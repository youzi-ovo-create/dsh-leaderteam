// Team membership: who is a leader or member, their scoped instructions, tool masks and read tracking.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtime, baseRuntime, teamStore, runtimeForTeam, isPluginActive, activePluginsMap, effectiveRuntimeConfig } from './runtime.mjs';
import { TeamStore } from '../core/store.mjs';
import { leaderSection, memberSection, directExecSection } from '../core/prompts.mjs';
import { resolvePath, pathKey } from '../core/paths.mjs';
import { truncate } from '../core/redact.mjs';
import { CAPABILITY_TOOLS } from '../core/tool-policy.mjs';
import { DIRECT_EXEC_ALLOWED_TOOLS, LEADER_AUTONOMOUS_TOOLS } from '../core/constants.mjs';
import { replay, nextAction } from '../core/agreement.mjs';
import { isReadGrantOnlyMessage, isBareContinueMessage } from '../core/gate-policy.mjs';
import { reviewStop } from './stop-review.mjs';
import { isControlOnlyUserMessage } from '../core/scheduler.mjs';
import { resolveModelTarget } from '../core/upstream-models.mjs';
import { readCurrentPlan, currentPlanFile } from '../core/current-plan.mjs';
import { frontierState, frontierView, frontierNeedsPlanning, frontierHasDispatchableWork } from '../core/frontier.mjs';
import { formatFrontierContext } from './planning.mjs';
import { hasAdmissibleFrontierWork, hasAdmissibleNonShellFrontierWork, hasUnfinishedNonShellPlanWork } from './activation.mjs';
import { createAgentCircuitState, recordToolOutcomeInCircuit, recordTurnEndInCircuit } from '../core/circuit-breaker.mjs';
import { runCircuitInvestigation } from './investigator.mjs';
import { isAutonomousGovernance, replayGovernanceState } from '../core/governance-protocol.mjs';
import {
  awaitTeamGovernanceJobs,
  parseCheckpointFromMemberOutput,
  buildCheckpointResumePrompt,
  verifyActiveArbiterDirectives,
} from './governance.mjs';

const LEGACY_TOOLS = {
  readonly: ['read', 'read_image', 'glob', 'grep', 'todo_write'],
  code: ['read', 'read_image', 'glob', 'grep', 'todo_write', 'write', 'edit'],
  shell: ['read', 'read_image', 'glob', 'grep', 'todo_write', 'write', 'edit', 'pwsh', 'bash', 'job_list', 'job_output', 'job_kill'],
};
const leaderPromptDisposers = new WeakMap();

export function leaderAllowedTools(rt = runtime()) {
  const cfg = rt.config;
  if (!cfg) return [];
  const disabledTools = new Set();
  if (!isPluginActive(rt, 'scheduler')) disabledTools.add('team_concurrency');
  if (!isPluginActive(rt, 'consensus')) {
    disabledTools.add('team_discuss');
    disabledTools.add('team_conference');
  }
  if (!isPluginActive(rt, 'timerArchive')) disabledTools.add('team_plan_archive');
  const autonomousExtras = isAutonomousGovernance(cfg) ? LEADER_AUTONOMOUS_TOOLS : [];
  return [...new Set([...cfg.profiles.leader.tools, ...autonomousExtras, ...CAPABILITY_TOOLS])].filter(t => !disabledTools.has(t));
}

/** Determine the actor for an agent without side effects on DSH; registers it in the runtime map. */
export function resolveActor(ctx, agent) {
  const rt = runtime(); let cfg = rt.config;
  const header = agent.session?.header ?? {};
  const cwd = typeof header.cwd === 'string' ? header.cwd : null;
  let actor = null;
  if (header.origin === 'subagent') {
    const parentId = header.parentSession;
    if (typeof parentId === 'string' && TeamStore.exists(rt.storageRoot, parentId)) {
      cfg = runtimeForTeam(parentId).config;
      const rec = teamStore(parentId).getMember(agent.id);
      if (rec?.actorRole === 'direct_exec') {
        const directPool = new Set(DIRECT_EXEC_ALLOWED_TOOLS);
        const granted = (rec.allowedTools ?? []).filter(n => directPool.has(n));
        actor = {
          role: 'direct_exec',
          teamId: parentId,
          agentId: agent.id,
          name: rec.name,
          profile: rec.profile ?? 'code',
          model: rec.model ?? '',
          effort: rec.effort ?? '',
          taskSeq: rec.taskSeq ?? 1,
          planId: null,
          stageId: null,
          stageHash: null,
          allowedTools: granted,
          loadedTools: granted,
          shellFailure: rec.shellFailure,
          skills: [],
          writeScope: [...(rec.writeScope ?? [])],
          refs: [],
          task: rec.task,
          acceptance: [...(rec.acceptance ?? [])],
          userTask: rec.userTask ?? '',
          cwd: cwd ?? rec.cwd,
        };
      } else {
        const pool = new Set([...(cfg.profiles[rec?.profile]?.tools ?? []), ...(cfg.toolPolicy?.additionalTools ?? []), ...CAPABILITY_TOOLS]);
        const granted = (rec?.allowedTools ?? LEGACY_TOOLS[rec?.profile] ?? []).filter(n => pool.has(n));
        actor = rec
          ? { role: 'member', teamId: parentId, agentId: agent.id, name: rec.name, profile: rec.profile, model: rec.model ?? '', effort: rec.effort ?? '', taskSeq: rec.taskSeq ?? 1, planId: rec.planId ?? null, stageId: rec.stageId ?? null, stageHash: rec.stageHash ?? null, allowedTools: granted, loadedTools: (rec.loadedTools ?? granted).filter(n => granted.includes(n)), shellFailure: rec.shellFailure, skills: rec.skills ?? [], writeScope: [...rec.writeScope], refs: [...rec.refs], task: rec.task, acceptance: [...rec.acceptance], userTask: rec.userTask ?? '', cwd: cwd ?? rec.cwd }
          : { role: 'unknown', teamId: parentId, agentId: agent.id, allowedTools: [], cwd };
      }
    }
  } else if (isLeaderRoot(ctx, agent)) {
    teamStore(agent.id).ensure({ workspace: cwd, surface: rt.surface });
    cfg = runtimeForTeam(agent.id).config;
    const tools = leaderAllowedTools(runtimeForTeam(agent.id));
    actor = { role: 'leader', teamId: agent.id, agentId: agent.id, name: 'leader', profile: 'leader', allowedTools: tools, loadedTools: tools, skills: [], writeScope: [], refs: [], cwd };
  }
  if (actor) { actor.agent = agent; rt.actors.set(agent.id, actor); }
  return actor;
}
function isLeaderRoot(ctx, agent) {
  const rt = runtime();
  if (rt.surface === 'headless') return process.env.LEADERTEAM_HEADLESS_LEADER === '1';
  const presets = ctx.get('agentPresets');
  return presets?.presetForSession?.(agent.session) === rt.config.profiles.leader.preset;
}

export function onAgentCreated(ctx, { agent }) {
  const actor = resolveActor(ctx, agent);
  if (!actor) return;
  const rt = runtimeForTeam(actor.teamId), cfg = rt.config;
  if (actor.role === 'leader') {
    if (leaderPromptDisposers.has(agent)) return;
    teamStore(actor.teamId).ensure({ workspace: actor.cwd, surface: rt.surface });
    reconcileStaleMembers(rt, teamStore(actor.teamId));
    try { rt.onLeaderSessionReady?.(ctx, actor.teamId, actor.cwd); } catch {}
    // Apply the configured default only before this session has any durable selection.
    // Resuming a session must preserve its actual model/effort and report a mismatch.
    if (rt.surface === 'desktop' && agent.model?.recordedSelection?.() === null) {
      const target = resolveModelTarget(cfg, cfg.roles.leader.route, cfg.roles.leader.effort);
      agent.model.select(target);
    }
    const prompt = agent.ctx.systemPrompt;
    const disposers = [];
    disposers.push(prompt.section({ name: 'leaderteam:role', order: 9000, interpolate: false, text: leaderSection(cfg, activePluginsMap(rt)) }));
    disposers.push(prompt.context?.({ name: 'leaderteam:current-plan', order: 125, interpolate: false,
      text: () => {
        const seq = currentTaskSeq(ctx, actor.teamId);
        if (cfg.team.rollingPlanning) return formatFrontierContext(teamStore(actor.teamId), seq, cfg);
        const plan = readCurrentPlan(rt.storageRoot, actor.teamId, seq);
        return `Current full task plan: ${currentPlanFile(rt.storageRoot, actor.teamId, seq)}. ${plan ? 'Read this file after context compaction; it is the source of plan review.' : 'Write the full plan using team_note(scope="current_plan", path="plan.md").'}`;
      } }));
    disposers.push(prompt.context?.({
      name: 'leaderteam:concurrency',
      order: 130,
      interpolate: false,
      text: () => rt.formatLeaderContext?.(actor.teamId) ?? '',
    }));
    leaderPromptDisposers.set(agent, disposers);
    if (cfg.team.rollingPlanning && isPluginActive(rt, 'consensus')) {
      rt.recoverExecutionReviews?.(actor, currentTaskSeq(ctx, actor.teamId));
    }
  } else if (actor.role === 'member') {
    if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.add(agent.id);
    const m = { name: actor.name, profile: actor.profile, model: '', effort: '', allowedTools: actor.allowedTools, loadedTools: actor.loadedTools, skills: actor.skills, writeScope: actor.writeScope, refs: actor.refs, task: actor.task, acceptance: actor.acceptance, userTask: actor.userTask };
    const rec = teamStore(actor.teamId).getMember(agent.id);
    if (rec) { m.model = rec.model; m.effort = rec.effort; }
    agent.ctx.systemPrompt.section({ name: 'leaderteam:role', order: 9000, interpolate: false, text: memberSection(m, cfg.paths.protectedDirs) });
    if (actor.shellFailure) appendShellFailureInstruction(agent, actor.shellFailure);
  } else if (actor.role === 'direct_exec') {
    if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.add(agent.id);
    const rec = teamStore(actor.teamId).getMember(agent.id);
    const m = { name: actor.name, profile: actor.profile, model: rec?.model ?? actor.model, effort: rec?.effort ?? actor.effort, allowedTools: actor.allowedTools, loadedTools: actor.loadedTools, writeScope: actor.writeScope, task: actor.task, acceptance: actor.acceptance, userTask: actor.userTask };
    agent.ctx.systemPrompt.section({ name: 'leaderteam:role', order: 9000, interpolate: false, text: directExecSection(m, cfg.paths.protectedDirs) });
    if (actor.shellFailure) appendShellFailureInstruction(agent, actor.shellFailure);
  }
  // The final registry-view filter covers inherited AND preset-local tools.
  // tools.restrict() intentionally exempts local registrations, so it cannot enforce this contract.
}
export function onAgentPresetSelected(ctx, sessionId) {
  const agent = runtime().hostAgents?.get?.(sessionId);
  if (agent) syncDesktopLeaderRole(ctx, agent);
}

function syncDesktopLeaderRole(ctx, agent) {
  const rt = runtime();
  if (rt.surface !== 'desktop' || agent.session?.header?.origin === 'subagent') return;
  if (isLeaderRoot(ctx, agent)) {
    if (!leaderPromptDisposers.has(agent)) onAgentCreated(ctx, { agent });
    return;
  }
  for (const dispose of leaderPromptDisposers.get(agent) ?? []) if (typeof dispose === 'function') dispose();
  leaderPromptDisposers.delete(agent);
  const actor = rt.actors.get(agent.id);
  if (actor?.agent === agent && actor.role === 'leader') rt.actors.delete(agent.id);
}
/** Global tool names to hide from a team agent: all names not granted by its profile. Pure. */
export function maskedGlobalTools(globalNames, allowedTools) {
  const allowed = new Set(allowedTools ?? []);
  return [...new Set(globalNames)].filter(n => typeof n === 'string' && !allowed.has(n)).sort();
}
export function onAgentDisposed({ agent }) {
  const rt = runtime();
  const actor = agent ? rt.actors.get(agent.id) : undefined;
  if (actor?.role === 'member' || actor?.role === 'direct_exec') {
    const err = rt.memberErrors?.get(agent.id);
    if (actor.teamId && rt.storageRoot) {
      try {
        const rec = teamStore(actor.teamId).getMember(agent.id);
        const cur = rec?.status;
        if (cur === 'starting' || cur === 'started' || cur === 'running') {
          teamStore(actor.teamId).setMemberStatus(agent.id, err ? 'failed' : 'cancelled', err ? err.message : 'member agent disposed while active');
          if (actor.role === 'member') {
            rt.scheduler?.recordMemberFinished?.(actor.teamId, rec?.taskSeq ?? 1);
            rt.onMemberTerminalStatus?.(actor.teamId, rec?.taskSeq ?? 1, agent.id);
          }
        }
      } catch {}
    }
    rt.memberErrors?.delete(agent.id);
  }
  if (actor?.agent === agent) { rt.actors.delete(agent.id); rt.reads.delete(agent.id); rt.readProgress?.delete(agent.id); baseRuntime(rt).circuitStates?.delete(agent.id); baseRuntime(rt).pendingMemberContinuations?.delete(agent.id); }
}

function ensureCircuitState(rt, agentId, role = 'member') {
  const base = baseRuntime(rt);
  base.circuitStates ??= new Map();
  let st = base.circuitStates.get(agentId);
  if (!st) {
    st = createAgentCircuitState(agentId, role);
    base.circuitStates.set(agentId, st);
  }
  return st;
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function summarizeToolTarget(name, rawArgs) {
  const args = parseToolArgs(rawArgs);
  if (!args || typeof args !== 'object') return '';
  if (typeof args.file_path === 'string') return truncate(args.file_path, 80);
  if (typeof args.path === 'string') return truncate(args.path, 80);
  if (typeof args.stage_id === 'string') return args.action ? `${args.action}:${args.stage_id}` : args.stage_id;
  if (typeof args.action === 'string') return args.action;
  if (typeof args.stop_state === 'string') return `stop_state=${args.stop_state}`;
  if (typeof args.name === 'string') return args.name;
  if (typeof args.command === 'string') return truncate(args.command.replace(/\s+/g, ' ').trim(), 80);
  return '';
}

function extractSessionTurnCompletedTools(evs, turnEndIdx) {
  if (!Array.isArray(evs) || turnEndIdx < 0) return [];
  const callById = new Map();
  const failedIds = new Set();
  const completed = [];
  let startIdx = 0;
  for (let i = turnEndIdx - 1; i >= 0; i--) {
    if (evs[i]?.type === 'turn/start') { startIdx = i + 1; break; }
  }
  for (let i = startIdx; i < turnEndIdx; i++) {
    const ev = evs[i];
    if (ev?.type === 'tool/call') {
      const cid = ev.data?.callId ?? ev.data?.id ?? `idx-${i}`;
      const nm = ev.data?.name ?? 'tool';
      const tgt = summarizeToolTarget(nm, ev.data?.arguments);
      callById.set(cid, tgt ? `${nm}(${tgt})` : nm);
    } else if (ev?.type === 'assistant/message') {
      for (const b of eventContentBlocks(ev)) {
        if (b?.type === 'tool-call' || b?.type === 'toolCall') {
          const cid = b.id ?? b.callId;
          const nm = b.name ?? 'tool';
          const tgt = summarizeToolTarget(nm, b.arguments ?? b.input);
          if (cid) callById.set(cid, tgt ? `${nm}(${tgt})` : nm);
        }
      }
    } else if (ev?.type === 'tool/result') {
      const cid = ev.data?.callId ?? ev.data?.toolCallId;
      if (ev.data?.isError) {
        if (cid) failedIds.add(cid);
      } else if (cid && callById.has(cid)) {
        completed.push(callById.get(cid));
      } else if (ev.data?.name) {
        completed.push(ev.data.name);
      }
    }
  }
  if (completed.length === 0 && callById.size > 0) {
    for (const [cid, label] of callById.entries()) {
      if (!failedIds.has(cid)) completed.push(label);
    }
  }
  return [...new Set(completed)];
}

function buildMemberTruncationContinuationPrompt(rec, completedInTurn, cumulativeCompleted) {
  const turnList = completedInTurn.length > 0
    ? completedInTurn.join(', ')
    : '(none — your last response hit the single-turn output token limit before a tool call finished)';
  const cumulativeTail = cumulativeCompleted.slice(-20);
  const cumulativeNote = cumulativeTail.length > 0
    ? `\nCumulative completed operations in this activation (already on disk — DO NOT re-run): ${cumulativeTail.join(', ')}.`
    : '';
  return [
    `[LeaderTeam output continuation — member "${rec?.name ?? 'member'}"]`,
    'Your previous response reached the single-turn output token limit (`max-tokens`). This is NOT a failure: your session context, read tracking, permissions, and workspace files are completely preserved.',
    `Already succeeded in the truncated turn (DO NOT repeat these operations): ${turnList}.${cumulativeNote}`,
    'Continue directly from the exact interruption point:',
    '- Do NOT re-execute already-succeeded `write`, `edit`, or shell commands.',
    '- If a tool call at the very end of your last response was cut off before executing, issue only that unfinished call now.',
    '- When creating or editing large files, keep pre-tool commentary brief and write one bounded file/section per tool call so each call completes cleanly.',
    '- Finish your remaining acceptance checks and report `STATUS: done` (or `STATUS: blocked` only for a genuine external obstacle).',
  ].join('\n');
}
export function onAgentStatus(ctx, { agent, status } = {}) {
  let rt = runtime();
  if (!rt.config || !rt.storageRoot || !agent) return;
  // DSH announces running before resolving the first step's model, tools and prompt.
  if (status === 'running') syncDesktopLeaderRole(ctx, agent);
  const actor = (rt.actors.get(agent.id)?.agent === agent ? rt.actors.get(agent.id) : null) ?? resolveActor(ctx, agent);
  rt = runtimeForTeam(actor?.teamId);
  if (actor?.role === 'leader') {
    if (status === 'idle') {
      const notified = rt.onLeaderIdle?.(ctx, actor.teamId);
      if (!notified) maybeAutoContinueLeader(ctx, rt, actor, agent);
    }
    return;
  }
  if (actor?.role !== 'member' && actor?.role !== 'direct_exec') return;
  if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.add(agent.id);
  const store = teamStore(actor.teamId);
  const rec = store.getMember(agent.id);
  const cur = rec?.status;
  if (!cur) return;
  if (status === 'running' && cur !== 'running') {
    rt.memberExecutionProgress ??= new Map();
    rt.memberExecutionProgress.set(agent.id, new Set());
    try { store.setMemberStatus(agent.id, 'running'); } catch {}
  } else if (status === 'idle') {
    const pendingCont = baseRuntime(rt).pendingMemberContinuations?.get(agent.id);
    if (pendingCont) {
      baseRuntime(rt).pendingMemberContinuations.delete(agent.id);
      if (typeof agent.followup === 'function') {
        try {
          agent.followup(pendingCont.message);
          return;
        } catch (err) {
          rt.logger?.warn?.(`leaderteam: deferred member continuation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    const err = rt.memberErrors?.get(agent.id);
    if (err && (cur === 'starting' || cur === 'started' || cur === 'running')) {
      rt.memberErrors.delete(agent.id);
      try {
        store.setMemberStatus(agent.id, 'failed', err.message);
        if (actor.role === 'member') {
          rt.scheduler?.recordMemberFinished?.(actor.teamId, rec?.taskSeq ?? 1);
          rt.onMemberTerminalStatus?.(actor.teamId, rec?.taskSeq ?? 1, agent.id);
        }
      } catch {}
    }
  }
}

const ACTIVE_MEMBER_STATES = new Set(['starting', 'started', 'running']);

export function reconcileStaleMembers(rt, store) {
  if (!rt || !(rt.liveProcessMemberIds instanceof Set) || typeof rt.hostAgents?.get !== 'function' || !store) return;
  for (const m of store.members().values()) {
    if (!ACTIVE_MEMBER_STATES.has(m.status)) continue;
    if (rt.liveProcessMemberIds.has(m.childId)) continue;
    if (rt.hostAgents.get(m.childId) !== undefined) {
      rt.liveProcessMemberIds.add(m.childId);
      continue;
    }
    try {
      store.setMemberStatus(m.childId, 'cancelled', 'interrupted by previous host exit');
    } catch {}
  }
}

function eventContentBlocks(ev) {
  return ev?.data?.message?.content ?? ev?.data?.content ?? [];
}

function buildContinuationMessage(rt, text) {
  const input = { content: [{ type: 'text', text }], source: { kind: 'cordis-host-runner' } };
  if (typeof rt.createUserMessage === 'function') return rt.createUserMessage(input);
  return Object.freeze({ ...input, role: 'user', id: randomUUID() });
}

function sessionHasWorkflowTracking(evs, cwd, projectRefsDir) {
  if (evs.some(e => e?.type === 'todo/write' || (e?.type === 'tool/call' && e.data?.name === 'todo_write'))) return true;
  if (typeof cwd === 'string' && typeof projectRefsDir === 'string') {
    try { if (fs.existsSync(path.join(cwd, projectRefsDir, 'plan.md'))) return true; } catch {}
  }
  return false;
}

function effectiveWorkspaceShellFailure(rt, store, cwd) {
  if (!cwd) return null;
  const key = pathKey(cwd);
  const live = rt.workspaceShellFailures?.get(key);
  if (live) return live;
  const shellTools = new Set(rt.config?.gate?.shellTools ?? []);
  let persisted = null;
  for (const m of store.members().values()) {
    if (m.cwd && pathKey(m.cwd) !== key) continue;
    if (m.shellFailure) {
      persisted = m.shellFailure;
    } else if (m.status === 'done' && (m.profile === 'shell' || (m.loadedTools ?? m.allowedTools ?? []).some(t => shellTools.has(t)))) {
      persisted = null;
    }
  }
  return persisted;
}

async function maybeAutoContinueLeader(ctx, rt, actor, agent) {
  try {
    if (rt.stopReviewPending?.has(actor.teamId)) return;
    if (typeof agent.followup !== 'function') return;
    if ((agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) return;
    const store = teamStore(actor.teamId);
    reconcileStaleMembers(rt, store);
    const rolling = rt.config.team.rollingPlanning;
    const planningWork = rolling && frontierNeedsPlanning(store, currentTaskSeq(ctx, actor.teamId));
    for (const m of store.members().values()) if (m.actorRole !== 'direct_exec' && ACTIVE_MEMBER_STATES.has(m.status) && !planningWork) return;
    if (typeof agent.session?.snapshotEvents !== 'function') return;
    const evs = agent.session.snapshotEvents();
    if (!Array.isArray(evs) || evs.length === 0) return;
    let lastTurnEndIdx = -1;
    for (let i = evs.length - 1; i >= 0; i--) {
      if (evs[i]?.type === 'turn/end') { lastTurnEndIdx = i; break; }
    }
    if (lastTurnEndIdx < 0) return;
    const endReason = evs[lastTurnEndIdx]?.data?.reason?.kind;
    if (!['completed', 'max-tokens'].includes(endReason)) return;
    let finalText = null;
    let hitHardTerminalBlocker = false;
    for (let i = lastTurnEndIdx - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev?.type === 'turn/start') break;
      if (finalText === null && ev?.type === 'assistant/message') {
        finalText = eventContentBlocks(ev).filter(b => b?.type === 'text').map(b => b.text).join('\n');
      }
      if (ev?.type === 'tool/result') {
        const txt = eventContentBlocks(ev).filter(b => b?.type === 'text').map(b => b.text).join('\n');
        if (/consensus cannot run:|plan agreement limit \d+ reached|discussion limit \d+ reached|workspace OS sandbox initialization failed/i.test(txt)) {
          hitHardTerminalBlocker = true;
        }
      }
    }
    finalText ??= '';
    const taskSeq = currentTaskSeq(ctx, actor.teamId);
    const states = new Map();
    const supersededBy = new Map();
    for (const id of store.agreementIds()) {
      try {
        const s = replay(store.agreementEvents(id));
        states.set(id, s);
        if (s.revises && (s.status === 'settled' || nextAction(s).kind === 'stalled')) supersededBy.set(s.revises, id);
      } catch {}
    }
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
    const activePlanIds = store.agreementIds().filter(id => {
      const s = states.get(id);
      return s && s.kind === 'plan' && (s.taskSeq ?? 1) === taskSeq && !replacedApproved(id) && s.outcome?.decision === 'approve';
    });
    const activePlanId = activePlanIds.at(-1) ?? null;
    const approvedDeliveryIds = store.agreementIds().filter(id => {
      const s = states.get(id);
      return s && s.kind === 'delivery' && (s.activeTaskSeq ?? s.taskSeq ?? 1) === taskSeq && !supersededBy.has(id) && s.outcome?.decision === 'approve';
    });
    const latestDeliveryId = store.agreementIds().filter(id => {
      const s = states.get(id);
      return s && s.kind === 'delivery' && (s.activeTaskSeq ?? s.taskSeq ?? 1) === taskSeq && !supersededBy.has(id);
    }).at(-1) ?? null;
    const latestDelivery = latestDeliveryId ? { id: latestDeliveryId, state: states.get(latestDeliveryId) } : null;
    let consecutiveUnapprovedDeliveries = 0;
    for (const id of store.agreementIds()) {
      const s = states.get(id);
      const isTerm = Boolean(s) && (s.status === 'settled' || nextAction(s).kind === 'stalled');
      if (!s || s.kind !== 'delivery' || (s.taskSeq ?? 1) !== taskSeq || !isTerm) continue;
      if (s.outcome?.decision === 'approve') consecutiveUnapprovedDeliveries = 0;
      else consecutiveUnapprovedDeliveries++;
    }

    const endTurn = evs[lastTurnEndIdx]?.data?.turn ?? null;
    const declaration = store.workflowEvents().findLast(e => e.type === 'stop-declared' && e.taskSeq === taskSeq && e.turn === endTurn);
    const activeMembers = [...store.members().values()].filter(m => m.actorRole !== 'direct_exec' && ACTIVE_MEMBER_STATES.has(m.status));

    if (isAutonomousGovernance(rt.config)) {
      const hasDeliveryClaimText = /^\s*DELIVERY:\s*(approved|completed)\b/im.test(finalText);
      if (declaration?.state === 'delivered' || hasDeliveryClaimText || activeMembers.length === 0) {
        await awaitTeamGovernanceJobs(rt, actor.teamId, 30000);
        if (agent.status === 'running' || currentTaskSeq(ctx, actor.teamId) !== taskSeq || (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) return;
      }

      const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
      const effectiveShellFailure = effectiveWorkspaceShellFailure(rt, store, actor.cwd);
      const hasDispatchableNonShellWork = hasAdmissibleNonShellFrontierWork(rt, store, rt.config, taskSeq);
      const unfinishedNonShellPlanWork = hasUnfinishedNonShellPlanWork(store, rt.config, taskSeq);
      const noHardBlockerAuto = !/允许读取|allow read/i.test(finalText)
        && (!effectiveShellFailure || hasDispatchableNonShellWork || unfinishedNonShellPlanWork)
        && !hitHardTerminalBlocker;

      // Single-turn output-token truncation (`max-tokens`) always recovers seamlessly first:
      if (endReason === 'max-tokens' && noHardBlockerAuto) {
        const cbState = ensureCircuitState(rt, actor.agentId, 'leader');
        const sessionTurnTools = extractSessionTurnCompletedTools(evs, lastTurnEndIdx);
        if (cbState.turnCompletedTools.length === 0 && sessionTurnTools.length > 0) {
          cbState.turnCompletedTools.push(...sessionTurnTools);
        }
        const cbDecision = recordTurnEndInCircuit(cbState, { reasonKind: 'max-tokens' }, rt.config.circuitBreaker);
        const leaderTurnCompletedTools = [...new Set([...cbDecision.completedInTurn, ...sessionTurnTools])];
        if (cbDecision.trigger === 'hard' && cbDecision.exhaustedConsolidations) return;
        if (cbDecision.trigger === 'soft' || cbDecision.trigger === 'hard') {
          void runCircuitInvestigation({ ctx, rt, store, actor, agent, circuitState: cbState, decision: cbDecision, taskSeq });
          if (cbDecision.trigger === 'hard') return;
        }
        store.appendWorkflowEvent({
          type: 'output-truncation-continued',
          role: 'leader',
          taskSeq,
          agentId: actor.agentId,
          completedInTurn: leaderTurnCompletedTools,
          totalTruncations: cbDecision.totalTruncations,
          zeroProgressStreak: cbDecision.zeroProgressTruncations,
        });
        const summary = leaderTurnCompletedTools.length > 0
          ? leaderTurnCompletedTools.join(', ')
          : '(none completed in the truncated turn — issue the next concrete tool call directly)';
        agent.followup(buildContinuationMessage(rt, `[LeaderTeam output recovery] The last model response hit its single-turn output-token limit before this task was delivered. Context and workspace state are preserved.\nAlready succeeded in the truncated turn (DO NOT repeat these calls): ${summary}.\nResume directly from the interruption point with the next required tool call.`));
        return;
      }

      // Pre-conference pause barrier in progress -> `openFormalConference` will wake the Leader as soon as all models pause:
      if (gov.pausingConference) {
        return;
      }

      // Stage 3 Formal Arbiter–Leader Conference open -> Leader must respond in `team_conference`:
      if (gov.activeConference) {
        const conf = gov.activeConference;
        const fingerprint = `conf:${conf.conferenceId}:${conf.turns.length}`;
        rt.autoContinueState ??= new Map();
        const stateKey = `${actor.teamId}:${taskSeq}`;
        const prev = rt.autoContinueState.get(stateKey);
        const streak = prev && prev.fingerprint === fingerprint ? prev.streak + 1 : 1;
        rt.autoContinueState.set(stateKey, { fingerprint, streak });
        if (streak > 3) return;
        agent.followup(buildContinuationMessage(rt, `[LeaderTeam Formal Conference "${conf.conferenceId}"] Independent Arbiter has convened a 2-party formal conference on dispute ${conf.disputeId} (strike #${conf.strike}). All execution dispatches (team_dispatch, send_message, and team_direct_exec) are suspended during the conference. Call team_conference(action="respond", conference_id="${conf.conferenceId}", explanation=..., new_evidence_files=..., proposed_alternative=...) now to present your facts or alternative before concluding.`));
        return;
      }

      // Strike 3 Human Escalation open -> stop cleanly for User unless Leader falsely claimed `delivered`:
      if (gov.activeHumanEscalation) {
        if (declaration?.state === 'delivered' || hasDeliveryClaimText) {
          const esc = gov.activeHumanEscalation;
          const fingerprint = `esc:${esc.escalationId}`;
          rt.autoContinueState ??= new Map();
          const stateKey = `${actor.teamId}:${taskSeq}`;
          const prev = rt.autoContinueState.get(stateKey);
          const streak = prev && prev.fingerprint === fingerprint ? prev.streak + 1 : 1;
          rt.autoContinueState.set(stateKey, { fingerprint, streak });
          if (streak > 2) return;
          agent.followup(buildContinuationMessage(rt, `[LeaderTeam Human Escalation "${esc.escalationId}"] Dispute ${esc.disputeId} reached its 3rd unanimous objection and is escalated to the User (§5). Do NOT claim delivery yet: call team_status(stop_state="waiting_user", reason=..., question=...) and present the dispute dossier and options clearly to the User.`));
        }
        return;
      }

      if (declaration && ['waiting_user', 'blocked'].includes(declaration.state)) {
        const review = await reviewStop(rt, store, actor, agent, declaration, {
          activeMembers: activeMembers.length,
          workspaceShellFailure: effectiveShellFailure,
          hitHardTerminalBlocker,
          hasDispatchableNonShellWork,
          hasUnfinishedNonShellPlanWork: unfinishedNonShellPlanWork,
        }, userTaskText(ctx, actor.teamId, 3000));
        if (review.action === 'stop') return;
        if (agent.status === 'running' || currentTaskSeq(ctx, actor.teamId) !== taskSeq || (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) return;
        const stopStreakKey = `stop-review:${actor.teamId}:${taskSeq}`;
        rt.autoContinueState ??= new Map();
        const prevStopStreak = rt.autoContinueState.get(stopStreakKey)?.streak ?? 0;
        if (prevStopStreak >= 2) return;
        rt.autoContinueState.set(stopStreakKey, { fingerprint: 'stop-review', streak: prevStopStreak + 1 });
        agent.followup(buildContinuationMessage(rt, `[LeaderTeam stop review${review.escalatedToArbiter ? ' (Arbiter)' : ''}] This checkpoint should continue within the current authorization: ${review.directive}`));
        return;
      }

      if (declaration?.state === 'waiting_members' && activeMembers.length > 0 && !hasAdmissibleFrontierWork(rt, store, rt.config, taskSeq)) return;

      const unsatisfiedCorrection = gov.activeDirectives.find(d => d.decision === 'enforce_correction' || d.decision === 'adopt_alternative');
      if (unsatisfiedCorrection && (declaration?.state === 'delivered' || hasDeliveryClaimText)) {
        const verifyRes = await verifyActiveArbiterDirectives({
          rt,
          store,
          actor,
          leaderModel: agent.model?.current?.() ?? null,
          taskSeq,
        });
        if (agent.status === 'running' || currentTaskSeq(ctx, actor.teamId) !== taskSeq || (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) return;
        if (!verifyRes.allSatisfied) {
          const firstMissing = verifyRes.missing[0];
          const fingerprint = `dir:${firstMissing.conferenceId}:${store.members().size}:${firstMissing.reason.slice(0, 64)}`;
          rt.autoContinueState ??= new Map();
          const stateKey = `${actor.teamId}:${taskSeq}`;
          const prev = rt.autoContinueState.get(stateKey);
          const streak = prev && prev.fingerprint === fingerprint ? prev.streak + 1 : 1;
          rt.autoContinueState.set(stateKey, { fingerprint, streak });
          if (streak > 3) return;
          agent.followup(buildContinuationMessage(rt, `[LeaderTeam Arbiter Directive] Formal conference "${firstMissing.conferenceId}" issued binding requirement(s): ${firstMissing.directives.join('; ')}. Verification status: ${firstMissing.reason} Execute and verify the required correction via team_dispatch or team_direct_exec before declaring delivery.`));
          return;
        }
      }

      if (activeMembers.length === 0 && (declaration?.state === 'delivered' || hasDeliveryClaimText)) {
        return;
      }

      const taskStarted = [...store.members().values()].some(m => (m.taskSeq ?? 1) === taskSeq) || (rolling && frontierState(store, taskSeq).revision > 0);
      if (!taskStarted || !noHardBlockerAuto) return;

      const settledMembers = [...store.members().values()].filter(m => !ACTIVE_MEMBER_STATES.has(m.status)).length;
      const fingerprint = `auto:${store.members().size}:${settledMembers}:${rolling ? frontierState(store, taskSeq).revision : 0}:${gov.eventsCount}`;
      rt.autoContinueState ??= new Map();
      const stateKey = `${actor.teamId}:${taskSeq}`;
      const prev = rt.autoContinueState.get(stateKey);
      const streak = prev && prev.fingerprint === fingerprint ? prev.streak + 1 : 1;
      rt.autoContinueState.set(stateKey, { fingerprint, streak });
      if (streak > 3) return;

      agent.followup(buildContinuationMessage(rt, `[LeaderTeam autonomous workflow] Work for task_seq=${taskSeq} is not yet finalized (running_ordinary_members=${activeMembers.length}). Continue dispatching ready work via team_dispatch or running local verification/fixes via team_direct_exec; once all acceptance checks pass, call team_status(stop_state="delivered") and output "DELIVERY: completed" in the user's language.`));
      return;
    }
    // Planning B remains asynchronous, but an actual wait is not a missing-member failure.
    // Background planning advice and real completion events may still wake the leader.
    if (rolling && declaration?.state === 'waiting_members' && activeMembers.length && !hasAdmissibleFrontierWork(rt, store, rt.config, taskSeq)) return;
    const effectiveShellFailureLegacy = effectiveWorkspaceShellFailure(rt, store, actor.cwd);
    const hasDispatchableNonShellLegacy = rolling ? hasAdmissibleNonShellFrontierWork(rt, store, rt.config, taskSeq) : false;
    const unfinishedNonShellLegacy = rolling ? hasUnfinishedNonShellPlanWork(store, rt.config, taskSeq) : false;
    let reviewedContinue = null;
    if (declaration && ['waiting_user', 'blocked'].includes(declaration.state) && approvedDeliveryIds.length === 0) {
      const review = await reviewStop(rt, store, actor, agent, declaration, { activePlanId, latestDeliveryId, deliveryDecision: latestDelivery?.state?.outcome?.decision ?? null, activeMembers: activeMembers.length, workspaceShellFailure: effectiveShellFailureLegacy, hitHardTerminalBlocker, hasDispatchableNonShellWork: hasDispatchableNonShellLegacy, hasUnfinishedNonShellPlanWork: unfinishedNonShellLegacy }, userTaskText(ctx, actor.teamId, 3000));
      if (review.action === 'stop') return;
      if (agent.status === 'running' || currentTaskSeq(ctx, actor.teamId) !== taskSeq || (agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) return;
      reviewedContinue = review.directive;
    }
    if (!isPluginActive(rt, 'consensus') && rt.config.team.requirePlanAgreement === false && declaration?.state === 'delivered') return;
    if (store.workflowEvents().some(e=>e.type==='environment-escalation' && e.taskSeq===taskSeq)) return;
    const declaredInvalidDelivery = declaration?.state === 'delivered' && approvedDeliveryIds.length === 0;
    if (rolling && declaration?.state === 'waiting_reviews' && !hasAdmissibleFrontierWork(rt,store,rt.config,taskSeq)) {
      const view=frontierView(store,taskSeq);
      if (view.pending_execution_reviews.some(r=>view.stages.some(s=>s.stage_id===r.stage_id&&s.hash===r.stage_hash))) return;
    }
    const declaredMissingMembers = (declaration?.state === 'waiting_members' && !activeMembers.length) || (rolling && declaration?.state === 'waiting_reviews' && planningWork);
    const claimMatch = /^\s*DELIVERY:\s*approved(?:\s*\(\s*([^)\s]+)\s*\))?/im.exec(finalText);
    const citedId = claimMatch?.[1] ?? null;
    const invalidDeliveryClaim = declaredInvalidDelivery || (claimMatch !== null && (approvedDeliveryIds.length === 0 || (citedId !== null && !approvedDeliveryIds.includes(citedId))));
    const isNotApprovedText = /^\s*DELIVERY:\s*not\s+approved\b/im.test(finalText);
    const noHardBlocker = !/允许读取|allow read/i.test(finalText)
      && !(actor.cwd && rt.workspaceShellFailures?.has(pathKey(actor.cwd)))
      && !hitHardTerminalBlocker;
    const hasReviseDelivery = latestDelivery?.state?.outcome?.decision === 'revise' && consecutiveUnapprovedDeliveries < 4;
    const prematureNotApproved = !invalidDeliveryClaim
      && isNotApprovedText
      && approvedDeliveryIds.length === 0
      && noHardBlocker
      && (activePlanId !== null || hasReviseDelivery)
      && latestDelivery?.state?.outcome?.decision !== 'reject'
      && consecutiveUnapprovedDeliveries < 4;

    const prematureStop = !invalidDeliveryClaim
      && !isNotApprovedText
      && approvedDeliveryIds.length === 0
      && (reviewedContinue || declaredMissingMembers || (noHardBlocker
      && ((activePlanId !== null && (readCurrentPlan(rt.storageRoot,actor.teamId,taskSeq) || sessionHasWorkflowTracking(evs, actor.cwd, rt.config.paths?.projectRefsDir))) || (rolling && frontierState(store, taskSeq).revision > 0) || hasReviseDelivery)));

    // Single-turn output-token truncation (`max-tokens`) is NOT a failure: preserve all state and auto-continue.
    // Normal truncations with tool progress never trip any cap; persistent zero-progress truncations route through the Circuit Breaker Investigator.
    const truncatedStop = endReason === 'max-tokens' && approvedDeliveryIds.length === 0
      && noHardBlocker && latestDelivery?.state?.outcome?.decision !== 'reject';
    if (!invalidDeliveryClaim && !prematureNotApproved && !prematureStop && !truncatedStop && !reviewedContinue && !declaredMissingMembers) return;

    const cbState = ensureCircuitState(rt, actor.agentId, 'leader');
    const sessionTurnTools = extractSessionTurnCompletedTools(evs, lastTurnEndIdx);
    let leaderTurnCompletedTools = sessionTurnTools;

    if (truncatedStop) {
      if (cbState.turnCompletedTools.length === 0 && sessionTurnTools.length > 0) {
        cbState.turnCompletedTools.push(...sessionTurnTools);
      }
      const cbDecision = recordTurnEndInCircuit(cbState, { reasonKind: 'max-tokens' }, rt.config.circuitBreaker);
      leaderTurnCompletedTools = [...new Set([...cbDecision.completedInTurn, ...sessionTurnTools])];
      if (cbDecision.trigger === 'hard' && cbDecision.exhaustedConsolidations) {
        return;
      }
      if (cbDecision.trigger === 'soft' || cbDecision.trigger === 'hard') {
        void runCircuitInvestigation({
          ctx,
          rt,
          store,
          actor,
          agent,
          circuitState: cbState,
          decision: cbDecision,
          taskSeq,
        });
        if (cbDecision.trigger === 'hard') {
          // Hard tier handles consolidation and followup directly in runCircuitInvestigation.
          return;
        }
      }
      store.appendWorkflowEvent({
        type: 'output-truncation-continued',
        role: 'leader',
        taskSeq,
        agentId: actor.agentId,
        completedInTurn: leaderTurnCompletedTools,
        totalTruncations: cbDecision.totalTruncations,
        zeroProgressStreak: cbDecision.zeroProgressTruncations,
      });
    } else {
      const settledMembers = [...store.members().values()].filter(m => !ACTIVE_MEMBER_STATES.has(m.status)).length;
      const settledAgreements = [...states.values()].filter(x => x.status === 'settled').length;
      const fingerprint = `${store.members().size}:${settledMembers}:${settledAgreements}:${rolling ? frontierState(store, taskSeq).revision : 0}`;
      rt.autoContinueState ??= new Map();
      const stateKey = `${actor.teamId}:${taskSeq}`;
      const prev = rt.autoContinueState.get(stateKey);
      const streak = prev && prev.fingerprint === fingerprint ? prev.streak + 1 : 1;
      rt.autoContinueState.set(stateKey, { fingerprint, streak });
      if (streak > 3) return;
    }
    const streak = rt.autoContinueState?.get(`${actor.teamId}:${taskSeq}`)?.streak ?? 1;

    let deliveryHint = 'no kind="delivery" agreement has been run yet';
    if (latestDelivery?.state) {
      const isTerm = latestDelivery.state.status === 'settled' || nextAction(latestDelivery.state).kind === 'stalled';
      if (!isTerm) deliveryHint = `open kind="delivery" agreement "${latestDelivery.id}" must be resumed via team_discuss(resume_id="${latestDelivery.id}")`;
      else if (latestDelivery.state.outcome?.decision === 'revise') deliveryHint = `kind="delivery" agreement "${latestDelivery.id}" returned "revise" (required_changes=${JSON.stringify(latestDelivery.state.outcome.requiredChanges)}); fix via members under plan_id="${activePlanId ?? ''}", re-verify, and call team_discuss(kind="delivery", revises="${latestDelivery.id}")`;
    }

    const planGuidance = rolling
      ? 'record the next bounded team_plan stage (goal, method and acceptance); submit ready stages for asynchronous team_discuss(kind="plan", stage_id), and dispatch only the matching approved stage/version. Continue planning later work while current stages are pending review or running'
      : activePlanId !== null
      ? `dispatch the required verification/rework member(s) with a fresh unique name and plan_id="${activePlanId}"`
      : `because active_approved_plan_id is currently null for task_seq=${taskSeq}, first update the full external current plan via team_note(scope="current_plan", path="plan.md") and call team_discuss(kind="plan") to obtain an approved plan_id for task_seq=${taskSeq}, then dispatch the required verification/rework member(s) under that plan_id`;

    const leaderCompletedSummary = leaderTurnCompletedTools.length > 0
      ? leaderTurnCompletedTools.join(', ')
      : '(none completed in the truncated turn — issue the next concrete tool call directly without repeating long prose)';

    const continuationText = reviewedContinue
      ? `[LeaderTeam stop review] This checkpoint should continue within the current authorization: ${reviewedContinue}`
      : truncatedStop
      ? `[LeaderTeam output recovery] The last model response hit its single-turn output-token limit before this task was delivered. Context, approvals, and workspace state are preserved.\nAlready succeeded in the truncated turn (DO NOT repeat these calls): ${leaderCompletedSummary}.\nResume directly from the interruption point with the next required tool call; do not re-execute completed calls or repeat already-approved stage reviews. Finish with actual delivery review, or declare a concrete stop state via team_status if genuinely blocked.`
      : !declaration && streak === 1 && !invalidDeliveryClaim
      ? '[LeaderTeam workflow state] Before stopping, call team_status with stop_state delivered, waiting_members, waiting_user (with the actual question), or blocked (with the concrete reason). Continue routine implementation and verification autonomously; the host will check the stated stop reason.'
      : invalidDeliveryClaim
      ? `[LeaderTeam workflow check] Your previous turn emitted "DELIVERY: approved${citedId ? ` (${citedId})` : ''}", which is invalid: ${citedId && activePlanIds.includes(citedId) ? `"${citedId}" is a kind="plan" agreement, NOT a kind="delivery" agreement` : `no approved kind="delivery" agreement exists for task_seq=${taskSeq} (approved_delivery_ids=${JSON.stringify(approvedDeliveryIds)})`}. Active approved plan_id="${activePlanId ?? 'none'}"; ${deliveryHint}. First ${planGuidance} (for profile="shell", include "read", "glob", "grep", "pwsh" and "read_image" in tools, plus "edit"/"write" if modifying files), then call team_discuss with kind="delivery" (attaching changed files and real verification output) and only emit "DELIVERY: approved (<delivery_agreement_id>)" in the user's language once kind="delivery" settles as "approve".`
      : prematureNotApproved
      ? `[LeaderTeam workflow check] Your previous turn emitted "DELIVERY: not approved" prematurely after a non-terminal review (${deliveryHint}). An outcome of "revise" requires resolving every item in required_changes through team members and re-submitting with revises, NOT stopping. Immediately ${planGuidance} (for profile="shell", include "read", "glob", "grep", "pwsh" and "read_image" in tools, plus "edit"/"write" if modifying files, and a workspace-relative write_scope), run real execution/browser verification and any needed fixes, and call team_discuss(kind="delivery"${latestDelivery?.id ? `, revises="${latestDelivery.id}"` : ''}) before answering in the user's language.`
      : `[LeaderTeam workflow continuation] Your turn ended while multi-step workflow work remains incomplete for task_seq=${taskSeq} (active_approved_plan_id="${activePlanId ?? 'none'}", running_members=${activeMembers.length}, ${deliveryHint}). Do not stop between waves: immediately ${planGuidance}, or once all acceptance criteria and real execution checks pass, call team_discuss with kind="delivery" and deliver in the user's language.`;

    agent.followup(buildContinuationMessage(rt, continuationText));
  } catch (err) {
    rt.logger?.warn?.(`leaderteam: auto-continuation check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
export function onAgentError(_ctx, { agent, error } = {}) {
  const rt = runtime();
  if (!rt.config || !agent) return;
  const actor = rt.actors.get(agent.id);
  const rawMsg = error instanceof Error ? error.message : String(error ?? '');
  if (actor) {
    rt.scheduler?.recordLlmOutcome?.({ ok: false, code: error?.code, message: rawMsg, retryable: true });
  }
  if (actor?.role !== 'member' && actor?.role !== 'direct_exec') return;
  rt.memberErrors ??= new Map();
  rt.memberErrors.set(agent.id, { seq: agent.session?.seq ?? 0, message: truncate(rawMsg, 600) });
}
export function onSessionEvent(ctx, session, event) {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !session || !event) return;
  if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
    const leader = [...rt.actors.values()].find(a => a.role === 'leader' && (a.agent?.session === session || a.teamId === session.id));
    if (leader) rt.onLeaderUserMessage?.(ctx, leader.teamId);
    return;
  }
  if (event.type !== 'turn/end') return;
  const leaderActor = [...rt.actors.values()].find(a => a.role === 'leader' && (a.agent?.session === session || a.teamId === session.id));
  if (leaderActor) {
    rt.onLeaderTurnEnd?.(ctx, leaderActor.teamId);
    return;
  }
  const actor = [...rt.actors.values()].find(a => (a.role === 'member' || a.role === 'direct_exec') && a.agent?.session === session)
    ?? (session.header?.origin === 'subagent' && typeof session.header?.parentSession === 'string' && typeof session.id === 'string' && TeamStore.exists(rt.storageRoot, session.header.parentSession)
      ? { role: teamStore(session.header.parentSession).getMember(session.id)?.actorRole === 'direct_exec' ? 'direct_exec' : 'member', teamId: session.header.parentSession, agentId: session.id }
      : null);
  if (!actor) return;
  const pendingErr = rt.memberErrors?.get(actor.agentId);
  if (pendingErr && typeof event.seq === 'number' && event.seq >= pendingErr.seq) {
    rt.memberErrors.delete(actor.agentId);
  }
  const store = teamStore(actor.teamId);
  const rec = store.getMember(actor.agentId);
  if (!rec) return;
  const isOrdinaryMember = rec.actorRole !== 'direct_exec';
  const reason = event.data?.reason;
  const kind = reason?.kind;
  const teamRt = runtimeForTeam(actor.teamId);
  try {
    if (baseRuntime(rt).circuitConsolidating?.has(actor.agentId) && (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled')) {
      // Turn was paused by hard circuit-breaker consolidation immediately prior to consolidated followup; keep member active.
      baseRuntime(rt).circuitConsolidating.delete(actor.agentId);
      return;
    }
    if (kind === 'aborted' || kind === 'interrupted' || kind === 'cancelled') {
      store.setMemberStatus(actor.agentId, 'cancelled', reason?.message ? truncate(String(reason.message), 600) : undefined);
      if (isOrdinaryMember) {
        rt.scheduler?.recordMemberFinished?.(actor.teamId, rec.taskSeq ?? 1);
        rt.onMemberTerminalStatus?.(actor.teamId, rec.taskSeq ?? 1, actor.agentId);
      }
      return;
    }
    if (kind === 'blocked') {
      store.setMemberStatus(actor.agentId, 'blocked', reason?.message ? truncate(String(reason.message), 600) : undefined);
      if (isOrdinaryMember) {
        rt.scheduler?.recordMemberFinished?.(actor.teamId, rec.taskSeq ?? 1);
        rt.onMemberTerminalStatus?.(actor.teamId, rec.taskSeq ?? 1, actor.agentId);
      }
      return;
    }
    const settleGovernanceCheckpointPause = (rawText, extraTools = []) => {
      const evsSnap = typeof session.snapshotEvents === 'function' ? (session.snapshotEvents() ?? []) : [];
      const turnTools = extractSessionTurnCompletedTools(evsSnap, evsSnap.length);
      const mergedTools = [...new Set([...extraTools, ...turnTools])];
      const checkpoint = parseCheckpointFromMemberOutput(rawText, mergedTools);
      const govNow = replayGovernanceState(store.governanceEvents(), rec.taskSeq ?? 1);
      const pauseConfId = rec.pausedByConferenceId
        ?? govNow.pausingConference?.conferenceId
        ?? govNow.activeConference?.conferenceId
        ?? govNow.activeHumanEscalation?.escalationId
        ?? null;

      const hasLiveHold = Boolean(govNow.pausingConference || govNow.activeConference || govNow.activeHumanEscalation);
      const concludedConf = pauseConfId ? govNow.conferences.find(c => c.conferenceId === pauseConfId && c.status === 'concluded') : null;
      const heldByConcludedRuling = Boolean(
        isOrdinaryMember
        && concludedConf
        && concludedConf.ruling?.decision === 'enforce_correction'
        && (concludedConf.ruling?.memberResumePolicy === 'adjust_disputed_resume_others' || (concludedConf.ruling?.blockedTargets?.length ?? 0) > 0)
        && (
          (rec.stageId && ((concludedConf.ruling?.blockedTargets ?? []).includes(rec.stageId) || concludedConf.stageId === rec.stageId)) ||
          (Array.isArray(rec.writeScope) && rec.writeScope.some(g => (concludedConf.targets ?? []).includes(g)))
        ),
      );
      const isStaleConferencePause = !hasLiveHold && !heldByConcludedRuling && (!pauseConfId || govNow.concludedConferenceIds.includes(pauseConfId));

      try { store.saveMemberCheckpoint(actor.agentId, pauseConfId, checkpoint); } catch {}

      if (isStaleConferencePause && isOrdinaryMember) {
        // `conferenceId` generation guard (§三): expired pause request must NEVER leave the member stranded in `paused`!
        store.setMemberGovernanceState(actor.agentId, null, { conferenceId: null });
        store.appendGovernanceEvent({
          type: 'stale-conference-pause-recovered',
          taskSeq: rec.taskSeq ?? 1,
          childId: actor.agentId,
          member: rec.name,
          staleConferenceId: pauseConfId,
          checkpointSummary: checkpoint.summary,
        });
        const liveAgent = actor.agent ?? rt.hostAgents?.get?.(actor.agentId) ?? null;
        if (typeof liveAgent?.followup === 'function') {
          const resumeText = buildCheckpointResumePrompt({
            conferenceId: pauseConfId ?? 'expired',
            decision: concludedConf?.ruling?.decision ?? 'overturn_objection',
            rulingSummary: concludedConf?.ruling?.rulingSummary ?? 'Conference already concluded before this pause turn finished; auto-resuming immediately.',
            bindingDirectives: concludedConf?.ruling?.bindingDirectives ?? [],
            checkpoint,
          });
          const resumeMsg = buildContinuationMessage(teamRt, resumeText);
          try {
            liveAgent.followup(resumeMsg);
          } catch {
            const base = baseRuntime(rt);
            base.pendingMemberContinuations ??= new Map();
            base.pendingMemberContinuations.set(actor.agentId, { agent: liveAgent, message: resumeMsg });
          }
          if (rec.status !== 'running') {
            try { store.setMemberStatus(actor.agentId, 'running'); } catch {}
          }
          return true;
        }
      }

      store.setMemberStatus(actor.agentId, 'paused', 'paused at immediate handoff checkpoint for formal governance conference');
      store.setMemberGovernanceState(actor.agentId, 'paused_for_conference', {
        conferenceId: pauseConfId,
        checkpoint,
        resumePoint: checkpoint.summary,
      });
      if (isOrdinaryMember) {
        rt.scheduler?.recordMemberFinished?.(actor.teamId, rec.taskSeq ?? 1);
      }
      return true;
    };

    if (kind === 'max-tokens') {
      const liveAgent = actor.agent ?? rt.hostAgents?.get?.(actor.agentId) ?? null;
      const cbState = ensureCircuitState(teamRt, actor.agentId, actor.role);
      const evs = typeof session.snapshotEvents === 'function' ? (session.snapshotEvents() ?? []) : [];
      const sessionTurnTools = extractSessionTurnCompletedTools(evs, evs.length);
      if (cbState.turnCompletedTools.length === 0 && sessionTurnTools.length > 0) {
        cbState.turnCompletedTools.push(...sessionTurnTools);
      }
      const cbDecision = recordTurnEndInCircuit(cbState, { reasonKind: 'max-tokens' }, teamRt.config?.circuitBreaker);
      const completedInTurn = [...new Set([...cbDecision.completedInTurn, ...sessionTurnTools])];

      if (rec.governanceState === 'pausing_for_conference') {
        settleGovernanceCheckpointPause('STOPPED_AT: single-turn output limit reached during immediate conference checkpoint', completedInTurn);
        return;
      }

      if (typeof liveAgent?.followup === 'function' && !(cbDecision.trigger === 'hard' && cbDecision.exhaustedConsolidations)) {
        const promptText = buildMemberTruncationContinuationPrompt(rec, completedInTurn, cbState.activationCompletedTools);
        const contMsg = buildContinuationMessage(teamRt, promptText);
        // If Session.append("turn/end") is currently publishing, defer followup to setPhase("idle") (`onAgentStatus`)
        // which runs immediately after `turn()` exits and BEFORE `whenIdle()` resolves in `watchLocalSettlement`.
        try {
          liveAgent.followup(contMsg);
        } catch (appendErr) {
          const base = baseRuntime(rt);
          base.pendingMemberContinuations ??= new Map();
          base.pendingMemberContinuations.set(actor.agentId, { agent: liveAgent, message: contMsg });
        }
        if (rec.status !== 'running') {
          try { store.setMemberStatus(actor.agentId, 'running'); } catch {}
        }
        store.appendWorkflowEvent({
          type: 'output-truncation-continued',
          role: actor.role,
          taskSeq: rec.taskSeq ?? 1,
          agentId: actor.agentId,
          member: rec.name,
          stageId: rec.stageId ?? null,
          completedInTurn,
          totalTruncations: cbDecision.totalTruncations,
          zeroProgressStreak: cbDecision.zeroProgressTruncations,
        });
        if (cbDecision.trigger === 'soft' || cbDecision.trigger === 'hard') {
          const fullActor = rt.actors.get(actor.agentId) ?? { ...actor, name: rec.name, profile: rec.profile, model: rec.model, effort: rec.effort, stageId: rec.stageId, writeScope: rec.writeScope, allowedTools: rec.allowedTools, loadedTools: rec.loadedTools, task: rec.task, acceptance: rec.acceptance };
          void runCircuitInvestigation({
            ctx,
            rt: teamRt,
            store,
            actor: fullActor,
            agent: liveAgent,
            circuitState: cbState,
            decision: cbDecision,
            taskSeq: rec.taskSeq ?? 1,
          });
        }
        return;
      }

      // Only reached if the agent has no followup capability (detached test stub) or exhausted all hard consolidations:
      const progress = rt.memberExecutionProgress?.get(actor.agentId);
      const failure = { kind: 'output-limit', completedOperations: progress?.size ?? completedInTurn.length, noExecutionProgress: (progress?.size ?? completedInTurn.length) === 0 };
      const detail = `max-tokens: response output-token limit reached after ${cbDecision.totalTruncations} truncation(s) without resident followup capability.`;
      store.setMemberStatus(actor.agentId, cbDecision.exhaustedConsolidations ? 'blocked' : 'failed', truncate(detail, 600), failure);
      if (isOrdinaryMember) {
        rt.scheduler?.recordMemberFinished?.(actor.teamId, rec.taskSeq ?? 1);
        rt.onMemberTerminalStatus?.(actor.teamId, rec.taskSeq ?? 1, actor.agentId);
      }
      return;
    }
    if (kind === 'error') {
      const detail = reason?.failure?.message ?? reason?.error?.message ?? reason?.message ?? kind;
      const errCode = String(reason?.failure?.code ?? kind);
      const cbState = ensureCircuitState(teamRt, actor.agentId, actor.role);
      const cbDecision = recordTurnEndInCircuit(cbState, { reasonKind: 'error', errorMessage: String(detail), errorCode: errCode }, teamRt.config?.circuitBreaker);
      rt.scheduler?.recordLlmOutcome?.({ ok: false, code: errCode, message: String(detail), retryable: false });
      store.setMemberStatus(actor.agentId, 'failed', truncate(String(detail), 600), null);
      if (isOrdinaryMember) {
        rt.scheduler?.recordMemberFinished?.(actor.teamId, rec.taskSeq ?? 1);
        rt.onMemberTerminalStatus?.(actor.teamId, rec.taskSeq ?? 1, actor.agentId);
      }
      if (cbDecision.trigger === 'soft' || cbDecision.trigger === 'hard') {
        const liveAgent = actor.agent ?? rt.hostAgents?.get?.(actor.agentId) ?? null;
        const fullActor = rt.actors.get(actor.agentId) ?? { ...actor, name: rec.name, profile: rec.profile, model: rec.model, effort: rec.effort, stageId: rec.stageId, writeScope: rec.writeScope, allowedTools: rec.allowedTools, loadedTools: rec.loadedTools, task: rec.task, acceptance: rec.acceptance };
        void runCircuitInvestigation({
          ctx,
          rt: teamRt,
          store,
          actor: fullActor,
          agent: liveAgent,
          circuitState: cbState,
          decision: cbDecision,
          taskSeq: rec.taskSeq ?? 1,
        });
      }
      return;
    }
    const cbState = ensureCircuitState(teamRt, actor.agentId, actor.role);
    recordTurnEndInCircuit(cbState, { reasonKind: 'completed' }, teamRt.config?.circuitBreaker);
    let finalText = '';
    if (typeof session.snapshotEvents === 'function') {
      const evs = session.snapshotEvents();
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i]?.type === 'turn/start') break;
        if (evs[i]?.type === 'assistant/message') {
          finalText = eventContentBlocks(evs[i]).filter(b => b?.type === 'text').map(b => b.text).join('\n');
          break;
        }
      }
    }
    if (rec.governanceState === 'pausing_for_conference' || /^\s*STATUS:\s*paused\b/im.test(finalText)) {
      settleGovernanceCheckpointPause(finalText, cbState.activationCompletedTools);
      return;
    }
    const isBlocked = /^\s*STATUS:\s*blocked\b/im.test(finalText) || Boolean(actor.shellFailure ?? rec.shellFailure);
    store.setMemberStatus(actor.agentId, isBlocked ? 'blocked' : 'done');
    if (isOrdinaryMember) {
      rt.scheduler?.recordMemberFinished?.(actor.teamId, rec.taskSeq ?? 1);
      rt.onMemberTerminalStatus?.(actor.teamId, rec.taskSeq ?? 1, actor.agentId);
    }
  } catch {}
}
/** Successful `read` calls mark files as read for read-before-write. */
export function onToolResult(exec, result) {
  let rt = runtime();
  const caller = exec?.agent && rt.actors.get(exec.agent.id);
  rt = runtimeForTeam(caller?.teamId);
  if (caller?.role === 'leader' && exec?.name === 'send_message' && !result?.isError) {
    const targetId = exec.arguments?.agent_id;
    if (typeof targetId === 'string' && caller.teamId && rt.storageRoot) {
      try {
        const store = teamStore(caller.teamId);
        const rec = store.getMember(targetId);
        const liveChild = rt.hostAgents?.get?.(targetId);
        const childQueuedOrRunning = liveChild
          ? (liveChild.status !== 'idle' || (liveChild.inbox?.nextTurn?.length ?? 0) > 0 || (liveChild.inbox?.nextStep?.length ?? 0) > 0)
          : false;
        if (rec && childQueuedOrRunning) {
          if (rt.liveProcessMemberIds instanceof Set) rt.liveProcessMemberIds.add(targetId);
          if (rec.status !== 'running') store.setMemberStatus(targetId, 'running');
        }
      } catch {}
    }
    return;
  }
  const errorText = (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (caller && caller.teamId && rt.storageRoot && exec?.name) {
    try {
      const store = teamStore(caller.teamId);
      const cbState = ensureCircuitState(rt, exec.agent.id, caller.role);
      const ok = !result?.isError && !result?.error;
      const gateRuleMatch = /\((rule:[^)]+|model|gate-error)\)/.exec(errorText);
      if (gateRuleMatch?.[1] === 'rule:conference-checkpoint-pause') {
        return;
      }
      const hasActiveMembers = caller.role === 'leader'
        ? [...store.members().values()].some(m => ACTIVE_MEMBER_STATES.has(m.status))
        : false;
      const cbDecision = recordToolOutcomeInCircuit(cbState, {
        tool: exec.name,
        targetSummary: summarizeToolTarget(exec.name, exec.arguments),
        ok,
        errorSignature: ok ? '' : truncate(errorText.replace(/\s+/g, ' ').trim(), 120),
        rule: gateRuleMatch?.[1] ?? '',
        hasActiveMembers,
      }, rt.config?.circuitBreaker);
      if (cbDecision.trigger === 'soft' || cbDecision.trigger === 'hard') {
        const hostCtx = baseRuntime(rt).gate?.ctx ?? null;
        const tSeq = caller.role === 'member' ? (caller.taskSeq ?? 1) : (hostCtx ? currentTaskSeq(hostCtx, caller.teamId) : 1);
        void runCircuitInvestigation({
          ctx: hostCtx,
          rt,
          store,
          actor: caller,
          agent: exec.agent,
          circuitState: cbState,
          decision: cbDecision,
          taskSeq: tSeq,
        });
      }
    } catch {}
  }
  if ((caller?.role === 'member' || caller?.role === 'direct_exec') && result?.isError && rt.config?.gate?.shellTools?.includes(exec.name) && /SetNamedSecurityInfoW failed.*grantWrite\(/s.test(errorText)) {
    caller.shellFailure = errorText.slice(0, 1200);
    caller.loadedTools = (caller.loadedTools ?? caller.allowedTools).filter(n => !rt.config.gate.shellTools.includes(n));
    rt.workspaceShellFailures ??= new Map();
    rt.workspaceShellFailures.set(pathKey(caller.cwd), caller.shellFailure);
    teamStore(caller.teamId).setMemberTools(caller.agentId, caller.loadedTools, caller.shellFailure);
    appendShellFailureInstruction(exec.agent, caller.shellFailure);
    return;
  }
  if ((caller?.role === 'member' || caller?.role === 'direct_exec') && !result?.isError && !result?.error && (['write', 'edit'].includes(exec.name) || rt.config?.gate?.shellTools?.includes(exec.name))) {
    rt.memberExecutionProgress ??= new Map();
    const progress = rt.memberExecutionProgress.get(exec.agent.id) ?? new Set();
    progress.add(exec.callId ?? exec.name);
    rt.memberExecutionProgress.set(exec.agent.id, progress);
  }
  if ((exec?.name !== 'read' && exec?.name !== 'read_image') || result?.isError) return;
  const actor = exec.agent ? rt.actors.get(exec.agent.id) : undefined;
  if (!actor || (actor.role !== 'member' && actor.role !== 'direct_exec')) return;
  if (exec.name === 'read_image') {
    const requested = resolvePath(exec.arguments?.file_path ?? exec.arguments?.path, actor.cwd, process.platform);
    if (requested === null) return;
    let set = rt.reads.get(exec.agent.id);
    if (!set) { set = new Set(); rt.reads.set(exec.agent.id, set); }
    set.add(pathKey(requested, process.platform));
    return;
  }
  const meta = readWindowMeta(result.meta);
  if (!meta) return;
  const p = resolvePath(meta.path, actor.cwd, process.platform);
  const requested = resolvePath(exec.arguments?.file_path, actor.cwd, process.platform);
  if (p === null || requested === null || pathKey(p, process.platform) !== pathKey(requested, process.platform)) return;
  const key = pathKey(p, process.platform);
  const intervals = mergeIntervals(rt.readProgress?.get(exec.agent.id)?.get(key) ?? [], meta.lines.map(({ number }) => [number, number]));
  if (!isFileCovered(intervals, meta.totalLines)) {
    rt.readProgress ??= new Map();
    const byPath = rt.readProgress.get(exec.agent.id) ?? new Map();
    byPath.set(key, intervals);
    rt.readProgress.set(exec.agent.id, byPath);
    return;
  }
  let set = rt.reads.get(exec.agent.id);
  if (!set) { set = new Set(); rt.reads.set(exec.agent.id, set); }
  set.add(key);
  rt.readProgress?.get(exec.agent.id)?.delete(key);
}
function appendShellFailureInstruction(agent, reason) {
  agent.ctx.systemPrompt.section({ name: 'leaderteam:shell-unavailable', order: 9010, interpolate: false, text: `The OS sandbox failed before a command started: ${reason}\nShell tools are now unavailable for this member. Stop command retries and report STATUS: blocked to the leader. Do not change permissions or bypass the sandbox. A repaired workspace requires a new member.` });
}
/** The user's instructions to the team leader: first and last two user messages, bounded. */
/** Every message the user typed in the leader session, oldest first. Agent notifications and tool output are excluded. */
/** User-authored messages of the leader session, in order: [{text, time}] (time = host event time in ms, NaN if absent). */
function userMessages(ctx, teamId) {
  if (!teamId) return [];
  const leader = runtime().actors.get(teamId)?.agent ?? ctx?.get?.('agents')?.get?.(teamId);
  const session = leader?.session;
  if (!session) return [];
  if (typeof session.snapshotEvents !== 'function') {
    if ('seq' in session || 'surface' in session) {
      throw new Error('leaderteam: host session lacks snapshotEvents(); refusing to run without user-message provenance');
    }
    return [];
  }
  const messages = [];
  for (const ev of session.snapshotEvents()) {
    if (ev.type !== 'user/message' || ev.data?.source?.kind !== 'user') continue;
    const t = (ev.data.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
    if (t) messages.push({ text: t, time: typeof ev.time === 'number' ? ev.time : NaN });
  }
  return messages;
}
export function userMessageTexts(ctx, teamId) {
  return userMessages(ctx, teamId).map(m => m.text);
}
/** Approved delivery agreements per task: Map(taskSeq -> [settle time ms]); null when the store cannot be read. */
function approvedDeliveryTimes(teamId) {
  let records;
  try { records = teamStore(teamId).agreementRecords(); } catch { return null; }
  const byId = new Map();
  for (const r of records) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
  const out = new Map();
  for (const recs of byId.values()) {
    let state;
    try { state = replay(recs.map(({ v, at, ...ev }) => ev)); } catch { continue; }
    if (state.kind !== 'delivery' || state.outcome?.decision !== 'approve') continue;
    const times = recs.map(r => Date.parse(r.at)).filter(Number.isFinite);
    if (times.length === 0) continue;
    const k = state.taskSeq ?? 1;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(Math.max(...times));
  }
  return out;
}
/** Number of the user task in hand. Every user message starts a new task, except messages that carry no new work:
 *  - a message made only of read-grant lines never starts one;
 *  - a bare "continue" resumes the task in hand while that task has no approved delivery. Once a delivery was approved
 *    before the message, "continue" means new work and starts a task like any other message. When the message time or
 *    the agreement log is unavailable, the conservative reading (new task) applies. */
export function currentTaskSeq(ctx, teamId) {
  const msgs = userMessages(ctx, teamId);
  let seq = 1, delivered;
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (isReadGrantOnlyMessage(m.text) || (!isBareContinueMessage(m.text) && isControlOnlyUserMessage(m.text))) continue;
    if (isBareContinueMessage(m.text) && Number.isFinite(m.time)) {
      if (delivered === undefined) delivered = approvedDeliveryTimes(teamId);
      if (delivered !== null && !(delivered.get(seq) ?? []).some(t => t <= m.time)) continue;
    }
    seq++;
  }
  return seq;
}
export function userTaskText(ctx, teamId, maxChars) {
  const all = userMessageTexts(ctx, teamId);
  const texts = all.filter((t, idx) => idx === 0 || !isControlOnlyUserMessage(t));
  if (texts.length === 0) return '';
  if (!Number.isInteger(maxChars) || maxChars <= 0) return '';
  const cap = (s, n) => (s.length <= n ? s : truncate(s, Math.max(0, n - 1)));
  if (texts.length === 1) return cap(texts[0], maxChars);
  const picked = texts.length <= 3 ? texts : [texts[0], '…', ...texts.slice(-2)];
  const joined = picked.join('\n---\n');
  if (joined.length <= maxChars) return joined;
  const first = texts[0];
  const latest = texts.at(-1);
  const baseSep = texts.length === 2 ? '\n---\n' : '\n---\n…\n---\n';
  if (maxChars <= baseSep.length + 32) return cap(latest, maxChars);
  const avail = maxChars - baseSep.length;
  const minHead = Math.min(first.length, Math.max(16, Math.min(256, Math.floor(avail * 0.25))));
  const latestPart = cap(latest, Math.max(16, avail - minHead));
  const remAfterLatest = Math.max(16, avail - latestPart.length);
  if (texts.length >= 3 && first.length < remAfterLatest) {
    const prev = texts.at(-2);
    const midPrefix = texts.length === 3 ? '\n---\n' : '\n---\n…\n---\n';
    const prevAvail = maxChars - first.length - latestPart.length - midPrefix.length - 5;
    if (prevAvail >= 64) {
      return `${first}${midPrefix}${cap(prev, prevAvail)}\n---\n${latestPart}`;
    }
  }
  const headPart = cap(first, remAfterLatest);
  return `${headPart}${baseSep}${latestPart}`;
}

function readWindowMeta(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
  const { path, offset, lines, totalLines } = meta;
  if (typeof path !== 'string' || typeof offset !== 'number' || typeof totalLines !== 'number') return null;
  if (!Number.isInteger(offset) || offset < 1) return null;
  if (!Number.isInteger(totalLines) || totalLines < 0) return null;
  if (!Array.isArray(lines) || !lines.every(isLine)) return null;
  let previous = offset - 1;
  for (const { number } of lines) {
    if (number <= previous || number > totalLines) return null;
    previous = number;
  }
  return { path, offset, lines, totalLines };
}

function isLine(line) {
  if (typeof line !== 'object' || line === null || Array.isArray(line)) return false;
  const { number, text } = line;
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string';
}

function mergeIntervals(existing, added) {
  const sorted = [...existing, ...added].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function isFileCovered(intervals, totalLines) {
  let next = 1;
  for (const [start, end] of intervals) {
    if (start > next) return false;
    next = Math.max(next, end + 1);
  }
  return next > totalLines;
}
