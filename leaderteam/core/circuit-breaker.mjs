// Multi-node anomaly circuit breaker for LeaderTeam agents (leader and execution members).
// Pure state reducer & judgment engine:
// - Normal single-turn `max-tokens` output continuations NEVER trip the circuit breaker when tool/artifact progress occurs.
// - Four distinct judgment nodes with high thresholds (calibrated so 85-90%+ of real tasks, including long multi-module builds, never trigger):
//   1. `zero_progress_truncations`: consecutive `max-tokens` turns with 0 succeeded tool calls in the turn.
//   2. `repeated_identical_failures`: consecutive failed/denied tool calls (accelerated when the exact failure signature repeats).
//   3. `stagnant_spin_steps`: consecutive read/status-only steps cycling over already-seen targets with zero file/test/workflow progress.
//   4. `consecutive_runtime_errors`: consecutive non-user-cancelled runtime errors (`turn/end` kind === "error").
// - Two-tier response:
//   * `soft`: DO NOT truncate and DO NOT pause the running chain; dispatch an asynchronous independent Investigator model call.
//   * `hard`: Pause the anomalous chain while preserving full context/files, consolidate state + Investigator diagnosis, and resume the original task.

export const CIRCUIT_NODES = Object.freeze([
  'zero_progress_truncations',
  'repeated_identical_failures',
  'stagnant_spin_steps',
  'consecutive_runtime_errors',
]);

export const DEFAULT_CIRCUIT_BREAKER_CONFIG = Object.freeze({
  enabled: true,
  investigatorRole: 'arbiter',
  firstOutputTimeoutMs: 120000,
  zeroProgressTruncationSoft: 5,
  zeroProgressTruncationHard: 10,
  repeatedFailureSoft: 8,
  repeatedFailureHard: 15,
  identicalSignatureSoft: 5,
  identicalSignatureHard: 9,
  stagnantSpinSoft: 40,
  stagnantSpinHard: 75,
  runtimeErrorSoft: 3,
  runtimeErrorHard: 6,
  cooldownMs: 30000,
  maxConsolidationsPerAgent: 2,
});

const READ_OR_STATUS_ONLY_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'list_agents',
  'team_status',
  'team_models',
  'team_concurrency',
  'job_list',
  'job_output',
  'team_tools',
  'team_skills',
]);

const RECOVERABLE_ONE_SHOT_RULES = new Set([
  'rule:tool-not-loaded',
  'rule:refs-unread',
  'rule:write-before-read',
]);

export function createAgentCircuitState(agentId, role = 'member') {
  return {
    agentId,
    role,
    zeroProgressTruncations: 0,
    totalTruncations: 0,
    consecutiveFailures: 0,
    identicalFailureSignature: null,
    identicalFailureCount: 0,
    stagnantSpinSteps: 0,
    seenSpinTargets: new Set(),
    spinRepeatHits: 0,
    consecutiveRuntimeErrors: 0,
    softInvestigations: 0,
    hardConsolidations: 0,
    benignHeadroomBonus: 0,
    inFlightInvestigation: false,
    lastInvestigatedNode: null,
    lastInvestigatedAtMs: 0,
    lastIncidentFingerprint: null,
    turnCompletedTools: [],
    activationCompletedTools: [],
  };
}

function effectiveThresholds(cfg = {}, state) {
  const c = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...(cfg ?? {}) };
  const bonus = state?.benignHeadroomBonus ?? 0;
  return {
    enabled: c.enabled !== false,
    investigatorRole: c.investigatorRole ?? 'arbiter',
    zeroProgressTruncationSoft: c.zeroProgressTruncationSoft + bonus * 3,
    zeroProgressTruncationHard: c.zeroProgressTruncationHard + bonus * 5,
    repeatedFailureSoft: c.repeatedFailureSoft + bonus * 4,
    repeatedFailureHard: c.repeatedFailureHard + bonus * 6,
    identicalSignatureSoft: c.identicalSignatureSoft + bonus * 3,
    identicalSignatureHard: c.identicalSignatureHard + bonus * 5,
    stagnantSpinSoft: c.stagnantSpinSoft + bonus * 20,
    stagnantSpinHard: c.stagnantSpinHard + bonus * 35,
    runtimeErrorSoft: c.runtimeErrorSoft + bonus,
    runtimeErrorHard: c.runtimeErrorHard + bonus * 2,
    cooldownMs: c.cooldownMs,
    maxConsolidationsPerAgent: c.maxConsolidationsPerAgent,
  };
}

function evaluateDecision(state, node, metric, softLimit, hardLimit, detail, cfg, nowMs = Date.now()) {
  const t = effectiveThresholds(cfg, state);
  if (!t.enabled) return { trigger: 'none', node: null };
  if (metric >= hardLimit) {
    const fp = `hard:${node}:${state.hardConsolidations}`;
    if ((state.inFlightInvestigation && state.inFlightTier === 'hard') || state.lastIncidentFingerprint === fp) {
      return { trigger: 'none', node };
    }
    return {
      trigger: 'hard',
      node,
      metric,
      softLimit,
      hardLimit,
      detail,
      fingerprint: fp,
      exhaustedConsolidations: state.hardConsolidations >= t.maxConsolidationsPerAgent,
    };
  }
  if (metric >= softLimit) {
    const fp = `soft:${node}:${state.hardConsolidations}:${Math.floor(metric / Math.max(1, softLimit))}`;
    const withinCooldown = state.lastInvestigatedNode === node && (nowMs - state.lastInvestigatedAtMs) < t.cooldownMs;
    if (state.inFlightInvestigation || withinCooldown || state.lastIncidentFingerprint === fp) {
      return { trigger: 'none', node };
    }
    return {
      trigger: 'soft',
      node,
      metric,
      softLimit,
      hardLimit,
      detail,
      fingerprint: fp,
      exhaustedConsolidations: false,
    };
  }
  return { trigger: 'none', node: null };
}

/** Record one tool execution result on an agent and evaluate circuit-breaker nodes 2 & 3. */
export function recordToolOutcomeInCircuit(state, {
  tool,
  targetSummary = '',
  ok,
  errorSignature = '',
  rule = '',
  hasActiveMembers = false,
  nowMs = Date.now(),
}, cfg = {}) {
  const t = effectiveThresholds(cfg, state);
  const summary = targetSummary ? `${tool}(${targetSummary})` : tool;

  if (ok) {
    state.turnCompletedTools.push(summary);
    if (state.activationCompletedTools.length < 200) {
      state.activationCompletedTools.push(summary);
    }
    state.zeroProgressTruncations = 0;
    state.consecutiveRuntimeErrors = 0;

    const isReadOnlySpinCandidate = READ_OR_STATUS_ONLY_TOOLS.has(tool)
      && !(tool === 'team_status' && targetSummary.includes('stop_state='));

    if (!isReadOnlySpinCandidate) {
      // Genuine mutating, shell, planning, discussion, or dispatch progress resets failure & spin counters.
      state.consecutiveFailures = 0;
      state.identicalFailureSignature = null;
      state.identicalFailureCount = 0;
      state.stagnantSpinSteps = 0;
      state.seenSpinTargets.clear();
      state.spinRepeatHits = 0;
      return { trigger: 'none', node: null };
    }

    // Read/status-only call: only count toward stagnant spin when no active child members are running.
    if (!hasActiveMembers) {
      state.stagnantSpinSteps++;
      if (state.seenSpinTargets.has(summary)) {
        state.spinRepeatHits++;
      } else {
        state.seenSpinTargets.add(summary);
      }
      // Require actual target repetition (>= 50% repeated targets or >= 12 repeat hits) so legitimate large-repo reading never trips!
      if (state.spinRepeatHits >= 12) {
        return evaluateDecision(
          state,
          'stagnant_spin_steps',
          state.stagnantSpinSteps,
          t.stagnantSpinSoft,
          t.stagnantSpinHard,
          `${state.stagnantSpinSteps} consecutive read/status-only calls (${state.spinRepeatHits} repeated targets) without mutating/workflow progress`,
          cfg,
          nowMs,
        );
      }
    }
    return { trigger: 'none', node: null };
  }

  // Tool failed or was denied:
  if (rule && RECOVERABLE_ONE_SHOT_RULES.has(rule) && state.identicalFailureSignature !== `${tool}:${rule}`) {
    state.identicalFailureSignature = `${tool}:${rule}`;
    state.identicalFailureCount = 1;
    return { trigger: 'none', node: null };
  }

  state.consecutiveFailures++;
  const sig = `${tool}:${rule || errorSignature || 'error'}`.slice(0, 240);
  if (state.identicalFailureSignature === sig) {
    state.identicalFailureCount++;
  } else {
    state.identicalFailureSignature = sig;
    state.identicalFailureCount = 1;
  }

  const byIdentical = evaluateDecision(
    state,
    'repeated_identical_failures',
    state.identicalFailureCount,
    t.identicalSignatureSoft,
    t.identicalSignatureHard,
    `${state.identicalFailureCount} consecutive identical failures on ${sig}`,
    cfg,
    nowMs,
  );
  if (byIdentical.trigger !== 'none') return byIdentical;

  return evaluateDecision(
    state,
    'repeated_identical_failures',
    state.consecutiveFailures,
    t.repeatedFailureSoft,
    t.repeatedFailureHard,
    `${state.consecutiveFailures} consecutive failed/denied tool calls (latest: ${sig})`,
    cfg,
    nowMs,
  );
}

/** Record a `turn/end` event (`max-tokens` | `error` | `completed`) and evaluate nodes 1 & 4. */
export function recordTurnEndInCircuit(state, {
  reasonKind,
  errorMessage = '',
  errorCode = '',
  nowMs = Date.now(),
}, cfg = {}) {
  const t = effectiveThresholds(cfg, state);
  const completedInTurn = [...state.turnCompletedTools];
  state.turnCompletedTools = [];

  if (reasonKind === 'max-tokens') {
    state.totalTruncations++;
    state.consecutiveRuntimeErrors = 0;
    if (completedInTurn.length > 0) {
      // Progress was made in this turn! Normal continuation — reset zero-progress truncation counter to 0.
      state.zeroProgressTruncations = 0;
      return {
        trigger: 'none',
        node: null,
        completedInTurn,
        zeroProgressTruncations: 0,
        totalTruncations: state.totalTruncations,
      };
    }
    state.zeroProgressTruncations++;
    const decision = evaluateDecision(
      state,
      'zero_progress_truncations',
      state.zeroProgressTruncations,
      t.zeroProgressTruncationSoft,
      t.zeroProgressTruncationHard,
      `${state.zeroProgressTruncations} consecutive max-tokens turns with 0 completed tool operations`,
      cfg,
      nowMs,
    );
    return {
      ...decision,
      completedInTurn,
      zeroProgressTruncations: state.zeroProgressTruncations,
      totalTruncations: state.totalTruncations,
    };
  }

  if (reasonKind === 'error') {
    const isQuotaOrTransient = /429|rate.?limit|quota|502|503|504|overloaded/i.test(`${errorCode} ${errorMessage}`);
    if (!isQuotaOrTransient) {
      state.consecutiveRuntimeErrors++;
      const decision = evaluateDecision(
        state,
        'consecutive_runtime_errors',
        state.consecutiveRuntimeErrors,
        t.runtimeErrorSoft,
        t.runtimeErrorHard,
        `${state.consecutiveRuntimeErrors} consecutive runtime error turns (${errorCode || 'ERROR'}: ${String(errorMessage).slice(0, 180)})`,
        cfg,
        nowMs,
      );
      return { ...decision, completedInTurn };
    }
    return { trigger: 'none', node: null, completedInTurn };
  }

  if (reasonKind === 'completed') {
    state.zeroProgressTruncations = 0;
    state.consecutiveRuntimeErrors = 0;
  }
  return { trigger: 'none', node: null, completedInTurn };
}

export function markInvestigationStarted(state, decision, nowMs = Date.now()) {
  state.inFlightInvestigation = true;
  state.inFlightTier = decision.trigger;
  state.lastInvestigatedNode = decision.node;
  state.lastInvestigatedAtMs = nowMs;
  state.lastIncidentFingerprint = decision.fingerprint;
  if (decision.trigger === 'hard') state.hardConsolidations++;
  else state.softInvestigations++;
}

export function markInvestigationFinished(state, verdict) {
  state.inFlightInvestigation = false;
  state.inFlightTier = null;
  if (!verdict) return;
  if (verdict.classification === 'benign_long_work' || verdict.action === 'continue_unchanged') {
    state.benignHeadroomBonus = Math.min(4, (state.benignHeadroomBonus ?? 0) + 1);
    state.zeroProgressTruncations = 0;
    state.stagnantSpinSteps = 0;
    state.spinRepeatHits = 0;
  } else if (verdict.tier === 'hard' && verdict.action !== 'escalate_to_leader_or_user') {
    // After hard pause + scene consolidation + resume, reset incident counters so the consolidated continuation gets a clean slate.
    state.zeroProgressTruncations = 0;
    state.consecutiveFailures = 0;
    state.identicalFailureSignature = null;
    state.identicalFailureCount = 0;
    state.stagnantSpinSteps = 0;
    state.seenSpinTargets.clear();
    state.spinRepeatHits = 0;
    state.consecutiveRuntimeErrors = 0;
  }
}
