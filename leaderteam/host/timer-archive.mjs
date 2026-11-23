// Host-side integration for the Engineering Timer & Fixed-External Plan Archive plugin (`leaderteam-timer-archive`).
import { LtError } from '../core/constants.mjs';
import {
  resolveNowMs,
  normalizeTimerState,
  advanceTimerActivity,
  recordTimerPlanSubmitted,
  recordTimerPlanSettled,
  recordTimerFallbackSelected,
  recordTimerDeliverySettled,
  computeTimerSnapshot,
  reviewTimerPayload,
} from '../core/timer.mjs';
import {
  resolvePlanArchiveRoot,
  PlanArchiveStore,
  rankCandidatePlans,
  buildBestPlanSelectionRequest,
  parseBestPlanSelection,
} from '../core/plan-archive.mjs';
import { replay } from '../core/agreement.mjs';
import { resolveModelTarget } from '../core/upstream-models.mjs';
import { quotaGate } from '../core/models.mjs';
import { readQuotaStateFile } from '../core/quota.mjs';
import { callRoleJson } from './llm.mjs';
import { roleRouteChain } from '../core/role-routes.mjs';
import { writeCurrentPlan } from '../core/current-plan.mjs';
import { runtime, teamStore, recordUsage, isPluginActive, effectiveRuntimeConfig, runtimeForTeam } from './runtime.mjs';
import { currentTaskSeq } from './roles.mjs';

export function ensurePlanArchive(rt = runtime(), workspaceRoot = null) {
  if (!isPluginActive(rt, 'timerArchive') || rt.config?.planArchive?.enabled === false) {
    return null;
  }
  const archiveRoot = resolvePlanArchiveRoot({
    config: rt.config,
    storageRoot: rt.storageRoot,
    workspaceRoot,
  });
  if (rt.planArchiveStore && rt.planArchiveStore.root === archiveRoot) {
    if (workspaceRoot) rt.planArchiveStore.assertSafeForWorkspace(workspaceRoot);
    return rt.planArchiveStore;
  }
  const store = new PlanArchiveStore(archiveRoot, { workspaceRoot });
  rt.planArchiveStore = store;
  return store;
}

function readPriorProjectSeeds(archiveStore, workspaceRoot, teamId) {
  if (!archiveStore || !workspaceRoot) return { seedProjectStartedAtMs: null, seedPriorActiveMs: 0 };
  const meta = archiveStore.readProjectMeta(workspaceRoot);
  if (!meta) return { seedProjectStartedAtMs: null, seedPriorActiveMs: 0 };
  const bySession = meta.teamActiveBySession ?? {};
  let otherActiveMs = 0;
  for (const [sid, ms] of Object.entries(bySession)) {
    if (sid !== teamId && typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      otherActiveMs += Math.trunc(ms);
    }
  }
  return {
    seedProjectStartedAtMs: meta.firstStartedAtMs ?? null,
    seedPriorActiveMs: otherActiveMs,
  };
}

export function ensureTeamTimerState(ctx, teamId, workspace = null, rt = runtime()) {
  if (!teamId || !rt.storageRoot || !rt.config) return null;
  const store = teamStore(teamId);
  const nowMs = resolveNowMs();
  const taskSeq = currentTaskSeq(ctx, teamId);
  const actorWs = workspace ?? rt.actors.get(teamId)?.cwd ?? null;
  let archive = null;
  try { archive = ensurePlanArchive(rt, actorWs); } catch {}
  const seeds = readPriorProjectSeeds(archive, actorWs, teamId);
  const existing = store.readTimerState();
  const normalized = normalizeTimerState(existing, {
    teamId,
    workspace: actorWs,
    taskSeq,
    nowMs,
    ...seeds,
  });
  if (!existing) {
    store.writeTimerState(normalized);
    if (archive && actorWs) {
      try { archive.touchProjectTimer({ workspaceRoot: actorWs, teamId, teamActiveMs: normalized.teamActiveMs, nowMs }); } catch {}
    }
  }
  return normalized;
}

export function touchTeamTimer(ctx, teamId, workspace = null, rt = runtime()) {
  if (!isPluginActive(rt, 'timerArchive') || !teamId || !rt.storageRoot || !rt.config) return null;
  const store = teamStore(teamId);
  const nowMs = resolveNowMs();
  const taskSeq = currentTaskSeq(ctx, teamId);
  const actorWs = workspace ?? rt.actors.get(teamId)?.cwd ?? null;
  const cur = ensureTeamTimerState(ctx, teamId, actorWs, rt);
  if (!cur) return null;
  const next = advanceTimerActivity(cur, {
    taskSeq,
    nowMs,
    idleGapCapMs: rt.config.timer?.idleGapCapMs,
    workspace: actorWs ?? undefined,
  });
  store.writeTimerState(next);
  try {
    const archive = ensurePlanArchive(rt, actorWs);
    if (archive && actorWs) {
      archive.touchProjectTimer({ workspaceRoot: actorWs, teamId, teamActiveMs: next.teamActiveMs, nowMs });
    }
  } catch {}
  return next;
}

export function getTeamTimerSnapshot(ctx, teamId, workspace = null, rt = runtime()) {
  if (!isPluginActive(rt, 'timerArchive') || !teamId || !rt.storageRoot || !rt.config) return null;
  const actorWs = workspace ?? rt.actors.get(teamId)?.cwd ?? null;
  const state = ensureTeamTimerState(ctx, teamId, actorWs, rt);
  if (!state) return null;
  const taskSeq = currentTaskSeq(ctx, teamId);
  return computeTimerSnapshot(state, rt.config, { taskSeq, nowMs: resolveNowMs() });
}

export function getReviewTimerPayload(ctx, teamId, workspace = null, { pendingPlanAttempt = false } = {}, rt = runtime()) {
  const snap = getTeamTimerSnapshot(ctx, teamId, workspace, rt);
  return snap ? reviewTimerPayload(snap, { pendingPlanAttempt }) : null;
}

export function formatLeaderTimerContext(ctx, teamId, workspace = null, rt = runtime()) {
  if (!isPluginActive(rt, 'timerArchive') || !teamId || !rt.storageRoot || !rt.config) return '';
  try {
    const snap = getTeamTimerSnapshot(ctx, teamId, workspace, rt);
    if (!snap) return '';
    const archive = ensurePlanArchive(rt, workspace ?? rt.actors.get(teamId)?.cwd ?? null);
    const fallbackHint = snap.stagnation_fallback_eligible
      ? ' | STAGNATION THRESHOLD MET: call team_plan_archive(action="select_best") to pick the best candidate plan and execute'
      : '';
    return [
      `LeaderTeam engineering timer & external plan archive:`,
      `- Planning pressure: ${snap.time_pressure}, plan_attempts=${snap.plan_attempts} (unapproved=${snap.unapproved_plan_attempts})${snap.executable_plan_id ? `, active_plan=${snap.executable_plan_id} (${snap.execution_mode})` : ''}${fallbackHint}`,
      ...(archive ? [`- Archive root (fixed external): ${archive.root}`] : []),
    ].join('\n');
  } catch {
    return '';
  }
}

export function recordArchivedPlanSubmitted(ctx, {
  rt = runtime(),
  teamId,
  taskSeq,
  workspace,
  agreementId,
  topic,
  proposal,
  userRequest,
  evidenceSummary = '',
  revises = null,
  explicitCategory = null,
}) {
  if (!isPluginActive(rt, 'timerArchive')) return null;
  const nowMs = resolveNowMs();
  const store = teamStore(teamId);
  const curTimer = ensureTeamTimerState(ctx, teamId, workspace, rt);
  let timerSnap = null;
  if (curTimer) {
    const updatedTimer = recordTimerPlanSubmitted(curTimer, {
      taskSeq,
      nowMs,
      idleGapCapMs: rt.config.timer?.idleGapCapMs,
    });
    store.writeTimerState(updatedTimer);
    timerSnap = computeTimerSnapshot(updatedTimer, rt.config, { taskSeq, nowMs });
  }
  const archive = ensurePlanArchive(rt, workspace);
  if (!archive) return null;
  archive.touchProjectTimer({ workspaceRoot: workspace, teamId, teamActiveMs: curTimer?.teamActiveMs ?? 0, nowMs });
  return archive.archivePlanSubmission({
    agreementId,
    teamId,
    taskSeq,
    workspace,
    topic,
    proposal,
    userRequest,
    evidenceSummary,
    revises,
    explicitCategory,
    timerSnapshot: timerSnap,
    nowMs,
  });
}

export function recordArchivedPlanSettled(ctx, {
  rt = runtime(),
  teamId,
  taskSeq,
  workspace,
  agreementId,
  state,
}) {
  if (!isPluginActive(rt, 'timerArchive') || !state?.outcome) return null;
  const nowMs = resolveNowMs();
  const store = teamStore(teamId);
  const curTimer = ensureTeamTimerState(ctx, teamId, workspace, rt);
  if (curTimer) {
    const updated = recordTimerPlanSettled(curTimer, {
      taskSeq,
      planId: agreementId,
      decision: state.outcome.decision,
      nowMs,
      idleGapCapMs: rt.config.timer?.idleGapCapMs,
    });
    store.writeTimerState(updated);
  }
  const archive = ensurePlanArchive(rt, workspace);
  if (!archive) return null;
  return archive.recordPlanReviewSettlement(agreementId, state, { nowMs });
}

export function recordArchivedMemberDispatched({
  rt = runtime(),
  workspace,
  planId,
  memberSummary,
}) {
  if (!isPluginActive(rt, 'timerArchive') || !planId) return null;
  try {
    const archive = ensurePlanArchive(rt, workspace);
    return archive ? archive.recordMemberLinked(planId, memberSummary, { nowMs: resolveNowMs() }) : null;
  } catch {
    return null;
  }
}

export function syncArchivedMemberStatuses(teamId, taskSeq, rt = runtime()) {
  if (!isPluginActive(rt, 'timerArchive') || !teamId || !rt.storageRoot) return;
  try {
    const workspace = rt.actors.get(teamId)?.cwd ?? null;
    const archive = ensurePlanArchive(rt, workspace);
    if (archive) {
      archive.syncTeamExecutionOutcomes(teamId, taskSeq, teamStore(teamId), { nowMs: resolveNowMs() });
    }
  } catch {}
}

export function recordArchivedDeliverySettled(ctx, {
  rt = runtime(),
  teamId,
  taskSeq,
  workspace,
  deliveryAgreementId,
  outcome,
}) {
  if (!isPluginActive(rt, 'timerArchive') || !outcome) return;
  const nowMs = resolveNowMs();
  const store = teamStore(teamId);
  const curTimer = ensureTeamTimerState(ctx, teamId, workspace, rt);
  if (curTimer) {
    const updated = recordTimerDeliverySettled(curTimer, {
      taskSeq,
      decision: outcome.decision,
      nowMs,
      idleGapCapMs: rt.config.timer?.idleGapCapMs,
    });
    store.writeTimerState(updated);
  }
  try {
    const archive = ensurePlanArchive(rt, workspace);
    if (archive) {
      archive.syncTeamExecutionOutcomes(teamId, taskSeq, store, { nowMs });
      archive.recordDeliveryOutcome({ teamId, taskSeq, deliveryAgreementId, outcome, nowMs });
    }
  } catch {}
}

function hydrateMissingTaskPlansIntoArchive(archive, store, teamId, taskSeq, workspace) {
  for (const id of store.agreementIds()) {
    try {
      const s = replay(store.agreementEvents(id));
      if (s.kind !== 'plan' || (s.taskSeq ?? 1) !== taskSeq) continue;
      if (!archive.resolvePlan(id)) {
        let savedInput = {};
        try { savedInput = store.loadAgreementInput(id); } catch {}
        archive.archivePlanSubmission({
          agreementId: id,
          teamId,
          taskSeq,
          workspace,
          topic: s.topic,
          proposal: savedInput.proposal ?? '',
          userRequest: savedInput.userRequest ?? '',
          revises: s.revises,
        });
        if (s.status === 'settled') {
          archive.recordPlanReviewSettlement(id, s);
        }
      }
    } catch {}
  }
}

/**
 * Execute anti-stagnation best-plan selection when repeated plan submissions were turned back
 * and engineering stagnation exceeded `timer.stagnationAfterMs`.
 */
export async function selectBestFallbackPlan({
  ctx,
  rt = runtime(),
  teamId,
  taskSeq,
  workspace,
  userRequest = '',
  signal,
}) {
  if (!isPluginActive(rt, 'timerArchive') || rt.config?.planArchive?.enabled === false) {
    throw new LtError('PLUGIN_DISABLED', 'leaderteam-timer-archive plugin is disabled');
  }
  const cfg = rt.config;
  const store = teamStore(teamId);
  const archive = ensurePlanArchive(rt, workspace);
  if (!archive) {
    throw new LtError('PLAN_ARCHIVE_UNAVAILABLE', 'external plan archive is unavailable');
  }
  hydrateMissingTaskPlansIntoArchive(archive, store, teamId, taskSeq, workspace);

  // If a fallback selection already exists for this taskSeq, return it idempotently.
  const existingSelection = store.stagnationSelections().find(s => (s.taskSeq ?? 1) === taskSeq);
  if (existingSelection) {
    const existingPlan = archive.resolvePlan(existingSelection.selectedPlanId);
    return {
      alreadySelected: true,
      selectedPlanId: existingSelection.selectedPlanId,
      by: existingSelection.by,
      rationale: existingSelection.rationale,
      executionGuardrails: existingSelection.executionGuardrails ?? [],
      plan: existingPlan,
    };
  }

  const timerSnap = getTeamTimerSnapshot(ctx, teamId, workspace, rt);
  const minUnapproved = cfg.planArchive?.minUnapprovedPlansForFallback ?? 3;
  const unapprovedCount = timerSnap?.unapproved_plan_attempts ?? 0;
  const stagMs = timerSnap?.planning_stagnation_ms ?? 0;
  const thresholdMs = cfg.timer?.stagnationAfterMs ?? (20 * 60 * 1000);

  if (!(unapprovedCount >= minUnapproved && stagMs >= thresholdMs) && unapprovedCount < 6) {
    throw new LtError(
      'STAGNATION_NOT_ELIGIBLE',
      `anti-stagnation best-plan fallback requires >= ${minUnapproved} unapproved plan attempts (current: ${unapprovedCount}) AND planning stagnation >= ${thresholdMs}ms (current: ${stagMs}ms). Revise the plan and call team_discuss normally.`,
    );
  }

  const summaries = archive.listPlans({ teamId, taskSeq, limit: 50 });
  const fullPlans = summaries.map(s => archive.getPlan(s.planId)).filter(Boolean);
  const ranked = rankCandidatePlans(fullPlans);
  const viable = ranked.filter(r => r.viableForFallback);
  if (viable.length === 0) {
    throw new LtError(
      'STAGNATION_NO_VIABLE_PLAN',
      'all submitted candidate plans for this task were unanimously rejected for blocking safety/correctness defects; none can be auto-promoted. Submit a safe, requirement-compliant plan.',
    );
  }

  if (!rt.llm) throw new LtError('ARBITER_UNAVAILABLE', 'independent arbitration unavailable; ask the user rather than choosing a plan by score');
  const qRes = readQuotaStateFile(cfg.quota.stateFile);
  const req = buildBestPlanSelectionRequest({ userRequest, timerSnapshot: timerSnap, rankedCandidates: viable });
  const current = rt.actors.get(teamId)?.agent?.model?.current?.();
  const chain = roleRouteChain(cfg, 'arbiter', current);
  const r = await callRoleJson(rt.llm, chain, { system: req.system, user: req.user, signal },
    text => parseBestPlanSelection(text, viable.map(v => v.planId)), {
      skip: t => { const g = quotaGate(cfg, qRes.ok ? qRes.state : null, t.route, new Date()); return g.allowed ? null : g.error; },
      onAttempt: (t,a) => recordUsage(teamId, { role:'arbiter',route:t.route,effort:t.effort,ok:a.ok,attempts:a.attempts,kind:'stagnation-select',usage:a.usage??null,...(t.degraded ? {degraded:true,via:t.via}: {}) }),
    });
  if (!r.ok) throw new LtError('ARBITER_UNAVAILABLE', 'independent arbitration unavailable: '+r.error.message+'; ask the user');
  const selectedPlanId = r.verdict.selectedPlanId;
  const by = 'arbiter';
  const rationale = r.verdict.rationale;
  const chosen = viable.find(v => v.planId === selectedPlanId).plan;
  const executionGuardrails = [...new Set([...(chosen.outcome?.requiredChanges ?? []), ...(chosen.outcome?.conditions ?? []), ...r.verdict.executionGuardrails])];
  const nowMs = resolveNowMs();
  const updatedPlan = archive.markFallbackSelected(selectedPlanId, {
    by,
    rationale,
    executionGuardrails,
    nowMs,
  });
  writeCurrentPlan(rt.storageRoot,teamId,taskSeq,chosen.proposal + (executionGuardrails.length ? '\n\nExecution conditions:\n'+executionGuardrails.map(x=>'- '+x).join('\n') : ''));
  store.appendStagnationSelection({
    taskSeq,
    selectedPlanId,
    agreementId: updatedPlan?.agreementId ?? selectedPlanId,
    by,
    rationale,
    executionGuardrails,
    ...(r.target?.degraded ? { degraded: true, via: r.target.via, route: r.target.route } : { route: r.target?.route }),
    unapprovedCount,
    planningStagnationMs: stagMs,
  });
  const curTimer = ensureTeamTimerState(ctx, teamId, workspace, rt);
  if (curTimer) {
    store.writeTimerState(recordTimerFallbackSelected(curTimer, { taskSeq, planId: selectedPlanId, nowMs, idleGapCapMs: cfg.timer?.idleGapCapMs }));
  }

  return {
    alreadySelected: false,
    selectedPlanId,
    agreementId: updatedPlan?.agreementId ?? selectedPlanId,
    by,
    rationale,
    executionGuardrails,
    rankedCandidates: ranked.map(({ plan: _p, ...rest }) => rest),
    plan: updatedPlan,
  };
}
