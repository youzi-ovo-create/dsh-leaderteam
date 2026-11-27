import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, mergeConfigLayers } from '../../leaderteam/core/config.mjs';
import { applyModelConfigChanges } from '../../leaderteam/core/model-config-writer.mjs';
import { probeHostRuntimeFacts, formatHostRuntimeFacts } from '../../leaderteam/core/host-facts.mjs';
import { leaderSection, directExecSection } from '../../leaderteam/core/prompts.mjs';
import {
  isNetworkForbiddenByUser,
  inspectWebFetchUrlSafety,
  evaluateHardRules,
  classifySandboxBoundary,
  evaluateDirectExecSafetyGate,
  DIRECT_EXEC_EPISTEMIC_NOTE,
} from '../../leaderteam/core/gate-policy.mjs';
import { TeamStore } from '../../leaderteam/core/store.mjs';
import { DEFAULT_CONFIG_FILE } from './helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: `virtual-dp-reg:${encodeURIComponent(specifier)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('virtual-dp-reg:')) return nextLoad(url, context);
    const spec = decodeURIComponent(url.slice('virtual-dp-reg:'.length));
    if (spec === '@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const defineTool = def => def;
          export const TOOL_ABORTED_BEFORE_DISPATCH = 'TOOL_ABORTED_BEFORE_DISPATCH';
          export class ToolsService {
            view(scope) { return scope?.__view ?? { visible: new Map(), knownNames: new Set() }; }
            resolve(agent) { return this.view(agent); }
            definitions() { return []; }
            get() { return null; }
            executable() { return null; }
          }
        `,
      };
    }
    if (spec === '@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class ToolExecutionPipeline { resolveExecution() { return undefined; } async dispatchToolBody() {} }',
      };
    }
    if (spec === '@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    }
    if (spec === '@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const boundContextSummary = s => s;
          export const createUserMessage = x => ({ ...x, role: 'user', id: 'm-dp' });
          export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === 'text') this._b.push(c); } blocks() { return this._b; } }
        `,
      };
    }
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  },
});

const { formatFrontierContext } = await import('../../leaderteam/host/planning.mjs');
const { formatLeaderGovernanceContext } = await import('../../leaderteam/host/governance.mjs');
const {
  runtime,
  bindRuntimeConfigFile,
  teamStore,
  runtimeForTeam,
  isTeamExecutionStarted,
  rebindUnstartedTeamGovernance,
  rebindAllUnstartedTeams,
} = await import('../../leaderteam/host/runtime.mjs');
const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { createPanelHandlers } = await import('../../leaderteam/plugins/leaderteam-panel/panel-api.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('[DP-01 & DP-02] Progressive local readiness orthogonal with autonomous dispatch, plus quiescent governance context suppression', t => {
  const cfg = loadConfig(DEFAULT_CONFIG_FILE, { includeLocal: false });
  const sec = leaderSection(cfg, null, { platform: 'win32', arch: 'x64', nodeVersion: 'v24.0.0', defaultMemberShell: 'pwsh', systemBrowsers: ['msedge', 'chrome'], systemFontsAvailable: true });
  assert.match(sec, /Host runtime facts \(verified read-only\): platform=win32\/x64/);
  assert.match(sec, /system_browser=\[msedge,chrome\]/);
  assert.match(sec, /Never Privately Pre-Design the Whole Project/);
  assert.match(sec, /immediately call `team_dispatch/);
  assert.match(sec, /Epistemic Boundary Rule/);
  assert.match(sec, /Two-Tier Obstacle Rule/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dp01-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new TeamStore(dir, 'team-dp01');
  store.ensure({ workspace: dir, surface: 'headless' });

  assert.equal(formatLeaderGovernanceContext(store, 1), '');

  store.appendGovernanceEvent({
    type: 'conference-opened',
    taskSeq: 1,
    conferenceId: 'conf-live-1',
    disputeId: 'disp-1',
    strike: 1,
    openingStatement: 'Clarify interface',
    keyQuestions: ['Why?'],
  });
  const activeGovCtx = formatLeaderGovernanceContext(store, 1);
  assert.match(activeGovCtx, /ACTIVE FORMAL CONFERENCE "conf-live-1"/);
  assert.match(activeGovCtx, /explanation, new_evidence_files, proposed_alternative/);

  store.appendWorkflowEvent({
    type: 'plan-increment',
    taskSeq: 1,
    overview: { summary: 'Build app', approach: 'Modular', acceptance: ['Tests pass'], estimated_minutes: 20, future_work: ['s1', 's2'] },
  });
  const frontierCtx = formatFrontierContext(store, 1, cfg);
  assert.match(frontierCtx, /define ONLY the first executable stage\(s\)/);
});

test('[DP-03] Host runtime facts privacy, web_search/web_fetch SSRF & user-prohibition rules, and direct_exec epistemic boundary note', () => {
  const cfg = loadConfig(DEFAULT_CONFIG_FILE, { includeLocal: false });
  assert.ok(cfg.profiles.leader.tools.includes('web_search') && cfg.profiles.leader.tools.includes('web_fetch'));
  assert.ok(cfg.profiles.readonly.tools.includes('web_search') && cfg.profiles.readonly.tools.includes('web_fetch'));
  assert.ok(cfg.profiles.shell.tools.includes('web_search') && cfg.profiles.shell.tools.includes('web_fetch'));
  assert.equal(cfg.profiles.code.tools.includes('web_search'), false);

  const patchText = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.equal((patchText.match(/@deepseek-ai\/dsh-tool-web/g) ?? []).length, 3);

  const liveFacts = probeHostRuntimeFacts();
  const formattedFacts = formatHostRuntimeFacts(liveFacts);
  assert.doesNotMatch(formattedFacts, /Users\\|\/home\/|Program Files/i);

  assert.equal(isNetworkForbiddenByUser(['联网只查 wiki 类公开资料，用来了解机制和数值。']), false);
  assert.equal(isNetworkForbiddenByUser(['全程禁止联网，纯离线完成']), true);
  assert.equal(isNetworkForbiddenByUser(['Do not use the internet for this task.']), true);

  assert.equal(inspectWebFetchUrlSafety('https://en.wikipedia.org/wiki/Tower_defense').safe, true);
  for (const badUrl of [
    'file:///C:/Windows/win.ini',
    'http://localhost:3425/v1/models',
    'http://127.0.0.1:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.1/',
    'http://10.0.0.5/',
    'http://172.20.0.1/',
    'http://[::1]:3000/',
    'https://user:pass@example.com/',
  ]) {
    assert.equal(inspectWebFetchUrlSafety(badUrl).safe, false, `must block unsafe URL: ${badUrl}`);
  }

  const leaderActor = { role: 'leader', allowedTools: cfg.profiles.leader.tools, loadedTools: cfg.profiles.leader.tools };
  assert.equal(
    evaluateHardRules({ tool: 'web_fetch', args: { url: 'https://developer.mozilla.org/en-US/' }, actor: leaderActor, cwd: ROOT, userTexts: ['联网只查公开文档'] }, cfg),
    undefined,
  );
  assert.equal(
    evaluateHardRules({ tool: 'web_fetch', args: { url: 'http://127.0.0.1:3425/v1/models' }, actor: leaderActor, cwd: ROOT, userTexts: [] }, cfg)?.rule,
    'web-fetch-url-blocked',
  );
  assert.equal(
    evaluateHardRules({ tool: 'web_search', args: { query: 'test' }, actor: leaderActor, cwd: ROOT, userTexts: ['请不要联网'] }, cfg)?.rule,
    'network-forbidden-by-user',
  );
  assert.equal(classifySandboxBoundary({ tool: 'web_fetch', args: { url: 'https://example.com' }, actor: leaderActor, cwd: ROOT }, cfg).confined, true);

  const directActor = { role: 'direct_exec', allowedTools: ['read', 'pwsh'], loadedTools: ['read', 'pwsh'], writeScope: ['src/**'] };
  const hardDeny = evaluateHardRules({
    tool: 'read',
    args: { file_path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    actor: directActor,
    cwd: 'C:\\workspace\\proj',
    platform: 'win32',
  }, cfg);
  assert.equal(hardDeny?.rule, 'direct-exec-sandbox-lock');
  assert.ok(hardDeny?.reason.includes(DIRECT_EXEC_EPISTEMIC_NOTE.trim()));
  const gateDeny = evaluateDirectExecSafetyGate({
    tool: 'pwsh',
    args: { command: 'Test-Path "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"' },
    actor: directActor,
    cwd: 'C:\\workspace\\proj',
    platform: 'win32',
  }, cfg);
  assert.equal(gateDeny.by, 'rule:direct-exec-sandbox-lock');
  assert.ok(gateDeny.reason.includes(DIRECT_EXEC_EPISTEMIC_NOTE.trim()));
  assert.match(directExecSection({ name: 'direct-exec-1', model: 'm', effort: 'low', allowedTools: ['read'], task: 'check' }), /NEVER claim or imply that an external binary, browser, font, or URL does not exist/);
});

test('[DP-04, DP-05 & DP-06] Blank-session rebinding, enforce diagnostic stop reporting + UI session alignment, and executionFallbacks auto-pruning', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dp04-06-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  const rawCfg = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
  assert.equal(rawCfg.team.leaderModelPolicy, 'follow');
  rawCfg.team.leaderModelPolicy = 'enforce';
  rawCfg.team.executionFallbacks = {
    'codex/gpt-6.1-sol': ['zcode/GLM-5.3', 'codex/gpt-6.1-terra'],
    'zcode/GLM-5.3': ['zcode/GLM-5.3-Flash'],
  };
  fs.writeFileSync(cfgFile, JSON.stringify(rawCfg, null, 2) + '\n', 'utf8');

  const narrowBase = applyModelConfigChanges(
    { poolSet: ['zcode/GLM-5.3-Flash'] },
    { configFile: cfgFile, target: 'base', syncPatches: false },
  );
  assert.deepEqual(narrowBase.effective.executionPool, ['zcode/GLM-5.3-Flash']);
  assert.equal(narrowBase.writtenConfig.team.executionFallbacks, undefined);
  assert.ok(narrowBase.warnings.some(w => w.includes('pruned')));

  fs.writeFileSync(cfgFile, JSON.stringify(rawCfg, null, 2) + '\n', 'utf8');
  const narrowLocal = applyModelConfigChanges(
    { poolSet: ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash'] },
    { configFile: cfgFile, target: 'local', syncPatches: false },
  );
  assert.deepEqual(narrowLocal.effective.executionPool, ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash']);
  const reloadedMerged = loadConfig(cfgFile);
  assert.deepEqual(reloadedMerged.team.executionFallbacks, { 'zcode/GLM-5.3': ['zcode/GLM-5.3-Flash'] });
  assert.deepEqual(
    mergeConfigLayers(rawCfg, { team: { executionPool: ['zcode/GLM-5.3-Flash'] } }).team.executionFallbacks,
    undefined,
  );

  fs.rmSync(path.join(tmp, 'leaderteam.local.json'), { force: true });
  fs.writeFileSync(cfgFile, JSON.stringify(rawCfg, null, 2) + '\n', 'utf8');
  const storageRoot = path.join(tmp, 'storage');
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });

  const rt = runtime();
  const loaded0 = loadConfig(cfgFile);
  bindRuntimeConfigFile(rt, cfgFile, loaded0);
  Object.assign(rt, {
    storageRoot,
    surface: 'desktop',
    startupReady: { coreVersion: '2.2.2' },
    llm: { listModels: async () => [] },
    actors: new Map(),
    stores: new Map(),
    teamConfigViews: new Map(),
    plugins: { scheduler: null, consensus: null, timerArchive: null, panel: {} },
    cordisCompositionMode: false,
  });

  let selectedModel = { provider: 'magpie', model: 'zcode/GLM-5.3', reasoningEffort: 'high' };
  const sessionEvents = [];
  const blankSessionId = 'session-blank-reused';
  const blankAgent = {
    id: blankSessionId,
    session: { id: blankSessionId, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: {
      current: () => selectedModel,
      select: next => { selectedModel = { ...next }; },
    },
  };
  const blankStore = teamStore(blankSessionId);
  blankStore.ensure({ workspace: ws, surface: 'desktop' });
  rt.actors.set(blankSessionId, {
    role: 'leader',
    teamId: blankSessionId,
    agentId: blankSessionId,
    name: 'leader',
    profile: 'leader',
    allowedTools: rt.config.profiles.leader.tools,
    loadedTools: rt.config.profiles.leader.tools,
    cwd: ws,
    agent: blankAgent,
  });

  assert.equal(runtimeForTeam(blankSessionId).config.roles.leader.route, 'codex/gpt-6.1-sol');
  assert.equal(isTeamExecutionStarted(blankStore), false);

  const tools = new Map();
  const ctx = {
    tools: { register: def => { tools.set(def.name, def); return () => {}; } },
    effect: fn => fn(),
    get: () => null,
    llm: rt.llm,
  };
  registerTeamTools(ctx);

  assert.equal(rt.config.team.leaderModelPolicy, 'enforce');
  await assert.rejects(() => tools.get('team_models').execute({}, { agent: blankAgent }), /leader model check failed/);
  await assert.rejects(() => tools.get('team_status').execute({}, { agent: blankAgent }), /leader model check failed/);
  await assert.rejects(() => tools.get('team_status').execute({ stop_state: 'delivered', reason: 'fake' }, { agent: blankAgent }), /leader model check failed/);

  const blockedStop = await tools.get('team_status').execute(
    { stop_state: 'blocked', reason: 'Leader model mismatch requires alignment' },
    { agent: blankAgent },
  );
  assert.equal(blockedStop.stop_declaration.recorded, true);
  assert.equal(blockedStop.leader_model_blocked, true);

  assert.equal(isTeamExecutionStarted(blankStore), true);
  assert.equal(rebindUnstartedTeamGovernance(rt, blankSessionId).rebound, false);

  const freshId = 'session-blank-2';
  let freshSel = { provider: 'magpie', model: 'zcode/GLM-5.3-Flash', reasoningEffort: 'high' };
  const freshAgent = {
    id: freshId,
    session: { id: freshId, header: { cwd: ws }, snapshotEvents: () => [] },
    model: {
      current: () => freshSel,
      select: next => { freshSel = { ...next }; },
    },
  };
  teamStore(freshId).ensure({ workspace: ws, surface: 'desktop' });
  runtimeForTeam(freshId);
  rt.actors.set(freshId, {
    role: 'leader',
    teamId: freshId,
    agentId: freshId,
    name: 'leader',
    profile: 'leader',
    allowedTools: rt.config.profiles.leader.tools,
    loadedTools: rt.config.profiles.leader.tools,
    cwd: ws,
    agent: freshAgent,
  });

  const handlers = createPanelHandlers(ctx, rt);
  const jsonHeaders = { 'content-type': 'application/json' };
  const stRes = await (await handlers.state(new Request('http://local/state', { method: 'POST', headers: jsonHeaders, body: '{}' }))).json();
  assert.equal(stRes.ok, true);
  const mismatchRow = stRes.value.leaderSessionChecks.find(r => r.sessionId === freshId);
  assert.equal(mismatchRow?.status, 'mismatch');
  assert.equal(mismatchRow?.blocked, true);

  const alignCfgRes = await (await handlers.apply(new Request('http://local/apply', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ target: 'base', changes: { alignLeaderSession: { sessionId: freshId, mode: 'config-to-session' } } }),
  }))).json();
  assert.equal(alignCfgRes.ok, true);
  assert.equal(runtimeForTeam(freshId).config.roles.leader.route, 'zcode/GLM-5.3-Flash');
  const afterCheck = alignCfgRes.value.state.leaderSessionChecks.find(r => r.sessionId === freshId);
  assert.equal(afterCheck?.status, 'match');

  freshSel = { provider: 'magpie', model: 'codex/gpt-6.1-sol', reasoningEffort: 'low' };
  const alignSessRes = await (await handlers.apply(new Request('http://local/apply', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ target: 'base', changes: { alignLeaderSession: { sessionId: freshId, mode: 'session-to-config' } } }),
  }))).json();
  assert.equal(alignSessRes.ok, true);
  assert.equal(freshSel.model, 'zcode/GLM-5.3-Flash');
  assert.equal(freshSel.reasoningEffort, 'high');
  assert.ok(rebindAllUnstartedTeams(ctx, rt));
});
