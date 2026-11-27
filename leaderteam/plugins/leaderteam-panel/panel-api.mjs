// Host HTTP API handlers for the in-DSH `leaderteam-panel` console.
// Kept free of bare `@deepseek-ai/*` imports so routes can be exercised directly in Node unit tests.
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_CATEGORIES, PLAN_LIFECYCLE_STATES } from '../../core/constants.mjs';
import { TeamStore } from '../../core/store.mjs';
import { checkLeaderModel } from '../../core/models.mjs';
import { computeTimerSnapshot, resolveNowMs } from '../../core/timer.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../../core/plan-archive.mjs';
import { inspectModelConfiguration, applyModelConfigChanges } from '../../core/model-config-writer.mjs';
import { resolveModelTarget } from '../../core/upstream-models.mjs';
import { recentTeamObservability } from '../../host/observability.mjs';
import {
  runtime,
  baseRuntime,
  syncRuntimeConfig,
  activePluginsMap,
  isPluginActive,
  refreshUpstreamCatalog,
  runtimeForTeam,
  teamStore,
  isTeamExecutionStarted,
  rebindUnstartedTeamGovernance,
  rebindAllUnstartedTeams,
  resolveCanonicalRouteFromHostSelection,
} from '../../host/runtime.mjs';
import {
  collectCombinedDiscoveredModels,
  enrichChangesWithDiscoveredProviders,
  syncActiveModelsToDshHost,
} from './public-api.mjs';
import { resolveMagpieGatewayHostProvider } from '../../gateway/index.mjs';

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

function collectLeaderSessionChecks(_ctx, rt) {
  const base = baseRuntime(rt);
  if (!base?.config || !base?.storageRoot) return [];
  const rows = [];
  for (const actor of base.actors?.values() ?? []) {
    if (actor?.role !== 'leader' || !actor.agent) continue;
    try {
      const sessionId = actor.teamId;
      const store = teamStore(sessionId);
      const started = isTeamExecutionStarted(store);
      const teamCfg = runtimeForTeam(sessionId).config;
      const sel = actor.agent.model?.current?.();
      const check = checkLeaderModel(teamCfg, sel);
      rows.push({
        sessionId,
        workspace: actor.cwd ?? null,
        started,
        status: check.status,
        blocked: check.blocked,
        policy: check.policy,
        configured: check.configured,
        actual: check.actual,
        message: check.message ?? null,
      });
    } catch {}
  }
  return rows;
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
  const magpieHostProv = resolveMagpieGatewayHostProvider(rt.config);
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
        source: dm.source ?? (dm.provider === magpieHostProv ? 'magpie' : 'dsh'),
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
    leaderSessionChecks: collectLeaderSessionChecks(ctx, rt),
    timers: collectRecentTeamTimers(rt),
    teams: recentTeamObservability(ctx, rt),
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
        const rawChanges = isPlainObj(body.changes) ? body.changes : {};
        const alignReq = isPlainObj(rawChanges.alignLeaderSession) ? rawChanges.alignLeaderSession : null;
        const cleanRawChanges = { ...rawChanges };
        delete cleanRawChanges.alignLeaderSession;

        if (alignReq?.mode === 'config-to-session' && typeof alignReq.sessionId === 'string') {
          const base = baseRuntime(rt);
          const actor = base.actors?.get(alignReq.sessionId);
          const sel = actor?.agent?.model?.current?.();
          if (!sel || !sel.provider || !sel.model) {
            return errReply('BAD_REQUEST', '无法读取该会话当前所选模型');
          }
          const route = resolveCanonicalRouteFromHostSelection(rt.config, sel.provider, sel.model);
          const spec = rt.config.models?.[route] ?? (discoveredModels ?? []).find(m => m.route === route);
          const effort = sel.reasoningEffort || spec?.defaultEffort || spec?.efforts?.[0] || 'none';
          if (!rt.config.models?.[route]) {
            cleanRawChanges.upsertModels = [
              ...(Array.isArray(cleanRawChanges.upsertModels) ? cleanRawChanges.upsertModels : []),
              {
                route,
                provider: sel.provider,
                upstreamModel: sel.model,
                efforts: Array.isArray(spec?.efforts) && spec.efforts.length ? spec.efforts : [effort],
                defaultEffort: effort,
                enableInPool: false,
              },
            ];
          }
          cleanRawChanges.setRoles = [
            ...(Array.isArray(cleanRawChanges.setRoles) ? cleanRawChanges.setRoles.filter(r => r?.role !== 'leader') : []),
            { role: 'leader', route, effort },
          ];
        }

        const changes = enrichChangesWithDiscoveredProviders(cleanRawChanges, rt.config, discoveredModels);
        const hasWriterChanges = Object.keys(changes).length > 0;
        const applyResult = hasWriterChanges
          ? applyModelConfigChanges(changes, {
            configFile: rt.configPath,
            target,
            dryRun: Boolean(body.dryRun),
            discoveredModels,
          })
          : null;
        let dshSettingsSync = { synced: false, reason: body.dryRun ? 'dry-run' : 'unchanged' };
        let alignedSession = null;
        const warnings = [...(applyResult?.warnings ?? [])];
        if (!body.dryRun) {
          syncRuntimeConfig(rt);
          if (applyResult) {
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
          rebindAllUnstartedTeams(ctx, rt, { alignBlankSessions: true });
          if (alignReq && typeof alignReq.sessionId === 'string') {
            const base = baseRuntime(rt);
            const actor = base.actors?.get(alignReq.sessionId);
            if (!isTeamExecutionStarted(teamStore(alignReq.sessionId))) {
              rebindUnstartedTeamGovernance(rt, alignReq.sessionId);
            }
            if (alignReq.mode === 'session-to-config' && actor?.agent?.model?.select) {
              const teamCfg = runtimeForTeam(alignReq.sessionId).config;
              const targetSel = resolveModelTarget(teamCfg, teamCfg.roles.leader.route, teamCfg.roles.leader.effort);
              actor.agent.model.select(targetSel);
              alignedSession = { sessionId: alignReq.sessionId, mode: 'session-to-config', selected: targetSel };
            } else if (alignReq.mode === 'config-to-session') {
              alignedSession = { sessionId: alignReq.sessionId, mode: 'config-to-session' };
            }
          }
        }
        const state = await buildPanelStateSnapshot(ctx, rt);
        return okReply({
          applyResult: applyResult ? { ...applyResult, warnings } : null,
          alignedSession,
          shadowedByLocal: applyResult?.shadowedByLocal ?? [],
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
