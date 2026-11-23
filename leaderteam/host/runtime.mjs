// Process-wide LeaderTeam state shared by the core and lead entries (one instance per process).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig } from '../core/config.mjs';
import { hashJson, deepFreeze } from '../core/canonical.mjs';
import { TeamStore } from '../core/store.mjs';
import { discoverRuntimeModels, enrichConfigModelsFromCatalog, mergeUpstreamModelsIntoConfig } from '../core/upstream-models.mjs';
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
export async function refreshUpstreamCatalog(ctx, rt = runtime(), { force = false, probeEndpoints = false, ttlMs = 3000 } = {}) {
  rt = baseRuntime(rt);
  if (!rt?.config) return null;
  const now = Date.now();
  if (!force && !probeEndpoints && rt.upstreamCatalog && (rt.upstreamCatalog.providers?.length ?? 0) > 0 && (now - (rt.upstreamCatalogAtMs ?? 0)) < ttlMs) {
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
    const cat = await discoverRuntimeModels(effectiveCtx, rt.config, { probeEndpoints });
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
