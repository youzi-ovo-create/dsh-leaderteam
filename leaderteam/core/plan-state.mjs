// Shared plan-lineage validation for dispatch, resume and status.
import { replay, nextAction } from './agreement.mjs';

export function isTerminalAgreement(state) {
  return Boolean(state) && (state.status === 'settled' || nextAction(state).kind === 'stalled');
}
export function agreementSnapshots(store) {
  const states = new Map();
  const supersededBy = new Map();
  for (const id of store.agreementIds()) {
    try {
      const s = replay(store.agreementEvents(id));
      states.set(id, s);
      if (s.revises && isTerminalAgreement(s)) supersededBy.set(s.revises, id);
    } catch {}
  }
  return { states, supersededBy };
}
export function activeApprovedPlanIds(store, states, supersededBy, taskSeq) {
  const replacedApproved = id => {
    let cur = id;
    const seen = new Set();
    while (supersededBy.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = supersededBy.get(cur);
      const d = states.get(cur)?.outcome?.decision;
      if (d === 'approve' || d === 'reject') return true;
    }
    return false;
  };
  return store.agreementIds().filter(id => {
    const s = states.get(id);
    return s && s.kind === 'plan' && (s.taskSeq ?? 1) === taskSeq && !replacedApproved(id) && s.outcome?.decision === 'approve';
  });
}
export function assertValidPlanAgreement(store, planId, taskSeq) {
  const { states, supersededBy } = agreementSnapshots(store);
  const approvedIds = activeApprovedPlanIds(store, states, supersededBy, taskSeq);
  if (typeof planId !== 'string' || planId.trim() === '') {
    if (approvedIds.length === 0) throw new Error('no approved plan agreement yet: call team_discuss with kind "plan" first, then pass its id as plan_id (readonly scouts are exempt)');
    throw new Error('no approved plan agreement bound: pass plan_id referencing the approved kind "plan" agreement for the current task');
  }
  const target = planId.trim();
  const state = states.get(target);
  const selection = store.stagnationSelections?.().find(s => s.taskSeq === taskSeq && s.by === 'arbiter' && (s.agreementId === target || s.selectedPlanId === target));
  if (selection && state?.kind === 'plan' && state.taskSeq === taskSeq) return target;
  if (!state) throw new Error(`unknown plan_id "${target}": no approved plan agreement with that id`);
  if (state.kind !== 'plan') throw new Error(`plan_id "${target}" is a "${state.kind}" agreement, not "plan"`);
  if ((state.taskSeq ?? 1) !== taskSeq) throw new Error(`plan_id "${target}" belongs to earlier user task #${state.taskSeq ?? 1} (current task is #${taskSeq}); call team_discuss with kind "plan" for the current task`);
  if (supersededBy.has(target) && !approvedIds.includes(target)) throw new Error(`plan_id "${target}" was superseded by "${supersededBy.get(target)}"; pass the latest approved plan_id`);
  if (state.outcome?.decision !== 'approve') throw new Error(`plan_id "${target}" is not approved (status=${state.status}, decision=${state.outcome?.decision ?? 'none'}): no approved plan agreement`);
  return target;
}
