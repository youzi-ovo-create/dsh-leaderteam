// One synchronous admission check for new dispatches and native member reactivations.
import { anyGlobOverlaps } from '../core/paths.mjs';
import { agreementSnapshots, activeApprovedPlanIds, assertValidPlanAgreement } from '../core/plan-state.mjs';
import { validateExecutionChoice } from '../core/models.mjs';
import { baseRuntime } from './runtime.mjs';
import { assertStageApproval, requireReadyStage, stageApproval, frontierState } from '../core/frontier.mjs';
import { assertRecoveryStrategy } from '../core/execution-recovery.mjs';
import { isAutonomousGovernance, replayGovernanceState, checkGovernanceExecutionGate } from '../core/governance-protocol.mjs';

export const ACTIVE_MEMBER_STATUSES = new Set(['starting', 'started', 'running']);

export function activationConfig(rt, store, cfg) {
  const base = baseRuntime(rt);
  const coherent = base.schedulerStorageRef === base.storageRoot && base.schedulerConfigRef === base.config && cfg.team.maxActiveMembers === base.config.team.maxActiveMembers;
  const limit = rt.activationLimit?.(store.teamId) ?? (coherent ? rt.scheduler?.currentUserMaxForTeam?.(store.teamId)?.max : undefined);
  return Number.isInteger(limit) ? { ...cfg, team: { ...cfg.team, maxActiveMembers: limit } } : cfg;
}

export function assertActivationAdmission(store, cfg, candidate, platform = process.platform) {
  const members = [...store.members().values()];
  const others = members.filter(m => m.childId !== candidate.childId);
  const activeAll = others.filter(m => ACTIVE_MEMBER_STATUSES.has(m.status));
  const activeOrdinary = activeAll.filter(m => m.actorRole !== 'direct_exec');
  const existing = candidate.childId && members.find(m => m.childId === candidate.childId);
  const sameName = others.find(m => m.actorRole !== 'direct_exec' && m.name === candidate.name && ((m.taskSeq ?? 1) === candidate.taskSeq || ACTIVE_MEMBER_STATUSES.has(m.status)) && !['failed', 'cancelled'].includes(m.status));
  if (sameName && candidate.actorRole !== 'direct_exec') {
    throw new Error(ACTIVE_MEMBER_STATUSES.has(sameName.status) ? `member name "${candidate.name}" is currently active in this team` : `member name "${candidate.name}" is already used by another member in this task`);
  }
  if (candidate.actorRole !== 'direct_exec' && !ACTIVE_MEMBER_STATUSES.has(existing?.status) && Number.isInteger(cfg.team.maxActiveMembers) && activeOrdinary.length >= cfg.team.maxActiveMembers) {
    throw new Error(`active member limit ${cfg.team.maxActiveMembers} reached; wait for running members to finish`);
  }
  const conflict = activeAll.find(m => anyGlobOverlaps(m.writeScope ?? [], candidate.writeScope ?? [], platform));
  if (conflict) throw new Error(`write_scope ${JSON.stringify(candidate.writeScope)} overlaps active running member "${conflict.name}" (child_id="${conflict.childId}", write_scope=${JSON.stringify(conflict.writeScope)}); wait for that member to finish or use disjoint write scopes`);
}

export function resolveSendMessageTargetId(store, args, taskSeq = null) {
  if (args && typeof args === 'object' && args.agent_id === undefined && typeof args.agent === 'string') {
    const ref = args.agent;
    const direct = store.getMember(ref);
    if (direct && direct.actorRole !== 'direct_exec') return direct.childId;
    const ordinary = [...store.members().values()].filter(m => m.actorRole !== 'direct_exec');
    if (Number.isInteger(taskSeq)) {
      const currentByHostName = ordinary.findLast(m => (m.taskSeq ?? 1) === taskSeq && m.hostAgentName === ref);
      if (currentByHostName) return currentByHostName.childId;
      const currentTaskHit = ordinary.findLast(
        m => (m.taskSeq ?? 1) === taskSeq && m.name === ref && m.status !== 'failed' && m.status !== 'cancelled',
      );
      if (currentTaskHit) return currentTaskHit.childId;
    }
    const byHostName = ordinary.findLast(m => m.hostAgentName === ref);
    if (byHostName) return byHostName.childId;
    const byName = ordinary.findLast(
      m => m.name === ref && m.status !== 'failed' && m.status !== 'cancelled',
    ) ?? ordinary.findLast(
      m => m.name === ref,
    );
    return byName ? byName.childId : ref;
  }
  return args?.agent_id;
}

export function resumeAdmission(store, cfg, targetId, taskSeq) {
  if (typeof targetId !== 'string') throw new Error('send_message requires a team member agent_id');
  const member = store.getMember(targetId);
  if (!member || member.actorRole === 'direct_exec') {
    const byName = [...store.members().values()].findLast(m => m.actorRole !== 'direct_exec' && m.name === targetId);
    const hint = byName?.childId ? ` (pass agent_id="${byName.childId}" instead of member name "${targetId}")` : '';
    throw new Error(`send_message target is not a member of this team${hint}`);
  }
  const autonomous = isAutonomousGovernance(cfg);
  if (autonomous) {
    const gov = replayGovernanceState(store.governanceEvents?.() ?? [], taskSeq);
    const gateCheck = checkGovernanceExecutionGate(gov, { role: 'leader' }, 'send_message', { agent_id: targetId, stage_id: member.stageId });
    if (gateCheck) throw new Error(gateCheck.reason);
  }
  const candidate = { ...member, taskSeq };
  assertActivationAdmission(store, cfg, candidate);
  const choice = validateExecutionChoice(cfg, member.model, member.effort);
  if (!choice.ok) throw new Error(`member cannot resume with its retired or unsupported model: ${choice.error}; dispatch a member from the current execution pool`);
  if (!ACTIVE_MEMBER_STATUSES.has(member.status)) assertRecoveryStrategy(store, candidate);
  let planId = member.planId ?? null;
  if (autonomous) {
    if (cfg.team.rollingPlanning && member.profile !== 'readonly' && member.stageId) {
      requireReadyStage(store, taskSeq, member.stageId);
    }
    return { member, planId };
  }
  if (cfg.team.rollingPlanning && member.profile !== 'readonly') {
    if (!member.stageId) throw new Error('legacy member cannot reactivate in a rolling task without a reviewed stage binding');
    if (ACTIVE_MEMBER_STATUSES.has(member.status) && member.taskSeq === taskSeq && store.loadAgreementInput(planId).stageReview?.hash === member.stageHash) return { member, planId }; // feedback does not expand an already-running snapshot
    if (!ACTIVE_MEMBER_STATUSES.has(member.status) || member.taskSeq !== taskSeq) {
      const stage = requireReadyStage(store, taskSeq, member.stageId);
      planId = stageApproval(store, taskSeq, stage);
      assertStageApproval(store, taskSeq, member.stageId, planId, { hash: member.stageHash });
    }
  }
  if (cfg.team.requirePlanAgreement && !cfg.team.planExemptProfiles.includes(member.profile)) {
    const { states, supersededBy } = agreementSnapshots(store);
    const approved = activeApprovedPlanIds(store, states, supersededBy, taskSeq);
    // Reusing a durable member in a later task requires an actual current approval, just like a fresh dispatch.
    const selected = store.stagnationSelections?.().findLast(s=>s.taskSeq===taskSeq && s.by==='arbiter');
    planId = approved.includes(planId) || (selected && [selected.agreementId,selected.selectedPlanId].includes(planId)) ? planId : approved.at(-1) ?? selected?.agreementId;
    planId = assertValidPlanAgreement(store, planId, taskSeq);
  }
  return { member, planId };
}

/** Whether an approved/ready current stage can actually use a slot now; no reservation or permission is created. */
export function hasAdmissibleFrontierWork(rt, store, cfg, taskSeq) {
  const members = [...store.members().values()], effective = activationConfig(rt, store, cfg);
  const autonomous = isAutonomousGovernance(cfg);
  return [...frontierState(store, taskSeq).stages.values()].some(stage => {
    if (members.some(m => m.actorRole !== 'direct_exec' && m.taskSeq === taskSeq && m.stageId === stage.id && m.stageHash === stage.hash && [...ACTIVE_MEMBER_STATUSES, 'paused', 'done'].includes(m.status))) return false;
    try {
      assertStageApproval(store, taskSeq, stage.id, stageApproval(store, taskSeq, stage), { requireApproval: !autonomous });
      assertActivationAdmission(store, effective, { name: '__admission_probe__', taskSeq, writeScope: stage.contract.write_scope });
      return true;
    } catch { return false; }
  });
}

/** Whether an approved/ready current NON-SHELL stage can actually use a slot now when OS shell sandboxing is broken. */
export function hasAdmissibleNonShellFrontierWork(rt, store, cfg, taskSeq) {
  const members = [...store.members().values()], effective = activationConfig(rt, store, cfg);
  const autonomous = isAutonomousGovernance(cfg);
  const shellTools = new Set(cfg.gate?.shellTools ?? []);
  return [...frontierState(store, taskSeq).stages.values()].some(stage => {
    if (stage.contract?.profile === 'shell' || (stage.contract?.tools ?? []).some(t => shellTools.has(t))) return false;
    if (members.some(m => m.actorRole !== 'direct_exec' && m.taskSeq === taskSeq && m.stageId === stage.id && m.stageHash === stage.hash && [...ACTIVE_MEMBER_STATUSES, 'paused', 'done'].includes(m.status))) return false;
    try {
      assertStageApproval(store, taskSeq, stage.id, stageApproval(store, taskSeq, stage), { requireApproval: !autonomous });
      assertActivationAdmission(store, effective, { name: '__admission_probe__', taskSeq, writeScope: stage.contract.write_scope });
      return true;
    } catch { return false; }
  });
}

/** Whether provisional or overview future_work still lists unfinished non-shell stages (so the team finishes code/docs before stopping on a shell blocker). */
export function hasUnfinishedNonShellPlanWork(store, cfg, taskSeq) {
  const s = frontierState(store, taskSeq);
  if (!s.overview) return false;
  const shellTools = new Set(cfg.gate?.shellTools ?? []);
  const members = [...store.members().values()];
  for (const st of s.stages.values()) {
    const isShellStage = st.contract?.profile === 'shell' || (st.contract?.tools ?? []).some(t => shellTools.has(t));
    if (isShellStage) continue;
    if (!st.contract?.ready) return true;
    const stageDone = members.some(m => m.actorRole !== 'direct_exec' && m.taskSeq === taskSeq && m.stageId === st.id && m.stageHash === st.hash && ['starting', 'started', 'running', 'paused', 'done'].includes(m.status));
    if (!stageDone) return true;
  }
  const SHELL_ONLY_STAGE_ID = /^(?:verify|runtime-verify|smoke|shell-verify|install|deploy)(?:[-_].*)?$/i;
  return (s.overview.future_work ?? []).some(id => !s.stages.has(id) && !SHELL_ONLY_STAGE_ID.test(id));
}

export async function withMemberActivation(rt, store, cfg, targetId, taskSeq, invoke) {
  const { member, planId } = resumeAdmission(store, activationConfig(rt, store, cfg), targetId, taskSeq);
  if (ACTIVE_MEMBER_STATUSES.has(member.status)) return invoke(); // a message to a running member adds no slot
  const reservation = rt.reserveMemberActivation?.(store.teamId, { ...member, taskSeq });
  if (reservation && !reservation.allowed) throw new Error(reservation.reason);
  // No await between checking and reserving: dispatches and other resumes see this slot and write range immediately.
  const actor = rt.actors.get(targetId);
  const previousProgress = rt.memberExecutionProgress?.get(targetId);
  rt.memberExecutionProgress ??= new Map();
  rt.memberExecutionProgress.set(targetId, new Set());
  const rollback = () => {
    if (store.getMember(targetId)?.status === 'starting') {
      store.setMemberBinding(targetId, member.taskSeq ?? 1, member.planId ?? null);
      store.setMemberStatus(targetId, member.status);
      if (previousProgress) rt.memberExecutionProgress.set(targetId, previousProgress);
      else rt.memberExecutionProgress.delete(targetId);
      if (actor) Object.assign(actor, { taskSeq: member.taskSeq ?? 1, planId: member.planId ?? null });
    }
  };
  try {
    store.setMemberBinding(targetId, taskSeq, planId);
    store.setMemberStatus(targetId, 'starting');
    rt.liveProcessMemberIds?.add(targetId);
    if (actor) Object.assign(actor, { taskSeq, planId });
    rt.reads.delete(targetId);
    rt.readProgress?.delete(targetId);
    const result = await invoke();
    if (result?.isError) { rollback(); reservation?.cancel(); }
    else reservation?.commit(rt.activationCapacity?.(store.teamId));
    return result;
  } catch (error) { rollback(); reservation?.cancel(); throw error; }
}
