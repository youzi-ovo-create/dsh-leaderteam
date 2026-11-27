import { isTerminalAgreement, agreementSnapshots, activeApprovedPlanIds, assertValidPlanAgreement } from '../core/plan-state.mjs';
import { assertActivationAdmission, activationConfig, hasAdmissibleFrontierWork } from './activation.mjs';
import { STOP_STATES, stopDeclaration } from './stop-review.mjs';
// Leader-only tools. Registered in the leader's scope (Desktop: inside the leader preset; headless: globally, masked for members).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { requireReady, teamStore, runtime, baseRuntime, recordUsage, runtimeForTeam, isPluginActive, activePluginsMap, refreshUpstreamCatalog, effectiveRuntimeConfig } from './runtime.mjs';
import { resolveActor, userTaskText, currentTaskSeq, reconcileStaleMembers } from './roles.mjs';
import { callRoleJson } from './llm.mjs';
import { roleRouteChain, degradedNote } from '../core/role-routes.mjs';
import { readQuotaStateFile } from '../core/quota.mjs';
import { executionModelRows, quotaGate, checkLeaderModel } from '../core/models.mjs';
import { resolvePath, isInside, normalizeGlob, relativeInside, realpathBestEffort, pathKey } from '../core/paths.mjs';
import { findProtectedWriteScopeOverlap } from '../core/gate-policy.mjs';
import { MEMBER_NAME_RE, AGREEMENT_KINDS, PLAN_CATEGORIES, PLAN_LIFECYCLE_STATES, DIRECT_EXEC_ALLOWED_TOOLS } from '../core/constants.mjs';
import { resolveModelTarget } from '../core/upstream-models.mjs';
import { hashJson } from '../core/canonical.mjs';
import { truncate } from '../core/redact.mjs';
import { writeFileAtomic } from '../core/store.mjs';
import { readCurrentPlan, writeCurrentPlan, currentPlanFile } from '../core/current-plan.mjs';
import { replay, nextAction, buildMemberRequest, buildArbiterRequest, parseMemberOpinion, parseArbiterRuling, normalizeReview, namedDocuments } from '../core/agreement.mjs';
import { memberInitialPrompt, directExecInitialPrompt } from '../core/prompts.mjs';
import { isAutonomousGovernance, replayGovernanceState, checkGovernanceExecutionGate } from '../core/governance-protocol.mjs';
import { queueAsyncSupervision, retryDeferredSupervisions, awaitTeamGovernanceJobs, respondInFormalConference } from './governance.mjs';
import { frontierState, frontierView, frontierNeedsPlanning, frontierHasDispatchableWork, recordOverview, recordStage, recordStageVerification, requireReadyStage, stageApproval } from '../core/frontier.mjs';
import { dispatchContract } from '../core/dispatch-contract.mjs';
import { resolveMemberRefs } from '../core/member-refs.mjs';
import { queueExecutionReview } from './planning.mjs';
import { needsSerialProof, buildSerialReviewRequest, parseSerialProof } from '../core/serial-review.mjs';
import { memberToolGrant } from '../core/tool-policy.mjs';
import { discoverSkills, loadSkill } from '../core/skills.mjs';
import { skillOptions, profileDefinitions } from './capability-tools.mjs';
import { syncTeamConcurrency, evaluateTeamConcurrency, reserveTeamDispatch, evaluateTeamRequestWindow, isTeamAwaitingUserAfterPowerPause } from './concurrency.mjs';
import {
  ensurePlanArchive,
  touchTeamTimer,
  getTeamTimerSnapshot,
  getReviewTimerPayload,
  recordArchivedPlanSubmitted,
  recordArchivedPlanSettled,
  recordArchivedMemberDispatched,
  syncArchivedMemberStatuses,
  recordArchivedDeliverySettled,
  selectBestFallbackPlan,
} from './timer-archive.mjs';

const json = { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }] };
const jsonCompact = { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] };
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });

function buildCatalogCandidateNames(validName, taskSeq = 1) {
  const candidates = [validName];
  for (let attempt = 2; attempt <= 20; attempt++) {
    const suffix = attempt === 2 ? `-t${taskSeq}` : `-t${taskSeq}-${attempt}`;
    const maxBase = Math.max(1, 32 - suffix.length);
    const trimmedBase = validName.slice(0, maxBase).replace(/-+$/, '') || 'm';
    const candidate = `${trimmedBase}${suffix}`;
    if (/^[a-z][a-z0-9-]{0,31}$/.test(candidate) && candidate !== 'lead' && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

export async function startSubagentCompat(subagents, {
  provider,
  childId,
  name,
  taskSeq = 1,
  label,
  delivery,
  signal,
  prompt,
  parent,
  agentPreset,
  agentOptions,
}) {
  const isFlatSpec = typeof subagents?.resolveName === 'function' || typeof subagents?.waitForTreeWork === 'function';
  if (!isFlatSpec) {
    const res = await subagents.startActivation({
      provider,
      childId,
      label,
      delivery,
      signal,
      request: { prompt, parent, agentPreset, agentOptions },
    });
    return { ...res, hostAgentName: null };
  }
  const validName = typeof name === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(name) && name !== 'lead' ? name : undefined;
  const baseSpec = {
    provider,
    childId,
    label,
    delivery,
    signal,
    prompt,
    parent,
    agentPreset,
    agentOptions,
  };
  if (validName && delivery === 'parent') {
    let lastDuplicateErr = null;
    for (const candidateName of buildCatalogCandidateNames(validName, taskSeq)) {
      try {
        const res = await subagents.startActivation({ ...baseSpec, name: candidateName });
        return { ...res, hostAgentName: candidateName };
      } catch (err) {
        if (err?.code === 'DUPLICATE_AGENT_NAME') {
          lastDuplicateErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastDuplicateErr ?? new Error(`unable to allocate unique subagent catalog name for "${validName}"`);
  }
  const res = await subagents.startActivation(baseSpec);
  return { ...res, hostAgentName: null };
}

function compactConcurrency(snap) {
  return {
    user_max_concurrent: snap.controls.user_max_concurrent,
    device_capacity: snap.controls.device_capacity,
    leader_max_parallel: snap.controls.leader_max_parallel,
    effective_cap: snap.controls.effective_cap,
    wave_available_now: snap.controls.ramp_available_now,
    scale_state: snap.controls.scale_state,
    active_execution_members: snap.active_execution_members.total,
    pending_parallel_tasks: snap.backlog.pending_parallel_tasks,
    device_pressure: snap.device.pressure,
    hysteresis: snap.hysteresis.mode,
    bottlenecks: snap.pipeline.bottlenecks,
  };
}

function fallbackConcurrencySnapshot(cfg, store, rt, teamId) {
  const active = [...store.members().values()].filter(m => m.actorRole !== 'direct_exec' && ACTIVE_MEMBER_STATUSES.has(m.status)).length
    + (rt.simpleDispatchInFlight?.get(teamId)?.size ?? 0);
  const cap = cfg.team.maxActiveMembers;
  const avail = Math.max(0, cap - active);
  return {
    scheduler_plugin: 'detached',
    user_max_concurrent: cap,
    device_capacity: cap,
    leader_max_parallel: null,
    effective_cap: cap,
    wave_available_now: avail,
    scale_state: active > cap ? 'draining_above_cap' : (avail > 0 ? 'ready' : 'at_cap'),
    active_execution_members: active,
    pending_parallel_tasks: 0,
    device_pressure: 'unmonitored',
    hysteresis: 'detached',
    bottlenecks: [],
  };
}

async function leaderOf(ctx, exec, { allowBlockedStopReport = false } = {}) {
  let rt = requireReady();
  const base = baseRuntime(rt);
  if (base.initialSettingsSyncPromise) {
    try { await base.initialSettingsSyncPromise; } catch {}
  }
  await refreshUpstreamCatalog(ctx, rt);
  const agent = exec.agent;
  if (!agent) throw new Error('team tools require a calling agent');
  const actor = (rt.actors.get(agent.id)?.agent === agent ? rt.actors.get(agent.id) : null) ?? resolveActor(ctx, agent);
  if (!actor || actor.role !== 'leader') throw new Error('team tools are only available in a LeaderTeam leader session');
  if (!actor.cwd) throw new Error('the leader session has no working directory');
  rt = runtimeForTeam(actor.teamId);
  const leaderModel = checkLeaderModel(rt.config, currentSelection(agent));
  const cfg = rt.config;
  if (leaderModel.blocked && !allowBlockedStopReport) throw new Error(`LeaderTeam leader model check failed: ${leaderModel.message}`);
  try { touchTeamTimer(ctx, actor.teamId, actor.cwd, rt); } catch {}
  return { rt, cfg, actor, store: teamStore(actor.teamId), leaderModel };
}
/** The calling agent's live model selection ({provider, model, reasoningEffort?}) or undefined. */
function currentSelection(agent) {
  try { return agent.model?.current?.(); } catch { return undefined; }
}
function leaderModelView(lm) {
  return { status: lm.status, policy: lm.policy, configured: `${lm.configured.provider}/${lm.configured.model} (${lm.configured.effort})`, actual: lm.actual ? `${lm.actual.provider}/${lm.actual.model}${lm.actual.effort ? ` (${lm.actual.effort})` : ''}` : null, ...(lm.message || lm.note ? { warning: lm.message ?? lm.note } : {}) };
}
const DISCUSSION_REQUEST_CHARS = 12000;
const ACTIVE_MEMBER_STATUSES = new Set(['starting', 'started', 'running']);
function quotaState(rt) { const r = readQuotaStateFile(rt.config.quota.stateFile); return r.ok ? r.state : null; }
function sameStage(store, id, stageId, stageHash) {
  if (stageId === undefined) return true;
  const stage = store.loadAgreementInput(id).stageReview;
  return stage?.id === stageId && (stageHash === undefined || stage.hash === stageHash);
}
function countAgreements(store, kind, taskSeq, stageId) {
  const { states } = agreementSnapshots(store);
  return [...states.values()].filter(s => isTerminalAgreement(s) && (kind === undefined || s.kind === kind) && (taskSeq === undefined || (s.taskSeq ?? 1) === taskSeq) && sameStage(store, s.id, stageId)).length;
}
function countConsecutiveUnapprovedPlans(store, states, taskSeq, stageId) {
  let streak = 0;
  for (const id of store.agreementIds()) {
    const s = states.get(id);
    if (!s || s.kind !== 'plan' || (s.taskSeq ?? 1) !== taskSeq || !isTerminalAgreement(s) || !sameStage(store, id, stageId)) continue;
    if (s.outcome?.decision === 'approve') streak = 0;
    else streak++;
  }
  return streak;
}
function hasConvergingPlanRevision(args, store, states, taskSeq) {
  const current=states.get(args.revises);
  if (current?.kind !== 'plan' || current.taskSeq !== taskSeq || current.outcome?.decision !== 'revise') return false;
  const prior=states.get(current.revises);
  const before=prior?.outcome?.requiredChanges,after=current.outcome.requiredChanges;
  return Array.isArray(before) && after.length > 0 && after.length < before.length && after.every(x=>before.includes(x));
}
function assertMemberDispatchCapacity(rt, store, cfg, name, taskSeq, writeScope) {
  reconcileStaleMembers(rt, store);
  const capacityConfig = activationConfig(rt, store, cfg);
  assertActivationAdmission(store, capacityConfig, { name, taskSeq, writeScope });
  const members = [...store.members().values()].filter(m => m.actorRole !== 'direct_exec');
  if (members.some(m => m.name === name && ACTIVE_MEMBER_STATUSES.has(m.status))) {
    throw new Error(`member name "${name}" is currently active in this team`);
  }
  const existing = members.find(m => m.name === name && (m.taskSeq ?? 1) === taskSeq && m.status !== 'failed' && m.status !== 'cancelled');
  if (existing) {
    throw new Error(`member name "${name}" is already used in this task (status=${existing.status}); choose a new unique lower-kebab name (e.g. "${name}-2") or continue "${existing.childId}" via send_message`);
  }
  const activeCount = members.filter(m => ACTIVE_MEMBER_STATUSES.has(m.status)).length;
  if (Number.isInteger(capacityConfig.team.maxActiveMembers) && activeCount >= capacityConfig.team.maxActiveMembers) {
    throw new Error(`active member limit ${capacityConfig.team.maxActiveMembers} reached; wait for running members to finish`);
  }
  const taskMemberCount = members.filter(m => (m.taskSeq ?? 1) === taskSeq && m.status !== 'failed').length;
  if (Number.isInteger(cfg.team.maxMembersPerTeam) && taskMemberCount >= cfg.team.maxMembersPerTeam) {
    throw new Error(`team member limit ${cfg.team.maxMembersPerTeam} reached for current task`);
  }
}
function buildWorkspaceManifest(workspace, cfg, platform = process.platform, maxFiles = 400) {
  if (typeof workspace !== 'string' || !workspace) return null;
  const refsRel = String(cfg.paths?.projectRefsDir ?? '.leaderteam/refs').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const skipNames = new Set(['.git', 'node_modules', '.edge-profile']);
  const protectedRels = (cfg.paths?.protectedDirs ?? []).map(d => String(d).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const entries = [];
  let capped = false;
  const walk = dir => {
    if (capped) return;
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const it of items) {
      if (capped) break;
      if (skipNames.has(it.name)) continue;
      const full = path.join(dir, it.name);
      const rel = relativeInside(workspace, full, platform);
      if (!rel) continue;
      const isRefs = rel === refsRel || rel.startsWith(refsRel + '/');
      const isProtected = !isRefs && protectedRels.some(pr => rel === pr || rel.startsWith(pr + '/')) && !(rel.startsWith('.leaderteam') && refsRel.startsWith(rel + '/') && it.isDirectory());
      if (isProtected) continue;
      if (it.isDirectory()) {
        walk(full);
      } else if (it.isFile()) {
        if (entries.length >= maxFiles) { capped = true; break; }
        let size = 0;
        try { size = fs.statSync(full).size; } catch {}
        entries.push(`${rel} (${size} B)`);
      }
    }
  };
  walk(workspace);
  if (entries.length === 0) return null;
  return `### workspace_manifest (${entries.length}${capped ? '+' : ''} files)\n${entries.join('\n')}`;
}
async function withAgreementLock(rt, id, fn) {
  rt.agreementLocks ??= new Map();
  const prev = rt.agreementLocks.get(id) ?? Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  const queued = prev.then(() => gate, () => gate);
  rt.agreementLocks.set(id, queued);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (rt.agreementLocks.get(id) === queued) rt.agreementLocks.delete(id);
  }
}
function assertNoSymlinkInRefs(refsDir, target, platform = process.platform) {
  const rel = relativeInside(refsDir, target, platform);
  if (rel === null) throw new Error(`path must stay inside ${refsDir}`);
  let cur = refsDir;
  try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(`refusing to write through symbolic link: ${cur}`); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  for (const part of rel.split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) throw new Error(`refusing to write through symbolic link: ${cur}`);
    } catch (e) {
      if (e?.code === 'ENOENT') break;
      throw e;
    }
  }
}
function followSuperseded(supersededBy, id) {
  let cur = id;
  const seen = new Set();
  while (supersededBy.has(cur) && !seen.has(cur)) { seen.add(cur); cur = supersededBy.get(cur); }
  return cur;
}
function latestAgreementFor(store, states, supersededBy, kind, taskSeq, stageId) {
  const ids = store.agreementIds().filter(id => {
    const s = states.get(id);
    return s && (kind === undefined || s.kind === kind) && (taskSeq === undefined || (s.taskSeq ?? 1) === taskSeq) && !supersededBy.has(id) && sameStage(store, id, stageId);
  });
  const id = ids.at(-1) ?? null;
  return id ? { id, state: states.get(id) } : null;
}

/**
 * Compute rational plan & discussion limits for `team_discuss`:
 * 1. Unanchored plan spam (`revises === undefined`) stays strictly bounded by `cfg.team.maxPlanAgreements`.
 * 2. Multi-phase evolution (`revises` anchored to a chain containing at least one approved & executed plan whose
 *    dispatched member completed `done`) earns phase headroom so multi-wave builds are never falsely bricked.
 * 3. Constructively converging revisions (`revises` pointing to a `revise` plan whose `requiredChanges.length`
 *    strictly decreased from its predecessor) earn convergence grace up to `ceil(maxPlanAgreements / 2)`.
 */
function computeEffectiveDiscussionCaps(store, cfg, taskSeq, args) {
  const { states } = agreementSnapshots(store);
  const members = [...store.members().values()].filter(m => (m.taskSeq ?? 1) === taskSeq);
  const donePlanIds = new Set(members.filter(m => m.status === 'done' && m.planId).map(m => m.planId));
  const executedApprovedCount = [...states.entries()].filter(
    ([id, s]) => s.kind === 'plan' && (s.taskSeq ?? 1) === taskSeq && s.outcome?.decision === 'approve' && donePlanIds.has(id),
  ).length;

  let effectivePlanCap = cfg.team.maxPlanAgreements;
  let effectiveDiscussionCap = cfg.team.maxDiscussionsPerTask + Math.min(3, executedApprovedCount) * 4;

  if (args.kind === 'plan' && typeof args.revises === 'string' && states.has(args.revises)) {
    // Walk ancestor chain of `args.revises`
    let curId = args.revises;
    const visited = new Set();
    let chainHasExecutedApproved = false;
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      const st = states.get(curId);
      if (!st) break;
      if (st.outcome?.decision === 'approve' && donePlanIds.has(curId)) {
        chainHasExecutedApproved = true;
      }
      curId = st.revises;
    }
    if (chainHasExecutedApproved) {
      effectivePlanCap += Math.min(3, executedApprovedCount) * cfg.team.maxPlanAgreements;
    }
    const prev = states.get(args.revises);
    if (prev?.outcome?.decision === 'revise' && prev.revises && states.has(prev.revises)) {
      const prevPrev = states.get(prev.revises);
      const prevCount = prev.outcome.requiredChanges?.length ?? 0;
      const prevPrevCount = prevPrev?.outcome?.requiredChanges?.length ?? 0;
      if (prevPrev?.outcome?.decision === 'revise' && prevCount > 0 && prevCount < prevPrevCount) {
        effectivePlanCap += Math.min(2, Math.max(1, Math.ceil(cfg.team.maxPlanAgreements / 2)));
      }
    }
  }
  return { effectivePlanCap, effectiveDiscussionCap };
}

export function registerTeamTools(ctx) {
  // Every tool returns plain JSON (undefined fields dropped) so DSH's lossless-output check always holds.
  const reg = def => {
    const execute = def.execute;
    if (def.name === 'team_discuss') runtime().recoverExecutionReviews = (actor, taskSeq) => {
      const rt = runtimeForTeam(actor.teamId), store = teamStore(actor.teamId);
      const events = store.workflowEvents();
      for (const e of events.filter(e => e.taskSeq === taskSeq && e.type === 'execution-review-queued' && !events.some(r => r.type === 'execution-review-result' && r.reviewId === e.reviewId))) {
        queueExecutionReview(rt, store, taskSeq, actor.agent, e.stage, e.args, signal => execute(e.args, { agent: actor.agent, signal }, e.stage));
      }
    };
    const wrapped = { ...def, async execute(args, exec) { return JSON.parse(JSON.stringify(await execute(args, exec) ?? null)); } };
    return ctx.effect(() => ctx.tools.register(defineTool(wrapped)), { label: def.name });
  };

  reg({
    name: 'team_plan',
    description: 'Rolling plan ledger. First record a compact overview/approach/acceptance/time estimate. Add one stage at a time; ready stages need goal, method, interfaces, tools, write_scope and acceptance. Future stages can stay provisional. Submit ready stage execution review immediately via team_discuss(kind="plan",stage_id) while planning later work, then dispatch with stage_id and its approved plan_id. Use state for results.',
    parameters: {
      action: { type: 'string', enum: ['overview', 'stage', 'state', 'verify'], required: true },
      summary: { type: 'string' }, approach: { type: 'string' }, acceptance: strList('Overview or stage acceptance checks.'),
      estimated_minutes: { type: 'number', description: 'Positive estimate, not a hard deadline.' }, future_work: strList('Future lower-kebab stage_ids, e.g. ["scan","report","integrate"]. No need to design them now.'),
      stage_id: { type: 'string' }, goal: { type: 'string' }, method: { type: 'string' }, interfaces: strList('Inputs/outputs and shared contracts; state explicitly when none.'),
      ready: { type: 'boolean', description: 'Ready for review, not execution permission. Defaults false.' },
      profile: { type: 'string', enum: ['readonly', 'code', 'shell'] }, tools: strList('Exact profile tools. Include read; shell for code requiring actual execution.'),
      write_scope: strList('Disjoint workspace-relative write globs for this stage.'), refs: strList('Required workspace or standing read-only references.'),
      depends_on: strList('Actual prerequisites by stage id; planning may proceed before they finish.'),
      requires_verified: strList('Subset of depends_on requiring acceptance to pass before dispatch. Leave it empty for a stage that performs those checks.'),
      stage_hash: { type: 'string', description: 'Optional for verify; defaults to the current stage hash.' },
      verification_generation: { type: 'string', description: 'Optional for verify; defaults to the current completed execution generation.' },
      verification_result: { type: 'string', enum: ['passed', 'failed'], description: 'For verify, the result of actual acceptance checks. Include existing test evidence files in refs.' },
      expected_inputs: strList('Expected acceptance/contracts used for planning, not completed-work claims.'),
      parallel_with: strList('Stages that can run independently alongside this one.'), serial_reason: { type: 'string', description: 'Concrete reason this stage is serial when parallel_with is empty.' },
    },
    output: json,
    async execute(args, exec) {
      const { rt, cfg, actor, store } = await leaderOf(ctx, exec);
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      const autonomous = isAutonomousGovernance(cfg);
      if (!cfg.team.rollingPlanning) throw new Error('rolling planning is disabled for this frozen team; start a new rolling-planning conversation');
      if (args.action === 'state') return frontierView(store, taskSeq, { autonomous });
      if (args.action === 'verify') {
        const refs = resolveMemberRefs(cfg, actor.cwd, args.refs ?? []);
        return recordStageVerification(store, taskSeq, { ...args, refs });
      }
      if (args.action === 'stage' && args.ready === true) {
        const profile = cfg.profiles[args.profile ?? 'code'];
        if (!profile || (args.profile ?? 'code') === 'leader') throw new Error('choose a member profile');
        const grant = memberToolGrant(cfg, args.profile ?? 'code', args.tools);
        const definitions = await profileDefinitions(ctx, profile);
        const available = new Set(definitions.map(d => d.name));
        const unavailable = args.tools.filter(n => !available.has(n));
        if (unavailable.length) throw new Error(`stage tools are unavailable: ${unavailable.join(', ')}; choose exact names from team_tools(action="list", profile="${args.profile ?? 'code'}")`);
        if (args.profile === 'shell' && !cfg.gate.shellTools.some(n => available.has(n) && grant.allowedTools.includes(n))) {
          const availShells = cfg.gate.shellTools.filter(n => available.has(n));
          const shellExample = availShells.length > 0 ? availShells.join(' or ') : (process.platform === 'win32' ? 'pwsh' : 'bash');
          throw new Error(`shell stage must select an actual host shell tool such as ${shellExample}; "shell" is a profile, not a tool name`);
        }
        if (profile.mutating && !grant.allowedTools.some(n => !cfg.gate.uncontrolledTools.includes(n))) throw new Error('writing stage must select edit/write or an actual shell tool');
      }
      const result = args.action === 'overview' ? recordOverview(store, taskSeq, args) : args.action === 'stage' ? recordStage(store, taskSeq, args) : (() => { throw new Error('invalid team_plan action'); })();
      const view = frontierView(store, taskSeq, { autonomous });
      if (autonomous) {
        if (args.action === 'stage' && result.changed && result.stage?.contract?.ready && cfg.governance?.autoSuperviseStages !== false && isPluginActive(rt, 'consensus')) {
          queueAsyncSupervision({
            ctx,
            rt,
            store,
            actor,
            leaderAgent: exec.agent,
            leaderModel: currentSelection(exec.agent) ?? null,
            taskSeq,
            phaseKind: 'execution',
            stageId: result.stage.id,
            stageHash: result.stage.hash,
            targets: result.stage.contract.write_scope ?? [],
            profile: result.stage.contract.profile,
            tools: result.stage.contract.tools ?? [],
            interfaces: result.stage.contract.interfaces ?? [],
            goal: result.stage.contract.goal ?? '',
            method: result.stage.contract.method ?? '',
            summary: result.stage.contract.goal,
            proposal: JSON.stringify(result.stage.contract, null, 2),
            userTask: userTaskText(ctx, actor.teamId, DISCUSSION_REQUEST_CHARS),
          });
        }
        const dispatchable = hasAdmissibleFrontierWork(rt, store, cfg, taskSeq)
          ? view.stages.filter(s => s.execution_state === 'ready_to_dispatch' || s.execution_state === 'approved_unassigned').map(s => s.stage_id)
          : [];
        const nextHint = dispatchable.length
          ? `Stage(s) [${dispatchable.join(', ')}] are ready_to_dispatch: call team_dispatch immediately WITHOUT waiting for plan_id or Dual Reviewers (Dual Reviewers supervise asynchronously in the background).`
          : undefined;
        return {
          ...result,
          governance_mode: 'autonomous',
          ...(nextHint ? { next_step_hint: nextHint } : {}),
          execution_authorized: Boolean(args.action === 'stage' && result.stage?.contract?.ready),
        };
      }
      const readyUnreviewed = view.stages.filter(s => s.execution_state === 'needs_review').map(s => s.stage_id);
      const dispatchable = hasAdmissibleFrontierWork(rt, store, cfg, taskSeq)
        ? view.stages.filter(s => s.execution_state === 'approved_unassigned').map(s => s.stage_id)
        : [];
      const nextHint = dispatchable.length
        ? `Approved stage(s) [${dispatchable.join(', ')}] can start now: call team_dispatch immediately instead of hoarding stages.`
        : readyUnreviewed.length && isPluginActive(rt, 'consensus')
          ? `Ready stage(s) [${readyUnreviewed.join(', ')}] await execution review: call team_discuss(kind="plan", stage_id="${readyUnreviewed[0]}", topic=...) now so review runs asynchronously while you plan later stages.`
          : undefined;
      return { ...result, ...(nextHint ? { next_step_hint: nextHint } : {}), execution_authorized: false };
    },
  });

  reg({
    name: 'team_models',
    description: 'List configurable execution models with capabilities, supported efforts, live quota and recent usage, plus the configured gate, discussion and arbiter models.',
    parameters: {},
    output: json,
    async execute(_args, exec) {
      const { rt, cfg, actor, store, leaderModel } = await leaderOf(ctx, exec);
      const now = new Date(); const q = quotaState(rt);
      const execRows = executionModelRows(cfg, q, now);
      const rows = execRows.map(r => ({
        route: r.route,
        provider: r.provider,
        upstream_model: r.upstreamModel,
        family: r.family,
        label: r.label,
        strengths: r.strengths,
        efforts: r.efforts,
        default_effort: r.defaultEffort,
        context_window: r.contextWindow ?? null,
        max_tokens: r.maxTokens ?? null,
        quota: r.quota.status,
        best_remaining_pct: r.quota.bestRemainingPct,
        next_reset: r.quota.nextResetAt,
        note: r.quota.reason || undefined,
        recent_p50_tokens_by_effort: Object.fromEntries(Object.entries(r.usage.byEffort).map(([k, v]) => [k, v.p50Tokens])),
      }));
      const roleKeys = ['gate', 'discussA', 'discussB', 'arbiter', 'serialReviewer', ...(cfg.roles.directExec ? ['directExec'] : [])];
      const roles = Object.fromEntries(roleKeys.map(k => [k, { route: cfg.roles[k].route, effort: cfg.roles[k].effort, quota: quotaGate(cfg, q, cfg.roles[k].route, now).quota.status }]));
      const concurrency = isPluginActive(rt, 'scheduler')
        ? compactConcurrency(evaluateTeamConcurrency(ctx, actor.teamId))
        : fallbackConcurrencySnapshot(cfg, store, rt, actor.teamId);
      const timer = isPluginActive(rt, 'timerArchive') ? getTeamTimerSnapshot(ctx, actor.teamId, actor.cwd, rt) : null;
      return {
        quota_snapshot_age_sec: execRows[0]?.quota.snapshotAgeSec ?? null,
        governance_mode: cfg.governance?.mode ?? 'autonomous',
        active_plugins: activePluginsMap(rt),
        models: rows,
        fixed_roles: roles,
        leader_model: leaderModelView(leaderModel),
        profiles: Object.fromEntries(cfg.derived.memberProfiles.map(id => [id, cfg.profiles[id].description])),
        concurrency,
        ...(timer ? { timer } : {}),
      };
    },
  });

  reg({
    name: 'team_concurrency',
    description: 'Inspect real-time execution subagent concurrency, local CPU/RAM/commit headroom, pipeline bottlenecks and hysteresis state; optionally update your own workload-based leader_max_parallel or register pending_parallel_tasks waiting for slots. Governance roles (gate, discuss, arbiter) are never counted here.',
    parameters: {
      pending_parallel_tasks: { type: 'number', description: 'Ready independent subtasks held back for later waves in the current task (0 when all ready tasks have been dispatched).' },
      leader_max_parallel: { type: 'number', description: 'Your own safe parallel execution cap judgment for heavy workloads (1..200, or 0 to reset to auto). Cannot exceed user_max_concurrent or device_capacity.' },
    },
    output: json,
    async execute(args, exec) {
      const { rt, actor } = await leaderOf(ctx, exec);
      if (!isPluginActive(rt, 'scheduler')) {
        throw new Error('leaderteam-scheduler plugin is disabled');
      }
      const { sched } = syncTeamConcurrency(ctx, actor.teamId, rt);
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      const beforeSnap = evaluateTeamConcurrency(ctx, actor.teamId);
      if (args?.pending_parallel_tasks !== undefined) {
        if (!Number.isInteger(args.pending_parallel_tasks) || args.pending_parallel_tasks < 0 || args.pending_parallel_tasks > 200) {
          throw new Error('pending_parallel_tasks must be an integer in [0, 200]');
        }
        sched.setLeaderPreference(actor.teamId, taskSeq, {
          pendingParallelTasks: args.pending_parallel_tasks,
          currentAvailableNow: beforeSnap.controls.ramp_available_now,
        });
      }
      if (args?.leader_max_parallel !== undefined) {
        if (!Number.isInteger(args.leader_max_parallel) || args.leader_max_parallel < 0 || args.leader_max_parallel > 200) {
          throw new Error('leader_max_parallel must be an integer in [0, 200] (0 resets to auto)');
        }
        sched.setLeaderPreference(actor.teamId, taskSeq, { leaderMaxParallel: args.leader_max_parallel });
      }
      return evaluateTeamConcurrency(ctx, actor.teamId);
    },
  });

  reg({
    name: 'team_plan_archive',
    description: 'Inspect the engineering timer and historical external plan archive, select a viable plan through independent arbitration, or generate a retrospective. Archived get/list snapshots are historical evidence, not live review progress; use team_plan(action="state") or team_status for current approvals.',
    parameters: {
      action: { type: 'string', required: true, enum: ['timer', 'list', 'get', 'select_best', 'retrospect'], description: 'Operation to perform.' },
      plan_id: { type: 'string', description: 'Plan or agreement ID for get / retrospect.' },
      category: { type: 'string', enum: [...PLAN_CATEGORIES], description: 'Optional category filter for list.' },
      lifecycle_state: { type: 'string', enum: [...PLAN_LIFECYCLE_STATES], description: 'Optional lifecycle state filter for list.' },
      project_only: { type: 'boolean', description: 'Default true: filter list to the current workspace project.' },
      limit: { type: 'number', description: 'Maximum rows for list (1..200).' },
      notes: { type: 'string', description: 'Optional operator/leader observations to include in retrospect.' },
    },
    output: json,
    async execute(args, exec) {
      const { rt, cfg, actor, store } = await leaderOf(ctx, exec);
      if (!isPluginActive(rt, 'timerArchive')) {
        throw new Error('leaderteam-timer-archive plugin is disabled');
      }
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      const workspace = resolvePath(actor.cwd, undefined, process.platform);
      const archive = ensurePlanArchive(rt, workspace);
      if (!archive) throw new Error('external plan archive is disabled in configuration');
      syncArchivedMemberStatuses(actor.teamId, taskSeq, rt);

      switch (args.action) {
        case 'timer': {
          return {
            timer: getTeamTimerSnapshot(ctx, actor.teamId, workspace, rt),
            archive: archive.getStats(),
          };
        }
        case 'list': {
          const projectOnly = args.project_only !== false;
          const plans = archive.listPlans({
            workspace: projectOnly ? workspace : null,
            category: args.category ?? null,
            lifecycleState: args.lifecycle_state ?? null,
            limit: Number.isInteger(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 30,
          });
          return {
            archive_root: archive.root,
            project_only: projectOnly,
            count: plans.length,
            plans,
          };
        }
        case 'get': {
          if (!args.plan_id) throw new Error('plan_id is required for action="get"');
          const plan = archive.resolvePlan(args.plan_id);
          if (!plan) throw new Error(`archived plan not found: ${args.plan_id}`);
          return { archive_root: archive.root, plan };
        }
        case 'select_best': {
          if (cfg.team.rollingPlanning) throw new Error('rolling planning uses per-stage execution review and its independent arbiter; a whole-task archived selection cannot authorize other stages');
          const userRequest = userTaskText(ctx, actor.teamId, DISCUSSION_REQUEST_CHARS);
          const selected = await selectBestFallbackPlan({
            ctx,
            rt,
            teamId: actor.teamId,
            taskSeq,
            workspace,
            userRequest,
            signal: exec.signal,
          });
          return {
            archive_root: archive.root,
            selected_plan_id: selected.selectedPlanId,
            agreement_id: selected.agreementId ?? selected.selectedPlanId,
            by: selected.by,
            already_selected: selected.alreadySelected,
            rationale: selected.rationale,
            execution_guardrails: selected.executionGuardrails,
          };
        }
        case 'retrospect': {
          const targetId = args.plan_id
            ?? archive.listPlans({ teamId: actor.teamId, taskSeq, limit: 1 })[0]?.planId;
          if (!targetId) throw new Error('no archived plan found to retrospect; pass plan_id');
          const retro = archive.createRetrospective(targetId, {
            teamStoreInstance: store,
            notes: args.notes ?? '',
          });
          return {
            archive_root: archive.root,
            retrospective: retro,
          };
        }
        default:
          throw new Error(`unknown team_plan_archive action: ${args.action}`);
      }
    },
  });

  reg({
    name: 'team_dispatch',
    description: 'Start a member from its approved stage: {name,stage_id,plan_id,model,effort}. The host loads task, acceptance, tools and write_scope from that immutable reviewed stage; do not copy them again. Returns after safety/admission; completion is asynchronous. A plan_id authorizes only its own stage/version. Legacy or readonly scouting without stage_id needs explicit task/acceptance/profile/tools.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique lower-kebab member name, e.g. "impl-parser".' },
      stage_id: { type: 'string', description: 'Reviewed ready stage; parameters are populated from its approved contract.' },
      task: { type: 'string', description: 'Required without stage_id: bounded assignment with authoritative refs, not a copy of the entire project.' },
      acceptance: strList('Required without stage_id: checkable criteria for this assignment.'),
      model: { type: 'string', required: true, description: 'Execution model route from team_models.' },
      effort: { type: 'string', required: true, description: 'Reasoning effort supported by that model.' },
      profile: { type: 'string', description: 'Required without stage_id: readonly | code | shell.' },
      plan_id: { type: 'string', description: 'Id of the approved kind "plan" agreement for the current user task (required for writing profiles).' },
      tools: strList('Without stage_id: exact authorized tools. With stage_id: omit to use reviewed tools, or narrow to a subset including read; adding tools needs amended stage approval.'),
      defer_tools: { ...strList('Subset of tools whose schemas should stay unloaded until the member explicitly loads them with team_tools.') },
      skills: { ...strList('Skill ids from team_skills list. Only selected skill bodies enter the member context.') },
      write_scope: { ...strList('Workspace-relative globs the member may modify, e.g. ["src/parser/**","tests/parser/**"]. Required for writing profiles; ignored for readonly.') },
      refs: { ...strList('Additional existing files inside the workspace or global reference roots that the member must read. With stage_id these supplement immutable required refs without revising the stage; they cannot change the approved assignment or expand permissions. Use explicit file paths, not globs.') },
    },
    output: json,
    async execute(args, exec) {
      const { rt, cfg, actor, store } = await leaderOf(ctx, exec);
      const platform = process.platform;
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      args = dispatchContract(store, cfg, taskSeq, args);
      if (!MEMBER_NAME_RE.test(args.name)) throw new Error(`member name must match ${MEMBER_NAME_RE}`);
      reconcileStaleMembers(rt, store);
      if (!cfg.derived.memberProfiles.includes(args.profile)) throw new Error(`profile must be one of: ${cfg.derived.memberProfiles.join(', ')}`);
      const schedulerActive = isPluginActive(rt, 'scheduler');
      const consensusActive = isPluginActive(rt, 'consensus');
      const autonomous = isAutonomousGovernance(cfg);
      if (autonomous) {
        const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
        const stgObj = args.stage_id ? (frontierState(store, taskSeq).stages.get(args.stage_id) ?? null) : null;
        const gateBlock = checkGovernanceExecutionGate(gov, actor, 'team_dispatch', args, stgObj, platform);
        if (gateBlock) throw new Error(gateBlock.reason);
      }
      const members = [...store.members().values()].filter(m => m.actorRole !== 'direct_exec');
      let inFlightTeam = [];
      if (schedulerActive) {
        const { sched } = syncTeamConcurrency(ctx, actor.teamId, rt);
        inFlightTeam = sched.reservedForTeamTask(actor.teamId);
      } else {
        rt.simpleDispatchInFlight ??= new Map();
        inFlightTeam = [...(rt.simpleDispatchInFlight.get(actor.teamId)?.values() ?? [])];
      }
      if (
        members.some(m => m.name === args.name && ACTIVE_MEMBER_STATUSES.has(m.status)) ||
        inFlightTeam.some(r => r.name === args.name)
      ) {
        throw new Error(`member name "${args.name}" is currently active in this team`);
      }
      const inFlightTask = inFlightTeam.filter(r => r.taskSeq === taskSeq);
      if (
        members.some(m => m.name === args.name && (m.taskSeq ?? 1) === taskSeq && m.status !== 'failed') ||
        inFlightTask.some(r => r.name === args.name)
      ) {
        throw new Error(`member name "${args.name}" is already used in this task`);
      }
      const taskMemberCount = members.filter(m => (m.taskSeq ?? 1) === taskSeq && m.status !== 'failed').length + inFlightTask.length;
      if (taskMemberCount >= cfg.team.maxMembersPerTeam) {
        throw new Error(`team member limit ${cfg.team.maxMembersPerTeam} reached for current task`);
      }
      const rwDispatch = evaluateTeamRequestWindow(rt, actor.teamId, Date.now(), { targetRoute: args.model });
      if (rwDispatch?.triggerCheckpointPause) {
        throw new Error(`5-hour request window entered checkpoint_pause for route "${args.model}" (${rwDispatch.reason}): new execution dispatches on this provider are paused to protect quota while governance reviews stay active. Save your progress checkpoint via team_note and declare team_status(stop_state="blocked", reason=...) (or dispatch an alternate provider route if available).`);
      }
      if (isTeamAwaitingUserAfterPowerPause(rt, actor.teamId)) {
        throw new Error('Battery-aware graceful shutdown is active (or awaiting an explicit user message to resume after low-battery pause): stop new execution dispatches, persist progress via team_note, and wait for user instructions.');
      }
      const profile = cfg.profiles[args.profile];
      const grant = memberToolGrant(cfg, args.profile, args.tools, args.defer_tools ?? []);
      if (grant.allowedTools.some(n => cfg.gate.shellTools.includes(n)) && rt.workspaceShellFailures?.has(pathKey(actor.cwd))) throw new Error('workspace OS sandbox initialization failed; stop shell dispatches and report the permissions problem. Repair requires the workspace owner, then restart and dispatch a new member.');
      const modelRoute = args.model;
      const acceptance = (args.acceptance ?? []).map(s => s.trim()).filter(Boolean);
      if (acceptance.length === 0 || acceptance.length > 20) throw new Error('acceptance must list 1 to 20 criteria');
      let writeScope = [];
      if (profile.mutating) {
        writeScope = (args.write_scope ?? []).map(normalizeGlob);
        if (writeScope.length === 0) throw new Error(`profile "${args.profile}" writes files: write_scope must list at least one workspace-relative glob`);
        for (const g of writeScope) {
          const hit = findProtectedWriteScopeOverlap(g, cfg.paths.protectedDirs ?? [], platform);
          if (hit) {
            throw new Error(`write_scope glob "${g}" targets protected path "${hit}" (members cannot modify protectedDirs ${JSON.stringify(cfg.paths.protectedDirs)}; update ${cfg.paths.projectRefsDir}/* directly from leader via team_note, and restrict member write_scope to non-protected workspace paths)`);
          }
        }
      }
      const workspace = resolvePath(actor.cwd, undefined, platform);
      const refs = resolveMemberRefs(cfg, workspace, args.refs, platform);
      if (refs.length && !grant.allowedTools.includes('read')) throw new Error('tasks with required refs must grant read');
      const actualTools = new Set((await profileDefinitions(ctx, profile)).map(d => d.name));
      const unavailable = args.tools.filter(n => !actualTools.has(n));
      if (unavailable.length) throw new Error(`selected tools are not registered in the target member preset: ${unavailable.join(', ')}`);
      if (actualTools.has('read') && !grant.allowedTools.includes('read')) {
        throw new Error(`profile "${args.profile}" requires including "read" in tools for ungated workspace file inspection and read-before-write enforcement (recommended: include "read", "glob", "grep"${args.profile === 'shell' ? ', plus your shell tool and "edit"/"write" when modifying files' : args.profile === 'code' ? ', plus "edit" and/or "write"' : ''})`);
      }
      if (profile.mutating && !grant.allowedTools.some(n => !cfg.gate.uncontrolledTools.includes(n))) {
        throw new Error(`profile "${args.profile}" is a mutating profile, but tools (${args.tools.join(', ')}) includes only read-only/uncontrolled tools; include "edit" and/or "write" (or a shell tool on profile "shell") in tools, or use profile "readonly" if no modifications are intended`);
      }
      const availableShellTools = cfg.gate.shellTools.filter(n => actualTools.has(n));
      if (args.profile === 'shell' && availableShellTools.length > 0 && !grant.allowedTools.some(n => availableShellTools.includes(n))) {
        throw new Error(`profile "shell" requires selecting an available shell tool in tools (available on this host: ${availableShellTools.join(', ')}); include "read", "glob", "grep", "${availableShellTools[0]}" in tools (plus "edit"/"write" if modifying files and "read_image" when visual screenshot inspection is needed), or use profile "code" if no command execution is intended`);
      }
      const opts = skillOptions(actor, cfg);
      const selectedSkills = args.skills ?? [];
      if (!Array.isArray(selectedSkills) || selectedSkills.length > 10) throw new Error('skills must list at most 10 ids');
      const catalog = selectedSkills.length ? discoverSkills(opts) : [];
      const skills = [...new Set(selectedSkills)].map(id => loadSkill(catalog, id, opts));
      if (skills.reduce((n, s) => n + Buffer.byteLength(s.text, 'utf8'), 0) > 131072) throw new Error('selected skill instructions exceed 128 KiB');
      let boundPlanId = null;
      let fallbackGuardrails = [];
      const needsPlan = !autonomous && cfg.team.requirePlanAgreement && !cfg.team.planExemptProfiles.includes(args.profile);
      if (needsPlan && !consensusActive) throw new Error('required plan review is unavailable: restore leaderteam-consensus or explicitly disable requirePlanAgreement for a new team');
      if (needsPlan || (typeof args.plan_id === 'string' && args.plan_id.trim() !== '')) {
        boundPlanId = assertValidPlanAgreement(store, args.plan_id, taskSeq);
        const selected = store.stagnationSelections().find(s => s.taskSeq === taskSeq && (s.agreementId === boundPlanId || s.selectedPlanId === boundPlanId));
        fallbackGuardrails = [...new Set([...(selected?.executionGuardrails ?? []),...(replay(store.agreementEvents(boundPlanId)).outcome?.conditions??[])])];
        if (acceptance.length+fallbackGuardrails.length>20) throw new Error('acceptance plus plan execution conditions exceeds 20 items; narrow this assignment without discarding conditions');
      }
      const now = new Date();
      const qg = quotaGate(cfg, quotaState(rt), modelRoute, now);
      if (!qg.allowed) throw new Error(qg.error);
      const presets = ctx.get('agentPresets');
      if (!presets) throw new Error('the agent preset registry is not installed; member presets are unavailable');
      assertMemberDispatchCapacity(rt, store, cfg, args.name, taskSeq, writeScope);
      const childId = randomUUID();
      let reservation;
      if (schedulerActive) {
        reservation = reserveTeamDispatch(ctx, actor.teamId, {
          id: childId,
          name: args.name,
          taskSeq,
          profile: args.profile,
          activeMembers: members,
        });
        if (!reservation.allowed) {
          throw new Error(reservation.reason);
        }
      } else {
        rt.simpleDispatchInFlight ??= new Map();
        let set = rt.simpleDispatchInFlight.get(actor.teamId);
        if (!set) { set = new Map(); rt.simpleDispatchInFlight.set(actor.teamId, set); }
        const activeCount = members.filter(m => ACTIVE_MEMBER_STATUSES.has(m.status)).length + set.size;
        if (activeCount >= cfg.team.maxActiveMembers) {
          throw new Error(`active member limit ${cfg.team.maxActiveMembers} reached: wait for a running member to finish before dispatching "${args.name}"`);
        }
        set.set(childId, { id: childId, name: args.name, taskSeq, profile: args.profile });
        reservation = {
          commit() { set.delete(childId); },
          cancel() { set.delete(childId); },
        };
      }
      let addedToStore = false;
      try {
        const effectiveAcceptance = fallbackGuardrails.length > 0
          ? [...acceptance, ...fallbackGuardrails.slice(0, Math.max(0, 20 - acceptance.length)).map(g => `[Review guardrail] ${g}`)]
          : acceptance;
        if (args.stage_id) dispatchContract(store, cfg, taskSeq, args); // recheck after asynchronous tool/skill discovery
        const member = { childId, name: args.name, taskSeq, planId: boundPlanId, ...(args.stage_id ? { stageId: args.stage_id, stageHash: args.stageHash, stageRevision: args.stageRevision } : {}), profile: args.profile, preset: profile.preset, model: modelRoute, effort: args.effort, ...grant, skills, writeScope, refs, task: args.task, acceptance: effectiveAcceptance, cwd: actor.cwd, userTask: userTaskText(ctx, actor.teamId, cfg.gate.maxAuthorizationChars), quotaAtDispatch: qg.quota.status };
        if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.add(childId);
        store.addMember(member);
        addedToStore = true;
        const target = resolveModelTarget(cfg, modelRoute, args.effort);
        const started = await startSubagentCompat(ctx.subagents, {
          provider: 'spawn',
          childId,
          name: args.name,
          taskSeq,
          label: args.name,
          delivery: 'parent',
          signal: exec.signal,
          prompt: [{ type: 'text', text: memberInitialPrompt(member, cfg.paths.protectedDirs) }],
          parent: exec.agent,
          agentPreset: profile.preset,
          agentOptions: target,
        });
        if (started.hostAgentName) {
          store.setMemberHostName(childId, started.hostAgentName);
        }
        if (store.getMember(childId)?.status === 'starting') store.setMemberStatus(childId, 'started');
        if (boundPlanId) {
          recordArchivedMemberDispatched({
            rt,
            workspace,
            planId: boundPlanId,
            memberSummary: store.getMember(childId) ?? member,
          });
        }
        const postSnap = schedulerActive ? evaluateTeamConcurrency(ctx, actor.teamId) : null;
        reservation.commit(postSnap);
        if (autonomous && cfg.governance?.autoSuperviseDispatches !== false && consensusActive) {
          retryDeferredSupervisions({
            ctx,
            rt,
            store,
            actor,
            leaderAgent: exec.agent,
            leaderModel: currentSelection(exec.agent) ?? null,
            taskSeq,
          });
          const boundStage = args.stage_id ? frontierState(store, taskSeq).stages.get(args.stage_id) : null;
          queueAsyncSupervision({
            ctx,
            rt,
            store,
            actor,
            leaderAgent: exec.agent,
            leaderModel: currentSelection(exec.agent) ?? null,
            taskSeq,
            phaseKind: 'execution',
            stageId: args.stage_id ?? null,
            stageHash: boundStage?.hash ?? args.stageHash ?? null,
            targets: writeScope.length > 0 ? writeScope : (boundStage ? [] : [`profile:${args.profile}`]),
            profile: args.profile,
            tools: boundStage?.contract?.tools ?? grant.allowedTools,
            interfaces: boundStage?.contract?.interfaces ?? [],
            goal: boundStage?.contract?.goal ?? args.task ?? '',
            method: boundStage?.contract?.method ?? '',
            summary: `Member "${args.name}" dispatched (${args.profile})`,
            proposal: `Task: ${args.task}\nAcceptance:\n- ${effectiveAcceptance.join('\n- ')}\nWrite scope: ${JSON.stringify(writeScope)}`,
            evidenceFiles: args.refs ?? [],
            userTask: userTaskText(ctx, actor.teamId, DISCUSSION_REQUEST_CHARS),
          });
        }
        const concurrency = schedulerActive
          ? compactConcurrency(evaluateTeamConcurrency(ctx, actor.teamId))
          : fallbackConcurrencySnapshot(cfg, store, rt, actor.teamId);
        return { member: args.name, child_id: started.childId, task_seq: taskSeq, ...(boundPlanId ? { plan_id: boundPlanId } : {}), ...(autonomous ? { governance_mode: 'autonomous' } : {}), model: modelRoute, provider: target.provider, upstream_model: target.model, effort: args.effort, profile: args.profile, tools: grant.allowedTools, loaded_tools: grant.loadedTools, skills: skills.map(({ id, name, sha256 }) => ({ id, name, sha256 }) ), write_scope: writeScope, refs, quota: qg.quota.status, concurrency };
      } catch (e) {
        if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.delete(childId);
        if (addedToStore) {
          store.setMemberStatus(childId, 'failed', e instanceof Error ? e.message : String(e));
          if (boundPlanId) {
            recordArchivedMemberDispatched({
              rt,
              workspace,
              planId: boundPlanId,
              memberSummary: store.getMember(childId),
            });
          }
        }
        reservation.cancel();
        throw e;
      }
    },
  });

  reg({
    name: 'team_direct_exec',
    description: 'Invoke the Leader\'s Direct Execution Model (直属执行模型, §3.2): high invocation freedom during normal execution (no formal stage or dual review needed; suspended during Stage 3 Formal Arbiter–Leader Conferences so workspace files stay quiescent), minimum execution privileges (1. strictly forbidden from ever leaving the workspace Sandbox; 2. every in-Sandbox action passes through the Safety Gate). Pass workspace-relative write_scope whenever creating or editing files; omit write_scope for local inspection, verification, or test runs.',
    parameters: {
      task: { type: 'string', required: true, description: 'Focused local task: inspection, targeted implementation/fix, or test verification inside the workspace Sandbox.' },
      acceptance: strList('Optional checkable completion criteria for this direct task.'),
      write_scope: strList('Workspace-relative globs this invocation may modify (e.g. ["src/utils/**"]). Omit or pass [] for read/test-only tasks.'),
      allow_shell: { type: 'boolean', description: 'Default true: allow in-Sandbox shell execution (inspected by Safety Gate). Set false for pure file read/write.' },
      effort: { type: 'string', description: 'Optional effort override supported by roles.directExec.' },
    },
    output: json,
    async execute(args, exec) {
      const { rt, cfg, actor, store } = await leaderOf(ctx, exec);
      const platform = process.platform;
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      if (isAutonomousGovernance(cfg)) {
        const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
        const gateBlock = checkGovernanceExecutionGate(gov, actor, 'team_direct_exec', args, null, platform);
        if (gateBlock) throw new Error(gateBlock.reason);
      }
      if (isTeamAwaitingUserAfterPowerPause(rt, actor.teamId)) {
        throw new Error('Battery-aware graceful shutdown is active (or awaiting an explicit user message to resume after low-battery pause): team_direct_exec is paused until the user sends a resume instruction.');
      }
      const taskText = typeof args.task === 'string' ? args.task.trim() : '';
      if (!taskText) throw new Error('team_direct_exec requires a non-empty task');
      if (taskText.length > 24000) throw new Error('team_direct_exec task exceeds 24000 characters');

      const writeScope = (args.write_scope ?? []).map(normalizeGlob).filter(Boolean);
      if (writeScope.length > 0) {
        for (const g of writeScope) {
          const hit = findProtectedWriteScopeOverlap(g, cfg.paths.protectedDirs ?? [], platform);
          if (hit) {
            throw new Error(`write_scope glob "${g}" targets protected path "${hit}" (direct_exec cannot modify protectedDirs ${JSON.stringify(cfg.paths.protectedDirs)})`);
          }
        }
      }

      reconcileStaleMembers(rt, store);
      const primaryChildId = randomUUID();
      const seqNum = [...store.members().values()].filter(m => m.actorRole === 'direct_exec').length + 1;
      const directName = `direct-exec-${seqNum}`;

      const now = new Date();
      const q = quotaState(rt);
      const chain = roleRouteChain(cfg, 'directExec', currentSelection(exec.agent) ?? null);
      const windowEligible = chain.filter(
        t => quotaGate(cfg, q, t.route, now).allowed
          && !evaluateTeamRequestWindow(rt, actor.teamId, now.getTime(), { targetRoute: t.route, skipAuditWrite: true })?.triggerCheckpointPause,
      );
      const quotaEligible = chain.filter(t => quotaGate(cfg, q, t.route, now).allowed);
      const candidates = windowEligible.length > 0
        ? windowEligible
        : (quotaEligible.length > 0 ? quotaEligible : (chain[0] ? [chain[0]] : []));
      const firstCand = candidates[0];
      if (!firstCand) throw new Error('no configured route available for roles.directExec');
      const firstQCheck = quotaGate(cfg, q, firstCand.route, now);
      if (!firstQCheck.allowed) throw new Error(firstQCheck.error);
      const rwDirect = evaluateTeamRequestWindow(rt, actor.teamId, now.getTime(), { targetRoute: firstCand.route });
      if (rwDirect?.triggerCheckpointPause) {
        throw new Error(`5-hour request window entered checkpoint_pause for route "${firstCand.route}" (${rwDirect.reason}): team_direct_exec is paused to protect quota while governance reviews stay active. Save your progress checkpoint via team_note and declare team_status(stop_state="blocked", reason=...).`);
      }

      const shellBlocked = rt.workspaceShellFailures?.has(pathKey(actor.cwd));
      const wantShell = args.allow_shell !== false && !shellBlocked;
      const profileKey = wantShell ? 'shell' : (writeScope.length > 0 ? 'code' : 'readonly');
      const profile = cfg.profiles[profileKey] ?? cfg.profiles.code;
      const actualTools = new Set((await profileDefinitions(ctx, profile)).map(d => d.name));
      const directAllowedSet = new Set(DIRECT_EXEC_ALLOWED_TOOLS);
      const candidateTools = [
        'read',
        'read_image',
        'glob',
        'grep',
        ...(writeScope.length > 0 ? ['write', 'edit'] : []),
        ...(wantShell ? cfg.gate.shellTools : []),
      ];
      const grantedTools = [...new Set(candidateTools)].filter(n => directAllowedSet.has(n) && actualTools.has(n));
      if (grantedTools.length === 0) throw new Error('no eligible direct_exec tools registered in host preset');

      const acceptance = (args.acceptance ?? []).map(s => String(s).trim()).filter(Boolean);
      const effectiveAcceptance = acceptance.length > 0
        ? acceptance.slice(0, 12)
        : ['Complete the assigned local task strictly inside the workspace Sandbox and report concise factual results.'];
      const capturedUserTask = userTaskText(ctx, actor.teamId, cfg.gate.maxAuthorizationChars);

      for (let candIdx = 0; candIdx < candidates.length; candIdx++) {
        const chosen = candidates[candIdx];
        const candQCheck = quotaGate(cfg, q, chosen.route, now);
        if (!candQCheck.allowed) {
          if (candIdx + 1 < candidates.length) continue;
          throw new Error(candQCheck.error);
        }
        const modelSpec = cfg.models[chosen.route];
        const chosenEffort = (typeof args.effort === 'string' && modelSpec?.efforts?.includes(args.effort))
          ? args.effort
          : chosen.effort;

        const childId = candIdx === 0 ? primaryChildId : randomUUID();
        const attemptName = candIdx === 0 ? directName : `${directName}-fb${candIdx}`;
        assertActivationAdmission(store, cfg, { childId, actorRole: 'direct_exec', name: attemptName, taskSeq, writeScope }, platform);

        const directRecord = {
          childId,
          name: attemptName,
          actorRole: 'direct_exec',
          taskSeq,
          planId: null,
          profile: profileKey,
          preset: profile.preset,
          model: chosen.route,
          effort: chosenEffort,
          allowedTools: grantedTools,
          loadedTools: grantedTools,
          deferredTools: [],
          skills: [],
          writeScope,
          refs: [],
          task: taskText,
          acceptance: effectiveAcceptance,
          cwd: actor.cwd,
          userTask: capturedUserTask,
          quotaAtDispatch: candQCheck.quota.status,
        };

        if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.add(childId);
        store.addMember(directRecord);
        let started = null;
        try {
          const target = resolveModelTarget(cfg, chosen.route, chosenEffort);
          started = await startSubagentCompat(ctx.subagents, {
            provider: 'spawn',
            childId,
            label: attemptName,
            delivery: 'caller',
            signal: exec.signal,
            prompt: [{ type: 'text', text: directExecInitialPrompt() }],
            parent: exec.agent,
            agentPreset: profile.preset,
            agentOptions: target,
          });
          if (store.getMember(childId)?.status === 'starting') store.setMemberStatus(childId, 'started');
          const settled = await started.result;
          const outputText = (settled?.output ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
          const stopKind = typeof settled?.stopReason === 'string' && settled.stopReason
            ? settled.stopReason
            : (settled?.stopReason?.kind ?? 'completed');
          const curRec = store.getMember(childId);
          const wasPausedForConf = curRec?.status === 'paused' || /^\s*STATUS:\s*paused\b/im.test(outputText);
          if (curRec && ACTIVE_MEMBER_STATUSES.has(curRec.status)) {
            store.setMemberStatus(childId, wasPausedForConf ? 'paused' : (stopKind === 'error' ? 'failed' : 'done'));
          }
          const childReceipts = store.gateReceipts().filter(r => r.agentId === childId);
          const allowedOps = childReceipts.filter(r => r.decision === 'allow').length;

          // If the model failed before executing ANY workspace tool (e.g. retired model / 404 / 429 / 503 / timeout),
          // automatically fall back to the next configured route in `roles.directExec`!
          if (stopKind === 'error' && !wasPausedForConf && allowedOps === 0 && !exec.signal?.aborted && candIdx + 1 < candidates.length) {
            continue;
          }

          const degraded = degradedNote('directExec', chosen);
          return {
            direct_exec_id: childId,
            name: attemptName,
            model: chosen.route,
            effort: chosenEffort,
            ...(degraded ? { degraded_role: degraded } : {}),
            tools: grantedTools,
            write_scope: writeScope,
            stop_reason: wasPausedForConf ? 'paused_for_conference' : stopKind,
            safety_gate: {
              total_checked: childReceipts.length,
              allowed: allowedOps,
              denied: childReceipts.filter(r => r.decision === 'deny').length,
              model_calls: childReceipts.filter(r => r.by === 'model').length,
            },
            output: truncate(outputText, 16000),
          };
        } catch (err) {
          const curRec = store.getMember(childId);
          if (curRec && ACTIVE_MEMBER_STATUSES.has(curRec.status)) {
            store.setMemberStatus(childId, 'failed', err instanceof Error ? err.message : String(err));
          }
          const allowedOps = store.gateReceipts().filter(r => r.agentId === childId && r.decision === 'allow').length;
          if (allowedOps === 0 && !exec.signal?.aborted && candIdx + 1 < candidates.length) {
            continue;
          }
          throw err;
        } finally {
          if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.delete(childId);
          await started?.dispose?.().catch(() => {});
        }
      }
      throw new Error('no usable route succeeded for roles.directExec');
    },
  });

  reg({
    name: 'team_conference',
    description: 'Inspect governance status or participate in a Stage 3 Formal 2-Party Conference (Independent Arbiter + Leader ONLY, §4). All other execution models (ordinary members and team_direct_exec) checkpoint and pause before the conference opens and remain suspended until it concludes. Present workspace facts, new evidence files, and/or proposed engineering alternatives.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'respond'], description: 'status inspects current governance/conference state; respond submits the Leader\'s presentation to the Arbiter.' },
      conference_id: { type: 'string', description: 'Active conference_id (optional for respond when a conference is currently open).' },
      explanation: { type: 'string', description: 'Leader\'s factual explanation, technical rationale, and direct answers to the Arbiter\'s questions.' },
      new_evidence_files: strList('Optional workspace-relative files to show the Arbiter directly (e.g. ["src/engine.js", "test/report.json"]).'),
      proposed_alternative: { type: 'string', description: 'Optional concrete alternative engineering approach proposed by the Leader.' },
    },
    output: json,
    async execute(args, exec) {
      const { rt, cfg, actor, store } = await leaderOf(ctx, exec);
      if (!isPluginActive(rt, 'consensus')) throw new Error('leaderteam-consensus plugin is disabled');
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
      if (args.action === 'status') {
        return {
          task_seq: taskSeq,
          governance_mode: cfg.governance?.mode ?? 'autonomous',
          ...gov,
        };
      }
      if (!gov.activeConference) {
        throw new Error('no active Stage 3 formal conference is currently open; check team_conference(action="status")');
      }
      const explanation = String(args.explanation ?? '').trim();
      const alternative = String(args.proposed_alternative ?? '').trim();
      if (!explanation && !alternative) {
        throw new Error('team_conference(action="respond") requires explanation and/or proposed_alternative');
      }
      return respondInFormalConference({
        ctx,
        rt,
        store,
        actor,
        leaderAgent: exec.agent,
        leaderModel: currentSelection(exec.agent) ?? null,
        taskSeq,
        conferenceId: args.conference_id ?? gov.activeConference.conferenceId,
        explanation,
        newEvidenceFiles: args.new_evidence_files ?? [],
        proposedAlternative: alternative,
        userTask: userTaskText(ctx, actor.teamId, DISCUSSION_REQUEST_CHARS),
        signal: exec.signal,
      });
    },
  });

  reg({
    name: 'team_discuss',
    description: 'Two independent reviewers and, if needed, arbiter. Rolling stage execution review: {kind:"plan",stage_id,topic}; returns a queued ticket immediately so you can plan B while A is reviewed. Read team_plan state/live context for the final approved plan_id. Delivery reviews remain synchronous and inspect actual results. After revise amend that stage and resubmit with revises. Outcomes never waive safety or permissions.',
    parameters: {
      kind: { type: 'string', enum: [...AGREEMENT_KINDS], description: 'Required unless resume_id is set.' },
      stage_id: { type: 'string', description: 'Required for rolling kind=plan; reviews only this ready stage/version. Future stages need not be complete.' },
      topic: { type: 'string', description: 'One line (required unless resume_id is set).' },
      proposal: { type: 'string', description: 'Full proposal for non-plan reviews. Plan review reads the current external plan file; on first submission an explicit proposal seeds that file.' },
      evidence: { type: 'string', description: 'Supporting facts: test output, measurements, excerpts.' },
      environment_blocked: { type: 'boolean', description: 'Delivery only: the team cannot resolve a concrete environmental hard blocker. Repeated blockers escalate to the user.' },
      blocker_reason: { type: 'string', description: 'Actual environment limitation and failed attempts; never use this for ordinary implementation work.' },
      evidence_files: { ...strList('Files attached verbatim (bounded): the requirement/specification documents for a plan; changed files and test output for a delivery. Files named in the user\'s request are attached automatically.') },
      category: { type: 'string', enum: [...PLAN_CATEGORIES], description: 'Optional explicit plan archive category (auto-classified when omitted).' },
      revises: { type: 'string', description: 'Id of the earlier agreement (same kind) whose outcome this proposal addresses; its required changes are shown to the reviewers.' },
      resume_id: { type: 'string', description: 'Continue an unfinished agreement after an error (same inputs are reused).' },
    },
    output: json,
    execute: async function runDiscussion(args, exec, backgroundStage = null) {
      const { rt, cfg, actor, store } = await leaderOf(ctx, exec);
      if (!isPluginActive(rt, 'consensus')) {
        throw new Error('leaderteam-consensus plugin is disabled');
      }
      const platform = process.platform;
      reconcileStaleMembers(rt, store);
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      const workspace = resolvePath(actor.cwd, undefined, platform);
      if (isAutonomousGovernance(cfg) && !args.resume_id && !backgroundStage) {
        if (!AGREEMENT_KINDS.includes(args.kind)) throw new Error(`kind must be one of: ${AGREEMENT_KINDS.join(', ')}`);
        if (typeof args.topic !== 'string' || !args.topic.trim()) throw new Error('topic must be a non-empty string');
        const autoStage = args.stage_id ? requireReadyStage(store, taskSeq, args.stage_id) : null;
        if (args.kind === 'delivery') {
          const running = [...store.members().values()].filter(m => m.actorRole !== 'direct_exec' && ACTIVE_MEMBER_STATUSES.has(m.status));
          if (running.length > 0) {
            throw new Error(`cannot finalize delivery check while ordinary team member(s) are still running (${running.map(m => `${m.name} [${m.childId}]`).join(', ')}); wait for running members to finish first`);
          }
        }
        const phaseKind = args.kind === 'delivery' ? 'delivery' : (args.kind === 'plan' ? 'execution' : 'architecture');
        const targets = autoStage?.contract?.write_scope?.length
          ? autoStage.contract.write_scope
          : (args.evidence_files?.length ? args.evidence_files : [`kind:${args.kind}`]);
        const proposalText = autoStage
          ? JSON.stringify(autoStage.contract, null, 2)
          : String(args.proposal ?? args.topic ?? '');
        retryDeferredSupervisions({
          ctx,
          rt,
          store,
          actor,
          leaderAgent: exec.agent,
          leaderModel: currentSelection(exec.agent) ?? null,
          taskSeq,
          excludePhaseKind: args.kind === 'delivery' ? 'delivery' : null,
        });
        const job = queueAsyncSupervision({
          ctx,
          rt,
          store,
          actor,
          leaderAgent: exec.agent,
          leaderModel: currentSelection(exec.agent) ?? null,
          taskSeq,
          phaseKind,
          stageId: autoStage?.id ?? null,
          stageHash: autoStage?.hash ?? null,
          targets,
          profile: autoStage?.contract?.profile ?? null,
          tools: autoStage?.contract?.tools ?? [],
          interfaces: autoStage?.contract?.interfaces ?? [],
          goal: autoStage?.contract?.goal ?? '',
          method: autoStage?.contract?.method ?? '',
          summary: args.topic.trim(),
          proposal: proposalText,
          evidence: String(args.evidence ?? ''),
          evidenceFiles: args.evidence_files ?? [],
          userTask: userTaskText(ctx, actor.teamId, DISCUSSION_REQUEST_CHARS),
        });
        if (args.kind !== 'delivery') {
          return {
            status: 'supervising_async',
            governance_mode: 'autonomous',
            ...(autoStage ? { stage_id: autoStage.id, stage_hash: autoStage.hash } : {}),
            execution_authorized: true,
            next_step_hint: 'Autonomous governance active: Dual Reviewers supervise asynchronously in the background and have no veto power. Proceed immediately with team_dispatch (no plan_id needed) or team_direct_exec.',
          };
        }
        const jobResult = job?.promise ? await job.promise : null;
        await awaitTeamGovernanceJobs(rt, actor.teamId, 60000);
        const govAfter = replayGovernanceState(store.governanceEvents(), taskSeq);
        if (govAfter.activeConference) {
          return {
            status: 'conference_opened',
            governance_mode: 'autonomous',
            conference_id: govAfter.activeConference.conferenceId,
            dispute_id: govAfter.activeConference.disputeId,
            opening: govAfter.activeConference.opening,
            next_step_hint: `Independent Arbiter + Reviewers voted >= 2/3 to convene Stage 3 Formal Conference "${govAfter.activeConference.conferenceId}". Call team_conference(action="respond", conference_id="${govAfter.activeConference.conferenceId}", ...) to resolve.`,
          };
        }
        if (govAfter.activeHumanEscalation) {
          return {
            status: 'waiting_user',
            governance_mode: 'autonomous',
            escalation: govAfter.activeHumanEscalation,
            next_step_hint: '3rd unanimous objection escalated directly to User (§5). Call team_status(stop_state="waiting_user", ...) and present the dispute dossier.',
          };
        }
        if (jobResult?.status === 'deferred' || (!jobResult && !job?.deduplicated) || govAfter.pendingSupervisions?.length > 0) {
          const anyPolicyRefused = (govAfter.pendingSupervisions ?? []).some(p => p.policyRefused);
          return {
            status: 'error',
            governance_mode: 'autonomous',
            error: 'Dual supervision incomplete: both Reviewer A and Reviewer B must return valid opinions before delivery can settle.',
            pending_supervisions: (govAfter.pendingSupervisions ?? []).map(p => ({
              supervision_id: p.supervisionId,
              phase_kind: p.phaseKind,
              target: p.targetLabel,
              missing_reviewers: [!p.hasValidOpinionA ? 'discussA' : null, !p.hasValidOpinionB ? 'discussB' : null].filter(Boolean),
              error_a: p.errorA,
              error_b: p.errorB,
              ...(p.policyRefused ? { policy_refused: true } : {}),
            })),
            hint: anyPolicyRefused
              ? 'One or more supervision items were refused by provider policy (non-retryable); adjust the refused content/route or call team_status(stop_state="blocked", reason=...) instead of retrying unchanged.'
              : 'Retry team_discuss(kind="delivery", ...) once reviewer routes are reachable, or call team_status(stop_state="blocked", reason=...) if upstream reviewer routes remain unavailable.',
          };
        }
        return {
          status: 'settled',
          governance_mode: 'autonomous',
          outcome: { decision: 'approve', by: 'autonomous-supervision' },
          advisory_notes: govAfter.advisoryNotes.slice(-2),
          next_step_hint: 'Supervision completed with two valid reviewer opinions and no formal Arbiter intervention; declare team_status(stop_state="delivered") and deliver in the user\'s language.',
        };
      }
      if (args.resume_id) {
        if (!store.agreementIds().includes(args.resume_id)) throw new Error(`unknown agreement resume_id "${args.resume_id}"; an execution review_id is only a tracking ticket. Use the actual agr-* agreement id from team_plan(state), or resubmit corrected kind="plan", stage_id and topic when no agreement was created.`);
        const saved = store.loadAgreementInput(args.resume_id), savedStage = saved.stageReview;
        if (args.kind && args.kind !== saved.kind) throw new Error('resume kind does not match the saved agreement');
        args = { ...args, kind: saved.kind, ...(!args.stage_id && savedStage ? { stage_id: savedStage.id } : {}) };
      }
      const reviewStage = backgroundStage ?? (args.stage_id ? requireReadyStage(store, taskSeq, args.stage_id) : null);
      if (cfg.team.rollingPlanning && args.kind === 'plan' && !reviewStage) throw new Error('rolling execution review requires stage_id; record a ready stage with team_plan first');
      if (reviewStage && args.kind && args.kind !== 'plan') throw new Error('stage_id is only for kind="plan" execution review');
      if (reviewStage && !backgroundStage) {
        const alreadyApproved = !args.resume_id ? stageApproval(store, taskSeq, reviewStage) : null;
        if (alreadyApproved) {
          return {
            status: 'settled',
            stage_id: reviewStage.id,
            stage_hash: reviewStage.hash,
            id: alreadyApproved,
            outcome: { decision: 'approve' },
            existing: true,
            next_step_hint: `Stage "${reviewStage.id}" version ${reviewStage.revision} is already approved (plan_id="${alreadyApproved}"); dispatch directly without re-reviewing unchanged content.`,
          };
        }
        // Reject deterministic deployment errors before creating a ticket or spending reviewer tokens.
        const c = reviewStage.contract;
        const grant = memberToolGrant(cfg, c.profile, c.tools);
        const frontier = frontierState(store, taskSeq), assigned = [...store.members().values()];
        const futureWriteScopes = c.depends_on.flatMap(id => {
          const hash = c.dependency_versions?.[id], dep = frontier.increments.findLast(e => e.stage?.id === id && e.stage.hash === hash)?.stage;
          const bound = assigned.filter(m => m.taskSeq === taskSeq && m.stageId === id && m.stageHash === hash);
          const complete = bound.some(m => m.status === 'done') && !bound.some(m => ACTIVE_MEMBER_STATUSES.has(m.status));
          return dep && !complete ? dep.contract.write_scope : [];
        });
        // Expected upstream outputs may be reviewed before A completes. Actual dispatch still requires every file.
        resolveMemberRefs(cfg, workspace, c.refs, platform, { futureWriteScopes });
        if (cfg.profiles[c.profile].mutating && !grant.allowedTools.some(n => !cfg.gate.uncontrolledTools.includes(n))) throw new Error('writing stage grants only read-only tools; include an authorized write/edit or shell tool before review');
        if (c.profile === 'shell' && !grant.allowedTools.some(n => cfg.gate.shellTools.includes(n))) throw new Error('shell stage must include an authorized shell tool before review');
        const { states, supersededBy } = agreementSnapshots(store);
        const previous = latestAgreementFor(store, states, supersededBy, 'plan', taskSeq, reviewStage.id);
        if (!args.resume_id && !args.revises && previous && isTerminalAgreement(previous.state) && (store.loadAgreementInput(previous.id).stageReview?.hash !== reviewStage.hash || previous.state.outcome?.decision === 'revise' || nextAction(previous.state).kind === 'stalled')) args = { ...args, revises: previous.id };
        return queueExecutionReview(rt, store, taskSeq, exec.agent, reviewStage, args, signal => runDiscussion(args, { ...exec, signal }, reviewStage));
      }
      const stageIdForReview = reviewStage?.id;
      let id, input;
      if (args.resume_id) {
        id = args.resume_id;
        if (!store.agreementIds().includes(id)) throw new Error(`unknown agreement ${id}`);
        const existing = replay(store.agreementEvents(id));
        if (existing.kind === 'plan' && (existing.taskSeq ?? 1) !== taskSeq && !isTerminalAgreement(existing)) {
          throw new Error(`cannot resume unfinished plan agreement "${id}" from earlier task #${existing.taskSeq ?? 1} in current task #${taskSeq}: call team_discuss with kind="plan" and current proposal/evidence_files so the approved plan_id binds to task #${taskSeq}`);
        }
        input = store.loadAgreementInput(id);
        if (reviewStage && input.stageReview?.hash !== reviewStage.hash) throw new Error('cannot resume an old stage version; review the current stage with revises instead');
      } else {
        if (!AGREEMENT_KINDS.includes(args.kind)) throw new Error(`kind must be one of: ${AGREEMENT_KINDS.join(', ')}`);
        if (typeof args.topic !== 'string' || args.topic.trim() === '') throw new Error('topic must be a non-empty string');
        if (args.kind === 'plan' && reviewStage) {
          args = { ...args, proposal: `Execution review for stage ${reviewStage.id}, revision ${reviewStage.revision}. Future stages may stay provisional.\n${JSON.stringify(reviewStage.contract, null, 2)}` };
        } else if (args.kind === 'plan') {
          let plan = readCurrentPlan(rt.storageRoot, actor.teamId, taskSeq);
          if (!plan && typeof args.proposal === 'string' && args.proposal.trim()) {
            writeCurrentPlan(rt.storageRoot, actor.teamId, taskSeq, args.proposal);
            plan = readCurrentPlan(rt.storageRoot, actor.teamId, taskSeq);
          }
          if (!plan) throw new Error('write the full current plan with team_note(scope="current_plan", path="plan.md") before plan review');
          args = { ...args, proposal: plan.content };
        }
        if (typeof args.proposal !== 'string' || args.proposal.trim() === '') throw new Error('proposal must be a non-empty string');
        if (args.kind === 'delivery') {
          const running = [...store.members().values()].filter(m => ACTIVE_MEMBER_STATUSES.has(m.status));
          if (running.length > 0) {
            throw new Error(`cannot start kind="delivery" agreement while team member(s) are still running (${running.map(m => `${m.name} [${m.childId}]`).join(', ')}); end your turn and wait for running members to finish (or interrupt_agent if superseded), inspect their output, and then call team_discuss(kind="delivery")`);
          }
        }
        const { states, supersededBy } = agreementSnapshots(store);
        const activePlanId = activeApprovedPlanIds(store, states, supersededBy, taskSeq).filter(id => sameStage(store, id, stageIdForReview, reviewStage?.hash)).at(-1) ?? null;
        const openSameKind = store.agreementIds().find(aid => {
          const s = states.get(aid);
          return s && s.kind === args.kind && (s.taskSeq ?? 1) === taskSeq && !isTerminalAgreement(s) && sameStage(store, aid, stageIdForReview, reviewStage?.hash);
        });
        if (openSameKind) {
          throw new Error(`unfinished ${args.kind} agreement "${openSameKind}" exists for current task #${taskSeq}: resume it with resume_id="${openSameKind}" instead of starting a new agreement`);
        }
        if (args.kind === 'plan' && args.revises === undefined && activePlanId !== null) {
          throw new Error(`approved plan agreement "${activePlanId}" already exists for current task #${taskSeq} and authorizes all remaining implementation, integration, verification and rework dispatches: pass plan_id="${activePlanId}" directly to team_dispatch, use kind="architecture"|"interface"|"risk"|"security-design" for a scoped mid-task decision, or pass revises="${activePlanId}" with the complete unabbreviated task plan only if replacing the whole task plan`);
        }
        if (Number.isInteger(cfg.team.maxDiscussionsPerTask)) {
          const usedAll = countAgreements(store, undefined, taskSeq, stageIdForReview);
          if (usedAll >= cfg.team.maxDiscussionsPerTask) {
            const latest = latestAgreementFor(store, states, supersededBy, args.kind, taskSeq);
            const dispatchGuidance = activePlanId
              ? `approved plan_id="${activePlanId}" remains valid for team_dispatch in task_seq=${taskSeq}; stop calling team_discuss in this turn`
              : `stop calling team_discuss or unapproved team_dispatch in this turn and report the exact blocker to the user (quota resets on the next user message, task_seq=${taskSeq + 1})`;
            throw new Error(`discussion limit ${cfg.team.maxDiscussionsPerTask} reached for current task (task_seq=${taskSeq}, settled=${usedAll}/${cfg.team.maxDiscussionsPerTask}, latest_agreement_id=${latest?.id ?? 'none'}, active_approved_plan_id=${activePlanId ?? 'none'}): ${dispatchGuidance}`);
          }
        }
        const usedPlan = args.kind === 'plan' ? countConsecutiveUnapprovedPlans(store, states, taskSeq, stageIdForReview) : 0;
        if (args.kind === 'plan' && Number.isInteger(cfg.team.maxPlanAgreements) && usedPlan >= cfg.team.maxPlanAgreements && !hasConvergingPlanRevision(args,store,states,taskSeq)) {
          const latest = latestAgreementFor(store, states, supersededBy, 'plan', taskSeq);
          const reqChanges = latest?.state?.outcome?.requiredChanges ?? [];
          if (activePlanId !== null) {
            throw new Error(`plan agreement limit ${cfg.team.maxPlanAgreements} reached (task_seq=${taskSeq}, settled=${usedPlan}/${cfg.team.maxPlanAgreements}, latest_agreement_id=${latest?.id ?? 'none'}, active_approved_plan_id=${activePlanId}): stop calling team_discuss(kind="plan") in this turn and proceed with team_dispatch using active approved plan_id="${activePlanId}"`);
          }
          throw new Error(`plan agreement limit ${cfg.team.maxPlanAgreements} reached (task_seq=${taskSeq}, settled=${usedPlan}/${cfg.team.maxPlanAgreements}, latest_agreement_id=${latest?.id ?? 'none'}, latest_decision=${latest?.state?.outcome?.decision ?? 'none'}, remaining_required_changes=${JSON.stringify(reqChanges)}): stop calling team_discuss or writing-profile team_dispatch in this turn, do NOT propose leader single-agent coding, and report the exact remaining_required_changes to the user (quota resets automatically on the next user message, task_seq=${taskSeq + 1}, where you can resume with revises="${latest?.id ?? ''}")`);
        }
        if (args.proposal.length > cfg.agreement.maxProposalChars) throw new Error(`proposal exceeds ${cfg.agreement.maxProposalChars} chars`);
        const files = args.evidence_files ?? [];
        if (files.length > cfg.agreement.maxEvidenceFiles) throw new Error(`at most ${cfg.agreement.maxEvidenceFiles} evidence files`);
        let previousRequiredChanges = [];
        let previousChangeItems = [];
        const latestInTask = latestAgreementFor(store, states, supersededBy, args.kind, taskSeq, stageIdForReview);
        if (latestInTask && isTerminalAgreement(latestInTask.state) && (latestInTask.state.outcome?.decision === 'revise' || nextAction(latestInTask.state).kind === 'stalled') && args.revises !== latestInTask.id) {
          const reqs = latestInTask.state.outcome
            ? latestInTask.state.outcome.requiredChanges
            : [...new Set([...(latestInTask.state.rounds.at(-1)?.A?.requiredChanges ?? []), ...(latestInTask.state.rounds.at(-1)?.B?.requiredChanges ?? [])])];
          const statusLabel = latestInTask.state.outcome?.decision ?? 'stalled';
          throw new Error(`revises is required: ${args.kind} agreement "${latestInTask.id}" in current task #${taskSeq} ended as "${statusLabel}"; pass revises="${latestInTask.id}" addressing its required_changes: ${JSON.stringify(reqs)}`);
        }
        if (args.revises !== undefined) {
          if (!store.agreementIds().includes(args.revises)) throw new Error(`revises: unknown agreement ${args.revises}`);
          const prev = replay(store.agreementEvents(args.revises));
          if (reviewStage && !sameStage(store, args.revises, stageIdForReview)) throw new Error('a stage revision cannot supersede another stage agreement');
          if (prev.kind !== args.kind) throw new Error(`revises: ${args.revises} is a ${prev.kind} agreement, not ${args.kind}`);
          if (!isTerminalAgreement(prev)) {
            const fallbackHint = prev.revises ? `, or pass revises="${prev.revises}" to submit a fresh revision` : '';
            throw new Error(`revises: "${args.revises}" is still open (unsettled); call team_discuss with resume_id="${args.revises}" to finish it${fallbackHint}`);
          }
          if (supersededBy.has(args.revises)) {
            const headId = followSuperseded(supersededBy, args.revises);
            const headReq = states.get(headId)?.outcome?.requiredChanges ?? [];
            throw new Error(`revises: "${args.revises}" was already superseded by "${headId}"; pass revises="${headId}" so reviewers receive the latest required_changes: ${JSON.stringify(headReq)}`);
          }
          const previousInput = store.loadAgreementInput(args.revises);
          const priorOpinions = [prev.rounds.at(-1)?.A, prev.rounds.at(-1)?.B].filter(o => o && !o.invalid);
          previousChangeItems = prev.outcome?.changeItems ?? [...new Map([...(previousInput.previousChangeItems ?? []), ...priorOpinions.flatMap(o => o.changeItems ?? [])].map(item => [item.id, item])).values()];
          previousRequiredChanges = prev.outcome
            ? [...prev.outcome.requiredChanges]
            : [...new Set([...(previousInput.previousRequiredChanges ?? []), ...priorOpinions.flatMap(o => o.requiredChanges ?? [])])];
        }
        const executionConditions = args.kind==='delivery' ? [...new Set([
          ...activeApprovedPlanIds(store,states,supersededBy,taskSeq).flatMap(id=>states.get(id).outcome?.conditions??[]),
          ...store.stagnationSelections().filter(s=>s.taskSeq===taskSeq).flatMap(s=>s.executionGuardrails??[]),
        ])] : [];
        const parts = [];
        if(executionConditions.length) parts.push('Execution conditions from accepted plan; check each against actual attached evidence:\n'+executionConditions.map(x=>'- '+x).join('\n'));
        const omittedOrTruncatedFiles = [];
        if (args.evidence) parts.push(args.evidence);
        const realWorkspace = realpathBestEffort(workspace, platform);
        const globals = cfg.paths.globalRefRoots.map(g => resolvePath(g, undefined, platform)).filter(Boolean);
        const realGlobals = globals.map(g => realpathBestEffort(g, platform));
        const inBounds = p => {
          const realP = p === null ? null : realpathBestEffort(p, platform);
          return p !== null && (isInside(p, workspace, platform) || globals.some(g => isInside(p, g, platform))) &&
            realP !== null && (isInside(realP, realWorkspace, platform) || realGlobals.some(g => isInside(realP, g, platform)));
        };
        const attached = new Set();
        const attach = p => {
          let buf; try { buf = fs.readFileSync(p); } catch (e) { throw new Error(`cannot read evidence file ${p}: ${e.message}`); }
          const label = relativeInside(workspace, p, platform) ?? p;
          const text = buf.subarray(0, cfg.agreement.evidenceFileMaxBytes).toString('utf8');
          if (buf.length > cfg.agreement.evidenceFileMaxBytes) {
            omittedOrTruncatedFiles.push(`${label} (first ${cfg.agreement.evidenceFileMaxBytes} of ${buf.length} bytes)`);
          }
          parts.push(`### file: ${label}${buf.length > cfg.agreement.evidenceFileMaxBytes ? ` (first ${cfg.agreement.evidenceFileMaxBytes} bytes)` : ''}\n${text}`);
          attached.add(pathKey(p, platform));
        };
        for (const f of files) {
          const p = resolvePath(f, workspace, platform);
          if (!inBounds(p)) throw new Error(`evidence file must be inside the workspace or a global reference root: ${f}`);
          if (!attached.has(pathKey(p, platform))) attach(p);
        }
        // The user's request and the documents it names are the requirements the reviewers judge against.
        const userRequest = userTaskText(ctx, actor.teamId, DISCUSSION_REQUEST_CHARS);
        const autoEvidence = [];
        for (const name of namedDocuments(userRequest)) {
          const p = resolvePath(name, workspace, platform);
          if (!inBounds(p) || attached.has(pathKey(p, platform))) continue;
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (!st.isFile()) continue;
          if (attached.size >= cfg.agreement.maxEvidenceFiles) {
            omittedOrTruncatedFiles.push(`${relativeInside(workspace, p, platform) ?? p} (omitted: maxEvidenceFiles=${cfg.agreement.maxEvidenceFiles})`);
            continue;
          }
          attach(p);
          autoEvidence.push(relativeInside(workspace, p, platform) ?? p);
        }
        if (args.kind === 'delivery') {
          const manifestBlock = buildWorkspaceManifest(workspace, cfg, platform);
          const baseLen = parts.reduce((sum, s, idx) => sum + s.length + (idx > 0 ? 2 : 0), 0);
          if (manifestBlock && baseLen + manifestBlock.length + (parts.length > 0 ? 2 : 0) <= cfg.agreement.maxEvidenceChars) {
            parts.unshift(manifestBlock);
          }
        }
        const fullEvidence = parts.join('\n\n');
        const evidenceTruncated = omittedOrTruncatedFiles.length > 0 || fullEvidence.length > cfg.agreement.maxEvidenceChars;
        input = { environmentBlocked: args.environment_blocked === true, blockerReason: args.blocker_reason ?? null, kind: args.kind, taskSeq, topic: truncate(args.topic, 200), proposal: args.proposal, evidence: truncate(fullEvidence, cfg.agreement.maxEvidenceChars), evidenceTruncated, omittedOrTruncatedFiles, userRequest, previousRequiredChanges, previousChangeItems, executionConditions, ...(args.category ? { category: args.category } : {}), ...(args.revises ? { revises: args.revises } : {}), autoEvidenceFiles: autoEvidence };
        if (reviewStage) {
          input.stageReview = reviewStage;
          const frontier = frontierView(store, taskSeq);
          input.planningContext = { overview: frontier.overview, elapsed_ms: frontier.elapsed_ms, stages: frontier.stages, capacity: isPluginActive(rt, 'scheduler') ? compactConcurrency(evaluateTeamConcurrency(ctx, actor.teamId)) : fallbackConcurrencySnapshot(cfg, store, rt, actor.teamId) };
        }
        id = `agr-${randomUUID().slice(0, 8)}`;
        store.saveAgreementInput(id, input);
        store.appendAgreementEvent({ type: 'created', id, taskSeq, topic: input.topic, kind: input.kind, proposalHash: hashJson(input), maxRounds: cfg.agreement.maxRounds, maxArbiterAttempts: cfg.agreement.maxArbiterAttempts, ...(needsSerialProof(input) ? { serialProofRequired: true } : {}), routes: { A: cfg.roles.discussA.route, B: cfg.roles.discussB.route, arbiter: cfg.roles.arbiter.route, serialReviewer: cfg.roles.serialReviewer.route }, ...(input.revises ? { revises: input.revises } : {}) });
        if (input.kind === 'plan') {
          recordArchivedPlanSubmitted(ctx, {
            rt,
            teamId: actor.teamId,
            taskSeq,
            workspace,
            agreementId: id,
            topic: input.topic,
            proposal: input.proposal,
            userRequest: input.userRequest,
            evidenceSummary: input.evidence,
            revises: input.revises ?? null,
            explicitCategory: input.category ?? null,
          });
        }
      }
      // Each role answers on its configured route; a fallback route or, last, the leader's own model stands in only
      // when every earlier route is unavailable. An answer of any kind is final and is never re-asked on another route.
      const chainOf = roleKey => roleRouteChain(cfg, roleKey, currentSelection(exec.agent) ?? null).map(t=>['discussA','discussB'].includes(roleKey)?{...t,retries:Math.min(t.retries,1)}:t);
      const unusable = t => { const g = quotaGate(cfg, quotaState(rt), t.route, new Date()); return g.allowed ? null : g.error; };
      const degradedRoles = new Map();
      const degradedView = () => (degradedRoles.size ? { degraded_roles: [...degradedRoles].map(([k, t]) => degradedNote(k, t)) } : {});
      const call = async (roleKey, req, parse) => {
        const r = await callRoleJson(rt.llm, chainOf(roleKey), { system: req.system, user: req.user, signal: exec.signal }, parse, {
          skip: unusable,
          onAttempt: (t, a) => recordUsage(actor.teamId, { role: roleKey, route: t.route, effort: t.effort, ok: a.ok, attempts: a.attempts, agreementId: id, kind: input.kind, usage: a.usage ?? null, ...(t.degraded ? { degraded: true, via: t.via } : {}) }),
        });
        if (r.ok && r.target?.degraded) degradedRoles.set(roleKey, r.target);
        return r;
      };
      const ensureRolesQuota = roleKeys => {
        for (const k of roleKeys) {
          const chain = chainOf(k);
          if (chain.every(t => unusable(t) !== null)) throw new Error(`consensus cannot run: ${unusable(chain[0])}`);
        }
      };
      const projectTimer = getReviewTimerPayload(ctx, actor.teamId, workspace, { pendingPlanAttempt: input.kind === 'plan' }, rt);
      const normalizeOpinion = text => {
        const p = parseMemberOpinion(text); if (!p.ok) return p;
        try { return { ok:true, opinion:normalizeReview(p.opinion, { previousItems: input.previousChangeItems ?? [] }) }; }
        catch(e) { return { ok:false,error:e.message }; }
      };
      return withAgreementLock(rt, id, async () => {
        for (let guard = 0; guard < 20; guard++) {
          const state = replay(store.agreementEvents(id));
          const next = nextAction(state);
          const snap = agreementSnapshots(store);
          const activePlanId = activeApprovedPlanIds(store, snap.states, snap.supersededBy, state.taskSeq ?? 1).at(-1) ?? null;
          const settledPlanCount = input.kind === 'plan' && Number.isInteger(cfg.team.maxPlanAgreements)
            ? countConsecutiveUnapprovedPlans(store, snap.states, state.taskSeq ?? 1)
            : undefined;
          const planQuota = settledPlanCount !== undefined
            ? { settled: settledPlanCount, limit: cfg.team.maxPlanAgreements, remaining: Math.max(0, cfg.team.maxPlanAgreements - settledPlanCount) }
            : undefined;
          const context = {
            task_seq: state.taskSeq ?? 1,
            ...(input.kind === 'plan' ? { active_approved_plan_id: activePlanId } : {}),
            ...(planQuota ? { plan_quota: planQuota } : {}),
            auto_evidence_files: input.autoEvidenceFiles ?? [],
            ...(input.evidenceTruncated ? { evidence_truncated: true, omitted_or_truncated_files: input.omittedOrTruncatedFiles ?? [] } : {}),
            ...(input.revises ? { revises: input.revises } : {}),
          };
          if (next.kind === 'settled') {
            if (input.kind === 'plan') recordArchivedPlanSettled(ctx, { rt, teamId:actor.teamId,taskSeq:state.taskSeq,workspace,agreementId:id,state });
            if (input.kind === 'delivery') recordArchivedDeliverySettled(ctx, { rt,teamId:actor.teamId,taskSeq:state.taskSeq,workspace,deliveryAgreementId:id,outcome:state.outcome });
            const timer = getTeamTimerSnapshot(ctx,actor.teamId,workspace,rt);
            if (timer) context.timer = timer;
            if (input.kind === 'delivery' && input.environmentBlocked && input.revises && state.outcome?.decision !== 'approve') {
              const prior = replay(store.agreementEvents(input.revises));
              const oldHard = new Set((prior.outcome?.changeItems ?? []).filter(i=>i.hard_blocker).map(i=>i.id));
              const repeated = (state.outcome?.changeItems??[]).filter(i=>i.hard_blocker && oldHard.has(i.id));
              if (repeated.length) {
                const escalation = { options:['disclosed_delivery','user_assistance','stop'],reason:input.blockerReason,blockers:repeated };
                store.appendWorkflowEvent({type:'environment-escalation',taskSeq,agreementId:id,...escalation});
                return {...summarize(id,state),...context,status:'waiting_user',escalation,next_step_hint:'Ask the user to choose disclosed delivery, assistance, or stop. Do not loop or claim approval.'};
              }
            }
            const hostShellTool = process.platform === 'win32' ? 'pwsh' : 'bash';
            const nextHint = state.outcome?.decision === 'revise'
              ? (input.kind === 'delivery'
                ? (activePlanId !== null
                  ? `Delivery review returned "revise": do NOT end your turn or output "DELIVERY: not approved". Dispatch member(s) using active plan_id="${activePlanId}" (for profile="shell", include "read", "glob", "grep", "${hostShellTool}" and "read_image" in tools, plus "edit"/"write" if modifying files) to resolve every item in outcome.required_changes and collect real execution/browser verification evidence, then call team_discuss with kind="delivery" and revises="${id}".`
                  : `Delivery review returned "revise": do NOT end your turn or output "DELIVERY: not approved". Because active_approved_plan_id is null for current task_seq=${state.taskSeq ?? 1}, first update .leaderteam/refs/plan.md and call team_discuss(kind="plan") to obtain an approved plan_id, then dispatch member(s) under that plan_id (for profile="shell", include "read", "glob", "grep", "${hostShellTool}" and "read_image" in tools, plus "edit"/"write" if modifying files) to resolve every item in outcome.required_changes, and call team_discuss with kind="delivery" and revises="${id}".`)
                : planQuota && planQuota.remaining === 0
                ? (activePlanId !== null
                  ? `Plan agreement limit (${planQuota.settled}/${planQuota.limit}) reached for task_seq=${state.taskSeq ?? 1}, but earlier approved plan "${activePlanId}" remains active and valid: proceed with team_dispatch using plan_id="${activePlanId}" (incorporating reviewer feedback into member tasks/notes) instead of calling team_discuss(kind="plan") again.`
                  : `Plan agreement limit (${planQuota.settled}/${planQuota.limit}) reached for task_seq=${state.taskSeq ?? 1}. Do NOT call team_discuss or writing-profile team_dispatch in this turn and do NOT offer single-agent coding; report agreement "${id}" and its required_changes to the user (quota resets on the next user message).`)
                : `Address every item in outcome.required_changes without deleting previously satisfied sections, then call team_discuss with revises="${id}".`)
              : undefined;
            return { ...summarize(id, state), ...context, ...degradedView(), ...(nextHint ? { next_step_hint: nextHint } : {}) };
          }
          if (next.kind === 'stalled') return { ...summarize(id, state), ...context, status: 'stalled', reason: next.reason };
          if (next.kind === 'serial-review') {
            ensureRolesQuota(['serialReviewer']);
            const r = await call('serialReviewer', buildSerialReviewRequest(input, state), text => parseSerialProof(text, input));
            if (!r.ok) return { ...summarize(id, state), ...context, status: 'error', error: `serialReviewer: ${r.error.kind}: ${r.error.message}`, hint: `retry with team_discuss resume_id "${id}"; serial approval has not been granted` };
            store.appendAgreementEvent({ type: 'serial-proof', id, taskSeq, proof: r.proof });
            continue;
          }
          if (next.kind === 'members') {
            ensureRolesQuota(next.members.map(m => m === 'A' ? 'discussA' : 'discussB'));
            const results = await Promise.all(next.members.map(async m => ({ m, r: await call(m === 'A' ? 'discussA' : 'discussB', buildMemberRequest({ state, member: m, ...input, projectTimer }), normalizeOpinion) })));
            for (const { m, r } of results) {
              if (!r.ok) continue;
              const fresh = replay(store.agreementEvents(id));
              const freshNext = nextAction(fresh);
              if (freshNext.kind === 'members' && freshNext.round === next.round && freshNext.members.includes(m)) {
                store.appendAgreementEvent({ type: 'opinion', id, taskSeq, round: next.round, member: m, opinion: r.opinion });
              }
            }
            const failed = results.filter(x => !x.r.ok);
            for (const x of [...failed]) {
              if (x.r.error?.kind !== 'schema') continue;
              const fresh = replay(store.agreementEvents(id));
              const awaiting = nextAction(fresh);
              if (awaiting.kind === 'members' && awaiting.members.includes(x.m)) {
                store.appendAgreementEvent({type:'opinion',id,taskSeq,round:next.round,member:x.m,opinion:{stance:'revise',summary:'invalid review after bounded retry',reasons:[x.r.error.message],suggestions:[],requiredChanges:[],invalid:true}});
              }
              failed.splice(failed.indexOf(x),1);
            }
            if (failed.length) return { ...summarize(id, replay(store.agreementEvents(id))), status: 'error', error: failed.map(x => `member ${x.m}: ${x.r.error.kind} ${x.r.error.code}: ${x.r.error.message}`).join('; '), hint: `retry with team_discuss resume_id "${id}"` };
            continue;
          }
          ensureRolesQuota(['arbiter']);
          store.appendAgreementEvent({ type: 'arbiter-attempt', id, taskSeq });
          const invalidReview = state.rounds.at(-1)?.A?.invalid || state.rounds.at(-1)?.B?.invalid;
          const request = invalidReview ? buildMemberRequest({state:{...state,status:'open',rounds:[]},member:'A',...input,projectTimer}) : buildArbiterRequest({state,...input,projectTimer});
          if (invalidReview) request.system = 'You are the independent arbiter. A reviewer produced invalid advice; judge the complete proposal independently under the same requirements.\n'+request.system;
          const r = await call('arbiter',request,invalidReview?normalizeOpinion:parseArbiterRuling);
          if (r.ok) {
            const fresh = replay(store.agreementEvents(id));
            if (fresh.status === 'open' && fresh.ruling === null) {
              store.appendAgreementEvent(invalidReview ? {type:'independent-ruling',id,taskSeq,opinion:r.opinion} : { type: 'ruling', id, taskSeq, ruling: r.ruling });
            }
            continue;
          }
          return { ...summarize(id, replay(store.agreementEvents(id))), status: 'error', error: `arbiter: ${r.error.kind} ${r.error.code}: ${r.error.message}`, hint: `retry with team_discuss resume_id "${id}"` };
        }
        throw new Error('agreement loop did not converge (internal error)');
      });
    },
  });

  reg({
    name: 'team_note',
    description: 'Create or update a project reference file under the project references directory (.leaderteam/refs/). Global references are read-only and cannot be written.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path relative to the project references directory, e.g. "INDEX.md" or "design/api.md".' },
      content: { type: 'string', required: true },
      scope: { type: 'string', enum: ['project', 'current_plan'], description: 'current_plan writes the full plan outside the project for the current task; path must be plan.md.' },
      mode: { type: 'string', enum: ['write', 'append'], description: 'Default write.' },
    },
    output: json,
    async execute(args, exec) {
      const { rt, cfg, actor } = await leaderOf(ctx, exec);
      if (args.scope === 'current_plan') {
        if (args.path !== 'plan.md') throw new Error('current_plan scope only accepts path="plan.md"');
        return writeCurrentPlan(rt.storageRoot, actor.teamId, currentTaskSeq(ctx, actor.teamId), args.content, args.mode);
      }
      const platform = process.platform;
      const workspace = resolvePath(actor.cwd, undefined, platform);
      const realWorkspace = realpathBestEffort(workspace, platform);
      const refsDir = resolvePath(cfg.paths.projectRefsDir, workspace, platform);
      const realRefsDir = realpathBestEffort(refsDir, platform);
      const expectedRealRefsDir = resolvePath(cfg.paths.projectRefsDir, realWorkspace, platform);
      const globals = cfg.paths.globalRefRoots.map(g => resolvePath(g, undefined, platform)).filter(Boolean);
      const realGlobals = globals.map(g => realpathBestEffort(g, platform));
      const rawNotePath = typeof args.path === 'string' ? args.path.replace(/\\/g, '/').replace(/^\.\//, '') : args.path;
      const normRefsPrefix = cfg.paths.projectRefsDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
      const relNotePath = (typeof rawNotePath === 'string' && normRefsPrefix && pathKey(rawNotePath, platform).startsWith(pathKey(`${normRefsPrefix}/`, platform)))
        ? rawNotePath.slice(normRefsPrefix.length + 1)
        : args.path;
      const target = resolvePath(relNotePath, refsDir, platform);
      if (target === null || pathKey(target, platform) === pathKey(refsDir, platform) || !isInside(target, refsDir, platform)) throw new Error(`path must stay inside ${refsDir}`);
      const realTarget = realpathBestEffort(target, platform);
      if (
        pathKey(realTarget, platform) === pathKey(realRefsDir, platform) ||
        !isInside(realTarget, realRefsDir, platform) ||
        pathKey(realTarget, platform) === pathKey(expectedRealRefsDir, platform) ||
        !isInside(realTarget, expectedRealRefsDir, platform) ||
        !isInside(realTarget, realWorkspace, platform) ||
        globals.some(g => isInside(target, g, platform)) ||
        realGlobals.some(g => isInside(realTarget, g, platform))
      ) {
        throw new Error(`path must stay inside ${refsDir}`);
      }
      assertNoSymlinkInRefs(refsDir, target, platform);
      if (args.content.length > 400000) throw new Error('content exceeds 400000 chars');
      const mode = args.mode ?? 'write';
      let prevBytes = null;
      if (mode === 'write') {
        try { const st = fs.statSync(target); if (st.isFile()) prevBytes = st.size; } catch {}
      }
      const bytes = Buffer.byteLength(args.content, 'utf8');
      if (mode === 'append') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.appendFileSync(target, args.content, 'utf8'); }
      else writeFileAtomic(target, args.content);
      const shrunk = prevBytes !== null && prevBytes >= 4096 && bytes < prevBytes * 0.5;
      return {
        path: target,
        bytes,
        mode,
        ...(prevBytes !== null ? { previous_bytes: prevBytes } : {}),
        ...(shrunk ? { warning: 'file size shrank by >50% on mode="write"; ensure earlier specification sections were not accidentally dropped (use separate ref files or mode="append" for phase notes)' } : {}),
      };
    },
  });

  reg({
    name: 'team_status',
    description: 'Show team members, agreements and safety-gate statistics. Before ending a workflow turn, declare stop_state: delivered | waiting_members | waiting_user | blocked, with the actual question or blocker when applicable. The host checks the declaration independently.',
    parameters: {
      stop_state: { type: 'string', enum: STOP_STATES, description: 'Structured reason for ending this turn.' },
      reason: { type: 'string', description: 'Concrete blocker or explanation, at most 2000 characters.' },
      question: { type: 'string', description: 'Actual user-only question; required for waiting_user.' },
    },
    output: jsonCompact,
    async execute(_args, exec) {
      const isDiagnosticBlockedStop = Boolean(_args && (_args.stop_state === 'blocked' || _args.stop_state === 'waiting_user'));
      const { rt, cfg, actor, store, leaderModel } = await leaderOf(ctx, exec, { allowBlockedStopReport: isDiagnosticBlockedStop });
      reconcileStaleMembers(rt, store);
      const taskSeq = currentTaskSeq(ctx, actor.teamId);
      const events = exec.agent.session?.snapshotEvents?.() ?? [];
      const turn = events.findLast(e => e.type === 'turn/start')?.data?.turn ?? null;
      const autonomous = isAutonomousGovernance(cfg);
      const members = [...store.members().values()].map(m => ({ name: m.name, child_id: m.childId, actor_role: m.actorRole ?? 'member', task_seq: m.taskSeq ?? 1, plan_id: m.planId ?? null, model: m.model, effort: m.effort, profile: m.profile, write_scope: m.writeScope ?? [], status: m.status, error: m.error }));
      const activeMembers = members.filter(m => m.actor_role !== 'direct_exec' && m.task_seq === taskSeq && ['starting', 'started', 'running'].includes(m.status));
      const pausedMembers = members.filter(m => m.actor_role !== 'direct_exec' && m.task_seq === taskSeq && m.status === 'paused');
      const planning = cfg.team.rollingPlanning ? frontierView(store, taskSeq, { autonomous }) : null;
      const governance = autonomous ? replayGovernanceState(store.governanceEvents(), taskSeq) : null;
      if (_args.stop_state !== undefined) {
        if (_args.stop_state === 'waiting_reviews') {
          const pending = planning?.pending_execution_reviews.some(r => planning.stages.some(s => s.stage_id === r.stage_id && s.hash === r.stage_hash));
          if (!cfg.team.rollingPlanning || !pending || hasAdmissibleFrontierWork(rt, store, cfg, taskSeq)) throw new Error('waiting_reviews requires a pending current-version execution review and no admissible dispatch. Continue any useful later planning; provisional placeholders alone do not require polling.');
          if (rt.surface === 'headless') {
            const jobs = [...(rt.executionReviewJobs?.values() ?? [])].filter(j => j.teamId === actor.teamId && j.promise);
            if (jobs.length > 0) {
              await Promise.race(jobs.map(j => j.promise));
              return {
                task_seq: taskSeq,
                settled_reviews_ready: true,
                planning: frontierView(store, taskSeq),
                action_required: 'INSPECT_SETTLED_REVIEW_AND_ACT',
                instruction: 'An in-flight stage execution review just settled. Check planning.stages (plan_id or recent reviews) and dispatch or revise immediately in this turn.',
              };
            }
          }
        }
        const decl = stopDeclaration(_args, taskSeq, turn);
        const priorStop = turn !== null ? store.workflowEvents().findLast(e => e.type === 'stop-declared' && e.taskSeq === taskSeq && e.turn === turn) : null;
        const duplicateInTurn = Boolean(priorStop && priorStop.state === decl.state);
        if (!duplicateInTurn) store.appendWorkflowEvent({ type: 'stop-declared', ...decl });
        if (_args.stop_state === 'delivered') {
          rt.scheduler?.clearAwaitingSlots?.(actor.teamId, taskSeq);
        }
        return {
          task_seq: taskSeq,
          stop_declaration: {
            state: _args.stop_state,
            recorded: true,
            duplicate_in_turn: duplicateInTurn,
            action_required: 'END_TURN_NOW_NO_MORE_TOOL_CALLS',
            instruction: duplicateInTurn
              ? 'STOP POLLING IMMEDIATELY. This stop_state is ALREADY recorded for the current turn. Calling team_status or list_agents inside the same turn does NOT wait and wastes context. Output one short status sentence now and call ZERO tools.'
              : 'Stop declaration recorded. If no useful planning or permitted dispatch remains, finish this turn NOW with one short status sentence and ZERO further tool calls; host completion/review notices will wake you automatically.',
          },
          active_members: activeMembers.map(m => ({ name: m.name, child_id: m.child_id, status: m.status })),
          ...(leaderModel.blocked ? { leader_model_blocked: true, leader_model: leaderModelView(leaderModel) } : {}),
          ...(planning?.pending_execution_reviews.length ? { pending_execution_reviews: planning.pending_execution_reviews } : {}),
        };
      }
      const { states, supersededBy } = agreementSnapshots(store);
      const activePlanId = activeApprovedPlanIds(store, states, supersededBy, taskSeq).at(-1) ?? null;
      const agreements = store.agreementIds().map(id => {
        try {
          const s = replay(store.agreementEvents(id));
          const na = nextAction(s);
          const canResumeOpen = s.status === 'open' && na.kind !== 'stalled' && (s.kind !== 'plan' || (s.taskSeq ?? 1) === taskSeq);
          const sup = supersededBy.get(id) ?? null;
          const isApprovedSettled = s.status === 'settled' && s.outcome?.decision === 'approve';
          const base = (sup !== null || isApprovedSettled) ? summarizeBrief(id, s) : summarize(id, s);
          return {
            ...base,
            ...(na.kind === 'stalled' ? { status: 'stalled', reason: na.reason } : {}),
            ...(canResumeOpen ? { resume_hint: `unfinished agreement; call team_discuss with resume_id="${id}" to continue without resending inputs` } : {}),
            task_seq: s.taskSeq ?? 1,
            superseded_by: sup,
          };
        } catch (e) { return { id, error: e.message }; }
      });
      const pollDigest = hashJson({
        taskSeq,
        members: members.map(m => [m.child_id, m.status, m.error ?? null]),
        agreements: agreements.map(a => [a.id, a.status, a.outcome?.decision ?? null, a.superseded_by ?? null]),
        revision: planning?.revision ?? 0,
        pending: planning?.pending_execution_reviews ?? [],
        govEvents: governance?.eventsCount ?? 0,
      });
      rt.lastStatusPolls ??= new Map();
      const lastPoll = rt.lastStatusPolls.get(actor.teamId);
      rt.lastStatusPolls.set(actor.teamId, { turn, digest: pollDigest });
      if (turn !== null && lastPoll?.turn === turn && lastPoll.digest === pollDigest) {
        return {
          task_seq: taskSeq,
          unchanged_in_turn: true,
          active_members: activeMembers.map(m => ({ name: m.name, child_id: m.child_id, status: m.status })),
          ...(pausedMembers.length ? { paused_members: pausedMembers.map(m => ({ name: m.name, child_id: m.child_id, status: m.status })) } : {}),
          ...(governance ? { governance } : {}),
          ...(planning?.pending_execution_reviews.length ? { pending_execution_reviews: planning.pending_execution_reviews } : {}),
          action_required: activeMembers.length || planning?.pending_execution_reviews.length ? 'DECLARE_STOP_STATE_ONCE_AND_END_TURN' : 'ACT_WITHOUT_REPEATED_STATUS_POLLING',
          instruction: 'STOP POLLING. Team, member and review state have not changed since your previous team_status call in this turn. If waiting for running members or reviews, declare stop_state ONCE (if not yet declared) and END THIS TURN with zero further tool calls so host events can wake you.',
        };
      }
      const receipts = store.gateReceipts();
      const gate = {
        reviewed: receipts.filter(r => ['model', 'gpt'].includes(r.by)).length,
        sandbox_direct: receipts.filter(r => r.by === 'sandbox').length,
        gate_rule_checked: receipts.filter(r => r.by === 'gate-rule').length,
        gate_cached: receipts.filter(r => r.by === 'gate-cache').length,
        allowed: receipts.filter(r => r.decision === 'allow').length,
        allowed_current_task: receipts.filter(r => (r.taskSeq ?? 1) === taskSeq && r.decision === 'allow').length,
        denied: receipts.filter(r => r.decision === 'deny').length,
        recent_denials: receipts.filter(r => r.decision === 'deny').slice(-5).map(r => ({ tool: r.tool, member: r.member, by: r.by, reason: r.reason })),
      };
      const concurrency = isPluginActive(rt, 'scheduler')
        ? evaluateTeamConcurrency(ctx, actor.teamId)
        : fallbackConcurrencySnapshot(cfg, store, rt, actor.teamId);
      const timer = isPluginActive(rt, 'timerArchive') ? getTeamTimerSnapshot(ctx, actor.teamId, actor.cwd, rt) : null;
      return {
        task_seq: taskSeq,
        governance_mode: cfg.governance?.mode ?? 'autonomous',
        active_approved_plan_id: cfg.team.rollingPlanning ? null : activePlanId,
        active_selected_plan_id: store.stagnationSelections().findLast(s=>s.taskSeq===taskSeq&&s.by==='arbiter')?.agreementId ?? null,
        current_plan_file: currentPlanFile(rt.storageRoot,actor.teamId,taskSeq),
        active_plugins: activePluginsMap(rt),
        leader_model: leaderModelView(leaderModel),
        ...(timer ? { timer } : {}),
        concurrency,
        ...(governance ? { governance } : {}),
        ...(planning ? { planning } : {}),
        members,
        ...(pausedMembers.length ? { paused_members: pausedMembers } : {}),
        agreements,
        gate,
      };
    },
  });
}

function summarizeBrief(id, s) {
  return {
    id, kind: s.kind, topic: s.topic, status: s.status,
    ...(s.revises ? { revises: s.revises } : {}),
    outcome: s.outcome ? {
      decision: s.outcome.decision,
      by: s.outcome.by,
      round: s.outcome.round,
      ...(s.outcome.adopted ? { adopted: s.outcome.adopted } : {}),
      ...(s.outcome.conditions?.length ? { conditions: [...s.outcome.conditions] } : {}),
    } : null,
  };
}

function summarize(id, s) {
  return {
    id, kind: s.kind, topic: s.topic, status: s.status,
    ...(s.revises ? { revises: s.revises } : {}),
    outcome: s.outcome ? {
      decision: s.outcome.decision,
      by: s.outcome.by,
      round: s.outcome.round,
      ...(s.outcome.adopted ? { adopted: s.outcome.adopted } : {}),
      reasons: [...(s.outcome.reasons ?? [])],
      suggestions: [...(s.outcome.suggestions ?? [])],
      required_changes: [...s.outcome.requiredChanges],
      change_items: s.outcome.changeItems ?? [], conditions: s.outcome.conditions ?? [],
      ...(s.outcome.serialProof ? { serial_justification: s.outcome.serialProof } : {}),
    } : null,
    rounds: s.rounds.map(r => ({
      round: r.n,
      A: r.A && { stance: r.A.stance, summary: r.A.summary, reasons: [...(r.A.reasons ?? [])], suggestions: [...(r.A.suggestions ?? [])], required_changes: [...r.A.requiredChanges] },
      B: r.B && { stance: r.B.stance, summary: r.B.summary, reasons: [...(r.B.reasons ?? [])], suggestions: [...(r.B.suggestions ?? [])], required_changes: [...r.B.requiredChanges] },
    })),
    ...(s.serialReviews?.length ? { serial_reviews: s.serialReviews } : {}),
  };
}
