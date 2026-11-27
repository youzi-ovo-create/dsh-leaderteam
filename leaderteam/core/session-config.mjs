// Session-scoped configuration overrides, safe-boundary staging, DSH host model auto-adoption,
// and strict User-vs-Agent principal authorization for LeaderTeam (Issue #4).
// Pure Node.js ESM, zero external dependencies, Apache-2.0.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LtError, FAMILIES } from './constants.mjs';
import { validateConfig } from './config.mjs';
import { writeFileAtomic } from './store.mjs';

const ROLE_KEYS = Object.freeze([
  'leader',
  'gate',
  'discussA',
  'discussB',
  'arbiter',
  'serialReviewer',
  'directExec',
]);

export const SESSION_CONFIG_FILENAME = 'session-config.json';

export const ALLOWED_USER_SOURCES = Object.freeze([
  'lt-public-v1',
  'panel-api',
  'lt-workbench',
  'dsh-host-picker',
  'model-config-ui',
  'onboarding',
  'cli',
  'test-user',
]);

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMergeConfig(base, over) {
  if (!isPlainObj(base) || !isPlainObj(over)) return over === undefined ? base : structuredClone(over);
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === undefined) continue;
    if (k === 'models' && isPlainObj(base.models) && isPlainObj(v)) {
      const mergedModels = { ...base.models };
      for (const [rk, rv] of Object.entries(v)) {
        if (rv === null) delete mergedModels[rk];
        else mergedModels[rk] = isPlainObj(mergedModels[rk]) && isPlainObj(rv) ? { ...mergedModels[rk], ...rv } : structuredClone(rv);
      }
      out.models = mergedModels;
      continue;
    }
    if (isPlainObj(v) && isPlainObj(base[k])) {
      out[k] = deepMergeConfig(base[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

function inferFamily(route = '', modelId = '') {
  const s = `${route} ${modelId}`.toLowerCase();
  const candidate = s.includes('claude')
    ? 'claude'
    : s.includes('gemini')
      ? 'gemini'
      : (s.includes('glm') || s.includes('chatglm') || s.includes('zhipu'))
        ? 'glm'
        : (s.includes('qwen') || s.includes('qwq') || s.includes('dashscope'))
          ? 'qwen'
          : s.includes('deepseek')
            ? 'deepseek'
            : (s.includes('gpt') || /\bo[134]\b/.test(s) || s.includes('codex'))
              ? 'gpt'
              : 'other';
  return FAMILIES.includes(candidate) ? candidate : 'other';
}

/**
 * Enforce strict separation between User-initiated configuration changes and Agent-initiated actions.
 * Agents (leader, members, direct_exec, or in-flight tool calls) are NEVER permitted to mutate
 * session or global configuration.
 */
export function assertUserConfigPrincipal(principal, { inAgentToolDispatch = false } = {}) {
  if (inAgentToolDispatch || principal?.kind === 'agent') {
    const err = new LtError(
      'AGENT_CONFIG_MUTATION_FORBIDDEN',
      '权限拒绝：Agent 执行体禁止自行修改全局或会话模型治理配置；仅允许用户主动操作修改。',
    );
    err.statusCode = 403;
    throw err;
  }
  if (!isPlainObj(principal) || principal.kind !== 'user') {
    const err = new LtError(
      'CONFIG_PRINCIPAL_REQUIRED',
      '缺少有效的用户操作凭据（principal.kind="user"），拒绝修改模型治理配置。',
    );
    err.statusCode = 403;
    throw err;
  }
  const src = String(principal.source || '').trim();
  if (!ALLOWED_USER_SOURCES.includes(src)) {
    const err = new LtError(
      'UNTRUSTED_CONFIG_SOURCE',
      `未受信任的配置修改来源 "${src}"，拒绝修改配置。`,
    );
    err.statusCode = 403;
    throw err;
  }
  return {
    kind: 'user',
    source: src,
    actorId: typeof principal.actorId === 'string' ? principal.actorId : 'local-user',
  };
}

function encodeSessionSegment(sessionId) {
  const raw = String(sessionId ?? '').trim();
  if (!raw || raw.includes('\0')) throw new LtError('BAD_SESSION_ID', 'invalid sessionId');
  if (/^[A-Za-z0-9._-]{1,96}$/.test(raw) && raw !== '.' && raw !== '..') {
    return raw;
  }
  const safePrefix = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'sess';
  const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${safePrefix}--${digest}`;
}

/**
 * Check whether a filesystem path targets LeaderTeam's protected global or session config / governance files,
 * used by Safety Gate so agents cannot bypass API checks by editing JSON files on disk.
 */
export function isProtectedLeaderTeamConfigPath(targetPath, { storageRoot = null, configPath = null } = {}) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
  const norm = path.resolve(targetPath).replace(/\\/g, '/').toLowerCase();
  if (configPath) {
    const exactCfg = path.resolve(configPath).replace(/\\/g, '/').toLowerCase();
    const cfgDir = path.dirname(exactCfg);
    if (
      norm === exactCfg ||
      norm === `${cfgDir}/leaderteam.local.json` ||
      norm === `${cfgDir}/governance-changes.jsonl`
    ) {
      return true;
    }
  }
  if (storageRoot) {
    const stRoot = path.resolve(storageRoot).replace(/\\/g, '/').toLowerCase();
    for (const sub of ['config', 'session-configs', 'session-modes', 'updater']) {
      const fullSub = `${stRoot}/${sub}`;
      if (norm === fullSub || norm.startsWith(`${fullSub}/`)) return true;
    }
    if (norm.startsWith(`${stRoot}/teams/`) && (
      norm.endsWith('/governance.json') ||
      norm.endsWith('/session-config.json')
    )) {
      return true;
    }
  }
  if (
    norm.endsWith('/leaderteam.config.json') ||
    norm.endsWith('/leaderteam.local.json') ||
    norm.endsWith('/session-config.json')
  ) {
    return true;
  }
  return false;
}

export function sessionConfigPath(storageRoot, sessionId) {
  if (!storageRoot || !sessionId) return null;
  const seg = encodeSessionSegment(sessionId);
  return path.join(storageRoot, 'session-configs', `${seg}.json`);
}

export function readSessionConfigRecord(storageRoot, sessionId, fsImpl = fs) {
  const file = sessionConfigPath(storageRoot, sessionId);
  const empty = {
    v: 1,
    sessionId,
    updatedAt: null,
    updatedBy: null,
    activePatch: {},
    pendingPatch: null,
    pendingMeta: null,
    audit: [],
  };
  if (!file || !fsImpl.existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!isPlainObj(parsed) || parsed.v !== 1) return empty;
    return {
      v: 1,
      sessionId: parsed.sessionId ?? sessionId,
      updatedAt: parsed.updatedAt ?? null,
      updatedBy: parsed.updatedBy ?? null,
      activePatch: isPlainObj(parsed.activePatch) ? parsed.activePatch : {},
      pendingPatch: isPlainObj(parsed.pendingPatch) ? parsed.pendingPatch : null,
      pendingMeta: isPlainObj(parsed.pendingMeta) ? parsed.pendingMeta : null,
      audit: Array.isArray(parsed.audit) ? parsed.audit.slice(-30) : [],
    };
  } catch {
    return empty;
  }
}

export function hasActiveSessionOverride(record) {
  if (!isPlainObj(record?.activePatch)) return false;
  const p = record.activePatch;
  return Boolean(
    (isPlainObj(p.models) && Object.keys(p.models).length > 0) ||
    (isPlainObj(p.roles) && Object.keys(p.roles).length > 0) ||
    (isPlainObj(p.team) && Object.keys(p.team).length > 0) ||
    (isPlainObj(p.quota) && Object.keys(p.quota).length > 0),
  );
}

export function hasPendingSessionOverride(record) {
  return isPlainObj(record?.pendingPatch) && Object.keys(record.pendingPatch).length > 0;
}

function stripDerived(cfg) {
  const copy = structuredClone(cfg);
  delete copy.derived;
  return copy;
}

/**
 * Check if a route in `cfg` points to an unconfigured placeholder (such as shipped `magpie/*` routes
 * when no `magpie` provider is registered in DSH and no discovered model matches it).
 */
export function isPlaceholderUnconfiguredRoute(route, cfg, discoveredRoutesSet = new Set()) {
  if (typeof route !== 'string' || !route) return true;
  if (discoveredRoutesSet.has(route)) return false;
  const spec = cfg?.models?.[route];
  if (!spec) return true;
  const defaultGw = cfg?.magpie?.provider ?? 'magpie';
  const effectiveProv = spec.provider ?? defaultGw;
  // Shipped internal placeholder routes (`codex/gpt-6.1-sol`, `zcode/GLM-5.3`, `antigravity/claude-opus-5-5`)
  if (effectiveProv === 'magpie' && (
    route.startsWith('codex/') ||
    route.startsWith('zcode/') ||
    route.startsWith('antigravity/')
  )) {
    return true;
  }
  return false;
}

/**
 * Normalize a user's partial session patch against `baseConfig`, auto-registering any discovered/host-selected
 * models, auto-aligning unsupported `effort` values to `model.defaultEffort`, and auto-healing unreachable
 * placeholder review roles when needed so manual edits never fail on effort/catalog mismatches.
 */
export function buildNormalizedSessionPatch(baseConfig, currentActivePatch = {}, incomingPatch = {}, {
  discoveredModels = [],
  autoHealPlaceholders = false,
} = {}) {
  const baseClean = stripDerived(baseConfig);
  const discoveredByRoute = new Map();
  const discoveredRoutesSet = new Set();
  for (const dm of discoveredModels ?? []) {
    if (dm?.route) {
      discoveredByRoute.set(dm.route, dm);
      discoveredRoutesSet.add(dm.route);
    }
  }

  const mergedPatch = deepMergeConfig(currentActivePatch, {});
  mergedPatch.models ??= {};
  mergedPatch.roles ??= {};
  mergedPatch.team ??= {};

  if (isPlainObj(incomingPatch.models)) {
    for (const [r, spec] of Object.entries(incomingPatch.models)) {
      if (!isPlainObj(spec)) continue;
      const effs = Array.isArray(spec.efforts) && spec.efforts.length > 0 ? [...spec.efforts] : ['none'];
      const defEff = spec.defaultEffort && effs.includes(spec.defaultEffort) ? spec.defaultEffort : effs[0];
      mergedPatch.models[r] = {
        family: FAMILIES.includes(spec.family) ? spec.family : inferFamily(r, spec.upstreamModel),
        label: spec.label || r.split('/').pop() || r,
        efforts: effs,
        defaultEffort: defEff,
        ...(spec.provider ? { provider: spec.provider } : {}),
        ...(spec.upstreamModel ? { upstreamModel: spec.upstreamModel } : {}),
        ...(typeof spec.vision === 'boolean' ? { vision: spec.vision } : {}),
        ...(Number.isInteger(spec.contextWindow) && spec.contextWindow > 0 ? { contextWindow: spec.contextWindow } : {}),
        ...(Number.isInteger(spec.maxTokens) && spec.maxTokens > 0 ? { maxTokens: spec.maxTokens } : {}),
        ...(isPlainObj(spec.reasoningEfforts) ? { reasoningEfforts: { ...spec.reasoningEfforts } } : {}),
      };
    }
  }

  const ensureRouteDefined = route => {
    if (!route || baseClean.models?.[route] || mergedPatch.models?.[route]) return;
    const dm = discoveredByRoute.get(route);
    if (dm) {
      const effs = Array.isArray(dm.efforts) && dm.efforts.length > 0 ? [...dm.efforts] : ['none'];
      mergedPatch.models[route] = {
        family: FAMILIES.includes(dm.family) ? dm.family : inferFamily(route, dm.upstreamModel),
        label: dm.label || dm.upstreamModel || route,
        efforts: effs,
        defaultEffort: dm.defaultEffort && effs.includes(dm.defaultEffort) ? dm.defaultEffort : effs[0],
        ...(dm.provider ? { provider: dm.provider } : {}),
        ...(dm.upstreamModel && dm.upstreamModel !== route ? { upstreamModel: dm.upstreamModel } : {}),
        ...(typeof dm.vision === 'boolean' ? { vision: dm.vision } : {}),
        ...(Number.isInteger(dm.contextWindow) && dm.contextWindow > 0 ? { contextWindow: dm.contextWindow } : {}),
        ...(Number.isInteger(dm.maxTokens ?? dm.defaultMaxTokens) && (dm.maxTokens ?? dm.defaultMaxTokens) > 0
          ? { maxTokens: dm.maxTokens ?? dm.defaultMaxTokens }
          : {}),
        ...(isPlainObj(dm.reasoningEfforts) ? { reasoningEfforts: { ...dm.reasoningEfforts } } : {}),
      };
      return;
    }
    // Synthesize a valid model entry from `<provider>/<model>` if user selected a live DSH model directly
    const slashIdx = route.indexOf('/');
    if (slashIdx > 0) {
      const prov = route.slice(0, slashIdx);
      const upstream = route.slice(slashIdx + 1);
      mergedPatch.models[route] = {
        provider: prov,
        upstreamModel: upstream,
        family: inferFamily(route, upstream),
        label: upstream,
        efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      };
    }
  };

  const resolveValidEffort = (route, requestedEffort) => {
    const spec = mergedPatch.models?.[route] ?? baseClean.models?.[route];
    const supported = Array.isArray(spec?.efforts) && spec.efforts.length > 0 ? spec.efforts : ['none'];
    if (requestedEffort && supported.includes(requestedEffort)) return requestedEffort;
    if (spec?.defaultEffort && supported.includes(spec.defaultEffort)) return spec.defaultEffort;
    if (supported.includes('high')) return 'high';
    if (supported.includes('medium')) return 'medium';
    return supported[0];
  };

  if (isPlainObj(incomingPatch.roles)) {
    for (const [roleKey, rSpec] of Object.entries(incomingPatch.roles)) {
      if (!ROLE_KEYS.includes(roleKey) || !isPlainObj(rSpec) || typeof rSpec.route !== 'string' || !rSpec.route.trim()) {
        continue;
      }
      const route = rSpec.route.trim();
      ensureRouteDefined(route);
      const priorRole = mergedPatch.roles?.[roleKey] ?? baseClean.roles?.[roleKey] ?? {};
      const effort = resolveValidEffort(route, rSpec.effort ?? priorRole.effort);
      if (roleKey === 'leader') {
        mergedPatch.roles.leader = {
          route,
          effort,
          ...(Number.isInteger(rSpec.maxTokens) && rSpec.maxTokens >= 64 ? { maxTokens: rSpec.maxTokens } : {}),
        };
      } else {
        const fbList = Array.isArray(rSpec.fallback)
          ? rSpec.fallback
          : (Array.isArray(priorRole.fallback) ? priorRole.fallback : []);
        const normalizedFb = fbList
          .filter(f => isPlainObj(f) && typeof f.route === 'string' && f.route.trim() && f.route.trim() !== route)
          .slice(0, 4)
          .map(f => {
            const fRoute = f.route.trim();
            ensureRouteDefined(fRoute);
            return {
              route: fRoute,
              effort: resolveValidEffort(fRoute, f.effort),
              ...(Number.isInteger(f.maxTokens) && f.maxTokens >= 64 ? { maxTokens: f.maxTokens } : {}),
              ...(Number.isInteger(f.timeoutMs) && f.timeoutMs >= 1000 ? { timeoutMs: f.timeoutMs } : {}),
              ...(Number.isInteger(f.retries) && f.retries >= 0 ? { retries: f.retries } : {}),
            };
          });
        mergedPatch.roles[roleKey] = {
          route,
          effort,
          ...(Number.isInteger(rSpec.maxTokens ?? priorRole.maxTokens) ? { maxTokens: rSpec.maxTokens ?? priorRole.maxTokens } : {}),
          timeoutMs: Number.isInteger(rSpec.timeoutMs) ? rSpec.timeoutMs : (priorRole.timeoutMs ?? 180000),
          retries: Number.isInteger(rSpec.retries) ? rSpec.retries : (priorRole.retries ?? 1),
          fallback: normalizedFb,
        };
      }
    }
  }

  // Optional one-click sync of all governance/review roles to match the session's leader route (or auto-heal placeholders)
  const effectiveLeaderRoute = mergedPatch.roles?.leader?.route ?? baseClean.roles?.leader?.route;
  const effectiveLeaderEffort = mergedPatch.roles?.leader?.effort ?? baseClean.roles?.leader?.effort;
  if (effectiveLeaderRoute && (incomingPatch.syncAllRolesToLeader === true || autoHealPlaceholders)) {
    for (const rk of ROLE_KEYS) {
      if (rk === 'leader') continue;
      if (mergedPatch.roles?.[rk] && !incomingPatch.syncAllRolesToLeader) continue;
      const curBaseRoute = baseClean.roles?.[rk]?.route;
      if (
        incomingPatch.syncAllRolesToLeader === true ||
        (autoHealPlaceholders && isPlaceholderUnconfiguredRoute(curBaseRoute, baseClean, discoveredRoutesSet))
      ) {
        const priorRole = baseClean.roles?.[rk] ?? {};
        mergedPatch.roles[rk] = {
          route: effectiveLeaderRoute,
          effort: resolveValidEffort(effectiveLeaderRoute, effectiveLeaderEffort),
          ...(Number.isInteger(priorRole.maxTokens) ? { maxTokens: priorRole.maxTokens } : {}),
          timeoutMs: priorRole.timeoutMs ?? 180000,
          retries: priorRole.retries ?? 1,
          fallback: [],
        };
      }
    }
  }

  if (isPlainObj(incomingPatch.team)) {
    if (Array.isArray(incomingPatch.team.executionPool) && incomingPatch.team.executionPool.length > 0) {
      const cleanPool = [...new Set(incomingPatch.team.executionPool.map(r => String(r || '').trim()).filter(Boolean))];
      for (const r of cleanPool) ensureRouteDefined(r);
      mergedPatch.team.executionPool = cleanPool;
    }
    if (Number.isInteger(incomingPatch.team.maxActiveMembers) && incomingPatch.team.maxActiveMembers >= 1 && incomingPatch.team.maxActiveMembers <= 200) {
      mergedPatch.team.maxActiveMembers = incomingPatch.team.maxActiveMembers;
    }
    if (['follow', 'enforce', 'warn', 'off'].includes(incomingPatch.team.leaderModelPolicy)) {
      mergedPatch.team.leaderModelPolicy = incomingPatch.team.leaderModelPolicy;
    }
  }

  // If autoHealPlaceholders is true and current executionPool only contains unconfigured placeholder routes, add effectiveLeaderRoute
  if (autoHealPlaceholders && effectiveLeaderRoute && !mergedPatch.team?.executionPool) {
    const basePool = baseClean.team?.executionPool ?? [];
    const hasAnyRealPoolModel = basePool.some(r => !isPlaceholderUnconfiguredRoute(r, baseClean, discoveredRoutesSet));
    if (!hasAnyRealPoolModel) {
      mergedPatch.team.executionPool = [effectiveLeaderRoute];
    }
  }

  // Ensure any family used in session models/roles/pool is not blocked by base `disabledFamilies`
  const candidatePreview = deepMergeConfig(baseClean, mergedPatch);
  const activeRoutes = new Set([
    ...(candidatePreview.team?.executionPool ?? []),
    ...Object.values(candidatePreview.roles ?? {}).map(r => r?.route).filter(Boolean),
  ]);
  const usedFamilies = new Set([...activeRoutes].map(r => candidatePreview.models?.[r]?.family).filter(Boolean));
  if (Array.isArray(candidatePreview.team?.disabledFamilies) && candidatePreview.team.disabledFamilies.some(f => usedFamilies.has(f))) {
    mergedPatch.team.disabledFamilies = candidatePreview.team.disabledFamilies.filter(f => !usedFamilies.has(f));
  }

  // Prune empty sub-objects
  for (const k of ['models', 'roles', 'team', 'quota']) {
    if (isPlainObj(mergedPatch[k]) && Object.keys(mergedPatch[k]).length === 0) {
      delete mergedPatch[k];
    }
  }

  const validated = validateConfig(deepMergeConfig(baseClean, mergedPatch));
  return {
    normalizedPatch: mergedPatch,
    validatedConfig: validated,
  };
}

/**
 * Merge a session's activePatch onto a live base configuration.
 */
export function applySessionPatchToConfig(baseConfig, sessionRecord) {
  if (!hasActiveSessionOverride(sessionRecord)) return baseConfig;
  const baseClean = stripDerived(baseConfig);
  try {
    return validateConfig(deepMergeConfig(baseClean, sessionRecord.activePatch));
  } catch {
    return baseConfig;
  }
}

/**
 * User-initiated mutation of a single session's configuration (`teams/<id>/session-config.json`).
 * - Idle session (`isBusy === false`): applies immediately to `activePatch`!
 * - Executing session (`isBusy === true`): stages in `pendingPatch` to switch cleanly at the next safe boundary!
 */
export function mutateSessionConfig({
  storageRoot,
  sessionId,
  baseConfig,
  patch = {},
  action = 'merge', // 'merge' | 'set' | 'reset'
  principal,
  inAgentToolDispatch = false,
  isBusy = false,
  busyReasons = [],
  discoveredModels = [],
  autoHealPlaceholders = false,
  fsImpl = fs,
} = {}) {
  const verifiedPrincipal = assertUserConfigPrincipal(principal, { inAgentToolDispatch });
  if (!storageRoot || !sessionId) {
    throw new LtError('BAD_SESSION_ID', 'storageRoot and sessionId are required');
  }

  const file = sessionConfigPath(storageRoot, sessionId);
  const prev = readSessionConfigRecord(storageRoot, sessionId, fsImpl);
  const nowIso = new Date().toISOString();

  if (action === 'reset') {
    const nextRecord = isBusy
      ? {
          ...prev,
          updatedAt: nowIso,
          updatedBy: verifiedPrincipal.source,
          pendingPatch: { __resetToGlobal: true },
          pendingMeta: { stagedAt: nowIso, source: verifiedPrincipal.source, busyReasons },
          audit: [
            ...prev.audit.slice(-29),
            { at: nowIso, event: 'staged-reset', by: verifiedPrincipal.source, busyReasons },
          ],
        }
      : {
          ...prev,
          updatedAt: nowIso,
          updatedBy: verifiedPrincipal.source,
          activePatch: {},
          pendingPatch: null,
          pendingMeta: null,
          audit: [
            ...prev.audit.slice(-29),
            { at: nowIso, event: 'reset-applied', by: verifiedPrincipal.source },
          ],
        };
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(nextRecord, null, 2)}\n`);
    return {
      appliedImmediately: !isBusy,
      stagedForSafeBoundary: Boolean(isBusy),
      busyReasons: isBusy ? busyReasons : [],
      record: nextRecord,
      effectiveConfig: isBusy ? applySessionPatchToConfig(baseConfig, nextRecord) : baseConfig,
    };
  }

  const startingPatch = action === 'set'
    ? {}
    : (isBusy && isPlainObj(prev.pendingPatch) && !prev.pendingPatch.__resetToGlobal
        ? deepMergeConfig(prev.activePatch, prev.pendingPatch)
        : prev.activePatch);

  const { normalizedPatch, validatedConfig } = buildNormalizedSessionPatch(
    baseConfig,
    startingPatch,
    patch,
    { discoveredModels, autoHealPlaceholders },
  );

  const nextRecord = isBusy
    ? {
        ...prev,
        updatedAt: nowIso,
        updatedBy: verifiedPrincipal.source,
        pendingPatch: normalizedPatch,
        pendingMeta: { stagedAt: nowIso, source: verifiedPrincipal.source, busyReasons },
        audit: [
          ...prev.audit.slice(-29),
          { at: nowIso, event: 'staged-for-safe-boundary', by: verifiedPrincipal.source, busyReasons },
        ],
      }
    : {
        ...prev,
        updatedAt: nowIso,
        updatedBy: verifiedPrincipal.source,
        activePatch: normalizedPatch,
        pendingPatch: null,
        pendingMeta: null,
        audit: [
          ...prev.audit.slice(-29),
          { at: nowIso, event: 'applied-immediately', by: verifiedPrincipal.source },
        ],
      };

  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(nextRecord, null, 2)}\n`);

  return {
    appliedImmediately: !isBusy,
    stagedForSafeBoundary: Boolean(isBusy),
    busyReasons: isBusy ? busyReasons : [],
    record: nextRecord,
    effectiveConfig: isBusy ? applySessionPatchToConfig(baseConfig, nextRecord) : validatedConfig,
  };
}

/**
 * Promote `pendingPatch` to `activePatch` once the session reaches a safe idle boundary.
 */
export function flushPendingSessionConfig({
  storageRoot,
  sessionId,
  baseConfig,
  discoveredModels = [],
  fsImpl = fs,
} = {}) {
  const file = sessionConfigPath(storageRoot, sessionId);
  if (!file || !fsImpl.existsSync(file)) return { flushed: false, record: null, effectiveConfig: baseConfig };
  const prev = readSessionConfigRecord(storageRoot, sessionId, fsImpl);
  if (!hasPendingSessionOverride(prev)) {
    return { flushed: false, record: prev, effectiveConfig: applySessionPatchToConfig(baseConfig, prev) };
  }

  const nowIso = new Date().toISOString();
  let nextActive = {};
  let effectiveConfig = baseConfig;

  if (!prev.pendingPatch.__resetToGlobal) {
    try {
      const built = buildNormalizedSessionPatch(baseConfig, {}, prev.pendingPatch, { discoveredModels });
      nextActive = built.normalizedPatch;
      effectiveConfig = built.validatedConfig;
    } catch {
      nextActive = prev.activePatch;
      effectiveConfig = applySessionPatchToConfig(baseConfig, prev);
    }
  }

  const nextRecord = {
    ...prev,
    updatedAt: nowIso,
    activePatch: nextActive,
    pendingPatch: null,
    pendingMeta: null,
    audit: [
      ...prev.audit.slice(-29),
      { at: nowIso, event: 'flushed-at-safe-boundary', by: prev.pendingMeta?.source ?? 'safe-boundary' },
    ],
  };
  writeFileAtomic(file, `${JSON.stringify(nextRecord, null, 2)}\n`);
  return {
    flushed: true,
    record: nextRecord,
    effectiveConfig,
  };
}

/**
 * Build a complete zero-CLI `leaderteam.local.json` starter override from real models already configured
 * inside the user's DeepSeek Harness host (`discoveredModels`), so users who already set up DSH never have
 * to configure LeaderTeam twice!
 */
export function buildAutoAdoptedLocalOverrideFromDshModels(discoveredModels = []) {
  const usable = (discoveredModels ?? []).filter(
    m => m && typeof m.route === 'string' && m.route.includes('/') && m.registeredInDsh !== false,
  );
  if (usable.length === 0) return null;

  // Prefer reasoning-capable models for Leader / Arbiter / DiscussA, and fast chat/code models for Gate / DirectExec
  const scoreReasoning = m => {
    const id = `${m.route} ${m.label || ''}`.toLowerCase();
    let score = 0;
    if (Array.isArray(m.efforts) && m.efforts.some(e => e !== 'none' && e !== 'off')) score += 10;
    if (/reasoner|opus|pro|gpt-5|gpt-4\.1|o3|o4|max|glm-5|glm-4\.5|kimi|r1|qwq/.test(id)) score += 8;
    if (/flash|mini|air|haiku|turbo|lite/.test(id)) score -= 3;
    return score;
  };
  const sortedByReasoning = [...usable].sort((a, b) => scoreReasoning(b) - scoreReasoning(a));
  const primary = sortedByReasoning[0];
  const secondary = usable.find(m => m.route !== primary.route) ?? primary;

  const modelsMap = {};
  const pool = [];
  for (const dm of usable.slice(0, 24)) {
    const effs = Array.isArray(dm.efforts) && dm.efforts.length > 0 ? [...dm.efforts] : ['none'];
    const defEff = dm.defaultEffort && effs.includes(dm.defaultEffort) ? dm.defaultEffort : effs[0];
    modelsMap[dm.route] = {
      ...(dm.provider ? { provider: dm.provider } : {}),
      ...(dm.upstreamModel && dm.upstreamModel !== dm.route ? { upstreamModel: dm.upstreamModel } : {}),
      family: FAMILIES.includes(dm.family) ? dm.family : inferFamily(dm.route, dm.upstreamModel),
      label: dm.label || dm.upstreamModel || dm.route,
      efforts: effs,
      defaultEffort: defEff,
      ...(isPlainObj(dm.reasoningEfforts) ? { reasoningEfforts: { ...dm.reasoningEfforts } } : {}),
      ...(typeof dm.vision === 'boolean' ? { vision: dm.vision } : {}),
      ...(Number.isInteger(dm.contextWindow) && dm.contextWindow > 0 ? { contextWindow: dm.contextWindow } : {}),
      ...(Number.isInteger(dm.maxTokens ?? dm.defaultMaxTokens) && (dm.maxTokens ?? dm.defaultMaxTokens) > 0
        ? { maxTokens: dm.maxTokens ?? dm.defaultMaxTokens }
        : {}),
    };
    pool.push(dm.route);
  }

  const pSpec = modelsMap[primary.route];
  const sSpec = modelsMap[secondary.route];
  const pEff = pSpec.efforts.includes('high') ? 'high' : pSpec.defaultEffort;
  const sEff = sSpec.defaultEffort;
  const fbToSecondary = secondary.route !== primary.route
    ? [{ route: secondary.route, effort: sEff, timeoutMs: 120000, retries: 1 }]
    : [];
  const fbToPrimary = secondary.route !== primary.route
    ? [{ route: primary.route, effort: pEff, timeoutMs: 180000, retries: 1 }]
    : [];

  return {
    models: modelsMap,
    roles: {
      leader: { route: primary.route, effort: pEff },
      gate: { route: secondary.route, effort: sEff, maxTokens: 4000, timeoutMs: 90000, retries: 1, fallback: fbToPrimary },
      discussA: { route: primary.route, effort: pEff, maxTokens: 8000, timeoutMs: 300000, retries: 1, fallback: fbToSecondary },
      discussB: { route: secondary.route, effort: sEff, maxTokens: 8000, timeoutMs: 300000, retries: 1, fallback: fbToPrimary },
      arbiter: { route: primary.route, effort: pEff, maxTokens: 16000, timeoutMs: 600000, retries: 1, fallback: fbToSecondary },
      serialReviewer: { route: secondary.route, effort: sEff, maxTokens: 2400, timeoutMs: 120000, retries: 1, fallback: fbToPrimary },
      directExec: { route: secondary.route, effort: sEff, timeoutMs: 180000, retries: 1, fallback: fbToPrimary },
    },
    team: {
      leaderModelPolicy: 'follow',
      executionPool: pool,
      autoIncludeUpstreamModels: true,
      disabledModels: [],
      disabledFamilies: [],
    },
    quota: {
      allowUnknown: true,
      allowUnknownGpt: true,
    },
  };
}
