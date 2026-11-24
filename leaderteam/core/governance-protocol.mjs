// Pure 4-Stage Governance & Power Redistribution Protocol:
//   - Leader autonomous execution & dispatch (no review pre-approval gate)
//   - Stage 1: Async Dual Supervision (advisory unless unanimous formal objection)
//   - Stage 2: 3-Party Internal Caucus (Arbiter + Reviewer A + Reviewer B, >= 2/3 majority vote, zero execution pause)
//   - Pre-Conference Barrier: Wait for ALL active execution models (`member` AND `direct_exec`) to write an immediate
//     handoff checkpoint (`STOPPED_AT`, `COMPLETED_SO_FAR`, `RESUME_PLAN`, `STATUS: paused`) and stop BEFORE opening Stage 3
//   - Stage 3: 2-Party Formal Conference (Arbiter + Leader ONLY; `team_dispatch`, `send_message`, and `team_direct_exec`
//     are ALL suspended during the conference; Arbiter may overturn initial expectation)
//   - Stage 4: Full 5-part Return Packet to Review Zone for genuine re-evaluation (stays on parent `disputeChainId`)
//   - Strike 3 on same event & actual behavior -> Direct Human Escalation (no 3rd internal Arbiter cycle)
import { extractJsonObjectText } from './gate-policy.mjs';
import { truncate } from './redact.mjs';
import { anyGlobOverlaps, normalizeGlob } from './paths.mjs';

export const DEFAULT_GOVERNANCE_CONFIG = Object.freeze({
  mode: 'autonomous',               // 'autonomous' | 'approval'
  caucusQuorumNumerator: 2,
  caucusQuorumDenominator: 3,
  maxInternalArbitrationRounds: 2,  // Strike 1 & 2 -> internal caucus/conference; Strike 3 -> human escalation
  maxConferenceDialogueTurns: 2,    // Max back-and-forth turns inside Stage 3 before Arbiter must conclude
  autoSuperviseStages: true,
  autoSuperviseDispatches: true,
  directExecMaxSteps: 24,
  pauseBarrierTimeoutMs: 30000,
});

/** True when LeaderTeam runs under the autonomous execution-first governance architecture. Pure. */
export function isAutonomousGovernance(cfg) {
  return cfg?.governance?.mode === 'autonomous';
}

function cleanStrList(arr, maxItems = 12, maxLen = 600) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (typeof x === 'string' && x.trim()) {
      out.push(truncate(x.trim(), maxLen));
      if (out.length >= maxItems) break;
    }
  }
  return out;
}

// ============================================================================
// Stage 1 & Stage 4: Asynchronous Dual Supervision Prompts & Parser
// ============================================================================

export const SUPERVISION_REVIEWER_SYSTEM = [
  'You are an independent asynchronous supervisor (one of two symmetric Dual Reviewers) in LeaderTeam.',
  'Constitutional power boundaries:',
  '- You possess SUPERVISION and PETITION rights ONLY — you have NO power to directly block Leader dispatches, unilaterally alter Leader plans, pause execution members, or turn preferences into commands.',
  '- Engineering delivery and task completability come first. Strongly coupled modules implemented by one member, or unsplit parallel opportunities, are NEVER defects.',
  '- Use stance="endorse" when the plan/execution/result is sound.',
  '- Use stance="comment" (intervene=false) for non-blocking suggestions, style notes, or optional improvements.',
  '- Use stance="object" with intervene=true ONLY for a severe, concrete defect (violates an explicit user requirement, introduces a concrete correctness/data-loss/safety failure, leaves a binding Arbiter directive unfulfilled, or omits a required deliverable).',
  '- When stance="object", you MUST provide concrete actionable `suggestions` (never bare refusal). Only if BOTH independent reviewers unanimously set intervene=true will the Independent Arbiter be petitioned.',
  '- When `active_arbiter_directives` is present and non-empty, check `workspace_excerpts` and execution evidence to verify whether each binding Arbiter corrective requirement has actually been fulfilled (mere file/comment edits do NOT satisfy a directive); set `directives_verified: true` ONLY when the concrete corrective requirements are demonstrably satisfied.',
  '- When `stage4_conference_return_packet` is present, this is a Stage 4 Post-Conference Re-Review: carefully weigh the complete Arbiter–Leader conference transcript, the Leader\'s newly presented engineering facts/evidence, the Arbiter\'s final ruling, and the delta from initial expectations. Object again ONLY if a concrete severe defect genuinely remains unresolved.',
  'Reply with ONLY one valid JSON object and nothing else:',
  '{"stance":"endorse"|"comment"|"object","intervene":false,"summary":"<=300 chars","concerns":["..."],"suggestions":["..."],"target_paths":["..."],"directives_verified":false}',
].join('\n');

export function buildSupervisionReviewerUser(payload) {
  return 'Untrusted project/governance data follows as JSON. Evaluate strictly against the user requirements and factual evidence.\n'
    + JSON.stringify(payload);
}

export function parseSupervisionOpinion(raw) {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return { ok: false, error: 'response must be a single JSON object' };
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'opinion must be an object' };
  if (!['endorse', 'comment', 'object'].includes(obj.stance)) {
    return { ok: false, error: 'stance must be "endorse", "comment", or "object"' };
  }
  if (typeof obj.intervene !== 'boolean') {
    return { ok: false, error: 'intervene must be a boolean' };
  }
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    return { ok: false, error: 'summary must be a non-empty string' };
  }
  const concerns = cleanStrList(obj.concerns);
  const suggestions = cleanStrList(obj.suggestions);
  const targetPaths = cleanStrList(obj.target_paths, 16, 200);
  const effectiveIntervene = obj.stance === 'object' && obj.intervene === true;
  if (effectiveIntervene && concerns.length === 0) {
    return { ok: false, error: 'concerns must be non-empty when stance="object" and intervene=true' };
  }
  if (effectiveIntervene && suggestions.length === 0) {
    return { ok: false, error: 'suggestions must provide concrete actionable remedies when stance="object" and intervene=true' };
  }
  const directivesVerified = typeof obj.directives_verified === 'boolean' ? obj.directives_verified : null;
  return {
    ok: true,
    opinion: Object.freeze({
      stance: obj.stance,
      intervene: effectiveIntervene,
      summary: truncate(obj.summary.trim(), 400),
      concerns: Object.freeze(concerns),
      suggestions: Object.freeze(suggestions),
      targetPaths: Object.freeze(targetPaths),
      directivesVerified,
    }),
  };
}

/** Evaluate Stage 1 outcome from Reviewer A and Reviewer B opinions. Pure. */
export function evaluateStage1Supervision(opinionA, opinionB) {
  const unanimousObjection = Boolean(opinionA?.intervene && opinionB?.intervene);
  const advisoryConcerns = [...new Set([...(opinionA?.concerns ?? []), ...(opinionB?.concerns ?? [])])];
  const advisorySuggestions = [...new Set([...(opinionA?.suggestions ?? []), ...(opinionB?.suggestions ?? [])])];
  const directivesVerified = !unanimousObjection
    && opinionA?.directivesVerified !== false
    && opinionB?.directivesVerified !== false
    && (opinionA?.directivesVerified === true || opinionB?.directivesVerified === true);
  return Object.freeze({
    unanimousObjection,
    petitionArbiter: unanimousObjection,
    advisoryOnly: !unanimousObjection,
    advisoryConcerns: Object.freeze(advisoryConcerns),
    advisorySuggestions: Object.freeze(advisorySuggestions),
    directivesVerified,
  });
}

// ============================================================================
// Stage 2: 3-Party Internal Caucus (Arbiter + Reviewer A + Reviewer B, >= 2/3)
// ============================================================================

export const CAUCUS_ARBITER_SYSTEM = [
  'You are the Independent Arbiter participating in Stage 2 (3-Party Internal Caucus with Reviewer A and Reviewer B).',
  'The Leader and execution members are NOT paused during this internal caucus.',
  'Your job:',
  '1. Examine Reviewer A and Reviewer B\'s unanimous objection alongside the live workspace excerpts, stage contracts, member progress, and safety-gate receipts.',
  '2. Verify whether the alleged defect actually exists on disk / in active execution and materially threatens correctness, user requirements, or safety.',
  '3. When `prior_dispute_chain` is present, judge `dispute_continuity` strictly by EVENT and ACTUAL ENGINEERING BEHAVIOR (file SHA-256 hashes and execution logs in `auxiliary_evidence_snapshot` are auxiliary evidence ONLY):',
  '   - Return `"same_behavior_persists"` if the underlying challenged decision or defect has NOT substantively changed (e.g., collateral files changed, comments changed, or stages/members were renamed while the disputed behavior remains).',
  '   - Return `"substantive_behavior_changed"` ONLY if the Leader/team genuinely changed the challenged architecture, design, or implementation approach (even if at the planning stage before disk hashes change).',
  '4. When `active_arbiter_directives` is present, set `prior_directive_satisfied: true` ONLY if the concrete corrective requirements from the prior conference have been verified as completed.',
  '5. Cast your caucus vote (`escalate_to_conference`: true or false) and state your `initial_expectation` (what corrective direction you currently expect if a conference is held, plus concrete questions to ask the Leader).',
  'Reply with ONLY one valid JSON object:',
  '{"escalate_to_conference":true|false,"rationale":"<=500 chars","fact_findings":["..."],"initial_expectation":"<=400 chars","questions_for_leader":["..."],"dispute_continuity":"same_behavior_persists"|"substantive_behavior_changed","prior_directive_satisfied":false}',
].join('\n');

export const CAUCUS_REVIEWER_VOTE_SYSTEM = [
  'You are a Dual Reviewer participating in Stage 2 (3-Party Internal Caucus with your peer Reviewer and the Independent Arbiter).',
  'Review the collected live workspace facts, execution records, and the Arbiter\'s preliminary fact-check.',
  'Cast your vote (`escalate_to_conference`: true or false) on whether to formally convene a Stage 3 Arbiter–Leader Conference (2/3 majority required).',
  'If live workspace facts show the issue is already resolved or non-blocking, vote false; if formal intervention is genuinely needed, vote true and state your expected remedy.',
  'Reply with ONLY one valid JSON object:',
  '{"escalate_to_conference":true|false,"rationale":"<=400 chars","initial_expectation":"<=300 chars"}',
].join('\n');

export function parseCaucusVote(raw, requireQuestions = false) {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return { ok: false, error: 'response must be a single JSON object' };
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'vote must be an object' };
  if (typeof obj.escalate_to_conference !== 'boolean') {
    return { ok: false, error: 'escalate_to_conference must be a boolean' };
  }
  if (typeof obj.rationale !== 'string' || !obj.rationale.trim()) {
    return { ok: false, error: 'rationale must be a non-empty string' };
  }
  const initialExpectation = typeof obj.initial_expectation === 'string' && obj.initial_expectation.trim()
    ? truncate(obj.initial_expectation.trim(), 500)
    : truncate(obj.rationale.trim(), 500);
  const questions = cleanStrList(obj.questions_for_leader, 6, 300);
  const factFindings = cleanStrList(obj.fact_findings, 8, 300);
  if (requireQuestions && obj.escalate_to_conference && questions.length === 0) {
    questions.push('Explain your engineering rationale, current workspace facts, and how the disputed requirement is satisfied or will be corrected.');
  }
  const continuity = ['same_behavior_persists', 'substantive_behavior_changed'].includes(obj.dispute_continuity)
    ? obj.dispute_continuity
    : null;
  const priorDirectiveSatisfied = typeof obj.prior_directive_satisfied === 'boolean'
    ? obj.prior_directive_satisfied
    : null;
  return {
    ok: true,
    vote: Object.freeze({
      escalate: obj.escalate_to_conference,
      rationale: truncate(obj.rationale.trim(), 600),
      initialExpectation,
      questionsForLeader: Object.freeze(questions),
      factFindings: Object.freeze(factFindings),
      disputeContinuity: continuity,
      priorDirectiveSatisfied,
    }),
  };
}

/** Tally the 3 caucus votes (`arbiter`, `A`, `B`) under the 2/3 majority rule. Pure. */
export function tallyCaucusVotes({ voteArbiter, voteA, voteB }, cfg = {}) {
  const num = cfg.caucusQuorumNumerator ?? 2;
  const den = cfg.caucusQuorumDenominator ?? 3;
  const votes = [
    { voter: 'arbiter', ...(voteArbiter ?? { escalate: false, rationale: 'unavailable', initialExpectation: '' }) },
    { voter: 'discussA', ...(voteA ?? { escalate: false, rationale: 'unavailable', initialExpectation: '' }) },
    { voter: 'discussB', ...(voteB ?? { escalate: false, rationale: 'unavailable', initialExpectation: '' }) },
  ];
  const yesVotes = votes.filter(v => v.escalate === true).length;
  const totalVotes = votes.length;
  const approved = yesVotes * den >= num * totalVotes;
  const yesExpectations = votes.filter(v => v.escalate && v.initialExpectation).map(v => `${v.voter}: ${v.initialExpectation}`);
  const initialExpectation = yesExpectations.join(' | ') || voteArbiter?.initialExpectation || '';
  return Object.freeze({
    approved,
    yesVotes,
    totalVotes,
    quorum: `${num}/${den}`,
    initialExpectation: truncate(initialExpectation, 900),
    questionsForLeader: Object.freeze(voteArbiter?.questionsForLeader?.length ? [...voteArbiter.questionsForLeader] : [
      'Please state the concrete engineering facts, rationale, and any alternative solution for the disputed item.',
    ]),
    votes: Object.freeze(votes),
  });
}

// ============================================================================
// Arbiter Directive Remediation Verification (§二: 裁断指令不能靠文件变化自动销账)
// ============================================================================

export const DIRECTIVE_VERIFICATION_SYSTEM = [
  'You are the Independent Arbiter verifying whether a binding corrective directive from a concluded Formal Conference has actually been fulfilled.',
  'CRITICAL RULE: Mere workspace file modifications, comment edits, or unrelated sibling file changes NEVER satisfy a directive.',
  'Inspect the live `workspace_excerpts`, post-conference execution records, and stage verification receipts against each item in `binding_directives`.',
  'Return `satisfied: true` ONLY if every concrete corrective requirement has genuinely been implemented and verified.',
  'Reply with ONLY one valid JSON object:',
  '{"satisfied":true|false,"verified_items":["..."],"missing_items":["..."],"reason":"<=400 chars"}',
].join('\n');

export function parseDirectiveVerification(raw) {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return { ok: false, error: 'response must be a single JSON object' };
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'verification must be an object' };
  if (typeof obj.satisfied !== 'boolean') return { ok: false, error: 'satisfied must be a boolean' };
  if (typeof obj.reason !== 'string' || !obj.reason.trim()) return { ok: false, error: 'reason must be a non-empty string' };
  const verifiedItems = cleanStrList(obj.verified_items, 10, 400);
  const missingItems = cleanStrList(obj.missing_items, 10, 400);
  if (!obj.satisfied && missingItems.length === 0) {
    missingItems.push(truncate(obj.reason.trim(), 400));
  }
  return {
    ok: true,
    verification: Object.freeze({
      satisfied: obj.satisfied,
      verifiedItems: Object.freeze(verifiedItems),
      missingItems: Object.freeze(missingItems),
      reason: truncate(obj.reason.trim(), 500),
    }),
  };
}

// ============================================================================
// Stage 3: 2-Party Formal Conference (Independent Arbiter + Leader ONLY)
// ============================================================================

export const CONFERENCE_OPENING_SYSTEM = [
  'You are the Independent Arbiter opening a Stage 3 Formal 2-Party Conference with ONLY the Leader.',
  'Reviewers are NOT present in this conference. All other execution models (both ordinary members and direct_exec) have written their handoff checkpoints and paused before this conference opened.',
  'State clearly and concisely to the Leader:',
  '1. The exact dispute and factual investigation basis from the caucus.',
  '2. The concrete questions or evidence needed from the Leader.',
  '3. Invite the Leader to present engineering facts, workspace evidence, or an alternative solution.',
  'Reply with ONLY one valid JSON object:',
  '{"opening_statement":"<=800 chars","key_questions":["..."]}',
].join('\n');

export const CONFERENCE_DELIBERATION_SYSTEM = [
  'You are the Independent Arbiter in a Stage 3 Formal 2-Party Conference with ONLY the Leader.',
  'CRITICAL CONSTITUTIONAL PRINCIPLE:',
  '- This Formal Conference is NOT a rubber-stamp procedure to enforce what Reviewers or the 3-party caucus initially expected!',
  '- Carefully evaluate the Leader\'s explanation, newly supplied workspace facts/evidence, and any proposed alternative.',
  '- Your final ruling MAY differ from the 3-party caucus\'s `initial_expectation`, adopt a better alternative proposed in the meeting, or COMPLETELY OVERTURN the original objection when the Leader\'s facts/evidence justify it.',
  '- Safety Gate hard constraints can NEVER be waived by any governance ruling.',
  'If one brief clarification question to the Leader is genuinely essential AND `remaining_dialogue_turns > 0`, return `status="continue_dialogue"`.',
  'Otherwise return `status="concluded"` with:',
  '- `decision`: "overturn_objection" (Leader\'s plan/execution stands without forced change) | "adopt_alternative" (adopt agreed compromise/alternative) | "enforce_correction" (mandate concrete corrective directives).',
  '- `ruling_summary`: clear final decision.',
  '- `delta_from_initial_expectation`: explicit statement comparing your final decision against `initial_expectation` and explaining why it matched, modified, or overturned it.',
  '- `binding_directives`: array of concrete required actions (must be [] when decision="overturn_objection", non-empty otherwise).',
  '- `blocked_targets`: workspace globs or stage ids temporarily gated until the Leader updates them (use [] unless decision="enforce_correction" requires editing a stage contract before re-dispatch).',
  '- `member_resume_policy`: "resume_all" | "adjust_disputed_resume_others".',
  'Reply with ONLY one valid JSON object:',
  '{"status":"continue_dialogue"|"concluded","follow_up_question":"...","decision":"overturn_objection"|"adopt_alternative"|"enforce_correction","ruling_summary":"<=800 chars","delta_from_initial_expectation":"<=600 chars","binding_directives":["..."],"blocked_targets":["..."],"member_resume_policy":"resume_all"|"adjust_disputed_resume_others"}',
].join('\n');

export function parseConferenceOpening(raw) {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return { ok: false, error: 'response must be a single JSON object' };
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  if (!obj || typeof obj.opening_statement !== 'string' || !obj.opening_statement.trim()) {
    return { ok: false, error: 'opening_statement must be a non-empty string' };
  }
  return {
    ok: true,
    opening: Object.freeze({
      openingStatement: truncate(obj.opening_statement.trim(), 1000),
      keyQuestions: Object.freeze(cleanStrList(obj.key_questions, 6, 300)),
    }),
  };
}

function isValidBlockedTargetEntry(entry, validStageIds = null, platform = process.platform) {
  if (typeof entry !== 'string' || !entry.trim()) return false;
  if (Array.isArray(validStageIds) && validStageIds.includes(entry)) return true;
  try {
    normalizeGlob(entry, platform);
    return true;
  } catch {
    return false;
  }
}

export function parseConferenceDeliberation(raw, {
  forceConclude = false,
  validStageIds = null,
  fallbackTargets = [],
  platform = process.platform,
} = {}) {
  const jsonText = extractJsonObjectText(raw);
  if (!jsonText) return { ok: false, error: 'response must be a single JSON object' };
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'deliberation must be an object' };

  if (obj.status === 'continue_dialogue' && !forceConclude) {
    if (typeof obj.follow_up_question !== 'string' || !obj.follow_up_question.trim()) {
      return { ok: false, error: 'follow_up_question is required when status="continue_dialogue"' };
    }
    return {
      ok: true,
      result: Object.freeze({
        status: 'continue_dialogue',
        followUpQuestion: truncate(obj.follow_up_question.trim(), 600),
      }),
    };
  }

  if (obj.status !== 'concluded' && !forceConclude) {
    return { ok: false, error: 'status must be "continue_dialogue" or "concluded"' };
  }
  const decision = obj.decision;
  if (!['overturn_objection', 'adopt_alternative', 'enforce_correction'].includes(decision)) {
    return { ok: false, error: 'decision must be "overturn_objection", "adopt_alternative", or "enforce_correction"' };
  }
  if (typeof obj.ruling_summary !== 'string' || !obj.ruling_summary.trim()) {
    return { ok: false, error: 'ruling_summary must be a non-empty string' };
  }
  if (typeof obj.delta_from_initial_expectation !== 'string' || !obj.delta_from_initial_expectation.trim()) {
    return { ok: false, error: 'delta_from_initial_expectation must be a non-empty string' };
  }
  const bindingDirectives = decision === 'overturn_objection' ? [] : cleanStrList(obj.binding_directives, 10, 500);
  if (decision !== 'overturn_objection' && bindingDirectives.length === 0) {
    return { ok: false, error: 'binding_directives must be non-empty when decision is adopt_alternative or enforce_correction' };
  }
  const rawBlockedTargets = decision === 'enforce_correction' ? cleanStrList(obj.blocked_targets, 12, 200) : [];
  let blockedTargets = rawBlockedTargets.filter(t => isValidBlockedTargetEntry(t, validStageIds, platform));
  if (decision === 'enforce_correction' && rawBlockedTargets.length > 0 && blockedTargets.length === 0) {
    if (!forceConclude) {
      return {
        ok: false,
        error: 'blocked_targets entries must be valid workspace-relative globs or stage IDs (no leading "/" or "..")',
      };
    }
    blockedTargets = cleanStrList(fallbackTargets, 12, 200)
      .filter(t => isValidBlockedTargetEntry(t, validStageIds, platform));
  }
  const resumePolicy = obj.member_resume_policy === 'adjust_disputed_resume_others'
    ? 'adjust_disputed_resume_others'
    : 'resume_all';

  return {
    ok: true,
    result: Object.freeze({
      status: 'concluded',
      decision,
      rulingSummary: truncate(obj.ruling_summary.trim(), 1000),
      deltaFromInitialExpectation: truncate(obj.delta_from_initial_expectation.trim(), 800),
      bindingDirectives: Object.freeze(bindingDirectives),
      blockedTargets: Object.freeze(blockedTargets),
      memberResumePolicy: resumePolicy,
    }),
  };
}

// ============================================================================
// Stage 4: Mandatory 5-Part Return Packet to Review Zone
// ============================================================================

export function buildStage4ReviewPacket({
  conferenceId,
  disputeId,
  eventId = null,
  behaviorId = null,
  strike,
  initialExpectation,
  opening,
  turns = [],
  ruling,
}) {
  const transcript = [
    { speaker: 'arbiter', role: 'opening', text: opening?.openingStatement ?? '', questions: opening?.keyQuestions ?? [] },
    ...turns.map(t => ({
      speaker: t.speaker,
      text: t.text,
      ...(t.proposedAlternative ? { proposed_alternative: t.proposedAlternative } : {}),
      ...(t.newEvidenceFiles?.length ? { new_evidence_files: t.newEvidenceFiles } : {}),
    })),
    { speaker: 'arbiter', role: 'final_ruling', decision: ruling.decision, text: ruling.rulingSummary },
  ];

  const leaderTurns = turns.filter(t => t.speaker === 'leader');
  const leaderNewFactsAndRationale = {
    explanations: leaderTurns.map(t => t.text).filter(Boolean),
    proposed_alternatives: leaderTurns.map(t => t.proposedAlternative).filter(Boolean),
    new_evidence_files: [...new Set(leaderTurns.flatMap(t => t.newEvidenceFiles ?? []))],
    new_evidence_excerpts: leaderTurns.map(t => t.loadedEvidencePreview).filter(Boolean),
  };

  return Object.freeze({
    conference_id: conferenceId,
    dispute_id: disputeId,
    dispute_chain_id: disputeId,
    ...(eventId ? { event_id: eventId } : {}),
    ...(behaviorId ? { behavior_id: behaviorId } : {}),
    strike,
    initial_caucus_expectation: initialExpectation ?? '',
    complete_discussion_transcript: transcript,
    leader_new_facts_and_rationale: leaderNewFactsAndRationale,
    arbiter_final_decision: {
      decision: ruling.decision,
      summary: ruling.rulingSummary,
      member_resume_policy: ruling.memberResumePolicy,
    },
    delta_from_initial_expectation: ruling.deltaFromInitialExpectation,
    follow_up_execution_requirements: ruling.bindingDirectives ?? [],
  });
}

// ============================================================================
// Durable Governance Ledger Replay & Execution / Pause Gate (§2, §5, §6, §7)
// ============================================================================

export function replayGovernanceState(events = [], taskSeq = 1) {
  const disputes = new Map();
  const conferences = new Map();
  const advisoryNotes = [];
  const activeDirectives = new Map(); // disputeId -> directive record
  const concludedConferenceIds = new Set();
  const deferredSupervisions = new Map(); // dedupeKey -> deferred supervision record
  let completedSupervisionCount = 0;
  let pausingConference = null;
  let activeConferenceId = null;
  let activeHumanEscalation = null;
  let inFlightPhase = null; // 'supervising' | 'caucus' | null

  for (const ev of Array.isArray(events) ? events : []) {
    if ((ev.taskSeq ?? 1) !== taskSeq) continue;

    if (ev.type === 'supervision-started') {
      inFlightPhase = 'supervising';
    } else if (ev.type === 'supervision-deferred') {
      if (inFlightPhase === 'supervising') inFlightPhase = null;
      const key = ev.dedupeKey ?? ev.supervisionId;
      if (key) {
        let prev = deferredSupervisions.get(key);
        if (!prev && ev.logicalSlotKey) {
          for (const [oldKey, oldVal] of deferredSupervisions.entries()) {
            if (oldVal.logicalSlotKey === ev.logicalSlotKey) {
              prev = oldVal;
              deferredSupervisions.delete(oldKey);
            }
          }
        }
        // Only carry cached partial opinion forward when exact content-hashed `dedupeKey` matches
        const sameSnapshot = prev?.dedupeKey === key;
        const opinionA = ev.opinionA ?? (sameSnapshot ? prev?.opinionA : null) ?? null;
        const opinionB = ev.opinionB ?? (sameSnapshot ? prev?.opinionB : null) ?? null;
        deferredSupervisions.set(key, {
          supervisionId: ev.supervisionId,
          dedupeKey: key,
          logicalSlotKey: ev.logicalSlotKey ?? prev?.logicalSlotKey ?? null,
          phaseKind: ev.phaseKind ?? prev?.phaseKind ?? 'execution',
          stageId: ev.stageId ?? prev?.stageId ?? null,
          targetLabel: ev.targetLabel ?? ev.stageId ?? prev?.targetLabel ?? 'task',
          targets: ev.targets ?? prev?.targets ?? [],
          disputeId: ev.disputeId ?? prev?.disputeId ?? null,
          isStage4ReReview: Boolean(ev.isStage4ReReview ?? prev?.isStage4ReReview),
          hasValidOpinionA: Boolean(opinionA),
          hasValidOpinionB: Boolean(opinionB),
          opinionA,
          opinionB,
          errorA: opinionA ? null : (ev.errorA ?? (sameSnapshot ? prev?.errorA : null) ?? 'reviewer_a_unavailable'),
          errorB: opinionB ? null : (ev.errorB ?? (sameSnapshot ? prev?.errorB : null) ?? 'reviewer_b_unavailable'),
          retrySpec: ev.retrySpec ?? prev?.retrySpec ?? null,
          at: ev.at ?? null,
        });
      }
    } else if (ev.type === 'supervision-completed') {
      if (inFlightPhase === 'supervising') inFlightPhase = null;
      completedSupervisionCount++;
      if (ev.dedupeKey) deferredSupervisions.delete(ev.dedupeKey);
      for (const oldKey of ev.supersedesDedupeKeys ?? []) {
        if (oldKey) deferredSupervisions.delete(oldKey);
      }
      const supersededIds = new Set([
        ...(ev.supervisionId ? [ev.supervisionId] : []),
        ...(ev.supersedesSupervisionIds ?? []),
      ]);
      for (const [k, v] of deferredSupervisions.entries()) {
        if (supersededIds.has(v.supervisionId) || (ev.logicalSlotKey && v.logicalSlotKey === ev.logicalSlotKey)) {
          deferredSupervisions.delete(k);
        }
      }
      if (ev.advisoryOnly && (ev.advisoryConcerns?.length || ev.advisorySuggestions?.length)) {
        advisoryNotes.push({
          supervisionId: ev.supervisionId,
          targetLabel: ev.targetLabel ?? ev.stageId ?? 'task',
          concerns: ev.advisoryConcerns ?? [],
          suggestions: ev.advisorySuggestions ?? [],
          at: ev.at ?? null,
        });
      }
      if (!ev.unanimousObjection && ev.disputeId && disputes.has(ev.disputeId)) {
        const prev = disputes.get(ev.disputeId);
        disputes.set(ev.disputeId, { ...prev, status: 'settled_after_review' });
      }
    } else if (ev.type === 'dispute-strike-recorded') {
      const chainId = ev.disputeChainId ?? ev.disputeId;
      const priorId = ev.priorChainId ?? ev.priorEpochDisputeId ?? null;
      if (priorId && disputes.has(priorId)) {
        const old = disputes.get(priorId);
        disputes.set(priorId, { ...old, supersededByEpoch: chainId });
        activeDirectives.delete(priorId);
      }
      const existing = disputes.get(chainId);
      const history = [...(existing?.history ?? []), {
        strike: ev.strikeCount,
        at: ev.at ?? null,
        summaryA: ev.summaryA ?? '',
        summaryB: ev.summaryB ?? '',
        action: ev.action,
        ...(ev.continuityVerdict ? { continuityVerdict: ev.continuityVerdict } : {}),
      }];
      disputes.set(chainId, {
        disputeId: chainId,
        disputeChainId: chainId,
        eventId: ev.eventId ?? existing?.eventId ?? null,
        anchorTargets: ev.anchorTargets ?? existing?.anchorTargets ?? ev.targets ?? [],
        behaviorId: ev.behaviorId ?? existing?.behaviorId ?? null,
        behaviorSummary: ev.behaviorSummary ?? existing?.behaviorSummary ?? '',
        taskSeq,
        phaseKind: ev.phaseKind ?? 'execution',
        targets: ev.targets ?? [],
        profile: ev.profile ?? existing?.profile ?? null,
        tools: ev.tools ?? existing?.tools ?? [],
        interfaces: ev.interfaces ?? existing?.interfaces ?? [],
        evidenceSnapshot: ev.evidenceSnapshot ?? existing?.evidenceSnapshot ?? null,
        epoch: ev.chainSeq ?? ev.epoch ?? 1,
        chainSeq: ev.chainSeq ?? ev.epoch ?? 1,
        priorEpochDisputeId: priorId,
        priorChainId: priorId,
        strikeCount: ev.strikeCount,
        lastStrikeAt: ev.at ?? existing?.lastStrikeAt ?? null,
        lastResolvedStrike: existing?.lastResolvedStrike ?? 0,
        status: ev.action === 'escalate_human' ? 'escalated_human' : 'in_caucus',
        history,
        conferences: existing?.conferences ?? [],
      });
    } else if (ev.type === 'caucus-started') {
      inFlightPhase = 'caucus';
    } else if (ev.type === 'caucus-completed') {
      if (inFlightPhase === 'caucus') inFlightPhase = null;
      if (ev.disputeId && disputes.has(ev.disputeId)) {
        const d = disputes.get(ev.disputeId);
        disputes.set(ev.disputeId, {
          ...d,
          lastCaucus: ev.tally,
          ...(ev.tally?.approved ? { status: 'in_conference' } : { status: 'caucus_dismissed', lastResolvedStrike: d.strikeCount }),
        });
      }
    } else if (ev.type === 'conference-pausing') {
      pausingConference = {
        conferenceId: ev.conferenceId,
        disputeId: ev.disputeId,
        strike: ev.strike ?? 1,
        stageId: ev.stageId ?? null,
        targets: ev.targets ?? [],
        targetMemberIds: ev.targetMemberIds ?? [],
        at: ev.at ?? null,
      };
    } else if (ev.type === 'conference-opened') {
      if (pausingConference?.conferenceId === ev.conferenceId) pausingConference = null;
      activeConferenceId = ev.conferenceId;
      conferences.set(ev.conferenceId, {
        conferenceId: ev.conferenceId,
        disputeId: ev.disputeId,
        eventId: ev.eventId ?? null,
        behaviorId: ev.behaviorId ?? null,
        strike: ev.strike ?? 1,
        stageId: ev.stageId ?? null,
        stageHashAtOpen: ev.stageHashAtOpen ?? null,
        targets: ev.targets ?? [],
        profile: ev.profile ?? null,
        tools: ev.tools ?? [],
        interfaces: ev.interfaces ?? [],
        initialExpectation: ev.initialExpectation ?? '',
        opening: ev.opening,
        turns: [],
        pausedMemberIds: ev.pausedMemberIds ?? [],
        openedAt: ev.at ?? null,
        concludedAt: null,
        status: 'open',
        ruling: null,
        stage4Packet: null,
      });
    } else if (ev.type === 'conference-turn') {
      const conf = conferences.get(ev.conferenceId);
      if (conf) {
        conf.turns = [...conf.turns, ev.turn];
      }
    } else if (ev.type === 'conference-concluded') {
      if (pausingConference?.conferenceId === ev.conferenceId) pausingConference = null;
      concludedConferenceIds.add(ev.conferenceId);
      const conf = conferences.get(ev.conferenceId);
      if (conf) {
        conf.status = 'concluded';
        conf.concludedAt = ev.at ?? null;
        conf.ruling = ev.ruling;
        conf.stage4Packet = ev.stage4Packet ?? null;
      }
      if (activeConferenceId === ev.conferenceId) activeConferenceId = null;
      if (ev.disputeId && disputes.has(ev.disputeId)) {
        const d = disputes.get(ev.disputeId);
        disputes.set(ev.disputeId, {
          ...d,
          lastResolvedStrike: Math.max(d.lastResolvedStrike ?? 0, conf?.strike ?? d.strikeCount),
          status: 'conference_concluded',
          conferences: [...(d.conferences ?? []), {
            conferenceId: ev.conferenceId,
            strike: conf?.strike ?? d.strikeCount,
            concludedAt: ev.at ?? null,
            ruling: ev.ruling,
            stage4Packet: ev.stage4Packet ?? null,
          }],
        });
      }
      if (ev.ruling?.decision === 'overturn_objection') {
        activeDirectives.delete(ev.disputeId);
      } else if (ev.ruling) {
        activeDirectives.set(ev.disputeId, {
          disputeId: ev.disputeId,
          conferenceId: ev.conferenceId,
          concludedAt: ev.at ?? null,
          stageId: conf?.stageId ?? ev.stageId ?? null,
          stageHashAtRuling: ev.stageHashAtRuling ?? conf?.stageHashAtOpen ?? null,
          targets: conf?.targets ?? ev.targets ?? [],
          decision: ev.ruling.decision,
          rulingSummary: ev.ruling.rulingSummary,
          directives: ev.ruling.bindingDirectives ?? [],
          blockedTargets: ev.ruling.blockedTargets ?? [],
          memberResumePolicy: ev.ruling.memberResumePolicy ?? 'resume_all',
          satisfied: false,
        });
      }
    } else if (ev.type === 'arbiter-directive-satisfied') {
      activeDirectives.delete(ev.disputeId);
    } else if (ev.type === 'human-escalation-opened') {
      pausingConference = null;
      activeHumanEscalation = {
        escalationId: ev.escalationId,
        disputeId: ev.disputeId,
        eventId: ev.eventId ?? null,
        behaviorId: ev.behaviorId ?? null,
        strike: ev.strike ?? 3,
        targets: ev.targets ?? [],
        stageId: ev.stageId ?? null,
        summary: ev.summary ?? '',
        dossier: ev.dossier ?? {},
        pausedMemberIds: ev.pausedMemberIds ?? [],
      };
    } else if (ev.type === 'human-escalation-resolved') {
      if (ev.escalationId) concludedConferenceIds.add(ev.escalationId);
      if (!ev.escalationId || activeHumanEscalation?.escalationId === ev.escalationId) {
        if (activeHumanEscalation?.disputeId) activeDirectives.delete(activeHumanEscalation.disputeId);
        activeHumanEscalation = null;
      }
    }
  }

  const activeConference = activeConferenceId ? conferences.get(activeConferenceId) ?? null : null;
  const phase = activeHumanEscalation
    ? 'human_escalation'
    : activeConference
      ? 'formal_conference'
      : pausingConference
        ? 'pausing_for_conference'
        : inFlightPhase ?? 'normal';

  return {
    taskSeq,
    eventsCount: Array.isArray(events) ? events.length : 0,
    phase,
    completedSupervisionCount,
    pendingSupervisions: [...deferredSupervisions.values()],
    pausingConference,
    activeConference,
    activeHumanEscalation,
    concludedConferenceIds: [...concludedConferenceIds],
    activeDirectives: [...activeDirectives.values()].filter(d => !d.satisfied),
    advisoryNotes: advisoryNotes.slice(-6),
    disputes: [...disputes.values()],
    conferences: [...conferences.values()],
  };
}

/**
 * Enforce constitutional governance holds (§2, §5, §6, §7):
 * - Reviewers NEVER block anything.
 * - Stage 1 (`supervising`) and Stage 2 (`caucus`) NEVER block anything.
 * - Pre-Conference Pause Barrier (`pausing_for_conference`) & Stage 3 (`formal_conference`):
 *   - Blocks Leader `team_dispatch`, `send_message`, AND `team_direct_exec` (direct_exec has NO power to execute during conferences!).
 *   - Subagents (`member` / `direct_exec`) marked `pausingForActiveConference` are blocked on ALL tools so they immediately
 *     write their handoff checkpoint (`STOPPED_AT`, `COMPLETED_SO_FAR`, `RESUME_PLAN`, `STATUS: paused`) and stop.
 * - Active Arbiter `blocked_targets` (`enforce_correction`):
 *   - Blocks re-dispatching an unamended stage contract (`stage.hash === dir.stageHashAtRuling`) on the blocked target;
 *     once the stage contract is amended (or remediated via a dedicated fix dispatch / post-conference `team_direct_exec`),
 *     execution is allowed while the directive itself remains active until verified!
 * - Strike 3 (`human_escalation`):
 *   - Blocks `team_dispatch`, `send_message`, and `team_direct_exec` until the User resolves the dispute.
 */
export function checkGovernanceExecutionGate(govState, actor, tool, args = {}, stage = null, platform = process.platform) {
  if (!govState || !actor) return undefined;

  if ((actor.role === 'member' || actor.role === 'direct_exec') && actor.pausingForActiveConference) {
    return {
      rule: 'conference-checkpoint-pause',
      reason: `Immediate governance checkpoint pause (${actor.pausedByConferenceId ?? 'conference'}): STOP immediately. Do NOT finish your current subtask and call ZERO tools. End this turn NOW outputting ONLY: STOPPED_AT: <exact file/step>, COMPLETED_SO_FAR: <completed ops>, RESUME_PLAN: <exact next step>, and STATUS: paused.`,
    };
  }

  if (actor.role === 'leader') {
    if (govState.activeHumanEscalation && ['team_dispatch', 'send_message', 'team_direct_exec'].includes(tool)) {
      const esc = govState.activeHumanEscalation;
      return {
        rule: 'human-escalation-pending',
        reason: `3rd unanimous dispute objection (${esc.disputeId}) has escalated to Human decision. Execution dispatches and team_direct_exec are paused until the user responds; declare team_status(stop_state="waiting_user", ...) and present the dispute dossier to the user.`,
      };
    }
    if ((govState.pausingConference || govState.activeConference) && ['team_dispatch', 'send_message', 'team_direct_exec'].includes(tool)) {
      const conf = govState.activeConference ?? govState.pausingConference;
      const stateDesc = govState.activeConference
        ? `Formal Arbiter–Leader conference "${conf.conferenceId}" is in session`
        : `Waiting for active execution models to checkpoint and pause before opening Formal Conference "${conf.conferenceId}"`;
      return {
        rule: 'arbiter-conference-active',
        reason: `${stateDesc}. All execution dispatches (team_dispatch, send_message, and team_direct_exec) are suspended during the conference; use read-only inspection if needed and respond to the Arbiter via team_conference(action="respond", conference_id="${conf.conferenceId}", ...).`,
      };
    }
    if (tool === 'team_dispatch' && govState.activeDirectives?.length > 0) {
      const candidateScopes = (stage?.contract?.write_scope ?? args?.write_scope ?? []).map(g => {
        try { return normalizeGlob(g, platform); } catch { return null; }
      }).filter(Boolean);
      const candidateStageId = stage?.id ?? args?.stage_id ?? null;
      for (const dir of govState.activeDirectives) {
        if (!dir.blockedTargets?.length) continue;
        const stageBlocked = Boolean(candidateStageId && dir.blockedTargets.includes(candidateStageId));
        const validBlockedGlobs = dir.blockedTargets
          .map(g => { try { return normalizeGlob(g, platform); } catch { return null; } })
          .filter(Boolean);
        const globBlocked = candidateScopes.length > 0
          && validBlockedGlobs.length > 0
          && anyGlobOverlaps(candidateScopes, validBlockedGlobs, platform);

        // If `blockedTargets` was non-empty on the directive yet every entry failed resolution (`!stageBlocked && validBlockedGlobs.length === 0`),
        // NEVER silently drop the hold — fall back to the conference's disputed `stageId` / `targets`, or fail-closed on unamended stages!
        let fallbackBlocked = false;
        if (!stageBlocked && validBlockedGlobs.length === 0) {
          const fallbackStageHit = Boolean(candidateStageId && dir.stageId && candidateStageId === dir.stageId);
          const fallbackTargetGlobs = (dir.targets ?? [])
            .map(g => { try { return normalizeGlob(g, platform); } catch { return null; } })
            .filter(Boolean);
          const fallbackGlobHit = candidateScopes.length > 0
            && fallbackTargetGlobs.length > 0
            && anyGlobOverlaps(candidateScopes, fallbackTargetGlobs, platform);
          fallbackBlocked = fallbackStageHit
            || fallbackGlobHit
            || (!dir.stageId && fallbackTargetGlobs.length === 0);
        }

        if (!stageBlocked && !globBlocked && !fallbackBlocked) continue;

        // Block re-dispatching the UNCHANGED stage contract (or identical unamended stageId);
        // once the Leader amends the stage contract (`stage.hash !== dir.stageHashAtRuling`) or dispatches a new remediation stage,
        // allow the remediation member to run while keeping `dir` active until remediation is verified!
        const unamendedBlockedStage = stage
          ? (dir.stageHashAtRuling ? stage.hash === dir.stageHashAtRuling : (stageBlocked || fallbackBlocked))
          : !dir.stageId;
        if (unamendedBlockedStage) {
          return {
            rule: 'arbiter-intervention',
            reason: `Independent Arbiter ruling (${dir.conferenceId}) requires corrective changes before dispatching this unamended target: ${dir.directives.join('; ')}. Amend the stage contract with team_plan(action="stage", ...) to incorporate the directive (or execute the fix via team_direct_exec) first.`,
          };
        }
      }
    }
  }

  return undefined;
}
