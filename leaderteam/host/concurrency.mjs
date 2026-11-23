// Host-side integration for the elastic concurrency scheduler:
// - Live sync with global <storageRoot>/concurrency.json, config/leaderteam.local.json, and session-scoped teams/<id>/concurrency.json
// - Cross-session active member & hardware/pipeline accounting
// - Synchronous dispatch slot reservations closing async TOCTOU windows
// - Dynamic per-step systemPrompt.context for running leaders + idle-only followup wakeups when capacity expands
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as dshLlm from '@deepseek-ai/dsh-llm';
import {
  ACTIVE_EXECUTION_STATUSES,
  ElasticConcurrencyScheduler,
  concurrencyControlPath,
  readConcurrencyControlFile,
  writeConcurrencyControlFile,
  teamConcurrencyControlPath,
  readTeamConcurrencyFile,
  writeTeamConcurrencyFile,
  resetAllTeamChatOverridesOnDisk,
} from '../core/scheduler.mjs';
import { runtime, teamStore, syncRuntimeConfig, baseRuntime } from './runtime.mjs';
import { userMessageTexts, currentTaskSeq, reconcileStaleMembers } from './roles.mjs';

export {
  concurrencyControlPath,
  readConcurrencyControlFile,
  writeConcurrencyControlFile,
  teamConcurrencyControlPath,
  readTeamConcurrencyFile,
  writeTeamConcurrencyFile,
};

function buildNoticeMessage(summary, text) {
  const bounded = typeof dshLlm.boundContextSummary === 'function'
    ? dshLlm.boundContextSummary(summary)
    : (summary.length <= 120 ? summary : `${summary.slice(0, 119)}…`);
  const input = {
    content: [{ type: 'text', text }],
    source: {
      kind: 'leaderteam-scheduler',
      form: 'notice',
      summary: bounded,
    },
  };
  if (typeof dshLlm.createUserMessage === 'function') return dshLlm.createUserMessage(input);
  return Object.freeze({ id: randomUUID(), role: 'user', ...input });
}

/**
 * Deliver a scale-up wakeup ONLY when the leader agent is genuinely idle.
 * Running leaders never receive mid-turn `inject` interruptions (they already get live `systemPrompt.context` refreshes).
 */
export function deliverSchedulerNotice(agent, notice) {
  if (!agent || !notice || agent.status !== 'idle' || typeof agent.followup !== 'function') return false;
  try {
    const message = buildNoticeMessage(notice.summary, notice.text);
    agent.followup(message);
    return true;
  } catch (e) {
    runtime().logger?.warn?.(`leaderteam: scheduler notice delivery skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

function optionalFileDeviceProbe() {
  const probeFile = process.env.LEADERTEAM_DEVICE_PROBE_FILE;
  if (!probeFile) return undefined;
  return () => {
    try {
      const raw = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {}
    return { logicalCores: 8, cpuBusyPct: 20, totalPhysMib: 16384, availPhysMib: 4096, hostRssMib: 200 };
  };
}

/** Ensure `rt.scheduler` exists (supports unit tests that initialize `rt` directly without `entry-core`). */
export function ensureScheduler(rt = runtime()) {
  rt = baseRuntime(rt);
  if (rt.scheduler && rt.schedulerConfigRef === rt.config && rt.schedulerStorageRef === rt.storageRoot) {
    return rt.scheduler;
  }
  const sched = new ElasticConcurrencyScheduler(rt.config, {
    deviceProbe: rt.deviceProbe ?? optionalFileDeviceProbe(),
  });
  rt.scheduler = sched;
  rt.schedulerConfigRef = rt.config;
  rt.schedulerStorageRef = rt.storageRoot;
  rt.concurrencyControlMtimeMs = -1;
  syncExternalConcurrencyControls(rt);
  return sched;
}

function statMtimeMs(file) {
  if (!file) return 0;
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Synchronously check leaderteam.config.json, leaderteam.local.json, and <storageRoot>/concurrency.json for live edits. */
export function syncExternalConcurrencyControls(rt = runtime()) {
  rt = baseRuntime(rt);
  if (!rt.config || !rt.storageRoot) return { changed: false, raised: false };
  const sched = rt.scheduler ?? ensureScheduler(rt);
  const before = sched.currentUserMax();
  const beforeByTeam = new Map();
  for (const tid of sched.teams.keys()) {
    beforeByTeam.set(tid, sched.currentUserMaxForTeam(tid).max);
  }

  // 1. Hot-reload leaderteam.config.json + leaderteam.local.json (updates rt.config and base maxActiveMembers)
  const cfgSync = syncRuntimeConfig(rt);

  // 2. Check global <storageRoot>/concurrency.json (CLI / operator control only)
  const ctrlFile = concurrencyControlPath(rt.storageRoot);
  const ctrlMtime = statMtimeMs(ctrlFile);
  if (ctrlMtime !== rt.concurrencyControlMtimeMs) {
    rt.concurrencyControlMtimeMs = ctrlMtime;
    if (ctrlMtime === 0) {
      sched.clearGlobalUserOverride();
    } else {
      const ctrl = readConcurrencyControlFile(rt.storageRoot);
      if (ctrl) {
        if (ctrl.maxActiveMembers === null) {
          const resetTs = ctrl.updatedAtMs || Date.now();
          sched.setUserOverride(null, ctrl.source ?? 'reset', resetTs);
          resetAllTeamChatOverridesOnDisk(rt.storageRoot, resetTs);
        } else {
          sched.setUserOverride(ctrl.maxActiveMembers, ctrl.source, ctrl.updatedAtMs || Date.now());
        }
      }
    }
  }

  const after = sched.currentUserMax();
  let anyTeamChanged = false;
  let anyTeamRaised = false;
  for (const [tid, prevMax] of beforeByTeam.entries()) {
    const nextMax = sched.currentUserMaxForTeam(tid).max;
    if (nextMax !== prevMax) anyTeamChanged = true;
    if (nextMax > prevMax) anyTeamRaised = true;
  }
  return {
    changed: after !== before || anyTeamChanged || Boolean(cfgSync.reloaded),
    raised: after > before || anyTeamRaised,
    prev: before,
    next: after,
    configReloaded: Boolean(cfgSync.reloaded),
  };
}

function collectTeamAndOtherActiveMembers(rt, teamId, sched, providedOwnMembers = null) {
  if (teamId && rt.storageRoot) reconcileStaleMembers(rt, teamStore(teamId));
  const activeMembers = Array.isArray(providedOwnMembers)
    ? providedOwnMembers
    : (teamId && rt.storageRoot ? [...teamStore(teamId).members().values()] : []);
  const otherActiveMembers = [];
  if (!rt.storageRoot) return { activeMembers, otherActiveMembers };
  const otherTeamIds = new Set();
  for (const a of rt.actors.values()) {
    if (a?.teamId && a.teamId !== teamId) otherTeamIds.add(a.teamId);
  }
  const seenOther = new Set();
  for (const tid of otherTeamIds) {
    try {
      reconcileStaleMembers(rt, teamStore(tid));
      sched.loadTeamChatState(tid, readTeamConcurrencyFile(rt.storageRoot, tid));
      for (const m of teamStore(tid).members().values()) {
        if (!m || !ACTIVE_EXECUTION_STATUSES.has(m.status)) continue;
        const key = m.childId ?? m.id ?? null;
        if (key) {
          if (seenOther.has(key)) continue;
          seenOther.add(key);
        }
        otherActiveMembers.push(m);
      }
    } catch {}
  }
  return { activeMembers, otherActiveMembers };
}

/** Sync both external global controls and session-scoped user chat directives for `teamId`. */
export function syncTeamConcurrency(ctx, teamId, rt = runtime()) {
  rt = baseRuntime(rt);
  const sched = ensureScheduler(rt);
  if (teamId && rt.storageRoot) {
    sched.loadTeamChatState(teamId, readTeamConcurrencyFile(rt.storageRoot, teamId));
  }
  const prevTeamMax = teamId ? sched.currentUserMaxForTeam(teamId).max : sched.currentUserMax();
  const ext = syncExternalConcurrencyControls(rt);
  let chatRes = null;
  if (teamId) {
    let texts = [];
    try { texts = userMessageTexts(ctx, teamId); } catch {}
    chatRes = sched.syncChatDirectives(teamId, texts, (newCap, _res, msgIndex, ts) => {
      if (rt.storageRoot) {
        try {
          writeTeamConcurrencyFile(rt.storageRoot, teamId, {
            maxActiveMembers: newCap,
            lastChatDirectiveIndex: msgIndex,
            source: 'chat',
            updatedAtMs: ts,
          });
        } catch {}
      }
    });
  }
  const nextTeamMax = teamId ? sched.currentUserMaxForTeam(teamId).max : sched.currentUserMax();
  const raised = nextTeamMax > prevTeamMax || Boolean(chatRes?.changed && chatRes.next > chatRes.prev);
  return { sched, raised, changed: nextTeamMax !== prevTeamMax || ext.changed || Boolean(chatRes?.changed) };
}

export function evaluateTeamConcurrency(ctx, teamId, options = {}) {
  const rt = runtime();
  const { sched } = syncTeamConcurrency(ctx, teamId, rt);
  const taskSeq = currentTaskSeq(ctx, teamId);
  const { activeMembers, otherActiveMembers } = collectTeamAndOtherActiveMembers(rt, teamId, sched);
  return sched.evaluate({
    teamId,
    taskSeq,
    activeMembers,
    otherActiveMembers,
    targetProfile: options.targetProfile ?? null,
    advanceSample: Boolean(options.advanceSample),
  });
}

/** Synchronously reserve a dispatch slot before any `await` in `team_dispatch`. */
export function reserveTeamDispatch(ctx, teamId, { id, name, taskSeq, profile, activeMembers: providedOwnMembers = null }) {
  const rt = runtime();
  const { sched } = syncTeamConcurrency(ctx, teamId, rt);
  const { activeMembers, otherActiveMembers } = collectTeamAndOtherActiveMembers(rt, teamId, sched, providedOwnMembers);
  return sched.reserveDispatch({
    id,
    name,
    teamId,
    taskSeq,
    activeMembers,
    otherActiveMembers,
    profile,
  });
}

export function onLeaderTurnCompleted(ctx, teamId) {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !teamId) return;
  const endSnap = evaluateTeamConcurrency(ctx, teamId);
  const sched = ensureScheduler(rt);
  const taskSeq = currentTaskSeq(ctx, teamId);
  sched.advanceLeaderTurn(teamId, taskSeq, endSnap);
  const leaderActor = rt.actors.get(teamId);
  const leaderAgent = leaderActor?.role === 'leader' ? leaderActor.agent : ctx?.get?.('agents')?.get?.(teamId);
  if (leaderAgent?.status === 'idle') {
    maybeNotifyLeaderScaleUp(ctx, teamId, { userCapRaised: false });
  }
}

export function formatLeaderConcurrencyContext(ctx, teamId) {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !teamId) return '';
  try {
    const snap = evaluateTeamConcurrency(ctx, teamId);
    const c = snap.controls;
    const a = snap.active_execution_members;
    const d = snap.device;
    const p = snap.pipeline;
    const pipeText = p.bottlenecks.length ? `, bottlenecks=[${p.bottlenecks.join(',')}]` : '';
    const globalText = a.global_total > a.total ? `, env_active=${a.global_total}` : '';
    return [
      `LeaderTeam elastic concurrency (execution subagents only; gate/discuss/arbiter excluded):`,
      `- Controls: user_max=${c.user_max_concurrent} (${c.user_max_source}), device_capacity=${c.device_capacity}, leader_max=${c.leader_max_parallel ?? 'auto'}, effective_cap=${c.effective_cap}, wave_available_now=${c.ramp_available_now}, state=${c.scale_state}`,
      `- Active execution members: ${a.total} (readonly=${a.by_profile.readonly}, code=${a.by_profile.code}, shell=${a.by_profile.shell})${globalText}${snap.backlog.pending_parallel_tasks > 0 ? `, registered_pending=${snap.backlog.pending_parallel_tasks}` : ''}`,
      `- Dispatch pressure: ${d.pressure}, hysteresis=${snap.hysteresis.mode}${pipeText}`,
      `- Action: ${snap.guidance}`,
    ].join('\n');
  } catch {
    return '';
  }
}

export function maybeNotifyLeaderScaleUp(ctx, teamId, { userCapRaised = false } = {}) {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !teamId) return false;
  const { sched, raised: syncRaised } = syncTeamConcurrency(ctx, teamId, rt);
  const effectiveUserRaise = Boolean(userCapRaised || syncRaised);
  const leaderActor = rt.actors.get(teamId);
  const leaderAgent = leaderActor?.role === 'leader' ? leaderActor.agent : ctx?.get?.('agents')?.get?.(teamId);
  if (!leaderAgent || leaderAgent.status !== 'idle' || typeof leaderAgent.followup !== 'function') {
    if (effectiveUserRaise) sched.markPendingUserScaleUpForTeam(teamId);
    return false;
  }
  const taskSeq = currentTaskSeq(ctx, teamId);
  if ((leaderAgent.inbox?.nextTurn?.length ?? 0) > 0 || (leaderAgent.inbox?.nextStep?.length ?? 0) > 0) return false;
  const turn = leaderAgent.session?.snapshotEvents?.().findLast(e => e.type === 'turn/start')?.data?.turn;
  if (teamStore(teamId).workflowEvents().some(e => e.type === 'stop-reviewed' && e.taskSeq === taskSeq && e.turn === turn && e.result?.action === 'stop')) return false;
  const { activeMembers, otherActiveMembers } = collectTeamAndOtherActiveMembers(rt, teamId, sched);
  const prepared = sched.prepareScaleUpNotice({
    teamId,
    taskSeq,
    activeMembers,
    otherActiveMembers,
    userCapRaised: effectiveUserRaise,
  });
  if (!prepared) return false;
  const delivered = deliverSchedulerNotice(leaderAgent, prepared);
  if (delivered) sched.commitScaleUpNotice(teamId, taskSeq, prepared);
  return delivered;
}

/** One priority order at idle: live/reserved work, a capacity notice or wait, then ordinary workflow recovery. */
export function handleLeaderIdle(ctx, teamId) {
  const rt = runtime(), sched = ensureScheduler(rt);
  reconcileStaleMembers(rt, teamStore(teamId));
  if ([...teamStore(teamId).members().values()].some(m => ACTIVE_EXECUTION_STATUSES.has(m.status)) || sched.reservedForTeamTask(teamId).length) return true;
  if (maybeNotifyLeaderScaleUp(ctx, teamId, { userCapRaised: false })) return true;
  const snapshot = evaluateTeamConcurrency(ctx, teamId);
  return snapshot.backlog.pending_parallel_tasks > 0 && snapshot.controls.ramp_available_now <= 0;
}

export function startConcurrencyWatchers(ctx) {
  const rt = runtime();
  const sched = ensureScheduler(rt);
  const runDetached = fn => {
    const agents = ctx.get?.('agents');
    return typeof agents?.withoutInitiator === 'function' ? agents.withoutInitiator(fn) : fn();
  };

  const notifyAllTeams = ({ userCapRaised = false } = {}) => {
    for (const actor of rt.actors.values()) {
      if (actor.role !== 'leader') continue;
      try { maybeNotifyLeaderScaleUp(ctx, actor.teamId, { userCapRaised }); } catch {}
    }
  };

  const pollMs = Math.max(100, sched.cfg.pollControlMs ?? 500);
  const sampleMs = Math.max(250, sched.cfg.sampleIntervalMs ?? 2000);

  const controlTimer = runDetached(() => setInterval(() => {
    if (!rt.startupReady) return;
    const ext = syncExternalConcurrencyControls(rt);
    if (ext.raised) notifyAllTeams({ userCapRaised: true });
  }, pollMs));
  controlTimer.unref?.();

  const sampleTimer = runDetached(() => setInterval(() => {
    if (!rt.startupReady) return;
    syncExternalConcurrencyControls(rt);
    // Sample hardware even when idle so rolling CPU delta stays warm
    sched.sampler.sample();
    notifyAllTeams({ userCapRaised: false });
  }, sampleMs));
  sampleTimer.unref?.();

  return () => {
    clearInterval(controlTimer);
    clearInterval(sampleTimer);
  };
}
