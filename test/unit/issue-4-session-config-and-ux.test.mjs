import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLeaderModel, quotaGate } from '../../leaderteam/core/models.mjs';
import { applyModelConfigChanges } from '../../leaderteam/core/model-config-writer.mjs';
import {
  assertUserConfigPrincipal,
  isProtectedLeaderTeamConfigPath,
  mutateSessionConfig,
  readSessionConfigRecord,
  buildAutoAdoptedLocalOverrideFromDshModels,
} from '../../leaderteam/core/session-config.mjs';
import {
  runtime,
  runtimeForTeam,
  teamStore,
  bindRuntimeConfigFile,
  syncRuntimeConfig,
  rebindTeamGovernanceSnapshot,
  rebindAllIdleSessionsOnGlobalUserSave,
  syncSessionLeaderSelectionFromHost,
  flushPendingSessionConfigAtSafeBoundary,
} from '../../leaderteam/host/runtime.mjs';
import { registerHooks } from 'node:module';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-issue4:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-issue4:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-issue4:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class ToolExecutionPipeline { async dispatchToolBody(exec) { const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet); return await tool.execute(exec.arguments, exec); } }',
      };
    }
    if (url === 'virtual-issue4:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: '{"version":"0.2.3-alpha.2"}' };
    }
    if (url.startsWith('virtual-issue4:')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler {} export const createUserMessage = x => x; export default {};',
      };
    }
    return nextLoad(url, context);
  },
});
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

function withIsolatedRuntime(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-issue4-'));
  const dshHome = path.join(tmp, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const cfgDir = path.join(storageRoot, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), cfgFile);

  const rt = runtime();
  const prev = { ...rt };
  Object.assign(rt, {
    config: null,
    configPath: null,
    configWatch: null,
    storageRoot,
    actors: new Map(),
    stores: new Map(),
    teamConfigViews: new Map(),
    inFlightToolDispatchesByTeam: new Map(),
    inFlightShellCallsBySession: new Map(),
    simpleDispatchInFlight: new Map(),
    executionReviewJobs: new Map(),
    governanceJobs: new Map(),
    stopReviewPending: new Set(),
    directiveVerifyPending: new Set(),
    upstreamCatalog: null,
  });
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));

  t.after(() => {
    Object.assign(rt, prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return { tmp, dshHome, storageRoot, cfgFile, rt };
}

test('Issue #4 (1): User manual DSH session model/effort switch auto-syncs ONLY that session without throwing or polluting global/other sessions', t => {
  const { rt, cfgFile } = withIsolatedRuntime(t);

  // Create two sessions: sess-alpha and sess-beta
  teamStore('sess-alpha').ensure({ workspace: '/tmp/ws-a', surface: 'desktop' });
  teamStore('sess-beta').ensure({ workspace: '/tmp/ws-b', surface: 'desktop' });
  assert.equal(runtimeForTeam('sess-alpha').config.roles.leader.route, 'codex/gpt-6.1-sol');
  assert.equal(runtimeForTeam('sess-beta').config.roles.leader.route, 'codex/gpt-6.1-sol');

  // User manually switches model & effort in DSH picker on sess-alpha to openai/gpt-4.1 (medium)
  const mockAgentAlpha = {
    id: 'sess-alpha',
    status: 'idle',
    model: {
      current: () => ({ provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'medium' }),
    },
  };
  const syncRes = syncSessionLeaderSelectionFromHost(null, rt, mockAgentAlpha, { atUserTurnStart: true });
  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.appliedImmediately, true);

  // sess-alpha immediately reflects the user's chosen model & effort, and heals placeholder review roles!
  const alphaCfg = runtimeForTeam('sess-alpha').config;
  assert.equal(alphaCfg.roles.leader.route, 'openai/gpt-4.1');
  assert.equal(alphaCfg.roles.leader.effort, 'medium');
  assert.equal(alphaCfg.roles.gate.route, 'openai/gpt-4.1');

  // Direct OpenAI GPT passes quotaGate freely when stateFile is null
  assert.equal(quotaGate(alphaCfg, null, 'openai/gpt-4.1', new Date()).allowed, true);

  // checkLeaderModel under default `follow` never blocks
  const lm = checkLeaderModel(alphaCfg, mockAgentAlpha.model.current());
  assert.equal(lm.blocked, false);

  // Global config on disk AND sess-beta remain 100% untouched!
  const localFile = path.join(path.dirname(cfgFile), 'leaderteam.local.json');
  assert.equal(fs.existsSync(localFile), false);
  assert.equal(runtimeForTeam('sess-beta').config.roles.leader.route, 'codex/gpt-6.1-sol');
});

test('Issue #4 (2): Idle sessions update immediately on config save; executing sessions stage changes and switch cleanly at safe boundary', async t => {
  const { rt, dshHome } = withIsolatedRuntime(t);

  teamStore('sess-idle').ensure({ workspace: '/tmp/ws-idle', surface: 'desktop' });
  const busyStore = teamStore('sess-running');
  busyStore.ensure({ workspace: '/tmp/ws-run', surface: 'desktop' });
  busyStore.addMember({
    childId: 'worker-running-1',
    name: 'impl-worker',
    profile: 'code',
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
    taskSeq: 1,
    allowedTools: ['read'],
    writeScope: ['src/**'],
    refs: [],
    task: 'implement feature',
    acceptance: ['pass'],
  });
  busyStore.setMemberStatus('worker-running-1', 'running');

  // Force initial governance snapshots on both sessions
  assert.equal(runtimeForTeam('sess-idle').config.roles.leader.route, 'codex/gpt-6.1-sol');
  assert.equal(runtimeForTeam('sess-running').config.roles.leader.route, 'codex/gpt-6.1-sol');

  let selectedTargetOnRunningAgent = null;
  rt.actors.set('sess-running', {
    role: 'leader',
    teamId: 'sess-running',
    agent: {
      id: 'sess-running',
      status: 'running',
      model: {
        select(tgt) { selectedTargetOnRunningAgent = tgt; },
      },
    },
  });

  const handlers = createPublicContractHandlers(null, rt, { dshHome });

  // 1. User saves global role change while sess-idle is idle and sess-running is executing
  const globalRes = await (await handlers.runtimeConfigure(
    new Request('http://127.0.0.1/api/lt/v1/runtime/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: 'local',
        changes: {
          setRoles: [{ role: 'leader', route: 'zcode/GLM-5.3' }], // effort auto-aligned!
        },
      }),
    }),
  )).json();
  assert.equal(globalRes.ok, true);
  assert.ok(globalRes.data.idleRebind.reboundIds.includes('sess-idle'));
  assert.ok(globalRes.data.idleRebind.skippedBusyIds.includes('sess-running'));

  // Idle session updated IMMEDIATELY without needing a new session!
  assert.equal(runtimeForTeam('sess-idle').config.roles.leader.route, 'zcode/GLM-5.3');
  // Executing session was NOT disturbed mid-flight!
  assert.equal(runtimeForTeam('sess-running').config.roles.leader.route, 'codex/gpt-6.1-sol');

  // 2. User also configures a session-specific model for sess-running while it is still executing -> staged!
  const stageRes = await (await handlers.workbenchSessionConfig(
    new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'set',
        sessionId: 'sess-running',
        syncAllRolesToLeader: true,
        patch: {
          models: {
            'deepseek/deepseek-reasoner': {
              provider: 'deepseek',
              upstreamModel: 'deepseek-reasoner',
              family: 'deepseek',
              label: 'DeepSeek Reasoner',
              efforts: ['none', 'high'],
              defaultEffort: 'high',
            },
          },
          roles: {
            leader: { route: 'deepseek/deepseek-reasoner', effort: 'high' },
          },
        },
      }),
    }),
  )).json();
  assert.equal(stageRes.ok, true);
  assert.equal(stageRes.data.appliedImmediately, false);
  assert.equal(stageRes.data.stagedForSafeBoundary, true);
  assert.equal(runtimeForTeam('sess-running').config.roles.leader.route, 'codex/gpt-6.1-sol');

  // 3. Running member finishes and leader reaches idle safe boundary -> staged config flushes automatically!
  busyStore.setMemberStatus('worker-running-1', 'done');
  rt.actors.get('sess-running').agent.status = 'idle';
  const flushRes = flushPendingSessionConfigAtSafeBoundary(null, rt, 'sess-running');
  assert.equal(flushRes.flushed, true);
  assert.equal(runtimeForTeam('sess-running').config.roles.leader.route, 'deepseek/deepseek-reasoner');
  assert.equal(selectedTargetOnRunningAgent?.provider, 'deepseek');
  assert.equal(selectedTargetOnRunningAgent?.model, 'deepseek-reasoner');
  // And sess-idle still has its own global `zcode/GLM-5.3`!
  assert.equal(runtimeForTeam('sess-idle').config.roles.leader.route, 'zcode/GLM-5.3');
});

test('Issue #4 (3): Agent vs User principal separation + Safety Gate blocks agent config tampering + opt-in enforce preserved', t => {
  const { rt, storageRoot, cfgFile } = withIsolatedRuntime(t);

  // 1. Agent principal or in-flight tool dispatch is strictly forbidden from mutating config
  assert.throws(
    () => assertUserConfigPrincipal({ kind: 'agent', source: 'leader' }),
    err => err.code === 'AGENT_CONFIG_MUTATION_FORBIDDEN' && err.statusCode === 403,
  );
  assert.throws(
    () =>
      mutateSessionConfig({
        storageRoot,
        sessionId: 'sess-sec',
        baseConfig: rt.config,
        patch: { roles: { leader: { route: 'zcode/GLM-5.3' } } },
        principal: { kind: 'user', source: 'lt-public-v1' },
        inAgentToolDispatch: true,
      }),
    err => err.code === 'AGENT_CONFIG_MUTATION_FORBIDDEN',
  );
  assert.throws(
    () => rebindTeamGovernanceSnapshot(rt, 'sess-sec', { principal: { kind: 'agent', source: 'member' } }),
    err => err.code === 'AGENT_CONFIG_MUTATION_FORBIDDEN',
  );

  // 2. Safety Gate hard-blocks agent file writes or shell commands targeting LT config / session-config / governance
  assert.equal(isProtectedLeaderTeamConfigPath(cfgFile, { storageRoot, configPath: cfgFile }), true);
  const gate = new Gate({});
  const actor = {
    role: 'leader',
    executionMode: 'single',
    teamId: 'sess-sec',
    agentId: 'sess-sec',
    cwd: '/tmp/ws-sec',
    allowedTools: ['write', 'bash'],
  };
  const writeHit = gate.checkHardRules({
    name: 'write',
    args: { file_path: cfgFile, content: '{}' },
    agent: { id: 'sess-sec', session: { header: { cwd: '/tmp/ws-sec' } } },
    actor,
  });
  assert.equal(writeHit?.rule, 'protected-lt-config');

  const shellHit = gate.checkHardRules({
    name: 'bash',
    args: { command: `echo '{}' > "${path.join(storageRoot, 'teams', 'sess-sec', 'session-config.json')}"` },
    agent: { id: 'sess-sec', session: { header: { cwd: '/tmp/ws-sec' } } },
    actor,
  });
  assert.equal(shellHit?.rule, 'protected-lt-config');

  // 3. Opt-in `enforce` mode still strictly blocks mismatched model/effort when user enables it
  mutateSessionConfig({
    storageRoot,
    sessionId: 'sess-enforced',
    baseConfig: rt.config,
    patch: { team: { leaderModelPolicy: 'enforce' } },
    principal: { kind: 'user', source: 'test-user' },
    isBusy: false,
  });
  const enforcedCfg = runtimeForTeam('sess-enforced').config;
  assert.equal(enforcedCfg.team.leaderModelPolicy, 'enforce');
  const blockedCheck = checkLeaderModel(enforcedCfg, { provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'high' });
  assert.equal(blockedCheck.blocked, true);

  // 4. Manual config helper tolerates disabling base catalog models in local mode & auto-adopts host models
  applyModelConfigChanges(
    { removeModels: ['codex/gpt-6-astra'] },
    { configFile: cfgFile, target: 'local', autoAlignRoleEfforts: true },
  );
  const afterRemoveCfg = loadConfig(cfgFile);
  assert.equal(afterRemoveCfg.team.executionPool.includes('codex/gpt-6-astra'), false);

  const adopted = buildAutoAdoptedLocalOverrideFromDshModels([
    {
      route: 'dashscope/qwen3-max',
      provider: 'dashscope',
      upstreamModel: 'qwen3-max',
      family: 'qwen',
      label: 'Qwen3 Max',
      efforts: ['none', 'high'],
      defaultEffort: 'high',
      registeredInDsh: true,
    },
  ]);
  assert.equal(adopted.roles.leader.route, 'dashscope/qwen3-max');
  assert.equal(adopted.team.leaderModelPolicy, 'follow');
});
