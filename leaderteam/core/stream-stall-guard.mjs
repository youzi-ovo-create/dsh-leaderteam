// SPDX-License-Identifier: Apache-2.0
// Deterministic subagent LLM streaming stall watchdog & DP-08 pre-side-effect fallback guard.
// Pure Node.js ESM, zero external dependencies, zero proprietary symbols.

import { quotaGate } from './models.mjs';

const POLICY_REFUSAL_CODES = new Set(['CONTENT_REFUSED', 'HTTP_403']);

function isPolicyRefusal({ kind = '', code = '', message = '', status = null } = {}) {
  if (kind === 'refusal' || kind === 'blocked') return true;
  if (code && POLICY_REFUSAL_CODES.has(code)) return true;
  if (status === 403) return true;
  if (code === 'PI_AI_ERROR' && typeof message === 'string' && /^403:\s/.test(message)) return true;
  if (/CONTENT_REFUSED|content[_\s-]*policy|content[_\s-]*filter/i.test(`${code} ${message}`)) return true;
  return false;
}

export const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 120_000;

/**
 * Resolve the ordered execution route chain `[primaryRoute, ...enabledFallbacks]` for a member dispatch.
 * Filters `cfg.team.executionFallbacks[primaryRoute]` to enabled routes in `cfg.team.executionPool`
 * (excluding disabled models/families and quota-exhausted routes when `quotaState` is supplied).
 */
export function resolveMemberExecutionRouteChain(cfg, primaryRoute, requestedEffort = 'none', { quotaState = null, now = new Date() } = {}) {
  if (!cfg || typeof primaryRoute !== 'string' || !primaryRoute) return [];
  const poolSet = new Set(cfg.team?.executionPool ?? []);
  const disabledModels = new Set(cfg.team?.disabledModels ?? []);
  const disabledFamilies = new Set(cfg.team?.disabledFamilies ?? []);
  const rawFallbacks = Array.isArray(cfg.team?.executionFallbacks?.[primaryRoute])
    ? cfg.team.executionFallbacks[primaryRoute]
    : [];

  const out = [];
  const seen = new Set();

  for (const candidateRoute of [primaryRoute, ...rawFallbacks]) {
    if (typeof candidateRoute !== 'string' || !candidateRoute || seen.has(candidateRoute)) continue;
    const spec = cfg.models?.[candidateRoute];
    if (!spec) continue;
    if (candidateRoute !== primaryRoute) {
      if (!poolSet.has(candidateRoute)) continue;
      if (disabledModels.has(candidateRoute)) continue;
      if (spec.family && disabledFamilies.has(spec.family)) continue;
      if (quotaState !== null && !quotaGate(cfg, quotaState, candidateRoute, now).allowed) continue;
    }
    seen.add(candidateRoute);
    const efforts = Array.isArray(spec.efforts) && spec.efforts.length > 0 ? spec.efforts : ['none'];
    const resolvedEffort = efforts.includes(requestedEffort)
      ? requestedEffort
      : (spec.defaultEffort && efforts.includes(spec.defaultEffort) ? spec.defaultEffort : efforts[0]);
    out.push({
      route: candidateRoute,
      effort: resolvedEffort,
      isFallback: candidateRoute !== primaryRoute,
    });
  }

  return out;
}

/**
 * Enforce DP-08 ("Pre-Side-Effect Fallback Invariant"):
 * Automatic fallback to an alternate execution model is ONLY permitted when ALL 5 classes
 * of tool/side-effect event sources are strictly 0:
 *   1. Session `tool/call` events
 *   2. Session `tool/result` events
 *   3. Assistant message `tool-call` / `toolCall` content blocks
 *   4. Safety Gate receipts (`gate.jsonl`) recorded for `childId`
 *   5. Recorded member execution progress / circuit-breaker completed tools
 */
export function inspectSubagentSideEffectSources({
  sessionEvents = [],
  gateReceipts = [],
  memberProgressCount = 0,
  circuitState = null,
  childId = null,
} = {}) {
  let toolCallEvents = 0;
  let toolResultEvents = 0;
  let assistantToolBlocks = 0;

  if (Array.isArray(sessionEvents)) {
    for (const ev of sessionEvents) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'tool/call') {
        toolCallEvents += 1;
      } else if (ev.type === 'tool/result') {
        toolResultEvents += 1;
      } else if (ev.type === 'assistant/message') {
        const blocks = ev.data?.message?.content ?? ev.data?.content ?? [];
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool-call' || b?.type === 'toolCall') {
              assistantToolBlocks += 1;
            }
          }
        }
      }
    }
  }

  let gateReceiptCount = 0;
  let allowedMutatingGateCount = 0;
  if (Array.isArray(gateReceipts) && childId) {
    for (const r of gateReceipts) {
      if (r?.agentId === childId) {
        gateReceiptCount += 1;
        if (r.decision === 'allow' && ['write', 'edit', 'pwsh', 'bash', 'job_kill'].includes(r.tool)) {
          allowedMutatingGateCount += 1;
        }
      }
    }
  }

  const circuitToolCount =
    (circuitState?.turnCompletedTools?.length ?? 0) +
    (circuitState?.activationCompletedTools?.length ?? 0);
  const progressCount = Math.max(0, Number(memberProgressCount) || 0) + circuitToolCount;
  const totalToolEvents =
    toolCallEvents +
    toolResultEvents +
    assistantToolBlocks +
    gateReceiptCount +
    progressCount;

  const hasMutatingSideEffects =
    (Number(memberProgressCount) || 0) > 0 || allowedMutatingGateCount > 0;

  return {
    canFallback: totalToolEvents === 0,
    totalToolEvents,
    hasMutatingSideEffects,
    sources: {
      toolCallEvents,
      toolResultEvents,
      assistantToolBlocks,
      gateReceiptCount,
      progressCount,
    },
  };
}

/**
 * Determine whether an LLM stream chunk frame carries non-empty model output
 * (ignoring empty keepalive frames so zero-byte / whitespace-only heartbeats cannot mask a hung stream).
 */
export function isMeaningfulAssistantStreamFrame(frame) {
  if (!frame || typeof frame !== 'object') return false;
  if (frame.type !== 'chunk') return false;
  const c = frame.chunk;
  if (typeof c === 'string') return c.length > 0;
  if (!c || typeof c !== 'object') return false;
  for (const k of ['text', 'delta', 'thinking', 'reasoning', 'content', 'arguments', 'partialJson', 'name']) {
    if (typeof c[k] === 'string' && c[k].length > 0) return true;
  }
  if (c.type && c.type !== 'ping' && c.type !== 'keepalive') return true;
  return false;
}

/**
 * Decide whether a pre-tool `turn/end` error is eligible for automatic `executionFallbacks` switching.
 * Content-policy refusals (`CONTENT_REFUSED`) must NEVER retry or switch models automatically.
 */
export function isRetryablePreToolMemberError({ errorKind = '', errorCode = '', errorMessage = '', status = null } = {}) {
  if (isPolicyRefusal({ kind: errorKind, code: errorCode, message: errorMessage, status })) return false;
  if (/INVALID_CREDENTIAL|MISSING_CREDENTIAL/i.test(`${errorCode} ${errorMessage}`)) return false;
  return true;
}
