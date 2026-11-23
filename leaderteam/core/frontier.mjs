// Rolling planning state: durable increments, immutable stage contracts and scoped admission.
import fs from 'node:fs';
import path from 'node:path';
import { hashJson } from './canonical.mjs';
import { currentPlanRoot, writeCurrentPlan } from './current-plan.mjs';
import { writeFileAtomic } from './store.mjs';
import { normalizeGlob } from './paths.mjs';
import { assertValidPlanAgreement } from './plan-state.mjs';

const ID = /^[a-z][a-z0-9-]{1,47}$/;
const ACTIVE = new Set(['starting', 'started', 'running']);
function text(value, name, max = 6000, required = true) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${name} must be ${required ? 'nonempty ' : ''}text within ${max} characters`);
  return value.trim();
}
function list(value, name, required = false, max = 30) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > max || (required && !value.length)) throw new Error(`${name} must be an array of ${required ? '1..' : '0..'}${max} strings`);
  return [...new Set(value.map(x => text(x, name, 1500)))];
}
function stageId(id) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('stage_id must be a lower-kebab id of 2..48 characters'); return id; }
function unorderedContractLists(contract) {
  const normalized = { ...contract };
  for (const key of ['tools', 'refs', 'write_scope', 'depends_on', 'requires_verified', 'parallel_with']) normalized[key] = [...new Set(contract[key] ?? [])].sort();
  return normalized;
}
export function frontierState(store, taskSeq) {
  const events = store.workflowEvents().filter(e => e.taskSeq === taskSeq);
  const increments = events.filter(e => e.type === 'plan-increment');
  const stages = new Map(); let overview = null;
  for (const e of increments) {
    if (e.overview) overview = e.overview;
    if (e.stage) stages.set(e.stage.id, e.stage);
  }
  return { revision: increments.length, overview, stages, events, increments, startedAt: increments[0]?.at ?? null };
}
function safeStageFile(store, taskSeq, id, revision, hash) {
  const root = currentPlanRoot(path.dirname(path.dirname(store.dir)), store.teamId);
  const file = path.join(root, `task-${taskSeq}`, 'stages', id, `${revision}-${hash}.md`);
  for (let p = file; ; p = path.dirname(p)) {
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('stage snapshot path contains a symlink or junction'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === root || p === path.dirname(p)) break;
  }
  return file;
}
function renderStage(s) {
  return `# Stage ${s.id} / revision ${s.revision}\n\n${JSON.stringify(s.contract, null, 2)}\n`;
}
export function stageTask(s) {
  const c = s.contract;
  return `Stage ${s.id}\nGoal: ${c.goal}\nMethod: ${c.method}\nInterfaces: ${c.interfaces.join('; ')}\nExpected inputs (contracts, not completed-work claims): ${c.expected_inputs.join('; ') || '(none)'}\nRead the approved stage snapshot for the exact contract: ${s.file}`;
}
function renderPlan(state) {
  return `# Rolling current plan\n\n## Task overview and estimate\n${JSON.stringify(state.overview ?? { status: 'not recorded' }, null, 2)}\n\n` + [...state.stages.values()].map(s => `## ${s.id} (${s.contract.ready ? 'ready for execution review' : 'provisional'})\n${renderStage(s)}`).join('\n');
}
export function recordOverview(store, taskSeq, args) {
  const overview = { summary: text(args.summary, 'summary', 4000), approach: text(args.approach, 'approach', 4000), acceptance: list(args.acceptance, 'acceptance', true, 20), estimated_minutes: args.estimated_minutes, future_work: list(args.future_work, 'future_work').map(stageId) };
  if (!Number.isFinite(overview.estimated_minutes) || overview.estimated_minutes <= 0) throw new Error('estimated_minutes must be positive');
  const state = frontierState(store, taskSeq);
  if (state.overview && hashJson(state.overview) === hashJson(overview)) return { changed: false, revision: state.revision };
  store.appendWorkflowEvent({ type: 'plan-increment', taskSeq, overview });
  syncCurrentPlan(store, taskSeq);
  return { changed: true, revision: state.revision + 1, overview };
}
export function recordStage(store, taskSeq, args) {
  const state = frontierState(store, taskSeq), id = stageId(args.stage_id);
  if (!state.overview) throw new Error('record the task overview, acceptance and estimate with team_plan(action="overview") first');
  const ready = args.ready === true;
  const contract = {
    goal: text(args.goal, 'goal'), method: text(args.method ?? '', 'method', 6000, ready),
    acceptance: list(args.acceptance, 'acceptance', ready, 20), interfaces: list(args.interfaces, 'interfaces', ready),
    profile: args.profile ?? 'code', tools: list(args.tools, 'tools', ready), write_scope: list(args.write_scope, 'write_scope').map(normalizeGlob),
    refs: list(args.refs, 'refs', false, 18), depends_on: list(args.depends_on, 'depends_on').map(stageId),
    expected_inputs: list(args.expected_inputs, 'expected_inputs'), parallel_with: list(args.parallel_with, 'parallel_with').map(stageId),
    serial_reason: text(args.serial_reason ?? '', 'serial_reason', 1500, false),
    estimated_minutes: args.estimated_minutes ?? null, ready,
  };
  const verifiedDeps = list(args.requires_verified, 'requires_verified').map(stageId);
  if (verifiedDeps.some(dep => !contract.depends_on.includes(dep))) throw new Error('requires_verified must be a subset of depends_on');
  if (verifiedDeps.length) contract.requires_verified = verifiedDeps;
  contract.dependency_versions = Object.fromEntries(contract.depends_on.map(id => [id, state.stages.get(id)?.hash ?? null]));
  if (ready && Object.values(contract.dependency_versions).some(hash => hash === null)) throw new Error('ready stage dependencies must identify existing stage contracts; future unknown work may stay provisional');
  if (!['readonly', 'code', 'shell'].includes(contract.profile)) throw new Error('invalid stage profile');
  if (contract.depends_on.includes(id)) throw new Error('stage cannot depend on itself');
  if (contract.estimated_minutes !== null && (!Number.isFinite(contract.estimated_minutes) || contract.estimated_minutes <= 0)) throw new Error('stage estimated_minutes must be positive');
  if (ready && (!contract.parallel_with.length && !contract.serial_reason)) throw new Error('ready stage needs parallel_with or a concrete serial_reason explaining its execution order');
  if (ready && contract.profile !== 'readonly' && !contract.write_scope.length) throw new Error('writing stage requires write_scope');
  if (ready && !contract.tools.includes('read')) throw new Error('ready stage must grant read for its required contract snapshot');
  const prior = state.stages.get(id), hash = hashJson(contract);
  // List order is presentation, not a new grant. Keep the exact old immutable snapshot/hash, including legacy contracts.
  if (prior && hashJson(unorderedContractLists(prior.contract)) === hashJson(unorderedContractLists(contract))) return { changed: false, revision: state.revision, stage: prior };
  const next = { id, contract, hash, revision: (prior?.revision ?? 0) + 1 };
  const graph = new Map([...state.stages].map(([id, s]) => [id, s.contract.depends_on])); graph.set(id, contract.depends_on);
  const visited = new Set();
  function cycle(at, chain = new Set()) {
    if (chain.has(at)) throw new Error('stage dependencies contain a cycle');
    if (visited.has(at)) return;
    const nextChain = new Set([...chain, at]); for (const dep of graph.get(at) ?? []) if (graph.has(dep)) cycle(dep, nextChain);
    visited.add(at);
  }
  cycle(id);
  next.file = safeStageFile(store, taskSeq, id, next.revision, hash);
  writeFileAtomic(next.file, renderStage(next));
  store.appendWorkflowEvent({ type: 'plan-increment', taskSeq, stage: next });
  syncCurrentPlan(store, taskSeq);
  return { changed: true, revision: state.revision + 1, stage: next };
}
function syncCurrentPlan(store, taskSeq) {
  const root = path.dirname(path.dirname(store.dir));
  writeCurrentPlan(root, store.teamId, taskSeq, renderPlan(frontierState(store, taskSeq)));
}
export function requireReadyStage(store, taskSeq, id) {
  const stage = frontierState(store, taskSeq).stages.get(stageId(id));
  if (!stage?.contract.ready) throw new Error(`stage "${id}" is provisional or unknown; define goal, method, interfaces, scope, tools and acceptance before execution review`);
  if (hashJson(stage.contract) !== stage.hash || stage.file !== safeStageFile(store, taskSeq, stage.id, stage.revision, stage.hash) || fs.readFileSync(stage.file, 'utf8') !== renderStage(stage)) throw new Error('immutable stage contract is corrupt');
  return stage;
}
export function stageApproval(store, taskSeq, stage) {
  const id = store.workflowEvents().filter(e => e.taskSeq === taskSeq && e.type === 'execution-review-result' && e.stageId === stage.id && e.stageHash === stage.hash && e.result?.outcome?.decision === 'approve' && e.result?.status === 'settled').at(-1)?.result.id;
  if (!id) return null;
  try {
    assertValidPlanAgreement(store, id, taskSeq);
    const input = store.loadAgreementInput(id);
    return input.stageReview?.id === stage.id && input.stageReview.hash === stage.hash ? id : null;
  } catch { return null; }
}
function membersOfStage(members, taskSeq, id, hash) {
  return members.filter(m => m.taskSeq === taskSeq && m.stageId === id && m.stageHash === hash);
}
function stageCompleted(members) {
  return members.some(m => m.status === 'done') && !members.some(m => ACTIVE.has(m.status));
}
function stageVerification(events, members, id, hash) {
  const generation = hashJson(members.map(m => [m.childId, m.statusRevision, m.status]).sort(([a], [b]) => a.localeCompare(b)));
  const receipt = events.findLast(e => e.type === 'stage-verification' && e.stageId === id && e.stageHash === hash && e.generation === generation);
  return { generation, status: receipt?.result ?? 'unverified', ...(receipt && { evidence: receipt.evidence }) };
}
export function recordStageVerification(store, taskSeq, args) {
  const stage = requireReadyStage(store, taskSeq, args.stage_id);
  if (args.stage_hash !== undefined && args.stage_hash !== stage.hash) throw new Error('verify the current stage hash');
  if (!['passed', 'failed'].includes(args.verification_result)) throw new Error('verification_result must be passed or failed');
  const members = membersOfStage([...store.members().values()], taskSeq, stage.id, stage.hash);
  if (!stageCompleted(members)) throw new Error('verify after the prerequisite work completes');
  const current = stageVerification(frontierState(store, taskSeq).events, members, stage.id, stage.hash);
  if (args.verification_generation !== undefined && args.verification_generation !== current.generation) throw new Error('the stage ran again; obtain and verify its current execution generation');
  const evidence = list(args.refs, 'test evidence refs', true, 6);
  if (current.status !== args.verification_result || hashJson(current.evidence ?? []) !== hashJson(evidence)) {
    store.appendWorkflowEvent({ type: 'stage-verification', taskSeq, stageId: stage.id, stageHash: stage.hash,
      generation: current.generation, result: args.verification_result, evidence });
  }
  return { stage_id: stage.id, stage_hash: stage.hash, generation: current.generation, status: args.verification_result, evidence };
}
function stageDependencyWaits(store, stage, state, members, taskSeq, { requireApproval = true } = {}) {
  const waits = [];
  for (const id of stage.contract.depends_on) {
    const pinnedHash = stage.contract.dependency_versions?.[id];
    const currentDep = state.stages.get(id);
    const currentMembers = currentDep ? membersOfStage(members, taskSeq, id, currentDep.hash) : [];
    const useCurrent = Boolean(currentDep && currentDep.hash !== pinnedHash
      && stageCompleted(currentMembers) && (!requireApproval || stageApproval(store, taskSeq, currentDep) !== null));
    const hash = useCurrent ? currentDep.hash : pinnedHash;
    const dependencyMembers = useCurrent ? currentMembers : membersOfStage(members, taskSeq, id, hash);
    if (!stageCompleted(dependencyMembers)) {
      waits.push({ id, reason: 'actual completed dependency' });
    } else if (stage.contract.requires_verified?.includes(id)) {
      const status = currentDep?.hash === hash
        ? stageVerification(state.events, dependencyMembers, id, hash).status : 'superseded';
      if (status !== 'passed') waits.push({ id, reason: 'passed verification', status });
    }
  }
  return waits;
}
export function assertStageApproval(store, taskSeq, id, planId, { hash = null, dependencies = true, requireApproval = true } = {}) {
  const stage = requireReadyStage(store, taskSeq, id);
  if (hash && hash !== stage.hash) throw new Error(`stage "${id}" changed after this member was admitted; obtain review for the latest version`);
  if (requireApproval && (typeof planId !== 'string' || stageApproval(store, taskSeq, stage) !== planId)) {
    throw new Error(`stage "${id}" has no matching approved execution review for this version; submit team_discuss(kind="plan", stage_id="${id}") and keep planning while it runs`);
  }
  if (dependencies && stage.contract.depends_on.length) {
    const [wait] = stageDependencyWaits(store, stage, frontierState(store, taskSeq), [...store.members().values()], taskSeq, { requireApproval });
    if (wait) throw new Error('stage "' + id + '" awaits ' + wait.reason + ' of "' + wait.id + '"' +
      (wait.status === 'superseded' ? '; amend and review the stage for the current dependency version'
        : wait.status ? ' (' + wait.status + '); record current test evidence in team_plan(action="verify")' : ''));
  }
  return stage;
}
export function hydrateStageDispatch(store, taskSeq, args, { requireApproval = true } = {}) {
  if (!args.stage_id) return args;
  const stage = assertStageApproval(store, taskSeq, args.stage_id, args.plan_id, { requireApproval });
  const tools = args.tools ?? stage.contract.tools;
  if (!Array.isArray(tools) || !tools.length || !tools.includes('read') || tools.some(n => !stage.contract.tools.includes(n))) throw new Error('stage dispatch cannot override reviewed tools with new privileges or omit required read; use a subset of the approved tools, or amend and review the stage for additional tools');
  const fixed = { task: stageTask(stage), acceptance: stage.contract.acceptance, profile: stage.contract.profile, tools, write_scope: stage.contract.write_scope };
  for (const [key, value] of Object.entries(fixed)) {
    if (key === 'tools' || args[key] === undefined) continue;
    const same = key === 'write_scope' && Array.isArray(args[key]) ? hashJson([...new Set(args[key].map(normalizeGlob))].sort()) === hashJson([...new Set(value)].sort()) : hashJson(args[key]) === hashJson(value);
    if (!same) throw new Error(`stage dispatch cannot override reviewed ${key}; amend and review the stage contract first`);
  }
  const boundPlanId = args.plan_id ?? stageApproval(store, taskSeq, stage) ?? undefined;
  return { ...args, ...(boundPlanId ? { plan_id: boundPlanId } : {}), ...fixed, refs: [...new Set([...stage.contract.refs, stage.file, ...(args.refs ?? [])])], stageHash: stage.hash, stageRevision: stage.revision };
}
export function frontierView(store, taskSeq, { autonomous = false } = {}) {
  const state = frontierState(store, taskSeq), members = [...store.members().values()];
  const pending = state.events.filter(e => e.type === 'execution-review-queued' && !state.events.some(r => r.type === 'execution-review-result' && r.reviewId === e.reviewId)).map(e => ({ review_id: e.reviewId, stage_id: e.stageId, stage_hash: e.stageHash }));
  return { revision: state.revision, overview: state.overview, elapsed_ms: state.startedAt ? Date.now() - Date.parse(state.startedAt) : 0,
    stages: [...state.stages.values()].map(s => {
      const assigned = members.filter(m => m.taskSeq === taskSeq && m.stageId === s.id), current = assigned.filter(m => m.stageHash === s.hash), planId = stageApproval(store, taskSeq, s);
      const waiting = stageDependencyWaits(store, s, state, members, taskSeq, { requireApproval: !autonomous });
      const status = current.some(m => ACTIVE.has(m.status)) ? 'running'
        : current.some(m => m.status === 'paused') ? 'paused'
        : current.some(m => m.status === 'done') ? 'member_done'
        : !s.contract.ready ? 'provisional'
        : autonomous ? (waiting.length ? 'waiting_dependencies' : 'ready_to_dispatch')
        : !planId ? pending.some(r => r.stage_id === s.id && r.stage_hash === s.hash) ? 'reviewing' : 'needs_review'
        : waiting.length ? 'waiting_dependencies' : 'approved_unassigned';
      return { stage_id: s.id, revision: s.revision, hash: s.hash, file: s.file, ready: s.contract.ready, goal: s.contract.goal, write_scope: s.contract.write_scope, depends_on: s.contract.depends_on, parallel_with: s.contract.parallel_with, serial_reason: s.contract.serial_reason, plan_id: planId, execution_state: status, waiting_dependencies: waiting.map(w => w.id),
        ...(s.contract.requires_verified?.length && { requires_verified: s.contract.requires_verified }),
        ...(waiting.some(w => w.status) && { waiting_verification: waiting.filter(w => w.status).map(({ id, status }) => ({ stage_id: id, status })) }),
        ...(stageCompleted(current) && { verification: stageVerification(state.events, current, s.id, s.hash) }),
        members: assigned.map(m => ({ name: m.name, status: m.status, child_id: m.childId, stage_hash: m.stageHash ?? null, current_version: m.stageHash === s.hash })) };
    }),
    reviews: state.events.filter(e => e.type === 'execution-review-result').slice(-8),
    pending_execution_reviews: pending,
  };
}

export function frontierNeedsPlanning(store, taskSeq) {
  const s = frontierState(store, taskSeq);
  return !s.overview || [...s.stages.values()].some(s => !s.contract.ready) || s.overview.future_work.some(id => !s.stages.has(id));
}
export function frontierHasDispatchableWork(store, taskSeq, { autonomous = false } = {}) {
  const s = frontierState(store, taskSeq), members = [...store.members().values()];
  return [...s.stages.values()].some(stage => {
    if (members.some(m => m.taskSeq === taskSeq && m.stageId === stage.id && m.stageHash === stage.hash && ['starting', 'started', 'running', 'paused', 'done'].includes(m.status))) return false;
    try { assertStageApproval(store, taskSeq, stage.id, stageApproval(store, taskSeq, stage), { requireApproval: !autonomous }); return true; } catch { return false; }
  });
}
