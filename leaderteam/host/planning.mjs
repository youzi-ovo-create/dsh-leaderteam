// Background stage execution reviews and live frontier context. Review jobs never occupy a leader tool turn.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { frontierView, frontierNeedsPlanning, stageApproval } from '../core/frontier.mjs';
import { isAutonomousGovernance } from '../core/governance-protocol.mjs';
import { baseRuntime } from './runtime.mjs';

function mayWake(agent) {
  if (agent?.status !== 'idle' || typeof agent.followup !== 'function') return false;
  const events = agent.session?.snapshotEvents?.() ?? [];
  const end = events.findLast(e => e.type === 'turn/end');
  return !['aborted', 'interrupted', 'cancelled'].includes(end?.data?.reason?.kind);
}
function wake(rt, agent, text, teamId, taskSeq) {
  if (rt.currentPlanningTaskSeq && rt.currentPlanningTaskSeq(teamId) !== taskSeq) return;
  if (!mayWake(agent)) return;
  const input = { content: [{ type: 'text', text }], source: { kind: 'leaderteam-planning', form: 'notice' } };
  agent.followup(rt.createUserMessage ? rt.createUserMessage(input) : { ...input, id: randomUUID(), role: 'user' });
}

export function queueExecutionReview(rt, store, taskSeq, agent, stage, args, run) {
  if (rt.planningDisposed) throw new Error('planning runtime is disposed');
  if (!args.resume_id && args.kind !== 'plan') throw new Error('stage execution review requires explicit kind="plan"; correct the arguments and retry. No review was queued.');
  if (!args.resume_id && (typeof args.topic !== 'string' || !args.topic.trim())) throw new Error('stage execution review requires a non-empty topic; correct the arguments and retry. No review was queued.');
  const approved = stageApproval(store, taskSeq, stage);
  if (approved && !args.resume_id) return { status: 'settled', stage_id: stage.id, id: approved, outcome: { decision: 'approve' }, existing: true };
  const events = store.workflowEvents();
  const prior = events.findLast(e => e.type === 'execution-review-queued' && e.taskSeq === taskSeq && e.stageHash === stage.hash && e.stageId === stage.id && e.resumeId === (args.resume_id ?? null) && e.revises === (args.revises ?? null) && !events.some(r => r.type === 'execution-review-result' && r.reviewId === e.reviewId && r.result?.status === 'error' && !r.result.id));
  const result = prior && events.findLast(e => e.type === 'execution-review-result' && e.reviewId === prior.reviewId);
  if (result) return { status: result.result.status, review_id: prior.reviewId, stage_id: stage.id, ...result.result };
  const reviewId = prior?.reviewId ?? `execution-${randomUUID()}`;
  const key = `${store.dir}:${reviewId}`;
  rt.executionReviewJobs ??= new Map();
  if (rt.executionReviewJobs.has(key)) return { status: 'reviewing', review_id: reviewId, stage_id: stage.id, instruction: 'Keep planning the next stage. Approval is required only before dispatch.' };
  if (!prior) store.appendWorkflowEvent({ type: 'execution-review-queued', taskSeq, reviewId, stageId: stage.id, stageHash: stage.hash, stage, args, resumeId: args.resume_id ?? null, revises: args.revises ?? null });
  const logicalTeamId = store.rawTeamId ?? store.teamId;
  const controller = new AbortController(), work = { teamId: logicalTeamId, controller, promise: null };
  rt.executionReviewJobs.set(key, work);
  work.promise = Promise.resolve().then(() => run(controller.signal)).then(value => {
    if (controller.signal.aborted) return; // interrupted work remains recoverable; it cannot publish a late approval
    store.appendWorkflowEvent({ type: 'execution-review-result', taskSeq, reviewId, stageId: stage.id, stageHash: stage.hash, result: value });
    wake(rt, agent, `[LeaderTeam execution review ${reviewId}] Stage ${stage.id} version ${stage.revision}: ${JSON.stringify(value)}. Dispatch only this approved version; continue planning future work concurrently.`, logicalTeamId, taskSeq);
  }).catch(e => {
    if (controller.signal.aborted) return;
    store.appendWorkflowEvent({ type: 'execution-review-result', taskSeq, reviewId, stageId: stage.id, stageHash: stage.hash, result: { status: 'error', error: e.message } });
  }).finally(() => { if (rt.executionReviewJobs.get(key) === work) rt.executionReviewJobs.delete(key); });
  return { status: 'reviewing', review_id: reviewId, stage_id: stage.id, stage_hash: stage.hash, instruction: 'Keep planning the next stage now. Read team_plan(action="state") or live context for the approved plan_id; do not use review_id as permission.' };
}

export function formatFrontierContext(store, taskSeq, cfg = null) {
  const autonomous = isAutonomousGovernance(cfg);
  const v = frontierView(store, taskSeq, { autonomous });
  const doc = fileURLToPath(new URL('../../docs/HeLuoDoc/V2.1/INDEX.md', import.meta.url));
  if (!v.overview) return `LeaderTeam rolling planning: first record a compact task overview, approach, acceptance and time estimate with team_plan(action="overview"). Do not wait to design the entire project before this first useful output. Optional read-only HeLuo Doc: ${doc}`;
  const feedback = v.reviews.slice(-4).map(e => {
    const r = e.result ?? {}, o = r.outcome;
    const outcome = o ? Object.fromEntries(Object.entries(o).filter(([key]) => ['decision', 'by', 'round', 'adopted', 'requiredChanges', 'required_changes', 'changeItems', 'change_items', 'conditions'].includes(key))) : undefined;
    if (outcome && o.serialProof?.reason) outcome.serial_justification_reason = o.serialProof.reason;
    return { type: e.type, review_id: e.reviewId, revision: e.revision, stage_id: e.stageId, ...(e.stageHash ? { stage_hash: e.stageHash, current_stage_version: v.stages.some(s => s.stage_id === e.stageId && s.hash === e.stageHash) } : {}), result: { status: r.status, id: r.id, outcome, error: r.error, degraded_roles: r.degraded_roles } };
  });
  const remaining = { missing_stage_ids: v.overview.future_work.filter(id => !v.stages.some(s => s.stage_id === id)), provisional_stage_ids: v.stages.filter(s => !s.ready).map(s => s.stage_id) };
  if (autonomous) {
    const next = v.stages.length === 0
      ? 'Autonomous progressive planning: define ONLY the first executable stage(s) (`ready=true` for their own boundary; leave downstream stages in `future_work` or `ready=false`) and call `team_dispatch` immediately — do NOT wait to design every future stage up front.'
      : frontierNeedsPlanning(store, taskSeq)
        ? 'Autonomous execution mode: dispatch ready stages (`ready_to_dispatch`) immediately with `team_dispatch` WITHOUT waiting for `plan_id` or Dual Reviewers; Dual Reviewers supervise asynchronously in the background. Elaborate remaining future stages incrementally while members run.'
        : 'Autonomous execution mode: dispatch any unblocked `ready_to_dispatch` stage immediately with `team_dispatch` (or use `team_direct_exec` for workspace-confined checks/fixes). If dependencies, write scopes or capacity block remaining dispatches, declare `team_status(stop_state="waiting_members")` once and END THIS TURN.';
    const stages = v.stages.map(({ verification, ...stage }) => ({ ...stage, ...(verification && { verification_state: verification.status }) }));
    return `LeaderTeam rolling planning revision ${v.revision}:\n` + JSON.stringify({ stages, remaining_planning: remaining, ...(feedback.length ? { recent_feedback: feedback } : {}) }) + '\n' + next + ' `member_done` records member completion; verify actual behavior before final delivery.';
  }
  const next = frontierNeedsPlanning(store, taskSeq)
    ? 'Keep planning useful later work while A is pending review or running. The remaining_planning ids identify exactly what is missing. If a future_work id was renamed or became obsolete, update the overview explicitly instead of inventing filler work or repeatedly polling status.'
    : 'No provisional or missing future stages remain. Dispatch any unblocked approved work. If dependencies, write scopes or capacity block every remaining dispatch, declare the genuine wait once with team_status and END THIS TURN with a brief final message; completion/review notices will wake you. Do not poll team_status or repeat waiting declarations.';
  const stages = v.stages.map(({ verification, ...stage }) => ({ ...stage, ...(verification && { verification_state: verification.status }) }));
  return `LeaderTeam rolling planning revision ${v.revision}:\n` + JSON.stringify({ stages, remaining_planning: remaining, pending_execution_reviews: v.pending_execution_reviews, recent_feedback: feedback }) + '\n' + next + ' This is the host-derived current checkpoint, refreshed after compaction. Use execution_state and current plan_id rather than re-deriving state from old conversations or archived plan copies. member_done records a member completion, not final acceptance. approved_unassigned still requires ordinary dispatch safety/capacity checks. Historical feedback marked current_stage_version=false is not current execution approval; its unresolved requirements still need reconciliation. An approved plan_id covers only its stage/version. Full review rationales remain in the agreement ledger/team_status; do not reload them without a concrete decision need.';
}
export function disposePlanning(rt) {
  rt.planningDisposed = true;
  for (const work of rt.executionReviewJobs?.values() ?? []) work.controller.abort();
  rt.executionReviewJobs?.clear();
  const base = baseRuntime(rt);
  for (const job of base.governanceJobs?.values() ?? []) job.controller?.abort?.();
  base.governanceJobs?.clear?.();
  base.inFlightSupervisionKeys?.clear?.();
  base.partialSupervisionOpinions?.clear?.();
  base.supervisedDigests?.clear?.();
}
