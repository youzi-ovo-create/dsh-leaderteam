// Process-wide LeaderTeam state shared by the core and lead entries (one instance per process).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, routeProvider } from '../core/config.mjs';
import { hashJson, deepFreeze } from '../core/canonical.mjs';
import { TeamStore, encodeTeamStoreId, resolveTeamStoreLogicalId, writeFileAtomic } from '../core/store.mjs';
import { readSessionModeRecord, decodeSessionModeSegment } from '../core/session-mode.mjs';
import { discoverRuntimeModels, enrichConfigModelsFromCatalog, mergeUpstreamModelsIntoConfig, resolveModelTarget } from '../core/upstream-models.mjs';
import { DETACHABLE_PLUGINS } from '../core/constants.mjs';
import { currentPlanRoot } from '../core/current-plan.mjs';
import {
  assertUserConfigPrincipal,
  isProcessPidDead,
  readSessionConfigRecord,
  hasActiveSessionOverride,
  hasPendingSessionOverride,
  applySessionPatchToConfig,
  mutateSessionConfig,
  flushPendingSessionConfig,
  withSessionConfigLock,
  hasLiveCrossProcessActiveTurn,
} from '../core/session-config.mjs';

const KEY = Symbol.for('leaderteam.runtime.v1');
const BASE_RUNTIME = Symbol.for('leaderteam.runtime.base');
export function runtime() {
  return globalThis[KEY] ??= {
    config: null, configPath: null, surface: null, storageRoot: null, llm: null, logger: null,
    configWatch: null,   // { boundConfigRef, configPath, localPath, baseSig, localSig }
    upstreamCatalog: null, // { discoveredAt, providers, models, endpointErrors }
    upstreamCatalogAtMs: 0,
    cordisCompositionMode: false, // true when modular plugin rows are mounted explicitly via cordis.patch.yml
    plugins: {
      scheduler: null,
      consensus: null,
      timerArchive: null,
      panel: null,
    },
    actors: new Map(),   // agentId -> actor { role, teamId, agent, cwd, allowedTools, ... }
    reads: new Map(),    // agentId -> Set<pathKey>
    readProgress: new Map(), // agentId -> Map<pathKey, Array<[startLine, endLine]>>
    memberErrors: new Map(), // agentId -> { seq, message }
    memberExecutionProgress: new Map(), // current activation's completed write/edit/shell call ids
    stores: new Map(),   // teamId -> TeamStore
    gate: null,          // active gate (or closed gate after the core plugin is disposed)
    startupReady: null, // identity published only after every core startup hook is installed
    counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 },
  };
}

export function baseRuntime(rt = runtime()) { return rt[BASE_RUNTIME] ?? rt; }

/** True once a team has recorded any workflow, member, agreement, or governance activity (after which governance is immutable). */
export function isTeamExecutionStarted(store) {
  if (!store) return false;
  try {
    if (store.workflowEvents().length > 0) return true;
    if (store.members().size > 0) return true;
    if (store.agreementIds().length > 0) return true;
    if (store.governanceEvents().length > 0) return true;
    return false;
  } catch {
    return true;
  }
}

/** Rebind `governance.json` to current `rt.config` ONLY when the team has not started any workflow/execution yet. */
export function rebindUnstartedTeamGovernance(rt = runtime(), teamId) {
  rt = baseRuntime(rt);
  if (!teamId || !rt.config || !rt.storageRoot) return { rebound: false, reason: 'not-ready' };
  let storeId;
  try { storeId = encodeTeamStoreId(teamId, rt.storageRoot); } catch { return { rebound: false, reason: 'bad-id' }; }
  const store = teamStore(teamId);
  if (!fs.existsSync(store.dir)) return { rebound: false, reason: 'no-store' };
  if (isTeamExecutionStarted(store)) return { rebound: false, reason: 'already-started' };
  const file = path.join(store.dir, 'governance.json');
  let prevRecord = null;
  try {
    if (fs.existsSync(file)) prevRecord = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  let prevLeaderTarget = null;
  if (prevRecord?.config?.roles?.leader?.route) {
    try {
      const prevValidated = validateConfig(prevRecord.config);
      prevLeaderTarget = resolveModelTarget(prevValidated, prevValidated.roles.leader.route, prevValidated.roles.leader.effort);
    } catch {}
  }
  const sessionRec = readSessionConfigRecord(rt.storageRoot, teamId);
  const mergedCfg = applySessionPatchToConfig(rt.config, sessionRec);
  const config = structuredClone(mergedCfg);
  delete config.derived;
  const sourceSha256 = hashJson(config);
  const changed = !prevRecord || prevRecord.sourceSha256 !== sourceSha256;
  if (changed) {
    const record = {
      v: 1,
      createdAt: prevRecord?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceSha256,
      config,
    };
    writeFileAtomic(file, JSON.stringify(record, null, 1));
  }
  rt.teamConfigViews?.delete(`${rt.storageRoot}:${storeId}`);
  rt.teamConfigViews?.delete(`${rt.storageRoot}:${teamId}`);
  const nextLeaderTarget = resolveModelTarget(mergedCfg, mergedCfg.roles.leader.route, mergedCfg.roles.leader.effort);
  return { rebound: true, changed, prevLeaderTarget, nextLeaderTarget };
}

/** Refresh all unstarted team governance snapshots (and optionally align blank 0-message Leader sessions) after config save. */
export function rebindAllUnstartedTeams(_ctx, rt = runtime(), { alignBlankSessions = true } = {}) {
  rt = baseRuntime(rt);
  if (!rt?.config || !rt?.storageRoot) return { reboundTeamIds: [], alignedSessionIds: [] };
  const candidateIds = new Set();
  for (const actor of rt.actors?.values() ?? []) {
    if (actor?.role === 'leader' && actor.teamId) candidateIds.add(actor.teamId);
  }
  const prefix = `${rt.storageRoot}:`;
  for (const key of rt.teamConfigViews?.keys() ?? []) {
    if (key.startsWith(prefix)) {
      try { candidateIds.add(resolveTeamStoreLogicalId(rt.storageRoot, key.slice(prefix.length))); } catch { candidateIds.add(key.slice(prefix.length)); }
    }
  }
  const teamsDir = path.join(rt.storageRoot, 'teams');
  try {
    if (fs.existsSync(teamsDir)) {
      for (const d of fs.readdirSync(teamsDir, { withFileTypes: true }).slice(0, 60)) {
        if (d.isDirectory()) {
          try { candidateIds.add(resolveTeamStoreLogicalId(rt.storageRoot, d.name)); } catch { candidateIds.add(d.name); }
        }
      }
    }
  } catch {}
  const reboundTeamIds = [];
  for (const tid of candidateIds) {
    const res = rebindUnstartedTeamGovernance(rt, tid);
    if (res.rebound && res.changed) reboundTeamIds.push(tid);
  }
  const alignedSessionIds = [];
  if (alignBlankSessions) {
    for (const actor of rt.actors?.values() ?? []) {
      if (actor?.role !== 'leader' || !actor.agent?.model?.select) continue;
      const store = teamStore(actor.teamId);
      if (isTeamExecutionStarted(store)) continue;
      const userMsgs = (actor.agent.session?.snapshotEvents?.() ?? []).filter(e => e?.type === 'user/message');
      if (userMsgs.length > 0) continue;
      try {
        const teamCfg = runtimeForTeam(actor.teamId).config;
        const target = resolveModelTarget(teamCfg, teamCfg.roles.leader.route, teamCfg.roles.leader.effort);
        actor.agent.model.select(target);
        alignedSessionIds.push(actor.teamId);
      } catch {}
    }
  }
  return { reboundTeamIds, alignedSessionIds };
}

/** Immutable during active execution; user-rebindable when idle and layerable with per-session overrides. */
export function runtimeForTeam(teamId) {
  const rt = runtime();
  if (!teamId || !rt.config || !rt.storageRoot) return rt;
  let storeId;
  try { storeId = encodeTeamStoreId(teamId, rt.storageRoot); } catch { return rt; }
  const sessionRec = readSessionConfigRecord(rt.storageRoot, teamId);
  const hasSessOver = hasActiveSessionOverride(sessionRec);
  const file = path.join(rt.storageRoot, 'teams', storeId, 'governance.json');
  if (!fs.existsSync(file) && !TeamStore.exists(rt.storageRoot, teamId)) {
    let isPureSingle = false;
    try {
      const cachedMode = rt.sessionModesCache?.get?.(teamId)?.mode;
      isPureSingle = (cachedMode ?? readSessionModeRecord(rt.storageRoot, teamId).mode) === 'single';
    } catch {}
    if (isPureSingle) {
      if (!hasSessOver) return rt;
      return new Proxy(rt, {
        get(target, property, receiver) {
          if (property === BASE_RUNTIME) return target;
          if (property !== 'config') return Reflect.get(target, property, receiver);
          const curRec = readSessionConfigRecord(target.storageRoot, teamId);
          const baseCfg = effectiveRuntimeConfig(target) ?? target.config;
          return hasActiveSessionOverride(curRec) ? applySessionPatchToConfig(baseCfg, curRec) : baseCfg;
        },
        set(target, property, value) { return Reflect.set(target, property, value); },
      });
    }
  }
  rt.teamConfigViews ??= new Map();
  const key = `${rt.storageRoot}:${storeId}`;
  let view = rt.teamConfigViews.get(key);
  if (!view) {
    const store = teamStore(teamId);
    fs.mkdirSync(store.dir, { recursive: true });
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`cannot load frozen team governance: ${error.message}`);
      const baseWithSess = applySessionPatchToConfig(rt.config, sessionRec);
      const config = structuredClone(baseWithSess); delete config.derived;
      record = { v: 1, createdAt: new Date().toISOString(), sourceSha256: hashJson(config), config };
      try { fs.writeFileSync(file, JSON.stringify(record, null, 1), { flag: 'wx' }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    }
    if (record.v !== 1 || hashJson(record.config) !== record.sourceSha256) throw new Error('frozen team governance snapshot is corrupt; refusing to replace it with live defaults');
    view = {
      snapshot: validateConfig(record.config),
      sourceSha256: record.sourceSha256,
      govSig: fileSignature(file),
      live: null,
      sessionSig: null,
      mixed: null,
      proxy: null,
    };
    view.proxy = new Proxy(rt, {
      get(target, property, receiver) {
        if (property === BASE_RUNTIME) return target;
        if (property !== 'config') return Reflect.get(target, property, receiver);
        const curGovSig = fileSignature(file);
        if (curGovSig !== 'missing' && curGovSig !== view.govSig) {
          try {
            const diskGov = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (diskGov?.v === 1 && hashJson(diskGov.config) === diskGov.sourceSha256) {
              view.snapshot = validateConfig(diskGov.config);
              view.sourceSha256 = diskGov.sourceSha256;
              view.govSig = curGovSig;
              view.live = null;
            }
          } catch {}
        }
        const curSessionRec = readSessionConfigRecord(target.storageRoot, teamId);
        const curSessionSig = curSessionRec.updatedAt ?? '';
        if (view.live !== target.config || view.catalog !== target.upstreamCatalog || view.sessionSig !== curSessionSig) {
          const fixed = view.snapshot;
          const liveBase = target.upstreamCatalog
            ? (target.config.team.autoIncludeUpstreamModels === true
              ? mergeUpstreamModelsIntoConfig(target.config, target.upstreamCatalog)
              : enrichConfigModelsFromCatalog(target.config, target.upstreamCatalog))
            : target.config;
          const live = hasActiveSessionOverride(curSessionRec)
            ? applySessionPatchToConfig(liveBase, curSessionRec)
            : liveBase;
          const effectiveRoles = curSessionRec?.activePatch?.roles
            ? { ...fixed.roles, ...live.roles }
            : fixed.roles;
          const roleSourceModels = { ...fixed.models, ...live.models };
          const roleModels = Object.fromEntries(Object.values(effectiveRoles).flatMap(role => [role.route, ...(role.fallback ?? []).map(f => f.route)]).filter(route => roleSourceModels[route]).map(route => {
            const frozenSpec = fixed.models[route] ?? roleSourceModels[route];
            const liveSpec = live.models[route];
            const enrichedRoleSpec = liveSpec ? {
              ...frozenSpec,
              ...(frozenSpec.contextWindow === undefined && liveSpec.contextWindow !== undefined ? { contextWindow: liveSpec.contextWindow } : {}),
              ...(frozenSpec.maxTokens === undefined && liveSpec.maxTokens !== undefined ? { maxTokens: liveSpec.maxTokens } : {}),
            } : frozenSpec;
            return [route, enrichedRoleSpec];
          }));
          view.mixed = deepFreeze({ ...fixed,
            roles: effectiveRoles,
            models: { ...live.models, ...roleModels, ...(curSessionRec?.activePatch?.models ?? {}) },
            team: {
              ...fixed.team,
              executionPool: curSessionRec?.activePatch?.team?.executionPool ?? live.team.executionPool,
              maxActiveMembers: curSessionRec?.activePatch?.team?.maxActiveMembers ?? live.team.maxActiveMembers,
              leaderModelPolicy: curSessionRec?.activePatch?.team?.leaderModelPolicy ?? fixed.team.leaderModelPolicy,
              disabledFamilies: curSessionRec?.activePatch?.team?.disabledFamilies ?? fixed.team.disabledFamilies,
            },
            scheduler: live.scheduler,
            timer: live.timer,
            paths: { ...fixed.paths, globalRefRoots: [...new Set([...fixed.paths.globalRefRoots, currentPlanRoot(rt.storageRoot, store.rawTeamId ?? store.teamId), ...((fixed.team.rollingPlanning || fixed.governance?.mode === 'autonomous') ? [fileURLToPath(new URL('../../docs/HeLuoDoc/V2.1', import.meta.url))] : [])])] },
            derived: { ...fixed.derived, executionModels: live.models, governanceSha256: view.sourceSha256 },
          });
          view.live = target.config;
          view.catalog = target.upstreamCatalog;
          view.sessionSig = curSessionSig;
        }
        return view.mixed;
      },
      set(target, property, value) { return Reflect.set(target, property, value); },
    });
    rt.teamConfigViews.set(key, view);
  }
  return view.proxy;
}

function fileSignature(file) {
  if (!file) return 'none';
  try {
    const st = fs.statSync(file, { bigint: true });
    return `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`;
  } catch {
    return 'missing';
  }
}

export function bindRuntimeConfigFile(rt, configPath, loadedConfig) {
  rt = baseRuntime(rt);
  if (loadedConfig === undefined) loadedConfig = rt.config;
  const absPath = path.resolve(configPath);
  const localPath = path.basename(absPath) === 'leaderteam.config.json'
    ? path.join(path.dirname(absPath), 'leaderteam.local.json')
    : null;
  rt.config = loadedConfig;
  rt.configPath = absPath;
  rt.configWatch = {
    boundConfigRef: loadedConfig,
    configPath: absPath,
    localPath,
    baseSig: fileSignature(absPath),
    localSig: fileSignature(localPath),
  };
  return loadedConfig;
}

/**
 * Hot-reload `rt.config` when `leaderteam.config.json` or `leaderteam.local.json` changes on disk.
 * Fail-safe: invalid edits are logged and rejected without disturbing the active runtime config or scheduler state.
 */
export function syncRuntimeConfig(rt = runtime()) {
  rt = baseRuntime(rt);
  if (!rt.config || !rt.configPath) return { reloaded: false };
  const absPath = path.resolve(rt.configPath);
  const w = rt.configWatch;
  if (!w || w.configPath !== absPath || w.boundConfigRef !== rt.config) {
    bindRuntimeConfigFile(rt, absPath, rt.config);
    return { reloaded: false };
  }
  const nextBaseSig = fileSignature(w.configPath);
  const nextLocalSig = fileSignature(w.localPath);
  if (nextBaseSig === w.baseSig && nextLocalSig === w.localSig) {
    return { reloaded: false };
  }
  w.baseSig = nextBaseSig;
  w.localSig = nextLocalSig;
  try {
    const reloaded = loadConfig(w.configPath);
    rt.config = reloaded;
    w.boundConfigRef = reloaded;
    if (rt.scheduler && rt.schedulerStorageRef === rt.storageRoot) {
      rt.scheduler.setBaseUserMax(reloaded.team.maxActiveMembers);
      rt.scheduler.cfg = {
        ...reloaded.scheduler,
        memberMemoryMib: { ...reloaded.scheduler.memberMemoryMib },
      };
      rt.schedulerConfigRef = reloaded;
    }
    return { reloaded: true, config: reloaded };
  } catch (e) {
    rt.logger?.warn?.(`leaderteam: live config reload rejected (retaining previous valid config): ${e instanceof Error ? e.message : String(e)}`);
    return { reloaded: false, error: e };
  }
}

export function teamStore(teamId) {
  const rt = runtime();
  let s = rt.stores.get(teamId);
  if (!s) {
    s = new TeamStore(rt.storageRoot, teamId);
    rt.stores.set(teamId, s);
  }
  return s;
}
/** Append one LeaderTeam model-usage record (team usage.jsonl); never fails the operation. */
export function recordUsage(teamId, rec) {
  if (!teamId) return;
  try { teamStore(teamId).appendUsage(rec); }
  catch (e) { runtime().logger?.warn?.(`leaderteam: usage record not written: ${e.message}`); }
}

/**
 * Map a live DSH host selection `(hostProvider, hostModel)` back to the canonical LeaderTeam config route
 * (e.g. `("magpie", "codex/gpt-6.1-terra")` -> `"codex/gpt-6.1-terra"`, `("deepseek", "deepseek-v4-pro")` -> `"deepseek/deepseek-v4-pro"`).
 */
export function resolveCanonicalRouteFromHostSelection(cfg, hostProvider, hostModel, fallbackRoute = null) {
  if (typeof hostModel !== 'string' || !hostModel.trim()) return fallbackRoute;
  const modelId = hostModel.trim();
  const provId = typeof hostProvider === 'string' && hostProvider.trim() ? hostProvider.trim() : null;
  const defaultGw = cfg?.magpie?.provider ?? null;
  const models = cfg?.models ?? {};

  if (provId) {
    for (const [routeKey, spec] of Object.entries(models)) {
      const specHostProv = spec?.provider ?? defaultGw;
      const specUpstreamModel = spec?.upstreamModel ?? routeKey;
      if (specHostProv === provId && specUpstreamModel === modelId) {
        return routeKey;
      }
    }
    if (defaultGw && provId === defaultGw && modelId.includes('/')) {
      return modelId;
    }
    const directCandidate = `${provId}/${modelId}`;
    if (models[directCandidate] || !modelId.includes('/')) {
      return directCandidate;
    }
    return modelId;
  }

  if (models[modelId] || modelId.includes('/')) return modelId;
  return defaultGw ? `${defaultGw}/${modelId}` : (fallbackRoute ?? modelId);
}

/**
 * Resolve the logical upstream quota/window provider for a LeaderTeam route:
 * - Gateway-routed models (`cfg.magpie.provider === "magpie"`, route `"codex/gpt-6.1-terra"`) resolve to `"codex"`,
 *   even after upstream catalog enrichment populates `spec.provider = "magpie"`.
 * - Direct non-gateway routes (`spec.provider === "deepseek"`, including disambiguated `"deepseek@direct/..."`)
 *   resolve to `spec.provider`.
 */
export function resolveProviderForRoute(route, cfg) {
  const gw = cfg?.magpie?.provider ?? null;
  if (typeof route !== 'string' || !route) return gw;
  const normalized = (gw && route.startsWith(`${gw}/`) && route.slice(gw.length + 1).includes('/'))
    ? route.slice(gw.length + 1)
    : route;
  const spec = cfg?.models?.[normalized];
  if (typeof spec?.provider === 'string' && spec.provider && spec.provider !== gw) {
    return spec.provider;
  }
  if (normalized.includes('/')) return routeProvider(normalized);
  if (typeof spec?.provider === 'string' && spec.provider) return spec.provider;
  return gw;
}

export function resolveHostProviderForRoute(route, cfg) {
  const gw = cfg?.magpie?.provider ?? null;
  if (typeof route !== 'string' || !route) return gw;
  const normalized = (gw && route.startsWith(`${gw}/`) && route.slice(gw.length + 1).includes('/'))
    ? route.slice(gw.length + 1)
    : route;
  const spec = cfg?.models?.[normalized];
  if (typeof spec?.provider === 'string' && spec.provider) return spec.provider;
  return gw ?? (normalized.includes('/') ? routeProvider(normalized) : null);
}

export function requestWindowCallsPath(storageRoot) {
  return path.join(storageRoot, 'request-window-calls.jsonl');
}

/** Record one actual session LLM turn/step (`leader`, `member`, or `direct_exec`) for accurate per-provider 5h accounting. */
export function recordSessionModelRequest(rt = runtime(), {
  teamId = null,
  role = 'leader',
  route = null,
  provider = null,
  hostProvider = null,
  hostModel = null,
  atMs = Date.now(),
} = {}) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.storageRoot || !baseRt?.config) return;
  const cfg = baseRt.config;
  const canonicalRoute = (hostProvider || hostModel)
    ? resolveCanonicalRouteFromHostSelection(cfg, hostProvider ?? provider, hostModel, route)
    : (typeof route === 'string' && route ? route : null);
  const gw = cfg?.magpie?.provider ?? null;
  const effectiveRoute = (canonicalRoute && gw && canonicalRoute.startsWith(`${gw}/`) && canonicalRoute.slice(gw.length + 1).includes('/'))
    ? canonicalRoute.slice(gw.length + 1)
    : canonicalRoute;
  const resolvedProvider = effectiveRoute
    ? resolveProviderForRoute(effectiveRoute, cfg)
    : (provider ?? resolveProviderForRoute(null, cfg));
  if (!resolvedProvider) return;
  const resolvedHostProvider = hostProvider ?? resolveHostProviderForRoute(effectiveRoute, cfg) ?? provider ?? null;
  const rec = {
    v: 1,
    at: new Date(atMs).toISOString(),
    atMs,
    teamId,
    role,
    route: effectiveRoute ?? null,
    provider: resolvedProvider,
    ...(resolvedHostProvider && resolvedHostProvider !== resolvedProvider ? { hostProvider: resolvedHostProvider } : {}),
  };
  try {
    fs.mkdirSync(baseRt.storageRoot, { recursive: true });
    fs.appendFileSync(requestWindowCallsPath(baseRt.storageRoot), JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    baseRt.logger?.warn?.(`leaderteam: failed to append request-window call record: ${err instanceof Error ? err.message : String(err)}`);
  }
}
export function requireReady() {
  const rt = runtime();
  if (!rt.config || !rt.storageRoot || !rt.llm) throw new Error('LeaderTeam core plugin is not initialized (leaderteam-core row missing or failed)');
  syncRuntimeConfig(rt);
  return rt;
}

/**
 * Return whether a detachable plugin capability (`scheduler` | `consensus` | `timerArchive` | `panel`)
 * is active right now:
 * 1. Soft-detach via `config.plugins.<id> === false` always disables it immediately.
 * 2. In explicit Cordis modular composition mode, the plugin's fiber must also be mounted (`rt.plugins[id] !== null`).
 * 3. In standalone unit-test harnesses (where `cordisCompositionMode` is false), enabled config flags default to active.
 */
export function isPluginActive(rt = runtime(), pluginId) {
  if (!DETACHABLE_PLUGINS.includes(pluginId)) return false;
  const cfgEnabled = rt?.config?.plugins?.[pluginId] !== false;
  if (!cfgEnabled) return false;
  if (rt?.cordisCompositionMode) {
    return Boolean(rt.plugins?.[pluginId]);
  }
  return true;
}

export function activePluginsMap(rt = runtime()) {
  return {
    core: Boolean(rt?.config),
    lead: true,
    scheduler: isPluginActive(rt, 'scheduler'),
    consensus: isPluginActive(rt, 'consensus'),
    timerArchive: isPluginActive(rt, 'timerArchive'),
    panel: isPluginActive(rt, 'panel'),
  };
}

export function registerRuntimePlugin(pluginId, handle = {}, rt = runtime()) {
  if (!DETACHABLE_PLUGINS.includes(pluginId)) {
    throw new Error(`leaderteam: unknown detachable plugin "${pluginId}"`);
  }
  rt.plugins ??= { scheduler: null, consensus: null, timerArchive: null, panel: null };
  const entry = Object.freeze({ id: pluginId, mountedAt: new Date().toISOString(), ...handle });
  rt.plugins[pluginId] = entry;
  return () => {
    if (rt.plugins?.[pluginId] === entry) {
      rt.plugins[pluginId] = null;
    }
  };
}

/**
 * Refresh live DSH `ctx.llm` upstream models (cached briefly unless `force` is true) and return
 * the merged effective runtime config (`rt.config` + dynamically connected DSH models).
 */
export async function refreshUpstreamCatalog(ctx, rt = runtime(), { force = false, probeEndpoints = false, ignoreRequestWindow = false, ttlMs = 3000 } = {}) {
  rt = baseRuntime(rt);
  if (!rt?.config) return null;
  const suppressOptional = !ignoreRequestWindow && typeof rt.shouldSuppressOptionalProbes === 'function' && rt.shouldSuppressOptionalProbes();
  const effectiveProbeEndpoints = Boolean(probeEndpoints && !suppressOptional);
  const now = Date.now();
  if (!force && !effectiveProbeEndpoints && rt.upstreamCatalog && (rt.upstreamCatalog.providers?.length ?? 0) > 0 && (now - (rt.upstreamCatalogAtMs ?? 0)) < ttlMs) {
    return rt.upstreamCatalog;
  }
  if (suppressOptional && !force && rt.upstreamCatalog) {
    return rt.upstreamCatalog;
  }
  try {
    let effectiveLlm = rt.llm ?? null;
    if (!effectiveLlm && ctx) {
      try { effectiveLlm = ctx.llm ?? null; } catch {}
      if (!effectiveLlm && typeof ctx.get === 'function') {
        try { effectiveLlm = ctx.get('llm') ?? null; } catch {}
      }
    }
    const effectiveCtx = {
      llm: effectiveLlm,
      get(name) {
        if (!ctx || typeof ctx.get !== 'function') return null;
        try { return ctx.get(name); } catch { return null; }
      },
    };
    const cat = await discoverRuntimeModels(effectiveCtx, rt.config, { probeEndpoints: effectiveProbeEndpoints });
    rt.upstreamCatalog = cat;
    rt.upstreamCatalogAtMs = now;
    return cat;
  } catch (e) {
    rt.logger?.warn?.(`leaderteam: upstream model discovery skipped: ${e instanceof Error ? e.message : String(e)}`);
    return rt.upstreamCatalog;
  }
}

export function effectiveRuntimeConfig(rt = runtime()) {
  if (!rt?.config) return null;
  if (!rt.upstreamCatalog) return rt.config;
  return rt.config.team.autoIncludeUpstreamModels === true
    ? mergeUpstreamModelsIntoConfig(rt.config, rt.upstreamCatalog)
    : enrichConfigModelsFromCatalog(rt.config, rt.upstreamCatalog);
}

const ACTIVE_MEMBER_SET = new Set(['starting', 'started', 'running']);

/**
 * Determine whether a session is currently mid-execution (leader turn running, tool call in-flight,
 * active subagent members, or pending governance review).
 */
export function inspectSessionBusyForConfig(rt = runtime(), teamId, { ignoreLeaderRunning = false } = {}) {
  const baseRt = baseRuntime(rt);
  if (!teamId || !baseRt) return { busy: false, reasons: [] };
  const reasons = [];
  const actor = baseRt.actors?.get?.(teamId);
  const agent = (actor?.role === 'leader' ? actor.agent : null) ?? baseRt.hostAgents?.get?.(teamId) ?? null;
  if (!ignoreLeaderRunning && agent && ['running', 'streaming', 'thinking'].includes(String(agent.status || '').toLowerCase())) {
    reasons.push('leader_turn_running');
  }
  if (baseRt.storageRoot && !reasons.includes('leader_turn_running')) {
    const crossTurn = hasLiveCrossProcessActiveTurn(baseRt.storageRoot, teamId, {
      includeSelf: !ignoreLeaderRunning,
    });
    if (crossTurn.active) {
      reasons.push('leader_turn_running');
    }
  }
  if ((baseRt.inFlightToolDispatchesByTeam?.get?.(teamId) ?? 0) > 0) {
    reasons.push('tool_dispatch_in_flight');
  }
  if ((baseRt.inFlightShellCallsBySession?.get?.(teamId) ?? 0) > 0) {
    reasons.push('shell_call_in_flight');
  }
  if ((baseRt.simpleDispatchInFlight?.get?.(teamId)?.size ?? 0) > 0) {
    reasons.push('direct_exec_in_flight');
  }
  if (baseRt.storageRoot && TeamStore.exists(baseRt.storageRoot, teamId)) {
    try {
      const store = teamStore(teamId);
      const hasActive = [...store.members().values()].some(m => {
        if (!ACTIVE_MEMBER_SET.has(m.status)) return false;
        if (Number.isInteger(m.ownerPid) && m.ownerPid > 0 && m.ownerPid !== process.pid && isProcessPidDead(m.ownerPid)) {
          return false;
        }
        return true;
      });
      if (hasActive) reasons.push('active_team_members');
    } catch {}
  }
  const hasReviewJob =
    [...(baseRt.executionReviewJobs?.values?.() ?? [])].some(j => j?.teamId === teamId) ||
    [...(baseRt.governanceJobs?.values?.() ?? [])].some(j => j?.teamId === teamId) ||
    Boolean(baseRt.stopReviewPending?.has?.(teamId)) ||
    Boolean(baseRt.directiveVerifyPending?.has?.(teamId));
  if (hasReviewJob) reasons.push('governance_review_in_flight');
  return { busy: reasons.length > 0, reasons };
}

function resolveLiveLeaderAgentForSession(ctx, baseRt, sessionId) {
  if (!sessionId) return null;
  const actor = baseRt?.actors?.get?.(sessionId);
  if (actor?.role === 'leader' && actor.agent) return actor.agent;
  if (actor && actor.role !== 'leader') return null;
  const hostAgent = baseRt?.hostAgents?.get?.(sessionId) ?? null;
  if (hostAgent) {
    if (hostAgent.session?.header?.origin === 'subagent') return null;
    return hostAgent;
  }
  if (ctx) {
    try {
      const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
      const cand = agentsSvc?.get?.(sessionId) ?? null;
      if (cand && cand.session?.header?.origin !== 'subagent') return cand;
    } catch {}
  }
  return null;
}

/**
 * Synchronize the DSH host Agent's selected leader model (`agent.model.select(...)`) with LeaderTeam's
 * effective configuration for an idle session so subsequent turns never fall back to a stale selection.
 */
export function syncIdleLeaderAgentModelToEffectiveConfig(ctx, rt = runtime(), sessionId) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config || !sessionId) return { selected: false };
  const liveAgent = resolveLiveLeaderAgentForSession(ctx, baseRt, sessionId);
  if (!liveAgent || typeof liveAgent.model?.select !== 'function') {
    return { selected: false, reason: 'no-live-agent' };
  }
  const effCfg = effectiveSessionConfig(baseRt, sessionId) ?? effectiveRuntimeConfig(baseRt) ?? baseRt.config;
  const leaderRole = effCfg?.roles?.leader;
  if (!leaderRole?.route) return { selected: false, reason: 'no-leader-route' };
  try {
    const tgt = resolveModelTarget(effCfg, leaderRole.route, leaderRole.effort);
    if (!tgt?.provider || !tgt?.model) return { selected: false, reason: 'unresolved-target' };
    const selection = {
      provider: tgt.provider,
      model: tgt.model,
      ...(tgt.reasoningEffort ? { reasoningEffort: tgt.reasoningEffort } : {}),
    };
    liveAgent.model.select(selection);
    return { selected: true, target: selection };
  } catch (err) {
    return { selected: false, error: err };
  }
}

/**
 * Atomically refresh `teams/<storeId>/governance.json` and invalidate cached `teamConfigViews`
 * for an IDLE session on user-initiated configuration changes. Refuses agent calls and refuses
 * to disturb mid-execution sessions unless `forceAtSafeBoundary` is true.
 */
export function rebindTeamGovernanceSnapshot(rt = runtime(), teamId, {
  principal,
  forceAtSafeBoundary = false,
  ctx = null,
  syncAgentModel = false,
} = {}) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config || !baseRt?.storageRoot || !teamId) return { rebound: false, reason: 'uninitialized' };
  const inTool = (baseRt.inFlightToolDispatchesByTeam?.get?.(teamId) ?? 0) > 0;
  const verified = assertUserConfigPrincipal(principal, { inAgentToolDispatch: inTool });
  const busyCheck = inspectSessionBusyForConfig(baseRt, teamId);
  if (busyCheck.busy && !forceAtSafeBoundary) {
    return { rebound: false, busy: true, reasons: busyCheck.reasons };
  }
  let storeId;
  try { storeId = encodeTeamStoreId(teamId, baseRt.storageRoot); } catch { return { rebound: false, reason: 'bad-id' }; }
  const key = `${baseRt.storageRoot}:${storeId}`;
  const govFile = path.join(baseRt.storageRoot, 'teams', storeId, 'governance.json');
  withSessionConfigLock(baseRt.storageRoot, teamId, () => {
    if (fs.existsSync(govFile)) {
      const sessionRec = readSessionConfigRecord(baseRt.storageRoot, teamId);
      const mergedCfg = applySessionPatchToConfig(baseRt.config, sessionRec);
      const cleanCfg = structuredClone(mergedCfg);
      delete cleanCfg.derived;
      let prevCreatedAt = new Date().toISOString();
      try {
        const prev = JSON.parse(fs.readFileSync(govFile, 'utf8'));
        if (prev?.createdAt) prevCreatedAt = prev.createdAt;
      } catch {}
      const nextRecord = {
        v: 1,
        createdAt: prevCreatedAt,
        updatedAt: new Date().toISOString(),
        updatedBy: verified.source,
        sourceSha256: hashJson(cleanCfg),
        config: cleanCfg,
      };
      writeFileAtomic(govFile, JSON.stringify(nextRecord, null, 1));
    }
  });
  baseRt.teamConfigViews?.delete?.(key);
  if (syncAgentModel) {
    syncIdleLeaderAgentModelToEffectiveConfig(ctx, baseRt, teamId);
  }
  return { rebound: true, busy: false };
}

/**
 * Refresh governance snapshots and live DSH leader model selections for all currently IDLE sessions
 * after a User saves global settings, so idle sessions immediately reflect updated roles/models while
 * executing sessions remain protected.
 */
export function rebindAllIdleSessionsOnGlobalUserSave(rt = runtime(), { principal, ctx = null } = {}) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config || !baseRt?.storageRoot) return { reboundIds: [], skippedBusyIds: [] };
  assertUserConfigPrincipal(principal);
  baseRt.lastGlobalUserConfigSaveAtMs = Date.now();
  const candidateIds = new Set([
    ...(baseRt.stores?.keys?.() ?? []),
    ...(baseRt.actors?.keys?.() ?? []),
    ...(baseRt.hostAgents?.keys?.() ?? []),
    ...(baseRt.workbenchCreatedSessionIds ?? []),
  ]);
  if (ctx) {
    try {
      const agentsSvc = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents;
      if (typeof agentsSvc?.keys === 'function') {
        for (const k of agentsSvc.keys()) candidateIds.add(k);
      }
    } catch {}
  }
  const teamsDir = path.join(baseRt.storageRoot, 'teams');
  if (fs.existsSync(teamsDir)) {
    try {
      for (const d of fs.readdirSync(teamsDir, { withFileTypes: true })) {
        if (d.isDirectory()) {
          try { candidateIds.add(resolveTeamStoreLogicalId(baseRt.storageRoot, d.name)); } catch {}
        }
      }
    } catch {}
  }
  const modesDir = path.join(baseRt.storageRoot, 'session-modes');
  if (fs.existsSync(modesDir)) {
    try {
      for (const f of fs.readdirSync(modesDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(modesDir, f), 'utf8'));
          if (typeof parsed?.sessionId === 'string' && parsed.sessionId.trim()) {
            candidateIds.add(parsed.sessionId.trim());
            continue;
          }
        } catch {}
        try {
          candidateIds.add(decodeSessionModeSegment(f.slice(0, -'.json'.length)));
        } catch {}
      }
    } catch {}
  }
  const reboundIds = [];
  const skippedBusyIds = [];
  for (const tid of candidateIds) {
    if (!tid) continue;
    const actor = baseRt.actors?.get?.(tid);
    if (actor && actor.role !== 'leader') continue;
    const res = rebindTeamGovernanceSnapshot(baseRt, tid, {
      principal,
      ctx,
      syncAgentModel: true,
    });
    if (res.rebound) reboundIds.push(tid);
    else if (res.busy) skippedBusyIds.push(tid);
  }
  return { reboundIds, skippedBusyIds };
}

/**
 * When `leaderModelPolicy === "follow"`, synchronize a user's DSH session model / reasoning-effort picker
 * selection into `session-config.json` (only affecting THIS session, never mutating global config).
 * - Idle / pre-dispatch turn boundary: applies immediately.
 * - Mid-execution with active members/tools: stages into `pendingPatch` for the next safe boundary.
 */
export function effectiveSessionConfig(rt = runtime(), sessionId) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config) return null;
  if (!sessionId || !baseRt.storageRoot) return effectiveRuntimeConfig(baseRt) ?? baseRt.config;
  if (TeamStore.exists(baseRt.storageRoot, sessionId)) {
    return runtimeForTeam(sessionId).config;
  }
  const baseCfg = effectiveRuntimeConfig(baseRt) ?? baseRt.config;
  const sessionRec = readSessionConfigRecord(baseRt.storageRoot, sessionId);
  return hasActiveSessionOverride(sessionRec)
    ? applySessionPatchToConfig(baseCfg, sessionRec)
    : baseCfg;
}

function resolveLatestLtConfigChangeMsForSession(baseRt, sessionId) {
  let latestMs = 0;
  if (!baseRt?.storageRoot || !sessionId) return latestMs;
  const sessionRec = readSessionConfigRecord(baseRt.storageRoot, sessionId);
  if (sessionRec?.updatedAt && sessionRec.updatedBy !== 'dsh-host-picker') {
    const t = Date.parse(sessionRec.updatedAt);
    if (Number.isFinite(t) && t > latestMs) latestMs = t;
  }
  if (!hasActiveSessionOverride(sessionRec)) {
    if (Number.isFinite(baseRt.lastGlobalUserConfigSaveAtMs) && baseRt.lastGlobalUserConfigSaveAtMs > latestMs) {
      latestMs = baseRt.lastGlobalUserConfigSaveAtMs;
    }
    try {
      const storeId = encodeTeamStoreId(sessionId, baseRt.storageRoot);
      const govFile = path.join(baseRt.storageRoot, 'teams', storeId, 'governance.json');
      if (fs.existsSync(govFile)) {
        const gov = JSON.parse(fs.readFileSync(govFile, 'utf8'));
        if (gov?.updatedAt && gov.updatedBy !== 'dsh-host-picker') {
          const gt = Date.parse(gov.updatedAt);
          if (Number.isFinite(gt) && gt > latestMs) latestMs = gt;
        }
      }
    } catch {}
    for (const cfgCandidate of [baseRt.configWatch?.localPath, baseRt.configPath]) {
      if (!cfgCandidate) continue;
      try {
        if (fs.existsSync(cfgCandidate)) {
          const st = fs.statSync(cfgCandidate);
          if (Number.isFinite(st.mtimeMs) && st.mtimeMs > latestMs) {
            latestMs = st.mtimeMs;
          }
        }
      } catch {}
    }
  }
  return latestMs;
}

function inspectSessionHostModelSelectionAge(agent) {
  if (typeof agent?.session?.snapshotEvents !== 'function') {
    return { hasSessionEvents: false, hasRecordedSelection: null, lastSelectionMs: null };
  }
  try {
    const evs = agent.session.snapshotEvents();
    if (!Array.isArray(evs)) {
      return { hasSessionEvents: false, hasRecordedSelection: null, lastSelectionMs: null };
    }
    let lastSelectionMs = null;
    let found = false;
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev?.type === 'model/selection') {
        found = true;
        if (typeof ev.time === 'number' && Number.isFinite(ev.time)) {
          lastSelectionMs = ev.time;
        }
        break;
      }
    }
    return { hasSessionEvents: true, hasRecordedSelection: found, lastSelectionMs };
  } catch {
    return { hasSessionEvents: false, hasRecordedSelection: null, lastSelectionMs: null };
  }
}

export function syncSessionLeaderSelectionFromHost(_ctx, rt = runtime(), agent, {
  atUserTurnStart = false,
  allowHostPrologue = false,
} = {}) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config || !baseRt?.storageRoot || !agent?.id) return { synced: false };
  const inFlightCount = baseRt.inFlightToolDispatchesByTeam?.get?.(agent.id) ?? 0;
  if (inFlightCount > (allowHostPrologue ? 1 : 0)) {
    return { synced: false, skippedReason: 'in-tool-dispatch' };
  }
  const teamRt = runtimeForTeam(agent.id);
  const cfg = teamRt.config;
  const policy = cfg?.team?.leaderModelPolicy ?? 'follow';
  if (policy !== 'follow') return { synced: false, policy };

  let sel = null;
  try { sel = agent.model?.current?.() ?? null; } catch { sel = null; }
  if (!sel || typeof sel.provider !== 'string' || !sel.provider.trim() || typeof sel.model !== 'string' || !sel.model.trim()) {
    return { synced: false };
  }

  const target = resolveModelTarget(cfg, cfg.roles.leader.route, cfg.roles.leader.effort);
  const selEffort = typeof sel.reasoningEffort === 'string' && sel.reasoningEffort.trim() ? sel.reasoningEffort.trim() : null;
  const effortMatches = cfg.roles.leader.effort === 'none'
    ? (selEffort === null || selEffort === 'none')
    : (selEffort === null || selEffort === cfg.roles.leader.effort);
  if (sel.provider === target.provider && sel.model === target.model && effortMatches) {
    return { synced: false, alreadyMatched: true };
  }

  // Guard against stale pre-reset / pre-global-save DSH session model selections (or unrecorded host defaults)
  // overwriting newer user-saved LeaderTeam configuration on existing cold or idle sessions.
  const hostSelAge = inspectSessionHostModelSelectionAge(agent);
  if (hostSelAge.hasSessionEvents) {
    const latestLtMs = resolveLatestLtConfigChangeMsForSession(baseRt, agent.id);
    const opts = agent.options;
    const hasExplicitPlainHeadlessModel =
      baseRt.surface === 'headless' &&
      Boolean(opts?.model) &&
      typeof Object.getOwnPropertyDescriptor(opts, 'model')?.get !== 'function';
    const hostSelStale =
      (hostSelAge.hasRecordedSelection === false && !hasExplicitPlainHeadlessModel) ||
      (hostSelAge.lastSelectionMs !== null && latestLtMs > hostSelAge.lastSelectionMs);
    if (hostSelStale) {
      if (typeof agent.model?.select === 'function' && target?.provider && target?.model) {
        try {
          agent.model.select({
            provider: target.provider,
            model: target.model,
            ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
          });
        } catch {}
      }
      return { synced: false, refreshedHostFromLtConfig: true };
    }
  }

  const route = resolveCanonicalRouteFromHostSelection(cfg, sel.provider, sel.model, `${sel.provider}/${sel.model}`);
  const discoveredModels = baseRt.upstreamCatalog?.models ?? [];
  const rawBusy = inspectSessionBusyForConfig(baseRt, agent.id, { ignoreLeaderRunning: atUserTurnStart || allowHostPrologue });
  const effectiveReasons = allowHostPrologue
    ? rawBusy.reasons.filter(r => r !== 'tool_dispatch_in_flight')
    : rawBusy.reasons;
  const busyCheck = { busy: effectiveReasons.length > 0, reasons: effectiveReasons };
  const patch = {
    models: cfg.models?.[route]
      ? {}
      : {
          [route]: {
            provider: sel.provider,
            upstreamModel: sel.model,
            label: sel.model.split('/').pop() || sel.model,
            efforts: selEffort && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(selEffort)
              ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
              : ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: selEffort || 'high',
          },
        },
    roles: {
      leader: {
        route,
        ...(selEffort ? { effort: selEffort } : {}),
      },
    },
  };

  try {
    const mut = mutateSessionConfig({
      storageRoot: baseRt.storageRoot,
      sessionId: agent.id,
      baseConfig: baseRt.config,
      patch,
      action: 'merge',
      principal: { kind: 'user', source: 'dsh-host-picker' },
      isBusy: busyCheck.busy,
      busyReasons: busyCheck.reasons,
      discoveredModels,
      autoHealPlaceholders: true,
    });
    if (mut.appliedImmediately) {
      rebindTeamGovernanceSnapshot(baseRt, agent.id, {
        principal: { kind: 'user', source: 'dsh-host-picker' },
        forceAtSafeBoundary: true,
      });
    }
    return {
      synced: true,
      appliedImmediately: mut.appliedImmediately,
      stagedForSafeBoundary: mut.stagedForSafeBoundary,
      route,
      effort: selEffort,
    };
  } catch (e) {
    baseRt.logger?.warn?.(`leaderteam: session leader auto-sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    return { synced: false, error: e };
  }
}

/**
 * Flush any staged `pendingPatch` once a session reaches a safe idle boundary (`onLeaderTurnEnd` / `onAgentStatus` / crash recovery).
 */
export function flushPendingSessionConfigAtSafeBoundary(ctx, rt = runtime(), sessionId, {
  ignoreLeaderRunning = false,
} = {}) {
  const baseRt = baseRuntime(rt);
  if (!baseRt?.config || !baseRt?.storageRoot || !sessionId) return { flushed: false };
  const rec = readSessionConfigRecord(baseRt.storageRoot, sessionId);
  if (!hasPendingSessionOverride(rec)) return { flushed: false };
  const busyCheck = inspectSessionBusyForConfig(baseRt, sessionId, { ignoreLeaderRunning });
  if (busyCheck.busy) return { flushed: false, busy: true, reasons: busyCheck.reasons };

  const res = flushPendingSessionConfig({
    storageRoot: baseRt.storageRoot,
    sessionId,
    baseConfig: baseRt.config,
    discoveredModels: baseRt.upstreamCatalog?.models ?? [],
  });
  if (res.flushed) {
    rebindTeamGovernanceSnapshot(baseRt, sessionId, {
      principal: { kind: 'user', source: 'dsh-host-picker' },
      forceAtSafeBoundary: true,
      ctx,
      syncAgentModel: true,
    });
  }
  return res;
}
