// Process-wide LeaderTeam state shared by the core and lead entries (one instance per process).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, routeProvider } from '../core/config.mjs';
import { hashJson, deepFreeze } from '../core/canonical.mjs';
import { TeamStore, writeFileAtomic } from '../core/store.mjs';
import { discoverRuntimeModels, enrichConfigModelsFromCatalog, mergeUpstreamModelsIntoConfig, resolveModelTarget } from '../core/upstream-models.mjs';
import { DETACHABLE_PLUGINS } from '../core/constants.mjs';
import { currentPlanRoot } from '../core/current-plan.mjs';

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
  const config = structuredClone(rt.config);
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
  rt.teamConfigViews?.delete(`${rt.storageRoot}:${teamId}`);
  const nextLeaderTarget = resolveModelTarget(rt.config, rt.config.roles.leader.route, rt.config.roles.leader.effort);
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
    if (key.startsWith(prefix)) candidateIds.add(key.slice(prefix.length));
  }
  const teamsDir = path.join(rt.storageRoot, 'teams');
  try {
    if (fs.existsSync(teamsDir)) {
      for (const d of fs.readdirSync(teamsDir, { withFileTypes: true }).slice(0, 60)) {
        if (d.isDirectory()) candidateIds.add(d.name);
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

/** Immutable team governance; execution choices and capacity remain live. */
export function runtimeForTeam(teamId) {
  const rt = runtime();
  if (!teamId || !rt.config || !rt.storageRoot) return rt;
  rt.teamConfigViews ??= new Map();
  const key = `${rt.storageRoot}:${teamId}`;
  let view = rt.teamConfigViews.get(key);
  if (!view) {
    const store = teamStore(teamId);
    fs.mkdirSync(store.dir, { recursive: true });
    const file = path.join(store.dir, 'governance.json');
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`cannot load frozen team governance: ${error.message}`);
      const config = structuredClone(rt.config); delete config.derived;
      record = { v: 1, createdAt: new Date().toISOString(), sourceSha256: hashJson(config), config };
      try { fs.writeFileSync(file, JSON.stringify(record, null, 1), { flag: 'wx' }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    }
    if (record.v !== 1 || hashJson(record.config) !== record.sourceSha256) throw new Error('frozen team governance snapshot is corrupt; refusing to replace it with live defaults');
    view = { snapshot: validateConfig(record.config), sourceSha256: record.sourceSha256, live: null, mixed: null, proxy: null };
    view.proxy = new Proxy(rt, {
      get(target, property, receiver) {
        if (property === BASE_RUNTIME) return target;
        if (property !== 'config') return Reflect.get(target, property, receiver);
        if (view.live !== target.config || view.catalog !== target.upstreamCatalog) {
          const fixed = view.snapshot;
          const live = target.upstreamCatalog
            ? (target.config.team.autoIncludeUpstreamModels === true
              ? mergeUpstreamModelsIntoConfig(target.config, target.upstreamCatalog)
              : enrichConfigModelsFromCatalog(target.config, target.upstreamCatalog))
            : target.config;
          const roleModels = Object.fromEntries(Object.values(fixed.roles).flatMap(role => [role.route, ...(role.fallback ?? []).map(f => f.route)]).filter(route => fixed.models[route]).map(route => {
            const frozenSpec = fixed.models[route];
            const liveSpec = live.models[route];
            const enrichedRoleSpec = liveSpec ? {
              ...frozenSpec,
              ...(frozenSpec.contextWindow === undefined && liveSpec.contextWindow !== undefined ? { contextWindow: liveSpec.contextWindow } : {}),
              ...(frozenSpec.maxTokens === undefined && liveSpec.maxTokens !== undefined ? { maxTokens: liveSpec.maxTokens } : {}),
            } : frozenSpec;
            return [route, enrichedRoleSpec];
          }));
          view.mixed = deepFreeze({ ...fixed,
            models: { ...live.models, ...roleModels },
            team: { ...fixed.team, executionPool: live.team.executionPool, maxActiveMembers: live.team.maxActiveMembers },
            scheduler: live.scheduler,
            timer: live.timer,
            paths: { ...fixed.paths, globalRefRoots: [...new Set([...fixed.paths.globalRefRoots, currentPlanRoot(rt.storageRoot, teamId), ...((fixed.team.rollingPlanning || fixed.governance?.mode === 'autonomous') ? [fileURLToPath(new URL('../../docs/HeLuoDoc/V2.1', import.meta.url))] : [])])] },
            derived: { ...fixed.derived, executionModels: live.models, governanceSha256: view.sourceSha256 },
          });
          view.live = target.config;
          view.catalog = target.upstreamCatalog;
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
  if (!s) { s = new TeamStore(rt.storageRoot, teamId); rt.stores.set(teamId, s); }
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
