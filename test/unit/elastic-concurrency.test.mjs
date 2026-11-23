// Unit tests for the resource-aware elastic concurrency scheduler, hysteresis, progressive ramp-up,
// governance-role exemption, chat directives, and real-time CLI overrides.
// Zero heavy OS processes are spawned: large counts (10, 5->3->6->20, saturation at 7~8) run purely in-memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import {
  ElasticConcurrencyScheduler,
  parseConcurrencyDirectives,
  isControlOnlyUserMessage,
  writeConcurrencyControlFile,
  readConcurrencyControlFile,
  readTeamConcurrencyFile,
  computeMemberConcurrencyTimeline,
} from '../../leaderteam/core/scheduler.mjs';
import { leaderSection } from '../../leaderteam/core/prompts.mjs';
import { runtime, teamStore } from '../../leaderteam/host/runtime.mjs';
import { ROOT, defaultConfig, configWith } from './helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-ec:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-ec:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-ec:@deepseek-ai/dsh-tools/pipeline') {
      return { format: 'module', shortCircuit: true, source: 'export class ToolExecutionPipeline { resolveExecution() {} async dispatchToolBody() {} }' };
    }
    if (url === 'virtual-ec:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: '{"version":"0.2.2-rc.1"}' };
    }
    if (url === 'virtual-ec:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === "text") this._b.push(c); } blocks() { return this._b; } } export const boundContextSummary = s => s.slice(0, 120); export const createUserMessage = m => ({ id: "msg-1", role: "user", ...m });',
      };
    }
    return nextLoad(url, context);
  },
});

const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { currentTaskSeq, userTaskText, onAgentStatus } = await import('../../leaderteam/host/roles.mjs');
const { syncExternalConcurrencyControls, maybeNotifyLeaderScaleUp, onLeaderTurnCompleted } = await import('../../leaderteam/host/concurrency.mjs');

test('walkthrough: 10 suitable tasks with live user cap 5 -> 3 (graceful drain) -> 6 -> 20 (caps at 10 tasks, never pads)', () => {
  let nowMs = 1_000_000;
  const cfg = configWith({
    team: { maxActiveMembers: 5, maxMembersPerTeam: 32 },
    scheduler: { rampStepSize: 10, rampObserveMs: 1000 },
  });
  const sched = new ElasticConcurrencyScheduler(cfg, {
    now: () => nowMs,
    deviceProbe: () => ({
      logicalCores: 16,
      cpuBusyPct: 25,
      totalPhysMib: 32768,
      availPhysMib: 16384,
      totalCommitMib: 65536,
      availCommitMib: 40960,
      hostRssMib: 250,
    }),
  });

  const teamId = 'team-walkthrough';
  const taskSeq = 1;
  const allTasks = Array.from({ length: 10 }, (_, i) => ({ name: `worker-${i + 1}`, status: 'pending', profile: 'code' }));
  const active = () => allTasks.filter(x => x.status === 'running');
  const pending = () => allTasks.filter(x => x.status === 'pending');

  // Leader registers 10 parallel tasks; userMax is 5 -> starts 5, holds 5
  sched.setLeaderPreference(teamId, taskSeq, { pendingParallelTasks: 10 });
  for (let i = 0; i < 10; i++) {
    const res = sched.admitDispatch({ teamId, taskSeq, activeMembers: active(), profile: 'code' });
    if (i < 5) {
      assert.equal(res.allowed, true, `slot ${i + 1} admitted under userMax=5`);
      allTasks[i].status = 'running';
    } else {
      assert.equal(res.allowed, false, '6th dispatch blocked by userMax=5');
      assert.match(res.reason, /active member limit 5 reached/);
      break;
    }
  }
  assert.equal(active().length, 5);
  assert.equal(pending().length, 5);

  // User lowers maxActiveMembers to 3 in real time: running 5 are NOT killed; state enters draining_above_cap
  nowMs += 500;
  sched.setUserOverride(3, 'cli', nowMs);
  let snap = sched.evaluate({ teamId, taskSeq, activeMembers: active() });
  assert.equal(snap.controls.effective_cap, 3);
  assert.equal(snap.controls.scale_state, 'draining_above_cap');
  assert.equal(snap.controls.ramp_available_now, 0);
  assert.match(snap.guidance, /SCALE-DOWN HOLD/);

  // Worker 1 finishes -> 4 active (still > 3): leader refrains from starting replacements
  allTasks[0].status = 'done';
  sched.recordMemberFinished(teamId, taskSeq);
  snap = sched.evaluate({ teamId, taskSeq, activeMembers: active() });
  assert.equal(active().length, 4);
  assert.equal(snap.controls.scale_state, 'draining_above_cap');
  assert.equal(sched.admitDispatch({ teamId, taskSeq, activeMembers: active(), profile: 'code' }).allowed, false);

  // Worker 2 finishes -> 3 active (controlled at 3 == cap): still holds at 3
  allTasks[1].status = 'done';
  sched.recordMemberFinished(teamId, taskSeq);
  snap = sched.evaluate({ teamId, taskSeq, activeMembers: active() });
  assert.equal(active().length, 3);
  assert.equal(snap.controls.scale_state, 'at_capacity');
  assert.equal(sched.admitDispatch({ teamId, taskSeq, activeMembers: active(), profile: 'code' }).allowed, false);

  // Now suppose 10 new subtasks exist in Task 2 with 3 running and 7 pending; user raises 3 -> 6
  const task2 = Array.from({ length: 10 }, (_, i) => ({ name: `t2-${i + 1}`, status: i < 3 ? 'running' : 'pending', profile: 'code' }));
  const active2 = () => task2.filter(x => x.status === 'running');
  const pending2 = () => task2.filter(x => x.status === 'pending');
  sched.setLeaderPreference(teamId, 2, { pendingParallelTasks: 7 });

  nowMs += 2000;
  sched.setUserOverride(6, 'cli', nowMs);
  const noticeTo6 = sched.shouldNotifyScaleUp({ teamId, taskSeq: 2, activeMembers: active2(), userCapRaised: true });
  assert.ok(noticeTo6, 'raising 3 -> 6 emits immediate scale-up wakeup notice');
  assert.equal(noticeTo6.snapshot.controls.ramp_available_now, 3);

  for (const item of pending2()) {
    const r = sched.admitDispatch({ teamId, taskSeq: 2, activeMembers: active2(), profile: 'code' });
    if (!r.allowed) break;
    item.status = 'running';
  }
  assert.equal(active2().length, 6, 'scaled up from 3 to 6');
  assert.equal(pending2().length, 4, '4 tasks still pending');

  // User raises 6 -> 20: only 4 suitable tasks remain -> opens those 4 to reach 10 (never forces 20)
  nowMs += 2000;
  sched.setUserOverride(20, 'cli', nowMs);
  const noticeTo20 = sched.shouldNotifyScaleUp({ teamId, taskSeq: 2, activeMembers: active2(), userCapRaised: true });
  assert.ok(noticeTo20);
  for (const item of pending2()) {
    const r = sched.admitDispatch({ teamId, taskSeq: 2, activeMembers: active2(), profile: 'code' });
    assert.equal(r.allowed, true);
    item.status = 'running';
  }
  assert.equal(active2().length, 10, 'all 10 suitable tasks active, without inventing 10 extra filler tasks');
  assert.equal(pending2().length, 0);
});

test('device saturation at 7~8 when userMax=20, plus hysteresis anti-oscillation before recovery', () => {
  let nowMs = 2_000_000;
  let activeList = [];
  let manualCpuOverride = null;
  let manualPhysOverride = null;

  const cfg = configWith({
    team: { maxActiveMembers: 20, maxMembersPerTeam: 32 },
    scheduler: {
      rampStepSize: 20,
      highCpuPct: 85,
      recoverCpuPct: 70,
      lowFreePhysMib: 400,
      recoverFreePhysMib: 600,
      hysteresisCooldownMs: 4000,
      hysteresisRecoverSamples: 2,
      sampleIntervalMs: 1000,
    },
  });
  const sched = new ElasticConcurrencyScheduler(cfg, {
    now: () => nowMs,
    deviceProbe: () => {
      const n = activeList.length;
      return {
        logicalCores: 16,
        // Hits 86% CPU and 380 MiB free RAM once 8 members are active
        cpuBusyPct: manualCpuOverride ?? (22 + n * 8),
        cpuSmoothedPct: manualCpuOverride ?? (22 + n * 8),
        totalPhysMib: 16384,
        availPhysMib: manualPhysOverride ?? (1180 - n * 100),
        hostRssMib: 240,
      };
    },
  });

  for (let i = 1; i <= 12; i++) {
    const r = sched.admitDispatch({ teamId: 't-sat', taskSeq: 1, activeMembers: activeList, profile: 'code' });
    if (!r.allowed) break;
    activeList.push({ name: `m-${i}`, status: 'running', profile: 'code' });
  }
  assert.ok(activeList.length >= 7 && activeList.length <= 8, `saturated safely at ${activeList.length} (expected 7~8) despite userMax=20`);

  // Next dispatch is blocked by device capacity & hysteresis enters throttled
  const blocked = sched.admitDispatch({ teamId: 't-sat', taskSeq: 1, activeMembers: activeList, profile: 'code' });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.snapshot.hysteresis.mode, 'throttled');

  // CPU dips slightly to 78% (inside deadband 70%..85%), free RAM 650 MiB -> MUST remain throttled (no oscillation!)
  activeList = activeList.slice(0, 6);
  manualCpuOverride = 78;
  manualPhysOverride = 700;
  nowMs += 5000;
  let sDeadband = sched.evaluate({ teamId: 't-sat', taskSeq: 1, activeMembers: activeList, advanceSample: true });
  assert.equal(sDeadband.hysteresis.mode, 'throttled', 'stays throttled while CPU=78% is above recoverCpuPct=70%');
  assert.equal(sDeadband.controls.effective_cap, 6, 'reclaimed idle capacity down to 6 while throttled');

  // CPU recovers to 55% (<= 70%) and RAM 900 MiB (>= 600 MiB): sample 1 is not enough yet, sample 2 recovers!
  manualCpuOverride = 55;
  manualPhysOverride = 900;
  nowMs += 1000;
  const sRec1 = sched.evaluate({ teamId: 't-sat', taskSeq: 1, activeMembers: activeList, advanceSample: true });
  assert.equal(sRec1.hysteresis.mode, 'throttled', 'requires 2 consecutive clean recovery samples');

  nowMs += 1000;
  const sRec2 = sched.evaluate({ teamId: 't-sat', taskSeq: 1, activeMembers: activeList, advanceSample: true });
  assert.equal(sRec2.hysteresis.mode, 'normal', 'exits throttled cleanly after cooldown + 2 clean samples');
  assert.ok(sRec2.controls.effective_cap > 6, 'capacity expands again once device truly recovers');
});

test('remote-model pipeline bottlenecks: upstream 429 rate-limits and gate review queue throttle even when local CPU is 5%', () => {
  let nowMs = 3_000_000;
  const cfg = configWith({
    team: { maxActiveMembers: 15, maxMembersPerTeam: 32 },
    scheduler: { rampStepSize: 10, gateQueueHighWater: 3, hysteresisCooldownMs: 2000, hysteresisRecoverSamples: 1 },
  });
  const sched = new ElasticConcurrencyScheduler(cfg, {
    now: () => nowMs,
    deviceProbe: () => ({ logicalCores: 32, cpuBusyPct: 5, cpuSmoothedPct: 5, totalPhysMib: 32768, availPhysMib: 24000 }),
  });

  const active = [
    { name: 'a', status: 'running', profile: 'code' },
    { name: 'b', status: 'running', profile: 'code' },
    { name: 'c', status: 'running', profile: 'code' },
  ];

  // Upstream 429 rate-limit despite 5% CPU and 24 GiB free RAM -> clamps pipeline capacity below 3!
  sched.recordLlmOutcome({ ok: false, code: '429', message: 'HTTP 429 Too Many Requests', retryable: true });
  const r429 = sched.admitDispatch({ teamId: 't-pipe', taskSeq: 1, activeMembers: active, profile: 'code' });
  assert.equal(r429.allowed, false);
  assert.ok(r429.snapshot.pipeline.bottlenecks.includes('model_rate_limit'));
  assert.equal(r429.snapshot.controls.scale_state, 'draining_above_cap');

  // Advance past rateLimitWindowMs (45s) + hysteresis cooldown -> recovers
  nowMs += 50_000;
  const recovered = sched.evaluate({ teamId: 't-pipe', taskSeq: 1, activeMembers: active, advanceSample: true });
  assert.equal(recovered.hysteresis.mode, 'normal');

  // Gate review backlog saturation (>= 3 concurrent safety-gate LLM reviews) -> holds new dispatches
  sched.beginGateReview(); sched.beginGateReview(); sched.beginGateReview();
  const rGate = sched.admitDispatch({ teamId: 't-pipe', taskSeq: 1, activeMembers: active, profile: 'code' });
  assert.equal(rGate.allowed, false);
  assert.ok(rGate.snapshot.pipeline.bottlenecks.includes('gate_review_backlog'));
  sched.endGateReview(); sched.endGateReview(); sched.endGateReview();
});

test('progressive ramp-up waves, chat directives without bumping taskSeq, governance exemption, and CLI script', async t => {
  // 1. Directive parsing & control-only message detection
  assert.equal(parseConcurrencyDirectives(['不要把最大并发设成 20，保持默认']), null, 'prose mention does not trigger');
  assert.deepEqual(parseConcurrencyDirectives(['先看任务\n最大并发 4', '最大子代理数: 7']), { maxActiveMembers: 7, messageIndex: 1 });
  assert.equal(isControlOnlyUserMessage('最大并发 6'), true);
  assert.equal(isControlOnlyUserMessage('最大并发 6\n允许读取 E:\\refs', 'win32'), true);
  assert.equal(isControlOnlyUserMessage('最大并发 6\n顺便再写一个新模块'), false);

  // 2. Leader prompt explicitly encodes proactive parallelism, no artificial padding, and spontaneous scale-down
  const prompt = leaderSection(defaultConfig());
  assert.match(prompt, /proactive parallelism without artificial padding/i);
  assert.match(prompt, /Fixed governance roles \(gate, discussA, discussB, arbiter\) do not count/i);
  assert.match(prompt, /never interrupt healthy running members just to cut count/i);

  // 3. Host integration: governance tools (team_discuss) work while execution concurrency is full,
  //    mid-task "最大并发 N" keeps currentTaskSeq=1 so plan_id stays valid, and CLI script updates live cap
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ec-host-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'spec.md'), 'spec\n');

  const cfg = configWith({
    storage: { root: storeRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 1, maxMembersPerTeam: 10 },
    scheduler: { rampStepSize: 2, rampObserveMs: 500 },
  });
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ... JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8')), storage: { root: storeRoot }, team: { ...defaultConfig().team, maxActiveMembers: 1 } }, null, 2));

  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => {
    Object.assign(rt, prev);
    rt.deviceProbe = prev.deviceProbe;
    rt.scheduler = prev.scheduler;
    rt.schedulerConfigRef = prev.schedulerConfigRef;
    rt.schedulerStorageRef = prev.schedulerStorageRef;
  });

  const sessionEvents = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement feature A and B' }] } },
  ];
  const notices = [];
  const leaderAgent = {
    id: 'leader-ec',
    status: 'idle',
    followup(msg) { notices.push(msg); },
    inject(msg) { notices.push(msg); },
    session: { id: 'leader-ec', seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  const mockLlm = {
    async *stream() {
      yield { type: 'text', text: '{"stance":"approve","summary":"ok","reasons":["r"],"required_changes":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const tools = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
      definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }]; },
    },
    get(k) {
      if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } };
      if (k === 'agents') return new Map([[leaderAgent.id, leaderAgent]]);
      return null;
    },
    subagents: {
      async startActivation({ childId }) { return { childId }; },
    },
  };
  Object.assign(rt, {
    config: cfg,
    configPath: cfgFile,
    storageRoot: storeRoot,
    llm: mockLlm,
    surface: 'headless',
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 20, totalPhysMib: 16384, availPhysMib: 8192 }),
    scheduler: null,
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  const plan = await tools.get('team_discuss').execute({ kind: 'plan', topic: 'p', proposal: 'two parallel modules' }, { agent: leaderAgent });
  assert.equal(plan.outcome.decision, 'approve');
  await tools.get('team_concurrency').execute({ pending_parallel_tasks: 2 }, { agent: leaderAgent });

  const baseArgs = { task: 't', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', tools: ['read', 'write'], write_scope: ['src/**'], plan_id: plan.id };
  const d1 = await tools.get('team_dispatch').execute({ ...baseArgs, name: 'mod-a', write_scope: ['src/mod-a/**'] }, { agent: leaderAgent });
  assert.equal(d1.concurrency.active_execution_members, 1);
  assert.equal(d1.concurrency.effective_cap, 1);

  // Second execution subagent is blocked at cap=1, YET governance tool team_discuss still runs unthrottled!
  await assert.rejects(() => tools.get('team_dispatch').execute({ ...baseArgs, name: 'mod-b', write_scope: ['src/mod-b/**'] }, { agent: leaderAgent }), /active member limit 1 reached/);
  const delivCheck = await tools.get('team_discuss').execute({ kind: 'dispute', topic: 'architecture note', proposal: 'governance check while execution is full' }, { agent: leaderAgent });
  assert.equal(delivCheck.outcome.decision, 'approve', 'governance roles are never blocked by execution concurrency cap');

  // User sends mid-task chat directive "最大并发 2" -> taskSeq stays 1, userTaskText stays clean, and plan.id stays valid!
  sessionEvents.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最大并发 2' }] } });
  assert.equal(currentTaskSeq(ctx, leaderAgent.id), 1, 'mid-task concurrency directive does not bump taskSeq');
  assert.equal(userTaskText(ctx, leaderAgent.id, 1000), 'Implement feature A and B');

  const d2 = await tools.get('team_dispatch').execute({ ...baseArgs, name: 'mod-b', write_scope: ['src/mod-b/**'] }, { agent: leaderAgent });
  assert.equal(d2.concurrency.user_max_concurrent, 2);
  assert.equal(d2.concurrency.active_execution_members, 2);
  assert.equal(readConcurrencyControlFile(storeRoot), null, 'session chat directive never pollutes global concurrency.json');
  assert.equal(readTeamConcurrencyFile(storeRoot, leaderAgent.id)?.maxActiveMembers, 2, 'session chat directive persists in teams/<id>/concurrency.json');

  // Test CLI script set-max-members.mjs (--max 4 -> wakes idle leader when pending work exists, then --reset)
  await tools.get('team_concurrency').execute({ pending_parallel_tasks: 1 }, { agent: leaderAgent });
  const cliPath = path.join(ROOT, 'scripts/dev/set-max-members.mjs');
  const setOut = JSON.parse(execFileSync(process.execPath, [cliPath, '--storage-root', storeRoot, '--config', cfgFile, '--max', '4'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(setOut.effectiveUserMax, 4);
  assert.equal(setOut.saved, true);

  const ext = syncExternalConcurrencyControls(rt);
  assert.equal(ext.raised, true);
  // Immediately within rampObserveMs (500ms after wave of 2 filled rampStepSize=2), progressive ramp holds off:
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: true }), false, 'holds wakeup during 500ms progressive ramp observation window');
  await new Promise(r => setTimeout(r, 540));
  // Once observation window passes and device remains healthy, remembered scale-up wakes the idle leader:
  const notified = maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: false });
  assert.equal(notified, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].source.kind, 'leaderteam-scheduler');
  assert.match(notices[0].content[0].text, /实时有效并发上限为 4/);

  const resetOut = JSON.parse(execFileSync(process.execPath, [cliPath, '--storage-root', storeRoot, '--config', cfgFile, '--reset'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(resetOut.runtimeOverride, null);
  assert.equal(resetOut.effectiveUserMax, 1);

  // Cold restart / session resume precedence: CLI sets --max 5 after earlier chat "最大并发 2" (msgIndex 1);
  // recreating a fresh scheduler on resume MUST preserve CLI 5 instead of re-applying old msgIndex 1,
  // while still accepting a brand-new chat directive "最大并发 3" at msgIndex 2!
  execFileSync(process.execPath, [cliPath, '--storage-root', storeRoot, '--config', cfgFile, '--max', '5'], { encoding: 'utf8', windowsHide: true });
  rt.scheduler = null; // simulate cold Desktop restart
  const resumedStatus = await tools.get('team_concurrency').execute({}, { agent: leaderAgent });
  assert.equal(resumedStatus.controls.user_max_concurrent, 5, 'cold resume keeps newer CLI cap 5 over historical chat cap 2');
  assert.equal(resumedStatus.controls.user_max_source, 'cli');

  sessionEvents.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最大并发 3' }] } });
  const afterNewChat = await tools.get('team_concurrency').execute({}, { agent: leaderAgent });
  assert.equal(afterNewChat.controls.user_max_concurrent, 3, 'new post-resume chat directive updates cap to 3');
  assert.equal(afterNewChat.controls.user_max_source, 'chat');
});

test('[P1-1] registering pending_parallel_tasks before Wave 1 preserves held-back count and wakes idle leader on scale-up', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p1-1-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const cfg = configWith({
    storage: { root: storeRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 2, maxMembersPerTeam: 10 },
    scheduler: { rampStepSize: 4, rampObserveMs: 200 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const sessionEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build 3 modules' }] } }];
  const followups = [];
  const leaderAgent = {
    id: 'leader-p1-1',
    status: 'running',
    followup(msg) { followups.push(msg); },
    inject() { throw new Error('inject must never be called'); },
    session: { id: 'leader-p1-1', seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  const mockLlm = {
    async *stream() {
      yield { type: 'text', text: '{"stance":"approve","summary":"ok","reasons":["r"],"required_changes":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const tools = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
      definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }]; },
    },
    get(k) {
      if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } };
      if (k === 'agents') return new Map([[leaderAgent.id, leaderAgent]]);
      return null;
    },
    subagents: { async startActivation({ childId }) { return { childId }; } },
  };
  Object.assign(rt, {
    config: cfg,
    configPath: null,
    storageRoot: storeRoot,
    llm: mockLlm,
    surface: 'headless',
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 15, totalPhysMib: 16384, availPhysMib: 8192 }),
    scheduler: null,
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  const plan = await tools.get('team_discuss').execute({ kind: 'plan', topic: 'p', proposal: '3 modules' }, { agent: leaderAgent });
  const baseArgs = { task: 't', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', tools: ['read', 'write'], write_scope: ['src/**'], plan_id: plan.id };

  // Leader registers 1 held-back task BEFORE dispatching Wave 1 (2 slots available)
  await tools.get('team_concurrency').execute({ pending_parallel_tasks: 1 }, { agent: leaderAgent });
  const r1 = await tools.get('team_dispatch').execute({ ...baseArgs, name: 'wave1-a', write_scope: ['src/wave1-a/**'] }, { agent: leaderAgent });
  const r2 = await tools.get('team_dispatch').execute({ ...baseArgs, name: 'wave1-b', write_scope: ['src/wave1-b/**'] }, { agent: leaderAgent });
  assert.equal(r1.concurrency.pending_parallel_tasks, 1, 'first dispatch in Wave 1 does NOT wipe held-back count');
  assert.equal(r2.concurrency.pending_parallel_tasks, 1, 'second dispatch in Wave 1 preserves held-back count=1');

  // End Turn 1 -> transition leader to idle
  onLeaderTurnCompleted(ctx, leaderAgent.id);
  leaderAgent.status = 'idle';
  const snapAfterTurn1 = await tools.get('team_concurrency').execute({}, { agent: leaderAgent });
  assert.equal(snapAfterTurn1.backlog.pending_parallel_tasks, 1);
  assert.equal(snapAfterTurn1.backlog.awaiting_slots, true);

  // Cap expands 2 -> 3 while Wave 1 is still active and leader is idle -> followup wakes leader!
  writeConcurrencyControlFile(storeRoot, 3, 'cli');
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: true }), true);
  assert.equal(followups.length, 1);
  assert.match(followups[0].content[0].text, /已登记待派并行任务 1 个/);

  // Wave 2 dispatch in Turn 2 decrements pending_parallel_tasks 1 -> 0 cleanly
  leaderAgent.status = 'running';
  const r3 = await tools.get('team_dispatch').execute({ ...baseArgs, name: 'wave2-c', write_scope: ['src/wave2-c/**'] }, { agent: leaderAgent });
  assert.equal(r3.concurrency.pending_parallel_tasks, 0);
});

test('[P1-2] synchronous slot reservation blocks same-batch async TOCTOU breaches, duplicate names, and rolls back failures', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p1-2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const cfg = configWith({
    storage: { root: storeRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 2, maxMembersPerTeam: 10 },
    scheduler: { rampStepSize: 5, rampObserveMs: 300 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const sessionEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Parallel TOCTOU check' }] } }];
  const leaderAgent = {
    id: 'leader-p1-2',
    status: 'running',
    session: { id: 'leader-p1-2', seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  const mockLlm = {
    async *stream() {
      yield { type: 'text', text: '{"stance":"approve","summary":"ok","reasons":["r"],"required_changes":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  let failLabel = null;
  const tools = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
      definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }]; },
    },
    get(k) {
      if (k === 'agentPresets') {
        return {
          presetForSession: () => cfg.profiles.leader.preset,
          async acquireScope() {
            // Deliberate async suspension where unguarded TOCTOU used to let concurrent calls slip through
            await new Promise(r => setTimeout(r, 35));
            return { key: {}, async [Symbol.asyncDispose]() {} };
          },
        };
      }
      if (k === 'agents') return new Map([[leaderAgent.id, leaderAgent]]);
      return null;
    },
    subagents: {
      async startActivation({ childId, label }) {
        await new Promise(r => setTimeout(r, 25));
        if (label === failLabel) throw new Error('simulated spawn failure');
        return { childId };
      },
    },
  };
  Object.assign(rt, {
    config: cfg,
    configPath: null,
    storageRoot: storeRoot,
    llm: mockLlm,
    surface: 'headless',
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 10, totalPhysMib: 16384, availPhysMib: 8192 }),
    scheduler: null,
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  const plan = await tools.get('team_discuss').execute({ kind: 'plan', topic: 'p', proposal: 'race test' }, { agent: leaderAgent });
  const baseArgs = { task: 't', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', tools: ['read', 'write'], write_scope: ['src/**'], plan_id: plan.id };

  // 1. Fire 3 concurrent team_dispatch calls in the exact same tick at maxActiveMembers=2
  const batch = await Promise.allSettled([
    tools.get('team_dispatch').execute({ ...baseArgs, name: 'race-1', write_scope: ['src/race-1/**'] }, { agent: leaderAgent }),
    tools.get('team_dispatch').execute({ ...baseArgs, name: 'race-2', write_scope: ['src/race-2/**'] }, { agent: leaderAgent }),
    tools.get('team_dispatch').execute({ ...baseArgs, name: 'race-3', write_scope: ['src/race-3/**'] }, { agent: leaderAgent }),
  ]);
  const okCount = batch.filter(r => r.status === 'fulfilled').length;
  const rejected = batch.filter(r => r.status === 'rejected');
  assert.equal(okCount, 2, 'exact 2 dispatches admitted despite async suspension');
  assert.equal(rejected.length, 1, '3rd concurrent dispatch deterministically rejected');
  assert.match(rejected[0].reason.message, /active member limit 2 reached/);
  assert.equal(teamStore(leaderAgent.id).members().size, 2);

  // 2. Raise cap to 4: test failed activation cleanly releases its reserved slot & duplicate same-batch name is blocked
  writeConcurrencyControlFile(storeRoot, 4, 'cli');
  failLabel = 'will-fail';
  await assert.rejects(() => tools.get('team_dispatch').execute({ ...baseArgs, name: 'will-fail', write_scope: ['src/will-fail/**'] }, { agent: leaderAgent }), /simulated spawn failure/);
  failLabel = null;

  const dupBatch = await Promise.allSettled([
    tools.get('team_dispatch').execute({ ...baseArgs, name: 'same-name', write_scope: ['src/same-name/**'] }, { agent: leaderAgent }),
    tools.get('team_dispatch').execute({ ...baseArgs, name: 'same-name', write_scope: ['src/same-name/**'] }, { agent: leaderAgent }),
  ]);
  assert.equal(dupBatch.filter(r => r.status === 'fulfilled').length, 1, 'only 1 of duplicate same-batch names succeeds');
  assert.match(dupBatch.find(r => r.status === 'rejected').reason.message, /currently active/);
  // Still 1 slot left (active = race-1, race-2, same-name = 3/4) because will-fail cancelled its reservation cleanly:
  const slot4 = await tools.get('team_dispatch').execute({ ...baseArgs, name: 'slot-four', write_scope: ['src/slot-four/**'] }, { agent: leaderAgent });
  assert.equal(slot4.concurrency.active_execution_members, 4);
});

test('[P1-3] session-scoped chat directive isolation + cross-session global pool & hardware sharing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p1-3-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const wsA = path.join(tmp, 'wsA');
  const wsB = path.join(tmp, 'wsB');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(path.join(wsA, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wsB, 'src'), { recursive: true });

  const cfg = configWith({
    storage: { root: storeRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 4, maxMembersPerTeam: 10 },
    scheduler: { rampStepSize: 6, rampObserveMs: 200 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const eventsA = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task A\n最大并发 2' }] } }];
  const eventsB = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task B' }] } }];
  const mkLeader = (id, cwd, evs) => ({
    id,
    status: 'running',
    session: { id, seq: 1, header: { cwd }, snapshotEvents: () => evs },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  });
  const leaderA = mkLeader('team-a', wsA, eventsA);
  const leaderB = mkLeader('team-b', wsB, eventsB);

  const mockLlm = {
    async *stream() {
      yield { type: 'text', text: '{"stance":"approve","summary":"ok","reasons":["r"],"required_changes":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const tools = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
      definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }]; },
    },
    get(k) {
      if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } };
      if (k === 'agents') return new Map([[leaderA.id, leaderA], [leaderB.id, leaderB]]);
      return null;
    },
    subagents: { async startActivation({ childId }) { return { childId }; } },
  };
  Object.assign(rt, {
    config: cfg,
    configPath: null,
    storageRoot: storeRoot,
    llm: mockLlm,
    surface: 'headless',
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 15, totalPhysMib: 16384, availPhysMib: 8192 }),
    scheduler: null,
    actors: new Map([
      [leaderA.id, { role: 'leader', teamId: leaderA.id, agentId: leaderA.id, agent: leaderA, cwd: wsA, allowedTools: cfg.profiles.leader.tools }],
      [leaderB.id, { role: 'leader', teamId: leaderB.id, agentId: leaderB.id, agent: leaderB, cwd: wsB, allowedTools: cfg.profiles.leader.tools }],
    ]),
    stores: new Map(),
  });
  teamStore(leaderA.id).ensure({ workspace: wsA, surface: 'headless' });
  teamStore(leaderB.id).ensure({ workspace: wsB, surface: 'headless' });
  registerTeamTools(ctx);

  const planA = await tools.get('team_discuss').execute({ kind: 'plan', topic: 'pa', proposal: 'a' }, { agent: leaderA });
  const planB = await tools.get('team_discuss').execute({ kind: 'plan', topic: 'pb', proposal: 'b' }, { agent: leaderB });
  const baseA = { task: 't', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', tools: ['read', 'write'], write_scope: ['src/**'], plan_id: planA.id };
  const baseB = { ...baseA, plan_id: planB.id };

  // Session A chat "最大并发 2" does NOT touch Session B's user_max=4 or global concurrency.json
  const snapA = await tools.get('team_concurrency').execute({}, { agent: leaderA });
  const snapB = await tools.get('team_concurrency').execute({}, { agent: leaderB });
  assert.equal(snapA.controls.user_max_concurrent, 2);
  assert.equal(snapA.controls.user_max_source, 'chat');
  assert.equal(snapB.controls.user_max_concurrent, 4, 'Session B keeps config user_max=4 without cross-session pollution');
  assert.equal(snapB.controls.user_max_source, 'config');
  assert.equal(readConcurrencyControlFile(storeRoot), null);

  // Session A launches 2 active members (hitting its session cap 2)
  await tools.get('team_dispatch').execute({ ...baseA, name: 'a-1', write_scope: ['src/a-1/**'] }, { agent: leaderA });
  await tools.get('team_dispatch').execute({ ...baseA, name: 'a-2', write_scope: ['src/a-2/**'] }, { agent: leaderA });
  await assert.rejects(() => tools.get('team_dispatch').execute({ ...baseA, name: 'a-3', write_scope: ['src/a-3/**'] }, { agent: leaderA }), /active member limit 2 reached/);

  // Session B shares the global pool (4): since Session A already uses 2 slots, Session B can launch 2 (NOT 4)!
  await tools.get('team_dispatch').execute({ ...baseB, name: 'b-1', write_scope: ['src/b-1/**'] }, { agent: leaderB });
  const b2 = await tools.get('team_dispatch').execute({ ...baseB, name: 'b-2', write_scope: ['src/b-2/**'] }, { agent: leaderB });
  assert.equal(b2.concurrency.active_execution_members, 2);
  await assert.rejects(
    () => tools.get('team_dispatch').execute({ ...baseB, name: 'b-3', write_scope: ['src/b-3/**'] }, { agent: leaderB }),
    /environment active=4\/4 \(2 in other session\(s\)\)/,
  );
});

test('[P1-4] running leader is never interrupted via inject, failed followup does not burn dedup key, and transition to idle delivers once', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p1-4-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(ws, { recursive: true });

  const cfg = configWith({
    storage: { root: storeRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 2, maxMembersPerTeam: 10 },
    scheduler: { rampStepSize: 4, rampObserveMs: 200 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  let injectCalls = 0;
  let throwOnFollowup = false;
  const delivered = [];
  const leaderAgent = {
    id: 'leader-p1-4',
    status: 'running',
    followup(msg) {
      if (throwOnFollowup) throw new Error('transient followup busy');
      delivered.push(msg);
    },
    inject() {
      injectCalls += 1;
    },
    session: {
      id: 'leader-p1-4',
      seq: 1,
      header: { cwd: ws },
      snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task' }] } }],
    },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  const ctx = { get(k) { return k === 'agents' ? new Map([[leaderAgent.id, leaderAgent]]) : null; } };
  Object.assign(rt, {
    config: cfg,
    configPath: null,
    storageRoot: storeRoot,
    llm: {},
    surface: 'headless',
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 10, totalPhysMib: 16384, availPhysMib: 8192 }),
    scheduler: null,
    onLeaderIdle: (hookCtx, tid) => maybeNotifyLeaderScaleUp(hookCtx, tid, { userCapRaised: false }),
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  teamStore(leaderAgent.id).addMember({ childId: 'c-1', name: 'm-1', taskSeq: 1, profile: 'code', writeScope: ['src/**'], refs: [], acceptance: ['ok'], task: 't', cwd: ws });
  teamStore(leaderAgent.id).setMemberStatus('c-1', 'running');

  // Register waiting task while running, then raise cap 2 -> 4 while STILL running
  rt.scheduler = null;
  maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: false });
  rt.scheduler.setLeaderPreference(leaderAgent.id, 1, { pendingParallelTasks: 2, currentAvailableNow: 1 });
  writeConcurrencyControlFile(storeRoot, 4, 'cli');

  // Tick while leader is running: MUST NOT call inject and MUST NOT burn wakeup!
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: true }), false);
  assert.equal(injectCalls, 0, 'never injects into a running leader turn');
  assert.equal(delivered.length, 0);

  // Transition to idle while followup throws transiently: MUST NOT burn dedup key!
  leaderAgent.status = 'idle';
  throwOnFollowup = true;
  onAgentStatus(ctx, { agent: leaderAgent, status: 'idle' });
  assert.equal(delivered.length, 0);

  // Next retry succeeds via followup, commits dedup key, and subsequent duplicate tick is a no-op
  throwOnFollowup = false;
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: false }), true);
  assert.equal(delivered.length, 1);
  assert.equal(injectCalls, 0);
  assert.equal(maybeNotifyLeaderScaleUp(ctx, leaderAgent.id, { userCapRaised: false }), false, 'dedup key committed after successful delivery');
});

test('[P2] deleted global concurrency.json after reset never replays chat history, CLI env vars work, partial config watermarks validate, and timeline overlap checks', async t => {
  // 1. Partial scheduler config overrides in .local.json / configWith must validate against merged defaults
  assert.throws(() => configWith({ scheduler: { highCpuPct: 65 } }), /recoverCpuPct must be < scheduler\.highCpuPct/);
  assert.throws(() => configWith({ scheduler: { criticalFreePhysMib: 500 } }), /criticalFreePhysMib must be <= scheduler\.lowFreePhysMib/);
  assert.throws(() => configWith({ scheduler: { recoverFreePhysMib: 300 } }), /recoverFreePhysMib must be >= scheduler\.lowFreePhysMib/);
  assert.throws(() => configWith({ scheduler: { rampObserveMs: 0 } }), /rampObserveMs must be an integer in \[100, 60000\]/);

  // 2. CLI honors LEADERTEAM_CONFIG and LT_DSH_HOME; deleting global concurrency.json after --reset never replays old chat directive
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fakeHome = path.join(tmp, 'dsh-home');
  const envStoreRoot = path.join(fakeHome, 'leaderteam');
  const cfgFile = path.join(tmp, 'custom-lt.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8')),
    storage: { root: null },
    team: { ...defaultConfig().team, maxActiveMembers: 6 },
  }, null, 2));

  const cliPath = path.join(ROOT, 'scripts/dev/set-max-members.mjs');
  const envOut = JSON.parse(execFileSync(process.execPath, [cliPath, '--max', '5'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LEADERTEAM_CONFIG: cfgFile, LT_DSH_HOME: fakeHome },
  }));
  assert.equal(envOut.storageRoot, envStoreRoot);
  assert.equal(envOut.effectiveUserMax, 5);

  const cfg = configWith({ storage: { root: envStoreRoot }, quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true }, team: { maxActiveMembers: 6 } });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));
  const sessionEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最大并发 2\nStart work' }] } }];
  const leaderAgent = {
    id: 'leader-p2',
    status: 'idle',
    session: { id: 'leader-p2', seq: 1, header: { cwd: tmp }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  const ctx = { get(k) { return k === 'agents' ? new Map([[leaderAgent.id, leaderAgent]]) : null; } };
  Object.assign(rt, {
    config: cfg,
    configPath: cfgFile,
    storageRoot: envStoreRoot,
    llm: {},
    surface: 'headless',
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 10, totalPhysMib: 16384, availPhysMib: 8192 }),
    scheduler: null,
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: tmp, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: tmp, surface: 'headless' });

  // Initial sync records msgIndex=0 ("最大并发 2") in teams/leader-p2/concurrency.json
  fs.unlinkSync(path.join(envStoreRoot, 'concurrency.json'));
  rt.scheduler = null;
  maybeNotifyLeaderScaleUp(ctx, leaderAgent.id);
  assert.equal(rt.scheduler.currentUserMaxForTeam(leaderAgent.id).max, 2);

  // Operator runs --reset, then deletes global concurrency.json, then cold-restarts Desktop:
  execFileSync(process.execPath, [cliPath, '--reset'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LEADERTEAM_CONFIG: cfgFile, LT_DSH_HOME: fakeHome },
  });
  fs.unlinkSync(path.join(envStoreRoot, 'concurrency.json'));
  rt.scheduler = null;
  maybeNotifyLeaderScaleUp(ctx, leaderAgent.id);
  assert.equal(rt.scheduler.currentUserMaxForTeam(leaderAgent.id).max, 6, 'historical chat cap 2 is NOT replayed after reset + global file deletion');
  assert.equal(rt.scheduler.currentUserMaxForTeam(leaderAgent.id).source, 'config');

  // 3. computeMemberConcurrencyTimeline accurately distinguishes serial vs genuinely overlapping members.jsonl records
  const serial = computeMemberConcurrencyTimeline([
    { type: 'member', childId: 'a', name: 'impl-alpha', at: '2026-11-11T06:37:00.000Z' },
    { type: 'member-status', childId: 'a', status: 'done', at: '2026-11-11T06:37:10.000Z' },
    { type: 'member', childId: 'b', name: 'impl-beta', at: '2026-11-11T06:37:37.000Z' },
    { type: 'member-status', childId: 'b', status: 'done', at: '2026-11-11T06:37:47.000Z' },
  ]);
  assert.equal(serial.peakConcurrent, 1);
  assert.equal(serial.maxPairwiseOverlapMs, 0);

  const parallel = computeMemberConcurrencyTimeline([
    { type: 'member', childId: 'a', name: 'impl-1', at: '2026-11-11T07:00:00.000Z' },
    { type: 'member', childId: 'b', name: 'impl-2', at: '2026-11-11T07:00:02.000Z' },
    { type: 'member-status', childId: 'a', status: 'done', at: '2026-11-11T07:00:15.000Z' },
    { type: 'member-status', childId: 'b', status: 'done', at: '2026-11-11T07:00:18.000Z' },
  ]);
  assert.equal(parallel.peakConcurrent, 2);
  assert.equal(parallel.maxPairwiseOverlapMs, 13000);
});
