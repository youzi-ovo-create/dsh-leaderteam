// Asynchronous 4-Stage Governance & Power Redistribution Engine:
//   - Stage 1: Non-blocking Async Dual Supervision (advisory unless unanimous objection)
//   - Stage 2: 3-Party Internal Caucus (Arbiter + Reviewer A + Reviewer B, >= 2/3 majority, zero pause)
//   - Pre-Conference Pause Barrier: Wait for ALL other active models (`member` + `direct_exec`) to write immediate
//     handoff checkpoints (`STOPPED_AT`, `COMPLETED_SO_FAR`, `RESUME_PLAN`, `STATUS: paused`) and stop BEFORE opening Stage 3
//   - Stage 3: 2-Party Formal Conference (Arbiter + Leader ONLY; `team_dispatch`, `send_message`, and `team_direct_exec`
//     are all suspended; Arbiter may modify or overturn initial expectations)
//   - Stage 4: Mandatory 5-part Return Packet sent back to Review Zone (strictly linked to parent `disputeChainId`)
//   - Event–Behavior–Chain Strike 3 -> Direct Human Escalation (file SHA-256 is auxiliary evidence ONLY)
//   - Arbiter Directive Verification -> Cleared ONLY when concrete corrective requirements are verified
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  SUPERVISION_REVIEWER_SYSTEM,
  buildSupervisionReviewerUser,
  parseSupervisionOpinion,
  evaluateStage1Supervision,
  CAUCUS_ARBITER_SYSTEM,
  CAUCUS_REVIEWER_VOTE_SYSTEM,
  parseCaucusVote,
  tallyCaucusVotes,
  DIRECTIVE_VERIFICATION_SYSTEM,
  parseDirectiveVerification,
  CONFERENCE_OPENING_SYSTEM,
  CONFERENCE_DELIBERATION_SYSTEM,
  parseConferenceOpening,
  parseConferenceDeliberation,
  buildStage4ReviewPacket,
  replayGovernanceState,
  isAutonomousGovernance,
} from '../core/governance-protocol.mjs';
import {
  normalizeDisputeTargets,
  computeBehaviorIdentity,
  computeActualBehaviorDigest,
  resolveDisputeStrike,
} from '../core/dispute-tracker.mjs';
import { readJsonl } from '../core/store.mjs';
import { frontierState } from '../core/frontier.mjs';
import { roleRouteChain } from '../core/role-routes.mjs';
import { readQuotaStateFile } from '../core/quota.mjs';
import { quotaGate } from '../core/models.mjs';
import { resolvePath, isInside, relativeInside, matchesAnyGlob, anyGlobOverlaps } from '../core/paths.mjs';
import { truncate } from '../core/redact.mjs';
import { baseRuntime, recordUsage } from './runtime.mjs';

const ACTIVE_EXECUTION_STATUSES = new Set(['starting', 'started', 'running']);

function buildHostMessage(rt, text) {
  const input = { content: [{ type: 'text', text }], source: { kind: 'cordis-host-runner' } };
  if (typeof rt?.createUserMessage === 'function') return rt.createUserMessage(input);
  return Object.freeze({ ...input, role: 'user', id: randomUUID() });
}

function notifyAgent(rt, agent, text) {
  if (!agent) return false;
  const msg = buildHostMessage(rt, text);
  if (agent.status === 'running' && typeof agent.steer === 'function') {
    try { agent.steer(msg); return true; } catch {}
  }
  if (typeof agent.followup === 'function') {
    try { agent.followup(msg); return true; } catch {}
  }
  return false;
}

function extractFieldLine(text, label) {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im');
  const m = re.exec(String(text ?? ''));
  return m ? truncate(m[1].trim(), 600) : '';
}

/** Parse structured immediate handoff checkpoint from a paused subagent's final output + completed tool calls. Pure. */
export function parseCheckpointFromMemberOutput(finalText = '', completedTools = []) {
  const raw = String(finalText ?? '').trim();
  const stoppedAt = extractFieldLine(raw, 'STOPPED_AT')
    || extractFieldLine(raw, 'NOTES')
    || truncate(raw.split(/\r?\n/).find(l => l.trim() && !/^\s*STATUS:/i.test(l)) ?? 'interrupted at immediate conference checkpoint', 400);
  const completedSoFar = extractFieldLine(raw, 'COMPLETED_SO_FAR')
    || extractFieldLine(raw, 'CHANGED')
    || (completedTools.length > 0 ? completedTools.slice(-12).join(', ') : '(none recorded before pause)');
  const resumePlan = extractFieldLine(raw, 'RESUME_PLAN')
    || 'Continue from STOPPED_AT without repeating COMPLETED_SO_FAR and complete remaining acceptance checks.';
  const summary = truncate(`STOPPED_AT=${stoppedAt} | RESUME_PLAN=${resumePlan}`, 500);
  return Object.freeze({
    stoppedAt,
    completedSoFar,
    resumePlan,
    completedTools: Object.freeze([...completedTools].slice(-20)),
    rawText: truncate(raw, 1500),
    summary,
  });
}

/** Build deterministic resume instructions injecting the member's saved handoff checkpoint. Pure. */
export function buildCheckpointResumePrompt({
  conferenceId,
  decision = 'overturn_objection',
  rulingSummary = '',
  bindingDirectives = [],
  checkpoint = null,
}) {
  const lines = [
    `[LeaderTeam Governance Notice — Resume Execution after Conference (${conferenceId ?? 'concluded'})]`,
    rulingSummary
      ? `Formal Arbiter–Leader conference concluded (${decision}: ${rulingSummary}).`
      : 'The governance conference has concluded; resume your assignment immediately.',
  ];
  if (Array.isArray(bindingDirectives) && bindingDirectives.length > 0) {
    lines.push(`Binding directives: ${bindingDirectives.join('; ')}`);
  }
  if (checkpoint) {
    lines.push('Saved Handoff Checkpoint:');
    if (checkpoint.stoppedAt) lines.push(`- STOPPED_AT: ${checkpoint.stoppedAt}`);
    if (checkpoint.completedSoFar) lines.push(`- COMPLETED_SO_FAR (already on disk — do NOT repeat): ${checkpoint.completedSoFar}`);
    if (checkpoint.resumePlan) lines.push(`- RESUME_PLAN: ${checkpoint.resumePlan}`);
  }
  lines.push('Resume directly from your checkpoint toward your acceptance criteria and report `STATUS: done` when complete.');
  return lines.join('\n');
}

/** Collect bounded SHA-256 content hashes for workspace files matching `targets` (strictly auxiliary evidence). */
export function collectTargetFileHashes(cwd, targets = [], protectedDirs = ['.leaderteam', '.git', '.agents'], platform = process.platform) {
  const ws = resolvePath(cwd, undefined, platform);
  if (!ws || !fs.existsSync(ws)) return {};
  const normTargets = normalizeDisputeTargets(targets);
  const skipTop = new Set(['node_modules', ...protectedDirs.map(d => d.replace(/\\/g, '/').split('/')[0])]);
  const hashes = {};
  let scanned = 0;

  function walk(dir) {
    if (scanned >= 400) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (scanned >= 400) break;
      if (dir === ws && skipTop.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ent.isSymbolicLink()) walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = relativeInside(ws, full, platform);
      if (!rel) continue;
      scanned++;
      if (normTargets.length === 0 || matchesAnyGlob(rel, normTargets, platform) || normTargets.includes(rel)) {
        try {
          const stat = fs.statSync(full);
          if (stat.size <= 2 * 1024 * 1024) {
            hashes[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          } else {
            hashes[rel] = `size:${stat.size}`;
          }
        } catch {}
      }
    }
  }

  walk(ws);
  return hashes;
}

function loadBoundedWorkspaceExcerpts(cwd, relFiles = [], maxTotalChars = 32000, platform = process.platform) {
  const ws = resolvePath(cwd, undefined, platform);
  if (!ws) return [];
  const excerpts = [];
  let used = 0;
  for (const raw of Array.isArray(relFiles) ? relFiles : []) {
    if (typeof raw !== 'string' || !raw.trim() || used >= maxTotalChars) continue;
    const target = resolvePath(raw.trim(), ws, platform);
    if (!target || !isInside(target, ws, platform)) continue;
    try {
      const st = fs.statSync(target);
      if (!st.isFile()) continue;
      const text = fs.readFileSync(target, 'utf8');
      const budget = Math.min(8000, maxTotalChars - used);
      const slice = truncate(text, budget);
      used += slice.length;
      excerpts.push({ file: relativeInside(ws, target, platform) ?? raw, content: slice });
    } catch {}
  }
  return excerpts;
}

async function callGovernanceRole(rt, teamId, taskSeq, roleKey, leaderModel, system, user, parse, purpose, signal) {
  if (!rt?.llm || !rt?.config) return { ok: false, error: { kind: 'unavailable', code: 'NO_LLM', message: 'no llm' } };
  const { callRoleJson } = await import('./llm.mjs');
  const chain = roleRouteChain(rt.config, roleKey, leaderModel);
  const quotaSnap = readQuotaStateFile(rt.config.quota?.stateFile);
  return callRoleJson(
    rt.llm,
    chain,
    { system, user, timeoutMs: 90000, signal },
    parse,
    {
      skip(target) {
        const q = quotaGate(rt.config, quotaSnap.ok ? quotaSnap.state : null, target.route, new Date());
        return !q.allowed && q.quota.status === 'exhausted' ? q.error : null;
      },
      onAttempt(target, res) {
        recordUsage(teamId, {
          role: roleKey,
          purpose,
          taskSeq,
          route: target.route,
          effort: target.effort,
          ok: res.ok,
          attempts: res.attempts,
          ...(res.usage ? { usage: res.usage } : {}),
          ...(target.degraded ? { degraded: true, via: target.via } : {}),
        });
      },
    },
  );
}

/**
 * Request ALL active execution models (`member` AND `direct_exec`) to stop immediately,
 * call ZERO further tools, and emit their structured handoff checkpoint (`STATUS: paused`).
 */
export async function requestExecutionModelsCheckpointPause({ ctx, rt, store, leaderAgent, taskSeq, conferenceId, reason }) {
  const pausedIds = [];
  const base = baseRuntime(rt);
  const checkpointNotice = [
    `[LeaderTeam Governance — Immediate Checkpoint Pause (${conferenceId})]`,
    reason || 'A formal Arbiter–Leader conference is opening.',
    'MANDATORY IMMEDIATE STOP:',
    '- STOP IMMEDIATELY. Do NOT finish your current subtask and call ZERO tools (all tool calls are now blocked by the Safety Gate).',
    '- Write down only where you stopped and how to resume, then end this turn:',
    'STOPPED_AT: <exact file, function, or step where you stopped>',
    'COMPLETED_SO_FAR: <files/operations already completed before this pause>',
    'RESUME_PLAN: <exact next step and arguments to execute first upon resume>',
    'STATUS: paused',
  ].join('\n');

  for (const m of store.members().values()) {
    if ((m.taskSeq ?? 1) !== taskSeq) continue;
    if (!ACTIVE_EXECUTION_STATUSES.has(m.status)) continue;

    pausedIds.push(m.childId);
    store.setMemberGovernanceState(m.childId, 'pausing_for_conference', { conferenceId });

    const liveChild = base.actors?.get(m.childId)?.agent ?? base.hostAgents?.get?.(m.childId) ?? null;
    if (liveChild && typeof liveChild.steer === 'function' && liveChild.status === 'running') {
      try {
        liveChild.steer(buildHostMessage(rt, checkpointNotice));
        continue;
      } catch {}
    }
    const subagentsSvc = ctx?.subagents ?? base.subagents ?? null;
    if (m.actorRole !== 'direct_exec' && subagentsSvc?.sendMessage && leaderAgent) {
      try {
        await subagentsSvc.sendMessage(leaderAgent, m.childId, [{ type: 'text', text: checkpointNotice }], { signal: new AbortController().signal });
      } catch {}
    }
  }
  return pausedIds;
}

/** Alias kept for compatibility with external callers. */
export const requestOrdinaryMembersWindDownPause = requestExecutionModelsCheckpointPause;

/**
 * Deterministic Pre-Conference Pause Barrier:
 * Issues immediate checkpoint pause to ALL active execution models (`member` + `direct_exec`) and
 * waits until every single one has written its checkpoint and stopped BEFORE Stage 3 Conference opens.
 */
export async function awaitExecutionModelsCheckpointPause({
  ctx,
  rt,
  store,
  leaderAgent,
  taskSeq,
  conferenceId,
  disputeId,
  strike = 1,
  stageId = null,
  targets = [],
  reason,
  signal,
  emitPausingEvent = true,
}) {
  const activeBefore = [...store.members().values()]
    .filter(m => (m.taskSeq ?? 1) === taskSeq && ACTIVE_EXECUTION_STATUSES.has(m.status))
    .map(m => m.childId);

  if (emitPausingEvent) {
    store.appendGovernanceEvent({
      type: 'conference-pausing',
      taskSeq,
      conferenceId,
      disputeId,
      strike,
      stageId,
      targets,
      targetMemberIds: activeBefore,
    });
  }

  const pausedIds = await requestExecutionModelsCheckpointPause({
    ctx,
    rt,
    store,
    leaderAgent,
    taskSeq,
    conferenceId,
    reason,
  });

  const startedWait = Date.now();
  const timeoutMs = rt?.config?.governance?.pauseBarrierTimeoutMs ?? 30000;
  const base = baseRuntime(rt);

  while (!signal?.aborted && !rt?.planningDisposed) {
    const stillRunning = [...store.members().values()].filter(
      m => (m.taskSeq ?? 1) === taskSeq && ACTIVE_EXECUTION_STATUSES.has(m.status),
    );
    if (stillRunning.length === 0) break;

    if (Date.now() - startedWait >= timeoutMs) {
      // Bounded timeout safety fallback: snapshot completed operations and force-settle hung streams so conference cannot deadlock
      for (const m of stillRunning) {
        const liveChild = base.actors?.get(m.childId)?.agent ?? base.hostAgents?.get?.(m.childId) ?? null;
        const fallbackCp = parseCheckpointFromMemberOutput(
          'STOPPED_AT: barrier timeout while awaiting model turn end\nRESUME_PLAN: inspect last completed tool calls and continue',
          [],
        );
        try { store.saveMemberCheckpoint(m.childId, conferenceId, fallbackCp); } catch {}
        try {
          store.setMemberGovernanceState(m.childId, 'paused_for_conference', {
            conferenceId,
            checkpoint: fallbackCp,
            resumePoint: fallbackCp.summary,
          });
          store.setMemberStatus(m.childId, 'paused', 'paused at pre-conference barrier timeout fallback');
        } catch {}
        try { liveChild?.cancel?.('paused for formal governance conference'); } catch {}
      }
      break;
    }

    await new Promise(resolve => {
      const t = setTimeout(resolve, 30);
      t.unref?.();
    });
  }

  store.appendGovernanceEvent({
    type: 'conference-pause-barrier-completed',
    taskSeq,
    conferenceId,
    disputeId,
    pausedMemberIds: pausedIds,
    barrierElapsedMs: Date.now() - startedWait,
  });

  return pausedIds;
}

/** Resume ordinary members that were paused for a Formal Conference once the conference concludes. */
export async function resumePausedMembersAfterConference({ ctx, rt, store, leaderAgent, taskSeq, conference, ruling }) {
  const resumed = [];
  const base = baseRuntime(rt);
  const blockedTargets = ruling?.blockedTargets ?? [];
  const adjustDisputed = ruling?.memberResumePolicy === 'adjust_disputed_resume_others' || blockedTargets.length > 0;

  for (const m of store.members().values()) {
    if ((m.taskSeq ?? 1) !== taskSeq) continue;
    if (m.actorRole === 'direct_exec') continue;
    const wasTargetedByConf = m.status === 'paused' || m.governanceState === 'pausing_for_conference' || m.governanceState === 'paused_for_conference';
    if (!wasTargetedByConf) continue;

    if (adjustDisputed) {
      const overlapsDisputed = (m.stageId && (blockedTargets.includes(m.stageId) || conference.stageId === m.stageId))
        || (Array.isArray(m.writeScope) && m.writeScope.some(g => (conference.targets ?? []).includes(g)));
      if (overlapsDisputed && ruling.decision === 'enforce_correction') {
        // Leave in recoverable `paused` state so the Leader can send adjusted instructions from the ruling
        if (m.status !== 'paused') store.setMemberStatus(m.childId, 'paused');
        continue;
      }
    }

    const savedCheckpoint = store.loadMemberCheckpoint?.(m.childId, conference.conferenceId) ?? m.checkpoint ?? null;
    const resumeText = buildCheckpointResumePrompt({
      conferenceId: conference.conferenceId,
      decision: ruling.decision,
      rulingSummary: ruling.rulingSummary,
      bindingDirectives: ruling.bindingDirectives ?? [],
      checkpoint: savedCheckpoint,
    });

    store.setMemberGovernanceState(m.childId, null, { conferenceId: null });
    const liveChild = base.actors?.get(m.childId)?.agent ?? base.hostAgents?.get?.(m.childId) ?? null;
    let delivered = false;
    if (liveChild) {
      if (liveChild.status === 'running' && typeof liveChild.steer === 'function') {
        try { liveChild.steer(buildHostMessage(rt, resumeText)); delivered = true; } catch {}
      } else if (typeof liveChild.followup === 'function') {
        try { liveChild.followup(buildHostMessage(rt, resumeText)); delivered = true; } catch {}
      }
    }
    const subagentsSvc = ctx?.subagents ?? base.subagents ?? null;
    if (!delivered && subagentsSvc?.sendMessage && leaderAgent) {
      try {
        await subagentsSvc.sendMessage(leaderAgent, m.childId, [{ type: 'text', text: resumeText }], { signal: new AbortController().signal });
        delivered = true;
      } catch {}
    }
    if (delivered) {
      store.setMemberStatus(m.childId, 'running');
      resumed.push(m.childId);
    }
  }
  return resumed;
}

/** Collect post-strike execution records on overlapping targets for auxiliary dispute evidence. */
function collectExecutionRecordsSince(store, taskSeq, sinceIso, targets = [], platform = process.platform) {
  const sinceMs = sinceIso ? Date.parse(sinceIso) : 0;
  const rawRecords = readJsonl(store.membersFile).records;
  const doneTimes = new Map();
  for (const r of rawRecords) {
    if (r.type === 'member-status' && (r.status === 'done' || r.status === 'paused')) {
      const t = r.at ? Date.parse(r.at) : 0;
      if (Number.isFinite(t)) doneTimes.set(r.childId, t);
    }
  }
  const normTargets = normalizeDisputeTargets(targets);
  const out = [];
  for (const m of store.members().values()) {
    if ((m.taskSeq ?? 1) !== taskSeq) continue;
    const createdMs = m.at ? Date.parse(m.at) : 0;
    const finishedMs = doneTimes.get(m.childId) ?? 0;
    if (sinceMs > 0 && Math.max(createdMs, finishedMs) <= sinceMs) continue;
    const scope = Array.isArray(m.writeScope) ? m.writeScope : [];
    const overlaps = normTargets.length === 0
      || scope.length === 0
      || anyGlobOverlaps(scope, normTargets, platform);
    if (!overlaps) continue;
    out.push({
      childId: m.childId,
      name: m.name,
      actorRole: m.actorRole ?? 'member',
      status: m.status,
      stageId: m.stageId ?? null,
      writeScope: scope,
    });
  }
  return out;
}

/**
 * Deterministic check for whether concrete post-conference remediation execution occurred after `dir.concludedAt` (§二).
 * Mere collateral file changes without post-conference remediation execution return `hasExecution: false`.
 */
export function hasPostConferenceRemediationEvidence(store, taskSeq, dir, platform = process.platform) {
  const concludedMs = dir?.concludedAt ? Date.parse(dir.concludedAt) : 0;
  const rawMemberRecords = readJsonl(store.membersFile).records;
  const membersMap = store.members();
  const dirTargets = normalizeDisputeTargets([...(dir?.targets ?? []), ...(dir?.blockedTargets ?? []).filter(t => !t.startsWith('stage'))]);

  const completedExecutions = [];
  for (const r of rawMemberRecords) {
    if (r.type !== 'member-status' || r.status !== 'done') continue;
    const atMs = r.at ? Date.parse(r.at) : 0;
    if (concludedMs > 0 && atMs < concludedMs) continue;
    const m = membersMap.get(r.childId);
    if (!m || (m.taskSeq ?? 1) !== taskSeq) continue;
    const scope = Array.isArray(m.writeScope) ? m.writeScope : [];
    const scopeMatches = dirTargets.length === 0
      || (dir?.stageId && m.stageId === dir.stageId)
      || (scope.length > 0 && anyGlobOverlaps(scope, dirTargets, platform))
      || (m.actorRole === 'direct_exec' && scope.length === 0);
    if (scopeMatches) {
      completedExecutions.push({
        childId: m.childId,
        name: m.name,
        actorRole: m.actorRole ?? 'member',
        stageId: m.stageId ?? null,
        writeScope: scope,
        completedAt: r.at,
      });
    }
  }

  let stageAmended = true;
  let hasPassedStageVerification = false;
  if (dir?.stageId) {
    const stg = frontierState(store, taskSeq).stages.get(dir.stageId);
    if (stg && dir.stageHashAtRuling && dir.blockedTargets?.includes(dir.stageId)) {
      stageAmended = stg.hash !== dir.stageHashAtRuling;
    }
    const verifyEv = store.workflowEvents().findLast(
      e => (e.type === 'stage-verification' || e.type === 'plan-stage-verified')
        && (e.taskSeq ?? 1) === taskSeq
        && e.stageId === dir.stageId
        && e.result === 'passed'
        && (!concludedMs || Date.parse(e.at ?? '') >= concludedMs),
    );
    hasPassedStageVerification = Boolean(verifyEv);
  }

  return {
    hasExecution: completedExecutions.length > 0,
    completedExecutions,
    stageAmended,
    hasPassedStageVerification,
  };
}

/**
 * Verify active Arbiter directives before allowing `delivered` (§二: 裁断指令不能靠文件变化自动销账).
 *   1. Deterministic check: requires actual post-conference remediation execution (`hasExecution === true`).
 *   2. Substantive check: verifies concrete `dir.directives` against live workspace files and execution records.
 */
export async function verifyActiveArbiterDirectives({
  rt,
  store,
  actor,
  leaderModel = null,
  taskSeq = 1,
  signal,
}) {
  const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
  const active = gov.activeDirectives.filter(d => d.decision === 'enforce_correction' || d.decision === 'adopt_alternative');
  if (active.length === 0) return { allSatisfied: true, missing: [] };

  const base = baseRuntime(rt);
  base.directiveVerifyPending ??= new Set();
  if (actor?.teamId) base.directiveVerifyPending.add(actor.teamId);

  try {
    const missing = [];
    for (const dir of active) {
      const rem = hasPostConferenceRemediationEvidence(store, taskSeq, dir);
      if (!rem.hasExecution) {
        missing.push({
          conferenceId: dir.conferenceId,
          disputeId: dir.disputeId,
          directives: dir.directives,
          reason: 'No post-conference remediation execution has completed since the Arbiter ruling.',
        });
        continue;
      }

      const dirTargets = normalizeDisputeTargets(dir.targets);
      const targetHashes = collectTargetFileHashes(actor.cwd, dirTargets, rt.config?.paths?.protectedDirs);
      const excerpts = loadBoundedWorkspaceExcerpts(actor.cwd, Object.keys(targetHashes).slice(0, 8), 24000);

      if (!rt?.llm) {
        if (rem.hasPassedStageVerification) {
          store.appendGovernanceEvent({
            type: 'arbiter-directive-satisfied',
            taskSeq,
            disputeId: dir.disputeId,
            conferenceId: dir.conferenceId,
            verifiedBy: 'deterministic-stage-verification',
          });
          continue;
        }
        missing.push({
          conferenceId: dir.conferenceId,
          disputeId: dir.disputeId,
          directives: dir.directives,
          reason: 'Remediation verification requires passed stage verification or Arbiter inspection.',
        });
        continue;
      }

      const verifyPayload = {
        conference_id: dir.conferenceId,
        dispute_id: dir.disputeId,
        decision: dir.decision,
        ruling_summary: dir.rulingSummary,
        binding_directives: dir.directives,
        post_conference_executions: rem.completedExecutions,
        passed_stage_verification: rem.hasPassedStageVerification,
        workspace_excerpts: excerpts,
      };

      const verRes = await callGovernanceRole(
        rt,
        actor.teamId,
        taskSeq,
        'arbiter',
        leaderModel,
        DIRECTIVE_VERIFICATION_SYSTEM,
        JSON.stringify(verifyPayload),
        parseDirectiveVerification,
        'directive-verification',
        signal,
      );

      if (verRes.ok && verRes.verification.satisfied) {
        store.appendGovernanceEvent({
          type: 'arbiter-directive-satisfied',
          taskSeq,
          disputeId: dir.disputeId,
          conferenceId: dir.conferenceId,
          verifiedBy: 'arbiter-directive-verification',
          verifiedItems: verRes.verification.verifiedItems,
          reason: verRes.verification.reason,
        });
      } else {
        const missingDetail = verRes.ok
          ? `${verRes.verification.reason} (Missing: ${verRes.verification.missingItems.join('; ')})`
          : 'Directive verification unavailable; confirm remediation via stage verification or delivery review.';
        missing.push({
          conferenceId: dir.conferenceId,
          disputeId: dir.disputeId,
          directives: dir.directives,
          reason: missingDetail,
        });
      }
    }

    return { allSatisfied: missing.length === 0, missing };
  } finally {
    if (actor?.teamId) base.directiveVerifyPending.delete(actor.teamId);
  }
}

/** Trigger Strike 3 Direct Human Escalation (§5): NO further Arbiter cycle. */
async function triggerHumanDisputeEscalation({
  ctx,
  rt,
  store,
  actor,
  leaderAgent,
  taskSeq,
  strikeInfo,
  stageId,
  opinionA,
  opinionB,
  signal,
}) {
  const escalationId = `esc-${randomUUID().slice(0, 8)}`;
  const govBefore = replayGovernanceState(store.governanceEvents(), taskSeq);
  const priorDispute = govBefore.disputes.find(d => d.disputeId === strikeInfo.disputeId);

  const pausedMemberIds = await awaitExecutionModelsCheckpointPause({
    ctx,
    rt,
    store,
    leaderAgent,
    taskSeq,
    conferenceId: escalationId,
    disputeId: strikeInfo.disputeId,
    strike: strikeInfo.strikeCount,
    stageId,
    targets: strikeInfo.targets,
    reason: `3rd unanimous objection on dispute chain ${strikeInfo.disputeId} has escalated to Human decision; write immediate handoff checkpoint and pause.`,
    signal,
    emitPausingEvent: false,
  });

  const dossier = {
    dispute_id: strikeInfo.disputeId,
    dispute_chain_id: strikeInfo.disputeChainId ?? strikeInfo.disputeId,
    event_id: strikeInfo.eventId ?? null,
    behavior_id: strikeInfo.behaviorId ?? null,
    strike_count: strikeInfo.strikeCount,
    targets: strikeInfo.targets,
    stage_id: stageId ?? null,
    prior_strikes: priorDispute?.history ?? [],
    prior_conferences: priorDispute?.conferences ?? [],
    auxiliary_evidence: strikeInfo.evidenceSnapshot ?? null,
    third_objection: {
      reviewer_A: opinionA,
      reviewer_B: opinionB,
    },
  };

  store.appendGovernanceEvent({
    type: 'human-escalation-opened',
    taskSeq,
    escalationId,
    disputeId: strikeInfo.disputeId,
    disputeChainId: strikeInfo.disputeChainId ?? strikeInfo.disputeId,
    eventId: strikeInfo.eventId ?? null,
    behaviorId: strikeInfo.behaviorId ?? null,
    strike: strikeInfo.strikeCount,
    stageId: stageId ?? null,
    targets: strikeInfo.targets,
    summary: `3rd unanimous objection on [${strikeInfo.targets.join(', ') || stageId || 'task'}]: A="${opinionA.summary}" | B="${opinionB.summary}"`,
    dossier,
    pausedMemberIds,
  });
  store.appendWorkflowEvent({
    type: 'human-dispute-escalation',
    taskSeq,
    escalationId,
    disputeId: strikeInfo.disputeId,
    eventId: strikeInfo.eventId ?? null,
    strike: strikeInfo.strikeCount,
    targets: strikeInfo.targets,
  });

  notifyAgent(rt, leaderAgent, [
    `[LeaderTeam Governance — 3rd Objection Escalated to Human (${escalationId})]`,
    `Dispute chain ${strikeInfo.disputeId} (event=${strikeInfo.eventId ?? 'n/a'}) on targets [${strikeInfo.targets.join(', ') || stageId || 'task'}] reached its 3rd unanimous objection.`,
    'Per constitutional rule §5, internal Arbiter cycling stops here and the dispute is escalated directly to the User.',
    `Reviewer A objection: ${opinionA.summary} (Concerns: ${opinionA.concerns.join('; ')})`,
    `Reviewer B objection: ${opinionB.summary} (Concerns: ${opinionB.concerns.join('; ')})`,
    'Action required: Call `team_status(stop_state="waiting_user", reason=..., question=...)` and present the complete dispute history, prior conference rulings, and concrete options for the User\'s decision.',
  ].join('\n'));

  return { status: 'human_escalation', escalationId, disputeId: strikeInfo.disputeId, dossier };
}

/** Stage 2: 3-Party Internal Caucus (Arbiter + A + B, >= 2/3 majority vote, ZERO execution pause). */
async function runThreePartyCaucus({
  ctx,
  rt,
  store,
  actor,
  leaderAgent,
  leaderModel,
  taskSeq,
  strikeInfo,
  strikeCandidate = null,
  stageId,
  proposal,
  opinionA,
  opinionB,
  userTask,
  supervisionId = null,
  signal,
}) {
  store.appendGovernanceEvent({
    type: 'caucus-started',
    taskSeq,
    disputeId: strikeInfo.disputeId,
    eventId: strikeInfo.eventId ?? null,
    strike: strikeInfo.strikeCount,
    needsContinuityVerification: Boolean(strikeInfo.needsContinuityVerification),
    stageId: stageId ?? null,
    targets: strikeInfo.targets,
  });

  const targetHashes = collectTargetFileHashes(actor.cwd, strikeInfo.targets, rt.config.paths?.protectedDirs);
  const targetExcerpts = loadBoundedWorkspaceExcerpts(actor.cwd, Object.keys(targetHashes).slice(0, 6), 18000);
  const membersSummary = [...store.members().values()]
    .filter(m => (m.taskSeq ?? 1) === taskSeq)
    .map(m => ({ name: m.name, actorRole: m.actorRole ?? 'member', stageId: m.stageId, status: m.status, writeScope: m.writeScope }));
  const recentGate = store.gateReceipts().filter(r => (r.taskSeq ?? 1) === taskSeq).slice(-12)
    .map(r => ({ tool: r.tool, role: r.role, member: r.member, decision: r.decision, by: r.by }));
  const govSnap = replayGovernanceState(store.governanceEvents(), taskSeq);

  const caucusFacts = {
    dispute_id: strikeInfo.disputeId,
    event_id: strikeInfo.eventId ?? null,
    current_behavior_identity: {
      behavior_id: strikeInfo.behaviorId ?? null,
      summary: strikeInfo.behaviorSummary ?? '',
    },
    ...(strikeInfo.matchedChain ? {
      prior_dispute_chain: {
        dispute_chain_id: strikeInfo.matchedChain.disputeChainId ?? strikeInfo.matchedChain.disputeId,
        event_id: strikeInfo.matchedChain.eventId,
        prior_behavior_id: strikeInfo.matchedChain.behaviorId,
        prior_behavior_summary: strikeInfo.matchedChain.behaviorSummary,
        prior_strikes: strikeInfo.matchedChain.history ?? [],
        prior_conferences: (strikeInfo.matchedChain.conferences ?? []).map(c => ({
          conference_id: c.conferenceId,
          strike: c.strike,
          decision: c.ruling?.decision,
          ruling_summary: c.ruling?.rulingSummary,
          binding_directives: c.ruling?.bindingDirectives ?? [],
        })),
      },
    } : {}),
    ...(govSnap.activeDirectives.length > 0 ? {
      active_arbiter_directives: govSnap.activeDirectives.map(d => ({
        conference_id: d.conferenceId,
        dispute_id: d.disputeId,
        decision: d.decision,
        binding_directives: d.directives,
      })),
    } : {}),
    auxiliary_evidence_snapshot: strikeInfo.evidenceSnapshot ?? null,
    strike_number: strikeInfo.strikeCount,
    stage_id: stageId ?? null,
    targets: strikeInfo.targets,
    user_task: truncate(String(userTask ?? ''), 3000),
    subject_proposal: truncate(String(proposal ?? ''), 6000),
    reviewer_A_objection: opinionA,
    reviewer_B_objection: opinionB,
    live_workspace_excerpts: targetExcerpts,
    active_and_completed_members: membersSummary,
    recent_safety_gate_receipts: recentGate,
  };

  const arbRes = await callGovernanceRole(
    rt,
    actor.teamId,
    taskSeq,
    'arbiter',
    leaderModel,
    CAUCUS_ARBITER_SYSTEM,
    JSON.stringify(caucusFacts),
    raw => parseCaucusVote(raw, true),
    'caucus-arbiter',
    signal,
  );
  const voteArbiter = arbRes.ok ? arbRes.vote : {
    escalate: true,
    rationale: 'Arbiter caucus check fallback: hear Leader directly in formal conference.',
    initialExpectation: opinionA.suggestions[0] ?? 'Verify disputed requirement with Leader.',
    questionsForLeader: ['Explain how the disputed requirement is addressed by current code/plan.'],
    factFindings: [],
    disputeContinuity: null,
    priorDirectiveSatisfied: null,
  };

  if (voteArbiter.priorDirectiveSatisfied === true) {
    for (const dir of govSnap.activeDirectives) {
      const rem = hasPostConferenceRemediationEvidence(store, taskSeq, dir);
      if (rem.hasExecution) {
        store.appendGovernanceEvent({
          type: 'arbiter-directive-satisfied',
          taskSeq,
          disputeId: dir.disputeId,
          conferenceId: dir.conferenceId,
          verifiedBy: 'caucus-arbiter',
        });
      }
    }
  }

  let effectiveStrike = strikeInfo;
  if (strikeInfo.needsContinuityVerification && strikeCandidate) {
    // Safe anti-reset rule: collateral file SHA-256 changes NEVER auto-reset a dispute chain;
    // reset ONLY when the Arbiter explicitly confirms `substantive_behavior_changed` (or on outage when structural behaviorId genuinely changed).
    const continuityVerdict = voteArbiter.disputeContinuity
      ?? (strikeInfo.behaviorChanged ? 'substantive_behavior_changed' : 'same_behavior_persists');
    const latestDisputes = replayGovernanceState(store.governanceEvents(), taskSeq).disputes;
    effectiveStrike = {
      ...resolveDisputeStrike(
        latestDisputes,
        { ...strikeCandidate, continuityVerdict },
        rt.config.governance,
      ),
      profile: strikeInfo.profile ?? null,
      tools: strikeInfo.tools ?? [],
      interfaces: strikeInfo.interfaces ?? [],
      continuityVerdict,
    };

    store.appendGovernanceEvent({
      type: 'dispute-strike-recorded',
      taskSeq,
      supervisionId,
      eventId: effectiveStrike.eventId,
      anchorTargets: effectiveStrike.anchorTargets,
      behaviorId: effectiveStrike.behaviorId,
      behaviorSummary: effectiveStrike.behaviorSummary,
      disputeChainId: effectiveStrike.disputeChainId,
      disputeId: effectiveStrike.disputeId,
      priorEpochDisputeId: effectiveStrike.priorEpochDisputeId,
      priorChainId: effectiveStrike.priorChainId,
      epoch: effectiveStrike.epoch,
      chainSeq: effectiveStrike.chainSeq,
      strikeCount: effectiveStrike.strikeCount,
      continuityVerdict,
      action: effectiveStrike.action,
      phaseKind: effectiveStrike.phaseKind,
      targets: effectiveStrike.targets,
      profile: effectiveStrike.profile,
      tools: effectiveStrike.tools,
      interfaces: effectiveStrike.interfaces,
      evidenceSnapshot: effectiveStrike.evidenceSnapshot,
      summaryA: opinionA.summary,
      summaryB: opinionB.summary,
    });

    // If Arbiter confirmed `same_behavior_persists` and this is Strike 3 -> escalate IMMEDIATELY to Human without a 3rd conference!
    if (effectiveStrike.action === 'escalate_human') {
      store.appendGovernanceEvent({
        type: 'caucus-completed',
        taskSeq,
        disputeId: effectiveStrike.disputeId,
        strike: effectiveStrike.strikeCount,
        stageId: stageId ?? null,
        escalatedToHuman: true,
        tally: null,
      });
      return triggerHumanDisputeEscalation({
        ctx,
        rt,
        store,
        actor,
        leaderAgent,
        taskSeq,
        strikeInfo: effectiveStrike,
        stageId,
        opinionA,
        opinionB,
        signal,
      });
    }
  }

  const reviewerCaucusPayload = JSON.stringify({
    ...caucusFacts,
    dispute_id: effectiveStrike.disputeId,
    strike_number: effectiveStrike.strikeCount,
    arbiter_preliminary_fact_check: {
      escalate_vote: voteArbiter.escalate,
      rationale: voteArbiter.rationale,
      fact_findings: voteArbiter.factFindings,
      initial_expectation: voteArbiter.initialExpectation,
      dispute_continuity: voteArbiter.disputeContinuity,
    },
  });

  const [resVoteA, resVoteB] = await Promise.all([
    callGovernanceRole(rt, actor.teamId, taskSeq, 'discussA', leaderModel, CAUCUS_REVIEWER_VOTE_SYSTEM, reviewerCaucusPayload, raw => parseCaucusVote(raw, false), 'caucus-vote-A', signal),
    callGovernanceRole(rt, actor.teamId, taskSeq, 'discussB', leaderModel, CAUCUS_REVIEWER_VOTE_SYSTEM, reviewerCaucusPayload, raw => parseCaucusVote(raw, false), 'caucus-vote-B', signal),
  ]);

  const voteA = resVoteA.ok ? resVoteA.vote : { escalate: true, rationale: opinionA.summary, initialExpectation: opinionA.suggestions[0] ?? '' };
  const voteB = resVoteB.ok ? resVoteB.vote : { escalate: true, rationale: opinionB.summary, initialExpectation: opinionB.suggestions[0] ?? '' };

  const tally = tallyCaucusVotes({ voteArbiter, voteA, voteB }, rt.config.governance);
  store.appendGovernanceEvent({
    type: 'caucus-completed',
    taskSeq,
    disputeId: effectiveStrike.disputeId,
    strike: effectiveStrike.strikeCount,
    stageId: stageId ?? null,
    tally,
  });
  store.appendWorkflowEvent({
    type: 'governance-caucus-result',
    taskSeq,
    disputeId: effectiveStrike.disputeId,
    strike: effectiveStrike.strikeCount,
    approved: tally.approved,
    yesVotes: tally.yesVotes,
    totalVotes: tally.totalVotes,
  });

  if (!tally.approved) {
    return { status: 'caucus_dismissed', disputeId: effectiveStrike.disputeId, tally };
  }

  // >= 2/3 voted YES -> Wait at Pre-Conference Barrier for ALL execution models to pause, THEN open Stage 3 Conference!
  return openFormalConference({
    ctx,
    rt,
    store,
    actor,
    leaderAgent,
    leaderModel,
    taskSeq,
    strikeInfo: effectiveStrike,
    stageId,
    profile: effectiveStrike.profile ?? null,
    tools: effectiveStrike.tools ?? [],
    interfaces: effectiveStrike.interfaces ?? [],
    tally,
    caucusFacts,
    signal,
  });
}

/**
 * Stage 3: Wait for ALL active execution models (`member` + `direct_exec`) to write their immediate
 * handoff checkpoint and pause, THEN open the 2-Party Formal Conference (Arbiter + Leader ONLY).
 */
async function openFormalConference({
  ctx,
  rt,
  store,
  actor,
  leaderAgent,
  leaderModel,
  taskSeq,
  strikeInfo,
  stageId,
  profile = null,
  tools = [],
  interfaces = [],
  tally,
  caucusFacts,
  signal,
}) {
  const conferenceId = `conf-${randomUUID().slice(0, 8)}`;
  const stageHashAtOpen = stageId ? (frontierState(store, taskSeq).stages.get(stageId)?.hash ?? null) : null;

  // 1. Pre-Conference Pause Barrier: ALL active execution models must checkpoint & pause BEFORE the conference opens!
  const pausedMemberIds = await awaitExecutionModelsCheckpointPause({
    ctx,
    rt,
    store,
    leaderAgent,
    taskSeq,
    conferenceId,
    disputeId: strikeInfo.disputeId,
    strike: strikeInfo.strikeCount,
    stageId,
    targets: strikeInfo.targets,
    reason: `Formal Arbiter–Leader Conference "${conferenceId}" is convening on [${strikeInfo.targets.join(', ') || stageId || 'task'}].`,
    signal,
    emitPausingEvent: true,
  });

  if (signal?.aborted || rt?.planningDisposed) return null;

  // 2. Now that all other models are paused and workspace files are quiescent, open the 2-Party Conference!
  const openRes = await callGovernanceRole(
    rt,
    actor.teamId,
    taskSeq,
    'arbiter',
    leaderModel,
    CONFERENCE_OPENING_SYSTEM,
    JSON.stringify({
      conference_id: conferenceId,
      dispute_id: strikeInfo.disputeId,
      event_id: strikeInfo.eventId ?? null,
      strike: strikeInfo.strikeCount,
      caucus_initial_expectation: tally.initialExpectation,
      caucus_questions: tally.questionsForLeader,
      reviewer_A_summary: caucusFacts.reviewer_A_objection.summary,
      reviewer_B_summary: caucusFacts.reviewer_B_objection.summary,
      targets: strikeInfo.targets,
    }),
    parseConferenceOpening,
    'conference-opening',
    signal,
  );

  const opening = openRes.ok ? openRes.opening : {
    openingStatement: `Dispute ${strikeInfo.disputeId} (${tally.yesVotes}/${tally.totalVotes} caucus vote): ${tally.initialExpectation}`,
    keyQuestions: tally.questionsForLeader,
  };

  store.appendGovernanceEvent({
    type: 'conference-opened',
    taskSeq,
    conferenceId,
    disputeId: strikeInfo.disputeId,
    eventId: strikeInfo.eventId ?? null,
    behaviorId: strikeInfo.behaviorId ?? null,
    strike: strikeInfo.strikeCount,
    stageId: stageId ?? null,
    stageHashAtOpen,
    targets: strikeInfo.targets,
    profile,
    tools,
    interfaces,
    initialExpectation: tally.initialExpectation,
    opening,
    pausedMemberIds,
  });
  store.appendWorkflowEvent({
    type: 'governance-conference-opened',
    taskSeq,
    conferenceId,
    disputeId: strikeInfo.disputeId,
    strike: strikeInfo.strikeCount,
    pausedMemberIds,
  });

  notifyAgent(rt, leaderAgent, [
    `[LeaderTeam Formal 2-Party Conference Opened — ${conferenceId}]`,
    'Participants: Independent Arbiter + Leader ONLY (Reviewers are excluded; all active execution models have checkpointed and paused; `team_dispatch`, `send_message`, and `team_direct_exec` are suspended until this conference concludes).',
    `Dispute Chain ID: ${strikeInfo.disputeId} (Event: ${strikeInfo.eventId ?? 'n/a'}, Strike #${strikeInfo.strikeCount}, Targets: ${strikeInfo.targets.join(', ') || stageId || 'task'})`,
    `Arbiter Opening Statement: ${opening.openingStatement}`,
    `Questions for Leader: ${(opening.keyQuestions ?? []).join(' | ')}`,
    `Respond now using \`team_conference(action="respond", conference_id="${conferenceId}", explanation="...", new_evidence_files=[...], proposed_alternative="...")\`. You may use read-only tools (\`read\`, \`glob\`, \`grep\`) to cite exact workspace files.`,
  ].join('\n'));

  return { status: 'conference_opened', conferenceId, disputeId: strikeInfo.disputeId, opening, pausedMemberIds };
}

/** Handle Leader's dialogue turn in Stage 3 Formal 2-Party Conference (`team_conference` tool). */
export async function respondInFormalConference({
  ctx,
  rt,
  store,
  actor,
  leaderAgent,
  leaderModel,
  taskSeq,
  conferenceId,
  explanation,
  newEvidenceFiles = [],
  proposedAlternative = '',
  userTask = '',
  signal,
}) {
  const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
  const conf = gov.activeConference;
  if (!conf) {
    throw new Error('no formal Arbiter–Leader conference is currently active');
  }
  if (conferenceId && conferenceId !== conf.conferenceId) {
    throw new Error(`active conference is "${conf.conferenceId}", not "${conferenceId}"`);
  }

  const evidenceExcerpts = loadBoundedWorkspaceExcerpts(actor.cwd, newEvidenceFiles, 24000);
  const leaderTurn = {
    speaker: 'leader',
    text: truncate(String(explanation ?? '').trim(), 6000),
    proposedAlternative: typeof proposedAlternative === 'string' && proposedAlternative.trim()
      ? truncate(proposedAlternative.trim(), 3000)
      : '',
    newEvidenceFiles: Array.isArray(newEvidenceFiles) ? newEvidenceFiles.slice(0, 12) : [],
    loadedEvidencePreview: evidenceExcerpts,
  };
  store.appendGovernanceEvent({
    type: 'conference-turn',
    taskSeq,
    conferenceId: conf.conferenceId,
    turn: leaderTurn,
  });

  const updatedTurns = [...conf.turns, leaderTurn];
  const leaderTurnsCount = updatedTurns.filter(t => t.speaker === 'leader').length;
  const maxDialogue = rt.config.governance?.maxConferenceDialogueTurns ?? 2;
  const remainingDialogueTurns = Math.max(0, maxDialogue - leaderTurnsCount);

  const delibPayload = {
    conference_id: conf.conferenceId,
    dispute_id: conf.disputeId,
    event_id: conf.eventId ?? null,
    strike: conf.strike,
    targets: conf.targets,
    user_task: truncate(String(userTask ?? ''), 3000),
    initial_expectation: conf.initialExpectation,
    arbiter_opening: conf.opening,
    conference_transcript_so_far: updatedTurns,
    remaining_dialogue_turns: remainingDialogueTurns,
  };

  const delibRes = await callGovernanceRole(
    rt,
    actor.teamId,
    taskSeq,
    'arbiter',
    leaderModel,
    CONFERENCE_DELIBERATION_SYSTEM,
    JSON.stringify(delibPayload),
    raw => parseConferenceDeliberation(raw, {
      forceConclude: remainingDialogueTurns === 0,
      validStageIds: [...frontierState(store, taskSeq).stages.keys()],
      fallbackTargets: [conf.stageId, ...(conf.targets ?? [])].filter(Boolean),
    }),
    'conference-deliberation',
    signal,
  );

  const parsed = delibRes.ok
    ? delibRes.result
    : {
        status: 'concluded',
        decision: leaderTurn.proposedAlternative ? 'adopt_alternative' : 'overturn_objection',
        rulingSummary: leaderTurn.proposedAlternative
          ? `Adopted Leader's proposed engineering alternative: ${truncate(leaderTurn.proposedAlternative, 300)}`
          : 'Accepted Leader\'s workspace evidence; proceeding with execution.',
        deltaFromInitialExpectation: 'Arbiter unavailable after Leader presentation; adopted non-blocking resolution from presented facts.',
        bindingDirectives: leaderTurn.proposedAlternative ? [truncate(leaderTurn.proposedAlternative, 400)] : [],
        blockedTargets: [],
        memberResumePolicy: 'resume_all',
      };

  if (parsed.status === 'continue_dialogue' && remainingDialogueTurns > 0) {
    const arbTurn = { speaker: 'arbiter', text: parsed.followUpQuestion };
    store.appendGovernanceEvent({
      type: 'conference-turn',
      taskSeq,
      conferenceId: conf.conferenceId,
      turn: arbTurn,
    });
    return {
      status: 'continue_dialogue',
      conference_id: conf.conferenceId,
      dispute_id: conf.disputeId,
      arbiter_question: parsed.followUpQuestion,
      remaining_dialogue_turns: remainingDialogueTurns,
      instruction: `Call team_conference(action="respond", conference_id="${conf.conferenceId}", explanation=...) to answer the Arbiter's follow-up question.`,
    };
  }

  // Concluded! Build mandatory 5-part Stage 4 Return Packet, resume paused members with their checkpoints, and trigger Stage 4 Re-Review!
  const stage4Packet = buildStage4ReviewPacket({
    conferenceId: conf.conferenceId,
    disputeId: conf.disputeId,
    eventId: conf.eventId ?? null,
    behaviorId: conf.behaviorId ?? null,
    strike: conf.strike,
    initialExpectation: conf.initialExpectation,
    opening: conf.opening,
    turns: updatedTurns,
    ruling: parsed,
  });

  const stageHashAtRuling = conf.stageId
    ? (frontierState(store, taskSeq).stages.get(conf.stageId)?.hash ?? conf.stageHashAtOpen ?? null)
    : null;

  store.appendGovernanceEvent({
    type: 'conference-concluded',
    taskSeq,
    conferenceId: conf.conferenceId,
    disputeId: conf.disputeId,
    stageId: conf.stageId ?? null,
    stageHashAtRuling,
    targets: conf.targets ?? [],
    ruling: parsed,
    stage4Packet,
  });
  store.appendWorkflowEvent({
    type: 'governance-conference-concluded',
    taskSeq,
    conferenceId: conf.conferenceId,
    disputeId: conf.disputeId,
    decision: parsed.decision,
    deltaFromInitialExpectation: parsed.deltaFromInitialExpectation,
  });

  const resumedMembers = await resumePausedMembersAfterConference({
    ctx,
    rt,
    store,
    leaderAgent,
    taskSeq,
    conference: conf,
    ruling: parsed,
  });

  // Stage 4 (§4 阶段四): Return complete 5-part packet to Review Zone strictly linked to `conf.disputeId`!
  queueAsyncSupervision({
    ctx,
    rt,
    store,
    actor,
    leaderAgent,
    leaderModel,
    taskSeq,
    phaseKind: 'execution',
    stageId: conf.stageId,
    targets: conf.targets,
    profile: conf.profile ?? null,
    tools: conf.tools ?? [],
    interfaces: conf.interfaces ?? [],
    summary: `Stage 4 Post-Conference Re-Review (${conf.conferenceId})`,
    proposal: parsed.rulingSummary,
    userTask,
    parentDisputeId: conf.disputeId,
    postConferencePacket: stage4Packet,
  });

  return {
    status: 'concluded',
    conference_id: conf.conferenceId,
    dispute_id: conf.disputeId,
    decision: parsed.decision,
    ruling_summary: parsed.rulingSummary,
    delta_from_initial_expectation: parsed.deltaFromInitialExpectation,
    binding_directives: parsed.bindingDirectives,
    blocked_targets: parsed.blockedTargets,
    resumed_members: resumedMembers,
    stage4_returned_to_reviewers: true,
  };
}

function formatRoleError(res, fallbackCode) {
  if (!res || res.ok) return null;
  const err = res.error;
  if (!err) return fallbackCode;
  if (typeof err === 'string') return err;
  return [err.kind, err.code, err.message].filter(Boolean).join(': ') || fallbackCode;
}

function seedSupervisionRuntimeFromStore(base, store, taskSeq) {
  let events;
  try { events = store.governanceEvents(); } catch { return; }
  for (const ev of events) {
    if ((ev.taskSeq ?? 1) !== taskSeq) continue;
    if (ev.type === 'supervision-completed' && ev.dedupeKey) {
      base.supervisedDigests.add(ev.dedupeKey);
      base.partialSupervisionOpinions.delete(ev.dedupeKey);
    } else if (ev.type === 'supervision-deferred' && ev.dedupeKey && !base.supervisedDigests.has(ev.dedupeKey)) {
      const prev = base.partialSupervisionOpinions.get(ev.dedupeKey);
      const opinionA = ev.opinionA ?? prev?.opinionA ?? null;
      const opinionB = ev.opinionB ?? prev?.opinionB ?? null;
      if (opinionA || opinionB) {
        base.partialSupervisionOpinions.set(ev.dedupeKey, { opinionA, opinionB });
      }
    }
  }
}

/**
 * Queue non-blocking Stage 1 Async Dual Supervision (or Stage 4 Post-Conference Re-Review).
 * Never blocks Leader tool execution; tracks background promise on `baseRuntime(rt).governanceJobs`.
 * CRITICAL (G6): Never converts a failed reviewer call into a synthetic `endorse`, and never marks
 * a supervision settled until BOTH Reviewer A and Reviewer B return valid parsed opinions.
 */
export function queueAsyncSupervision({
  ctx,
  rt,
  store,
  actor,
  leaderAgent,
  leaderModel = null,
  taskSeq = 1,
  phaseKind = 'execution',
  stageId = null,
  stageHash = null,
  targets = [],
  profile = null,
  tools = [],
  interfaces = [],
  goal = '',
  method = '',
  summary = '',
  proposal = '',
  evidence = '',
  evidenceFiles = [],
  userTask = '',
  parentDisputeId = null,
  postConferencePacket = null,
}) {
  if (!rt || rt.planningDisposed || !isAutonomousGovernance(rt.config)) return null;
  if (rt.config.plugins?.consensus === false) return null;

  const base = baseRuntime(rt);
  base.governanceJobs ??= new Map();
  base.supervisedDigests ??= new Set();
  base.inFlightSupervisionKeys ??= new Set();
  base.partialSupervisionOpinions ??= new Map();
  seedSupervisionRuntimeFromStore(base, store, taskSeq);

  const normTargets = normalizeDisputeTargets(targets);
  const targetFileHashes = collectTargetFileHashes(actor.cwd, normTargets, rt.config.paths?.protectedDirs);
  const snapshotDigest = computeActualBehaviorDigest({
    phaseKind,
    targets: normTargets,
    profile,
    tools,
    interfaces,
    goal: goal || summary,
    method,
    proposal,
    targetFileHashes,
  });

  const dedupeIdentity = (stageId && stageHash && !postConferencePacket)
    ? `stage:${stageId}:${stageHash}:${JSON.stringify(targetFileHashes)}`
    : snapshotDigest;
  const dedupeKey = `${store.teamId}:${taskSeq}:${phaseKind}:${dedupeIdentity}:${postConferencePacket?.conference_id ?? 'initial'}`;
  if (base.supervisedDigests.has(dedupeKey)) {
    return { queued: false, deduplicated: true, status: 'already_completed', behaviorDigest: snapshotDigest };
  }
  if (base.inFlightSupervisionKeys.has(dedupeKey)) {
    const existingJob = [...base.governanceJobs.values()].find(j => j.dedupeKey === dedupeKey);
    return {
      queued: false,
      inFlight: true,
      supervisionId: existingJob?.supervisionId ?? null,
      behaviorDigest: snapshotDigest,
      promise: existingJob?.promise ?? null,
    };
  }
  base.inFlightSupervisionKeys.add(dedupeKey);

  const supervisionId = `sup-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const retrySpec = {
    phaseKind,
    stageId,
    stageHash,
    targets: normTargets,
    profile,
    tools,
    interfaces,
    goal,
    method,
    summary,
    proposal,
    evidence,
    evidenceFiles,
    userTask,
    parentDisputeId,
    postConferencePacket,
  };

  const jobPromise = (async () => {
    try {
      store.appendGovernanceEvent({
        type: 'supervision-started',
        taskSeq,
        supervisionId,
        dedupeKey,
        phaseKind,
        stageId,
        targets: normTargets,
        snapshotDigest,
        isStage4ReReview: Boolean(postConferencePacket),
      });

      const preGov = replayGovernanceState(store.governanceEvents(), taskSeq);
      const relevantDirectives = !postConferencePacket
        ? preGov.activeDirectives.filter(dir =>
            phaseKind === 'delivery'
            || (stageId && dir.stageId === stageId)
            || (normTargets.length > 0 && dir.targets?.length > 0 && anyGlobOverlaps(normTargets, normalizeDisputeTargets(dir.targets))),
          )
        : [];

      const fileExcerpts = loadBoundedWorkspaceExcerpts(
        actor.cwd,
        [...evidenceFiles, ...Object.keys(targetFileHashes).slice(0, 6)],
        24000,
      );

      const reviewerPayload = {
        supervision_id: supervisionId,
        phase_kind: phaseKind,
        stage_id: stageId,
        targets: normTargets,
        user_task: truncate(String(userTask ?? ''), 3500),
        summary: truncate(String(summary ?? ''), 800),
        proposal: truncate(String(proposal ?? ''), 12000),
        ...(evidence ? { evidence: truncate(String(evidence), 8000) } : {}),
        workspace_excerpts: fileExcerpts,
        ...(relevantDirectives.length > 0 ? {
          active_arbiter_directives: relevantDirectives.map(d => ({
            conference_id: d.conferenceId,
            dispute_id: d.disputeId,
            decision: d.decision,
            binding_directives: d.directives,
          })),
        } : {}),
        ...(postConferencePacket ? { stage4_conference_return_packet: postConferencePacket } : {}),
      };
      const userPrompt = buildSupervisionReviewerUser(reviewerPayload);
      const purpose = postConferencePacket ? 'stage4-re-review' : 'async-supervision';

      const cachedPartial = base.partialSupervisionOpinions.get(dedupeKey) ?? null;
      const [resA, resB] = await Promise.all([
        cachedPartial?.opinionA
          ? Promise.resolve({ ok: true, opinion: cachedPartial.opinionA, cached: true })
          : callGovernanceRole(rt, actor.teamId, taskSeq, 'discussA', leaderModel, SUPERVISION_REVIEWER_SYSTEM, userPrompt, parseSupervisionOpinion, purpose, controller.signal),
        cachedPartial?.opinionB
          ? Promise.resolve({ ok: true, opinion: cachedPartial.opinionB, cached: true })
          : callGovernanceRole(rt, actor.teamId, taskSeq, 'discussB', leaderModel, SUPERVISION_REVIEWER_SYSTEM, userPrompt, parseSupervisionOpinion, purpose, controller.signal),
      ]);

      if (controller.signal.aborted) return null;

      const opinionA = resA?.ok ? resA.opinion : null;
      const opinionB = resB?.ok ? resB.opinion : null;
      if (!opinionA || !opinionB) {
        if (opinionA || opinionB) {
          base.partialSupervisionOpinions.set(dedupeKey, { opinionA, opinionB });
        }
        const errorA = opinionA ? null : formatRoleError(resA, 'reviewer_a_unavailable');
        const errorB = opinionB ? null : formatRoleError(resB, 'reviewer_b_unavailable');
        store.appendGovernanceEvent({
          type: 'supervision-deferred',
          taskSeq,
          supervisionId,
          dedupeKey,
          phaseKind,
          stageId,
          targetLabel: stageId ?? (normTargets.join(',') || phaseKind),
          targets: normTargets,
          disputeId: parentDisputeId ?? null,
          isStage4ReReview: Boolean(postConferencePacket),
          hasValidOpinionA: Boolean(opinionA),
          hasValidOpinionB: Boolean(opinionB),
          ...(opinionA ? { opinionA } : {}),
          ...(opinionB ? { opinionB } : {}),
          errorA,
          errorB,
          retrySpec,
        });
        return {
          status: 'deferred',
          completed: false,
          supervisionId,
          dedupeKey,
          missingReviewers: [!opinionA ? 'discussA' : null, !opinionB ? 'discussB' : null].filter(Boolean),
          errorA,
          errorB,
        };
      }

      base.supervisedDigests.add(dedupeKey);
      base.partialSupervisionOpinions.delete(dedupeKey);
      const stage1 = evaluateStage1Supervision(opinionA, opinionB);

      store.appendGovernanceEvent({
        type: 'supervision-completed',
        taskSeq,
        supervisionId,
        dedupeKey,
        phaseKind,
        stageId,
        targetLabel: stageId ?? (normTargets.join(',') || phaseKind),
        targets: normTargets,
        disputeId: parentDisputeId ?? null,
        isStage4ReReview: Boolean(postConferencePacket),
        opinionA,
        opinionB,
        unanimousObjection: stage1.unanimousObjection,
        advisoryOnly: stage1.advisoryOnly,
        advisoryConcerns: stage1.advisoryConcerns,
        advisorySuggestions: stage1.advisorySuggestions,
        directivesVerified: stage1.directivesVerified,
      });

      if (!stage1.unanimousObjection) {
        // §二: Mark active Arbiter directives satisfied ONLY when post-conference remediation execution ran AND supervision verified them!
        for (const dir of relevantDirectives) {
          const rem = hasPostConferenceRemediationEvidence(store, taskSeq, dir);
          const verifiedByReviewers = stage1.directivesVerified
            || (phaseKind === 'delivery' && opinionA.stance === 'endorse' && opinionB.stance === 'endorse' && resA.ok && resB.ok);
          if (rem.hasExecution && verifiedByReviewers) {
            store.appendGovernanceEvent({
              type: 'arbiter-directive-satisfied',
              taskSeq,
              disputeId: dir.disputeId,
              conferenceId: dir.conferenceId,
              verifiedBy: 'post-remediation-supervision',
              supervisionId,
            });
          }
        }
        return { status: 'advisory', supervisionId, stage1 };
      }

      // Unanimous objection by BOTH Reviewer A and Reviewer B!
      const latestGov = replayGovernanceState(store.governanceEvents(), taskSeq);
      const reviewerTargets = normalizeDisputeTargets([...(opinionA.targetPaths ?? []), ...(opinionB.targetPaths ?? [])]);
      const effectiveTargets = normTargets.length > 0 ? normTargets : reviewerTargets;
      const finalHashes = collectTargetFileHashes(actor.cwd, effectiveTargets, rt.config.paths?.protectedDirs);

      const priorMatch = latestGov.disputes.findLast(
        d => !d.supersededByEpoch && (
          (parentDisputeId && d.disputeId === parentDisputeId) ||
          ((d.taskSeq ?? 1) === taskSeq && (d.phaseKind ?? 'execution') === (phaseKind === 'delivery' ? 'delivery' : 'execution'))
        ),
      );
      const executionRecords = collectExecutionRecordsSince(
        store,
        taskSeq,
        priorMatch?.lastStrikeAt ?? null,
        effectiveTargets,
      );

      const behaviorIdentity = computeBehaviorIdentity({
        phaseKind,
        goal: goal || summary,
        method,
        interfaces,
        profile,
        tools,
        decisionSummary: proposal,
      });

      const strikeCandidate = {
        taskSeq,
        phaseKind,
        targets: effectiveTargets,
        reviewerTargets,
        behaviorIdentity,
        goal: goal || summary,
        method,
        interfaces,
        profile,
        tools,
        proposal,
        targetFileHashes: finalHashes,
        executionRecords,
        parentDisputeId,
        isStage4ReReview: Boolean(postConferencePacket),
      };

      const strikeInfo = {
        ...resolveDisputeStrike(latestGov.disputes, strikeCandidate, rt.config.governance),
        profile,
        tools,
        interfaces,
      };

      // Prevent concurrent in-flight Stage 1 supervisions from double-counting strikes or opening duplicate parallel conferences
      // before the current strike's caucus/conference has even concluded!
      if (!postConferencePacket) {
        const matchedExisting = strikeInfo.matchedChain
          ?? latestGov.disputes.findLast(d => !d.supersededByEpoch && d.disputeId === strikeInfo.disputeId);
        const strikeStillInFlight = Boolean(
          matchedExisting && (
            matchedExisting.status === 'in_caucus'
            || matchedExisting.status === 'in_conference'
            || latestGov.pausingConference?.disputeId === matchedExisting.disputeId
            || latestGov.activeConference?.disputeId === matchedExisting.disputeId
            || latestGov.activeHumanEscalation?.disputeId === matchedExisting.disputeId
          ),
        );
        if (strikeStillInFlight) {
          store.appendGovernanceEvent({
            type: 'supervision-coalesced-into-active-dispute',
            taskSeq,
            supervisionId,
            disputeId: matchedExisting.disputeId,
            eventId: matchedExisting.eventId ?? strikeInfo.eventId,
          });
          return { status: 'coalesced_into_active_dispute', disputeId: matchedExisting.disputeId, supervisionId };
        }
      }

      if (!strikeInfo.needsContinuityVerification) {
        store.appendGovernanceEvent({
          type: 'dispute-strike-recorded',
          taskSeq,
          supervisionId,
          eventId: strikeInfo.eventId,
          anchorTargets: strikeInfo.anchorTargets,
          behaviorId: strikeInfo.behaviorId,
          behaviorSummary: strikeInfo.behaviorSummary,
          disputeChainId: strikeInfo.disputeChainId,
          disputeId: strikeInfo.disputeId,
          priorEpochDisputeId: strikeInfo.priorEpochDisputeId,
          priorChainId: strikeInfo.priorChainId,
          epoch: strikeInfo.epoch,
          chainSeq: strikeInfo.chainSeq,
          strikeCount: strikeInfo.strikeCount,
          action: strikeInfo.action,
          phaseKind: strikeInfo.phaseKind,
          targets: strikeInfo.targets,
          profile: profile ?? null,
          tools: tools ?? [],
          interfaces: interfaces ?? [],
          evidenceSnapshot: strikeInfo.evidenceSnapshot,
          summaryA: opinionA.summary,
          summaryB: opinionB.summary,
        });

        if (strikeInfo.action === 'escalate_human') {
          return await triggerHumanDisputeEscalation({
            ctx,
            rt,
            store,
            actor,
            leaderAgent,
            taskSeq,
            strikeInfo,
            stageId,
            opinionA,
            opinionB,
            signal: controller.signal,
          });
        }
      }

      return await runThreePartyCaucus({
        ctx,
        rt,
        store,
        actor,
        leaderAgent,
        leaderModel,
        taskSeq,
        strikeInfo,
        strikeCandidate,
        stageId,
        proposal,
        opinionA,
        opinionB,
        userTask,
        supervisionId,
        signal: controller.signal,
      });
    } catch (err) {
      rt.logger?.warn?.(`leaderteam: async supervision error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      base.inFlightSupervisionKeys.delete(dedupeKey);
      base.governanceJobs.delete(supervisionId);
    }
  })();

  base.governanceJobs.set(supervisionId, { supervisionId, dedupeKey, teamId: store.teamId, taskSeq, controller, promise: jobPromise });
  return { queued: true, supervisionId, dedupeKey, behaviorDigest: snapshotDigest, promise: jobPromise };
}

/** Re-queue any deferred dual supervisions for `taskSeq` that have not yet obtained two valid reviewer opinions. */
export function retryDeferredSupervisions({
  ctx,
  rt,
  store,
  actor,
  leaderAgent,
  leaderModel = null,
  taskSeq = 1,
}) {
  if (!rt || rt.planningDisposed || !isAutonomousGovernance(rt.config)) return [];
  if (rt.config.plugins?.consensus === false || !actor?.cwd) return [];
  const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
  if (!gov.pendingSupervisions?.length) return [];
  const jobs = [];
  for (const pending of gov.pendingSupervisions) {
    if (!pending.retrySpec) continue;
    const job = queueAsyncSupervision({
      ctx,
      rt,
      store,
      actor,
      leaderAgent,
      leaderModel,
      taskSeq,
      ...pending.retrySpec,
    });
    if (job?.promise) jobs.push(job);
  }
  return jobs;
}

/** Await any in-flight async supervision/caucus jobs for a team (used at delivery boundary). */
export async function awaitTeamGovernanceJobs(rt, teamId, timeoutMs = 60000) {
  const base = baseRuntime(rt);
  const jobs = [...(base.governanceJobs?.values() ?? [])].filter(j => j.teamId === teamId && j.promise);
  if (jobs.length === 0) return;
  let timer;
  await Promise.race([
    Promise.allSettled(jobs.map(j => j.promise)),
    new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Resolve an active Strike 3 Human Escalation when the User replies in the Leader session (§5 & §6.3). */
export async function resolveHumanEscalationOnUserTurn({ ctx, rt, store, leaderAgent, taskSeq, userText }) {
  const allEvents = store.governanceEvents();
  const resolvedIds = new Set(allEvents.filter(e => e.type === 'human-escalation-resolved').map(e => e.escalationId));
  const openEvent = allEvents.findLast(e => e.type === 'human-escalation-opened' && !resolvedIds.has(e.escalationId));
  if (!openEvent) return false;
  const escTaskSeq = openEvent.taskSeq ?? taskSeq;
  store.appendGovernanceEvent({
    type: 'human-escalation-resolved',
    taskSeq: escTaskSeq,
    resolvedInTaskSeq: taskSeq,
    escalationId: openEvent.escalationId,
    disputeId: openEvent.disputeId,
    userResolutionPreview: truncate(String(userText ?? ''), 600),
    note: 'User governance decision recorded; Safety Gate hard rules remain strictly non-waivable (§6.3).',
  });
  store.appendWorkflowEvent({
    type: 'human-dispute-resolved',
    taskSeq,
    escalationId: openEvent.escalationId,
    disputeId: openEvent.disputeId,
  });

  await resumePausedMembersAfterConference({
    ctx,
    rt,
    store,
    leaderAgent,
    taskSeq: escTaskSeq,
    conference: { conferenceId: openEvent.escalationId, stageId: openEvent.stageId, targets: openEvent.targets },
    ruling: {
      decision: 'adopt_alternative',
      rulingSummary: `Resolved by User decision: ${truncate(String(userText ?? ''), 300)}`,
      bindingDirectives: [],
      blockedTargets: [],
      memberResumePolicy: 'resume_all',
    },
  });
  return true;
}

/** Concise governance snapshot injected into Leader's live runtime context. */
export function formatLeaderGovernanceContext(store, taskSeq) {
  const gov = replayGovernanceState(store.governanceEvents(), taskSeq);
  const lines = [`LeaderTeam autonomous governance state: phase=${gov.phase}`];
  if (gov.pausingConference) {
    lines.push(`- PAUSING FOR CONFERENCE "${gov.pausingConference.conferenceId}" (dispute=${gov.pausingConference.disputeId}): Waiting for active execution models to checkpoint and pause before Stage 3 opens; dispatches and team_direct_exec are suspended.`);
  }
  if (gov.activeConference) {
    lines.push(`- ACTIVE FORMAL CONFERENCE "${gov.activeConference.conferenceId}" (dispute=${gov.activeConference.disputeId}, strike=#${gov.activeConference.strike}): All execution dispatches and team_direct_exec are suspended. Respond via team_conference(action="respond", conference_id="${gov.activeConference.conferenceId}", ...).`);
  }
  if (gov.activeHumanEscalation) {
    lines.push(`- HUMAN ESCALATION PENDING "${gov.activeHumanEscalation.escalationId}" (dispute=${gov.activeHumanEscalation.disputeId}, 3rd strike): All execution dispatches and team_direct_exec are paused. Declare team_status(stop_state="waiting_user") and present the dispute dossier to the user.`);
  }
  for (const d of gov.activeDirectives) {
    lines.push(`- Active Arbiter directive (${d.conferenceId}, ${d.decision} — verified completion required): ${d.directives.join('; ')}`);
  }
  if (gov.pendingSupervisions?.length > 0) {
    const labels = gov.pendingSupervisions.slice(-3).map(p => `${p.targetLabel} (missing: ${[!p.hasValidOpinionA ? 'discussA' : null, !p.hasValidOpinionB ? 'discussB' : null].filter(Boolean).join(',') || 'reviewer'})`);
    lines.push(`- Pending dual supervision (${gov.pendingSupervisions.length} awaiting two valid reviewer opinions before final delivery): ${labels.join(' | ')}`);
  }
  if (gov.advisoryNotes.length > 0) {
    const latest = gov.advisoryNotes.slice(-2).map(n => `[${n.targetLabel}] ${(n.suggestions.length ? n.suggestions : n.concerns).slice(0, 2).join('; ')}`);
    lines.push(`- Non-blocking reviewer supervision notes (advisory only): ${latest.join(' | ')}`);
  }
  return lines.join('\n');
}
