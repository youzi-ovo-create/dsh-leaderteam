import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-v223:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v223:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.5' }) };
    }
    if (url === 'virtual-v223:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class ToolExecutionPipeline {
            constructor(toolsService) { this.toolsService = toolsService; }
            resolveExecution(name, agent, _hasParent, _toolSet) {
              if (!this.toolsService) return { name, description: name, execute: async args => ({ ok: true, args }) };
              return this.toolsService.resolve(agent, name);
            }
            async dispatchToolBody(exec) {
              const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
              if (!tool) return { isError: true, content: [{ type: 'text', text: 'UNKNOWN_TOOL: ' + exec.name }] };
              return await tool.execute(exec.arguments, exec);
            }
          }
        `,
      };
    }
    if (url === 'virtual-v223:@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const TOOL_ABORTED_BEFORE_DISPATCH = 'aborted';
          export class ToolsService {
            constructor(defs = []) {
              this._defs = new Map(defs.map(d => [d.name, d]));
            }
            view(_scope) {
              return {
                visible: new Map(this._defs),
                knownNames: new Set(this._defs.keys()),
              };
            }
            resolve(agent, name) {
              const v = this.view(agent);
              const admitted = v.visible.get(name);
              return admitted;
            }
            definitions(scope) { return [...this.view(scope).visible.values()]; }
            get(name) { return this._defs.get(name); }
            executable(name) { return this._defs.get(name); }
          }
        `,
      };
    }
    if (url === 'virtual-v223:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class BlockAssembler {
            constructor() { this._text = ''; }
            push(ev) {
              if (ev?.type === 'text-delta') this._text += (ev.delta ?? ev.text ?? '');
            }
            blocks() {
              return this._text ? [{ type: 'text', text: this._text }] : [];
            }
          }
          export function createUserMessage(input) { return { ...input, role: 'user', id: 'msg-1' }; }
          export function createToolResultMessage(r) { return r; }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { ToolsService } = await import('@deepseek-ai/dsh-tools');
const { ToolExecutionPipeline } = await import('@deepseek-ai/dsh-tools/pipeline');
const { loadConfig } = await import('../../leaderteam/core/config.mjs');
const { TeamStore, readJsonl } = await import('../../leaderteam/core/store.mjs');
const {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  SessionModeStore,
  normalizeExecutionMode,
  encodeSessionModeSegment,
  readSessionModeRecord,
  writeSessionModeRecord,
  readSessionModeHistory,
} = await import('../../leaderteam/core/session-mode.mjs');
const {
  evaluateHardRules,
  buildGateRequest,
} = await import('../../leaderteam/core/gate-policy.mjs');
const { singleModeSection } = await import('../../leaderteam/core/prompts.mjs');
const {
  runtime,
  bindRuntimeConfigFile,
  teamStore,
  requestWindowCallsPath,
} = await import('../../leaderteam/host/runtime.mjs');
const {
  getSessionExecutionMode,
  inspectSessionModeState,
  switchSessionExecutionMode,
} = await import('../../leaderteam/host/mode-controller.mjs');
const {
  leaderAllowedTools,
  resolveActor,
  isLeaderRoot,
  onAgentCreated,
  onAgentStatus,
  onSessionEvent,
  onToolResult,
  currentTaskSeq,
} = await import('../../leaderteam/host/roles.mjs');
const { installToolSurface } = await import('../../leaderteam/host/tool-surface.mjs');
const { installFinalGate, Gate, ClosedGate } = await import('../../leaderteam/host/final-gate.mjs');
const { recentTeamObservability, teamObservability } = await import('../../leaderteam/host/observability.mjs');
const { syncUpstreamModelsToDshSettings } = await import('../../leaderteam/core/upstream-models.mjs');
const { generateRedactedBugReport } = await import('../../bin/lt-bugreport.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash';

function makeTempSandbox(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-v223-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function resetRuntimeForTest(storageRoot, cfgFile, llm = null) {
  const rt = runtime();
  rt.storageRoot = storageRoot;
  rt.surface = 'desktop';
  rt.cordisCompositionMode = false;
  rt.plugins = { scheduler: null, consensus: null, timerArchive: null, panel: null };
  rt.actors = new Map();
  rt.reads = new Map();
  rt.readProgress = new Map();
  rt.stores = new Map();
  rt.teamConfigViews = new Map();
  rt.sessionModesCache = new Map();
  rt.gatePatternCache = new Map();
  rt.inFlightGateReviews = new Map();
  rt.inFlightShellCallsBySession = new Map();
  rt.executionReviewJobs = new Map();
  rt.governanceJobs = new Map();
  rt.stopReviewPending = new Set();
  rt.directiveVerifyPending = new Set();
  rt.liveProcessMemberIds = new Set();
  rt.hostAgents = new Map();
  rt.counters = { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 };
  rt.llm = llm;
  // resetRuntimeForTest cleanup for workspaceShellFailures
  rt.workspaceShellFailures = new Map();
  rt.circuitStates = new Map();
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile, { includeLocal: false }));
  return rt;
}

function createFakePromptRegistry() {
  const sections = new Map();
  const contexts = new Map();
  return {
    sections,
    contexts,
    systemPrompt: {
      section(entry) {
        sections.set(entry.name, entry);
        return () => {
          if (sections.get(entry.name) === entry) sections.delete(entry.name);
        };
      },
      context(entry) {
        contexts.set(entry.name, entry);
        return () => {
          if (contexts.get(entry.name) === entry) contexts.delete(entry.name);
        };
      },
    },
  };
}

function createAllHostToolDefs(executedCalls) {
  const names = [
    'read',
    'read_image',
    'glob',
    'grep',
    'todo_write',
    'write',
    'edit',
    'bash',
    'pwsh',
    'job_list',
    'job_output',
    'job_kill',
    'send_message',
    'interrupt_agent',
    'list_agents',
    'subagent',
    'fork_agent',
    'team_models',
    'team_plan',
    'team_concurrency',
    'team_dispatch',
    'team_direct_exec',
    'team_conference',
    'team_discuss',
    'team_plan_archive',
    'team_note',
    'team_status',
    'team_tools',
    'team_skills',
  ];
  return names.map(name => ({
    name,
    description: `Host tool ${name}`,
    async execute(args) {
      executedCalls.push({ name, args });
      return { content: [{ type: 'text', text: `OK:${name}` }], isError: false };
    },
  }));
}

function createMockCtx({ presetMap = new Map(), sessionsMap = new Map(), agentsMap = new Map(), jobsList = () => [] } = {}) {
  const services = {
    agentPresets: {
      presetForSession(session) {
        if (!session) return undefined;
        return presetMap.get(session.id) ?? session.header?.agentPreset ?? 'leaderteam';
      },
    },
    sessions: sessionsMap,
    agents: agentsMap,
    jobs: { list: jobsList },
  };
  return {
    sessions: sessionsMap,
    agents: agentsMap,
    get(name) {
      return services[name] ?? null;
    },
  };
}

test('SessionModeStore: default team mode with zero disk writes, safe segment encoding, atomic persistence, history, and cold recovery', t => {
  const tmp = makeTempSandbox(t, 'store');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(storageRoot, { recursive: true });

  assert.deepEqual(EXECUTION_MODES, ['team', 'single']);
  assert.equal(DEFAULT_EXECUTION_MODE, 'team');
  assert.equal(normalizeExecutionMode('team'), 'team');
  assert.equal(normalizeExecutionMode(' SINGLE '), 'single');
  for (const bad of [null, undefined, '', 'auto', 'hybrid', 42, {}]) {
    assert.throws(() => normalizeExecutionMode(bad), err => err?.code === 'BAD_EXECUTION_MODE');
  }

  // Missing session mode returns default 'team' with ZERO disk writes
  const unpersisted = readSessionModeRecord(storageRoot, 'sess-fresh-1');
  assert.equal(unpersisted.mode, 'team');
  assert.equal(unpersisted.persisted, false);
  assert.equal(unpersisted.updatedAt, null);
  assert.equal(unpersisted.switchCount, 0);
  assert.equal(fs.existsSync(path.join(storageRoot, 'session-modes')), false, 'reading missing session must not create session-modes directory');
  assert.deepEqual(readSessionModeHistory(storageRoot, 'sess-fresh-1'), []);

  // Safe segment encoding & traversal rejection
  assert.equal(encodeSessionModeSegment('sess-123_abc.v1'), 'sess-123_abc.v1');
  assert.equal(encodeSessionModeSegment('.'), '~002E');
  assert.equal(encodeSessionModeSegment('..'), '~002E~002E');
  const travSeg = encodeSessionModeSegment('../../etc/passwd:main~1');
  assert.ok(/^[A-Za-z0-9._~-]+$/.test(travSeg));
  assert.equal(travSeg.includes('/'), false);
  assert.equal(travSeg.includes('..'), false);
  for (const invalidId of ['', '   ', 'bad\u0000id', 'x'.repeat(257), null, undefined]) {
    assert.throws(() => encodeSessionModeSegment(invalidId), err => err?.code === 'BAD_SESSION_ID');
  }

  // Persistence, switchCount, and audit JSONL history
  const store = new SessionModeStore(storageRoot);
  const w1 = store.write('ns:session/alpha', 'single', { source: 'workbench-ui', taskSeqHint: 1 });
  assert.equal(w1.persisted, true);
  assert.equal(w1.mode, 'single');
  assert.equal(w1.switchCount, 1);
  assert.equal(w1.lastSwitchedFrom, 'team');
  assert.equal(w1.lastTaskSeqHint, 1);

  const w2 = store.write('ns:session/alpha', 'team', { source: 'panel-ui', taskSeqHint: 2 });
  assert.equal(w2.mode, 'team');
  assert.equal(w2.switchCount, 2);
  assert.equal(w2.lastSwitchedFrom, 'single');
  assert.equal(w2.createdAt, w1.createdAt);

  const hist = store.history('ns:session/alpha');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].fromMode, 'team');
  assert.equal(hist[0].toMode, 'single');
  assert.equal(hist[0].source, 'workbench-ui');
  assert.equal(hist[0].taskSeqHint, 1);
  assert.equal(hist[1].fromMode, 'single');
  assert.equal(hist[1].toMode, 'team');
  assert.equal(hist[1].source, 'panel-ui');
  assert.equal(hist[1].taskSeqHint, 2);

  // Symlink escape inside session-modes is deterministically rejected
  const outsideFile = path.join(tmp, 'outside-secret.json');
  fs.writeFileSync(outsideFile, JSON.stringify({ v: 1, sessionId: 'sym-sess', mode: 'single' }));
  const symTarget = path.join(storageRoot, 'session-modes', `${encodeSessionModeSegment('sym-sess')}.json`);
  fs.symlinkSync(outsideFile, symTarget);
  assert.throws(
    () => readSessionModeRecord(storageRoot, 'sym-sess'),
    err => err?.code === 'SESSION_MODE_PATH_ESCAPE',
  );
  fs.unlinkSync(symTarget);

  // Cold reload recovery via getSessionExecutionMode
  store.write('sess-cold-1', 'single', { source: 'cli', taskSeqHint: 1 });
  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));
  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  rt.sessionModesCache.clear();
  assert.equal(getSessionExecutionMode(rt, 'sess-cold-1'), 'single');
  assert.equal(getSessionExecutionMode(rt, 'sess-never-switched'), 'team');
});

test('cordis.patch.yml and headless.patch.yml mount direct execution tools while preserving member profile isolation', () => {
  const cordisText = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  const headlessText = fs.readFileSync(path.join(ROOT, 'config/headless.patch.yml'), 'utf8');

  const presetLtIdx = cordisText.indexOf('id: preset-leaderteam');
  const presetRoIdx = cordisText.indexOf('id: preset-lt-member-readonly');
  const presetCodeIdx = cordisText.indexOf('id: preset-lt-member-code');
  const presetShellIdx = cordisText.indexOf('id: preset-lt-member-shell');
  assert.ok(presetLtIdx > 0 && presetRoIdx > presetLtIdx && presetCodeIdx > presetRoIdx && presetShellIdx > presetCodeIdx);

  const leaderBlock = cordisText.slice(presetLtIdx, presetRoIdx);
  const readonlyBlock = cordisText.slice(presetRoIdx, presetCodeIdx);
  const codeBlock = cordisText.slice(presetCodeIdx, presetShellIdx);

  assert.doesNotMatch(leaderBlock, /write:\s*false/);
  assert.match(leaderBlock, /name:\s*'@deepseek-ai\/dsh-tool-bash'/);
  assert.match(leaderBlock, /name:\s*'@deepseek-ai\/dsh-tool-pwsh'/);
  assert.match(leaderBlock, /name:\s*'@deepseek-ai\/dsh-tool-jobs'/);

  // Readonly & Code member presets keep their exact host-level restrictions
  assert.match(readonlyBlock, /config:\s*\{write:\s*false,\s*edit:\s*false\}/);
  assert.doesNotMatch(readonlyBlock, /dsh-tool-bash|dsh-tool-pwsh|dsh-tool-jobs/);
  assert.doesNotMatch(codeBlock, /dsh-tool-bash|dsh-tool-pwsh|dsh-tool-jobs/);

  // Headless patch mounts write/edit/bash/pwsh/jobs while keeping subagent interrupt
  const headlessInsertIdx = headlessText.indexOf('- insert:');
  const headlessRoot = headlessText.slice(0, headlessInsertIdx);
  assert.doesNotMatch(headlessRoot, /write:\s*false/);
  assert.doesNotMatch(headlessRoot, /- id:\s*tool-jobs\s*\n\s*disabled:\s*true/);
  assert.match(headlessRoot, /- id:\s*tool-bash\s*\n\s*disabled:\s*!!js process\.platform === 'win32'/);
  assert.match(headlessRoot, /- id:\s*tool-pwsh\s*\n\s*disabled:\s*!!js process\.platform !== 'win32'/);
  assert.match(headlessRoot, /- id:\s*tool-subagent-control\s*\n\s*config:\s*\{interrupt:\s*true\}/);
});

test('ToolSurface + FinalGate enforce Team -> Single -> Team transitions, zero team.json in pure Single mode, Single-mode gate scope, mid-flight binding, and member profile isolation', async t => {
  const tmp = makeTempSandbox(t, 'gate');
  const ws = path.join(tmp, 'ws');
  const outsideDir = path.join(tmp, 'outside');
  const globalRefs = path.join(tmp, 'global-refs');
  const storageRoot = path.join(tmp, 'lt-store');
  for (const d of [ws, path.join(ws, '.git'), path.join(ws, 'src'), outsideDir, globalRefs, storageRoot]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Protected instructions\n');
  fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n');
  fs.writeFileSync(path.join(ws, 'src', 'app.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(globalRefs, 'GLOBAL.md'), 'read-only ref\n');

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  cfgRaw.paths.globalRefRoots = [globalRefs];
  cfgRaw.quota.allowUnknown = true;
  cfgRaw.quota.allowUnknownGpt = true;
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const gateLlmCalls = [];
  let onGateReviewHook = null;
  const mockLlm = {
    resolveModel(provider, model) {
      return { provider, id: model };
    },
    async *stream(req) {
      gateLlmCalls.push(req);
      if (onGateReviewHook) await onGateReviewHook(req);
      yield {
        type: 'text-delta',
        delta: JSON.stringify({ decision: 'allow', risk: 'low', reason: 'authorized inline script check' }),
      };
      yield {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
      };
    },
  };

  const rt = resetRuntimeForTest(storageRoot, cfgFile, mockLlm);
  installFinalGate(['0.2.2-rc.1', '0.2.2-rc.5']);
  const ctx = createMockCtx();
  rt.gate = new Gate(ctx);
  installToolSurface(agent => (agent?.session ? rt.gate.actorFor(agent) : null));

  const executedCalls = [];
  const toolsService = new ToolsService(createAllHostToolDefs(executedCalls));
  const pipeline = new ToolExecutionPipeline(toolsService);

  // 1. Pure Single-mode session: zero team.json / members.jsonl created before or after FinalGate receipts
  const pureSingleId = 'sess-pure-single';
  writeSessionModeRecord(storageRoot, pureSingleId, 'single', { initial: true, source: 'create' });
  const purePrompt = createFakePromptRegistry();
  const pureAgent = {
    id: pureSingleId,
    status: 'idle',
    ctx: { systemPrompt: purePrompt.systemPrompt, get: () => null },
    session: {
      id: pureSingleId,
      header: { id: pureSingleId, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => [
        { type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Update src/app.js directly' }] } },
      ],
    },
  };
  ctx.sessions.set(pureSingleId, pureAgent.session);
  ctx.agents.set(pureSingleId, pureAgent);
  rt.hostAgents.set(pureSingleId, pureAgent);

  onAgentCreated(ctx, { agent: pureAgent });
  assert.equal(purePrompt.sections.get('leaderteam:role')?.text, singleModeSection(rt.config, process.platform));
  assert.equal(purePrompt.contexts.size, 0, 'Single mode must not attach current-plan or concurrency prompt contexts');
  assert.equal(TeamStore.exists(storageRoot, pureSingleId), false, 'Pure Single session must not create team.json or members.jsonl');
  assert.equal(fs.existsSync(path.join(storageRoot, 'teams', pureSingleId)), false);

  // Direct workspace write in Single mode -> allowed via sandbox (0 LLM calls)
  const wRes = await pipeline.dispatchToolBody({
    name: 'write',
    arguments: { file_path: 'src/hello.txt', content: 'hello single\n' },
    agent: pureAgent,
    callId: 'c-single-write-1',
  });
  assert.equal(wRes.isError, false);
  assert.equal(gateLlmCalls.length, 0, 'in-workspace write in Single mode must make 0 LLM calls');
  const pureReceipts1 = readJsonl(path.join(storageRoot, 'teams', pureSingleId, 'gate.jsonl')).records;
  assert.equal(pureReceipts1.at(-1)?.by, 'sandbox');
  assert.equal(pureReceipts1.at(-1)?.decision, 'allow');
  assert.equal(fs.existsSync(path.join(storageRoot, 'teams', pureSingleId, 'team.json')), false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'teams', pureSingleId, 'members.jsonl')), false);

  // Pure Single-mode gate.jsonl-only directory must NOT leak into recentTeamObservability (V223-UI-05),
  // while direct teamObservability and lt-bugreport still succeed cleanly without throwing
  const obs = recentTeamObservability(ctx, rt, 8);
  assert.equal(obs.some(o => o.teamId === pureSingleId), false, 'Pure Single gate.jsonl-only session must not leak into recentTeamObservability');
  const directPureObs = teamObservability(ctx, rt, pureSingleId);
  assert.ok(directPureObs && !directPureObs.error, 'direct teamObservability must succeed without team.json/members.jsonl');
  const bugReport = generateRedactedBugReport({
    dshHome: tmp,
    storageRoot,
    teamId: pureSingleId,
    hostname: 'test-host',
    username: 'test-user',
  });
  assert.equal(bugReport.metrics.teamFound, true);
  assert.equal(bugReport.metrics.gate.allow, 1);

  // 2. Full Team -> Single -> Team lifecycle on a session
  const sid = 'sess-dual-lifecycle';
  const promptReg = createFakePromptRegistry();
  const leaderAgent = {
    id: sid,
    status: 'idle',
    ctx: { systemPrompt: promptReg.systemPrompt, get: () => null },
    session: {
      id: sid,
      header: { id: sid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => [
        { type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement feature and verify' }] } },
      ],
    },
  };
  ctx.sessions.set(sid, leaderAgent.session);
  ctx.agents.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);
  onAgentCreated(ctx, { agent: leaderAgent });

  // (a) Default 'team' mode checks
  const teamVisible = [...toolsService.view(leaderAgent).visible.keys()];
  for (const forbiddenInTeam of ['write', 'edit', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill']) {
    assert.equal(teamVisible.includes(forbiddenInTeam), false, `Team mode must hide ${forbiddenInTeam}`);
  }
  for (const allowedInTeam of ['read', 'glob', 'grep', 'team_dispatch', 'team_discuss', 'team_status', 'send_message']) {
    assert.equal(teamVisible.includes(allowedInTeam), true, `Team mode must expose ${allowedInTeam}`);
  }
  assert.equal(promptReg.contexts.has('leaderteam:current-plan'), true);
  assert.equal(promptReg.contexts.has('leaderteam:concurrency'), true);

  // Direct FinalGate / evaluateHardRules check in Team mode (even if stale allowedTools were passed)
  const hardTeamWrite = evaluateHardRules({
    tool: 'write',
    args: { file_path: 'src/a.js', content: 'x' },
    actor: { role: 'leader', executionMode: 'team', allowedTools: ['write'], loadedTools: ['write'] },
    cwd: ws,
  }, rt.config);
  assert.equal(hardTeamWrite?.rule, 'tool-not-in-profile');

  const gateTeamBash = await rt.gate.decide({
    name: SHELL_TOOL,
    args: { command: 'echo hi' },
    agent: leaderAgent,
    actor: rt.gate.actorFor(leaderAgent),
    callId: 'c-team-bash',
  });
  assert.equal(gateTeamBash.decision, 'deny');
  assert.equal(gateTeamBash.by, 'rule:tool-not-in-profile');

  // (b) Switch 'team' -> 'single' (0 LLM calls)
  const llmBeforeSwitch1 = gateLlmCalls.length;
  const swToSingle = switchSessionExecutionMode(ctx, rt, sid, 'single', { source: 'unit-test' });
  assert.equal(swToSingle.changed, true);
  assert.equal(swToSingle.previousMode, 'team');
  assert.equal(swToSingle.modeState.mode, 'single');
  assert.equal(gateLlmCalls.length, llmBeforeSwitch1, 'switching mode must perform 0 LLM calls');
  assert.match(promptReg.sections.get('leaderteam:role')?.text ?? '', /# LeaderTeam Single Mode: direct execution/);
  assert.equal(promptReg.contexts.size, 0, 'switching to Single mode must dispose team dynamic contexts');

  const singleVisible = [...toolsService.view(leaderAgent).visible.keys()];
  for (const directTool of ['read', 'read_image', 'glob', 'grep', 'todo_write', 'write', 'edit', SHELL_TOOL, 'job_list', 'job_output', 'job_kill']) {
    assert.equal(singleVisible.includes(directTool), true, `Single mode must expose ${directTool}`);
  }
  for (const teamOrSubTool of ['team_dispatch', 'team_discuss', 'team_plan', 'team_note', 'team_status', 'team_tools', 'team_skills', 'send_message', 'interrupt_agent', 'list_agents', 'subagent', 'fork_agent']) {
    assert.equal(singleVisible.includes(teamOrSubTool), false, `Single mode must hide ${teamOrSubTool}`);
  }

  // Team & subagent tools are deterministically denied with rule:single-mode-no-team-tools
  for (const blockedTeamTool of ['team_dispatch', 'team_discuss', 'team_note', 'send_message', 'interrupt_agent', 'subagent']) {
    const hardRes = evaluateHardRules({
      tool: blockedTeamTool,
      args: {},
      actor: rt.gate.actorFor(leaderAgent),
      cwd: ws,
    }, rt.config);
    assert.equal(hardRes?.rule, 'single-mode-no-team-tools', `${blockedTeamTool} must trigger single-mode-no-team-tools`);
    const dec = await rt.gate.decide({
      name: blockedTeamTool,
      args: {},
      agent: leaderAgent,
      actor: rt.gate.actorFor(leaderAgent),
      callId: `c-single-block-${blockedTeamTool}`,
    });
    assert.equal(dec.decision, 'deny');
    assert.equal(dec.by, 'rule:single-mode-no-team-tools');
  }

  // Outside-workspace and protected-path writes are denied in Single mode
  const outDeny = await pipeline.dispatchToolBody({
    name: 'write',
    arguments: { file_path: path.join(outsideDir, 'escape.txt'), content: 'bad' },
    agent: leaderAgent,
    callId: 'c-single-outside',
  });
  assert.equal(outDeny.isError, true);
  assert.match(outDeny.content[0].text, /rule:path-outside-workspace/);

  for (const protRel of ['.git/config', '.leaderteam/refs/hack.md', 'AGENTS.md']) {
    const protDeny = await pipeline.dispatchToolBody({
      name: 'write',
      arguments: { file_path: protRel, content: 'bad' },
      agent: leaderAgent,
      callId: `c-single-prot-${protRel}`,
    });
    assert.equal(protDeny.isError, true);
    assert.match(protDeny.content[0].text, /rule:path-protected/);
  }

  const globalRefDeny = await pipeline.dispatchToolBody({
    name: 'edit',
    arguments: { file_path: path.join(globalRefs, 'GLOBAL.md'), old_string: 'read-only', new_string: 'writable' },
    agent: leaderAgent,
    callId: 'c-single-globalref',
  });
  assert.equal(globalRefDeny.isError, true);
  assert.match(globalRefDeny.content[0].text, /rule:path-in-global-refs/);

  // Confined in-workspace edit + bash succeed via 'sandbox' with 0 LLM calls
  const editOk = await pipeline.dispatchToolBody({
    name: 'edit',
    arguments: { file_path: 'src/app.js', old_string: '1', new_string: '2' },
    agent: leaderAgent,
    callId: 'c-single-edit',
  });
  assert.equal(editOk.isError, false);

  const bashConfinedOk = await pipeline.dispatchToolBody({
    name: SHELL_TOOL,
    arguments: { command: 'node src/app.js' },
    agent: leaderAgent,
    callId: 'c-single-bash-confined',
  });
  assert.equal(bashConfinedOk.isError, false);
  assert.equal(gateLlmCalls.length, 0, 'confined Single-mode edit + bash must use 0 gate LLM calls');

  // Cross-boundary inline script bash routes to gate LLM with Single-mode write_scope in buildGateRequest
  const directReq = buildGateRequest({
    tool: SHELL_TOOL,
    args: { command: 'node -e "console.log(123)"' },
    callId: 'c-req-check',
    actor: rt.gate.actorFor(leaderAgent),
    cwd: ws,
    userTask: 'Verify script output',
  }, rt.config);
  const parsedGatePayload = JSON.parse(directReq.user);
  assert.deepEqual(parsedGatePayload.scope.write_scope, [
    '**/* (Single Mode: leader direct workspace write access, excluding protected_dirs and read_only_roots)',
  ]);

  const bashCrossOk = await pipeline.dispatchToolBody({
    name: SHELL_TOOL,
    arguments: { command: 'rm -f src/tmp-probe.txt' },
    agent: leaderAgent,
    callId: 'c-single-bash-cross',
  });
  assert.equal(bashCrossOk.isError, false);
  assert.equal(gateLlmCalls.length, 1, 'cross-boundary destructive/unconfined bash must invoke gate LLM once');
  const gateUserSent = JSON.stringify(gateLlmCalls[0].messages);
  assert.match(gateUserSent, /Single Mode: leader direct workspace write access/);

  // Mid-flight mode mutation fail-closed binding check
  const executedBeforeRace = executedCalls.length;
  onGateReviewHook = async () => {
    writeSessionModeRecord(storageRoot, sid, 'team', { source: 'mid-flight-race' });
  };
  const raceDenied = await pipeline.dispatchToolBody({
    name: SHELL_TOOL,
    arguments: { command: 'rm -f src/tmp-probe-2.txt' },
    agent: leaderAgent,
    callId: 'c-single-midflight-race',
  });
  onGateReviewHook = null;
  assert.equal(raceDenied.isError, true);
  assert.match(raceDenied.content[0].text, /\(binding\)/);
  assert.equal(executedCalls.length, executedBeforeRace, 'tool body must NEVER execute if mode changed during review');

  // (c) Immediate 'single' -> 'team' revocation in both ToolSurface and FinalGate
  writeSessionModeRecord(storageRoot, sid, 'single', { source: 'reset-for-clean-switch' });
  const llmBeforeSwitch2 = gateLlmCalls.length;
  const swToTeam = switchSessionExecutionMode(ctx, rt, sid, 'team', { source: 'unit-test-back' });
  assert.equal(swToTeam.changed, true);
  assert.equal(swToTeam.previousMode, 'single');
  assert.equal(swToTeam.modeState.mode, 'team');
  assert.equal(gateLlmCalls.length, llmBeforeSwitch2, 'switching back to Team must perform 0 LLM calls');

  const revokedVisible = [...toolsService.view(leaderAgent).visible.keys()];
  for (const revoked of ['write', 'edit', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill']) {
    assert.equal(revokedVisible.includes(revoked), false, `switching back to Team must immediately hide ${revoked}`);
  }
  const afterRevokeGate = await rt.gate.decide({
    name: 'write',
    args: { file_path: 'src/after.txt', content: 'blocked' },
    agent: leaderAgent,
    actor: rt.gate.actorFor(leaderAgent),
    callId: 'c-after-revoke-write',
  });
  assert.equal(afterRevokeGate.decision, 'deny');
  assert.equal(afterRevokeGate.by, 'rule:tool-not-in-profile');

  // (d) Member readonly & code profiles remain strictly isolated even with global write/bash/jobs registered
  const store = teamStore(sid);
  store.ensure({ workspace: ws, surface: 'desktop' });
  store.addMember({
    childId: 'mem-ro-1',
    name: 'scout',
    profile: 'readonly',
    model: 'zcode/GLM-5.3',
    effort: 'high',
    allowedTools: ['read', 'glob', 'grep', 'team_tools', 'team_skills'],
    loadedTools: ['read', 'glob', 'grep', 'team_tools', 'team_skills'],
    writeScope: [],
    refs: [],
    task: 'Read files',
    acceptance: ['Report'],
    cwd: ws,
  });
  store.addMember({
    childId: 'mem-code-1',
    name: 'coder',
    profile: 'code',
    model: 'zcode/GLM-5.3',
    effort: 'high',
    allowedTools: ['read', 'glob', 'grep', 'write', 'edit', 'team_tools', 'team_skills'],
    loadedTools: ['read', 'glob', 'grep', 'write', 'edit', 'team_tools', 'team_skills'],
    writeScope: ['src/**'],
    refs: [],
    task: 'Edit src',
    acceptance: ['Pass'],
    cwd: ws,
  });

  const roAgent = { id: 'mem-ro-1', session: { id: 'mem-ro-1', header: { origin: 'subagent', parentSession: sid, cwd: ws } } };
  const codeAgent = { id: 'mem-code-1', session: { id: 'mem-code-1', header: { origin: 'subagent', parentSession: sid, cwd: ws } } };
  resolveActor(ctx, roAgent);
  resolveActor(ctx, codeAgent);

  const roVisible = [...toolsService.view(roAgent).visible.keys()];
  for (const tName of ['write', 'edit', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill', 'team_dispatch']) {
    assert.equal(roVisible.includes(tName), false, `readonly member must not see ${tName}`);
  }
  const roWriteDeny = await rt.gate.decide({
    name: 'write',
    args: { file_path: 'src/ro.txt', content: 'no' },
    agent: roAgent,
    actor: rt.gate.actorFor(roAgent),
    callId: 'c-ro-write',
  });
  assert.equal(roWriteDeny.decision, 'deny');
  assert.equal(roWriteDeny.by, 'rule:tool-not-in-profile');

  const codeVisible = [...toolsService.view(codeAgent).visible.keys()];
  assert.equal(codeVisible.includes('write'), true);
  assert.equal(codeVisible.includes('edit'), true);
  for (const tName of ['bash', 'pwsh', 'job_list', 'job_output', 'job_kill', 'team_dispatch']) {
    assert.equal(codeVisible.includes(tName), false, `code member must not see ${tName}`);
  }
  const codeBashDeny = await rt.gate.decide({
    name: SHELL_TOOL,
    args: { command: 'echo no' },
    agent: codeAgent,
    actor: rt.gate.actorFor(codeAgent),
    callId: 'c-code-bash',
  });
  assert.equal(codeBashDeny.decision, 'deny');
  assert.equal(codeBashDeny.by, 'rule:tool-not-in-profile');
});

test('Idle-only mode switch guard rejects non-LT presets and every busy execution/governance state with 0 LLM calls', t => {
  const tmp = makeTempSandbox(t, 'guard');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  let llmCalls = 0;
  const rt = resetRuntimeForTest(storageRoot, cfgFile, {
    async *stream() { llmCalls++; },
  });

  const presetMap = new Map();
  const sessionsMap = new Map();
  const agentsMap = new Map();
  let mockRunningJobs = [];
  const ctx = createMockCtx({
    presetMap,
    sessionsMap,
    agentsMap,
    jobsList: ownerId => mockRunningJobs.filter(j => j.owner === ownerId),
  });

  // 1. Non-LT DSH native preset -> MODE_NOT_LT_SESSION
  const nonLtId = 'sess-native-coder';
  presetMap.set(nonLtId, 'native-coder');
  sessionsMap.set(nonLtId, { id: nonLtId, header: { id: nonLtId, cwd: ws } });
  const nonLtSnap = inspectSessionModeState(ctx, rt, nonLtId);
  assert.equal(nonLtSnap.isLtSession, false);
  assert.equal(nonLtSnap.canSwitch, false);
  assert.match(nonLtSnap.busyReason ?? '', /native-coder/);
  assert.throws(
    () => switchSessionExecutionMode(ctx, rt, nonLtId, 'single'),
    err => err?.code === 'MODE_NOT_LT_SESSION',
  );

  // Set up an LT leader session
  const sid = 'sess-lt-guard';
  presetMap.set(sid, 'leaderteam');
  const leaderAgent = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: name => ctx.get(name) },
    session: {
      id: sid,
      header: { id: sid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => [{ type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task 1' }] } }],
    },
  };
  sessionsMap.set(sid, leaderAgent.session);
  agentsMap.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);
  onAgentCreated(ctx, { agent: leaderAgent });

  // 2. Active leader turn -> MODE_SWITCH_BUSY
  leaderAgent.status = 'running';
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  leaderAgent.status = 'idle';

  // Queued inbox message -> MODE_SWITCH_BUSY
  leaderAgent.inbox.nextTurn.push({ id: 'm1' });
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  leaderAgent.inbox.nextTurn.length = 0;

  // Passive state running -> MODE_SWITCH_BUSY
  assert.throws(
    () => switchSessionExecutionMode(ctx, rt, sid, 'single', { passiveRunning: true }),
    err => err?.code === 'MODE_SWITCH_BUSY',
  );

  // 3. Stale dead member is reconciled cleanly, whereas live running or paused member blocks switch
  const store = teamStore(sid);
  store.addMember({ childId: 'dead-child', name: 'stale-m', profile: 'code', status: 'running', writeScope: ['src/**'], refs: [], task: 't', acceptance: ['a'] });
  store.setMemberStatus('dead-child', 'running');
  const afterStaleReconcile = inspectSessionModeState(ctx, rt, sid);
  assert.equal(afterStaleReconcile.activeMembersCount, 0, 'dead member absent from hostAgents must be reconciled before checking busy state');
  assert.equal(afterStaleReconcile.canSwitch, true);

  store.addMember({ childId: 'live-child', name: 'live-m', profile: 'code', writeScope: ['src/**'], refs: [], task: 't', acceptance: ['a'] });
  store.setMemberStatus('live-child', 'running');
  rt.hostAgents.set('live-child', { id: 'live-child', status: 'running' });
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');

  // Paused at conference checkpoint also blocks switch
  store.setMemberStatus('live-child', 'paused');
  store.setMemberGovernanceState('live-child', 'paused_for_conference', { conferenceId: 'conf-1' });
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');

  store.setMemberStatus('live-child', 'done');
  rt.hostAgents.delete('live-child');

  // 4. Pending execution review / governance / gate / stopReview / directiveVerify jobs block switch
  rt.executionReviewJobs.set('rev-1', { teamId: sid, promise: Promise.resolve() });
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  rt.executionReviewJobs.clear();

  rt.governanceJobs.set('gov-1', { teamId: sid, promise: Promise.resolve() });
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  rt.governanceJobs.clear();

  rt.stopReviewPending.add(sid);
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  rt.stopReviewPending.delete(sid);

  rt.directiveVerifyPending.add(sid);
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  rt.directiveVerifyPending.delete(sid);

  rt.inFlightGateReviews.set(sid, new Map([[sid, 1]]));
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  rt.inFlightGateReviews.clear();

  // 5. Open formal conference blocks switch until concluded
  store.appendGovernanceEvent({
    type: 'conference-opened',
    taskSeq: 1,
    conferenceId: 'conf-open-99',
    disputeId: 'disp-1',
    strike: 1,
    openingStatement: 'Verify architecture',
    keyQuestions: ['Q1'],
  });
  const confBusySnap = inspectSessionModeState(ctx, rt, sid);
  assert.equal(confBusySnap.activeConferenceId, 'conf-open-99');
  assert.equal(confBusySnap.canSwitch, false);
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');

  store.appendGovernanceEvent({
    type: 'conference-concluded',
    taskSeq: 1,
    conferenceId: 'conf-open-99',
    disputeId: 'disp-1',
    ruling: { decision: 'overturn_objection', rulingSummary: 'Cleared' },
  });

  // 6. Active background shell job on agent blocks switch
  mockRunningJobs = [{ id: 'job-1', owner: sid, kind: 'bash', label: 'npm test', status: 'running' }];
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');
  mockRunningJobs = [];

  // Now completely idle -> switches cleanly with 0 LLM calls!
  const okSwitch = switchSessionExecutionMode(ctx, rt, sid, 'single');
  assert.equal(okSwitch.changed, true);
  assert.equal(okSwitch.modeState.mode, 'single');
  // Idempotent switch to same mode -> changed: false, 0 extra switchCount
  const noopSwitch = switchSessionExecutionMode(ctx, rt, sid, 'single');
  assert.equal(noopSwitch.changed, false);
  assert.equal(noopSwitch.modeState.switchCount, 1);
  assert.equal(llmCalls, 0);
});

test('Single mode short-circuits team workflow hooks while keeping 5h request-window accounting and advancing currentTaskSeq on Single -> Team', t => {
  const tmp = makeTempSandbox(t, 'hooks');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  let userHookCalls = 0;
  let turnEndHookCalls = 0;
  let idleHookCalls = 0;
  const followups = [];
  rt.onLeaderUserMessage = () => { userHookCalls++; };
  rt.onLeaderTurnEnd = () => { turnEndHookCalls++; };
  rt.onLeaderIdle = () => { idleHookCalls++; return false; };

  const sid = 'sess-hooks-seq';
  const sessionEvents = [
    { type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Start task 1' }] } },
  ];
  const ctx = createMockCtx();
  const leaderAgent = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(msg) { followups.push(msg); },
    model: { current: () => ({ provider: 'magpie', model: 'codex/gpt-6.1-sol' }), recordedSelection: () => null, select() {} },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: () => null },
    session: {
      id: sid,
      header: { id: sid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => sessionEvents,
    },
  };
  ctx.sessions.set(sid, leaderAgent.session);
  ctx.agents.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);
  onAgentCreated(ctx, { agent: leaderAgent });

  // Switch to Single mode
  switchSessionExecutionMode(ctx, rt, sid, 'single', { source: 'test' });

  // Fire session & agent status events in Single mode
  onSessionEvent(ctx, leaderAgent.session, {
    type: 'user/message',
    time: 2000,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Quick question in Single mode' }] },
  });
  onSessionEvent(ctx, leaderAgent.session, {
    type: 'assistant/message',
    time: 2100,
    data: { message: { id: 'asst-1', source: { provider: 'magpie', model: 'codex/gpt-6.1-sol' } } },
  });
  onSessionEvent(ctx, leaderAgent.session, {
    type: 'turn/end',
    time: 2200,
    data: { turn: 2, reason: { kind: 'completed' } },
  });
  onAgentStatus(ctx, { agent: leaderAgent, status: 'idle' });

  assert.equal(userHookCalls, 0, 'onLeaderUserMessage must not run in Single mode');
  assert.equal(turnEndHookCalls, 0, 'onLeaderTurnEnd must not run in Single mode');
  assert.equal(idleHookCalls, 0, 'onLeaderIdle must not run in Single mode');
  assert.equal(followups.length, 0, 'maybeAutoContinueLeader must not enqueue followups in Single mode');

  // 5h request-window accounting MUST still record the Single-mode assistant turn
  const rwRecords = readJsonl(requestWindowCallsPath(storageRoot)).records;
  assert.equal(rwRecords.length, 1);
  assert.equal(rwRecords[0].teamId, sid);
  assert.equal(rwRecords[0].role, 'leader');

  // Verify currentTaskSeq across Single -> Team switch even when user sends bare "continue"
  assert.equal(currentTaskSeq(ctx, sid), 1);
  switchSessionExecutionMode(ctx, rt, sid, 'team', { source: 'test' });
  sessionEvents.push({
    type: 'user/message',
    time: Date.now() + 50,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] },
  });
  assert.equal(currentTaskSeq(ctx, sid), 2, 'bare "continue" after Single -> Team switch must start a fresh taskSeq');
});

test('Stage 7 V223-RT-01: ClosedGate(ctx) fails closed for cached, live, cold-resumed LT, subagent, and scope=all sessions and denies all tools unconditionally', async t => {
  const tmp = makeTempSandbox(t, 'rt01-closed');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  installFinalGate(['0.2.2-rc.1', '0.2.2-rc.5']);
  const presetMap = new Map([
    ['live-lt-sess', 'leaderteam'],
    ['native-std-sess', 'standard'],
  ]);
  const ctx = createMockCtx({ presetMap });
  rt.gate = new ClosedGate(ctx);
  installToolSurface(agent => (agent?.session ? rt.gate.actorFor(agent) : null));

  const executedCalls = [];
  const toolsService = new ToolsService(createAllHostToolDefs(executedCalls));
  // Unfiltered pipeline to verify FinalGate + ClosedGate.decide even if a caller bypasses ToolsService.view
  const rawPipeline = new ToolExecutionPipeline(null);

  // 1. Cold-resumed LT session (absent from rt.actors, presetMap empty, only header.agentPreset === 'leaderteam')
  const coldLtAgent = {
    id: 'cold-lt-1',
    session: { id: 'cold-lt-1', header: { id: 'cold-lt-1', cwd: ws, agentPreset: 'leaderteam' } },
  };
  const coldActor = rt.gate.actorFor(coldLtAgent);
  assert.ok(coldActor && coldActor.role === 'closed');
  assert.deepEqual(coldActor.allowedTools, []);
  assert.equal(toolsService.view(coldLtAgent).visible.size, 0, 'ClosedGate must hide 100% of tools on cold LT session');

  for (const toolName of ['read', 'glob', 'grep', 'write', 'edit', SHELL_TOOL, 'job_list']) {
    const res = await rawPipeline.dispatchToolBody({
      name: toolName,
      arguments: toolName === 'read' ? { file_path: '/etc/passwd' } : {},
      agent: coldLtAgent,
      callId: `closed-cold-${toolName}`,
    });
    assert.equal(res.isError, true, `${toolName} must be denied when ClosedGate is installed`);
    assert.match(res.content[0].text, /\(gate-closed\)/);
  }
  assert.equal(executedCalls.length, 0);

  // 2. Cached actor in rt.actors also denies "uncontrolled" tools (read/glob/grep) under ClosedGate.decide
  rt.actors.set('cached-lt-1', { role: 'leader', agentId: 'cached-lt-1', teamId: 'cached-lt-1', allowedTools: ['read', 'glob', 'grep'] });
  const cachedAgent = { id: 'cached-lt-1', session: { id: 'cached-lt-1', header: { id: 'cached-lt-1', cwd: ws } } };
  assert.equal(toolsService.view(cachedAgent).visible.size, 0);
  const cachedReadVerdict = await rt.gate.decide({ name: 'read', args: { file_path: '/etc/passwd' }, actor: rt.gate.actorFor(cachedAgent) });
  assert.equal(cachedReadVerdict.decision, 'deny');
  assert.equal(cachedReadVerdict.by, 'gate-closed');

  // 3. Live isLeaderRoot session and subagent session are also intercepted
  const liveLtAgent = { id: 'live-lt-sess', session: { id: 'live-lt-sess', header: { id: 'live-lt-sess', cwd: ws } } };
  assert.equal(isLeaderRoot(ctx, liveLtAgent), true);
  assert.equal(rt.gate.actorFor(liveLtAgent)?.role, 'closed');

  const subAgent = { id: 'orphan-sub-1', session: { id: 'orphan-sub-1', header: { origin: 'subagent', cwd: ws } } };
  assert.equal(rt.gate.actorFor(subAgent)?.role, 'closed');

  // 4. Native non-LT session ('standard') passes through when gate.scope !== 'all', and closes when scope === 'all'
  const stdAgent = { id: 'native-std-sess', session: { id: 'native-std-sess', header: { id: 'native-std-sess', cwd: ws, agentPreset: 'standard' } } };
  assert.equal(rt.gate.actorFor(stdAgent), null);
  rt.config = { ...rt.config, gate: { ...rt.config.gate, scope: 'all' } };
  assert.equal(rt.gate.actorFor(stdAgent)?.role, 'closed');
});

test('Stage 7 V223-RT-02: inspectSessionModeState blocks Team -> Single switching during Strike-3 human escalation and unsatisfied Arbiter directives', t => {
  const tmp = makeTempSandbox(t, 'rt02-gov');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const sid = 'sess-gov-hold';
  const ctx = createMockCtx();
  const leaderAgent = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: name => ctx.get(name) },
    session: {
      id: sid,
      header: { id: sid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => [{ type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build module' }] } }],
    },
  };
  ctx.sessions.set(sid, leaderAgent.session);
  ctx.agents.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);
  onAgentCreated(ctx, { agent: leaderAgent });
  const store = teamStore(sid);

  // 1. Strike-3 human escalation open -> blocks switch
  store.appendGovernanceEvent({
    type: 'human-escalation-opened',
    taskSeq: 1,
    escalationId: 'esc-strike3-1',
    disputeId: 'disp-esc',
    strike: 3,
    summary: '3rd unanimous objection',
  });
  const escSnap = inspectSessionModeState(ctx, rt, sid);
  assert.equal(escSnap.canSwitch, false);
  assert.match(escSnap.busyReason ?? '', /esc-strike3-1/);
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');

  store.appendGovernanceEvent({
    type: 'human-escalation-resolved',
    taskSeq: 1,
    escalationId: 'esc-strike3-1',
    disputeId: 'disp-esc',
  });
  assert.equal(inspectSessionModeState(ctx, rt, sid).canSwitch, true);

  // 2. Concluded conference with unsatisfied 'enforce_correction' directive -> blocks switch until satisfied
  store.appendGovernanceEvent({
    type: 'conference-opened',
    taskSeq: 1,
    conferenceId: 'conf-dir-1',
    disputeId: 'disp-dir',
    strike: 1,
  });
  store.appendGovernanceEvent({
    type: 'conference-concluded',
    taskSeq: 1,
    conferenceId: 'conf-dir-1',
    disputeId: 'disp-dir',
    ruling: {
      decision: 'enforce_correction',
      rulingSummary: 'Fix boundary validation',
      bindingDirectives: ['Add input validation'],
      blockedTargets: ['src/auth.js'],
    },
  });
  const dirSnap = inspectSessionModeState(ctx, rt, sid);
  assert.equal(dirSnap.canSwitch, false);
  assert.match(dirSnap.busyReason ?? '', /conf-dir-1/);
  assert.throws(() => switchSessionExecutionMode(ctx, rt, sid, 'single'), err => err?.code === 'MODE_SWITCH_BUSY');

  store.appendGovernanceEvent({
    type: 'arbiter-directive-satisfied',
    taskSeq: 1,
    disputeId: 'disp-dir',
    conferenceId: 'conf-dir-1',
  });
  assert.equal(inspectSessionModeState(ctx, rt, sid).canSwitch, true);
  const sw = switchSessionExecutionMode(ctx, rt, sid, 'single');
  assert.equal(sw.modeState.mode, 'single');
});

test('Stage 7 V223-RT-03: currentTaskSeq consumes pre-task Single -> Team boundaries and multi-toggle boundaries without premature increments on bare "continue"', t => {
  const tmp = makeTempSandbox(t, 'rt03-seq');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const ctx = createMockCtx();
  const sid = 'sess-pre-switch';
  const events = [];
  const leaderAgent = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: name => ctx.get(name) },
    session: {
      id: sid,
      header: { id: sid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => events,
    },
  };
  ctx.sessions.set(sid, leaderAgent.session);
  ctx.agents.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);

  // Created in Single mode at t=1000, switched Single -> Team at t=1200 BEFORE first task message
  writeSessionModeRecord(storageRoot, sid, 'single', { initial: true, at: new Date(1000).toISOString(), taskSeqHint: 1 });
  writeSessionModeRecord(storageRoot, sid, 'team', { at: new Date(1200).toISOString(), taskSeqHint: 1 });

  // Leading read-grant at t=1100, then first real task prompt at t=2000, then bare "continue" at t=3000
  events.push({ type: 'user/message', time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '允许读取 /tmp/spec.md' }] } });
  events.push({ type: 'user/message', time: 2000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement Stage 1 plan' }] } });
  assert.equal(currentTaskSeq(ctx, sid), 1);

  events.push({ type: 'user/message', time: 3000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] } });
  assert.equal(currentTaskSeq(ctx, sid), 1, 'bare "continue" must stay on taskSeq=1 when Single -> Team occurred before the first task message');

  // Now toggle Team -> Single -> Team -> Single -> Team twice between t=3100..3400, then send bare "continue" at t=4000
  writeSessionModeRecord(storageRoot, sid, 'single', { at: new Date(3100).toISOString(), taskSeqHint: 1 });
  writeSessionModeRecord(storageRoot, sid, 'team', { at: new Date(3200).toISOString(), taskSeqHint: 1 });
  writeSessionModeRecord(storageRoot, sid, 'single', { at: new Date(3300).toISOString(), taskSeqHint: 1 });
  writeSessionModeRecord(storageRoot, sid, 'team', { at: new Date(3400).toISOString(), taskSeqHint: 1 });

  events.push({ type: 'user/message', time: 4000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] } });
  assert.equal(currentTaskSeq(ctx, sid), 2, 'bare "continue" after Single -> Team boundary advances to taskSeq=2');

  // Another bare "continue" at t=5000 with NO new switch must stay at taskSeq=2 (both boundaries at 3200 & 3400 consumed!)
  events.push({ type: 'user/message', time: 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] } });
  assert.equal(currentTaskSeq(ctx, sid), 2, 'second bare "continue" without new switch must remain on taskSeq=2');
});

test('Stage 7 V223-RT-04: Gate.decide isolates gatePatternCache and dedupeDeniedCalls across Team and Single execution modes', async t => {
  const tmp = makeTempSandbox(t, 'rt04-cache');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  cfgRaw.toolPolicy = { ...(cfgRaw.toolPolicy ?? {}), additionalTools: ['mcp_deploy'] };
  cfgRaw.profiles.leader.tools = [...cfgRaw.profiles.leader.tools, 'mcp_deploy'];
  cfgRaw.gate.enablePatternCache = true;
  cfgRaw.gate.dedupeDeniedCalls = true;
  cfgRaw.quota.allowUnknown = true;
  cfgRaw.quota.allowUnknownGpt = true;
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  let gateLlmCalls = 0;
  let nextGateDecision = { decision: 'deny', risk: 'medium', reason: 'Team leader has no direct deploy scope' };
  const mockLlm = {
    resolveModel(provider, model) { return { provider, id: model }; },
    async *stream() {
      gateLlmCalls++;
      yield { type: 'text-delta', delta: JSON.stringify(nextGateDecision) };
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const rt = resetRuntimeForTest(storageRoot, cfgFile, mockLlm);
  const ctx = createMockCtx();
  rt.gate = new Gate(ctx);

  const sid = 'sess-rt04-mode-cache';
  const leaderAgent = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: name => ctx.get(name) },
    session: {
      id: sid,
      header: { id: sid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => [{ type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Deploy preview' }] } }],
    },
  };
  ctx.sessions.set(sid, leaderAgent.session);
  ctx.agents.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);
  onAgentCreated(ctx, { agent: leaderAgent });

  // 1. In Team mode on taskSeq=1, mcp_deploy is denied by gate model
  const teamVerdict = await rt.gate.decide({
    name: 'mcp_deploy',
    args: { env: 'staging' },
    toolDescription: 'Deploy preview',
    agent: leaderAgent,
    actor: rt.gate.actorFor(leaderAgent),
    callId: 'c-deploy-team-1',
  });
  assert.equal(teamVerdict.decision, 'deny');
  assert.equal(teamVerdict.by, 'model');
  assert.equal(gateLlmCalls, 1);

  // Repeat in Team mode hits gate-cache (or duplicate-denied-call if cache cleared)
  const teamCached = await rt.gate.decide({
    name: 'mcp_deploy',
    args: { env: 'staging' },
    toolDescription: 'Deploy preview',
    agent: leaderAgent,
    actor: rt.gate.actorFor(leaderAgent),
    callId: 'c-deploy-team-2',
  });
  assert.equal(teamCached.decision, 'deny');
  assert.equal(gateLlmCalls, 1);

  // 2. Switch Team -> Single (taskSeq remains 1) -> neither gatePatternCache nor dedupeDeniedCalls pollutes Single mode!
  switchSessionExecutionMode(ctx, rt, sid, 'single');
  assert.equal(currentTaskSeq(ctx, sid), 1);
  nextGateDecision = { decision: 'allow', risk: 'low', reason: 'Single mode direct deploy authorized' };

  const singleVerdict = await rt.gate.decide({
    name: 'mcp_deploy',
    args: { env: 'staging' },
    toolDescription: 'Deploy preview',
    agent: leaderAgent,
    actor: rt.gate.actorFor(leaderAgent),
    callId: 'c-deploy-single-1',
  });
  assert.equal(singleVerdict.decision, 'allow');
  assert.equal(singleVerdict.by, 'model');
  assert.equal(gateLlmCalls, 2, 'Single mode must evaluate fresh via gate LLM instead of reusing Team denial');

  const receipts = teamStore(sid).gateReceipts();
  assert.equal(receipts.find(r => r.callId === 'c-deploy-team-1')?.executionMode, 'team');
  assert.equal(receipts.find(r => r.callId === 'c-deploy-single-1')?.executionMode, 'single');
});

test('Stage 7 V223-RT-05 & V223-RT-06: Single-mode max-tokens output recovery, bwrap OS sandbox failure masking, and static DSH tool prompt shadowing', t => {
  const tmp = makeTempSandbox(t, 'rt05-rt06');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  cfgRaw.circuitBreaker = { ...(cfgRaw.circuitBreaker ?? {}), zeroProgressTruncationSoft: 2, zeroProgressTruncationHard: 3 };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const ctx = createMockCtx();

  // 1. Pure Single-mode session: verify static prompt shadowing & max-tokens auto-continuation with 0 TeamStore files
  const pureSid = 'sess-single-recovery';
  writeSessionModeRecord(storageRoot, pureSid, 'single', { initial: true, source: 'create' });
  const purePrompt = createFakePromptRegistry();
  const followups = [];
  const sessionEvents = [
    { type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Generate large module' }] } },
  ];
  const pureLeader = {
    id: pureSid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(msg) { followups.push(msg); },
    ctx: { systemPrompt: purePrompt.systemPrompt, get: name => ctx.get(name) },
    session: {
      id: pureSid,
      header: { id: pureSid, cwd: ws, agentPreset: 'leaderteam' },
      snapshotEvents: () => sessionEvents,
    },
  };
  ctx.sessions.set(pureSid, pureLeader.session);
  ctx.agents.set(pureSid, pureLeader);
  rt.hostAgents.set(pureSid, pureLeader);
  onAgentCreated(ctx, { agent: pureLeader });

  // In Single mode on non-win32: bash & jobs are allowed so NOT shadowed; pwsh IS shadowed
  if (process.platform === 'win32') {
    assert.equal(purePrompt.sections.has('tool:pwsh'), false);
    assert.equal(purePrompt.sections.get('tool:bash')?.text, '');
  } else {
    assert.equal(purePrompt.sections.has('tool:bash'), false);
    assert.equal(purePrompt.sections.get('tool:pwsh')?.text, '');
  }
  assert.equal(purePrompt.sections.has('tool:jobs'), false);

  // Record a completed write tool in Single mode, then end turn with max-tokens -> recovers cleanly!
  onToolResult(
    { agent: pureLeader, name: 'write', callId: 'w-1', arguments: { file_path: 'src/part1.js' } },
    { isError: false, content: [{ type: 'text', text: 'ok' }] },
  );
  sessionEvents.push(
    { type: 'turn/start', time: 1100, data: { turn: 1 } },
    { type: 'assistant/message', time: 1200, data: { content: [{ type: 'text', text: 'Partial output...' }] } },
    { type: 'turn/end', time: 1300, data: { turn: 1, reason: { kind: 'max-tokens' } } },
  );
  onAgentStatus(ctx, { agent: pureLeader, status: 'idle' });
  assert.equal(followups.length, 1, 'Single-mode max-tokens turn must auto-continue');
  assert.match(followups[0].content[0].text, /LeaderTeam output recovery — Single Mode/);
  assert.match(followups[0].content[0].text, /write\(src\/part1\.js\)/);
  assert.equal(TeamStore.exists(storageRoot, pureSid), false, 'Single-mode max-tokens recovery must create 0 TeamStore files');
  assert.equal(fs.existsSync(path.join(storageRoot, 'teams', pureSid)), false);

  // Zero-progress max-tokens turns stop once zeroProgressTruncationHard (3) is reached
  for (let n = 0; n < 4; n++) {
    sessionEvents.push(
      { type: 'turn/start', time: 2000 + n * 100, data: { turn: 2 + n } },
      { type: 'assistant/message', time: 2050 + n * 100, data: { content: [{ type: 'text', text: 'Still truncated with 0 tools' }] } },
      { type: 'turn/end', time: 2090 + n * 100, data: { turn: 2 + n, reason: { kind: 'max-tokens' } } },
    );
    onAgentStatus(ctx, { agent: pureLeader, status: 'idle' });
  }
  // 2 zero-progress turns recover (followups total = 1 + 2 = 3); 3rd & 4th hit hard cap (3) and stop!
  assert.equal(followups.length, 3, 'zero-progress Single-mode max-tokens must stop cleanly at hard threshold');

  // 2. bwrap OS sandbox startup failure in Single mode records workspaceShellFailures, masks shellTools, shadows tool:bash, and injects leaderteam:shell-unavailable
  onToolResult(
    { agent: pureLeader, name: SHELL_TOOL, callId: 'bwrap-1', arguments: { command: 'echo test' } },
    { isError: true, content: [{ type: 'text', text: 'bwrap: Creating new namespace failed: Operation not permitted' }] },
  );
  assert.equal(rt.workspaceShellFailures.size, 1);
  assert.equal(leaderAllowedTools(rt, 'single', process.platform, ws).includes(SHELL_TOOL), false);
  assert.equal(pureLeader && rt.actors.get(pureSid).allowedTools.includes(SHELL_TOOL), false);
  assert.match(purePrompt.sections.get('leaderteam:shell-unavailable')?.text ?? '', /OS sandbox failed/);
  assert.equal(purePrompt.sections.get(`tool:${SHELL_TOOL}`)?.text, '', 'failed shell tool prompt section must be shadowed');

  // Switching Single -> Team disposes Single-mode shell-unavailable and shadows tool:bash, tool:pwsh, and tool:jobs
  switchSessionExecutionMode(ctx, rt, pureSid, 'team');
  assert.equal(purePrompt.sections.has('leaderteam:shell-unavailable'), false);
  assert.equal(purePrompt.sections.get('tool:bash')?.text, '');
  assert.equal(purePrompt.sections.get('tool:pwsh')?.text, '');
  assert.equal(purePrompt.sections.get('tool:jobs')?.text, '');

  // 3. Member (readonly, code) and shell-disabled direct_exec shadow tool:bash, tool:pwsh, and tool:jobs
  const store = teamStore(pureSid);
  store.addMember({
    childId: 'ro-sub-rt06',
    name: 'ro-scout',
    profile: 'readonly',
    model: 'zcode/GLM-5.3',
    effort: 'high',
    allowedTools: ['read', 'glob', 'grep', 'team_tools', 'team_skills'],
    loadedTools: ['read', 'glob', 'grep', 'team_tools', 'team_skills'],
    writeScope: [],
    refs: [],
    task: 'Inspect',
    acceptance: ['Done'],
    cwd: ws,
  });
  store.addMember({
    childId: 'de-noshell-rt06',
    name: 'de-edit',
    actorRole: 'direct_exec',
    profile: 'code',
    model: 'zcode/GLM-5.3',
    effort: 'high',
    allowedTools: ['read', 'glob', 'grep', 'write', 'edit'],
    loadedTools: ['read', 'glob', 'grep', 'write', 'edit'],
    writeScope: ['src/**'],
    refs: [],
    task: 'Edit',
    acceptance: ['Done'],
    cwd: ws,
  });

  const roPrompt = createFakePromptRegistry();
  onAgentCreated(ctx, {
    agent: {
      id: 'ro-sub-rt06',
      ctx: { systemPrompt: roPrompt.systemPrompt, get: () => null },
      session: { id: 'ro-sub-rt06', header: { origin: 'subagent', parentSession: pureSid, cwd: ws } },
    },
  });
  assert.equal(roPrompt.sections.get('tool:bash')?.text, '');
  assert.equal(roPrompt.sections.get('tool:pwsh')?.text, '');
  assert.equal(roPrompt.sections.get('tool:jobs')?.text, '');

  const dePrompt = createFakePromptRegistry();
  onAgentCreated(ctx, {
    agent: {
      id: 'de-noshell-rt06',
      ctx: { systemPrompt: dePrompt.systemPrompt, get: () => null },
      session: { id: 'de-noshell-rt06', header: { origin: 'subagent', parentSession: pureSid, cwd: ws } },
    },
  });
  assert.equal(dePrompt.sections.get('tool:bash')?.text, '');
  assert.equal(dePrompt.sections.get('tool:pwsh')?.text, '');
  assert.equal(dePrompt.sections.get('tool:jobs')?.text, '');
});

test('Stage 7 V223-RT-07, V223-RT-08 & V223-UI-03: corrupt session-mode file quarantine/recovery, colon/slash/long session IDs across runtime & Gate, and DSH 0.2.2-rc.5 array settings.describe()', async t => {
  const tmp = makeTempSandbox(t, 'rt07-rt08-ui03');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const ctx = createMockCtx();
  rt.gate = new Gate(ctx);

  // 1. V223-RT-07: Corrupt session-modes/<seg>.json fails closed to 'team' on inspect and quarantines + repairs on switch
  const corruptSid = 'sess-corrupt-json';
  writeSessionModeRecord(storageRoot, corruptSid, 'single', { initial: true, source: 'create' });
  const modesDir = path.join(storageRoot, 'session-modes');
  const stateFile = path.join(modesDir, `${encodeSessionModeSegment(corruptSid)}.json`);
  fs.writeFileSync(stateFile, '{corrupt-truncated-json');

  assert.equal(getSessionExecutionMode(rt, corruptSid), 'team');
  const corruptSnap = inspectSessionModeState(ctx, rt, corruptSid);
  assert.equal(corruptSnap.mode, 'team');
  assert.equal(corruptSnap.canSwitch, true);

  // Even switching to 'team' without forcePersist repairs the corrupt file and leaves a .corrupt.<ts> backup!
  const recovered = switchSessionExecutionMode(ctx, rt, corruptSid, 'team', { source: 'recover' });
  assert.equal(recovered.modeState.mode, 'team');
  const filesAfterRecover = fs.readdirSync(modesDir);
  assert.ok(filesAfterRecover.some(f => f.startsWith(`${encodeSessionModeSegment(corruptSid)}.json.corrupt.`)), 'corrupt file must be quarantined');
  assert.equal(readSessionModeRecord(storageRoot, corruptSid).mode, 'team');

  // Symlink escape MUST remain strictly fatal (SESSION_MODE_PATH_ESCAPE) and never overwrite symlink target
  const outsideSecret = path.join(tmp, 'outside-target.json');
  fs.writeFileSync(outsideSecret, 'KEEP_ME');
  const symSid = 'sess-symlink-escape';
  const symStateFile = path.join(modesDir, `${encodeSessionModeSegment(symSid)}.json`);
  fs.symlinkSync(outsideSecret, symStateFile);
  assert.throws(() => inspectSessionModeState(ctx, rt, symSid), err => err?.code === 'SESSION_MODE_PATH_ESCAPE');
  assert.throws(() => writeSessionModeRecord(storageRoot, symSid, 'single'), err => err?.code === 'SESSION_MODE_PATH_ESCAPE');
  assert.equal(fs.readFileSync(outsideSecret, 'utf8'), 'KEEP_ME');
  fs.unlinkSync(symStateFile);

  // 2. V223-RT-08: Colon, slash, tilde, and 240-char session IDs work across pure Single, Gate.record, Single -> Team, and observability
  for (const trickySid of ['ns:session/alpha~1', `long:${'x'.repeat(235)}`]) {
    writeSessionModeRecord(storageRoot, trickySid, 'single', { initial: true, source: 'create' });
    const promptReg = createFakePromptRegistry();
    const agent = {
      id: trickySid,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      ctx: { systemPrompt: promptReg.systemPrompt, get: name => ctx.get(name) },
      session: {
        id: trickySid,
        header: { id: trickySid, cwd: ws, agentPreset: 'leaderteam' },
        snapshotEvents: () => [{ type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Edit file' }] } }],
      },
    };
    ctx.sessions.set(trickySid, agent.session);
    ctx.agents.set(trickySid, agent);
    rt.hostAgents.set(trickySid, agent);

    onAgentCreated(ctx, { agent });
    assert.equal(TeamStore.exists(storageRoot, trickySid), false);

    const verdict = await rt.gate.decide({
      name: 'write',
      args: { file_path: 'src/ok.txt', content: 'hi' },
      agent,
      actor: rt.gate.actorFor(agent),
      callId: 'c-tricky-1',
    });
    assert.equal(verdict.decision, 'allow');

    // Pure Single still excluded from recentTeamObservability; switching Single -> Team creates team.json cleanly
    assert.equal(recentTeamObservability(ctx, rt, 16).some(o => o.teamId === trickySid), false);
    const sw = switchSessionExecutionMode(ctx, rt, trickySid, 'team');
    assert.equal(sw.modeState.mode, 'team');
    assert.equal(TeamStore.exists(storageRoot, trickySid), true);
  }
  const obsAfterTeam = recentTeamObservability(ctx, rt, 16);
  assert.equal(obsAfterTeam.some(o => o.teamId === 'ns:session/alpha~1'), true, 'encoded Team session resolves back to sessionId in recentTeamObservability');

  // 3. V223-UI-03: syncUpstreamModelsToDshSettings supports real DSH 0.2.2-rc.5 Array settings.describe() AND legacy { namespaces }
  const arrayUpdates = [];
  const dshRc5Ctx = {
    get(name) {
      if (name !== 'settings') return null;
      return {
        describe() {
          return [
            { ns: 'other-plugin', value: { enabled: true } },
            { ns: 'llm-pi-ai', value: { providers: {} } },
          ];
        },
        async update(ns, payload) {
          arrayUpdates.push({ ns, payload });
        },
      };
    },
  };
  const syncArrayRes = await syncUpstreamModelsToDshSettings(
    dshRc5Ctx,
    [{ route: 'codex/gpt-6.1-sol', provider: 'magpie', upstreamModel: 'codex/gpt-6.1-sol', efforts: ['none', 'high'], contextWindow: 200000, maxTokens: 32000 }],
    'magpie',
    { providerTemplates: { magpie: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:23190/v1', apiKeyEnv: 'MAGPIE_API_KEY' } } },
  );
  assert.equal(syncArrayRes.synced, true);
  assert.equal(syncArrayRes.changed, true);
  assert.deepEqual(syncArrayRes.updatedProviders, ['magpie']);
  assert.equal(arrayUpdates.length, 1);
  assert.equal(arrayUpdates[0].ns, 'llm-pi-ai');
  assert.equal(arrayUpdates[0].payload.providers.magpie.apiKeyEnv, 'MAGPIE_API_KEY');
  assert.equal(arrayUpdates[0].payload.providers.magpie.models[0].id, 'codex/gpt-6.1-sol');

  const legacyUpdates = [];
  const legacyCtx = {
    get(name) {
      if (name !== 'settings') return null;
      return {
        describe() {
          return { namespaces: [{ ns: 'llm-pi-ai', data: { providers: { magpie: { type: 'openai-compatible', models: [] } } } }] };
        },
        async update(ns, payload) {
          legacyUpdates.push({ ns, payload });
        },
      };
    },
  };
  const syncLegacyRes = await syncUpstreamModelsToDshSettings(
    legacyCtx,
    [{ route: 'zcode/GLM-5.3', provider: 'magpie', upstreamModel: 'zcode/GLM-5.3', efforts: ['high'] }],
    'magpie',
  );
  assert.equal(syncLegacyRes.synced, true);
  assert.equal(legacyUpdates.length, 1);
  assert.equal(legacyUpdates[0].ns, 'llm-pi-ai');
});
