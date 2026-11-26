// Host-side integration for the elastic concurrency scheduler:
// - Live sync with global <storageRoot>/concurrency.json, config/leaderteam.local.json, and session-scoped teams/<id>/concurrency.json
// - Cross-session active member & hardware/pipeline accounting
// - Synchronous dispatch slot reservations closing async TOCTOU windows
// - Dynamic per-step systemPrompt.context for running leaders + idle-only followup wakeups when capacity expands
import fs from 'node:fs';
import path from 'node:path';
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
import {
  createPowerMonitorState,
  evaluatePowerSample,
  acknowledgePowerShutdownNotice,
  registerTeamsForPowerLatch,
  clearTeamPowerPauseOnUserTurn,
  buildNoticeFromLatchedState,
  serializePowerState,
  hydratePowerState,
} from '../core/power-monitor.mjs';
import { assessRequestWindow } from '../core/request-window.mjs';
import { readQuotaStateFile, routeQuota5hWindow } from '../core/quota.mjs';
import { routeProvider } from '../core/config.mjs';
import { TeamStore, readJsonl } from '../core/store.mjs';
import { frontierState, frontierNeedsPlanning } from '../core/frontier.mjs';
import { hasAdmissibleFrontierWork } from './activation.mjs';
import { readSystemPowerSample } from './power-adapter.mjs';
import {
  runtime,
  teamStore,
  syncRuntimeConfig,
  baseRuntime,
  resolveCanonicalRouteFromHostSelection,
  resolveProviderForRoute,
  resolveHostProviderForRoute,
  requestWindowCallsPath,
  recordSessionModelRequest,
} from './runtime.mjs';
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

export { requestWindowCallsPath, recordSessionModelRequest };

function buildCheckpointPauseNotice(rwResult) {
  const summary = `5小时请求窗口检查点暂停保护：${rwResult.reason}`;
  const text = [
    `[LeaderTeam 5小时请求窗口检查点暂停] 当前上游提供商 5 小时请求窗口已触发三级保护（tier=checkpoint_pause，原因：${rwResult.reason}）：`,
    '1. 已暂停新的执行子代理派发（team_dispatch）与直属执行（team_direct_exec）；',
    '2. 治理双审（discussA / discussB）、仲裁（arbiter）与安全门（gate）严格保持完整，绝不静默跳过；',
    '3. 请让已在运行中的成员完成安全收尾，通过 team_note 记录当前进度检查点与恢复入口，随后调用 team_status(stop_state="blocked", reason=...) 有序暂停。',
  ].join('\n');
  return { summary, text };
}

export function evaluateTeamRequestWindow(rt = runtime(), teamId = null, nowMs = Date.now(), options = {}) {
  const baseRt = baseRuntime(rt);
  const cfg = baseRt.config;
  if (!cfg || !baseRt.storageRoot) return null;
  const rwCfg = cfg.requestWindow;
  const teamCfg = teamId ? (() => { try { return teamStore(teamId) && cfg; } catch { return cfg; } })() : cfg;
  const targetRoute = typeof options.targetRoute === 'string' && options.targetRoute ? options.targetRoute : null;
  const leaderActor = teamId ? baseRt.actors?.get?.(teamId) : null;
  const liveSelection = !targetRoute ? (leaderActor?.agent?.model?.current?.() ?? null) : null;
  const effectiveRoute = targetRoute
    ?? (liveSelection?.model
      ? resolveCanonicalRouteFromHostSelection(teamCfg, liveSelection.provider ?? null, liveSelection.model, cfg.roles?.leader?.route ?? '')
      : (cfg.roles?.leader?.route ?? ''));
  const upstreamProvider = resolveProviderForRoute(effectiveRoute, teamCfg);
  const hostGateway = resolveHostProviderForRoute(effectiveRoute, teamCfg);
  const configuredWindows = (rwCfg?.windowsByProvider && typeof rwCfg.windowsByProvider === 'object')
    ? rwCfg.windowsByProvider
    : null;
  const matchByHostGateway = !options.provider
    && Boolean(configuredWindows)
    && Boolean(hostGateway)
    && hostGateway !== upstreamProvider
    && !(upstreamProvider && Object.prototype.hasOwnProperty.call(configuredWindows, upstreamProvider))
    && Object.prototype.hasOwnProperty.call(configuredWindows, hostGateway);
  const provider = options.provider ?? (matchByHostGateway ? hostGateway : upstreamProvider);

  const matchesProvider = (recRoute, recProv, recHostProv = null) => {
    if (!provider) return true;
    if (matchByHostGateway) {
      const hp = recHostProv ?? resolveHostProviderForRoute(recRoute, cfg) ?? recProv;
      return !hp || hp === provider;
    }
    const up = recRoute ? resolveProviderForRoute(recRoute, cfg) : recProv;
    return !up || up === provider;
  };

  const storeForRoot = tid => (baseRt.storageRoot === runtime().storageRoot ? teamStore(tid) : new TeamStore(baseRt.storageRoot, tid));

  // Collect per-provider call timestamps from:
  // 1. `<storageRoot>/teams/*/usage.jsonl` (governance/gate calls matching `provider`)
  // 2. `<storageRoot>/request-window-calls.jsonl` (leader/member/direct_exec LLM turns matching `provider`)
  const timestampsMs = [];
  const teamsDir = path.join(baseRt.storageRoot, 'teams');
  try {
    if (fs.existsSync(teamsDir)) {
      for (const tid of fs.readdirSync(teamsDir)) {
        try {
          for (const u of readJsonl(path.join(teamsDir, tid, 'usage.jsonl')).records) {
            if (!matchesProvider(u?.route ?? null, u?.provider ?? null, u?.hostProvider ?? null)) continue;
            const t = typeof u?.at === 'string' ? Date.parse(u.at) : (typeof u?.atMs === 'number' ? u.atMs : NaN);
            if (Number.isFinite(t)) timestampsMs.push(t);
          }
        } catch {}
      }
    }
  } catch {}

  const sessionCallsFile = requestWindowCallsPath(baseRt.storageRoot);
  try {
    if (fs.existsSync(sessionCallsFile)) {
      const rawLines = fs.readFileSync(sessionCallsFile, 'utf8').split(/\r?\n/);
      for (const line of rawLines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (!matchesProvider(r?.route ?? null, r?.provider ?? null, r?.hostProvider ?? null)) continue;
          const t = typeof r?.atMs === 'number' ? r.atMs : (typeof r?.at === 'string' ? Date.parse(r.at) : NaN);
          if (Number.isFinite(t)) timestampsMs.push(t);
        } catch {}
      }
    }
  } catch {}

  let confirmedQuota = null;
  if (cfg.quota?.stateFile) {
    const qr = readQuotaStateFile(cfg.quota.stateFile);
    const modelEntry = effectiveRoute && cfg.models?.[effectiveRoute] ? cfg.models[effectiveRoute] : null;
    if (qr.ok && effectiveRoute && modelEntry) {
      const rq5h = routeQuota5hWindow(qr.state, effectiveRoute, modelEntry, cfg.quota, new Date(nowMs));
      if (rq5h.status !== 'unknown' && typeof rq5h.bestRemainingPct === 'number') {
        confirmedQuota = { remainingPct: rq5h.bestRemainingPct, status: rq5h.status, nextResetAt: rq5h.nextResetAt };
      }
    }
  }

  const sched = baseRt.scheduler ?? null;
  const recent429Count = Array.isArray(sched?.rateLimitEvents)
    ? sched.rateLimitEvents.filter(t => nowMs - t <= 300000).length
    : 0;

  const result = assessRequestWindow({
    localCallTimestampsMs: timestampsMs,
    providerConfirmedQuota: confirmedQuota,
    provider,
    recent429Count,
    config: rwCfg,
    nowMs,
  });

  if (result.auditRecord && result.tier === 'checkpoint_pause' && options.skipAuditWrite !== true) {
    const auditFile = path.join(baseRt.storageRoot, 'request-window-audit.jsonl');
    const lastKey = `${provider ?? 'default'}:${result.tier}:${result.local_estimated_requests_5h}:${result.confirmedRemainingPct ?? 'na'}`;
    if (baseRt.lastRequestWindowAuditKey !== lastKey) {
      baseRt.lastRequestWindowAuditKey = lastKey;
      try {
        fs.mkdirSync(baseRt.storageRoot, { recursive: true });
        fs.appendFileSync(auditFile, JSON.stringify({ teamId, ...result.auditRecord }) + '\n', 'utf8');
      } catch (err) {
        baseRt.logger?.warn?.(`leaderteam: failed to write request-window audit log: ${err instanceof Error ? err.message : String(err)}`);
      }
      const targetTeams = teamId
        ? [teamId]
        : [...(baseRt.actors?.values() ?? [])].filter(a => a.role === 'leader').map(a => a.teamId);
      for (const tid of targetTeams) {
        try {
          storeForRoot(tid).appendGovernanceEvent({
            type: 'request-window-checkpoint-pause',
            ...result.auditRecord,
          });
        } catch {}
      }
    }
  }
  return result;
}

export function powerMonitorStatePath(storageRoot) {
  return path.join(storageRoot, 'power-monitor-state.json');
}

export function loadPersistedPowerState(storageRoot) {
  if (!storageRoot) return createPowerMonitorState();
  const file = powerMonitorStatePath(storageRoot);
  try {
    if (!fs.existsSync(file)) return createPowerMonitorState();
    return hydratePowerState(fs.readFileSync(file, 'utf8'));
  } catch {
    return createPowerMonitorState();
  }
}

export function savePersistedPowerState(storageRoot, state) {
  if (!storageRoot) return;
  const file = powerMonitorStatePath(storageRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(serializePowerState(state), null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function trySavePersistedPowerState(baseRt) {
  if (!baseRt?.storageRoot || !baseRt?.powerMonitorState) return false;
  try {
    savePersistedPowerState(baseRt.storageRoot, baseRt.powerMonitorState);
    baseRt.powerMonitorStateDirty = false;
    return true;
  } catch (err) {
    baseRt.powerMonitorStateDirty = true;
    baseRt.logger?.warn?.(`leaderteam: failed to persist power-monitor-state.json (will retry): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function isTeamAwaitingUserAfterPowerPause(rt = runtime(), teamId = null) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config || baseRt.config.powerMonitor?.enabled === false) return false;
  if (!baseRt.powerMonitorState && baseRt.storageRoot) {
    baseRt.powerMonitorState = loadPersistedPowerState(baseRt.storageRoot);
  }
  const st = baseRt.powerMonitorState;
  if (!st) return false;
  if (st.latched) {
    if (teamId && Array.isArray(st.userResumedTeamsDuringLatch) && st.userResumedTeamsDuringLatch.includes(teamId)) {
      return false;
    }
    return true;
  }
  if (teamId && Array.isArray(st.pausedTeamsAwaitingUser) && st.pausedTeamsAwaitingUser.includes(teamId)) {
    return true;
  }
  return false;
}

export function clearPowerPauseForTeamOnUserMessage(rt = runtime(), teamId = null) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.storageRoot || !teamId) return false;
  if (!baseRt.powerMonitorState) {
    baseRt.powerMonitorState = loadPersistedPowerState(baseRt.storageRoot);
  }
  const res = clearTeamPowerPauseOnUserTurn(baseRt.powerMonitorState, teamId);
  if (res.changed || baseRt.powerMonitorStateDirty) {
    trySavePersistedPowerState(baseRt);
  }
  return res.changed;
}

export async function pollAndDeliverPowerMonitor(ctx, rt = runtime(), options = {}) {
  const baseRt = baseRuntime(rt);
  if (!baseRt.config || !baseRt.storageRoot) return null;
  const pmCfg = baseRt.config.powerMonitor;
  if (!baseRt.powerMonitorState) {
    baseRt.powerMonitorState = loadPersistedPowerState(baseRt.storageRoot);
  }
  const sample = options.sample ?? await readSystemPowerSample({
    hostPowerReader: options.hostPowerReader ?? baseRt.hostPowerReader,
  });
  const nowMs = options.nowMs ?? Date.now();
  const outcome = evaluatePowerSample(baseRt.powerMonitorState, sample, pmCfg, nowMs);
  baseRt.powerMonitorState = outcome.state;

  const leaderActors = [...baseRt.actors.values()].filter(a => a.role === 'leader');
  const activeLeaderTeamIds = leaderActors.map(a => a.teamId).filter(Boolean);
  if (outcome.latched) {
    registerTeamsForPowerLatch(baseRt.powerMonitorState, activeLeaderTeamIds);
  }
  if (outcome.action === 'notify_graceful_shutdown') {
    for (const tid of activeLeaderTeamIds) {
      try {
        teamStore(tid).appendGovernanceEvent({
          type: 'low-battery-graceful-shutdown',
          action: 'notify_graceful_shutdown',
          batteryPct: outcome.notice?.batteryPct ?? sample?.batteryPct ?? null,
          lowBatteryPct: pmCfg?.lowBatteryPct ?? 20,
          atMs: nowMs,
        });
      } catch {}
    }
  }
  trySavePersistedPowerState(baseRt);

  if (outcome.latched) {
    const noticeToSend = outcome.notice ?? buildNoticeFromLatchedState(baseRt.powerMonitorState, pmCfg, nowMs);
    if (leaderActors.length === 0 && outcome.notice && options.acknowledgeWhenNoLeaders === true) {
      acknowledgePowerShutdownNotice(baseRt.powerMonitorState, { ackedAtMs: nowMs, deliveredBy: 'headless-no-leaders' });
      trySavePersistedPowerState(baseRt);
    } else {
      let anyDelivered = false;
      const resumedList = baseRt.powerMonitorState.userResumedTeamsDuringLatch ?? [];
      for (const actor of leaderActors) {
        const pendingList = baseRt.powerMonitorState.pendingTeams ?? [];
        const ackedList = baseRt.powerMonitorState.ackedTeams ?? [];
        if (resumedList.includes(actor.teamId) || ackedList.includes(actor.teamId)) continue;
        if (!pendingList.includes(actor.teamId) && !(pendingList.length === 0 && ackedList.length === 0 && baseRt.powerMonitorState.pendingNotice)) {
          continue;
        }
        const leaderAgent = actor.agent ?? ctx?.get?.('agents')?.get?.(actor.teamId);
        if (deliverSchedulerNotice(leaderAgent, noticeToSend)) {
          acknowledgePowerShutdownNotice(baseRt.powerMonitorState, {
            teamId: actor.teamId,
            ackedAtMs: nowMs,
            deliveredBy: 'scheduler-followup',
          });
          anyDelivered = true;
        }
      }
      if (
        baseRt.powerMonitorState.pendingNotice
        && (baseRt.powerMonitorState.pendingTeams?.length ?? 0) === 0
        && leaderActors.length > 0
        && leaderActors.every(a => resumedList.includes(a.teamId) || (baseRt.powerMonitorState.ackedTeams ?? []).includes(a.teamId))
      ) {
        baseRt.powerMonitorState.pendingNotice = false;
        anyDelivered = true;
      }
      if (anyDelivered || baseRt.powerMonitorStateDirty) {
        trySavePersistedPowerState(baseRt);
      }
    }
  }
  // CRITICAL: when action === 'rearmed', we NEVER wake/auto-resume paused leaders (`pausedTeamsAwaitingUser` remains locked until user message)!
  return outcome;
}

function evaluateExecutionPoolWindowSummary(baseRt, teamId, nowMs = Date.now()) {
  const cfg = baseRt?.config;
  if (!cfg || !baseRt?.storageRoot) return null;
  const poolRoutes = Array.isArray(cfg.team?.executionPool) && cfg.team.executionPool.length > 0
    ? cfg.team.executionPool
    : [cfg.roles?.leader?.route].filter(Boolean);
  const seenProviders = new Set();
  const evaluations = [];
  for (const r of poolRoutes) {
    const prov = resolveProviderForRoute(r, cfg) ?? '';
    if (seenProviders.has(prov)) continue;
    seenProviders.add(prov);
    const ev = evaluateTeamRequestWindow(baseRt, teamId, nowMs, { targetRoute: r, skipAuditWrite: true });
    if (ev) evaluations.push(ev);
  }
  if (evaluations.length === 0) {
    return evaluateTeamRequestWindow(baseRt, teamId, nowMs);
  }
  const allPaused = evaluations.every(e => e.triggerCheckpointPause);
  if (allPaused) {
    // Re-evaluate primary route with audit enabled so the checkpoint_pause audit event is persisted
    return evaluateTeamRequestWindow(baseRt, teamId, nowMs, { targetRoute: poolRoutes[0] });
  }
  if (evaluations.some(e => e.maxNewDispatchCap === null)) {
    return { maxNewDispatchCap: null, triggerCheckpointPause: false };
  }
  const maxCap = Math.max(...evaluations.map(e => (typeof e.maxNewDispatchCap === 'number' ? e.maxNewDispatchCap : 0)));
  return { maxNewDispatchCap: maxCap, triggerCheckpointPause: false };
}

function effectiveExternalDispatchCap(rt, teamId) {
  const baseRt = baseRuntime(rt);
  if (!baseRt.config || !baseRt.storageRoot) return undefined;
  if (isTeamAwaitingUserAfterPowerPause(baseRt, teamId)) {
    return 0;
  }
  const poolSummary = evaluateExecutionPoolWindowSummary(baseRt, teamId);
  if (poolSummary && typeof poolSummary.maxNewDispatchCap === 'number') {
    return poolSummary.maxNewDispatchCap;
  }
  return undefined;
}

export function evaluateTeamConcurrency(ctx, teamId, options = {}) {
  const rt = runtime();
  const { sched } = syncTeamConcurrency(ctx, teamId, rt);
  const taskSeq = currentTaskSeq(ctx, teamId);
  const { activeMembers, otherActiveMembers } = collectTeamAndOtherActiveMembers(rt, teamId, sched);
  const requestWindowMaxCap = options.requestWindowMaxCap !== undefined
    ? options.requestWindowMaxCap
    : effectiveExternalDispatchCap(rt, teamId);
  return sched.evaluate({
    teamId,
    taskSeq,
    activeMembers,
    otherActiveMembers,
    targetProfile: options.targetProfile ?? null,
    advanceSample: Boolean(options.advanceSample),
    requestWindowMaxCap,
  });
}

/** Synchronously reserve a dispatch slot before any `await` in `team_dispatch`. */
export function reserveTeamDispatch(ctx, teamId, { id, name, taskSeq, profile, activeMembers: providedOwnMembers = null }) {
  const rt = runtime();
  const { sched } = syncTeamConcurrency(ctx, teamId, rt);
  const { activeMembers, otherActiveMembers } = collectTeamAndOtherActiveMembers(rt, teamId, sched, providedOwnMembers);
  const requestWindowMaxCap = effectiveExternalDispatchCap(rt, teamId);
  return sched.reserveDispatch({
    id,
    name,
    teamId,
    taskSeq,
    activeMembers,
    otherActiveMembers,
    profile,
    requestWindowMaxCap,
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
    const baseRt = baseRuntime(rt);
    if (!baseRt.powerMonitorState) {
      baseRt.powerMonitorState = loadPersistedPowerState(baseRt.storageRoot);
    }
    if (baseRt.powerMonitorStateDirty) {
      trySavePersistedPowerState(baseRt);
    }
    if (baseRt.config.powerMonitor?.enabled !== false && baseRt.powerMonitorState?.latched) {
      registerTeamsForPowerLatch(baseRt.powerMonitorState, [teamId]);
      const pendingTeams = baseRt.powerMonitorState.pendingTeams ?? [];
      const ackedTeams = baseRt.powerMonitorState.ackedTeams ?? [];
      if (!ackedTeams.includes(teamId) && (pendingTeams.includes(teamId) || (pendingTeams.length === 0 && ackedTeams.length === 0 && baseRt.powerMonitorState.pendingNotice))) {
        const retryNotice = buildNoticeFromLatchedState(baseRt.powerMonitorState, baseRt.config.powerMonitor);
        if (deliverSchedulerNotice(leaderAgent, retryNotice)) {
          acknowledgePowerShutdownNotice(baseRt.powerMonitorState, {
            teamId,
            ackedAtMs: Date.now(),
            deliveredBy: 'turn-end-retry',
          });
          trySavePersistedPowerState(baseRt);
          return;
        }
      }
    }
    const rw = evaluateExecutionPoolWindowSummary(baseRt, teamId);
    if (rw?.triggerCheckpointPause) {
      baseRt.notifiedCheckpointPauseTeams ??= new Set();
      const cpKey = `${teamId}:${taskSeq}`;
      if (!baseRt.notifiedCheckpointPauseTeams.has(cpKey)) {
        const notice = buildCheckpointPauseNotice(rw);
        if (deliverSchedulerNotice(leaderAgent, notice)) {
          baseRt.notifiedCheckpointPauseTeams.add(cpKey);
          return;
        }
      }
      return;
    }
    if (!isTeamAwaitingUserAfterPowerPause(baseRt, teamId)) {
      maybeNotifyLeaderScaleUp(ctx, teamId, { userCapRaised: false });
    }
  }
}

export function formatLeaderConcurrencyContext(ctx, teamId) {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !teamId) return '';
  try {
    const baseRt = baseRuntime(rt);
    const snap = evaluateTeamConcurrency(ctx, teamId);
    const rw = evaluateTeamRequestWindow(baseRt, teamId);
    const c = snap.controls;
    const a = snap.active_execution_members;
    const d = snap.device;
    const p = snap.pipeline;
    const pipeText = p.bottlenecks.length ? `, bottlenecks=[${p.bottlenecks.join(',')}]` : '';
    const globalText = a.global_total > a.total ? `, env_active=${a.global_total}` : '';
    const lines = [
      `LeaderTeam elastic concurrency (execution subagents only; gate/discuss/arbiter excluded):`,
      `- Controls: user_max=${c.user_max_concurrent} (${c.user_max_source}), device_capacity=${c.device_capacity}, leader_max=${c.leader_max_parallel ?? 'auto'}, effective_cap=${c.effective_cap}, wave_available_now=${c.ramp_available_now}, state=${c.scale_state}`,
      `- Active execution members: ${a.total} (readonly=${a.by_profile.readonly}, code=${a.by_profile.code}, shell=${a.by_profile.shell})${globalText}${snap.backlog.pending_parallel_tasks > 0 ? `, registered_pending=${snap.backlog.pending_parallel_tasks}` : ''}`,
      `- Dispatch pressure: ${d.pressure}, hysteresis=${snap.hysteresis.mode}${pipeText}`,
    ];
    if (rw && rw.enabled !== false) {
      const confirmedLabel = rw.confirmedSource === 'provider-confirmed'
        ? `${rw.confirmedRemainingPct !== null ? `${rw.confirmedRemainingPct}%` : 'confirmed'} (provider-confirmed)`
        : 'unknown';
      lines.push(`- 5h request window: local_estimated=${rw.local_estimated_requests_5h} (local-estimate), provider_confirmed=${confirmedLabel}, tier=${rw.tier} (governance reviews never skipped)`);
    }
    if (isTeamAwaitingUserAfterPowerPause(baseRt, teamId)) {
      lines.push(`- Battery-aware wind-down ACTIVE (${baseRt.powerMonitorState?.latched ? `${baseRt.powerMonitorState.lastBatteryPct ?? '<=20'}% on battery` : 'awaiting explicit user message to resume after low-battery pause'}): stop new non-essential dispatches, let active members reach safe checkpoints, persist progress & resume entry.`);
    }
    lines.push(`- Action: ${snap.guidance}`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

export function maybeNotifyLeaderScaleUp(ctx, teamId, { userCapRaised = false } = {}) {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !teamId) return false;
  if (isTeamAwaitingUserAfterPowerPause(rt, teamId)) return false;
  const rw = evaluateExecutionPoolWindowSummary(baseRuntime(rt), teamId);
  if (rw?.triggerCheckpointPause) return false;
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
  const store = teamStore(teamId);
  const wfEvents = store.workflowEvents().filter(e => e.taskSeq === taskSeq);
  const lastStopDecl = wfEvents.findLast(e => e.type === 'stop-declared');
  // Terminal delivery suppresses all subsequent scale-up wakeups for this taskSeq
  if (lastStopDecl?.state === 'delivered') {
    sched.clearAwaitingSlots(teamId, taskSeq);
    return false;
  }
  const turn = leaderAgent.session?.snapshotEvents?.().findLast(e => e.type === 'turn/start')?.data?.turn;
  if (wfEvents.some(e => e.type === 'stop-reviewed' && e.turn === turn && e.result?.action === 'stop')) return false;

  // Decouple capacity shifts from wakeup delivery under rolling planning: when no explicit pendingParallelTasks are held back
  // and rolling stages exist, suppress wakeups whenever the plan frontier has zero admissible undispatched stages.
  const teamSt = sched.teamState(teamId, taskSeq);
  if (rt.config.team?.rollingPlanning && teamSt.pendingParallelTasks === 0) {
    const fState = frontierState(store, taskSeq);
    if (fState.revision > 0) {
      const hasFrontierDispatch = hasAdmissibleFrontierWork(rt, store, rt.config, taskSeq);
      if (!hasFrontierDispatch && (!frontierNeedsPlanning(store, taskSeq) || lastStopDecl?.state === 'waiting_members')) {
        return false;
      }
    }
  }

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
    sched.sampler.sample({ force: true });
    notifyAllTeams({ userCapRaised: false });
  }, sampleMs));
  sampleTimer.unref?.();

  const powerPollMs = Math.max(600000, Math.min(900000, rt.config?.powerMonitor?.pollIntervalMs ?? 720000));
  let powerTimer = null;
  if (rt.config?.powerMonitor?.enabled !== false) {
    powerTimer = runDetached(() => setInterval(() => {
      if (!rt.startupReady || rt.config?.powerMonitor?.enabled === false) return;
      void pollAndDeliverPowerMonitor(ctx, rt).catch(() => {});
    }, powerPollMs));
    powerTimer.unref?.();
  }

  return () => {
    clearInterval(controlTimer);
    clearInterval(sampleTimer);
    if (powerTimer) clearInterval(powerTimer);
  };
}
