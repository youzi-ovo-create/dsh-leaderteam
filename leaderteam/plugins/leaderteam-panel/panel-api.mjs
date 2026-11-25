// Host HTTP API handlers for the in-DSH `leaderteam-panel` console.
// Kept free of bare `@deepseek-ai/*` imports so routes can be exercised directly in Node unit tests.
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_CATEGORIES, PLAN_LIFECYCLE_STATES } from '../../core/constants.mjs';
import { TeamStore } from '../../core/store.mjs';
import { computeTimerSnapshot, resolveNowMs } from '../../core/timer.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../../core/plan-archive.mjs';
import { inspectModelConfiguration, applyModelConfigChanges } from '../../core/model-config-writer.mjs';
import { recentTeamObservability } from '../../host/observability.mjs';
import {
  runtime,
  syncRuntimeConfig,
  activePluginsMap,
  isPluginActive,
  refreshUpstreamCatalog,
} from '../../host/runtime.mjs';
import {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  inspectSessionModeState,
  switchSessionExecutionMode,
} from '../../host/mode-controller.mjs';
import {
  collectCombinedDiscoveredModels,
  collectKnownSessionModeItems,
  resolveHostSessionModeHints,
  syncActiveModelsToDshHost,
} from './public-api.mjs';

export const PANEL_ROUTES = Object.freeze({
  STATE: '/api/leaderteam-panel/state',
  DISCOVER: '/api/leaderteam-panel/discover',
  APPLY: '/api/leaderteam-panel/apply',
  ARCHIVE: '/api/leaderteam-panel/archive',
  RETROSPECT: '/api/leaderteam-panel/retrospect',
  CLEAN: '/api/leaderteam-panel/clean',
  SESSION_MODE: '/api/leaderteam-panel/session-mode',
});

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function jsonReply(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}

function okReply(value) {
  return jsonReply({ ok: true, value });
}

function errReply(code, message, status = 200, details = undefined) {
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

const PANEL_MODE_BAD_CODES = new Set([
  'MODE_NOT_LT_SESSION',
  'BAD_EXECUTION_MODE',
  'BAD_SESSION_ID',
  'SESSION_MODE_PATH_ESCAPE',
]);

function errReplyFromModeError(fallbackCode, e) {
  const code = typeof e?.code === 'string' && e.code ? e.code : fallbackCode;
  let status = Number.isInteger(e?.status) && e.status >= 400 ? e.status : 200;
  if (code === 'MODE_SWITCH_BUSY') status = 409;
  else if (PANEL_MODE_BAD_CODES.has(code) && status < 400) status = 400;
  const includeDetails = code === 'MODE_SWITCH_BUSY' || PANEL_MODE_BAD_CODES.has(code) || e?.details !== undefined;
  return errReply(
    code,
    e instanceof Error ? e.message : String(e),
    status,
    includeDetails ? (e?.details ?? null) : undefined,
  );
}

async function parseBody(request) {
  if (!request || request.method === 'GET' || request.method === 'HEAD') return {};
  const ct = String(request.headers?.get?.('content-type') || '').toLowerCase();
  const cl = request.headers?.get?.('content-length');
  const isJsonCt = ct.includes('application/json');
  if (!isJsonCt) {
    if (ct !== '') {
      const err = new Error('POST requests must use Content-Type: application/json');
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      err.status = 415;
      throw err;
    }
    const rawText = await request.text();
    if (rawText.length > 0 || cl !== '0') {
      const err = new Error('POST requests with body must include Content-Type: application/json');
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      err.status = 415;
      throw err;
    }
    return {};
  }
  const rawText = await request.text();
  if (!rawText.trim()) return {};
  try {
    const raw = JSON.parse(rawText);
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
  const { dshCatalog: catalog, discoveredModels } = await collectCombinedDiscoveredModels(ctx, rt);
  if (probeEndpoints || forceDiscover) {
    await refreshUpstreamCatalog(ctx, rt, {
      force: true,
      probeEndpoints,
    }).catch(() => null);
  }
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

  // Merge configured models + upstream DSH & live Magpie discovered models into a unified selector catalog
  const byRoute = new Map();
  for (const m of configSnapshot.models) {
    byRoute.set(m.route, {
      ...m,
      source: 'configured',
      registeredInDsh: true,
    });
  }
  for (const dm of discoveredModels ?? catalog?.models ?? []) {
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
        efforts: [...(dm.efforts ?? ['none'])],
        defaultEffort: dm.defaultEffort ?? dm.efforts?.[0] ?? 'none',
        ...(dm.reasoningEfforts ? { reasoningEfforts: { ...dm.reasoningEfforts } } : {}),
        contextWindow: dm.contextWindow ?? null,
        maxTokens: dm.maxTokens ?? dm.defaultMaxTokens ?? null,
        strengths: dm.strengths ?? '',
        quotaWindows: null,
        inExecutionPool: Boolean(rt.config.team?.autoIncludeUpstreamModels !== false && dm.registeredInDsh),
        poolIndex: -1,
        usedByRoles: [],
        overriddenInLocal: false,
        onlyInLocal: false,
        source: dm.source ?? 'magpie',
        registeredInDsh: Boolean(dm.registeredInDsh),
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
    sessionModes: await collectKnownSessionModeItems(ctx, rt),
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
        return errReply(e?.code ?? 'PANEL_STATE_FAILED', e instanceof Error ? e.message : String(e), e?.status ?? 200);
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
        return errReply(e?.code ?? 'PANEL_DISCOVER_FAILED', e instanceof Error ? e.message : String(e), e?.status ?? 200);
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
        const { gwStatus, discoveredModels } = await collectCombinedDiscoveredModels(ctx, rt);
        const target = body.target === 'base' ? 'base' : 'local';
        const changes = isPlainObj(body.changes) ? body.changes : {};
        const applyResult = applyModelConfigChanges(changes, {
          configFile: rt.configPath,
          target,
          dryRun: Boolean(body.dryRun),
          discoveredModels,
        });
        let dshSettingsSync = { synced: false, reason: 'dry-run' };
        const warnings = [...(applyResult.warnings ?? [])];
        if (!body.dryRun) {
          syncRuntimeConfig(rt);
          dshSettingsSync = await syncActiveModelsToDshHost(
            ctx,
            rt,
            applyResult.effective,
            discoveredModels,
            gwStatus,
          );
          if (
            !dshSettingsSync.synced &&
            dshSettingsSync.reason &&
            !['settings-service-unavailable', 'no-host-context'].includes(dshSettingsSync.reason)
          ) {
            warnings.push(`DSH settings live-sync warning: ${dshSettingsSync.reason}`);
          }
          await refreshUpstreamCatalog(ctx, rt, { force: true }).catch(() => null);
        }
        const state = await buildPanelStateSnapshot(ctx, rt);
        return okReply({
          applyResult: {
            ...applyResult,
            warnings,
          },
          shadowedByLocal: applyResult.shadowedByLocal ?? [],
          warnings,
          dshSettingsSync,
          state,
        });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_APPLY_FAILED', e instanceof Error ? e.message : String(e), e?.status ?? 200);
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
        return errReply(e?.code ?? 'PANEL_ARCHIVE_FAILED', e instanceof Error ? e.message : String(e), e?.status ?? 200);
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
        return errReply(e?.code ?? 'PANEL_RETROSPECT_FAILED', e instanceof Error ? e.message : String(e), e?.status ?? 200);
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
        if (!dryRun && body.confirm !== true) {
          return errReply('CONFIRMATION_REQUIRED', 'Destructive plan archive cleanup (dryRun=false) requires confirm=true');
        }
        if (body.olderThanDays !== undefined && body.olderThanDays !== null) {
          if (typeof body.olderThanDays !== 'number' || !Number.isFinite(body.olderThanDays) || body.olderThanDays < 0) {
            return errReply('BAD_REQUEST', 'olderThanDays must be a non-negative finite number');
          }
        }
        const result = archive.cleanPlans({
          projectKey: typeof body.projectKey === 'string' && body.projectKey.trim() ? body.projectKey.trim() : null,
          workspace: typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : null,
          category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null,
          olderThanDays: typeof body.olderThanDays === 'number' ? body.olderThanDays : null,
          all: Boolean(body.all),
          dryRun,
          confirm: body.confirm === true,
        });
        return okReply({
          ...result,
          stats: archive.getStats(),
          recentPlans: archive.listPlans({ limit: 30 }),
        });
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_CLEAN_FAILED', e instanceof Error ? e.message : String(e), e?.status ?? 200);
      }
    },

    async sessionMode(request) {
      try {
        syncRuntimeConfig(rt);
        const body = await parseBody(request);
        const rawAction = typeof body.action === 'string' && body.action.trim()
          ? body.action.trim().toLowerCase()
          : (body.mode !== undefined ? 'set' : (body.sessionId !== undefined ? 'get' : 'list'));

        if (rawAction === 'list') {
          const sessions = await collectKnownSessionModeItems(ctx, rt);
          return okReply({
            defaultMode: DEFAULT_EXECUTION_MODE,
            modes: [...EXECUTION_MODES],
            sessions,
          });
        }

        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (rawAction === 'get') {
          const hints = sessionId ? await resolveHostSessionModeHints(ctx, rt, sessionId) : {};
          const modeState = inspectSessionModeState(ctx, rt, sessionId, hints);
          return okReply({ modeState });
        }

        if (rawAction === 'set') {
          const hints = sessionId ? await resolveHostSessionModeHints(ctx, rt, sessionId) : {};
          const switched = switchSessionExecutionMode(ctx, rt, sessionId, body.mode, {
            ...hints,
            source: 'panel-api',
          });
          const sessions = await collectKnownSessionModeItems(ctx, rt);
          return okReply({
            ...switched,
            sessions,
          });
        }

        return errReply('BAD_ACTION', `Unsupported session-mode action: ${rawAction}`, 400, null);
      } catch (e) {
        return errReplyFromModeError('PANEL_SESSION_MODE_FAILED', e);
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
    [PANEL_ROUTES.SESSION_MODE, handlers.sessionMode, 'leaderteam-panel:session-mode'],
  ];
  for (const [routePath, fn, label] of table) {
    effectScope.effect(
      () => register({ path: routePath, methods: ['POST'], requestBody: 'buffered', fetch: fn }),
      label,
    );
  }
  return true;
}
