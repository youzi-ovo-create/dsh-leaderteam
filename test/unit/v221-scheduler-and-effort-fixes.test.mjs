import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { ElasticConcurrencyScheduler } from '../../leaderteam/core/scheduler.mjs';
import { validateConfig, loadRawConfig } from '../../leaderteam/core/config.mjs';
import { renderMagpieModelRows, parseMagpiePatchModels, applyModelConfigChanges } from '../../leaderteam/core/model-config-writer.mjs';
import { syncUpstreamModelsToDshSettings } from '../../leaderteam/core/upstream-models.mjs';
import { TeamStore } from '../../leaderteam/core/store.mjs';
import { runtime, teamStore } from '../../leaderteam/host/runtime.mjs';
import { configWith } from './helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-v221:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v221:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-v221:@deepseek-ai/dsh-tools/pipeline') {
      return { format: 'module', shortCircuit: true, source: 'export class ToolExecutionPipeline { resolveExecution() {} async dispatchToolBody() {} }' };
    }
    if (url === 'virtual-v221:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: '{"version":"0.2.2-rc.5"}' };
    }
    if (url === 'virtual-v221:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === "text") this._b.push(c); else if (c.type === "text-delta") this._b.push({ type: "text", text: c.text }); } blocks() { return this._b; } } export const boundContextSummary = s => s.slice(0, 120); export const createUserMessage = m => ({ id: "msg-1", role: "user", ...m });',
      };
    }
    return nextLoad(url, context);
  },
});

const { maybeNotifyLeaderScaleUp, onLeaderTurnCompleted, evaluateTeamRequestWindow } = await import('../../leaderteam/host/concurrency.mjs');
const { onAgentStatus, onSessionEvent } = await import('../../leaderteam/host/roles.mjs');
const { callRoleJson } = await import('../../leaderteam/host/llm.mjs');
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');
const { queueAsyncSupervision, retryDeferredSupervisions } = await import('../../leaderteam/host/governance.mjs');
const { replayGovernanceState } = await import('../../leaderteam/core/governance-protocol.mjs');
import { roleRouteChain } from '../../leaderteam/core/role-routes.mjs';
import { parseGateVerdict } from '../../leaderteam/core/gate-policy.mjs';
import { recordUsage } from '../../leaderteam/host/runtime.mjs';

test('V2.2.1 [1a & 1b]: awaitingSlots clears after open-slot turn end, and capacity decreases / 6<->3<->5 ping-pong never trigger redundant wakeups', () => {
  let nowMs = 10_000_000;
  let cpuPct = 15;
  const cfg = configWith({
    team: { maxActiveMembers: 6, maxMembersPerTeam: 32 },
    scheduler: { rampStepSize: 5, rampObserveMs: 500, maxConcurrentShellMembers: 4 },
  });
  const sched = new ElasticConcurrencyScheduler(cfg, {
    now: () => nowMs,
    deviceProbe: () => ({
      logicalCores: 4,
      cpuBusyPct: cpuPct,
      cpuSmoothedPct: cpuPct,
      totalPhysMib: 16384,
      availPhysMib: 13500,
    }),
  });

  const teamId = 'team-sched-repro';
  const taskSeq = 1;
  const fourShell = Array.from({ length: 4 }, (_, i) => ({ id: `s-${i}`, name: `shell-${i}`, status: 'running', profile: 'shell' }));

  // Reproduce 5th shell dispatch rejected by shell_concurrency_limit -> latches awaitingSlots=true while pendingParallelTasks===0
  const rejected = sched.checkDispatch({ teamId, taskSeq, activeMembers: fourShell, profile: 'shell' });
  assert.equal(rejected.allowed, false);
  assert.equal(sched.teamState(teamId, taskSeq).awaitingSlots, true);

  // Leader switches to `code` profile in the same turn, succeeds, and ends Turn 1 with open slots
  nowMs += 1000;
  const admittedCode = sched.admitDispatch({ teamId, taskSeq, activeMembers: fourShell, profile: 'code' });
  assert.equal(admittedCode.allowed, true);
  const fiveActive = [...fourShell, { id: 'c-1', name: 'code-worker', status: 'running', profile: 'code' }];
  const endSnap = sched.evaluate({ teamId, taskSeq, activeMembers: fiveActive });
  assert.equal(endSnap.controls.ramp_available_now, 1);
  sched.advanceLeaderTurn(teamId, taskSeq, endSnap);
  assert.equal(sched.teamState(teamId, taskSeq).awaitingSlots, false, 'awaitingSlots must clear once Leader dispatches and ends turn with open slots');

  // Even when awaitingSlots IS active (e.g. genuine held-back task), capacity drops (6->3, 6->5) and bounce-backs NEVER ping-pong!
  sched.setLeaderPreference(teamId, taskSeq, { pendingParallelTasks: 1, currentAvailableNow: 5 });
  const soleFinalValidation = [{ id: 'f-1', name: 'final-validation', status: 'running', profile: 'shell' }];

  // Initial notice at 1/6 (avail 5): fires ONCE
  cpuPct = 15;
  nowMs += 2000;
  const n1 = sched.shouldNotifyScaleUp({ teamId, taskSeq, activeMembers: soleFinalValidation });
  assert.ok(n1, 'initial scale-up notice at 1/6 fires once');
  assert.equal(n1.availableNow, 5);

  // Reproduce 13:34..13:37 CPU oscillation: 75% (cap 3) -> 40% (cap 6) -> 65% (cap 5) -> 35% (cap 6)
  for (const nextCpu of [75, 40, 65, 35, 65, 30]) {
    cpuPct = nextCpu;
    nowMs += 2000;
    const dup = sched.shouldNotifyScaleUp({ teamId, taskSeq, activeMembers: soleFinalValidation });
    assert.equal(dup, null, `must NOT fire redundant wakeup on CPU=${nextCpu}% capacity drop or bounce-back`);
  }
});

test('V2.2.1 [1c & 1d]: rolling frontier zero-work suppression, terminal delivered hard suppression, and cross-turn delivered preservation', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v221-deliv-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(ws, { recursive: true });

  const cfg = configWith({
    storage: { root: storeRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 6, rollingPlanning: true },
    governance: { mode: 'autonomous' },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const followups = [];
  let sessionEvents = [
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build feature' }] } },
    { seq: 2, type: 'turn/start', data: { turn: 15 } },
    { seq: 3, type: 'assistant/message', data: { turn: 15, message: { content: [{ type: 'text', text: 'All checks passed.' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 15, reason: { kind: 'completed' } } },
  ];
  const leaderAgent = {
    id: 'team-deliv',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    followup(msg) { followups.push(msg); },
    session: { id: 'team-deliv', seq: 4, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  const ctx = { get: k => (k === 'agents' ? new Map([[leaderAgent.id, leaderAgent]]) : null) };
  Object.assign(rt, {
    config: cfg,
    storageRoot: storeRoot,
    surface: 'desktop',
    deviceProbe: () => ({ logicalCores: 8, cpuBusyPct: 10, totalPhysMib: 16384, availPhysMib: 12000 }),
    scheduler: null,
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  const store = teamStore(leaderAgent.id);
  store.ensure({ workspace: ws, surface: 'desktop' });

  // 1. Rolling plan has 1 stage already running (`delivery`) and zero undispatched ready stages -> scheduler wakeup MUST be suppressed
  store.appendWorkflowEvent({ type: 'plan-increment', taskSeq: 1, overview: { summary: 's', approach: 'a', acceptance: ['ok'], estimated_minutes: 10, future_work: ['delivery'] } });
  store.appendWorkflowEvent({
    type: 'plan-increment',
    taskSeq: 1,
    stage: { id: 'delivery', revision: 1, hash: 'h1', contract: { ready: true, goal: 'g', method: 'm', acceptance: ['ok'], interfaces: ['i'], profile: 'shell', tools: ['read', 'bash'], write_scope: ['docs/**'], refs: [], depends_on: [], expected_inputs: [], parallel_with: [], serial_reason: '', dependency_versions: {} } },
  });
  store.addMember({ childId: 'c-deliv', name: 'final-validation', taskSeq: 1, stageId: 'delivery', stageHash: 'h1', profile: 'shell', writeScope: ['docs/**'] });
  store.setMemberStatus('c-deliv', 'running');
  store.appendWorkflowEvent({ type: 'stop-declared', taskSeq: 1, turn: 6, state: 'waiting_members', reason: 'waiting final-validation', question: '' });

  onLeaderTurnCompleted(ctx, leaderAgent.id);
  rt.scheduler.markAwaitingSlots(leaderAgent.id, 1);
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: false }), false, 'zero admissible frontier stages must suppress redundant wakeup');

  // 2. Member finishes & Leader declares `delivered` in Turn 15 -> NO post-delivery scheduler wakeup (reproduces seq=1422 & Turns 18..21)
  store.setMemberStatus('c-deliv', 'done');
  store.appendWorkflowEvent({ type: 'stage-verification', taskSeq: 1, stageId: 'delivery', stageHash: 'h1', generation: 'g1', result: 'passed', evidence: ['ok'] });
  store.appendWorkflowEvent({ type: 'stop-declared', taskSeq: 1, turn: 15, state: 'delivered', reason: 'done', question: '' });
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: false }), false, 'delivered state suppresses scheduler wakeup');
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: true }), false, 'delivered state suppresses even userCapRaised wakeup until next user task');

  // 3. Reproduce Turn 16 -> Turn 17 bug: even if a post-delivery Turn 16 occurred without re-calling team_status, maybeAutoContinueLeader sees Turn 15's delivered state!
  sessionEvents = [
    ...sessionEvents,
    { seq: 5, type: 'turn/start', data: { turn: 16 } },
    { seq: 6, type: 'assistant/message', data: { turn: 16, message: { content: [{ type: 'text', text: '当前计划的全部阶段均已完成并通过验收，无需补派。' }] } } },
    { seq: 7, type: 'turn/end', data: { turn: 16, reason: { kind: 'completed' } } },
  ];
  await onAgentStatus(ctx, { agent: leaderAgent, status: 'idle' });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(followups.length, 0, 'prior delivered declaration in same taskSeq suppresses spurious Work is not yet finalized continuation');
});

test('V2.2.1 [2a & 2b]: +2 upward normal-band deadband suppresses 1-slot CPU boundary jitter & passive sample respects min window', () => {
  let nowMs = 50_000_000;
  let cpuPct = 61; // floor((85-61)/5) = 4 -> 1 + 4 = 5
  const cfg = configWith({ team: { maxActiveMembers: 6 }, scheduler: { sampleIntervalMs: 2000 } });
  const sched = new ElasticConcurrencyScheduler(cfg, {
    now: () => nowMs,
    deviceProbe: () => ({ logicalCores: 8, cpuBusyPct: cpuPct, cpuSmoothedPct: cpuPct, totalPhysMib: 16384, availPhysMib: 12000 }),
  });
  const one = [{ id: 'm1', name: 'w1', status: 'running', profile: 'code' }];

  const s1 = sched.evaluate({ teamId: 't-db', taskSeq: 1, activeMembers: one });
  assert.equal(s1.controls.device_capacity, 5);

  // Tiny 2% CPU dip across 60% boundary (`59%` -> unfiltered 1 + floor(26/5) = 6, only +1 slot): held at 5 by deadband!
  cpuPct = 59;
  nowMs += 2000;
  const s2 = sched.evaluate({ teamId: 't-db', taskSeq: 1, activeMembers: one });
  assert.equal(s2.controls.device_capacity, 5, '1-slot wiggle across 60% CPU boundary is absorbed by upward deadband');

  // Genuine CPU drop (`50%` -> unfiltered 1 + floor(35/5) = 8 >= 5 + 2): steps up cleanly!
  cpuPct = 50;
  nowMs += 2000;
  const s3 = sched.evaluate({ teamId: 't-db', taskSeq: 1, activeMembers: one });
  assert.equal(s3.controls.device_capacity, 8);
});

test('V2.2.1 [3]: explicit off->none wire mapping, preservation of existing settings.yaml off:"none", YAML 1.1 safe quoting, and quote-stripping', async () => {
  // 1. Magpie YAML writer quotes "off": "none" for ['none', 'low', 'high', 'max'] and ['off', 'low', 'high']
  const rendered = renderMagpieModelRows({
    magpie: { provider: 'magpie' },
    models: {
      'zcode/GLM-5.4': { efforts: ['none', 'low', 'high', 'max'], vision: true },
      'codex/gpt-6.2-sol': { efforts: ['off', 'low', 'medium', 'high', 'max'], vision: true },
      'plain/chat-only': { efforts: ['none'], vision: false },
    },
  });
  assert.match(rendered, /id: zcode\/GLM-5\.4.*reasoningEfforts: \{"off": "none", low: low, high: high, max: max\}/);
  assert.match(rendered, /id: codex\/gpt-6\.2-sol.*reasoningEfforts: \{"off": "none", low: low, medium: medium, high: high, max: max\}/);
  assert.doesNotMatch(rendered.split('\n')[2], /reasoningEfforts/);

  // 2. parseMagpiePatchModels strips quotes cleanly so desktop sync never reports false drift on `"off"`
  const parsed = parseMagpiePatchModels(rendered);
  assert.deepEqual(parsed.get('zcode/GLM-5.4'), ['off', 'low', 'high', 'max']);
  assert.deepEqual(parsed.get('codex/gpt-6.2-sol'), ['off', 'low', 'medium', 'high', 'max']);
  assert.deepEqual(parsed.get('plain/chat-only'), ['none']);

  // 3. syncUpstreamModelsToDshSettings preserves user's hand-crafted `off: "none"` when merging new effort keys
  let saved = null;
  const mockCtx = {
    get: name => (name === 'settings' ? {
      describe: () => ({
        namespaces: [{
          ns: 'llm-pi-ai',
          data: {
            providers: {
              magpie: {
                models: [{
                  id: 'zcode/GLM-5.4',
                  input: ['text'],
                  reasoningEfforts: { off: 'none', low: 'low', high: 'high' },
                }],
              },
            },
          },
        }],
      }),
      update: async (_ns, next) => { saved = next; },
    } : null),
  };
  await syncUpstreamModelsToDshSettings(mockCtx, [{
    route: 'zcode/GLM-5.4',
    provider: 'magpie',
    upstreamModel: 'zcode/GLM-5.4',
    efforts: ['off', 'low', 'medium', 'high', 'max'],
    vision: true,
  }], 'magpie');
  assert.ok(saved);
  assert.deepEqual(saved.providers.magpie.models[0].reasoningEfforts, {
    off: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
  });

  // 4. [F06] Brand-new DSH settings entry with logical `efforts: ['off', 'high']` maps `off -> "none"` identically to YAML,
  //    explicit `models[route].reasoningEfforts` passes config validation, and chat-only `['none']` omits reasoningEfforts
  let freshData = { providers: { magpie: { models: [] } } };
  const freshCtx = {
    get: name => (name === 'settings' ? {
      describe: () => ({ namespaces: [{ ns: 'llm-pi-ai', data: freshData }] }),
      update: async (_ns, next) => { freshData = next; },
    } : null),
  };
  await syncUpstreamModelsToDshSettings(freshCtx, [
    { route: 'codex/gpt-6.1-sol', provider: 'magpie', efforts: ['off', 'high'], vision: false },
    { route: 'custom/wire', provider: 'magpie', efforts: ['off', 'max'], reasoningEfforts: { off: 'disabled', max: 'ultra' }, vision: false },
    { route: 'plain/chat', provider: 'magpie', efforts: ['none'], vision: false },
  ], 'magpie');
  assert.deepEqual(freshData.providers.magpie.models[0].reasoningEfforts, { off: 'none', high: 'high' });
  assert.deepEqual(freshData.providers.magpie.models[1].reasoningEfforts, { off: 'disabled', max: 'ultra' });
  assert.equal(freshData.providers.magpie.models[2].reasoningEfforts, undefined);

  const rawExplicit = loadRawConfig(fileURLToPath(new URL('../../config/leaderteam.config.json', import.meta.url)), { includeLocal: false });
  rawExplicit.models['codex/gpt-6.1-sol'].reasoningEfforts = { off: 'none', high: 'high' };
  const validatedExplicit = validateConfig(rawExplicit);
  assert.deepEqual(validatedExplicit.models['codex/gpt-6.1-sol'].reasoningEfforts, { off: 'none', high: 'high' });
});

test('V2.2.1 [F07 & F08]: multi-team hysteresis recovery never double-counts one sample, and passive CPU sampler honors configured sampleIntervalMs', () => {
  // 1. [F07] Evaluating multiple teams at the same sample timestamp increments cleanSamples only once
  let now = 10_000;
  let cpu = 95;
  const sample = () => ({
    sampledAtMs: now,
    logicalCores: 8,
    cpuBusyPct: cpu,
    cpuSmoothedPct: cpu,
    totalPhysMib: 16384,
    availPhysMib: 12000,
    totalCommitMib: null,
    availCommitMib: null,
    commitUsedPct: null,
  });
  const baseCfg = configWith({ scheduler: { hysteresisRecoverSamples: 2, hysteresisCooldownMs: 4000 } });
  const sched = new ElasticConcurrencyScheduler(baseCfg, { now: () => now, sampler: { sample } });
  sched.teamState('team-a', 1);
  sched.teamState('team-b', 1);
  sched.evaluate({ teamId: 'team-a', taskSeq: 1 });
  assert.equal(sched.hysteresis.mode, 'throttled');

  now += sched.cfg.hysteresisCooldownMs + 1;
  cpu = 10;
  sched.prepareScaleUpNotice({ teamId: 'team-a', taskSeq: 1 });
  assert.equal(sched.hysteresis.mode, 'throttled');
  assert.equal(sched.hysteresis.cleanSamples, 1);

  // Team B evaluated on the exact same sample (and even +5ms within the same timer sweep) must NOT advance cleanSamples to 2!
  sched.prepareScaleUpNotice({ teamId: 'team-b', taskSeq: 1 });
  assert.equal(sched.hysteresis.mode, 'throttled');
  assert.equal(sched.hysteresis.cleanSamples, 1);

  // Second genuinely distinct healthy sample (>= 200ms later) completes recovery to `normal`
  now += 1000;
  sched.prepareScaleUpNotice({ teamId: 'team-a', taskSeq: 1 });
  assert.equal(sched.hysteresis.mode, 'normal');

  // 2. [F08] Normal constructor wires `this.cfg.sampleIntervalMs` into `createDeviceSampler` passive window (500ms, 2000ms, 20000ms)
  const originalCpus = os.cpus;
  try {
    const checkPassive = (sampleIntervalMs, elapsedMs) => {
      let tick = 0;
      os.cpus = () => [{ model: 'test', speed: 3000, times: { user: tick, idle: 0, nice: 0, sys: 0, irq: 0 } }];
      const sc = new ElasticConcurrencyScheduler(configWith({ scheduler: { sampleIntervalMs } }), { now: () => tick });
      tick = elapsedMs;
      const passiveBusy = sc.sampler.sample().cpuBusyPct;
      const forcedBusy = sc.sampler.sample({ force: true }).cpuBusyPct;
      return { passiveBusy, forcedBusy };
    };
    // 20,000ms interval -> passive window 10,000ms: 1,100ms elapsed holds 0%, while forced sample (>=200ms) reads 100%
    assert.deepEqual(checkPassive(20000, 1100), { passiveBusy: 0, forcedBusy: 100 });
    // 2,000ms interval -> passive window 1,000ms: 900ms holds 0%, 1,050ms reads 100%
    assert.equal(checkPassive(2000, 900).passiveBusy, 0);
    assert.equal(checkPassive(2000, 1050).passiveBusy, 100);
    // 500ms interval -> passive window 250ms: 300ms elapsed reads 100%
    assert.equal(checkPassive(500, 300).passiveBusy, 100);
  } finally {
    os.cpus = originalCpus;
  }
});

test('V2.2.1 [R04 & R07]: upsertModels label-only edit preserves reasoningEfforts & YAML wire mapping, and multi-file write failures leave config untouched', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v221-r04-'));
  try {
    const srcCfg = fileURLToPath(new URL('../../config/leaderteam.config.json', import.meta.url));
    const srcPatch = fileURLToPath(new URL('../../config/magpie-models.patch.yml', import.meta.url));
    const cfgFile = path.join(tmp, 'leaderteam.config.json');
    const patchFile = path.join(tmp, 'magpie-models.patch.yml');

    const raw = JSON.parse(fs.readFileSync(srcCfg, 'utf8'));
    const route = 'codex/gpt-6.1-terra';
    raw.models[route] = {
      ...raw.models[route],
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
      reasoningEfforts: { high: 'medium' },
    };
    fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2) + '\n');
    fs.copyFileSync(srcPatch, patchFile);

    const res = applyModelConfigChanges(
      { upsertModels: [{ route, label: 'Renamed for display' }] },
      { configFile: cfgFile, patchFiles: [patchFile], dshHome: tmp },
    );
    assert.equal(res.saved, true);
    assert.ok(res.patchesUpdated.includes(patchFile));

    const onDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).models[route];
    assert.equal(onDisk.label, 'Renamed for display');
    assert.deepEqual(onDisk.reasoningEfforts, { high: 'medium' });

    const yamlText = fs.readFileSync(patchFile, 'utf8');
    assert.match(yamlText, /id: codex\/gpt-6\.1-terra[^\r\n]*reasoningEfforts: \{low: low, medium: medium, high: medium\}/);

    // Multi-file transactional write: read-only patch directory leaves cfgFile untouched on EACCES
    if (process.getuid?.() !== 0) {
      const roDir = path.join(tmp, 'ro-patches');
      fs.mkdirSync(roDir);
      const roPatch = path.join(roDir, 'magpie-models.patch.yml');
      fs.copyFileSync(patchFile, roPatch);
      fs.chmodSync(roPatch, 0o444);
      fs.chmodSync(roDir, 0o555);
      try {
        assert.throws(
          () => applyModelConfigChanges(
            { upsertModels: [{ route, label: 'Should Not Persist', maxTokens: 4096 }] },
            { configFile: cfgFile, patchFiles: [roPatch], dshHome: tmp },
          ),
        );
      } finally {
        fs.chmodSync(roDir, 0o755);
        fs.chmodSync(roPatch, 0o644);
      }
      assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).models[route].label, 'Renamed for display');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('V2.2.1 [Provider Pair Fallback, Policy Refusal Stop, & 5h Retry Accounting]: leader fallback verifies (provider, upstreamModel), CONTENT_REFUSED stops without retry/fallback, and 5h window counts retries & failed attempts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v221-p1-p2-'));
  const rt = runtime();
  const prevRt = { ...rt };
  try {
    const srcCfg = fileURLToPath(new URL('../../config/leaderteam.config.json', import.meta.url));
    const raw = loadRawConfig(srcCfg, { includeLocal: false });
    raw.magpie.provider = 'magpie';
    raw.team.leaderModelAsLastResort = true;
    raw.models['acme/model'] = {
      provider: 'acme',
      upstreamModel: 'model',
      family: 'other',
      label: 'Direct Acme',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
      strengths: 'direct acme',
    };
    raw.models['magpie@upstream/acme/model'] = {
      provider: 'magpie',
      upstreamModel: 'acme/model',
      family: 'other',
      label: 'Magpie Acme',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
      strengths: 'gateway acme',
    };
    raw.models['acme@direct/acme/model'] = {
      provider: 'acme',
      upstreamModel: 'acme/model',
      family: 'other',
      label: 'Direct Acme Full',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
      strengths: 'direct acme full',
    };
    raw.roles.leader = { route: 'magpie@upstream/acme/model', effort: 'high' };
    raw.roles.gate = {
      route: 'codex/gpt-6.1-sol',
      effort: 'high',
      maxTokens: 512,
      timeoutMs: 5000,
      retries: 2,
      fallback: [{ route: 'zcode/GLM-5.3', effort: 'high' }],
    };
    raw.requestWindow = { ...raw.requestWindow, enabled: true, windowsByProvider: { codex: { maxRequests: 100 }, zcode: { maxRequests: 100 } } };
    const cfg = validateConfig(raw);

    // 1. Multi-provider leader fallback pairs (provider, upstreamModel)
    const chainMagpie = roleRouteChain(cfg, 'gate', { provider: 'magpie', model: 'acme/model', reasoningEffort: 'high' });
    const leadMagpie = chainMagpie.find(c => c.via === 'leader');
    assert.equal(leadMagpie?.provider, 'magpie');
    assert.equal(leadMagpie?.route, 'magpie@upstream/acme/model');

    const chainAcme = roleRouteChain(cfg, 'gate', { provider: 'acme', model: 'acme/model', reasoningEffort: 'low' });
    const leadAcme = chainAcme.find(c => c.via === 'leader');
    assert.equal(leadAcme?.provider, 'acme');
    assert.equal(leadAcme?.route, 'acme@direct/acme/model');

    // 2. CONTENT_REFUSED (in-band & thrown) stops without retry or model switch
    for (const mode of ['in-band', 'thrown']) {
      let calls = 0;
      const llm = {
        async *stream() {
          calls++;
          if (mode === 'in-band') {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_REFUSED', message: 'refused' } } };
          } else {
            const err = new Error('refused');
            err.code = 'CONTENT_REFUSED';
            throw err;
          }
        },
      };
      const res = await callRoleJson(llm, roleRouteChain(cfg, 'gate', null), { system: 's', user: '{}' }, parseGateVerdict);
      assert.equal(res.ok, false);
      assert.equal(res.error.kind, 'policy');
      assert.equal(res.error.code, 'CONTENT_REFUSED');
      assert.equal(res.error.retryable, false);
      assert.equal(res.attempts, 1);
      assert.equal(calls, 1);
    }

    // 3. 5h window counts usage.jsonl attempts=2 and failed assistant/attempt
    const teamId = 'team-v221-win';
    const store = new TeamStore(tmp, teamId);
    store.ensure({ workspace: tmp });
    store.addMember({ childId: 'm-1', name: 'w1', taskSeq: 1, profile: 'readonly', model: 'zcode/GLM-5.3', effort: 'high', allowedTools: ['read'], writeScope: [], refs: [], task: 't', acceptance: ['ok'], cwd: tmp });
    const mEvents = [
      { type: 'request/context', seq: 0, data: { provider: 'magpie', model: 'zcode/GLM-5.3' } },
      { type: 'assistant/attempt', seq: 1, time: Date.now(), data: { turn: 1, step: 1, stream: [] } },
      { type: 'assistant/message', seq: 2, time: Date.now(), data: { source: { provider: 'magpie', model: 'zcode/GLM-5.3' } } },
    ];
    const mSession = { id: 'm-1', header: { origin: 'subagent', parentSession: teamId, cwd: tmp }, snapshotEvents: () => mEvents };
    Object.assign(rt, {
      config: cfg,
      storageRoot: tmp,
      actors: new Map([['m-1', { role: 'member', teamId, agentId: 'm-1', agent: { id: 'm-1', session: mSession, model: { current: () => ({ provider: 'magpie', model: 'zcode/GLM-5.3' }) } } }]]),
      stores: new Map([[teamId, store]]),
      teamConfigViews: new Map(),
    });
    onSessionEvent({}, mSession, mEvents[1]);
    onSessionEvent({}, mSession, mEvents[2]);
    recordUsage(teamId, { role: 'gate', route: 'codex/gpt-6.1-sol', effort: 'none', ok: true, attempts: 2, at: new Date().toISOString() });

    assert.equal(evaluateTeamRequestWindow(rt, teamId, Date.now(), { targetRoute: 'zcode/GLM-5.3' }).local_estimated_requests_5h, 2);
    assert.equal(evaluateTeamRequestWindow(rt, teamId, Date.now(), { targetRoute: 'codex/gpt-6.1-sol' }).local_estimated_requests_5h, 2);

    // 4. Mid-request model switch: Codex stream starts, user selects GLM for next step, then Codex stream fails -> Codex +1, GLM +0
    const leadId = 'team-v221-midswitch';
    const leadStore = new TeamStore(tmp, leadId);
    leadStore.ensure({ workspace: tmp });
    const codexBefore = evaluateTeamRequestWindow(rt, leadId, Date.now(), { targetRoute: 'codex/gpt-6.1-sol' }).local_estimated_requests_5h;
    const glmBefore = evaluateTeamRequestWindow(rt, leadId, Date.now(), { targetRoute: 'zcode/GLM-5.3' }).local_estimated_requests_5h;
    const leadEvents = [
      { type: 'request/header', seq: 1, data: { header: { config: { provider: 'magpie', model: 'codex/gpt-6.1-sol' } }, reason: 'initial' } },
      { type: 'request/context', seq: 2, data: { provider: 'magpie', model: 'codex/gpt-6.1-sol' } },
      { type: 'model/selection', seq: 3, data: { provider: 'magpie', model: 'zcode/GLM-5.3' } },
      { type: 'assistant/attempt', seq: 4, time: Date.now(), data: { turn: 1, step: 1, stream: [] } },
    ];
    const leadSession = { id: leadId, header: { cwd: tmp }, snapshotEvents: () => leadEvents };
    const leadActor = {
      role: 'leader',
      teamId: leadId,
      agentId: leadId,
      cwd: tmp,
      agent: { id: leadId, session: leadSession, model: { current: () => ({ provider: 'magpie', model: 'zcode/GLM-5.3' }) } },
    };
    rt.actors.set(leadId, leadActor);
    rt.stores.set(leadId, leadStore);
    onSessionEvent({}, leadSession, leadEvents[3]);
    assert.equal(evaluateTeamRequestWindow(rt, leadId, Date.now(), { targetRoute: 'codex/gpt-6.1-sol' }).local_estimated_requests_5h - codexBefore, 1);
    assert.equal(evaluateTeamRequestWindow(rt, leadId, Date.now(), { targetRoute: 'zcode/GLM-5.3' }).local_estimated_requests_5h - glmBefore, 0);

    // 5. Async dual supervision stops automatic re-send after CONTENT_REFUSED while keeping supervision incomplete,
    //    and Safety Gate receipt distinguishes policy refusal from transient gate-error
    const ws = path.join(tmp, 'ws-sup');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'a.js'), 'export const a = 1;\n');
    const supCfg = validateConfig({
      ...raw,
      storage: { ...raw.storage, root: tmp },
      governance: { mode: 'autonomous' },
      gate: { ...raw.gate, sandboxDirectAllow: false },
      plugins: { ...raw.plugins, consensus: true },
      roles: {
        ...raw.roles,
        gate: { ...raw.roles.gate, retries: 0, fallback: [{ route: 'zcode/GLM-5.3', effort: 'high', retries: 0 }] },
        discussA: { route: 'zcode/GLM-5.3', effort: 'high', maxTokens: 512, timeoutMs: 5000, retries: 1, fallback: [] },
        discussB: { route: 'codex/gpt-6.1-sol', effort: 'high', maxTokens: 512, timeoutMs: 5000, retries: 1, fallback: [] },
      },
    });
    let callsA = 0;
    let callsB = 0;
    let gateMode = 'policy';
    const supLlm = {
      async *stream(opts) {
        const sys = String(opts.system ?? '');
        if (sys.includes('final safety gate')) {
          if (gateMode === 'policy') {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_REFUSED', message: 'refused by policy' } } };
            return;
          }
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '502' } } };
          return;
        }
        if (opts.model.startsWith('zcode/')) {
          callsA++;
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_REFUSED', message: 'refused' } } };
          return;
        }
        callsB++;
        yield {
          type: 'text-delta',
          text: JSON.stringify({ stance: 'endorse', intervene: false, summary: 'B ok', concerns: [], suggestions: [], target_paths: ['src/a.js'] }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const supTeamId = 'team-v221-sup';
    const supStore = new TeamStore(tmp, supTeamId);
    supStore.ensure({ workspace: ws, surface: 'headless' });
    const supActor = { role: 'leader', teamId: supTeamId, agentId: supTeamId, cwd: ws };
    Object.assign(rt, {
      config: supCfg,
      storageRoot: tmp,
      llm: supLlm,
      surface: 'headless',
      planningDisposed: false,
      governanceJobs: new Map(),
      supervisedDigests: new Set(),
      inFlightSupervisionKeys: new Set(),
      partialSupervisionOpinions: new Map(),
      reads: new Map(),
      counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 },
    });
    rt.stores.set(supTeamId, supStore);
    rt.actors.set(supTeamId, supActor);

    const job = queueAsyncSupervision({
      ctx: {},
      rt,
      store: supStore,
      actor: supActor,
      leaderAgent: null,
      taskSeq: 1,
      phaseKind: 'execution',
      stageId: 'st-1',
      stageHash: 'h-1',
      targets: ['src/a.js'],
      summary: 'check',
      proposal: 'write src/a.js',
    });
    const out = await job.promise;
    assert.equal(out.status, 'deferred');
    assert.equal(out.policyRefused, true);
    assert.equal(callsA, 1);
    assert.equal(callsB, 1);
    assert.equal(retryDeferredSupervisions({ ctx: {}, rt, store: supStore, actor: supActor, leaderAgent: null, taskSeq: 1 }).length, 0);
    assert.equal(callsA, 1);
    const gov = replayGovernanceState(supStore.governanceEvents(), 1);
    assert.equal(gov.completedSupervisionCount, 0);
    assert.equal(gov.pendingSupervisions.length, 1);
    assert.equal(gov.pendingSupervisions[0].hasValidOpinionA, false);
    assert.equal(gov.pendingSupervisions[0].hasValidOpinionB, true);

    const gate = new Gate({});
    const gAgent = { id: 'm-g1', session: { header: { cwd: ws, origin: 'subagent', parentSession: supTeamId } } };
    const gActor = { role: 'member', teamId: supTeamId, agentId: 'm-g1', agent: gAgent, name: 'w', profile: 'code', allowedTools: supCfg.profiles.code.tools, writeScope: ['src/**'], refs: [], task: 't', acceptance: ['ok'], userTask: 'u', cwd: ws };
    rt.actors.set('m-g1', gActor);
    const gPolicy = await gate.decide({ name: 'write', args: { file_path: 'src/a.js', content: '2' }, agent: gAgent, actor: gActor, callId: 'c-pol' });
    assert.equal(gPolicy.decision, 'deny');
    assert.equal(gPolicy.by, 'rule:provider-policy-refusal');
    assert.doesNotMatch(gPolicy.reason, /safe to retry/i);

    gateMode = 'server';
    const gAgent2 = { id: 'm-g2', session: { header: { cwd: ws, origin: 'subagent', parentSession: supTeamId } } };
    const gActor2 = { ...gActor, agentId: 'm-g2', agent: gAgent2, name: 'w2' };
    rt.actors.set('m-g2', gActor2);
    const gServer = await gate.decide({ name: 'write', args: { file_path: 'src/a.js', content: '2' }, agent: gAgent2, actor: gActor2, callId: 'c-srv' });
    assert.equal(gServer.decision, 'deny');
    assert.equal(gServer.by, 'gate-error');
    assert.match(gServer.reason, /safe to retry/);

    // 6. Delivery submission binding & legacy 857c9a6 policy-refusal replay:
    //    - Verbatim repeat stays deduplicated (`callsA=1, callsB=1`)
    //    - Revising `evidence` or `proposal` under the same `summary`/`targets` obtains fresh A & B opinions!
    let dCallsA = 0;
    let dCallsB = 0;
    let dRefuseA = true;
    rt.llm = {
      async *stream(opts) {
        if (opts.model.startsWith('zcode/')) {
          dCallsA++;
          if (dRefuseA) {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_REFUSED', message: 'refused' } } };
            return;
          }
        } else {
          dCallsB++;
        }
        yield {
          type: 'text-delta',
          text: JSON.stringify({ stance: 'endorse', intervene: false, summary: 'ok', concerns: [], suggestions: [], target_paths: ['src/a.js'] }),
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
    const delivStore = new TeamStore(tmp, 'team-v221-deliv');
    delivStore.ensure({ workspace: ws, surface: 'headless' });
    const delivActor = { role: 'leader', teamId: 'team-v221-deliv', agentId: 'team-v221-deliv', cwd: ws };
    rt.stores.set('team-v221-deliv', delivStore);
    rt.actors.set('team-v221-deliv', delivActor);

    const dj1 = queueAsyncSupervision({
      ctx: {}, rt, store: delivStore, actor: delivActor, leaderAgent: null, taskSeq: 1,
      phaseKind: 'delivery', targets: ['src/a.js'], summary: 'Delivery topic', proposal: 'Proposal v1', evidence: 'Evidence v1', evidenceFiles: ['src/a.js'],
    });
    await dj1.promise;
    assert.equal(dCallsA, 1);
    assert.equal(dCallsB, 1);

    // Verbatim repeat -> deduplicated
    const dj1Dup = queueAsyncSupervision({
      ctx: {}, rt, store: delivStore, actor: delivActor, leaderAgent: null, taskSeq: 1,
      phaseKind: 'delivery', targets: ['src/a.js'], summary: 'Delivery topic', proposal: 'Proposal v1', evidence: 'Evidence v1', evidenceFiles: ['src/a.js'],
    });
    assert.equal(dj1Dup.queued, false);
    assert.equal(dj1Dup.status, 'policy_refused');
    assert.equal(dCallsA, 1);
    assert.equal(dCallsB, 1);

    // Revise evidence only (same summary & attachment) -> calls A & B
    const dj2 = queueAsyncSupervision({
      ctx: {}, rt, store: delivStore, actor: delivActor, leaderAgent: null, taskSeq: 1,
      phaseKind: 'delivery', targets: ['src/a.js'], summary: 'Delivery topic', proposal: 'Proposal v1', evidence: 'Evidence v2', evidenceFiles: ['src/a.js'],
    });
    await dj2.promise;
    assert.equal(dCallsA, 2);
    assert.equal(dCallsB, 2);

    // Revise proposal + evidence & allow A -> settles and clears pending!
    dRefuseA = false;
    const dj3 = queueAsyncSupervision({
      ctx: {}, rt, store: delivStore, actor: delivActor, leaderAgent: null, taskSeq: 1,
      phaseKind: 'delivery', targets: ['src/a.js'], summary: 'Delivery topic', proposal: 'Proposal v3', evidence: 'Evidence v3', evidenceFiles: ['src/a.js'],
    });
    const dj3Res = await dj3.promise;
    assert.equal(dj3Res.status, 'advisory');
    assert.equal(dCallsA, 3);
    assert.equal(dCallsB, 3);
    assert.equal(replayGovernanceState(delivStore.governanceEvents(), 1).pendingSupervisions.length, 0);

    // Legacy 857c9a6 event without `policyRefused` boolean restores `policyRefused=true`, preserves `opinionB`, and skips retry
    const legGov = replayGovernanceState([{
      type: 'supervision-deferred',
      taskSeq: 1,
      supervisionId: 'sup-old',
      dedupeKey: 'team-leg:1:delivery:old:initial',
      logicalSlotKey: 'team-leg:1:delivery:initial',
      phaseKind: 'delivery',
      hasValidOpinionA: false,
      hasValidOpinionB: true,
      opinionB: { stance: 'endorse', intervene: false, summary: 'B kept', concerns: [], suggestions: [], targetPaths: [] },
      errorA: 'policy: CONTENT_REFUSED: refused',
      errorB: null,
      retrySpec: { phaseKind: 'delivery', targets: ['src/a.js'], summary: 's', proposal: 'p', evidence: 'e' },
    }], 1);
    assert.equal(legGov.pendingSupervisions[0].policyRefused, true);
    assert.equal(legGov.pendingSupervisions[0].retrySpec, null);
    assert.equal(legGov.pendingSupervisions[0].opinionB.summary, 'B kept');
  } finally {
    Object.assign(rt, prevRt);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
