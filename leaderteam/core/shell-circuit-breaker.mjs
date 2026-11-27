// SPDX-License-Identifier: Apache-2.0
// Deterministic per-team circuit breaker for host shell process-initialization failures
// (`0xC0000142` / `STATUS_DLL_INIT_FAILED` / uint32 `3221225794` / int32 `-1073741502`).
// Pure module: zero external dependencies and zero DSH host imports.

const BASE_RUNTIME = Symbol.for('leaderteam.runtime.base');

export const DEFAULT_SHELL_TOOLS = Object.freeze(['pwsh', 'bash']);
export const DEFAULT_SHELL_INIT_FAILURE_THRESHOLD = 2;

export const WIN_STATUS_DLL_INIT_FAILED_UINT32 = 0xC0000142; // 3221225794
export const WIN_STATUS_DLL_INIT_FAILED_INT32 = -1073741502; // (0xC0000142 | 0)

export const HOST_SHELL_CHANNEL_BROKEN_RULE = 'host-shell-channel-broken';
export const HOST_SHELL_CHANNEL_BROKEN_BY = `rule:${HOST_SHELL_CHANNEL_BROKEN_RULE}`;
export const HOST_SHELL_CHANNEL_UNAVAILABLE_REASON =
  '[HOST_SHELL_CHANNEL_UNAVAILABLE] Host shell process initialization failed repeatedly (0xC0000142 / STATUS_DLL_INIT_FAILED). ' +
  'This is a host environment/window-station fault, NOT a command syntax or workspace path issue. ' +
  'Do NOT retry pwsh/bash, do NOT probe alternative workdirs, and do NOT dispatch direct_exec shell checks; ' +
  'complete remaining static file work or report blocked once via team_status.';

const HEX_OR_SYMBOL_RE = /\b0xc0000142\b|\bSTATUS_DLL_INIT_FAILED\b/i;
const EXIT_CODE_TEXT_RE = /(?:\[\s*exit\s+code:\s*|(?:\bexit(?:\s+code|ed\s+with(?:\s+code)?|Code)?|\bstatus(?:\s+code)?|\bcode)\s*[:=]?\s*|^\s*)(?:3221225794|-1073741502)(?!\d)/im;
const CLEAN_RENDERED_EXIT_ZERO_RE = /\[\s*exit\s+code:\s*0\s*\]\s*$/i;
const MAX_TRACKED_CALL_IDS = 256;

function toShellToolSet(shellTools) {
  if (shellTools instanceof Set) return shellTools;
  if (Array.isArray(shellTools) && shellTools.length > 0) return new Set(shellTools);
  return new Set(DEFAULT_SHELL_TOOLS);
}

export function isShellInitFailureExitCode(code) {
  if (typeof code !== 'number' || !Number.isInteger(code)) return false;
  if (code < -2147483648 || code > 4294967295) return false;
  return (code >>> 0) === WIN_STATUS_DLL_INIT_FAILED_UINT32;
}

function extractExplicitExitCode(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    obj.exitCode,
    obj.value?.exitCode,
    obj.meta?.exitCode,
    obj.error?.exitCode,
    obj.details?.exitCode,
    typeof obj.status === 'number' ? obj.status : undefined,
    typeof obj.code === 'number' ? obj.code : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

function extractStreamText(stream) {
  if (typeof stream === 'string') return stream;
  if (stream && typeof stream === 'object' && typeof stream.text === 'string') return stream.text;
  return '';
}

function collectDiagnosticTexts(resultOrError, { includeStdout = true } = {}) {
  if (typeof resultOrError === 'string') return [resultOrError];
  if (resultOrError instanceof Error) {
    const parts = [resultOrError.message];
    if (resultOrError.cause instanceof Error) parts.push(resultOrError.cause.message);
    else if (typeof resultOrError.cause === 'string') parts.push(resultOrError.cause);
    return parts.filter(Boolean);
  }
  if (!resultOrError || typeof resultOrError !== 'object') return [];

  const parts = [];
  if (Array.isArray(resultOrError.content)) {
    for (const block of resultOrError.content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block.text === 'string') parts.push(block.text);
    }
  }
  for (const field of [
    resultOrError.result,
    resultOrError.text,
    resultOrError.output,
    resultOrError.detail,
    resultOrError.message,
    typeof resultOrError.error === 'string' ? resultOrError.error : resultOrError.error?.message,
    resultOrError.value?.output,
    resultOrError.value?.detail,
    extractStreamText(resultOrError.stderr),
    extractStreamText(resultOrError.value?.stderr),
  ]) {
    if (typeof field === 'string' && field.length > 0) parts.push(field);
  }

  if (includeStdout) {
    for (const outField of [
      extractStreamText(resultOrError.stdout),
      extractStreamText(resultOrError.value?.stdout),
    ]) {
      if (outField.length > 0) parts.push(outField);
    }
  }

  return parts;
}

export function isHostShellInitFailureResult(toolName, resultOrError, shellTools = DEFAULT_SHELL_TOOLS) {
  if (typeof toolName !== 'string' || !toolName) return false;
  const allowed = toShellToolSet(shellTools);
  if (!allowed.has(toolName)) return false;
  if (resultOrError === null || resultOrError === undefined) return false;

  const isError = Boolean(
    resultOrError instanceof Error
    || (typeof resultOrError === 'object' && (resultOrError.isError === true || Boolean(resultOrError.error))),
  );

  const explicitExit = extractExplicitExitCode(resultOrError);
  if (explicitExit !== null) {
    if (isShellInitFailureExitCode(explicitExit)) return true;
    if (!isError && explicitExit === 0) return false;
  }

  const includeStdout = explicitExit === null || isError;
  const texts = collectDiagnosticTexts(resultOrError, { includeStdout });
  for (const text of texts) {
    if (!isError && CLEAN_RENDERED_EXIT_ZERO_RE.test(text)) return false;
    if (HEX_OR_SYMBOL_RE.test(text)) return true;
    if (EXIT_CODE_TEXT_RE.test(text)) return true;
  }
  return false;
}

export class ShellChannelCircuitBreaker {
  constructor({
    threshold = DEFAULT_SHELL_INIT_FAILURE_THRESHOLD,
    shellTools = DEFAULT_SHELL_TOOLS,
  } = {}) {
    this.threshold = Number.isInteger(threshold) && threshold >= 1
      ? threshold
      : DEFAULT_SHELL_INIT_FAILURE_THRESHOLD;
    this.defaultShellTools = Object.freeze([...(shellTools ?? DEFAULT_SHELL_TOOLS)]);
    this.teams = new Map();
  }

  isShellTool(toolName, shellTools) {
    if (typeof toolName !== 'string' || !toolName) return false;
    return toShellToolSet(shellTools ?? this.defaultShellTools).has(toolName);
  }

  #ensureEntry(teamId) {
    let entry = this.teams.get(teamId);
    if (!entry) {
      entry = {
        teamId,
        failures: 0,
        tripped: false,
        trippedAtMs: null,
        lastFailureAtMs: null,
        seenCallIds: new Set(),
        actors: [],
      };
      this.teams.set(teamId, entry);
    }
    return entry;
  }

  getTeamState(teamId) {
    if (typeof teamId !== 'string' || !teamId) {
      return { teamId: null, failures: 0, tripped: false, trippedAtMs: null, lastFailureAtMs: null };
    }
    const entry = this.teams.get(teamId);
    if (!entry) {
      return { teamId, failures: 0, tripped: false, trippedAtMs: null, lastFailureAtMs: null };
    }
    return {
      teamId,
      failures: entry.failures,
      tripped: entry.tripped,
      trippedAtMs: entry.trippedAtMs,
      lastFailureAtMs: entry.lastFailureAtMs,
    };
  }

  isTripped(teamId) {
    if (typeof teamId !== 'string' || !teamId) return false;
    return Boolean(this.teams.get(teamId)?.tripped);
  }

  recordResult(teamId, toolName, resultOrError, {
    shellTools,
    callId = null,
    actorRole = null,
    nowMs = Date.now(),
  } = {}) {
    if (typeof teamId !== 'string' || !teamId) {
      return { matched: false, failures: 0, tripped: false, newlyTripped: false };
    }
    const matched = isHostShellInitFailureResult(toolName, resultOrError, shellTools ?? this.defaultShellTools);
    if (!matched) {
      const cur = this.teams.get(teamId);
      return {
        matched: false,
        failures: cur?.failures ?? 0,
        tripped: Boolean(cur?.tripped),
        newlyTripped: false,
      };
    }

    const entry = this.#ensureEntry(teamId);
    if (typeof callId === 'string' && callId.length > 0) {
      if (entry.seenCallIds.has(callId)) {
        return {
          matched: true,
          deduplicated: true,
          failures: entry.failures,
          tripped: entry.tripped,
          newlyTripped: false,
        };
      }
      if (entry.seenCallIds.size >= MAX_TRACKED_CALL_IDS) {
        const oldest = entry.seenCallIds.values().next().value;
        if (oldest !== undefined) entry.seenCallIds.delete(oldest);
      }
      entry.seenCallIds.add(callId);
    }

    entry.failures += 1;
    entry.lastFailureAtMs = nowMs;
    if (typeof actorRole === 'string' && actorRole && entry.actors.length < 16) {
      entry.actors.push(actorRole);
    }
    let newlyTripped = false;
    if (!entry.tripped && entry.failures >= this.threshold) {
      entry.tripped = true;
      entry.trippedAtMs = nowMs;
      newlyTripped = true;
    }
    return {
      matched: true,
      deduplicated: false,
      failures: entry.failures,
      tripped: entry.tripped,
      newlyTripped,
    };
  }

  checkGate(teamId, toolName, shellTools) {
    if (typeof teamId !== 'string' || !teamId) return undefined;
    if (!this.isShellTool(toolName, shellTools)) return undefined;
    if (!this.isTripped(teamId)) return undefined;
    return {
      rule: HOST_SHELL_CHANNEL_BROKEN_RULE,
      by: HOST_SHELL_CHANNEL_BROKEN_BY,
      reason: HOST_SHELL_CHANNEL_UNAVAILABLE_REASON,
    };
  }

  decide(teamId, toolName, shellTools) {
    const hit = this.checkGate(teamId, toolName, shellTools);
    if (!hit) return null;
    return {
      decision: 'deny',
      by: hit.by,
      reason: hit.reason,
    };
  }

  resetTeam(teamId) {
    if (typeof teamId !== 'string' || !teamId) return false;
    return this.teams.delete(teamId);
  }

  resetAll() {
    this.teams.clear();
  }
}

function unwrapBaseRuntime(rt) {
  if (!rt || typeof rt !== 'object') return null;
  return rt[BASE_RUNTIME] ?? rt;
}

export function ensureShellCircuitBreaker(rt, options) {
  const base = unwrapBaseRuntime(rt);
  if (!base) return null;
  if (!(base.shellCircuitBreaker instanceof ShellChannelCircuitBreaker)) {
    base.shellCircuitBreaker = new ShellChannelCircuitBreaker(options);
  }
  return base.shellCircuitBreaker;
}

export function recordShellToolResultForTeam(rt, teamId, toolName, resultOrError, options = {}) {
  const breaker = ensureShellCircuitBreaker(rt);
  if (!breaker) return { matched: false, failures: 0, tripped: false, newlyTripped: false };
  return breaker.recordResult(teamId, toolName, resultOrError, options);
}

export function checkShellCircuitBreakerForTeam(rt, teamId, toolName, shellTools) {
  const base = unwrapBaseRuntime(rt);
  const breaker = base?.shellCircuitBreaker;
  if (!(breaker instanceof ShellChannelCircuitBreaker)) return undefined;
  return breaker.checkGate(teamId, toolName, shellTools);
}

export function resetShellCircuitBreakerForTeam(rt, teamId) {
  const base = unwrapBaseRuntime(rt);
  const breaker = base?.shellCircuitBreaker;
  if (!(breaker instanceof ShellChannelCircuitBreaker)) return false;
  return breaker.resetTeam(teamId);
}
