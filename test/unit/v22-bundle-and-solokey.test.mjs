import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from '../../leaderteam/core/config.mjs';
import {
  SOLO_PROVIDER_PRESETS,
  detectSoloKeyPreset,
  buildSoloKeyStarterConfig,
  resolveOrBootstrapConfigPath,
} from '../../leaderteam/core/solo-key.mjs';
import { roleRouteChain } from '../../leaderteam/core/role-routes.mjs';
import { locateHostAnchor } from '../../leaderteam/host/host-imports.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-v22:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v22:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.5' }) };
    }
    if (url === 'virtual-v22:@deepseek-ai/dsh-tools/pipeline') {
      return { format: 'module', shortCircuit: true, source: 'export class ToolExecutionPipeline {}' };
    }
    if (url === 'virtual-v22:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const TOOL_ABORTED_BEFORE_DISPATCH = "aborted";' };
    }
    if (url === 'virtual-v22:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler {} export function createUserMessage(t) { return { text: t }; } export function createToolResultMessage(r) { return r; }',
      };
    }
    return nextLoad(url, context);
  },
});

const { assertCompatiblePipeline } = await import('../../leaderteam/host/final-gate.mjs');
const { runtime, bindRuntimeConfigFile, teamStore } = await import('../../leaderteam/host/runtime.mjs');
const {
  ensureScheduler,
  pollAndDeliverPowerMonitor,
  evaluateTeamConcurrency,
  evaluateTeamRequestWindow,
  formatLeaderConcurrencyContext,
  loadPersistedPowerState,
} = await import('../../leaderteam/host/concurrency.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('root package.json and cordis.patch.yml conform to official DSH bundle rules', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const innerPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'leaderteam/package.json'), 'utf8'));
  const webPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/lt-web/package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-leaderteam');
  assert.equal(pkg.version, '1.0.0');
  assert.equal(innerPkg.version, pkg.version);
  assert.equal(innerPkg.leaderteam?.brand, 'Open Leader Team');
  assert.equal(innerPkg.leaderteam?.shortBrand, 'OLT');
  assert.equal(innerPkg.leaderteam?.brandEpoch, 2);
  assert.equal(webPkg.version, pkg.version);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  // Review check #3: never emit non-standard dsh.compatibility.dshReleases; use bounded engines.dsh
  assert.equal(pkg.dsh?.compatibility, undefined);
  assert.equal(pkg.engines?.dsh, '>=0.2.2-alpha.2 <1.0.0');

  // Every exported subpath target and bundle patch file must exist on disk
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath.includes('*')) continue;
    const abs = path.join(ROOT, target);
    assert.ok(fs.existsSync(abs), `export ${subpath} -> ${target} exists`);
  }
  const patchText = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patchText, /name:\s*dsh-leaderteam\/native-executor/);
  assert.match(patchText, /name:\s*dsh-leaderteam\/core/);
  assert.match(patchText, /name:\s*dsh-leaderteam\/lead/);
  assert.ok(fs.existsSync(path.join(ROOT, 'icon.svg')));
  assert.ok(fs.existsSync(path.join(ROOT, 'locale/en.json')));
  assert.ok(fs.existsSync(path.join(ROOT, 'locale/zh-CN.json')));
});

test('Solo-Key starter presets produce strictly valid frozen configs with active non-retired models and full role fallbacks', () => {
  const RETIRED_MODELS = new Set([
    'deepseek-reasoner',
    'deepseek-chat',
    'qwen-coder-plus',
    'qwen3-coder-plus',
  ]);
  const baseRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  for (const preset of SOLO_PROVIDER_PRESETS) {
    const raw = buildSoloKeyStarterConfig(baseRaw, { preset });
    const validated = validateConfig(raw);
    assert.equal(validated.magpie.provider, preset.provider);
    assert.equal(validated.roles.leader.route, preset.reasoningRoute);
    assert.equal(validated.team.leaderModelPolicy, 'follow');
    assert.equal(validated.governance.mode, 'autonomous');
    assert.equal(validated.powerMonitor.enabled, true);
    assert.equal(validated.powerMonitor.pollIntervalMs, 720000);
    for (const [route, spec] of Object.entries(validated.models)) {
      const up = spec.upstreamModel ?? route;
      assert.equal(RETIRED_MODELS.has(up), false, `Solo-Key preset "${preset.id}" must not use retired model "${up}"`);
    }
    if (preset.chatRoute !== preset.reasoningRoute) {
      assert.ok(validated.roles.serialReviewer.fallback?.length >= 1, `${preset.id} serialReviewer must configure fallback route`);
      assert.ok(validated.roles.directExec.fallback?.length >= 1, `${preset.id} directExec must configure fallback route`);
    }
  }

  // Verify smoke-bugfix config also uses active DeepSeek V4 models (zero retired model IDs)
  const smokeCfg = loadConfig(path.join(ROOT, 'examples/smoke-bugfix/leaderteam.smoke.json'));
  for (const [route, spec] of Object.entries(smokeCfg.models)) {
    assert.equal(RETIRED_MODELS.has(spec.upstreamModel ?? route), false, `smoke config must not use retired model "${route}"`);
  }
  assert.equal(smokeCfg.roles.leader.route, 'deepseek/deepseek-v4-pro');
  assert.equal(smokeCfg.roles.directExec.route, 'deepseek/deepseek-flash');

  // Verify DashScope preset uses active `qwen-max` + `qwen-plus` AND `roleRouteChain` resolves prefixed leaderModel fallback
  const dashPreset = SOLO_PROVIDER_PRESETS.find(p => p.id === 'dashscope');
  assert.equal(dashPreset?.reasoningRoute, 'dashscope/qwen-max');
  assert.equal(dashPreset?.chatRoute, 'dashscope/qwen-plus');
  const dashNoExplicitFb = buildSoloKeyStarterConfig(baseRaw, { preset: dashPreset });
  delete dashNoExplicitFb.roles.serialReviewer.fallback;
  const dashValidated = validateConfig(dashNoExplicitFb);
  const srChain = roleRouteChain(dashValidated, 'serialReviewer', { provider: 'dashscope', model: 'qwen-max', reasoningEffort: 'high' });
  assert.deepEqual(srChain.map(c => c.route), ['dashscope/qwen-plus', 'dashscope/qwen-max']);

  assert.equal(detectSoloKeyPreset({ env: { DEEPSEEK_API_KEY: 'sk-test-123' } })?.preset.id, 'deepseek');
  assert.equal(detectSoloKeyPreset({ env: { ZHIPU_API_KEY: 'zp-test-123' } })?.preset.id, 'zhipu');
  assert.equal(detectSoloKeyPreset({ env: {} }), null);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v22-bootstrap-'));
  try {
    const res1 = resolveOrBootstrapConfigPath({
      explicitConfigPath: null,
      env: { DEEPSEEK_API_KEY: 'sk-test-123' },
      dshHome: tmpHome,
      bundledDefaultConfigPath: path.join(ROOT, 'config/leaderteam.config.json'),
    });
    assert.equal(res1.bootstrapped, true);
    assert.equal(res1.mode, 'solo-deepseek');
    const loaded = loadConfig(res1.configPath);
    assert.equal(loaded.roles.leader.route, 'deepseek/deepseek-v4-pro');

    // Second call reuses existing managed config idempotently
    const res2 = resolveOrBootstrapConfigPath({
      explicitConfigPath: null,
      env: { ZHIPU_API_KEY: 'zp-ignored' },
      dshHome: tmpHome,
      bundledDefaultConfigPath: path.join(ROOT, 'config/leaderteam.config.json'),
    });
    assert.equal(res2.bootstrapped, false);
    assert.equal(res2.mode, 'managed-existing');
    assert.equal(res2.configPath, res1.configPath);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('host-imports locates @deepseek-ai/dsh-tools across Linux/Windows npm CLI trees and Desktop app.asar', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v22-host-'));
  try {
    // Mock Linux/Windows npm CLI layout: `<carrier>/node_modules/@deepseek-ai/{dsh,dsh-tools}`
    const dshBin = path.join(tmp, 'carrier', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const toolsPkg = path.join(tmp, 'carrier', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json');
    const carrierPkg = path.join(tmp, 'carrier', 'package.json');
    fs.mkdirSync(path.dirname(dshBin), { recursive: true });
    fs.mkdirSync(path.dirname(toolsPkg), { recursive: true });
    fs.writeFileSync(carrierPkg, JSON.stringify({ name: 'carrier', private: true }));
    fs.writeFileSync(dshBin, '#!/usr/bin/env node\n');
    fs.writeFileSync(toolsPkg, JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.2-rc.5' }));

    const found = locateHostAnchor({
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', dshBin, 'web'],
      env: {},
      pluginRoot: path.join(tmp, 'other-dir'),
    });
    assert.ok(found, 'locates npm CLI carrier');
    assert.equal(path.resolve(found.moduleRoot), path.resolve(path.join(tmp, 'carrier')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('version boundary strictly rejects unverified host versions even when pipeline strings match (no unsafe env bypass)', () => {
  const validProto = {
    resolveExecution() {},
    dispatchToolBody: new Function('exec', `
      const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
      return async () => await tool.execute(exec.arguments, exec);
    `),
  };
  const supported = ['0.2.2-rc.1', '0.2.2-rc.5'];
  assert.doesNotThrow(() => assertCompatiblePipeline(validProto, '0.2.2-rc.1', supported));
  assert.doesNotThrow(() => assertCompatiblePipeline(validProto, '0.2.2-rc.5', supported));
  // Unverified 0.2.3-alpha.2 MUST fail closed even if LT_ALLOW_UNVERIFIED_DSH=1 is set in env
  const prev = process.env.LT_ALLOW_UNVERIFIED_DSH;
  process.env.LT_ALLOW_UNVERIFIED_DSH = '1';
  try {
    assert.throws(
      () => assertCompatiblePipeline(validProto, '0.2.3-alpha.2', supported),
      /not a verified core version/,
    );
  } finally {
    if (prev === undefined) delete process.env.LT_ALLOW_UNVERIFIED_DSH;
    else process.env.LT_ALLOW_UNVERIFIED_DSH = prev;
  }
});

test('host concurrency wires Battery-Aware Graceful Shutdown and 5h Request Window Guard end-to-end without skipping reviews', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v22-seam-'));
  try {
    const baseRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
    const soloCfgRaw = buildSoloKeyStarterConfig(baseRaw, { preset: SOLO_PROVIDER_PRESETS[0] });
    soloCfgRaw.storage = { root: path.join(tmp, 'store') };
    soloCfgRaw.requestWindow = {
      enabled: true,
      windowMs: 5 * 60 * 60 * 1000,
      softThrottlePct: 20,
      hardPausePct: 5,
      windowsByProvider: { deepseek: { maxRequests: 20 } },
    };
    const cfgFile = path.join(tmp, 'leaderteam.config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(soloCfgRaw, null, 2));

    const rt = runtime();
    rt.storageRoot = soloCfgRaw.storage.root;
    rt.powerMonitorState = null;
    rt.lastRequestWindowAuditKey = null;
    bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));
    ensureScheduler(rt);

    const teamId = 'team-v22-seam';
    const deliveredNotices = [];
    const leaderAgent = {
      id: teamId,
      status: 'running', // busy at first -> notice must persist as pendingNotice!
      session: { snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build module' }] } }] },
      followup(msg) { deliveredNotices.push(msg); },
    };
    rt.actors.set(teamId, { role: 'leader', teamId, agent: leaderAgent });
    const fakeCtx = { get: () => null };

    // 1. Battery at 19% while Leader is busy -> persists pendingNotice=true, caps new dispatches to 0
    const p1 = await pollAndDeliverPowerMonitor(fakeCtx, rt, {
      sample: { status: 'ok', onBattery: true, batteryPct: 19 },
      nowMs: 1000,
    });
    assert.equal(p1.action, 'notify_graceful_shutdown');
    assert.equal(deliveredNotices.length, 0, 'busy leader is not interrupted mid-turn');
    assert.equal(loadPersistedPowerState(rt.storageRoot).pendingNotice, true);
    assert.equal(evaluateTeamConcurrency(fakeCtx, teamId).controls.effective_cap, 0);

    // 2. Leader becomes idle -> next poll/retry delivers once and persists ack (pendingNotice=false)
    leaderAgent.status = 'idle';
    const p2 = await pollAndDeliverPowerMonitor(fakeCtx, rt, {
      sample: { status: 'ok', onBattery: true, batteryPct: 19 },
      nowMs: 2000,
    });
    assert.equal(p2.action, 'retry_pending_notice');
    assert.equal(deliveredNotices.length, 1);
    assert.equal(loadPersistedPowerState(rt.storageRoot).pendingNotice, false);

    // 3. Still 19% -> duplicate notice suppressed
    const p3 = await pollAndDeliverPowerMonitor(fakeCtx, rt, {
      sample: { status: 'ok', onBattery: true, batteryPct: 19 },
      nowMs: 3000,
    });
    assert.equal(p3.action, 'none');
    assert.equal(deliveredNotices.length, 1);

    // 4. AC plugged back in -> latch rearms, autoResumeAllowed stays false, no unsolicited wakeup!
    const p4 = await pollAndDeliverPowerMonitor(fakeCtx, rt, {
      sample: { status: 'ok', onBattery: false, batteryPct: 22 },
      nowMs: 4000,
    });
    assert.equal(p4.action, 'rearmed');
    assert.equal(p4.autoResumeAllowed, false);
    assert.equal(deliveredNotices.length, 1, 'plugging AC in never auto-resumes paused leader');

    // 5. 5h Request Window: simulate 19 calls out of 20 maxRequests (>= 95%) -> checkpoint_pause + audit file, skipGovernanceReviews=false
    const nowMs = Date.now();
    const st = teamStore(teamId);
    for (let i = 0; i < 19; i++) {
      st.appendUsage({ at: new Date(nowMs - i * 1000).toISOString(), role: 'gate', route: 'deepseek/deepseek-flash', ok: true });
    }
    const rw = evaluateTeamRequestWindow(rt, teamId, nowMs);
    assert.equal(rw.tier, 'checkpoint_pause');
    assert.equal(rw.skipGovernanceReviews, false);
    assert.equal(rw.localSource, 'local-estimate');
    assert.equal(rw.confirmedSource, 'unknown');
    assert.ok(fs.existsSync(path.join(rt.storageRoot, 'request-window-audit.jsonl')));

    const ctxText = formatLeaderConcurrencyContext(fakeCtx, teamId);
    assert.match(ctxText, /local_estimated=19 \(local-estimate\)/);
    assert.match(ctxText, /governance reviews never skipped/);
  } finally {
    runtime().actors?.delete?.('team-v22-seam');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('send_message target resolver bridges 0.2.2-rc.1 agent_id and 0.2.2-rc.5 agent (name or childId) without weakening member validation', async () => {
  const { resolveSendMessageTargetId } = await import('../../leaderteam/host/activation.mjs');
  const membersMap = new Map([
    ['uuid-failed-1', { childId: 'uuid-failed-1', name: 'impl', status: 'failed' }],
    ['uuid-done-2', { childId: 'uuid-done-2', name: 'impl', status: 'done' }],
    ['uuid-direct-3', { childId: 'uuid-direct-3', name: 'direct-exec-1', actorRole: 'direct_exec', status: 'done' }],
  ]);
  const fakeStore = {
    getMember: id => membersMap.get(id) ?? null,
    members: () => membersMap,
  };
  assert.equal(resolveSendMessageTargetId(fakeStore, { agent_id: 'uuid-done-2' }), 'uuid-done-2');
  assert.equal(resolveSendMessageTargetId(fakeStore, { agent_id: 'impl' }), 'impl', 'legacy agent_id keeps strict childId check');
  assert.equal(resolveSendMessageTargetId(fakeStore, { agent: 'impl' }), 'uuid-done-2', '0.2.2-rc.5 agent resolves latest active/done member by name');
  assert.equal(resolveSendMessageTargetId(fakeStore, { agent: 'uuid-done-2' }), 'uuid-done-2', '0.2.2-rc.5 agent also accepts childId');
  assert.equal(resolveSendMessageTargetId(fakeStore, { agent: 'direct-exec-1' }), 'direct-exec-1', 'never resolves direct_exec as ordinary member');
});
