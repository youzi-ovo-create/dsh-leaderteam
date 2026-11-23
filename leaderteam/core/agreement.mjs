// Symmetric two-member agreement protocol. Pure reducer + prompt builders + parsers.
// Rules: each round both members (A, B) give an independent opinion; same stance => settled by consensus;
// after maxRounds unsettled rounds the arbiter rules ONCE by adopting A's or B's final opinion (no own proposal or reasons).
import { LtError, STANCES, AGREEMENT_KINDS } from './constants.mjs';
import { extractJsonObjectText } from './gate-policy.mjs';
import { truncate } from './redact.mjs';
export { normalizeReview } from './review-policy.mjs';
function reviewExtras(o) { return { ...(o.changeItems ? { changeItems: structuredClone(o.changeItems) } : {}), ...(o.conditions ? { conditions: [...o.conditions] } : {}), ...(o.resolutions ? { resolutions: structuredClone(o.resolutions) } : {}), ...(o.invalid ? { invalid: true } : {}) }; }
function combinedExtras(a,b) { return { ...((a.changeItems || b.changeItems) ? { changeItems:[...(a.changeItems??[]),...(b.changeItems??[])] } : {}), ...((a.conditions || b.conditions) ? { conditions:dedupe([...(a.conditions??[]),...(b.conditions??[])]) } : {}) }; }

const MEMBERS = ['A', 'B'];

export function initialState(created) {
  if (!created || created.type !== 'created') throw new LtError('AGREEMENT_EVENT', 'first event must be "created"');
  if (!AGREEMENT_KINDS.includes(created.kind)) throw new LtError('AGREEMENT_EVENT', `unknown kind ${created.kind}`);
  if (!Number.isInteger(created.maxRounds) || created.maxRounds < 1) throw new LtError('AGREEMENT_EVENT', 'maxRounds must be a positive integer');
  if (!Number.isInteger(created.maxArbiterAttempts) || created.maxArbiterAttempts < 1) throw new LtError('AGREEMENT_EVENT', 'maxArbiterAttempts must be a positive integer');
  const taskSeq = Number.isInteger(created.taskSeq) && created.taskSeq >= 1 ? created.taskSeq : 1;
  return Object.freeze({
    id: created.id, topic: created.topic, kind: created.kind, proposalHash: created.proposalHash,
    maxRounds: created.maxRounds, maxArbiterAttempts: created.maxArbiterAttempts,
    taskSeq, activeTaskSeq: taskSeq,
    revises: typeof created.revises === 'string' ? created.revises : null,
    rounds: Object.freeze([]), arbiterAttempts: 0, ruling: null, outcome: null, status: 'open',
    ...(created.serialProofRequired ? { serialProofRequired: true, serialReviews: [], pendingOutcome: null } : {}),
  });
}

/** The round that currently accepts opinions, or null when none does. */
export function currentRound(state) {
  if (state.status !== 'open') return null;
  const last = state.rounds.at(-1);
  if (last && (last.A === null || last.B === null)) return last.n;
  if (last && (last.A?.invalid || last.B?.invalid)) return null;
  const n = state.rounds.length + 1;
  return n <= state.maxRounds ? n : null;
}
function arbiterNeeded(state) {
  return state.status === 'open' && (state.rounds.length === state.maxRounds || state.rounds.at(-1)?.A?.invalid || state.rounds.at(-1)?.B?.invalid) && state.rounds.at(-1).A !== null && state.rounds.at(-1).B !== null;
}

export function applyEvent(state, ev) {
  if (!ev || ev.id !== state.id) throw new LtError('AGREEMENT_EVENT', 'event belongs to another agreement');
  const activeTaskSeq = Number.isInteger(ev.taskSeq) && ev.taskSeq >= 1 ? ev.taskSeq : state.activeTaskSeq;
  switch (ev.type) {
    case 'opinion': {
      const n = currentRound(state);
      if (n === null || ev.round !== n) throw new LtError('AGREEMENT_EVENT', `opinion for round ${ev.round} not accepted (current: ${n})`);
      if (!MEMBERS.includes(ev.member)) throw new LtError('AGREEMENT_EVENT', `unknown member ${ev.member}`);
      assertOpinion(ev.opinion);
      const normalizedOpinion = Object.freeze({
        ...reviewExtras(ev.opinion),
        stance: ev.opinion.stance,
        summary: ev.opinion.summary,
        reasons: Object.freeze([...ev.opinion.reasons]),
        requiredChanges: Object.freeze([...ev.opinion.requiredChanges]),
        suggestions: Object.freeze([...(ev.opinion.suggestions ?? [])]),
      });
      const rounds = [...state.rounds];
      let r = rounds.at(-1);
      if (!r || r.n !== n) { r = { n, A: null, B: null }; rounds.push(r); } else { r = { ...r }; rounds[rounds.length - 1] = r; }
      if (r[ev.member] !== null) throw new LtError('AGREEMENT_EVENT', `member ${ev.member} already answered round ${n}`);
      r[ev.member] = normalizedOpinion;
      Object.freeze(r);
      let next = { ...state, activeTaskSeq, rounds: Object.freeze(rounds) };
      if (r.A !== null && r.B !== null && !r.A.invalid && !r.B.invalid && r.A.stance === r.B.stance) {
        const requiredChanges = r.A.stance === 'revise' ? dedupe([...r.A.requiredChanges, ...r.B.requiredChanges]) : [];
        const reasons = dedupe([...r.A.reasons, ...r.B.reasons]);
        const suggestions = dedupe([...(r.A.suggestions ?? []), ...(r.B.suggestions ?? [])]);
        next = {
          ...next,
          status: 'settled',
          outcome: Object.freeze({
            ...combinedExtras(r.A,r.B),
            decision: r.A.stance,
            by: 'consensus',
            round: n,
            reasons: Object.freeze(reasons),
            suggestions: Object.freeze(suggestions),
            requiredChanges: Object.freeze(requiredChanges),
          }),
        };
      }
      if (next.serialProofRequired && next.outcome?.decision === 'approve') next = awaitSerialProof(next);
      return Object.freeze(next);
    }
    case 'serial-proof': {
      if (state.status !== 'serial-review' || !ev.proof || !['proven','not_proven'].includes(ev.proof.verdict)) throw new LtError('AGREEMENT_EVENT', 'serial proof is not expected');
      if (!Array.isArray(ev.proof.responsibilities) || !ev.proof.responsibilities.length || !ev.proof.reason || !Array.isArray(ev.proof.proof) || (ev.proof.verdict === 'proven' && !ev.proof.proof.length)) throw new LtError('AGREEMENT_EVENT', 'serial proof lacks responsibilities or evidence');
      const serialReviews = [...state.serialReviews, { round: state.rounds.length, proof: structuredClone(ev.proof) }];
      if (ev.proof.verdict === 'proven') return Object.freeze({ ...state, activeTaskSeq, serialReviews, status: 'settled', outcome: { ...state.pendingOutcome, serialProof: structuredClone(ev.proof) }, pendingOutcome: null });
      if (!ev.proof.feedback?.length) throw new LtError('AGREEMENT_EVENT', 'serial challenge requires feedback');
      // Both reviewers must reconsider the challenge; their earlier approve is never executable.
      if (state.rounds.length < state.maxRounds) return Object.freeze({ ...state, activeTaskSeq, serialReviews, status: 'open', outcome: null, pendingOutcome: null, ruling: null, arbiterAttempts: 0 });
      return Object.freeze({ ...state, activeTaskSeq, serialReviews, status: 'settled', pendingOutcome: null, outcome: { decision: 'revise', by: 'serial-review', round: state.rounds.length, reasons: [ev.proof.reason], requiredChanges: [...ev.proof.feedback], suggestions: [] } });
    }
    case 'arbiter-attempt': {
      if (!arbiterNeeded(state) || state.ruling !== null) throw new LtError('AGREEMENT_EVENT', 'arbiter is not needed');
      if (state.arbiterAttempts >= state.maxArbiterAttempts) throw new LtError('AGREEMENT_EVENT', 'arbiter attempts exhausted');
      return Object.freeze({ ...state, activeTaskSeq, arbiterAttempts: state.arbiterAttempts + 1 });
    }
    case 'ruling': {
      if (!arbiterNeeded(state) || state.ruling !== null) throw new LtError('AGREEMENT_EVENT', 'ruling not accepted');
      if (state.arbiterAttempts < 1) throw new LtError('AGREEMENT_EVENT', 'ruling without an arbiter attempt');
      if (!MEMBERS.includes(ev.ruling?.adopt)) throw new LtError('AGREEMENT_EVENT', 'ruling must adopt "A" or "B"');
      const adopted = state.rounds.at(-1)[ev.ruling.adopt];
      if (adopted.invalid) throw new LtError('AGREEMENT_EVENT', 'arbiter cannot adopt an invalid review');
      const next = { ...state, activeTaskSeq, ruling: Object.freeze({ adopt: ev.ruling.adopt }), status: 'settled',
        outcome: Object.freeze({
          ...reviewExtras(adopted),
          decision: adopted.stance,
          by: 'arbiter',
          round: state.maxRounds,
          adopted: ev.ruling.adopt,
          reasons: Object.freeze([...adopted.reasons]),
          suggestions: Object.freeze([...(adopted.suggestions ?? [])]),
          requiredChanges: Object.freeze([...adopted.requiredChanges]),
        }) };
      return Object.freeze(next.serialProofRequired && next.outcome.decision === 'approve' ? awaitSerialProof(next) : next);
    }
    case 'independent-ruling': {
      if (!arbiterNeeded(state) || state.arbiterAttempts < 1 || !(state.rounds.at(-1).A.invalid || state.rounds.at(-1).B.invalid)) throw new LtError('AGREEMENT_EVENT','independent ruling requires an invalid review and arbiter attempt');
      assertOpinion(ev.opinion);
      const next = { ...state, activeTaskSeq, status:'settled', ruling:{independent:true}, outcome:{decision:ev.opinion.stance,by:'arbiter',round:state.rounds.length,reasons:ev.opinion.reasons,suggestions:ev.opinion.suggestions??[],requiredChanges:ev.opinion.requiredChanges,...reviewExtras(ev.opinion)} };
      return Object.freeze(next.serialProofRequired && next.outcome.decision === 'approve' ? awaitSerialProof(next) : next);
    }
    default: throw new LtError('AGREEMENT_EVENT', `unknown event type ${ev.type}`);
  }
}
export function replay(events) {
  if (!Array.isArray(events) || events.length === 0) throw new LtError('AGREEMENT_EVENT', 'no events');
  let s = initialState(events[0]);
  for (const ev of events.slice(1)) s = applyEvent(s, ev);
  return s;
}
/** What to do next: members to ask, the arbiter, or done. 'stalled' when the arbiter attempts are exhausted. */
export function nextAction(state) {
  if (state.status === 'serial-review') return { kind: 'serial-review' };
  if (state.status === 'settled') return { kind: 'settled', outcome: state.outcome };
  const n = currentRound(state);
  if (n !== null) {
    const r = state.rounds.find(x => x.n === n);
    return { kind: 'members', round: n, members: MEMBERS.filter(m => !r || r[m] === null) };
  }
  if (arbiterNeeded(state)) return state.arbiterAttempts < state.maxArbiterAttempts ? { kind: 'arbiter' } : { kind: 'stalled', reason: 'arbiter attempts exhausted without a valid ruling' };
  return { kind: 'stalled', reason: 'no further action is possible' };
}
function dedupe(xs) { const seen = new Set(); return xs.filter(x => { const k = x.trim().toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
function awaitSerialProof(state) { return { ...state, status: 'serial-review', pendingOutcome: state.outcome, outcome: null }; }
function assertOpinion(o) {
  if (!o || !STANCES.includes(o.stance) || typeof o.summary !== 'string' || !Array.isArray(o.reasons) || !Array.isArray(o.requiredChanges) || (o.suggestions !== undefined && !Array.isArray(o.suggestions))) {
    throw new LtError('AGREEMENT_EVENT', 'malformed opinion');
  }
}

const PLACEHOLDER_RE = /^(?:n\/a|none|null|nil|todo|tbd|nothing|无|没有|暂无|同上|略|无建议)[。.!！]?$/iu;
const BARE_REFUSAL_RE = /^(?:(?:我)?(?:一概|一律)?(?:不予?同意|不同意|反对|驳回|拒绝|不通过)|因为[^。；\n]{1,100}[，,]?\s*所以(?:我)?(?:一概|一律)?(?:不予?同意|不同意|反对|驳回|拒绝|不通过)|because\b[^.;\n]{1,140},?\s*(?:so\s+|therefore\s+)?i\s+(?:simply\s+)?(?:disagree|reject|do\s+not\s+agree|refuse)|(?:i\s+)?(?:simply\s+)?(?:disagree|reject|do\s+not\s+agree|refuse))[。.!！]?$/iu;
const VAGUE_CLICHE_SUGGESTION_RE = /^(?:请)?(?:重新设计(?:方案)?|重写(?:方案)?|优化代码(?:质量)?|完善(?:方案|细节)|再想想|自行修改|please\s+redesign(?:\s+it|\s+the\s+plan)?|improve\s+code\s+quality|fix\s+the\s+issues?)[。.!！]?$/iu;

function normalizeComparable(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s,.;:!?，。；：！？'"`()[\]{}-]+/gu, '');
}

export const MEMBER_SYSTEM = [
  'You are one of two independent reviewers (A and B) on an engineering consensus panel. Both reviewers receive the same material and the same instructions.',
  'When execution_stage is present, review only that stage for immediate execution: goal, method, interfaces, acceptance, scope, tools and dependencies. Future stages may remain provisional and are not reasons to delay a ready current stage. Use planning_context and elapsed time as facts, not a deadline. Approval applies only to this stage/version, never to later provisional work.',
  'Stage-scoped review still checks every original user requirement applicable to this execution. A condensed overview or stage contract cannot waive a user constraint. Require revising an omitted or conflicting constraint on current actions; do not accept a future verification stage as a substitute. Leave unrelated future deliverables provisional.',
  'NEVER automatically treat an unsplit parallel opportunity as a planning defect, and NEVER force-split coupled modules (such as compiler passes sharing AST/IR/types, coupled state machines, or cohesive multi-file subsystems) into separate stages just to increase superficial concurrency. Strongly coupled modules are explicitly allowed to be implemented continuously by a single member. Only require splitting when genuinely unrelated, zero-coupling deliverables are bundled in a way that creates a concrete scope or correctness conflict; otherwise note optional parallelism ideas only in reasons or nonblocking conditions, and approve when no functional defect remains.',
  'Check that the granted tools can actually satisfy execution acceptance: writing a test file that calls child_process.spawn does not run it. A stage required to run commands needs an available execution tool such as pwsh/bash; read/edit/write alone only prepare files. If execution must occur in this stage but no execution tool is granted, require correcting the profile/tools or explicitly assign execution to a capable reviewed stage. Never accept source code or static inspection as a completed run.',
  'The user\'s request (user_request) and the attached evidence (requirements, specifications, files, measurements) define the goal and its scope. For kind "plan" and "delivery", judge correctness, completeness against user_request (counting already-completed workspace artifacts documented in proposal/evidence when continuing an in-progress task), risk, maintainability and cost. For scoped kinds ("architecture", "interface", "security-design", "risk"), topic defines a focused technical decision within user_request: judge correctness, completeness for topic, consistency with user_request, risk and maintainability without requiring the proposal to restate unrelated phases of the project. You are not a safety gate and you do not judge tool permissions.',
  'stance "approve" = proceed exactly as proposed; "reject" = do not proceed; "revise" = proceed only after the specific changes you list.',
  'required_changes is only for blocking defects: the proposal contradicts or omits something the user\'s request or the evidence requires, breaks a stated constraint, or carries a concrete correctness, safety or data-loss risk. Do not require details the requirements leave open (implementers decide them), additional hardening, tests or edge cases beyond what is asked, restating what the evidence already specifies, or style. Put optional suggestions in reasons, never in required_changes. Approve when no blocking defect remains.',
  'Accountable review is mandatory: whenever stance is "revise" or "reject", you MUST provide both specific substantive `reasons` AND concrete actionable `suggestions` (specific solutions, implementation fixes, or viable alternatives). Bare refusals such as "because X, I disagree" ("因为…所以我不同意") without a concrete solution are rejected.',
  'When previous_required_changes is not empty, this proposal revises an earlier one: check that each listed change is addressed or shown unnecessary by the requirements. Raise a new required change only for a blocking defect.',
  'From round 2 on you also see your own previous opinion and your peer\'s. Reconsider honestly: change your stance if the other side convinced you, keep it if not. Do not agree just to finish.',
  'For each blocking issue supply change_items: [{id,problem,evidence,suggestion,hard_blocker,category}]. category is safety, data_loss, user_requirement, or ordinary; only the first three may be hard_blocker=true. conditions is an array of nonblocking execution conditions. On revisions reconcile every previous_change_items id in resolutions: [{id,status: resolved|unresolved,evidence}]. New ordinary issues in a revision become conditions instead of restarting review. Consider elapsed time as a factual cost; never relax user constraints because of elapsed time.',
  'Reply with exactly one JSON object and nothing else: {"stance":"approve"|"reject"|"revise","summary":"<= 300 chars","reasons":["..."],"required_changes":["..."],"suggestions":["..."],"change_items":[{"id":"...","problem":"...","evidence":"...","suggestion":"...","hard_blocker":false,"category":"ordinary"}],"conditions":["..."],"resolutions":[{"id":"...","status":"resolved"|"unresolved","evidence":"..."}]}. Whenever previous_change_items is non-empty, "resolutions" MUST list every id from previous_change_items with status "resolved" or "unresolved" and concrete evidence. "required_changes" must be non-empty exactly when stance is "revise", otherwise []. "suggestions" must be non-empty whenever stance is "revise" or "reject" (optional [] when "approve").',
].join('\n');
export const ARBITER_SYSTEM = [
  'You are the independent arbiter of a two-member engineering consensus panel. The members (A and B) did not agree after the maximum number of rounds.',
  'Decide which member\'s FINAL opinion the team adopts: the one that better serves the user\'s request (user_request), the attached evidence, and engineering progress (`project_timer`). Do not reward lazy conservative stonewalling when a proposal safely meets the requirements. Do not write your own proposal, changes or reasons.',
  'Reply with exactly one JSON object and nothing else: {"adopt":"A"} or {"adopt":"B"}.',
].join('\n');

function opinionView(o) {
  return o === null ? null : {
    ...reviewExtras(o),
    stance: o.stance,
    summary: o.summary,
    reasons: o.reasons,
    suggestions: o.suggestions ?? [],
    required_changes: o.requiredChanges,
  };
}

/** input: { state, member:'A'|'B', topic, kind, proposal, evidence, userRequest?, previousRequiredChanges?, projectTimer? } */
export function buildMemberRequest(input) {
  const { state, member } = input;
  const n = currentRound(state);
  if (n === null) throw new LtError('AGREEMENT_STATE', 'no open round');
  const peer = member === 'A' ? 'B' : 'A';
  const prev = n > 1 ? state.rounds.find(r => r.n === n - 1) : null;
  const payload = {
    you_are: member, round: n, max_rounds: state.maxRounds,
    ...(input.stageReview ? { execution_stage: input.stageReview, planning_context: input.planningContext ?? null } : {}),
    user_request: input.userRequest ?? '',
    project_timer: input.projectTimer ?? null,
    topic: input.topic, kind: input.kind, proposal: input.proposal, evidence: input.evidence ?? '',
    ...(input.evidenceTruncated ? { evidence_truncated: true, omitted_or_truncated_files: [...(input.omittedOrTruncatedFiles ?? [])] } : {}),
    previous_change_items: input.previousChangeItems ?? [],
    previous_required_changes: [...(input.previousRequiredChanges ?? [])],
    ...(state.serialReviews?.length ? { serial_review_feedback: state.serialReviews.at(-1).proof, serial_review_instruction: 'Both reviewers must reassess the insufficient serial rationale: supply task-specific truthful grounds or amend the stage. Do not simply repeat approval. You need not split when a proportionate, supported serial rationale exists.' } : {}),
    previous_round: prev ? { yours: opinionView(prev[member]), peer: opinionView(prev[peer]) } : null,
  };
  return { system: MEMBER_SYSTEM, user: JSON.stringify(payload, null, 1) };
}
/** input: { state, topic, kind, proposal, evidence, userRequest?, projectTimer? } */
export function buildArbiterRequest(input) {
  const { state } = input;
  const payload = {
    user_request: input.userRequest ?? '',
    ...(input.stageReview ? { execution_stage: input.stageReview, planning_context: input.planningContext ?? null } : {}),
    project_timer: input.projectTimer ?? null,
    topic: input.topic, kind: input.kind, proposal: input.proposal, evidence: input.evidence ?? '',
    ...(input.evidenceTruncated ? { evidence_truncated: true, omitted_or_truncated_files: [...(input.omittedOrTruncatedFiles ?? [])] } : {}),
    previous_required_changes: [...(input.previousRequiredChanges ?? [])],
    rounds: state.rounds.map(r => ({ round: r.n, A: opinionView(r.A), B: opinionView(r.B) })),
  };
  return { system: ARBITER_SYSTEM, user: JSON.stringify(payload, null, 1) };
}
export function parseMemberOpinion(text) {
  let v;
  try { v = JSON.parse(extractJsonObjectText(text)); } catch { return { ok: false, error: 'opinion is not a JSON object' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'opinion is not a JSON object' };
  const extra = Object.keys(v).filter(k => !['stance', 'summary', 'reasons', 'required_changes', 'suggestions', 'change_items', 'conditions', 'resolutions'].includes(k));
  if (extra.length) return { ok: false, error: `unexpected opinion fields: ${extra.join(', ')}` };
  if (!STANCES.includes(v.stance)) return { ok: false, error: 'stance must be approve, reject or revise' };
  if (typeof v.summary !== 'string' || v.summary.trim() === '') return { ok: false, error: 'summary must be a non-empty string' };
  const strs = x => Array.isArray(x) && x.every(s => typeof s === 'string' && s.trim() !== '');
  if (!strs(v.reasons) || v.reasons.length === 0) return { ok: false, error: 'reasons must be a non-empty array of strings' };
  if (!strs(v.required_changes)) return { ok: false, error: 'required_changes must be an array of strings' };
  if (v.suggestions !== undefined && !strs(v.suggestions)) return { ok: false, error: 'suggestions must be an array of non-empty strings' };
  if (v.stance === 'revise' && v.required_changes.length === 0) return { ok: false, error: 'revise requires required_changes' };
  if (v.stance !== 'revise' && v.required_changes.length > 0) return { ok: false, error: 'required_changes must be empty unless stance is revise' };

  const rawSuggestions = v.suggestions ?? [];
  if (v.stance === 'revise' || v.stance === 'reject') {
    if (BARE_REFUSAL_RE.test(v.summary.trim())) {
      return { ok: false, error: 'accountable review: summary cannot be a bare refusal ("because X, I disagree")' };
    }
    if (v.reasons.some(r => r.trim().length < 4 || PLACEHOLDER_RE.test(r.trim()) || BARE_REFUSAL_RE.test(r.trim()))) {
      return { ok: false, error: 'accountable review: non-approve reasons must state concrete technical grounds (>= 4 chars), not bare disagreement' };
    }
    if (rawSuggestions.length === 0) {
      return { ok: false, error: `accountable review: ${v.stance} requires non-empty suggestions (concrete solutions or viable alternatives)` };
    }
    if (rawSuggestions.some(s => s.trim().length < 6 || PLACEHOLDER_RE.test(s.trim()) || BARE_REFUSAL_RE.test(s.trim()))) {
      return { ok: false, error: 'accountable review: suggestions must contain concrete actionable solutions (>= 6 chars), not placeholders or bare refusals' };
    }
    if (rawSuggestions.every(s => VAGUE_CLICHE_SUGGESTION_RE.test(s.trim()))) {
      return { ok: false, error: 'accountable review: suggestions cannot be generic clichés ("redesign the plan"); provide specific actionable solutions' };
    }
    const reasonNormSet = new Set(v.reasons.map(normalizeComparable));
    if (rawSuggestions.every(s => reasonNormSet.has(normalizeComparable(s)))) {
      return { ok: false, error: 'accountable review: suggestions must provide actionable solutions, not repeat reasons verbatim' };
    }
  }

  return {
    ok: true,
    opinion: {
      stance: v.stance,
      summary: truncate(v.summary.trim(), 300),
      reasons: v.reasons.slice(0, 12).map(s => truncate(s.trim(), 600)),
      requiredChanges: v.required_changes.slice(0, 20).map(s => truncate(s.trim(), 600)),
      suggestions: rawSuggestions.slice(0, 12).map(s => truncate(s.trim(), 600)),
      ...(v.change_items !== undefined ? { changeItems: v.change_items } : {}),
      ...(v.conditions !== undefined ? { conditions: v.conditions } : {}),
      ...(v.resolutions !== undefined ? { resolutions: v.resolutions } : {}),
    },
  };
}
export function parseArbiterRuling(text) {
  let v;
  try { v = JSON.parse(extractJsonObjectText(text)); } catch { return { ok: false, error: 'ruling is not a JSON object' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'ruling is not a JSON object' };
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== 'adopt' || !MEMBERS.includes(v.adopt)) return { ok: false, error: 'ruling must be exactly {"adopt":"A"} or {"adopt":"B"}' };
  return { ok: true, ruling: { adopt: v.adopt } };
}
const DOC_EXT = /\.(?:md|markdown|txt|rst|json|ya?ml|toml)$/i;
/** Workspace-relative or absolute document paths named in the user's request (deduplicated, in order). Pure. */
export function namedDocuments(text) {
  const out = [];
  const push = raw => {
    const t = raw.trim().replace(/[.:,，。、；：！？]+$/u, '');
    if (t && t.length <= 240 && !/[<>|?*\r\n]/.test(t) && DOC_EXT.test(t) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && !out.includes(t)) {
      out.push(t);
    }
  };
  const rest = String(text ?? '').replace(/(["'`])([^"'`\r\n]{1,240})\1/g, (whole, _q, inner) => {
    const cand = inner.trim();
    if (DOC_EXT.test(cand) && !/[<>|?*]/.test(cand) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(cand) && !/^(?:implement|read|see|use|check)\s+/i.test(cand)) {
      push(cand);
      return ' ';
    }
    return whole;
  });
  for (const m of rest.matchAll(/[\p{L}\p{N}_.:\\/\-]+/gu)) {
    const token = m[0].replace(/[.:,，。、；：！？]+$/u, '');
    const cjkPrefixedAscii = token.match(/^\p{Script=Han}+([A-Za-z0-9_:\\/\-][A-Za-z0-9_.:\\/\-]*\.[A-Za-z0-9]+)$/u);
    if (cjkPrefixedAscii) push(cjkPrefixedAscii[1]);
    push(token);
  }
  return out;
}
