// Host HTTP API handlers for the in-DSH `leaderteam-panel` console.
// Kept free of bare `@deepseek-ai/*` imports so routes can be exercised directly in Node unit tests.
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_CATEGORIES, PLAN_LIFECYCLE_STATES } from '../../core/constants.mjs';
import { TeamStore } from '../../core/store.mjs';
import { computeTimerSnapshot, resolveNowMs } from '../../core/timer.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../../core/plan-archive.mjs';
import { inspectModelConfiguration, applyModelConfigChanges } from '../../core/model-config-writer.mjs';
import { buildSoloProviderSettingsTemplates } from '../../core/solo-key.mjs';
import { syncUpstreamModelsToDshSettings } from '../../core/upstream-models.mjs';
import { recentTeamObservability } from '../../host/observability.mjs';
import {
  runtime,
  syncRuntimeConfig,
  activePluginsMap,
  isPluginActive,
  refreshUpstreamCatalog,
} from '../../host/runtime.mjs';

export const PANEL_ROUTES = Object.freeze({
  STATE: '/api/leaderteam-panel/state',
  DISCOVER: '/api/leaderteam-panel/discover',
  APPLY: '/api/leaderteam-panel/apply',
  ARCHIVE: '/api/leaderteam-panel/archive',
  RETROSPECT: '/api/leaderteam-panel/retrospect',
  CLEAN: '/api/leaderteam-panel/clean',
});

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function jsonReply(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}

function okReply(value) {
  return jsonReply({ ok: true, value });
}

function errReply(code, message, status = 200) {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

async function parseBody(request) {
  try {
    const raw = await request.json();
    return isPlainObj(raw) ? raw : {};
  } catch {
    return {};
  }
}

function openArchiveForPanel(rt) {
  if (!rt?.config || !rt?.storageRoot || rt.config.planArchive?.enabled === false) return null;
  const root = resolvePlanArchiveRoot({
    config: rt.config,
    storageRoot: rt.storageRoot,
    workspaceRoot: null,
  });
  return new PlanArchiveStore(root);
}

function collectRecentTeamTimers(rt, maxTeams = 30) {
  if (!rt?.storageRoot || !rt?.config) return [];
  const teamsDir = path.join(rt.storageRoot, 'teams');
  if (!fs.existsSync(teamsDir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(teamsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return [];
  }
  const nowMs = resolveNowMs();
  const rows = [];
  for (const dirent of entries.slice(0, maxTeams * 2)) {
    try {
      const store = new TeamStore(rt.storageRoot, dirent.name);
      const tState = store.readTimerState();
      if (!tState) continue;
      const snap = computeTimerSnapshot(tState, rt.config, {
        taskSeq: tState.currentTaskSeq ?? 1,
        nowMs,
      });
      rows.push({
        teamId: dirent.name,
        workspace: tState.workspace ?? null,
        lastActivityAtMs: tState.lastActivityAtMs ?? 0,
        ...snap,
      });
    } catch {}
  }
  rows.sort((a, b) => (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0));
  return rows.slice(0, maxTeams);
}

export async function buildPanelStateSnapshot(ctx, rt = runtime(), { probeEndpoints = false, forceDiscover = false } = {}) {
  syncRuntimeConfig(rt);
  if (!rt?.config || !rt?.configPath) {
    throw new Error('LeaderTeam core runtime is not initialized');
  }
  const catalog = await refreshUpstreamCatalog(ctx, rt, {
    force: forceDiscover || probeEndpoints,
    probeEndpoints,
  });
  const configSnapshot = inspectModelConfiguration({
    configFile: rt.configPath,
  });
  const archive = openArchiveForPanel(rt);
  const archiveView = archive
    ? {
      enabled: true,
      root: archive.root,
      stats: archive.getStats(),
      categories: [...PLAN_CATEGORIES],
      lifecycleStates: [...PLAN_LIFECYCLE_STATES],
      recentPlans: archive.listPlans({ limit: 30 }),
    }
    : {
      enabled: false,
      root: null,
      stats: null,
      categories: [...PLAN_CATEGORIES],
      lifecycleStates: [...PLAN_LIFECYCLE_STATES],
      recentPlans: [],
    };

  // Merge configured models + upstream DSH discovered models into a unified selector catalog
  const byRoute = new Map();
  for (const m of configSnapshot.models) {
    byRoute.set(m.route, {
      ...m,
      source: 'configured',
      registeredInDsh: true,
    });
  }
  for (const dm of catalog?.models ?? []) {
    const existing = byRoute.get(dm.route);
    if (existing) {
      if (existing.contextWindow == null && dm.contextWindow != null) existing.contextWindow = dm.contextWindow;
      if (existing.maxTokens == null && (dm.maxTokens ?? dm.defaultMaxTokens) != null) existing.maxTokens = dm.maxTokens ?? dm.defaultMaxTokens;
      continue;
    }
    if (!byRoute.has(dm.route)) {
      byRoute.set(dm.route, {
        route: dm.route,
        provider: dm.provider,
        upstreamModel: dm.upstreamModel,
        family: dm.family,
        label: dm.label,
        efforts: [...dm.efforts],
        defaultEffort: dm.defaultEffort,
        contextWindow: dm.contextWindow ?? null,
        maxTokens: dm.maxTokens ?? dm.defaultMaxTokens ?? null,
        strengths: dm.strengths ?? '',
        quotaWindows: null,
        inExecutionPool: Boolean(rt.config.team?.autoIncludeUpstreamModels !== false && dm.registeredInDsh),
        poolIndex: -1,
        usedByRoles: [],
        overriddenInLocal: false,
        onlyInLocal: false,
        source: dm.source,
        registeredInDsh: dm.registeredInDsh,
      });
    }
  }

  return {
    activePlugins: activePluginsMap(rt),
    cordisCompositionMode: Boolean(rt.cordisCompositionMode),
    storageRoot: rt.storageRoot,
    configSnapshot,
    unifiedModels: [...byRoute.values()],
    upstreamCatalog: catalog ?? { discoveredAt: null, providers: [], models: [], endpointErrors: [] },
    timers: collectRecentTeamTimers(rt),
    teams: recentTeamObservability(ctx,rt),
    archive: archiveView,
  };
}

export function createPanelHandlers(ctx, rt = runtime()) {
  return {
    async state(request) {
      try {
        const body = await parseBody(request);
        const snap = await buildPanelStateSnapshot(ctx, rt, {
          probeEndpoints: Boolean(body.probeEndpoints),
          forceDiscover: Boolean(body.forceDiscover),
        });
        return okReply(snap);
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_STATE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async discover(request) {
      try {
        const body = await parseBody(request);
        const catalog = await refreshUpstreamCatalog(ctx, rt, {
          force: true,
          probeEndpoints: body.probeEndpoints !== false,
        });
        const snap = await buildPanelStateSnapshot(ctx, rt, { forceDiscover: false });
        return okReply({ catalog, state: snap });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_DISCOVER_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async apply(request) {
      try {
        const body = await parseBody(request);
        const reEnablingPanel = body?.changes?.setPlugins?.panel === true;
        if (!reEnablingPanel && !isPluginActive(rt, 'panel')) {
          return errReply('PLUGIN_DISABLED', 'leaderteam-panel plugin is disabled');
        }
        syncRuntimeConfig(rt);
        const catalog = await refreshUpstreamCatalog(ctx, rt, { force: false });
        const target = body.target === 'base' ? 'base' : 'local';
        const changes = isPlainObj(body.changes) ? body.changes : {};
        const applyResult = applyModelConfigChanges(changes, {
          configFile: rt.configPath,
          target,
          dryRun: Boolean(body.dryRun),
          discoveredModels: catalog?.models ?? [],
        });
        let dshSettingsSync = { synced: false, reason: 'dry-run' };
        if (!body.dryRun) {
          syncRuntimeConfig(rt);
          const activeRoutes = new Set([
            ...(applyResult.effective?.executionPool ?? []),
            ...Object.values(applyResult.effective?.roles ?? {}).map(r => r?.route).filter(Boolean),
          ]);
          const discByRoute = new Map((catalog?.models ?? []).map(m => [m.route, m]));
          const toSync = [...activeRoutes]
            .map(route => {
              const spec = applyResult.effective?.models?.[route];
              if (!spec) return null;
              const dm = discByRoute.get(route);
              return {
                route,
                provider: spec.provider ?? rt.config.magpie?.provider ?? 'magpie',
                upstreamModel: spec.upstreamModel ?? route,
                efforts: spec.efforts,
                vision: spec.vision ?? dm?.vision,
                contextWindow: spec.contextWindow ?? dm?.upstreamContextWindow ?? dm?.contextWindow,
                maxTokens: spec.maxTokens ?? dm?.upstreamMaxTokens ?? dm?.maxTokens ?? dm?.defaultMaxTokens,
              };
            })
            .filter(Boolean);
          dshSettingsSync = await syncUpstreamModelsToDshSettings(
            ctx,
            toSync,
            rt.config.magpie?.provider ?? 'magpie',
            { providerTemplates: buildSoloProviderSettingsTemplates(process.env) },
          );
          await refreshUpstreamCatalog(ctx, rt, { force: true });
        }
        const state = await buildPanelStateSnapshot(ctx, rt);
        return okReply({ applyResult, dshSettingsSync, state });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_APPLY_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async archive(request) {
      try {
        const body = await parseBody(request);
        const archive = openArchiveForPanel(rt);
        if (!archive) {
          return errReply('PLAN_ARCHIVE_DISABLED', 'external plan archive is disabled');
        }
        if (typeof body.planId === 'string' && body.planId.trim()) {
          const plan = archive.resolvePlan(body.planId.trim());
          if (!plan) return errReply('NOT_FOUND', `archived plan not found: ${body.planId}`);
          return okReply({ root: archive.root, plan });
        }
        const plans = archive.listPlans({
          workspace: typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null,
          projectKey: typeof body.projectKey === 'string' && body.projectKey.trim() ? body.projectKey.trim() : null,
          category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null,
          lifecycleState: typeof body.lifecycleState === 'string' && body.lifecycleState.trim() ? body.lifecycleState.trim() : null,
          limit: Number.isInteger(body.limit) ? Math.max(1, Math.min(200, body.limit)) : 50,
        });
        return okReply({
          root: archive.root,
          stats: archive.getStats(),
          plans,
        });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_ARCHIVE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async retrospect(request) {
      try {
        const body = await parseBody(request);
        if (typeof body.planId !== 'string' || !body.planId.trim()) {
          return errReply('BAD_REQUEST', 'planId is required');
        }
        const archive = openArchiveForPanel(rt);
        if (!archive) {
          return errReply('PLAN_ARCHIVE_DISABLED', 'external plan archive is disabled');
        }
        const planBefore = archive.resolvePlan(body.planId.trim());
        if (!planBefore) {
          return errReply('NOT_FOUND', `archived plan not found: ${body.planId}`);
        }
        let teamStoreInstance = null;
        if (planBefore.teamId && rt.storageRoot && TeamStore.exists(rt.storageRoot, planBefore.teamId)) {
          teamStoreInstance = new TeamStore(rt.storageRoot, planBefore.teamId);
        }
        const retrospective = archive.createRetrospective(planBefore.planId, {
          teamStoreInstance,
          notes: typeof body.notes === 'string' ? body.notes : '',
        });
        const plan = archive.getPlan(planBefore.planId);
        return okReply({ root: archive.root, retrospective, plan });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_RETROSPECT_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async clean(request) {
      try {
        const body = await parseBody(request);
        const archive = openArchiveForPanel(rt);
        if (!archive) {
          return errReply('PLAN_ARCHIVE_DISABLED', 'external plan archive is disabled');
        }
        const dryRun = body.dryRun !== false;
        const result = archive.cleanPlans({
          projectKey: typeof body.projectKey === 'string' && body.projectKey.trim() ? body.projectKey.trim() : null,
          workspace: typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null,
          category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null,
          olderThanDays: typeof body.olderThanDays === 'number' ? body.olderThanDays : null,
          all: Boolean(body.all),
          dryRun,
          confirm: Boolean(body.confirm),
        });
        return okReply({
          ...result,
          stats: archive.getStats(),
          recentPlans: archive.listPlans({ limit: 30 }),
        });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_CLEAN_FAILED', e instanceof Error ? e.message : String(e));
      }
    },
  };
}

export function registerPanelRoutes(effectScope, connection, ctxForHandlers, rt = runtime()) {
  const register = typeof connection?.fetch?.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : null;
  if (!register) return false;
  const handlers = createPanelHandlers(ctxForHandlers, rt);
  const table = [
    [PANEL_ROUTES.STATE, handlers.state, 'leaderteam-panel:state'],
    [PANEL_ROUTES.DISCOVER, handlers.discover, 'leaderteam-panel:discover'],
    [PANEL_ROUTES.APPLY, handlers.apply, 'leaderteam-panel:apply'],
    [PANEL_ROUTES.ARCHIVE, handlers.archive, 'leaderteam-panel:archive'],
    [PANEL_ROUTES.RETROSPECT, handlers.retrospect, 'leaderteam-panel:retrospect'],
    [PANEL_ROUTES.CLEAN, handlers.clean, 'leaderteam-panel:clean'],
  ];
  for (const [routePath, fn, label] of table) {
    effectScope.effect(
      () => register({ path: routePath, methods: ['POST'], requestBody: 'buffered', fetch: fn }),
      label,
    );
  }
  return true;
}
