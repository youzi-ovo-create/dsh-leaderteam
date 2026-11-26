// Host HTTP API handlers for the in-DSH `leaderteam-panel` console.
// Kept free of bare `@deepseek-ai/*` imports so routes can be exercised directly in Node unit tests.
import fs from 'node:fs';
import path from 'node:path';
import { PLAN_CATEGORIES, PLAN_LIFECYCLE_STATES } from '../../core/constants.mjs';
import { TeamStore, resolveTeamStoreLogicalId } from '../../core/store.mjs';
import { computeTimerSnapshot, resolveNowMs } from '../../core/timer.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../../core/plan-archive.mjs';
import { inspectModelConfiguration, applyModelConfigChanges } from '../../core/model-config-writer.mjs';
import { recentTeamObservability } from '../../host/observability.mjs';
import {
  runtime,
  baseRuntime,
  runtimeForTeam,
  syncRuntimeConfig,
  activePluginsMap,
  isPluginActive,
  refreshUpstreamCatalog,
  inspectSessionBusyForConfig,
  effectiveSessionConfig,
  rebindTeamGovernanceSnapshot,
  rebindAllIdleSessionsOnGlobalUserSave,
} from '../../host/runtime.mjs';
import { resolveModelTarget } from '../../core/upstream-models.mjs';
import {
  readSessionConfigRecord,
  hasActiveSessionOverride,
  hasPendingSessionOverride,
  mutateSessionConfig,
  buildAutoAdoptedLocalOverrideFromDshModels,
} from '../../core/session-config.mjs';
import {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  inspectSessionModeState,
  switchSessionExecutionMode,
} from '../../host/mode-controller.mjs';
import {
  collectCombinedDiscoveredModels,
  collectKnownSessionModeItems,
  enrichChangesWithDiscoveredProviders,
  resolveHostSessionModeHints,
  syncActiveModelsToDshHost,
} from './public-api.mjs';
import { resolveMagpieGatewayHostProvider } from '../../gateway/index.mjs';
import { fileURLToPath } from 'node:url';
import { getHostCompatibilityMatrix } from '../../core/host-compat.mjs';
import {
  UPDATE_TRACKS,
  readInstalledVersionInfo,
  readUpdaterState,
  listSavedBackups,
  checkForUpdates,
  performOneClickUpgrade,
  rollbackToSavedBackup,
} from '../../core/updater.mjs';
import {
  buildOnboardingSnapshot,
  applyQuickOnboardingSetup,
  writePersistedOnboardingRecord,
} from '../../core/onboarding.mjs';

export const PANEL_ROUTES = Object.freeze({
  STATE: '/api/leaderteam-panel/state',
  DISCOVER: '/api/leaderteam-panel/discover',
  APPLY: '/api/leaderteam-panel/apply',
  ARCHIVE: '/api/leaderteam-panel/archive',
  RETROSPECT: '/api/leaderteam-panel/retrospect',
  CLEAN: '/api/leaderteam-panel/clean',
  SESSION_MODE: '/api/leaderteam-panel/session-mode',
  SESSION_CONFIG: '/api/leaderteam-panel/session-config',
  UPDATE: '/api/leaderteam-panel/update',
  ONBOARDING: '/api/leaderteam-panel/onboarding',
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
      const logicalTeamId = resolveTeamStoreLogicalId(rt.storageRoot, dirent.name);
      const store = new TeamStore(rt.storageRoot, logicalTeamId);
      const tState = store.readTimerState();
      if (!tState) continue;
      const snap = computeTimerSnapshot(tState, rt.config, {
        taskSeq: tState.currentTaskSeq ?? 1,
        nowMs,
      });
      rows.push({
        teamId: logicalTeamId,
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

  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const installedInfo = readInstalledVersionInfo(pluginRoot);
  const hostVersion = rt?.hostCompatibility?.toolsVersion ?? null;

  return {
    activePlugins: activePluginsMap(rt),
    cordisCompositionMode: Boolean(rt.cordisCompositionMode),
    storageRoot: rt.storageRoot,
    configSnapshot,
    unifiedModels: [...byRoute.values()],
    upstreamCatalog: catalog ?? { discoveredAt: null, providers: [], models: [], endpointErrors: [] },
    timers: collectRecentTeamTimers(rt),
    teams: recentTeamObservability(ctx,rt),
    sessionModes: (await collectKnownSessionModeItems(ctx, rt)).map(item => {
      if (!item?.sessionId || !rt?.storageRoot) return item;
      const rec = readSessionConfigRecord(rt.storageRoot, item.sessionId);
      const eff = runtimeForTeam(item.sessionId)?.config ?? rt.config;
      return {
        ...item,
        hasSessionConfigOverride: hasActiveSessionOverride(rec),
        hasPendingSessionConfig: hasPendingSessionOverride(rec),
        effectiveLeaderRoute: eff?.roles?.leader?.route ?? null,
        effectiveLeaderEffort: eff?.roles?.leader?.effort ?? null,
      };
    }),
    archive: archiveView,
    hostCompatibility: rt?.hostCompatibility ?? null,
    compatibilityMatrix: getHostCompatibilityMatrix({
      track: installedInfo.track,
      currentHostVersion: hostVersion,
    }),
    updater: {
      installed: installedInfo,
      tracks: Object.values(UPDATE_TRACKS),
      state: rt.storageRoot ? readUpdaterState(rt.storageRoot) : null,
      backups: rt.storageRoot ? listSavedBackups(rt.storageRoot).slice(0, 5) : [],
    },
    onboarding: rt.storageRoot
      ? buildOnboardingSnapshot({
          storageRoot: rt.storageRoot,
          hasLocalOverrides: Boolean(configSnapshot?.localOverrides?.exists),
        })
      : null,
  };
}

export function createPanelHandlers(ctx, rt = runtime(), options = {}) {
  const explicitDshHome = typeof options?.dshHome === 'string' && options.dshHome.trim()
    ? path.resolve(options.dshHome.trim())
    : null;
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
        const changes = enrichChangesWithDiscoveredProviders(rawChanges, rt.config, discoveredModels);
        const applyResult = applyModelConfigChanges(changes, {
          configFile: rt.configPath,
          target,
          dryRun: Boolean(body.dryRun),
          discoveredModels,
          autoAlignRoleEfforts: true,
        });
        let dshSettingsSync = { synced: false, reason: 'dry-run' };
        const warnings = [...(applyResult.warnings ?? [])];
        if (!body.dryRun) {
          syncRuntimeConfig(rt);
          rebindAllIdleSessionsOnGlobalUserSave(rt, {
            principal: { kind: 'user', source: 'panel-api' },
          });
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
          const sessions = await collectKnownSessionModeItems(ctx, rt, explicitDshHome);
          return okReply({
            defaultMode: DEFAULT_EXECUTION_MODE,
            modes: [...EXECUTION_MODES],
            sessions,
          });
        }

        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (rawAction === 'get') {
          const hints = sessionId ? await resolveHostSessionModeHints(ctx, rt, sessionId, explicitDshHome) : {};
          const modeState = inspectSessionModeState(ctx, rt, sessionId, hints);
          return okReply({ modeState });
        }

        if (rawAction === 'set') {
          const hints = sessionId ? await resolveHostSessionModeHints(ctx, rt, sessionId, explicitDshHome) : {};
          const switched = switchSessionExecutionMode(ctx, rt, sessionId, body.mode, {
            ...hints,
            source: 'panel-api',
          });
          const sessions = await collectKnownSessionModeItems(ctx, rt, explicitDshHome);
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

    async sessionConfig(request) {
      try {
        syncRuntimeConfig(rt);
        const body = await parseBody(request);
        const action = String(body.action || 'get').trim().toLowerCase();
        const principal = { kind: 'user', source: 'panel-api' };
        const { gwStatus, discoveredModels } = await collectCombinedDiscoveredModels(ctx, rt);

        if (action === 'auto-adopt-host') {
          const poolCandidates = discoveredModels?.length > 0 ? discoveredModels : [];
          const adopted = buildAutoAdoptedLocalOverrideFromDshModels(poolCandidates);
          if (!adopted) return errReply('NO_USABLE_MODELS', '未发现可用的已连接 DSH 模型，请先在 DSH 设置或新手引导中连接模型。', 400);
          const setRoles = Object.entries(adopted.roles).map(([role, spec]) => ({ role, ...spec }));
          const upsertModels = Object.entries(adopted.models).map(([route, spec]) => ({ route, ...spec }));
          applyModelConfigChanges(
            { upsertModels, poolSet: adopted.team.executionPool, setRoles, leaderModelPolicy: 'follow' },
            { configFile: rt.configPath, target: 'local', discoveredModels, autoAlignRoleEfforts: true },
          );
          syncRuntimeConfig(rt);
          const idleRebind = rebindAllIdleSessionsOnGlobalUserSave(rt, { principal });
          await syncActiveModelsToDshHost(ctx, rt, rt.config, discoveredModels, gwStatus).catch(() => null);
          return okReply({ idleRebind, state: await buildPanelStateSnapshot(ctx, rt) });
        }

        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!sessionId) return errReply('BAD_SESSION_ID', 'sessionId is required', 400);
        const busy = inspectSessionBusyForConfig(rt, sessionId);

        if (action === 'get') {
          const rec = readSessionConfigRecord(rt.storageRoot, sessionId);
          const eff = effectiveSessionConfig(rt, sessionId) ?? rt.config;
          return okReply({
            sessionId,
            hasOverride: hasActiveSessionOverride(rec),
            hasPending: hasPendingSessionOverride(rec),
            isBusy: busy.busy,
            busyReasons: busy.reasons,
            record: rec,
            effective: {
              roles: eff?.roles ?? {},
              executionPool: eff?.team?.executionPool ?? [],
              maxActiveMembers: eff?.team?.maxActiveMembers ?? 6,
              leaderModelPolicy: eff?.team?.leaderModelPolicy ?? 'follow',
            },
          });
        }

        if (action === 'set') {
          const rawPatch = isPlainObj(body.patch) ? body.patch : {};
          const mut = mutateSessionConfig({
            storageRoot: rt.storageRoot,
            sessionId,
            baseConfig: rt.config,
            patch: { ...rawPatch, ...(body.syncAllRolesToLeader ? { syncAllRolesToLeader: true } : {}) },
            action: body.replaceAll ? 'set' : 'merge',
            principal,
            isBusy: busy.busy,
            busyReasons: busy.reasons,
            discoveredModels,
          });
          if (mut.appliedImmediately) {
            rebindTeamGovernanceSnapshot(rt, sessionId, { principal, forceAtSafeBoundary: true });
            const baseRt = baseRuntime(rt);
            const liveAgent = baseRt?.actors?.get?.(sessionId)?.agent ?? baseRt?.hostAgents?.get?.(sessionId) ?? null;
            if (liveAgent && typeof liveAgent.model?.select === 'function' && rawPatch.roles?.leader) {
              try {
                const effCfg = runtimeForTeam(sessionId).config;
                liveAgent.model.select(resolveModelTarget(effCfg, effCfg.roles.leader.route, effCfg.roles.leader.effort));
              } catch {}
            }
          }
          return okReply({
            appliedImmediately: mut.appliedImmediately,
            stagedForSafeBoundary: mut.stagedForSafeBoundary,
            busyReasons: mut.busyReasons,
            state: await buildPanelStateSnapshot(ctx, rt),
          });
        }

        if (action === 'reset') {
          const mut = mutateSessionConfig({
            storageRoot: rt.storageRoot,
            sessionId,
            baseConfig: rt.config,
            action: 'reset',
            principal,
            isBusy: busy.busy,
            busyReasons: busy.reasons,
          });
          if (mut.appliedImmediately) {
            rebindTeamGovernanceSnapshot(rt, sessionId, { principal, forceAtSafeBoundary: true });
          }
          return okReply({
            appliedImmediately: mut.appliedImmediately,
            stagedForSafeBoundary: mut.stagedForSafeBoundary,
            state: await buildPanelStateSnapshot(ctx, rt),
          });
        }

        return errReply('BAD_ACTION', `Unsupported session-config action: ${action}`, 400);
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_SESSION_CONFIG_FAILED', e instanceof Error ? e.message : String(e), e?.statusCode ?? 200);
      }
    },

    async update(request) {
      try {
        syncRuntimeConfig(rt);
        const body = await parseBody(request);
        const action = String(body.action || 'status').trim().toLowerCase();
        const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
        const hostVersion = rt?.hostCompatibility?.toolsVersion ?? null;

        if (action === 'status') {
          return okReply({
            installed: readInstalledVersionInfo(pluginRoot),
            state: readUpdaterState(rt.storageRoot),
            backups: listSavedBackups(rt.storageRoot).slice(0, 5),
          });
        }
        if (action === 'check') {
          const check = await checkForUpdates({
            pluginRoot,
            storageRoot: rt.storageRoot,
            track: body.track || null,
            force: body.force !== false,
            currentHostVersion: hostVersion,
          });
          return okReply({ check, state: readUpdaterState(rt.storageRoot) });
        }
        if (action === 'apply') {
          const result = await performOneClickUpgrade({
            ctx,
            rt,
            pluginRoot,
            storageRoot: rt.storageRoot,
            dshHome: explicitDshHome,
            targetTrack: body.targetTrack || null,
            confirmTrackSwitch: body.confirmTrackSwitch || null,
            localTgzPath: body.localTgzPath || null,
            currentHostVersion: hostVersion,
          });
          return okReply({ result, state: readUpdaterState(rt.storageRoot) });
        }
        if (action === 'rollback') {
          const result = await rollbackToSavedBackup({
            ctx,
            rt,
            storageRoot: rt.storageRoot,
            dshHome: explicitDshHome,
            backupId: body.backupId || null,
          });
          return okReply({ result, state: readUpdaterState(rt.storageRoot) });
        }
        return errReply('BAD_UPDATE_ACTION', `Unsupported update action: ${action}`, 400);
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_UPDATE_FAILED', e instanceof Error ? e.message : String(e), e?.statusCode ?? 200, e?.details);
      }
    },

    async onboarding(request) {
      try {
        syncRuntimeConfig(rt);
        const body = await parseBody(request);
        const action = String(body.action || 'status').trim().toLowerCase();
        const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
        if (action === 'apply-quick-setup') {
          const applied = await applyQuickOnboardingSetup({
            ctx,
            rt,
            storageRoot: rt.storageRoot,
            dshHome: explicitDshHome,
            configPath: rt.configPath,
            bundledDefaultConfigPath: path.join(pluginRoot, 'config', 'leaderteam.config.json'),
            providerId: body.providerId || 'deepseek',
            apiKey: body.apiKey || '',
            collabPresetId: body.collabPresetId || 'balanced-team',
          });
          return okReply(applied);
        }
        if (action === 'dismiss') {
          return okReply(writePersistedOnboardingRecord(rt.storageRoot, { dismissed: true }));
        }
        return okReply(buildOnboardingSnapshot({ storageRoot: rt.storageRoot }));
      } catch (e) {
        return errReply(e?.code ?? 'PANEL_ONBOARDING_FAILED', e instanceof Error ? e.message : String(e), 200);
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
    [PANEL_ROUTES.SESSION_CONFIG, handlers.sessionConfig, 'leaderteam-panel:session-config'],
    [PANEL_ROUTES.UPDATE, handlers.update, 'leaderteam-panel:update'],
    [PANEL_ROUTES.ONBOARDING, handlers.onboarding, 'leaderteam-panel:onboarding'],
  ];
  for (const [routePath, fn, label] of table) {
    effectScope.effect(
      () => register({ path: routePath, methods: ['POST'], requestBody: 'buffered', fetch: fn }),
      label,
    );
  }
  return true;
}
