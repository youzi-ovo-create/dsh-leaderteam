// Persistent project and task elapsed-time tracker for engineering review and stagnation prevention.
import fs from 'node:fs';

export const DEFAULT_TIMER_CONFIG = Object.freeze({
  elevatedAfterMs: 10 * 60 * 1000,   // 10 min planning stagnation -> elevated time pressure
  stagnationAfterMs: 20 * 60 * 1000, // 20 min planning stagnation -> critical pressure & fallback-eligible
  idleGapCapMs: 5 * 60 * 1000,       // cap single idle gaps to 5 min when accumulating active time
});

/**
 * Resolve current epoch ms, supporting injected clocks in unit tests and optional
 * `LEADERTEAM_CLOCK_FILE` (`{"nowMs":...}` or `{"offsetMs":...}`) in subprocess integration tests.
 */
export function resolveNowMs(customNowMs) {
  if (typeof customNowMs === 'number' && Number.isFinite(customNowMs)) {
    return Math.trunc(customNowMs);
  }
  if (process.env.LT_TIMER_NOW_MS !== undefined) {
    const envNow = Number(process.env.LT_TIMER_NOW_MS);
    if (Number.isFinite(envNow) && envNow > 0) return Math.trunc(envNow);
  }
  const clockFile = process.env.LEADERTEAM_CLOCK_FILE;
  if (clockFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(clockFile, 'utf8'));
      if (typeof raw?.nowMs === 'number' && Number.isFinite(raw.nowMs)) {
        return Math.trunc(raw.nowMs);
      }
      if (typeof raw?.offsetMs === 'number' && Number.isFinite(raw.offsetMs)) {
        return Date.now() + Math.trunc(raw.offsetMs);
      }
    } catch {}
  }
  return Date.now();
}

export function formatElapsedDuration(ms) {
  const clamped = Math.max(0, Math.trunc(Number(ms) || 0));
  const totalSec = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function createTaskTimerEntry(taskSeq, nowMs) {
  return {
    taskSeq,
    startedAtMs: nowMs,
    lastActivityAtMs: nowMs,
    activeMs: 0,
    planningStartedAtMs: nowMs,
    planSettledForExecutionAtMs: null,
    selectedPlanId: null,
    selectionMode: null, // 'approved' | 'stagnation_best_fallback'
    deliveredAtMs: null,
    planAttempts: 0,
    unapprovedPlanAttempts: 0,
    settledPlanIds: [],
  };
}

export function createInitialTimerState({
  teamId,
  workspace = null,
  taskSeq = 1,
  nowMs = resolveNowMs(),
  seedProjectStartedAtMs = null,
  seedPriorActiveMs = 0,
} = {}) {
  const seq = Number.isInteger(taskSeq) && taskSeq >= 1 ? taskSeq : 1;
  const projectStartedAtMs = (typeof seedProjectStartedAtMs === 'number' && Number.isFinite(seedProjectStartedAtMs) && seedProjectStartedAtMs > 0)
    ? Math.min(Math.trunc(seedProjectStartedAtMs), nowMs)
    : nowMs;
  const priorSessionsActiveMs = (typeof seedPriorActiveMs === 'number' && Number.isFinite(seedPriorActiveMs) && seedPriorActiveMs > 0)
    ? Math.trunc(seedPriorActiveMs)
    : 0;
  return {
    v: 1,
    teamId: String(teamId ?? 'team'),
    workspace: typeof workspace === 'string' ? workspace : null,
    projectStartedAtMs,
    priorSessionsActiveMs,
    teamStartedAtMs: nowMs,
    teamActiveMs: 0,
    lastActivityAtMs: nowMs,
    currentTaskSeq: seq,
    tasks: {
      [String(seq)]: createTaskTimerEntry(seq, nowMs),
    },
  };
}

export function normalizeTimerState(raw, fallback = {}) {
  const nowMs = fallback.nowMs ?? resolveNowMs();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createInitialTimerState({ ...fallback, nowMs });
  }
  const base = createInitialTimerState({
    teamId: raw.teamId ?? fallback.teamId,
    workspace: raw.workspace ?? fallback.workspace ?? null,
    taskSeq: raw.currentTaskSeq ?? fallback.taskSeq ?? 1,
    nowMs,
    seedProjectStartedAtMs: raw.projectStartedAtMs ?? fallback.seedProjectStartedAtMs,
    seedPriorActiveMs: raw.priorSessionsActiveMs ?? fallback.seedPriorActiveMs,
  });
  if (typeof raw.teamStartedAtMs === 'number' && Number.isFinite(raw.teamStartedAtMs)) {
    base.teamStartedAtMs = Math.trunc(raw.teamStartedAtMs);
  }
  if (typeof raw.projectStartedAtMs === 'number' && Number.isFinite(raw.projectStartedAtMs)) {
    base.projectStartedAtMs = Math.min(Math.trunc(raw.projectStartedAtMs), base.teamStartedAtMs);
  }
  if (typeof fallback.seedProjectStartedAtMs === 'number' && Number.isFinite(fallback.seedProjectStartedAtMs) && fallback.seedProjectStartedAtMs > 0) {
    base.projectStartedAtMs = Math.min(base.projectStartedAtMs, Math.trunc(fallback.seedProjectStartedAtMs));
  }
  if (typeof raw.priorSessionsActiveMs === 'number' && Number.isFinite(raw.priorSessionsActiveMs) && raw.priorSessionsActiveMs >= 0) {
    base.priorSessionsActiveMs = Math.max(base.priorSessionsActiveMs, Math.trunc(raw.priorSessionsActiveMs));
  }
  if (typeof raw.teamActiveMs === 'number' && Number.isFinite(raw.teamActiveMs) && raw.teamActiveMs >= 0) {
    base.teamActiveMs = Math.trunc(raw.teamActiveMs);
  }
  if (typeof raw.lastActivityAtMs === 'number' && Number.isFinite(raw.lastActivityAtMs)) {
    base.lastActivityAtMs = Math.trunc(raw.lastActivityAtMs);
  }
  if (raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks)) {
    base.tasks = {};
    for (const [k, v] of Object.entries(raw.tasks)) {
      const seq = Number.parseInt(k, 10);
      if (!Number.isInteger(seq) || seq < 1 || !v || typeof v !== 'object') continue;
      base.tasks[String(seq)] = {
        taskSeq: seq,
        startedAtMs: typeof v.startedAtMs === 'number' ? Math.trunc(v.startedAtMs) : base.teamStartedAtMs,
        lastActivityAtMs: typeof v.lastActivityAtMs === 'number' ? Math.trunc(v.lastActivityAtMs) : base.lastActivityAtMs,
        activeMs: typeof v.activeMs === 'number' && v.activeMs >= 0 ? Math.trunc(v.activeMs) : 0,
        planningStartedAtMs: typeof v.planningStartedAtMs === 'number' ? Math.trunc(v.planningStartedAtMs) : (typeof v.startedAtMs === 'number' ? Math.trunc(v.startedAtMs) : base.teamStartedAtMs),
        planSettledForExecutionAtMs: typeof v.planSettledForExecutionAtMs === 'number' ? Math.trunc(v.planSettledForExecutionAtMs) : null,
        selectedPlanId: typeof v.selectedPlanId === 'string' ? v.selectedPlanId : null,
        selectionMode: v.selectionMode === 'approved' || v.selectionMode === 'stagnation_best_fallback' ? v.selectionMode : null,
        deliveredAtMs: typeof v.deliveredAtMs === 'number' ? Math.trunc(v.deliveredAtMs) : null,
        planAttempts: Number.isInteger(v.planAttempts) && v.planAttempts >= 0 ? v.planAttempts : 0,
        unapprovedPlanAttempts: Number.isInteger(v.unapprovedPlanAttempts) && v.unapprovedPlanAttempts >= 0 ? v.unapprovedPlanAttempts : 0,
        settledPlanIds: Array.isArray(v.settledPlanIds)
          ? [...new Set(v.settledPlanIds.filter(id => typeof id === 'string' && id.length > 0))]
          : [],
      };
    }
  }
  const curKey = String(base.currentTaskSeq);
  if (!base.tasks[curKey]) {
    base.tasks[curKey] = createTaskTimerEntry(base.currentTaskSeq, nowMs);
  }
  return base;
}

export function advanceTimerActivity(state, {
  taskSeq = state.currentTaskSeq,
  nowMs = resolveNowMs(),
  idleGapCapMs = DEFAULT_TIMER_CONFIG.idleGapCapMs,
  workspace = undefined,
} = {}) {
  const seq = Number.isInteger(taskSeq) && taskSeq >= 1 ? taskSeq : 1;
  const next = structuredClone(state);
  if (typeof workspace === 'string' && workspace.trim() !== '') next.workspace = workspace;
  const cap = Math.max(10, Math.trunc(idleGapCapMs ?? DEFAULT_TIMER_CONFIG.idleGapCapMs));
  const globalDelta = Math.max(0, nowMs - (next.lastActivityAtMs ?? nowMs));
  const activeAdd = Math.min(globalDelta, cap);
  next.teamActiveMs = (next.teamActiveMs ?? 0) + activeAdd;
  next.lastActivityAtMs = Math.max(next.lastActivityAtMs ?? nowMs, nowMs);
  next.currentTaskSeq = seq;

  const key = String(seq);
  if (!next.tasks[key]) {
    next.tasks[key] = createTaskTimerEntry(seq, nowMs);
  } else {
    const t = next.tasks[key];
    const taskDelta = Math.max(0, nowMs - (t.lastActivityAtMs ?? nowMs));
    t.activeMs = (t.activeMs ?? 0) + Math.min(taskDelta, cap);
    t.lastActivityAtMs = Math.max(t.lastActivityAtMs ?? nowMs, nowMs);
  }
  return next;
}

export function recordTimerPlanSubmitted(state, { taskSeq, nowMs = resolveNowMs(), idleGapCapMs } = {}) {
  const next = advanceTimerActivity(state, { taskSeq, nowMs, idleGapCapMs });
  const t = next.tasks[String(next.currentTaskSeq)];
  t.planAttempts = (t.planAttempts ?? 0) + 1;
  return next;
}

export function recordTimerPlanSettled(state, {
  taskSeq,
  planId,
  decision,
  nowMs = resolveNowMs(),
  idleGapCapMs,
} = {}) {
  const next = advanceTimerActivity(state, { taskSeq, nowMs, idleGapCapMs });
  const t = next.tasks[String(next.currentTaskSeq)];
  t.settledPlanIds ??= [];
  if (t.settledPlanIds.includes(planId)) return next;
  t.settledPlanIds.push(planId);
  if (decision === 'approve') {
    t.planSettledForExecutionAtMs ??= nowMs;
    t.selectedPlanId = planId;
    t.selectionMode = 'approved';
  } else {
    t.unapprovedPlanAttempts = (t.unapprovedPlanAttempts ?? 0) + 1;
  }
  return next;
}

export function recordTimerFallbackSelected(state, {
  taskSeq,
  planId,
  nowMs = resolveNowMs(),
  idleGapCapMs,
} = {}) {
  const next = advanceTimerActivity(state, { taskSeq, nowMs, idleGapCapMs });
  const t = next.tasks[String(next.currentTaskSeq)];
  t.planSettledForExecutionAtMs ??= nowMs;
  t.selectedPlanId = planId;
  t.selectionMode = 'stagnation_best_fallback';
  return next;
}

export function recordTimerDeliverySettled(state, {
  taskSeq,
  decision,
  nowMs = resolveNowMs(),
  idleGapCapMs,
} = {}) {
  const next = advanceTimerActivity(state, { taskSeq, nowMs, idleGapCapMs });
  const t = next.tasks[String(next.currentTaskSeq)];
  if (decision === 'approve') {
    t.deliveredAtMs ??= nowMs;
  }
  return next;
}

export function computeTimerSnapshot(state, config = {}, {
  taskSeq = state?.currentTaskSeq ?? 1,
  nowMs = resolveNowMs(),
} = {}) {
  const timerCfg = { ...DEFAULT_TIMER_CONFIG, ...(config?.timer ?? {}) };
  const minUnapproved = config?.planArchive?.minUnapprovedPlansForFallback ?? 3;
  const seq = Number.isInteger(taskSeq) && taskSeq >= 1 ? taskSeq : 1;
  const s = normalizeTimerState(state, { taskSeq: seq, nowMs });
  const task = s.tasks[String(seq)] ?? createTaskTimerEntry(seq, nowMs);

  const cap = Math.max(10, Math.trunc(timerCfg.idleGapCapMs));
  const pendingTeamActive = Math.min(Math.max(0, nowMs - s.lastActivityAtMs), cap);
  const pendingTaskActive = Math.min(Math.max(0, nowMs - task.lastActivityAtMs), cap);

  const projectWallElapsedMs = Math.max(0, nowMs - s.projectStartedAtMs);
  const teamActiveElapsedMs = s.teamActiveMs + pendingTeamActive;
  const projectActiveElapsedMs = s.priorSessionsActiveMs + teamActiveElapsedMs;
  const teamWallElapsedMs = Math.max(0, nowMs - s.teamStartedAtMs);
  const taskWallElapsedMs = Math.max(0, nowMs - task.startedAtMs);
  const taskActiveElapsedMs = task.activeMs + pendingTaskActive;

  const planSettledAt = task.planSettledForExecutionAtMs;
  const planningStagnationMs = planSettledAt === null
    ? Math.max(0, nowMs - task.planningStartedAtMs)
    : Math.max(0, planSettledAt - task.planningStartedAtMs);
  const executionElapsedMs = planSettledAt === null
    ? 0
    : Math.max(0, (task.deliveredAtMs ?? nowMs) - planSettledAt);

  let timePressure = 'normal';
  if (planSettledAt === null) {
    if (planningStagnationMs >= timerCfg.stagnationAfterMs) {
      timePressure = 'critical';
    } else if (planningStagnationMs >= timerCfg.elevatedAfterMs || task.unapprovedPlanAttempts >= 2) {
      timePressure = 'elevated';
    }
  } else if (taskWallElapsedMs >= timerCfg.stagnationAfterMs * 2) {
    timePressure = 'critical';
  } else if (taskWallElapsedMs >= timerCfg.stagnationAfterMs) {
    timePressure = 'elevated';
  }

  const stagnationFallbackEligible = planSettledAt === null
    && ((task.unapprovedPlanAttempts >= minUnapproved && planningStagnationMs >= timerCfg.stagnationAfterMs) || task.unapprovedPlanAttempts >= 6);

  return {
    now_iso: new Date(nowMs).toISOString(),
    now_ms: nowMs,
    project_started_at: new Date(s.projectStartedAtMs).toISOString(),
    project_wall_ms: projectWallElapsedMs,
    project_wall_elapsed_ms: projectWallElapsedMs,
    project_active_ms: projectActiveElapsedMs,
    project_active_elapsed_ms: projectActiveElapsedMs,
    team_wall_elapsed_ms: teamWallElapsedMs,
    team_active_elapsed_ms: teamActiveElapsedMs,
    task_seq: seq,
    task_started_at: new Date(task.startedAtMs).toISOString(),
    task_wall_elapsed_ms: taskWallElapsedMs,
    task_active_elapsed_ms: taskActiveElapsedMs,
    planning_started_at: new Date(task.planningStartedAtMs).toISOString(),
    planning_stagnation_ms: planningStagnationMs,
    execution_elapsed_ms: executionElapsedMs,
    plan_attempts: task.planAttempts,
    unapproved_plan_attempts: task.unapprovedPlanAttempts,
    executable_plan_id: task.selectedPlanId,
    execution_mode: task.selectionMode,
    time_pressure: timePressure,
    elevated_threshold_ms: timerCfg.elevatedAfterMs,
    stagnation_threshold_ms: timerCfg.stagnationAfterMs,
    min_unapproved_for_fallback: minUnapproved,
    stagnation_fallback_eligible: stagnationFallbackEligible,
    summary: `project=${formatElapsedDuration(projectWallElapsedMs)} (active ${formatElapsedDuration(projectActiveElapsedMs)}), task#${seq}=${formatElapsedDuration(taskWallElapsedMs)}, planning=${formatElapsedDuration(planningStagnationMs)} [${timePressure}]`,
  };
}

/** Compact payload embedded into reviewer and arbiter LLM requests (`project_timer`). */
export function reviewTimerPayload(snap, { pendingPlanAttempt = false } = {}) {
  if (!snap) return null;
  const directive = snap.time_pressure === 'critical'
    ? 'CRITICAL TIME PRESSURE: Planning stagnation exceeded threshold. Block ONLY for concrete correctness, security, data-loss, or explicit requirement violations; never issue conservative blanket refusals or nitpick optional polish.'
    : snap.time_pressure === 'elevated'
      ? 'ELEVATED TIME PRESSURE: Elapsed time or prior unapproved rounds are accumulating. Judge strictly against requirements and provide concrete actionable solutions.'
      : 'NORMAL TIME PRESSURE: Weigh engineering progress fairly; never issue bare refusals without concrete technical grounds and actionable suggestions.';
  return {
    project_wall_ms: snap.project_wall_elapsed_ms,
    project_wall_elapsed_ms: snap.project_wall_elapsed_ms,
    project_active_elapsed_ms: snap.project_active_elapsed_ms,
    task_wall_elapsed_ms: snap.task_wall_elapsed_ms,
    task_active_elapsed_ms: snap.task_active_elapsed_ms,
    planning_stagnation_ms: snap.planning_stagnation_ms,
    plan_attempts: pendingPlanAttempt ? Math.max(1, snap.plan_attempts) : snap.plan_attempts,
    prior_unapproved_attempts: snap.unapproved_plan_attempts,
    time_pressure: snap.time_pressure,
    stagnation_threshold_ms: snap.stagnation_threshold_ms,
    directive,
  };
}
