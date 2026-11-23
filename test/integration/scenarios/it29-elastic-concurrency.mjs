// Real DSH 0.2.2-rc.1 elastic concurrency scenario (lightweight: max 3 in-process code members, 0 shell load):
// 1. Starts with maxActiveMembers=3 and 4 independent subtasks -> dispatches impl-1, impl-2, impl-3 concurrently.
// 2. Real-time scale-down 3 -> 1 while all 3 are running: Harness does NOT force-kill any running subagent.
//    - When impl-1 finishes (2 still active > cap 1), leader sees state=draining_above_cap (SCALE-DOWN HOLD) in
//      its refreshed systemPrompt.context and spontaneously refrains from dispatching impl-4.
//    - When impl-2 finishes (1 still active == cap 1), leader sees state=at_capacity and still holds at 1.
// 3. Real-time scale-up 1 -> 3 via <storageRoot>/concurrency.json while leader is IDLE and impl-3 is still running:
//    watcher wakes the idle leader via followup notice without bumping taskSeq; leader dispatches impl-4 alongside
//    impl-3 using the SAME approved plan_id.
// 4. Governance roles (gate & delivery discussion) run unthrottled throughout.
import { assert, allow, approve, DELIVERY, dispatch, latestPlanId, lastToolResult, read } from '../lib.mjs';
import { writeConcurrencyControlFile } from '../../../leaderteam/core/scheduler.mjs';

const waitFor = async (cond, ms, label = 'barrier timeout') => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(label);
    await new Promise(r => setTimeout(r, 40));
  }
};

const mkDispatch = (planId, idx) => dispatch({
  plan_id: planId,
  name: `impl-${idx}`,
  task: `Write src/m${idx}.txt containing M${idx}.`,
  acceptance: [`src/m${idx}.txt contains M${idx}`],
  write_scope: [`src/m${idx}.txt`],
  model: idx % 2 === 1 ? 'zcode/GLM-5.3' : 'zcode/GLM-5.3-Flash',
  effort: 'high',
});

const memberScript = idx => [
  { tool: 'read', args: { file_path: 'spec.md' } },
  { tool: 'write', args: { file_path: `src/m${idx}.txt`, content: `M${idx}\n` } },
  { content: `STATUS: done\nCHANGED: src/m${idx}.txt\nEVIDENCE: wrote m${idx}\nNOTES: none` },
];

export default {
  files: { 'spec.md': 'Write m1..m4 independently.\n' },
  timeoutSec: 120,
  config: {
    team: { maxActiveMembers: 3, maxMembersPerTeam: 8 },
    scheduler: {
      pollControlMs: 100,
      sampleIntervalMs: 300,
      rampStepSize: 4,
      lowFreePhysMib: 64,
      recoverFreePhysMib: 96,
      criticalFreePhysMib: 32,
      lowFreeCommitMib: 128,
      recoverFreeCommitMib: 256,
      highCpuPct: 99,
      recoverCpuPct: 90,
    },
  },
  async respond(c, t) {
    const s = t.state;
    s.arrived ??= new Set();
    s.finished ??= new Set();
    s.leaderContexts ??= [];

    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;

    if (c.kind === 'member') {
      const idx = Number(c.who.split('-')[1]);
      if (c.index === 1) {
        s.arrived.add(c.who);
        if (idx === 1) {
          // Wait until impl-1, impl-2, impl-3 are all concurrently active, then lower user cap 3 -> 1!
          await waitFor(() => s.arrived.has('impl-1') && s.arrived.has('impl-2') && s.arrived.has('impl-3'), 25000, 'wave 1 3-way concurrency barrier');
          s.wave1Concurrent = true;
          writeConcurrencyControlFile(t.store, 1, 'cli');
          s.scaledDownTo1 = true;
        } else if (idx === 2) {
          // Hold impl-2 alive until impl-1 finishes and leader observes draining_above_cap (2 active > cap 1)
          await waitFor(() => s.sawDrainingAboveCap === true, 30000, 'draining_above_cap observation barrier');
        } else if (idx === 3) {
          // Hold impl-3 alive through both scale-down steps AND until scale-up wakes idle leader to spawn impl-4!
          await waitFor(() => s.arrived.has('impl-4'), 35000, 'scale-up wakeup barrier');
          s.concurrentAfterScaleUp = !s.finished.has('impl-3');
        } else {
          await waitFor(() => s.arrived.has('impl-3') && s.arrived.has('impl-4'), 25000, 'wave 2 peers barrier');
        }
      }
      const step = memberScript(idx)[c.index - 1];
      if (c.index === 3) s.finished.add(c.who);
      return step;
    }

    if (c.kind === 'leader') {
      s.leaderContexts.push(c.text);
      if (c.index === 1) {
        return { tool: 'team_discuss', args: { kind: 'plan', topic: '4 independent files', proposal: 'Write m1..m4 in parallel waves.' } };
      }
      if (c.index === 2) {
        s.planId = latestPlanId(c) ?? JSON.parse(lastToolResult(c)).id;
        return { tool: 'team_concurrency', args: { pending_parallel_tasks: 4 } };
      }
      if (c.index === 3) return mkDispatch(s.planId, 1);
      if (c.index === 4) return mkDispatch(s.planId, 2);
      if (c.index === 5) return mkDispatch(s.planId, 3);
      if (c.index === 6) return { content: 'WAITING_WAVE_1' };

      // impl-1 finished while impl-2 & impl-3 are still running (2 active > cap 1 -> draining_above_cap)
      if (!s.sawDrainingAboveCap) {
        s.sawDrainingAboveCap = true;
        s.drainingContextText = c.text;
        return { content: 'SPONTANEOUS_DRAIN_2_TO_1' };
      }

      // impl-2 finished while impl-3 is still running (1 active == cap 1 -> at_capacity)
      if (!s.sawAtCapacityHold) {
        s.sawAtCapacityHold = true;
        s.atCapacityContextText = c.text;
        // Schedule real-time scale-up 1 -> 3 shortly AFTER this turn ends so leader is genuinely IDLE when woken!
        setTimeout(() => {
          writeConcurrencyControlFile(t.store, 3, 'cli');
          s.scaledUpTo3 = true;
        }, 250);
        return { content: 'HOLDING_AT_CAP_1' };
      }

      // Woken up from IDLE by the scheduler's followup notice after cap rose 1 -> 3!
      if (!s.dispatched4) {
        s.dispatched4 = true;
        s.scaleUpWakeText = c.text;
        return mkDispatch(s.planId, 4);
      }
      if (s.finished.size < 4) return { content: 'WAITING_WAVE_2' };
      if (!s.deliverySent) {
        s.deliverySent = true;
        return DELIVERY;
      }
      return { content: 'DELIVERY: approved' };
    }
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'headless process exited cleanly');
    assert.match(run.final?.text ?? '', /DELIVERY: approved/);
    assert.equal(t.state.wave1Concurrent, true, 'initial 3 members ran concurrently');
    assert.equal(t.state.scaledDownTo1, true, 'lowered cap 3 -> 1 while running');
    assert.match(t.state.drainingContextText, /user_max=1 \(cli\)/, 'leader saw live lowered user_max=1 in refreshed systemPrompt.context');
    assert.match(t.state.drainingContextText, /state=draining_above_cap/, 'leader saw draining_above_cap while 2 members remained active above cap 1');
    assert.match(t.state.drainingContextText, /SCALE-DOWN HOLD/, 'leader received spontaneous scale-down guidance without force-killing running members');
    assert.match(t.state.atCapacityContextText, /state=at_capacity/, 'after draining from 2 to 1, leader saw at_capacity and continued holding at cap 1');
    assert.equal(t.state.scaledUpTo3, true, 'raised cap 1 -> 3 while leader was idle');
    assert.match(t.state.scaleUpWakeText, /LeaderTeam 弹性并发调度通知/, 'idle leader was woken by scheduler notice');
    assert.match(t.state.scaleUpWakeText, /user_max=3 \(cli\)/, 'woken leader saw user_max=3');
    assert.equal(t.state.concurrentAfterScaleUp, true, 'impl-3 remained alive throughout scale-down and ran concurrently with newly dispatched impl-4');
    for (let i = 1; i <= 4; i++) {
      assert.equal(read(t, `src/m${i}.txt`), `M${i}\n`);
    }
  },
};
