// Real DSH 0.2.2-rc.1 adversarial concurrency scenario (0 shell subprocesses, lightweight in-memory code members):
// 1. [P1-1] Leader calls team_concurrency({ pending_parallel_tasks: 1 }) BEFORE Wave 1.
// 2. [P1-2] Leader emits 3 parallel team_dispatch tool_calls in ONE single LLM turn at maxActiveMembers=2:
//    synchronous slot reservation admits exact 2 (impl-1, impl-2) and deterministically rejects the 3rd (impl-3)
//    without breaching effective_cap=2.
// 3. [P1-3] Chat directive "最大并发 2" stays scoped to teams/<id>/concurrency.json without polluting global concurrency.json.
// 4. [P1-4] Scale-up wakeup only fires via followup once leader is genuinely idle; Wave 1 members overlap in wall-clock
//    time as verified by computeMemberConcurrencyTimeline(members.jsonl).
import { assert, allow, approve, DELIVERY, dispatch, latestPlanId, lastToolResult, memberRecords, read, teamDir, toolResults } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  computeMemberConcurrencyTimeline,
  readConcurrencyControlFile,
  writeConcurrencyControlFile,
} from '../../../leaderteam/core/scheduler.mjs';

const waitFor = async (cond, ms, label = 'barrier timeout') => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(label);
    await new Promise(r => setTimeout(r, 35));
  }
};

const mkDispatch = (planId, idx) => dispatch({
  plan_id: planId,
  name: `race-impl-${idx}`,
  task: `Write src/r${idx}.txt containing R${idx}.`,
  acceptance: [`src/r${idx}.txt contains R${idx}`],
  write_scope: [`src/r${idx}.txt`],
  model: idx % 2 === 1 ? 'zcode/GLM-5.3' : 'zcode/GLM-5.3-Flash',
  effort: 'high',
});

const memberScript = idx => [
  { tool: 'read', args: { file_path: 'spec.md' } },
  { tool: 'write', args: { file_path: `src/r${idx}.txt`, content: `R${idx}\n` } },
  { content: `STATUS: done\nCHANGED: src/r${idx}.txt\nEVIDENCE: wrote r${idx}\nNOTES: none` },
];

export default {
  files: { 'spec.md': 'Write r1..r3 safely under cap.\n' },
  timeoutSec: 120,
  runs: [{ task: '最大并发 2\nImplement r1, r2, r3 in parallel waves.' }],
  config: {
    team: { maxActiveMembers: 4, maxMembersPerTeam: 8 },
    scheduler: {
      pollControlMs: 100,
      sampleIntervalMs: 250,
      rampStepSize: 4,
      rampObserveMs: 200,
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

    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;

    if (c.kind === 'member') {
      const idx = Number(c.who.split('-').at(-1));
      if (c.index === 1) {
        s.arrived.add(c.who);
        if (s.arrived.size <= 2 && !s.wave1Synced) {
          // Hold both admitted Wave 1 members together for >= 120ms so wall-clock overlap is indisputable,
          // and wait until leader finishes Turn 1 and receives the idle scale-up wakeup!
          await waitFor(() => s.arrived.size === 2, 20000, 'wave 1 two-member overlap barrier');
          await new Promise(r => setTimeout(r, 150));
          s.wave1Synced = true;
          await waitFor(() => s.wokenForWave2 === true, 25000, 'idle scale-up wakeup while wave 1 still running');
        }
      }
      const step = memberScript(idx)[c.index - 1];
      if (c.index === 3) s.finished.add(c.who);
      return step;
    }

    if (c.kind === 'leader') {
      if (c.index === 1) {
        return { tool: 'team_discuss', args: { kind: 'plan', topic: '3 files', proposal: 'Write r1..r3 under cap.' } };
      }
      if (c.index === 2) {
        // Once the user message is committed to session history, context reflects user_max=2 (chat) without touching global concurrency.json
        s.postPlanContext = c.text;
        s.globalCtrlBeforeCli = readConcurrencyControlFile(t.store);
        s.planId = latestPlanId(c) ?? JSON.parse(lastToolResult(c)).id;
        // [P1-1]: Register 1 held-back task BEFORE dispatching Wave 1!
        return { tool: 'team_concurrency', args: { pending_parallel_tasks: 1 } };
      }
      if (c.index === 3) {
        // [P1-2]: Emit THREE parallel team_dispatch calls in ONE turn at cap=2!
        return {
          tools: [
            mkDispatch(s.planId, 1),
            mkDispatch(s.planId, 2),
            mkDispatch(s.planId, 3),
          ],
        };
      }
      if (c.index === 4) {
        // Inspect which 2 succeeded and which 1 rejected, then end Turn 1 so leader goes IDLE;
        // schedule CLI scale-up 2 -> 3 shortly after Turn 1 completes while Wave 1 members are still running!
        setTimeout(() => {
          writeConcurrencyControlFile(t.store, 3, 'cli');
        }, 300);
        return { content: 'WAVE_1_CAPPED_AT_2_WAITING' };
      }
      if (!s.wokenForWave2) {
        s.wokenForWave2 = true;
        s.wakeContext = c.text;
        // Find whichever of 1..3 was rejected in the batch and dispatch it now in Wave 2!
        const missingIdx = [1, 2, 3].find(i => !s.arrived.has(`race-impl-${i}`)) ?? 3;
        s.wave2Idx = missingIdx;
        return mkDispatch(s.planId, missingIdx);
      }
      if (s.finished.size < 3) return { content: 'WAITING_ALL_3' };
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

    // [P1-3]: Chat directive "最大并发 2" stayed in teams/<id>/concurrency.json and did NOT touch global concurrency.json
    assert.match(t.state.postPlanContext, /user_max=2 \(chat\)/);
    assert.equal(t.state.globalCtrlBeforeCli, null, 'global concurrency.json untouched by chat directive');
    assert.equal(fs.existsSync(path.join(teamDir(t), 'concurrency.json')), true, 'per-team concurrency.json written');

    // [P1-2]: Out of 3 same-turn parallel team_dispatch calls at cap=2, exact 1 failed with active member limit 2 reached
    const results = toolResults(run);
    const capRejections = results.filter(r => (r.status === 'error' || r.isError) && /active member limit 2 reached/.test(JSON.stringify(r)));
    assert.equal(capRejections.length, 1, 'exact 1 of 3 concurrent dispatches rejected at cap=2');

    // [P1-1] & [P1-4]: Held-back pending_parallel_tasks=1 survived Wave 1 and woke idle leader via followup
    assert.equal(t.state.wokenForWave2, true, 'idle leader woken for Wave 2');
    assert.match(t.state.wakeContext, /LeaderTeam 弹性并发调度通知/);
    assert.match(t.state.wakeContext, /已登记待派并行任务 1 个/);

    // Timeline overlap proof on persisted members.jsonl
    const timeline = computeMemberConcurrencyTimeline(memberRecords(t));
    assert.ok(timeline.peakConcurrent >= 2 && timeline.peakConcurrent <= 3, `peakConcurrent=${timeline.peakConcurrent} within [2, 3]`);
    assert.ok(timeline.maxPairwiseOverlapMs >= 100, `real wall-clock parallel overlap=${timeline.maxPairwiseOverlapMs}ms >= 100ms`);

    for (let i = 1; i <= 3; i++) {
      assert.equal(read(t, `src/r${i}.txt`), `R${i}\n`);
    }
  },
};
