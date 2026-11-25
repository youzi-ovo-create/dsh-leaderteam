// Authoritative session execution mode read, idle-only switch guard, and 0-LLM live hot-swap controller.
// Kept 100% free of bare `@deepseek-ai/*` imports so DSH host, standalone `lt-ui`, and Node unit tests share one engine.
import fs from 'node:fs';
import { LtError } from '../core/constants.mjs';
import { TeamStore, encodeTeamStoreId } from '../core/store.mjs';
import { replayGovernanceState } from '../core/governance-protocol.mjs';
import {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  normalizeExecutionMode,
  encodeSessionModeSegment,
  resolveSessionModePaths,
  readSessionModeRecord,
  writeSessionModeRecord,
  readSessionModeHistory,
} from '../core/session-mode.mjs';
import { runtime, baseRuntime, teamStore, runtimeForTeam } from './runtime.mjs';
import { reconcileStaleMembers, currentTaskSeq, syncLeaderAgentMode, isLeaderRoot } from './roles.mjs';

export {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  normalizeExecutionMode,
  encodeSessionModeSegment,
  readSessionModeRecord,
  writeSessionModeRecord,
  readSessionModeHistory,
};

const MAX_MODE_CACHE_ENTRIES = 512;
const BUSY_MEMBER_STATUSES = new Set(['starting', 'started', 'running', 'paused']);
const BUSY_MEMBER_GOV_STATES = new Set(['pausing_for_conference', 'paused_for_conference']);

function modeFileSignature(file) {
  if (!file) return 'none';
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
  } catch {
    return 'missing';
  }
}

function setBoundedModeCache(baseRt, sessionId, entry) {
  baseRt.sessionModesCache ??= new Map();
  const cache = baseRt.sessionModesCache;
  if (cache.has(sessionId)) cache.delete(sessionId);
  while (cache.size >= MAX_MODE_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(sessionId, entry);
}

function getHostService(ctx, name) {
  if (!ctx) return null;
  if (typeof ctx.get === 'function') {
    try {
      const val = ctx.get(name);
      if (val !== undefined && val !== null) return val;
    } catch {}
  }
  try {
    return ctx[name] ?? null;
  } catch {
    return null;
  }
}

function safeCurrentTaskSeq(ctx, sessionId) {
  try {
    return currentTaskSeq(ctx, sessionId);
  } catch {
    return 1;
  }
}

function computeMaxRecordedStoreTaskSeq(store, rec = null) {
  let maxSeq = Number.isInteger(rec?.lastTaskSeqHint) && rec.lastTaskSeqHint >= 1 ? rec.lastTaskSeqHint : 1;
  if (!store) return maxSeq;
  const bump = val => {
    if (Number.isInteger(val) && val > maxSeq) maxSeq = val;
  };
  try {
    for (const ev of store.governanceEvents?.() ?? []) bump(ev?.taskSeq);
  } catch {}
  try {
    for (const ev of store.workflowEvents?.() ?? []) bump(ev?.taskSeq);
  } catch {}
  try {
    const members = store.members?.();
    if (members) {
      for (const m of members.values()) bump(m?.taskSeq);
    }
  } catch {}
  try {
    for (const r of store.agreementRecords?.() ?? []) bump(r?.taskSeq);
  } catch {}
  return maxSeq;
}

/**
 * Fast authoritative mode lookup (`'team' | 'single'`), synced with disk mtime and write cache.
 * Defaults to `'team'` with zero disk writes when no mode record exists.
 */
export function getSessionExecutionMode(rt = runtime(), sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return DEFAULT_EXECUTION_MODE;
  const baseRt = baseRuntime(rt ?? runtime());
  if (!baseRt?.storageRoot) {
    return baseRt?.sessionModesCache?.get?.(sessionId)?.mode ?? DEFAULT_EXECUTION_MODE;
  }
  try {
    const { stateFile } = resolveSessionModePaths(baseRt.storageRoot, sessionId, { ensureDir: false });
    const sig = modeFileSignature(stateFile);
    const cached = baseRt.sessionModesCache?.get?.(sessionId);
    if (cached && cached.storageRoot === baseRt.storageRoot && cached.sig === sig) {
      return cached.mode;
    }
    const rec = sig === 'missing'
      ? {
          sessionId,
          mode: DEFAULT_EXECUTION_MODE,
          persisted: false,
          updatedAt: null,
          switchCount: 0,
        }
      : readSessionModeRecord(baseRt.storageRoot, sessionId);
    setBoundedModeCache(baseRt, sessionId, {
      storageRoot: baseRt.storageRoot,
      sig,
      mode: rec.mode,
      record: rec,
    });
    return rec.mode;
  } catch {
    // Fail-closed to `'team'` (where direct write/edit/shell tools are revoked on leader).
    return DEFAULT_EXECUTION_MODE;
  }
}

/**
 * Inspect full `SessionModeSnapshot` for `sessionId`, evaluating LT-session membership and every idle-guard condition.
 * Performs zero `TeamStore` file creations when `TeamStore.exists` is false.
 */
export function inspectSessionModeState(ctx, rt = runtime(), sessionId, options = {}) {
  encodeSessionModeSegment(sessionId);
  const baseRt = baseRuntime(rt ?? runtime());
  let rec;
  let corruptOnDisk = false;
  if (baseRt?.storageRoot) {
    try {
      rec = readSessionModeRecord(baseRt.storageRoot, sessionId);
    } catch (err) {
      if (err?.code !== 'SESSION_MODE_CORRUPT') throw err;
      corruptOnDisk = true;
      rec = {
        sessionId,
        mode: DEFAULT_EXECUTION_MODE,
        persisted: false,
        updatedAt: null,
        switchCount: 0,
      };
    }
  } else {
    rec = {
      sessionId,
      mode: getSessionExecutionMode(baseRt, sessionId),
      persisted: false,
      updatedAt: null,
      switchCount: 0,
    };
  }
  if (baseRt?.storageRoot && !corruptOnDisk) {
    const { stateFile } = resolveSessionModePaths(baseRt.storageRoot, sessionId, { ensureDir: false });
    setBoundedModeCache(baseRt, sessionId, {
      storageRoot: baseRt.storageRoot,
      sig: modeFileSignature(stateFile),
      mode: rec.mode,
      record: rec,
    });
  } else if (baseRt?.storageRoot && corruptOnDisk) {
    baseRt.sessionModesCache?.delete?.(sessionId);
  }

  const liveActor = baseRt?.actors?.get?.(sessionId) ?? null;
  const hostAgents = baseRt?.hostAgents ?? getHostService(ctx, 'agents');
  const liveAgent = (liveActor?.role === 'leader' ? liveActor.agent : null) ?? hostAgents?.get?.(sessionId) ?? null;

  const leaderPreset = baseRt?.config?.profiles?.leader?.preset ?? 'leaderteam';
  let isLtSession = true;
  let notLtReason = null;

  if ((liveActor && liveActor.role !== 'leader') || liveAgent?.session?.header?.origin === 'subagent' || options.origin === 'subagent') {
    isLtSession = false;
    notLtReason = 'Subagent sessions cannot switch execution mode independently';
  } else if (baseRt?.surface === 'headless') {
    if (process.env.LEADERTEAM_HEADLESS_LEADER === '0' && options.isLtSession !== true) {
      isLtSession = false;
      notLtReason = 'Headless session is not a LeaderTeam leader session';
    }
  } else {
    const presets = getHostService(ctx, 'agentPresets');
    const sessionsSvc = getHostService(ctx, 'sessions');
    const liveSession = sessionsSvc?.get?.(sessionId) ?? liveAgent?.session ?? null;
    let preset = typeof presets?.presetForSession === 'function' && liveSession
      ? presets.presetForSession(liveSession)
      : undefined;
    if (preset === undefined || preset === null) {
      preset = liveSession?.header?.agentPreset ?? options.agentPreset ?? null;
    }
    if (typeof preset === 'string' && preset.trim() !== '') {
      const cleanPreset = preset.trim();
      if (cleanPreset !== leaderPreset) {
        isLtSession = false;
        notLtReason = `Session uses native DSH preset "${cleanPreset}", not LeaderTeam`;
      }
    } else if (options.isLtSession === false) {
      isLtSession = false;
      notLtReason = 'Not a LeaderTeam session';
    }
  }

  const agentRunning = Boolean(liveAgent && typeof liveAgent.status === 'string' && liveAgent.status !== 'idle');
  const inboxPending = (liveAgent?.inbox?.nextTurn?.length ?? 0) > 0 || (liveAgent?.inbox?.nextStep?.length ?? 0) > 0;
  const passiveRunning = Boolean(
    options.passiveRunning
    || options.passiveState?.running === true
    || options.passiveState?.status === 'running',
  );
  const activeTurn = agentRunning || inboxPending || passiveRunning;

  let activeMembersCount = 0;
  let activeConferenceId = null;
  let activeHumanEscalation = null;
  let unsatisfiedDirective = null;
  const memberChildIds = new Set();
  if (baseRt?.storageRoot && TeamStore.exists(baseRt.storageRoot, sessionId)) {
    const store = baseRt === runtime()
      ? teamStore(sessionId)
      : (baseRt.stores?.get?.(sessionId) ?? new TeamStore(baseRt.storageRoot, sessionId));
    reconcileStaleMembers(baseRt, store);
    for (const [cid, m] of store.members().entries()) {
      if (typeof cid === 'string' && cid) memberChildIds.add(cid);
      if (BUSY_MEMBER_STATUSES.has(m.status) || BUSY_MEMBER_GOV_STATES.has(m.governanceState)) {
        activeMembersCount += 1;
      }
    }
    const govEvents = store.governanceEvents();
    const liveTSeq = safeCurrentTaskSeq(ctx, sessionId);
    const maxRecordedStoreTaskSeq = computeMaxRecordedStoreTaskSeq(store, rec);
    const effectiveTSeq = Math.max(liveTSeq, maxRecordedStoreTaskSeq);
    let maxGovEventSeq = 1;
    for (const ev of govEvents) {
      if (Number.isInteger(ev?.taskSeq) && ev.taskSeq > maxGovEventSeq) maxGovEventSeq = ev.taskSeq;
    }
    const candidateTSeqs = [...new Set(
      [effectiveTSeq, maxGovEventSeq, liveTSeq].filter(n => Number.isInteger(n) && n >= 1),
    )];
    for (const seq of candidateTSeqs) {
      // Skip stale earlier taskSeqs when a live session has already advanced past them,
      // while always checking both `liveTSeq` and `effectiveTSeq` (and cold recorded taskSeqs).
      if (liveAgent?.session && liveTSeq > 1 && seq < liveTSeq) continue;
      if (!liveAgent?.session && seq < maxGovEventSeq && seq < effectiveTSeq) continue;
      const govState = replayGovernanceState(govEvents, seq);
      if (!activeConferenceId && (govState.activeConference || govState.pausingConference)) {
        activeConferenceId = govState.activeConference?.conferenceId
          ?? govState.pausingConference?.conferenceId
          ?? 'conference-open';
      }
      if (!activeHumanEscalation && govState.activeHumanEscalation) {
        activeHumanEscalation = govState.activeHumanEscalation;
      }
      if (!unsatisfiedDirective) {
        unsatisfiedDirective = (govState.activeDirectives ?? []).find(
          d => d && !d.satisfied && (d.decision === 'enforce_correction' || d.decision === 'adopt_alternative'),
        ) ?? null;
      }
    }
    // Strike-3 human escalation is session-wide until paired with `human-escalation-resolved` (`governance.mjs:1898-1900`).
    if (!activeHumanEscalation && govEvents.length > 0) {
      const resolvedEscIds = new Set(
        govEvents.filter(e => e?.type === 'human-escalation-resolved').map(e => e.escalationId),
      );
      const openEsc = govEvents.findLast(
        e => e?.type === 'human-escalation-opened' && !resolvedEscIds.has(e.escalationId),
      );
      if (openEsc) activeHumanEscalation = openEsc;
    }
  }

  let encodedStoreId = null;
  if (baseRt?.storageRoot) {
    try { encodedStoreId = encodeTeamStoreId(sessionId, baseRt.storageRoot); } catch {}
  }
  const matchesTeamId = tid => tid === sessionId || (encodedStoreId !== null && tid === encodedStoreId);
  const execReviews = [...(baseRt?.executionReviewJobs?.values?.() ?? [])].filter(j => matchesTeamId(j?.teamId)).length;
  const govJobs = [...(baseRt?.governanceJobs?.values?.() ?? [])].filter(j => matchesTeamId(j?.teamId)).length;
  const stopRev = (baseRt?.stopReviewPending?.has?.(sessionId) || (encodedStoreId && baseRt?.stopReviewPending?.has?.(encodedStoreId))) ? 1 : 0;
  const dirVer = (baseRt?.directiveVerifyPending?.has?.(sessionId) || (encodedStoreId && baseRt?.directiveVerifyPending?.has?.(encodedStoreId))) ? 1 : 0;
  const gateMap = baseRt?.inFlightGateReviews?.get?.(sessionId)
    ?? (encodedStoreId ? baseRt?.inFlightGateReviews?.get?.(encodedStoreId) : undefined);
  const gateRev = gateMap instanceof Map
    ? [...gateMap.values()].reduce((acc, n) => acc + (Number.isFinite(n) && n > 0 ? n : 0), 0)
    : (typeof gateMap === 'number' && gateMap > 0 ? gateMap : 0);
  const trackedCircuitAgentIds = new Set([sessionId, ...memberChildIds]);
  for (const a of baseRt?.actors?.values?.() ?? []) {
    if (matchesTeamId(a?.teamId) && typeof a.agentId === 'string' && a.agentId) {
      trackedCircuitAgentIds.add(a.agentId);
    }
  }
  let circuitInv = 0;
  for (const aid of trackedCircuitAgentIds) {
    if (baseRt?.circuitStates?.get?.(aid)?.inFlightInvestigation === true) {
      circuitInv += 1;
    }
  }
  const pendingReviewsCount = execReviews + govJobs + stopRev + dirVer + gateRev + circuitInv;

  let activeShellJobsCount = Number.isInteger(options.activeShellJobsCount) && options.activeShellJobsCount > 0
    ? options.activeShellJobsCount
    : 0;
  activeShellJobsCount += baseRt?.inFlightShellCallsBySession?.get?.(sessionId) ?? 0;
  const jobsSvc = getHostService(liveAgent?.ctx, 'jobs') ?? getHostService(ctx, 'jobs');
  if (typeof jobsSvc?.list === 'function') {
    try {
      const list = jobsSvc.list(sessionId) ?? [];
      if (Array.isArray(list)) {
        activeShellJobsCount += list.filter(j => j && (j.status === 'running' || j.status === 'stopping')).length;
      }
    } catch {}
  }

  const canSwitch = Boolean(
    isLtSession
    && !activeTurn
    && activeMembersCount === 0
    && pendingReviewsCount === 0
    && !activeConferenceId
    && !activeHumanEscalation
    && !unsatisfiedDirective
    && activeShellJobsCount === 0,
  );

  let busyReason = null;
  if (!canSwitch) {
    if (!isLtSession) {
      busyReason = notLtReason || 'Not a LeaderTeam session';
    } else if (activeTurn) {
      busyReason = agentRunning
        ? `Leader session is currently executing (status="${liveAgent.status}")`
        : inboxPending
          ? 'Leader session has queued messages in inbox'
          : 'Leader session is currently executing';
    } else if (activeConferenceId) {
      busyReason = `Formal governance conference "${activeConferenceId}" is open; conclude it before switching mode`;
    } else if (activeHumanEscalation) {
      busyReason = `Human governance escalation "${activeHumanEscalation.escalationId ?? 'escalation'}" is awaiting user resolution in Team mode`;
    } else if (unsatisfiedDirective) {
      busyReason = `Binding Arbiter directive from conference "${unsatisfiedDirective.conferenceId ?? 'conference'}" must be verified in Team mode before switching`;
    } else if (activeMembersCount > 0) {
      busyReason = `${activeMembersCount} team member(s) are currently active or paused at checkpoint`;
    } else if (pendingReviewsCount > 0) {
      busyReason = circuitInv > 0 && pendingReviewsCount === circuitInv
        ? `${circuitInv} circuit-breaker investigation review(s) are still in flight`
        : `${pendingReviewsCount} governance or safety review job(s) are still in flight`;
    } else if (activeShellJobsCount > 0) {
      busyReason = `${activeShellJobsCount} shell command or background job(s) are still running`;
    }
  }

  return {
    sessionId,
    mode: rec.mode,
    defaultMode: DEFAULT_EXECUTION_MODE,
    isLtSession,
    canSwitch,
    busyReason,
    activeTurn,
    activeMembersCount,
    pendingReviewsCount,
    activeConferenceId,
    updatedAt: rec.updatedAt ?? null,
    switchCount: rec.switchCount ?? 0,
  };
}

/**
 * Switch a LeaderTeam session between `'team'` and `'single'` modes when idle.
 * Performs 0 LLM calls, 0 subagent spawns, and 0 synthetic user messages.
 */
export function switchSessionExecutionMode(ctx, rt = runtime(), sessionId, targetMode, options = {}) {
  encodeSessionModeSegment(sessionId);
  const nextMode = normalizeExecutionMode(targetMode);
  const baseRt = baseRuntime(rt ?? runtime());
  if (!baseRt?.storageRoot) {
    throw new LtError('BAD_STORAGE_ROOT', 'LeaderTeam runtime storageRoot is not initialized');
  }

  const state = inspectSessionModeState(ctx, baseRt, sessionId, options);
  if (!state.isLtSession) {
    throw new LtError('MODE_NOT_LT_SESSION', state.busyReason || 'Not a LeaderTeam session', { modeState: state });
  }
  if (!state.canSwitch) {
    throw new LtError(
      'MODE_SWITCH_BUSY',
      state.busyReason || 'Cannot switch Single/Team mode while session is executing',
      { modeState: state },
    );
  }

  let diskCorrupt = false;
  let existingRec = null;
  try {
    existingRec = readSessionModeRecord(baseRt.storageRoot, sessionId);
  } catch (err) {
    if (err?.code === 'SESSION_MODE_CORRUPT') diskCorrupt = true;
    else throw err;
  }

  let maxStoreSeq = Number.isInteger(existingRec?.lastTaskSeqHint) && existingRec.lastTaskSeqHint >= 1
    ? existingRec.lastTaskSeqHint
    : 1;
  if (TeamStore.exists(baseRt.storageRoot, sessionId)) {
    const storeForSeq = baseRt === runtime()
      ? teamStore(sessionId)
      : (baseRt.stores?.get?.(sessionId) ?? new TeamStore(baseRt.storageRoot, sessionId));
    maxStoreSeq = computeMaxRecordedStoreTaskSeq(storeForSeq, existingRec);
  }
  const taskSeqHint = Math.max(safeCurrentTaskSeq(ctx, sessionId), maxStoreSeq);

  if (state.mode === nextMode && !options.forcePersist && !diskCorrupt) {
    if (options.persistInitial === true) {
      const rec = writeSessionModeRecord(baseRt.storageRoot, sessionId, nextMode, {
        initial: true,
        source: options.source ?? 'create',
        actor: options.actor ?? options.source ?? 'user',
        taskSeqHint,
      });
      const { stateFile } = resolveSessionModePaths(baseRt.storageRoot, sessionId, { ensureDir: false });
      setBoundedModeCache(baseRt, sessionId, {
        storageRoot: baseRt.storageRoot,
        sig: modeFileSignature(stateFile),
        mode: rec.mode,
        record: rec,
      });
    }
    syncLeaderAgentMode(ctx, baseRt, sessionId);
    return {
      changed: false,
      previousMode: state.mode,
      modeState: inspectSessionModeState(ctx, baseRt, sessionId, options),
    };
  }

  const rec = writeSessionModeRecord(baseRt.storageRoot, sessionId, nextMode, {
    initial: Boolean(options.persistInitial),
    source: options.source ?? 'user',
    actor: options.actor ?? options.source ?? 'user',
    taskSeqHint,
  });
  const { stateFile } = resolveSessionModePaths(baseRt.storageRoot, sessionId, { ensureDir: false });
  setBoundedModeCache(baseRt, sessionId, {
    storageRoot: baseRt.storageRoot,
    sig: modeFileSignature(stateFile),
    mode: rec.mode,
    record: rec,
  });

  const liveActor = baseRt.actors?.get?.(sessionId) ?? null;
  const hostAgents = baseRt.hostAgents ?? getHostService(ctx, 'agents');
  const liveAgent = (liveActor?.role === 'leader' ? liveActor.agent : null) ?? hostAgents?.get?.(sessionId) ?? null;
  const hasLiveLeader = liveActor?.role === 'leader' || Boolean(liveAgent && isLeaderRoot(ctx, liveAgent));

  if (nextMode === 'team' && hasLiveLeader && !TeamStore.exists(baseRt.storageRoot, sessionId)) {
    const cwd = liveActor?.cwd ?? liveAgent?.session?.header?.cwd ?? null;
    const store = baseRt === runtime()
      ? teamStore(sessionId)
      : (baseRt.stores?.get?.(sessionId) ?? new TeamStore(baseRt.storageRoot, sessionId));
    store.ensure({ workspace: cwd, surface: baseRt.surface });
    try { baseRt.onLeaderSessionReady?.(ctx, sessionId, cwd); } catch {}
  }

  syncLeaderAgentMode(ctx, baseRt, sessionId);
  const updatedState = inspectSessionModeState(ctx, baseRt, sessionId, options);
  return {
    changed: state.mode !== nextMode,
    previousMode: state.mode,
    modeState: updatedState,
  };
}
