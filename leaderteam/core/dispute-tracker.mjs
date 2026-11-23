// Event–Behavior–Chain dispute identity, auxiliary evidence snapshot, and Strike-3 human escalation.
// Constitutional principle (§一 & §5):
//   - EVENT (`eventId`) and ACTUAL BEHAVIOR (`behaviorIdentity`) are the sole primary subjects of dispute attribution.
//   - File SHA-256 hashes and execution records (`evidenceSnapshot`) are strictly AUXILIARY EVIDENCE to help verify
//     whether behavior substantively changed — they NEVER automatically reset or determine `strikeCount` on their own.
//   - Stage 4 post-conference re-objections strictly stay on their parent `disputeChainId` regardless of collateral file edits.
// Pure module.
import { createHash } from 'node:crypto';
import { hashJson } from './canonical.mjs';
import { normalizeGlob, anyGlobOverlaps, matchesAnyGlob } from './paths.mjs';
import { truncate } from './redact.mjs';

function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function normalizeTextToken(raw, maxLen = 2000) {
  return truncate(String(raw ?? '').replace(/\s+/g, ' ').trim(), maxLen);
}

/** Normalize target globs or workspace-relative file paths into canonical sorted targets. Pure. */
export function normalizeDisputeTargets(rawTargets = []) {
  const cleaned = [];
  for (const raw of Array.isArray(rawTargets) ? rawTargets : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      cleaned.push(normalizeGlob(raw.trim()));
    } catch {
      cleaned.push(raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
    }
  }
  return [...new Set(cleaned.filter(Boolean))].sort();
}

/**
 * True when two target sets represent the same concrete workspace event scope
 * (resistant to stage renaming, member renaming, or splitting/repackaging the same file scope). Pure.
 */
export function disputeTargetsMatch(targetsA, targetsB, platform = process.platform) {
  const a = normalizeDisputeTargets(targetsA);
  const b = normalizeDisputeTargets(targetsB);
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  if (hashJson(a) === hashJson(b)) return true;
  return anyGlobOverlaps(a, b, platform);
}

/**
 * Resolve the canonical target anchor for an engineering event.
 * When a stage has a broad scope (e.g. `src/**`) and reviewers pinpoint specific target files (`src/lexer.mjs`),
 * narrowing the event anchor to those pinpointed files keeps unrelated modules (`src/vm.mjs`) as distinct events
 * while keeping repeated objections on `src/lexer.mjs` (even if stages/members are renamed) on the SAME event. Pure.
 */
export function resolveEventAnchorTargets({ targets = [], reviewerTargets = [], platform = process.platform } = {}) {
  const normTargets = normalizeDisputeTargets(targets);
  const normRev = normalizeDisputeTargets(reviewerTargets);
  if (normRev.length === 0) return normTargets;
  const isSyntheticTarget = normTargets.length === 0 || normTargets.every(t => t.startsWith('kind:') || t.startsWith('profile:'));
  if (isSyntheticTarget) return normRev;
  const overlappingRev = normRev.filter(r => matchesAnyGlob(r, normTargets, platform) || anyGlobOverlaps([r], normTargets, platform));
  return overlappingRev.length > 0 ? overlappingRev : normTargets;
}

/** Compute deterministic Event ID (`evt-...`) for a concrete engineering event. Pure. */
export function computeEventId({
  taskSeq = 1,
  phaseKind = 'execution',
  targets = [],
  reviewerTargets = [],
  platform = process.platform,
} = {}) {
  const canonicalPhase = phaseKind === 'delivery' ? 'delivery' : 'execution';
  const anchorTargets = resolveEventAnchorTargets({ targets, reviewerTargets, platform });
  const seed = hashJson({ taskSeq, phaseKind: canonicalPhase, anchorTargets });
  return {
    eventId: `evt-${seed.slice(0, 12)}`,
    anchorTargets,
    phaseKind: canonicalPhase,
  };
}

/**
 * Compute Behavior Identity (`beh-...`) recording the ACTUAL challenged decision or execution contract.
 * Deliberately excludes:
 *   - workspace file SHA-256 hashes (collateral edits by other members must NEVER alter Behavior Identity!)
 *   - stage_id / member name / topic / review title
 *   - reviewer wording, objection reasons, concerns, or newly attached evidence excerpts
 * Pure.
 */
export function computeBehaviorIdentity({
  phaseKind = 'execution',
  goal = '',
  method = '',
  interfaces = [],
  profile = null,
  tools = [],
  decisionSummary = '',
} = {}) {
  const canonicalPhase = phaseKind === 'delivery' ? 'delivery' : 'execution';
  const sortedTools = [...new Set((Array.isArray(tools) ? tools : []).filter(t => typeof t === 'string'))].sort();
  const sortedInterfaces = [...new Set((Array.isArray(interfaces) ? interfaces : []).filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean))].sort();
  const normGoal = normalizeTextToken(goal, 1200);
  const normMethod = normalizeTextToken(method, 2400);
  const normDecision = (!normGoal && !normMethod) ? normalizeTextToken(decisionSummary, 1600) : '';

  const payload = {
    phaseKind: canonicalPhase,
    profile: profile ?? null,
    tools: sortedTools,
    interfaces: sortedInterfaces,
    goal: normGoal,
    method: normMethod,
    decision: normDecision,
  };
  const digest = hashJson(payload);
  const summaryParts = [
    profile ? `profile=${profile}` : '',
    normGoal ? `goal=${truncate(normGoal, 100)}` : '',
    normMethod ? `method=${truncate(normMethod, 120)}` : '',
    normDecision ? `decision=${truncate(normDecision, 120)}` : '',
  ].filter(Boolean);

  return Object.freeze({
    behaviorId: `beh-${digest.slice(0, 12)}`,
    behaviorHash: digest,
    summary: summaryParts.join(' | ') || `${canonicalPhase}-behavior`,
  });
}

/** Deterministic Dispute Chain ID (`chain-...`) linking recurring objections on the same event & behavior. Pure. */
export function createDisputeChainId({ eventId, chainSeq = 1 } = {}) {
  const seed = hashJson({ eventId: String(eventId ?? 'evt-unknown'), chainSeq });
  return `chain-${seed.slice(0, 12)}`;
}

/** Legacy alias preserved for external callers. Pure. */
export function createDisputeId({ taskSeq = 1, phaseKind = 'execution', targets = [], epoch = 1 } = {}) {
  const { eventId } = computeEventId({ taskSeq, phaseKind, targets });
  return createDisputeChainId({ eventId, chainSeq: epoch });
}

/**
 * Build strictly AUXILIARY evidence snapshot (file hashes + post-strike execution records).
 * Used as factual evidence for continuity/remediation verification — NEVER auto-resets `strikeCount`. Pure.
 */
export function buildDisputeEvidenceSnapshot({
  targets = [],
  targetFileHashes = {},
  priorFileHashes = null,
  executionRecords = [],
  platform = process.platform,
} = {}) {
  const normTargets = normalizeDisputeTargets(targets);
  const currentFiles = {};
  for (const [relPath, contentHash] of Object.entries(targetFileHashes ?? {})) {
    const normRel = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normRel) continue;
    if (normTargets.length === 0 || matchesAnyGlob(normRel, normTargets, platform) || normTargets.includes(normRel)) {
      currentFiles[normRel] = contentHash ?? 'missing';
    }
  }
  const sortedFiles = Object.fromEntries(Object.entries(currentFiles).sort(([a], [b]) => a.localeCompare(b)));

  const changedFiles = [];
  const unchangedFiles = [];
  if (priorFileHashes && typeof priorFileHashes === 'object') {
    const allKeys = new Set([...Object.keys(priorFileHashes), ...Object.keys(sortedFiles)]);
    for (const k of [...allKeys].sort()) {
      if ((priorFileHashes[k] ?? 'missing') !== (sortedFiles[k] ?? 'missing')) {
        changedFiles.push(k);
      } else {
        unchangedFiles.push(k);
      }
    }
  }

  const cleanExec = (Array.isArray(executionRecords) ? executionRecords : []).map(r => ({
    name: r.name ?? null,
    actorRole: r.actorRole ?? 'member',
    status: r.status ?? null,
    stageId: r.stageId ?? null,
    writeScope: Array.isArray(r.writeScope) ? r.writeScope : [],
  }));

  return Object.freeze({
    fileHashes: sortedFiles,
    changedFiles: Object.freeze(changedFiles),
    unchangedFiles: Object.freeze(unchangedFiles),
    hasTargetFileChanges: changedFiles.length > 0,
    executionRecords: Object.freeze(cleanExec),
    hasNewExecutionRecords: cleanExec.length > 0,
  });
}

/**
 * Snapshot digest used ONLY to deduplicate identical Stage 1 background supervision jobs in memory.
 * NEVER used to reset dispute strike counts! Pure.
 */
export function computeActualBehaviorDigest({
  phaseKind = 'execution',
  targets = [],
  profile = null,
  tools = [],
  interfaces = [],
  goal = '',
  method = '',
  proposal = '',
  targetFileHashes = {},
  platform = process.platform,
} = {}) {
  const normTargets = normalizeDisputeTargets(targets);
  const behavior = computeBehaviorIdentity({
    phaseKind,
    goal,
    method,
    interfaces,
    profile,
    tools,
    decisionSummary: proposal,
  });
  const ev = buildDisputeEvidenceSnapshot({ targets: normTargets, targetFileHashes, platform });
  return hashJson({
    phaseKind: phaseKind === 'delivery' ? 'delivery' : 'execution',
    targets: normTargets,
    behaviorId: behavior.behaviorId,
    files: ev.fileHashes,
  });
}

/**
 * Match or open a Dispute Chain and advance its strike counter when Dual Reviewers unanimously object.
 *
 * Constitutional guarantees (§一 & §5):
 * 1. Event (`eventId`) + Actual Behavior (`behaviorId`) are the primary subjects — file SHA-256 NEVER auto-resets `strikeCount`!
 * 2. Collateral file edits by another member (`hasTargetFileChanges === true` while `behaviorId` is unchanged or unverified)
 *    NEVER reset `strikeCount` to 1.
 * 3. Unchanged file hashes at planning stage (`hasTargetFileChanges === false` while `behaviorId` genuinely changed)
 *    are NOT blindly forced to stay on the old chain — `needsContinuityVerification` lets Stage 2 Arbiter judge actual behavior change.
 * 4. Stage 4 post-conference re-objection (`isStage4ReReview === true` / `parentChainId`) ALWAYS stays on the parent
 *    `disputeChainId` (`strikeCount + 1`), regardless of any concurrent/other-member file changes.
 * 5. Reaching Strike 3 (`strikeCount > maxInternalArbitrationRounds`) on the same chain IMMEDIATELY escalates to Human (`escalate_human`).
 */
export function resolveDisputeStrike(existingDisputes, candidate, cfg = {}) {
  const maxInternalRounds = Number.isInteger(cfg.maxInternalArbitrationRounds) && cfg.maxInternalArbitrationRounds > 0
    ? cfg.maxInternalArbitrationRounds
    : 2;
  const platform = cfg.platform ?? process.platform;
  const taskSeq = candidate.taskSeq ?? 1;
  const phaseKind = candidate.phaseKind === 'delivery' ? 'delivery' : 'execution';
  const normTargets = normalizeDisputeTargets(candidate.targets);
  const reviewerTargets = normalizeDisputeTargets(candidate.reviewerTargets);

  const eventInfo = computeEventId({
    taskSeq,
    phaseKind,
    targets: normTargets,
    reviewerTargets,
    platform,
  });

  const behavior = candidate.behaviorIdentity?.behaviorId
    ? candidate.behaviorIdentity
    : computeBehaviorIdentity({
        phaseKind,
        goal: candidate.goal ?? '',
        method: candidate.method ?? '',
        interfaces: candidate.interfaces ?? [],
        profile: candidate.profile ?? null,
        tools: candidate.tools ?? [],
        decisionSummary: candidate.decisionSummary ?? candidate.proposal ?? '',
      });

  const activeChains = (Array.isArray(existingDisputes) ? existingDisputes : []).filter(
    d => (d.taskSeq ?? 1) === taskSeq && (d.phaseKind ?? 'execution') === eventInfo.phaseKind && !d.supersededByEpoch,
  );

  const explicitParentId = candidate.parentChainId ?? candidate.parentDisputeId ?? null;
  let matched = null;
  if (typeof explicitParentId === 'string' && explicitParentId) {
    matched = activeChains.findLast(d => (d.disputeChainId ?? d.disputeId) === explicitParentId) ?? null;
  }
  if (!matched) {
    matched = activeChains.findLast(d =>
      d.eventId === eventInfo.eventId ||
      disputeTargetsMatch(d.anchorTargets ?? d.targets, eventInfo.anchorTargets, platform),
    ) ?? null;
  }

  const priorHashes = matched?.evidenceSnapshot?.fileHashes ?? null;
  const evidenceSnapshot = buildDisputeEvidenceSnapshot({
    targets: eventInfo.anchorTargets.length > 0 ? eventInfo.anchorTargets : normTargets,
    targetFileHashes: candidate.targetFileHashes ?? {},
    priorFileHashes: priorHashes,
    executionRecords: candidate.executionRecords ?? [],
    platform,
  });

  // 1. Brand-new engineering event -> open Chain #1, Strike #1
  if (!matched) {
    const chainSeq = 1;
    const disputeChainId = createDisputeChainId({ eventId: eventInfo.eventId, chainSeq });
    return {
      eventId: eventInfo.eventId,
      anchorTargets: eventInfo.anchorTargets,
      behaviorId: behavior.behaviorId,
      behaviorSummary: behavior.summary,
      disputeChainId,
      disputeId: disputeChainId,
      isNewDispute: true,
      materialBehaviorChange: false,
      needsContinuityVerification: false,
      matchedChain: null,
      priorEpochDisputeId: null,
      priorChainId: null,
      epoch: chainSeq,
      chainSeq,
      strikeCount: 1,
      action: 1 > maxInternalRounds ? 'escalate_human' : 'enter_caucus',
      targets: eventInfo.anchorTargets.length > 0 ? eventInfo.anchorTargets : normTargets,
      evidenceSnapshot,
      phaseKind: eventInfo.phaseKind,
      taskSeq,
    };
  }

  const effectiveEventId = matched.eventId ?? eventInfo.eventId;
  const matchedChainId = matched.disputeChainId ?? matched.disputeId;
  const mergedTargets = normalizeDisputeTargets([...(matched.targets ?? []), ...(eventInfo.anchorTargets.length > 0 ? eventInfo.anchorTargets : normTargets)]);

  // 2. Stage 4 Post-Conference Re-Review ALWAYS links to the parent dispute chain (§一)
  if (candidate.isStage4ReReview === true || candidate.forceSameDispute === true) {
    const nextStrike = (matched.strikeCount ?? 0) + 1;
    return {
      eventId: effectiveEventId,
      anchorTargets: matched.anchorTargets ?? eventInfo.anchorTargets,
      behaviorId: matched.behaviorId ?? behavior.behaviorId,
      behaviorSummary: matched.behaviorSummary ?? behavior.summary,
      disputeChainId: matchedChainId,
      disputeId: matchedChainId,
      isNewDispute: false,
      materialBehaviorChange: false,
      needsContinuityVerification: false,
      matchedChain: matched,
      priorEpochDisputeId: matched.priorEpochDisputeId ?? null,
      priorChainId: matched.priorChainId ?? null,
      epoch: matched.chainSeq ?? matched.epoch ?? 1,
      chainSeq: matched.chainSeq ?? matched.epoch ?? 1,
      strikeCount: nextStrike,
      action: nextStrike > maxInternalRounds ? 'escalate_human' : 'enter_caucus',
      targets: mergedTargets,
      evidenceSnapshot,
      phaseKind: eventInfo.phaseKind,
      taskSeq,
    };
  }

  // 3. Explicit continuity verdict (confirmed by Stage 2 Arbiter or caller)
  if (candidate.continuityVerdict === 'substantive_behavior_changed') {
    const nextChainSeq = (matched.chainSeq ?? matched.epoch ?? 1) + 1;
    const disputeChainId = createDisputeChainId({ eventId: effectiveEventId, chainSeq: nextChainSeq });
    return {
      eventId: effectiveEventId,
      anchorTargets: eventInfo.anchorTargets.length > 0 ? eventInfo.anchorTargets : (matched.anchorTargets ?? []),
      behaviorId: behavior.behaviorId,
      behaviorSummary: behavior.summary,
      disputeChainId,
      disputeId: disputeChainId,
      isNewDispute: true,
      materialBehaviorChange: true,
      needsContinuityVerification: false,
      matchedChain: matched,
      priorEpochDisputeId: matchedChainId,
      priorChainId: matchedChainId,
      epoch: nextChainSeq,
      chainSeq: nextChainSeq,
      strikeCount: 1,
      action: 1 > maxInternalRounds ? 'escalate_human' : 'enter_caucus',
      targets: eventInfo.anchorTargets.length > 0 ? eventInfo.anchorTargets : normTargets,
      evidenceSnapshot,
      phaseKind: eventInfo.phaseKind,
      taskSeq,
    };
  }

  const behaviorChanged = Boolean(matched.behaviorId && matched.behaviorId !== behavior.behaviorId);
  const hasCandidateActivity = behaviorChanged || evidenceSnapshot.hasNewExecutionRecords || evidenceSnapshot.hasTargetFileChanges;
  const priorSettled = (matched.lastResolvedStrike ?? matched.strikeCount ?? 0) >= 1;

  // 4. If neither explicit continuityVerdict nor zero-activity match, flag `needsContinuityVerification: true`
  //    WITHOUT resetting `strikeCount`! File SHA-256 changes alone NEVER auto-reset the chain.
  const needsContinuityVerification = candidate.continuityVerdict !== 'same_behavior_persists'
    && priorSettled
    && hasCandidateActivity;

  const nextStrike = (matched.strikeCount ?? 0) + 1;
  return {
    eventId: effectiveEventId,
    anchorTargets: matched.anchorTargets ?? eventInfo.anchorTargets,
    behaviorId: behavior.behaviorId,
    behaviorSummary: behavior.summary,
    disputeChainId: matchedChainId,
    disputeId: matchedChainId,
    isNewDispute: false,
    materialBehaviorChange: false,
    needsContinuityVerification,
    behaviorChanged,
    matchedChain: matched,
    priorEpochDisputeId: matched.priorEpochDisputeId ?? null,
    priorChainId: matched.priorChainId ?? null,
    epoch: matched.chainSeq ?? matched.epoch ?? 1,
    chainSeq: matched.chainSeq ?? matched.epoch ?? 1,
    strikeCount: nextStrike,
    // When continuity verification is needed, Stage 2 Arbiter inspects event + behavior + auxiliary evidence first;
    // if Arbiter confirms `same_behavior_persists` and `nextStrike > maxInternalRounds`, it immediately escalates to Human!
    action: (!needsContinuityVerification && nextStrike > maxInternalRounds) ? 'escalate_human' : 'enter_caucus',
    wouldEscalateHumanIfSameBehavior: nextStrike > maxInternalRounds,
    targets: mergedTargets,
    evidenceSnapshot,
    phaseKind: eventInfo.phaseKind,
    taskSeq,
  };
}
