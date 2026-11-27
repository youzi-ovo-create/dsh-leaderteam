// Final-dispatch safety gate: a version-guarded runtime patch of the DSH tool pipeline.
// The gate runs immediately before the tool body, after every pre-execute policy and every
// tools/execute wrapper, so it always reviews the exact name and arguments that execute.
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools';
import toolsPackage from '@deepseek-ai/dsh-tools/package.json' with { type: 'json' };
import os from 'node:os';
import { dispatchContract } from '../core/dispatch-contract.mjs';
import { createHash } from 'node:crypto';
import { frozenJsonCopy, hashJson } from '../core/canonical.mjs';
import {
  classifyTool,
  classifySandboxBoundary,
  evaluateDirectExecSafetyGate,
  evaluateCrossBoundarySafetyGate,
  computeGatePatternKey,
  evaluateHardRules,
  buildGateRequest,
  parseGateVerdict,
} from '../core/gate-policy.mjs';
import {
  isAutonomousGovernance,
  replayGovernanceState,
  checkGovernanceExecutionGate,
} from '../core/governance-protocol.mjs';
import { frontierState } from '../core/frontier.mjs';
import { boundJson, sanitizeArguments } from '../core/redact.mjs';
import { GATE_DENIED_CODE, GATE_DENIED_NAME } from '../core/constants.mjs';
import { pathKey, resolvePath } from '../core/paths.mjs';
import { isProtectedLeaderTeamConfigPath } from '../core/session-config.mjs';
import { readQuotaStateFile } from '../core/quota.mjs';
import { quotaGate } from '../core/models.mjs';
import { replay, nextAction } from '../core/agreement.mjs';
import { callRoleJson } from './llm.mjs';
import { roleRouteChain } from '../core/role-routes.mjs';
import { runtime, teamStore, recordUsage, syncRuntimeConfig, runtimeForTeam, isPluginActive, refreshUpstreamCatalog, effectiveRuntimeConfig } from './runtime.mjs';
import { resolveActor, isLeaderRoot, leaderAllowedTools, userTaskText, userMessageTexts, currentTaskSeq, reconcileStaleMembers } from './roles.mjs';
import { getSessionExecutionMode } from './mode-controller.mjs';
import { resumeAdmission, withMemberActivation, activationConfig, resolveSendMessageTargetId } from './activation.mjs';
import {
  VERIFIED_CORE_VERSIONS,
  SUPPORTED_DSH_ENGINE_RANGE,
  CANONICAL_PIPELINE_SNIPPETS,
  evaluateHostCompatibility,
} from '../core/host-compat.mjs';

const INSTALLED = Symbol.for('leaderteam.finalGate.installed.v1');
const ORIGINAL_DISPATCH = Symbol.for('leaderteam.finalGate.originalDispatch.v1');
const RECOVERABLE_PROTOCOL_NUDGES = new Set([
  'rule:tool-not-loaded',
  'rule:refs-unread',
  'rule:write-before-read',
  'rule:conference-checkpoint-pause',
]);

function countSubstantiveMemberDenials(memberReceipts) {
  const seenProtocolNudge = new Set();
  let count = 0;
  for (const r of memberReceipts) {
    if (r.decision !== 'deny') continue;
    if (RECOVERABLE_PROTOCOL_NUDGES.has(r.by)) {
      const key = `${r.by}\u0000${r.tool}\u0000${r.argsSha256 ?? ''}`;
      if (!seenProtocolNudge.has(key)) {
        seenProtocolNudge.add(key);
        continue;
      }
    }
    count++;
  }
  return count;
}

const REQUIRED_SOURCE = CANONICAL_PIPELINE_SNIPPETS;

/**
 * Throws when the host pipeline breaks safety-gate contract invariants or is disallowed by policy.
 * When `options` is omitted and `supported` is a plain array of versions, defaults to `'strict-verified'`
 * so explicit allowlist callers retain deterministic pin semantics; runtime startup passes `{ policy: 'adaptive' }`.
 */
export function assertCompatiblePipeline(proto, version, supported, options = null) {
  const isConfigObj = supported !== null && typeof supported === 'object' && !Array.isArray(supported);
  const cfg = isConfigObj ? supported : (options ?? {});
  const supportedVersions = isConfigObj
    ? (cfg.supportedVersions ?? VERIFIED_CORE_VERSIONS)
    : (Array.isArray(supported) ? supported : VERIFIED_CORE_VERSIONS);
  const policy = cfg.policy ?? (isConfigObj || options ? 'adaptive' : 'strict-verified');
  const supportedRange = cfg.supportedRange ?? SUPPORTED_DSH_ENGINE_RANGE;

  if (!proto || typeof proto.dispatchToolBody !== 'function' || typeof proto.resolveExecution !== 'function') {
    throw new Error('leaderteam: ToolExecutionPipeline lacks dispatchToolBody/resolveExecution; refusing to start');
  }
  const unpatchedFn = typeof proto[ORIGINAL_DISPATCH] === 'function' ? proto[ORIGINAL_DISPATCH] : proto.dispatchToolBody;
  const src = Function.prototype.toString.call(unpatchedFn);
  const evaluation = evaluateHostCompatibility({
    toolsVersion: version,
    pipelineSource: src,
    supportedVersions,
    supportedRange,
    policy,
  });

  if (evaluation.classification === 'INCOMPATIBLE_PIPELINE') {
    for (const s of REQUIRED_SOURCE) {
      if (!src.includes(s)) {
        throw new Error(`leaderteam: dispatchToolBody no longer contains "${s}"; refusing to start`);
      }
    }
    throw new Error(`leaderteam: ${evaluation.summary}`);
  }
  if (!evaluation.productionAllowed) {
    throw new Error(
      `leaderteam: @deepseek-ai/dsh-tools ${version} is not a verified core version (${supportedVersions.join(', ')}); refusing to start without the safety gate`,
    );
  }
  return evaluation;
}

export function installFinalGate(supportedVersionsOrOptions) {
  const proto = ToolExecutionPipeline.prototype;
  const opts = Array.isArray(supportedVersionsOrOptions)
    ? { supportedVersions: supportedVersionsOrOptions, supportedRange: SUPPORTED_DSH_ENGINE_RANGE, policy: 'adaptive' }
    : (supportedVersionsOrOptions ?? { supportedVersions: VERIFIED_CORE_VERSIONS, supportedRange: SUPPORTED_DSH_ENGINE_RANGE, policy: 'adaptive' });
  const evaluation = assertCompatiblePipeline(proto, toolsPackage.version, opts);
  const original = typeof proto[ORIGINAL_DISPATCH] === 'function' ? proto[ORIGINAL_DISPATCH] : proto.dispatchToolBody;
  if (!proto[ORIGINAL_DISPATCH]) {
    Object.defineProperty(proto, ORIGINAL_DISPATCH, { value: original });
  }
  runtime().hostCompatibility = Object.freeze({
    ...evaluation,
    checkedAt: new Date().toISOString(),
  });
  proto.dispatchToolBody = async function leaderteamFinalGate(exec) {
    const gate = runtime().gate;
    const agent = exec.agent;
    if (gate === null) return original.call(this, exec);
    const actor = gate.actorFor(agent);
    if (actor === null) return original.call(this, exec); // not governed (outside any LeaderTeam team)
    const reviewedMode = actor.executionMode;
    const name = exec.name, parent = exec.parent, toolSet = exec.toolSet;
    let args;
    try { args = frozenJsonCopy(exec.arguments ?? {}); } catch { return denied(name, { by: 'rule:arguments-not-json', reason: 'tool arguments are not plain JSON' }); }
    const definition = this.resolveExecution(name, agent, parent !== void 0, toolSet);
    if (definition === undefined) return original.call(this, exec); // UNKNOWN_TOOL, nothing to review
    let verdict;
    try { verdict = await gate.decide({ name, args, toolDescription: definition.description, agent, actor, callId: exec.callId, signal: exec.signal }); }
    catch (e) { verdict = { decision: 'deny', by: 'gate-error', reason: `safety gate failed: ${e instanceof Error ? e.message : String(e)}` }; }
    if (exec.signal?.aborted) return abortedBeforeDispatch();
    if (verdict.decision !== 'allow') return denied(name, verdict);
    const postActor = gate.actorFor(agent);
    if (runtime().gate !== gate || exec.agent !== agent || exec.parent !== parent || exec.toolSet !== toolSet || postActor !== actor || postActor.executionMode !== reviewedMode || (typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd !== actor.cwd)) {
      return denied(name, { by: 'binding', reason: 'the operation changed while it was under review' });
    }
    if (typeof gate.checkHardRules === 'function') {
      const postHit = gate.checkHardRules({ name, args, agent, actor });
      if (postHit) return denied(name, { by: `rule:${postHit.rule}`, reason: postHit.reason });
    }
    exec.name = name;          // bind: execute exactly what was reviewed
    exec.arguments = args;
    if (actor.role === 'leader' && name === 'send_message') {
      const rt = runtimeForTeam(actor.teamId), store = teamStore(actor.teamId);
      reconcileStaleMembers(rt, store);
      const tSeq = currentTaskSeq(gate.ctx, actor.teamId);
      const targetId = resolveSendMessageTargetId(store, args, tSeq);
      const targetMember = typeof targetId === 'string' ? store.getMember(targetId) : null;
      if (args.agent_id === undefined && typeof args.agent === 'string' && targetMember?.hostAgentName && args.agent !== targetMember.hostAgentName) {
        exec.arguments = frozenJsonCopy({ ...args, agent: targetMember.hostAgentName });
      }
      try { return await withMemberActivation(rt, store, rt.config, targetId, tSeq, () => original.call(this, exec)); }
      catch (error) { return denied(name, { by: 'rule:member-activation', reason: error.message }); }
    }
    if (actor.role === 'leader' && name === 'interrupt_agent' && args.agent_id === undefined && typeof args.agent === 'string') {
      const store = teamStore(actor.teamId);
      const tSeq = currentTaskSeq(gate.ctx, actor.teamId);
      const targetId = resolveSendMessageTargetId(store, args, tSeq);
      const targetMember = typeof targetId === 'string' ? store.getMember(targetId) : null;
      if (targetMember?.hostAgentName && args.agent !== targetMember.hostAgentName) {
        exec.arguments = frozenJsonCopy({ ...args, agent: targetMember.hostAgentName });
      }
    }
    const isShell = Boolean(runtimeForTeam(actor.teamId).config?.gate?.shellTools?.includes(name));
    const sessionKey = actor.teamId ?? agent?.id ?? null;
    const baseRtForFlight = runtime();
    if (sessionKey) {
      baseRtForFlight.inFlightToolDispatchesByTeam ??= new Map();
      baseRtForFlight.inFlightToolDispatchesByTeam.set(
        sessionKey,
        (baseRtForFlight.inFlightToolDispatchesByTeam.get(sessionKey) ?? 0) + 1,
      );
    }
    if (isShell) {
      const baseRt = runtime();
      baseRt.scheduler?.beginShellCall?.();
      if (sessionKey) {
        baseRt.inFlightShellCallsBySession ??= new Map();
        baseRt.inFlightShellCallsBySession.set(sessionKey, (baseRt.inFlightShellCallsBySession.get(sessionKey) ?? 0) + 1);
      }
    }
    try {
      return await original.call(this, exec);
    } finally {
      if (sessionKey && baseRtForFlight.inFlightToolDispatchesByTeam) {
        const nextToolCnt = (baseRtForFlight.inFlightToolDispatchesByTeam.get(sessionKey) ?? 1) - 1;
        if (nextToolCnt <= 0) baseRtForFlight.inFlightToolDispatchesByTeam.delete(sessionKey);
        else baseRtForFlight.inFlightToolDispatchesByTeam.set(sessionKey, nextToolCnt);
      }
      if (isShell) {
        const baseRt = runtime();
        baseRt.scheduler?.endShellCall?.();
        if (sessionKey && baseRt.inFlightShellCallsBySession) {
          const next = (baseRt.inFlightShellCallsBySession.get(sessionKey) ?? 1) - 1;
          if (next <= 0) baseRt.inFlightShellCallsBySession.delete(sessionKey);
          else baseRt.inFlightShellCallsBySession.set(sessionKey, next);
        }
      }
    }
  };
  if (!proto[INSTALLED]) {
    Object.defineProperty(proto, INSTALLED, { value: true });
  }
  return evaluation;
}

function denied(name, verdict) {
  const message = `blocked by the LeaderTeam safety gate (${verdict.by}): ${verdict.reason}`;
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true, error: { message, info: { name: GATE_DENIED_NAME, code: GATE_DENIED_CODE } } };
}
function abortedBeforeDispatch() {
  return { content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], isError: true, error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } } };
}

/** The live gate. */
export class Gate {
  constructor(ctx) { this.ctx = ctx; }
  checkHardRules({ name, args, agent, actor }) {
    syncRuntimeConfig();
    const rt = runtimeForTeam(actor.teamId);
    const cfg = rt.config;
    const unreadRefs = actor.role === 'member' ? (actor.refs ?? []).filter(r => !(rt.reads.get(agent.id)?.has(pathKey(r)))) : [];
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : actor.cwd;
    const baseRt = runtime();
    // Enforce Agent-vs-User separation at filesystem boundary: agents may NEVER mutate LeaderTeam global or session config files.
    if (cfg.gate?.mutatingTools?.includes(name)) {
      const argKeys = [...new Set([...(cfg.gate?.pathArgs?.[name] ?? []), 'file_path', 'path'])];
      for (const k of argKeys) {
        const rawTarget = args?.[k];
        if (typeof rawTarget === 'string' && rawTarget.trim()) {
          const resolved = resolvePath(rawTarget, cwd) ?? rawTarget;
          if (isProtectedLeaderTeamConfigPath(resolved, { storageRoot: baseRt.storageRoot, configPath: baseRt.configPath })) {
            return {
              rule: 'protected-lt-config',
              reason: 'Agent processes are forbidden from modifying LeaderTeam global or session configuration files; only user-initiated actions are permitted.',
            };
          }
        }
      }
    }
    if (cfg.gate?.shellTools?.includes(name) && typeof args?.command === 'string') {
      const cmdLower = args.command.toLowerCase();
      if (
        cmdLower.includes('leaderteam.config.json') ||
        cmdLower.includes('leaderteam.local.json') ||
        cmdLower.includes('session-config.json') ||
        (cmdLower.includes('governance.json') && cmdLower.includes('teams'))
      ) {
        if (/(?:>|tee\b|sed\s+-i|mv\b|cp\b|rm\b|python|node\s+-e|writefile)/i.test(args.command)) {
          return {
            rule: 'protected-lt-config',
            reason: 'Shell commands initiated by an agent may not modify LeaderTeam configuration or governance files.',
          };
        }
      }
    }
    const userTexts = (actor.role === 'leader' || name === 'web_search' || name === 'web_fetch') ? () => userMessageTexts(this.ctx, actor.teamId) : undefined; // read grants & user network-prohibition checks
    const rawSessionId = typeof agent?.session?.id === 'string' ? agent.session.id : (typeof agent?.session?.header?.id === 'string' ? agent.session.header.id : '');
    const ownSpillSessionSegment = rawSessionId ? `session-${createHash('sha256').update(rawSessionId).digest('hex').slice(0, 12)}` : undefined;
    const hit = evaluateHardRules({ tool: name, args, actor: { ...actor, unreadRefs }, cwd, platform: process.platform, userTexts, spillTmpRoot: os.tmpdir(), ownSpillSessionSegment }, cfg);
    if (hit) return hit;
    if (actor.role === 'leader' && name === 'send_message') {
      try {
        const store = teamStore(actor.teamId);
        reconcileStaleMembers(rt, store);
        const tSeq = currentTaskSeq(this.ctx, actor.teamId);
        const targetId = resolveSendMessageTargetId(store, args, tSeq);
        resumeAdmission(store, activationConfig(rt, store, cfg), targetId, tSeq);
      } catch (error) { return { rule: 'member-activation', reason: error.message }; }
    }
    return undefined;
  }
  actorFor(agent) {
    if (agent === undefined || agent === null) return null;
    const rt = runtime();
    syncRuntimeConfig(rt);
    const known = rt.actors.get(agent.id);
    if (known && known.agent === agent) {
      if (known.role === 'leader') {
        const mode = getSessionExecutionMode(rt, known.teamId);
        const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : known.cwd;
        const tools = leaderAllowedTools(runtimeForTeam(known.teamId), mode, process.platform, cwd);
        known.executionMode = mode;
        known.allowedTools = tools;
        known.loadedTools = tools;
      }
      return known;
    }
    const resolved = resolveActor(this.ctx, agent); // lazy: preset switched mid-session, or created before registration
    if (resolved) return resolved;
    return rt.config.gate.scope === 'all' ? { role: 'unknown', agentId: agent.id, teamId: null, allowedTools: [] } : null;
  }
  async decide({ name, args, toolDescription, agent, actor, callId, signal }) {
    syncRuntimeConfig();
    const rt = runtimeForTeam(actor.teamId);
    const cfg = rt.config;
    const initialExecutionMode = actor.role === 'leader'
      ? (actor.executionMode ?? getSessionExecutionMode(rt, actor.teamId))
      : undefined;
    try { rt.onTeamActivity?.(this.ctx, actor.teamId, actor.cwd); } catch {}
    const taskSeq = currentTaskSeq(this.ctx, actor.teamId);
    const argsPreview = boundJson(sanitizeArguments(args ?? {}), 400, 200).text;
    const base = {
      teamId: actor.teamId,
      taskSeq,
      agentId: agent.id,
      role: actor.role,
      ...(actor.role === 'leader' ? { executionMode: initialExecutionMode } : {}),
      member: actor.name ?? null,
      tool: name,
      callId,
      argsSha256: hashJson(args ?? {}),
      argsPreview,
    };
    let reviewArgs = args;
    let effectiveActor = actor;
    if (isAutonomousGovernance(cfg) && base.teamId && (actor.role === 'member' || actor.role === 'direct_exec')) {
      const store = teamStore(base.teamId);
      const rec = store.getMember(agent.id);
      if (rec?.governanceState === 'pausing_for_conference') {
        const govState = replayGovernanceState(store.governanceEvents(), rec.taskSeq ?? taskSeq);
        const pauseConfId = rec.pausedByConferenceId ?? null;
        const isStalePause = !govState.pausingConference
          && !govState.activeConference
          && !govState.activeHumanEscalation
          && (!pauseConfId || govState.concludedConferenceIds.includes(pauseConfId));
        if (isStalePause) {
          // `conferenceId` generation guard (§三): auto-clear expired pause request deterministically!
          try { store.setMemberGovernanceState(agent.id, null, { conferenceId: null }); } catch {}
        } else {
          effectiveActor = { ...actor, pausingForActiveConference: true, pausedByConferenceId: pauseConfId };
          const pauseHit = checkGovernanceExecutionGate(govState, effectiveActor, name, args, null, process.platform);
          if (pauseHit) return this.record(base, { decision: 'deny', by: `rule:${pauseHit.rule}`, reason: pauseHit.reason });
        }
      }
    }
    const hit = this.checkHardRules({ name, args, agent, actor: effectiveActor });
    if (hit) return this.record(base, { decision: 'deny', by: `rule:${hit.rule}`, reason: hit.reason });
    if (isAutonomousGovernance(cfg) && base.teamId && !(effectiveActor.role === 'leader' && effectiveActor.executionMode === 'single')) {
      const store = teamStore(base.teamId);
      const govState = replayGovernanceState(store.governanceEvents(), taskSeq);
      const stageObj = (effectiveActor.role === 'leader' && name === 'team_dispatch' && args?.stage_id)
        ? (frontierState(store, taskSeq).stages.get(args.stage_id) ?? null)
        : null;
      const govHit = checkGovernanceExecutionGate(govState, effectiveActor, name, args, stageObj, process.platform);
      if (govHit) return this.record(base, { decision: 'deny', by: `rule:${govHit.rule}`, reason: govHit.reason });
    }
    if (actor.role === 'leader' && name === 'team_direct_exec') {
      return this.record(base, { decision: 'allow', by: 'gate-rule', risk: 'low', reason: 'safety gate authorized confined direct-exec invocation' });
    }
    if (actor.role === 'leader' && name === 'team_dispatch') {
      try {
        reviewArgs = dispatchContract(teamStore(actor.teamId), cfg, taskSeq, args);
        if (args.stage_id) base.resolvedArgsSha256 = hashJson(reviewArgs);
      }
      catch (error) { return this.record(base, { decision: 'deny', by: 'rule:dispatch-contract', reason: error.message }); }
      const snapshot = readQuotaStateFile(cfg.quota.stateFile);
      const admission = quotaGate(cfg, snapshot.ok ? snapshot.state : null, reviewArgs.model, new Date());
      if (!admission.allowed) return this.record(base, { decision: 'deny', by: 'rule:dispatch-quota', reason: admission.error });
    }
    if ((actor.role === 'member' || actor.role === 'direct_exec') && (cfg.gate.mutatingTools.includes(name) || cfg.gate.shellTools.includes(name))) {
      if (actor.role === 'member' && !isAutonomousGovernance(cfg) && cfg.team.requirePlanAgreement && !cfg.team.planExemptProfiles.includes(actor.profile) && (actor.taskSeq ?? 1) !== taskSeq && base.teamId) {
        const store = teamStore(base.teamId);
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
        const hasCurrentPlan = [...states.entries()].some(([id, s]) => s.kind === 'plan' && (s.taskSeq ?? 1) === taskSeq && !replacedApproved(id) && s.outcome?.decision === 'approve');
        if (!hasCurrentPlan) {
          return this.record(base, { decision: 'deny', by: 'rule:no-approved-plan-for-current-task', reason: `member "${actor.name}" was dispatched under earlier task #${actor.taskSeq ?? 1}; obtain an approved kind "plan" agreement for current task #${taskSeq} before resuming mutating member work` });
        }
      }
      if (actor.model && cfg.models?.[actor.model]) {
        const qr = readQuotaStateFile(cfg.quota.stateFile);
        const mg = quotaGate(cfg, qr.ok ? qr.state : null, actor.model, new Date());
        if (!mg.allowed && mg.quota.status === 'exhausted') {
          return this.record(base, { decision: 'deny', by: 'rule:member-model-quota', reason: `member model quota blocked: ${mg.error}` });
        }
      }
    }
    if (classifyTool(name, cfg, actor) === 'uncontrolled') { rt.counters.uncontrolled++; return { decision: 'allow', by: 'uncontrolled' }; }
    // Rule-only tools passed every deterministic rule above and have no effect outside LeaderTeam's own references
    // directory; a model review adds cost and delay but, over 83 real reviews, never a denial. Still audited.
    if (actor.role !== 'direct_exec' && cfg.gate.ruleOnlyTools.includes(name)) {
      return this.record(base, { decision: 'allow', by: 'rule-only', risk: 'low', reason: 'covered by deterministic rules; no model review' });
    }
    const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : actor.cwd;
    if (actor.role === 'direct_exec') {
      const directGate = evaluateDirectExecSafetyGate({ tool: name, args: reviewArgs, actor, cwd, platform: process.platform }, cfg);
      if (directGate.decision !== 'needs-model') {
        return this.record(base, { decision: directGate.decision, by: directGate.by, risk: directGate.risk, reason: directGate.reason });
      }
      base.boundaryReason = directGate.reason;
    } else if (cfg.gate.sandboxDirectAllow !== false) {
      const boundary = classifySandboxBoundary({ tool: name, args: reviewArgs, actor, cwd, platform: process.platform }, cfg);
      if (boundary.confined) {
        return this.record(base, { decision: 'allow', by: 'sandbox', risk: 'low', reason: boundary.reason });
      }
      base.boundaryReason = boundary.reason;
      const detCross = evaluateCrossBoundarySafetyGate({ tool: name, args: reviewArgs, actor, cwd, platform: process.platform }, cfg);
      if (detCross) {
        return this.record(base, detCross);
      }
    }
    const usePatternCache = cfg.gate.enablePatternCache !== false && (actor.role === 'direct_exec' || cfg.gate.sandboxDirectAllow !== false);
    const patternCacheKey = usePatternCache
      ? `${base.teamId ?? 'local'}:${taskSeq}:${actor.role}${actor.role === 'leader' ? `:${initialExecutionMode ?? 'team'}` : ''}:${actor.stageHash ?? actor.name ?? agent.id}:${computeGatePatternKey(name, reviewArgs, base.boundaryReason ?? '')}`
      : null;
    if (patternCacheKey) {
      rt.gatePatternCache ??= new Map();
      const cached = rt.gatePatternCache.get(patternCacheKey);
      if (cached) {
        return this.record(base, { ...cached, by: 'gate-cache' });
      }
    }
    rt.inFlightGateReviews ??= new Map();
    const teamInFlight = base.teamId ? (rt.inFlightGateReviews.get(base.teamId) ?? new Map()) : null;
    if (teamInFlight && base.teamId) rt.inFlightGateReviews.set(base.teamId, teamInFlight);
    const inFlightMember = teamInFlight ? (teamInFlight.get(agent.id) ?? 0) : 0;
    const inFlightTeam = teamInFlight ? [...teamInFlight.values()].reduce((a, b) => a + b, 0) : 0;
    if (base.teamId) {
      let receipts;
      try { receipts = teamStore(base.teamId).gateReceipts(); }
      catch (e) {
        rt.counters.denied++;
        return { decision: 'deny', by: 'gate-receipt-error', reason: `cannot read safety-gate audit log: ${e.message}` };
      }
      const taskReceipts = receipts.filter(x => (x.taskSeq ?? 1) === taskSeq);
      if (cfg.gate.dedupeDeniedCalls) {
        const prevDeny = taskReceipts.find(
          x => x.agentId === agent.id
            && x.tool === name
            && x.argsSha256 === base.argsSha256
            && x.decision === 'deny'
            && (x.by === 'model' || x.by === 'rule:provider-policy-refusal')
            && (actor.role !== 'leader' || (x.executionMode ?? 'team') === (initialExecutionMode ?? 'team')),
        );
        if (prevDeny) return this.record(base, { decision: 'deny', by: 'rule:duplicate-denied-call', reason: `identical operation was already denied by safety review: ${prevDeny.reason}` });
      }
      // Safety review unavailable N times in a row for this agent: stop calling until the cooldown has passed, so an
      // upstream outage cannot turn into an unbounded retry loop. One probe call is accepted after each cooldown.
      if (Number.isInteger(cfg.gate.maxConsecutiveGateErrors)) {
        let errors = 0, lastAt = null;
        for (let i = taskReceipts.length - 1; i >= 0; i--) {
          const x = taskReceipts[i];
          if (x.agentId !== agent.id || x.by === 'rule:gate-unavailable-circuit-breaker') continue;
          if (x.by !== 'gate-error') break;
          errors++;
          if (lastAt === null) lastAt = Date.parse(x.at);
        }
        const cooldownMs = cfg.gate.gateErrorCooldownMs;
        if (errors >= cfg.gate.maxConsecutiveGateErrors && Number.isFinite(lastAt) && Date.now() - lastAt < cooldownMs) {
          return this.record(base, { decision: 'deny', by: 'rule:gate-unavailable-circuit-breaker', reason: `safety review has been unavailable ${errors} times in a row; stop retrying now (members: report STATUS: blocked, safety review unavailable; leader: tell the user). One new attempt is accepted ${Math.ceil(cooldownMs / 1000)} s after the last failure` });
        }
      }
      if (actor.role === 'member') {
        let consecutiveDenials = 0;
        for (let i = taskReceipts.length - 1; i >= 0; i--) {
          const x = taskReceipts[i];
          // Not policy refusals of the member's work: review outages, and the reminder to read assigned references first.
          if (x.agentId !== agent.id || x.by === 'gate-error' || x.by === 'rule:gate-unavailable-circuit-breaker' || x.by === 'rule:refs-unread' || ['rule:tool-not-loaded','rule:write-before-read','rule:conference-checkpoint-pause'].includes(x.by)) continue;
          if (x.decision === 'allow') break;
          if (x.decision === 'deny') consecutiveDenials++;
        }
        if (Number.isInteger(cfg.gate.maxDenialsPerMember) && consecutiveDenials >= cfg.gate.maxDenialsPerMember) {
          return this.record(base, { decision: 'deny', by: 'rule:member-denial-circuit-breaker', reason: `member "${actor.name}" reached the safety-gate denial limit (${cfg.gate.maxDenialsPerMember}); stop retrying and report STATUS: blocked` });
        }
        if (Number.isInteger(cfg.gate.maxReviewsPerMember)) {
          const memberReviews = taskReceipts.filter(x => x.agentId === agent.id && (x.by === 'model' || x.by === 'gate-error' || x.by === 'rule:provider-policy-refusal')).length;
          if (memberReviews + inFlightMember >= cfg.gate.maxReviewsPerMember) {
            return this.record(base, { decision: 'deny', by: 'rule:gate-budget-exceeded', reason: `member "${actor.name}" reached the safety-review call budget (${cfg.gate.maxReviewsPerMember}) for this task` });
          }
        }
      }
      if (Number.isInteger(cfg.gate.maxReviewsPerTask)) {
        const totalReviews = taskReceipts.filter(x => x.by === 'model' || x.by === 'gate-error' || x.by === 'rule:provider-policy-refusal').length;
        let budget = cfg.gate.maxReviewsPerTask;
        const taskMemberCount = [...teamStore(base.teamId).members().values()].filter(m => (m.taskSeq ?? 1) === taskSeq && m.status !== 'failed').length;
        const denied = taskReceipts.filter(x => (x.by === 'model' || x.by === 'rule:provider-policy-refusal') && x.decision === 'deny').length;
        if (taskMemberCount >= 4 && denied <= Math.floor(totalReviews*0.05) && Number.isInteger(cfg.gate.maxReviewsPerMember)) budget=Math.max(budget,taskMemberCount*Math.max(1,Math.floor(cfg.gate.maxReviewsPerMember*0.75)));
        if (totalReviews+inFlightTeam >= budget) return this.record(base, {decision:'deny',by:'rule:gate-budget-exceeded',reason:'team reached the safety-review call budget ('+budget+') for this task'});
      }
    }
    const qr = readQuotaStateFile(cfg.quota.stateFile);
    const quotaNow = new Date();
    const exhausted = t => { const g = quotaGate(cfg, qr.ok ? qr.state : null, t.route, quotaNow); return !g.allowed && g.quota.status === 'exhausted' ? g.error : null; };
    let leaderModel = null;
    try { leaderModel = rt.actors?.get(base.teamId)?.agent?.model?.current?.() ?? null; } catch { leaderModel = null; }
    const chain = roleRouteChain(cfg, 'gate', leaderModel);
    if (chain.every(t => exhausted(t) !== null)) {
      return this.record(base, { decision: 'deny', by: 'gate-quota', reason: `safety gate model quota blocked (${exhausted(chain[0])}); failed closed without executing` });
    }
    const liveUserTask = userTaskText(this.ctx, actor.teamId, cfg.gate.maxAuthorizationChars) || actor.userTask || '';
    const req = buildGateRequest({ tool: name, args: reviewArgs, toolDescription, callId, actor, cwd: actor.cwd, userTask: liveUserTask, platform: process.platform }, cfg);
    if (teamInFlight) teamInFlight.set(agent.id, (teamInFlight.get(agent.id) ?? 0) + 1);
    rt.scheduler?.beginGateReview?.();
    let r;
    try {
      r = await callRoleJson(rt.llm, chain, { system: req.system, user: req.user, signal }, parseGateVerdict, {
        skip: exhausted,
        onAttempt: (t, a) => recordUsage(base.teamId, { role: 'gate', route: t.route, effort: t.effort, ok: a.ok, attempts: a.attempts, tool: name, callId, member: base.member, usage: a.usage ?? null, ...(t.degraded ? { degraded: true, via: t.via } : {}) }),
      });
    } finally {
      rt.scheduler?.endGateReview?.();
      if (teamInFlight) {
        const nextCount = (teamInFlight.get(agent.id) ?? 1) - 1;
        if (nextCount <= 0) teamInFlight.delete(agent.id);
        else teamInFlight.set(agent.id, nextCount);
      }
    }
    const used = r.target ?? chain[0];
    const ran = { model: used.route, ...(used.degraded ? { degraded: true, via: used.via } : {}) };
    if (!r.ok) {
      rt.counters.reviewErrors++;
      const triedNote = r.tried.length > 1 ? `; routes tried: ${r.tried.map(x => `${x.route} (${x.skipped ? 'quota' : x.error})`).join(', ')}` : '';
      if (r.error?.kind === 'policy') {
        return this.record(base, {
          decision: 'deny',
          by: 'rule:provider-policy-refusal',
          reason: `safety review refused by provider policy after ${r.attempts} attempt(s) (${r.error.kind} ${r.error.code}: ${r.error.message}); failed closed without executing — non-retryable policy refusal, do not retry this call unchanged${triedNote}`,
          ...ran,
          attempts: r.attempts,
        });
      }
      return this.record(base, { decision: 'deny', by: 'gate-error', reason: `safety review unavailable after ${r.attempts} attempt(s) (${r.error.kind} ${r.error.code}: ${r.error.message}); failed closed without executing — transient upstream error, safe to retry this call${triedNote}`, ...ran, attempts: r.attempts });
    }
    if (r.verdict.decision === 'allow') {
      if (actor.role === 'leader' && name === 'team_dispatch' && args.stage_id) {
        try {
          const live = dispatchContract(teamStore(actor.teamId), cfg, taskSeq, args);
          if (hashJson(live) !== base.resolvedArgsSha256) throw new Error('stage dispatch changed during safety review');
        } catch (error) { return this.record(base, { decision: 'deny', by: 'rule:stage-changed-during-review', reason: error.message }); }
      }
      if (typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd !== actor.cwd) {
        return this.record(base, { decision: 'deny', by: 'binding', reason: 'the operation changed while it was under review', ...ran, attempts: r.attempts, latencyMs: r.latencyMs });
      }
      if (actor.role === 'leader' && actor.teamId && getSessionExecutionMode(rt, actor.teamId) !== initialExecutionMode) {
        return this.record(base, { decision: 'deny', by: 'binding', reason: 'the operation changed while it was under review', ...ran, attempts: r.attempts, latencyMs: r.latencyMs });
      }
      const postHit = this.checkHardRules({ name, args, agent, actor });
      if (postHit) {
        return this.record(base, { decision: 'deny', by: `rule:${postHit.rule}`, reason: postHit.reason, ...ran, attempts: r.attempts, latencyMs: r.latencyMs });
      }
    }
    if (patternCacheKey) {
      rt.gatePatternCache ??= new Map();
      rt.gatePatternCache.set(patternCacheKey, { decision: r.verdict.decision, risk: r.verdict.risk, reason: r.verdict.reason });
    }
    return this.record(base, { ...r.verdict, by: 'model', ...ran, effort: used.effort, attempts: r.attempts, latencyMs: r.latencyMs });
  }
  record(base, verdict) {
    const rt = runtime();
    if (base.teamId) {
      try { teamStore(base.teamId).appendGateReceipt({ ...base, ...verdict }); }
      catch (e) {
        rt.logger?.warn?.(`leaderteam: gate receipt not written: ${e.message}`);
        if (verdict.decision === 'allow') {
          rt.counters.denied++;
          return { decision: 'deny', by: 'gate-receipt-error', reason: `cannot persist safety-gate audit receipt: ${e.message}` };
        }
      }
    }
    if (verdict.decision === 'allow') rt.counters.allowed++; else rt.counters.denied++;
    return verdict;
  }
}
/** After the core plugin is disposed: fail closed (hide all tools and deny all executions) for every LT-governed session. */
export class ClosedGate {
  constructor(ctx = null) { this.ctx = ctx; }
  actorFor(agent) {
    if (!agent) return null;
    const rt = runtime();
    const leaderPreset = rt.config?.profiles?.leader?.preset ?? 'leaderteam';
    let leaderMatch = false;
    try { leaderMatch = Boolean(isLeaderRoot(this.ctx, agent)); } catch { leaderMatch = false; }
    if (
      rt.actors.has(agent.id)
      || leaderMatch
      || agent.session?.header?.agentPreset === leaderPreset
      || agent.session?.header?.origin === 'subagent'
      || rt.config?.gate?.scope === 'all'
    ) {
      return {
        role: 'closed',
        agentId: agent.id,
        teamId: agent.id,
        allowedTools: [],
        loadedTools: [],
      };
    }
    return null;
  }
  async decide() {
    return { decision: 'deny', by: 'gate-closed', reason: 'the LeaderTeam core plugin is not running' };
  }
}
