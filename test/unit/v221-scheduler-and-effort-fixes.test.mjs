import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { ElasticConcurrencyScheduler } from '../../leaderteam/core/scheduler.mjs';
import { validateConfig, loadRawConfig } from '../../leaderteam/core/config.mjs';
import { renderMagpieModelRows, parseMagpiePatchModels } from '../../leaderteam/core/model-config-writer.mjs';
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
        source: 'export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === "text") this._b.push(c); } blocks() { return this._b; } } export const boundContextSummary = s => s.slice(0, 120); export const createUserMessage = m => ({ id: "msg-1", role: "user", ...m });',
      };
    }
    return nextLoad(url, context);
  },
});

const { maybeNotifyLeaderScaleUp, onLeaderTurnCompleted } = await import('../../leaderteam/host/concurrency.mjs');
const { onAgentStatus } = await import('../../leaderteam/host/roles.mjs');

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

  const teamId = 'team-v23-repro';
  const taskSeq = 1;
  const fourShell = Array.from({ length: 4 }, (_, i) => ({ id: `s-${i}`, name: `shell-${i}`, status: 'running', profile: 'shell' }));

  // Reproduce seq=317: 5th shell dispatch rejected by shell_concurrency_limit -> latches awaitingSlots=true while pendingParallelTasks===0
  const rejected = sched.checkDispatch({ teamId, taskSeq, activeMembers: fourShell, profile: 'shell' });
  assert.equal(rejected.allowed, false);
  assert.equal(sched.teamState(teamId, taskSeq).awaitingSlots, true);

  // Reproduce seq=341: Leader switches to `code` profile in the same turn, succeeds, and ends Turn 1 with open slots
  nowMs += 1000;
  const admittedCode = sched.admitDispatch({ teamId, taskSeq, activeMembers: fourShell, profile: 'code' });
  assert.equal(admittedCode.allowed, true);
  const fiveActive = [...fourShell, { id: 'c-1', name: 'mapper-e2e', status: 'running', profile: 'code' }];
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
    { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build V2.3' }] } },
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
