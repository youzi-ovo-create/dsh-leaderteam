/**
 * Leader Team Public Contract HTTP Backend (`lt.public.v1` · v1.0.0) & `/lt/` Static Asset Server
 *
 * Kept 100% free of bare `@deepseek-ai/*` imports so all handlers run identically:
 * 1. Inside DSH (`dsh web` / Desktop) via `ctx.connection.fetch.register` & `ctx.webServer.register`
 * 2. In standalone companion mode (`bin/lt-ui.mjs`)
 * 3. Directly in Node unit tests
 */

import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TeamStore, readJsonl, writeFileAtomic } from '../../core/store.mjs';
import { frontierView } from '../../core/frontier.mjs';
import { isAutonomousGovernance, replayGovernanceState } from '../../core/governance-protocol.mjs';
import { computeTimerSnapshot, resolveNowMs } from '../../core/timer.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../../core/plan-archive.mjs';
import { inspectModelConfiguration, applyModelConfigChanges, resolveDefaultDshHome } from '../../core/model-config-writer.mjs';
import { buildSoloProviderSettingsTemplates, resolveOrBootstrapConfigPath } from '../../core/solo-key.mjs';
import { resolveModelTarget, syncUpstreamModelsToDshSettings } from '../../core/upstream-models.mjs';
import { hashJson } from '../../core/canonical.mjs';
import { loadConfig } from '../../core/config.mjs';
import {
  runtime,
  baseRuntime,
  bindRuntimeConfigFile,
  syncRuntimeConfig,
  activePluginsMap,
  refreshUpstreamCatalog,
} from '../../host/runtime.mjs';
import { recentTeamObservability } from '../../host/observability.mjs';
import {
  getOrCreateGatewayManager,
  buildPublicProviders,
  buildPublicModelCatalog,
  buildModelUpsertsFromCatalogEntries,
  resolveMagpieGatewayHostProvider,
} from '../../gateway/index.mjs';
import { getOrCreateHengzhangBridge } from '../../usage/index.mjs';
import {
  foldMembers,
  listSessions,
  parseJsonl,
  readSessionFile,
  resolveStorageRoot,
} from '../../../packages/lt-usage/index.mjs';
import { listKnownHomes } from '../../../packages/lt-usage/reader/homes.js';
import pkg from '../../../package.json' with { type: 'json' };

export const CONTRACT_ID = 'lt.public.v1';
export const CONTRACT_VERSION = '1.0.0';

export const PUBLIC_API_ROUTES = Object.freeze({
  CAPABILITIES: '/api/lt/v1/capabilities',
  BUNDLE: '/api/lt/v1/bundle',
  GATEWAY_STATUS: '/api/lt/v1/gateway/status',
  GATEWAY_CONTROL: '/api/lt/v1/gateway/control',
  PROVIDERS_LIST: '/api/lt/v1/providers/list',
  PROVIDERS_MUTATE: '/api/lt/v1/providers/mutate',
  MODELS_CATALOG: '/api/lt/v1/models/catalog',
  MODELS_SYNC_POOL: '/api/lt/v1/models/sync-pool',
  RUNTIME_SNAPSHOT: '/api/lt/v1/runtime/snapshot',
  RUNTIME_CONFIGURE: '/api/lt/v1/runtime/configure',
  WORKBENCH_SESSIONS: '/api/lt/v1/workbench/sessions',
  WORKBENCH_TRANSCRIPT: '/api/lt/v1/workbench/transcript',
  WORKBENCH_CREATE: '/api/lt/v1/workbench/create',
  WORKBENCH_PROMPT: '/api/lt/v1/workbench/prompt',
  WORKBENCH_CANCEL: '/api/lt/v1/workbench/cancel',
  ARCHIVE_QUERY: '/api/lt/v1/archive/query',
  ARCHIVE_ACTION: '/api/lt/v1/archive/action',
  USAGE_STATUS: '/api/lt/v1/usage/status',
  USAGE_OVERVIEW: '/api/lt/v1/usage/overview',
  USAGE_SESSIONS: '/api/lt/v1/usage/sessions',
  USAGE_REPORT: '/api/lt/v1/usage/report',
  USAGE_PRICING: '/api/lt/v1/usage/pricing',
  USAGE_TOGGLE: '/api/lt/v1/usage/toggle',
  UI_PREFERENCES: '/api/lt/v1/ui-preferences',
});

export const PUBLIC_READONLY_API_ROUTES = new Set([
  PUBLIC_API_ROUTES.BUNDLE,
  PUBLIC_API_ROUTES.CAPABILITIES,
  PUBLIC_API_ROUTES.GATEWAY_STATUS,
  PUBLIC_API_ROUTES.PROVIDERS_LIST,
  PUBLIC_API_ROUTES.MODELS_CATALOG,
  PUBLIC_API_ROUTES.RUNTIME_SNAPSHOT,
  PUBLIC_API_ROUTES.WORKBENCH_SESSIONS,
  PUBLIC_API_ROUTES.USAGE_STATUS,
  PUBLIC_API_ROUTES.USAGE_OVERVIEW,
  PUBLIC_API_ROUTES.USAGE_SESSIONS,
]);

export const SUPPORTED_V22_ROLES = Object.freeze([
  { roleId: 'leader', label: '主导代理 (Leader)', description: '任务拆解、滚动规划、成员分派与交付汇总', supportsFallbacks: false, maxFallbacks: 0, required: true },
  { roleId: 'gate', label: '安全门禁 (Safety Gate)', description: '高危指令与越界操作的独立模型复核', supportsFallbacks: true, maxFallbacks: 4, required: true },
  { roleId: 'discussA', label: '对称评审 A (Discuss A)', description: '规划评审与阶段一异步双监督（A 席）', supportsFallbacks: true, maxFallbacks: 4, required: true },
  { roleId: 'discussB', label: '对称评审 B (Discuss B)', description: '规划评审与阶段一异步双监督（B 席）', supportsFallbacks: true, maxFallbacks: 4, required: true },
  { roleId: 'arbiter', label: '仲裁者 (Arbiter)', description: '内部合议庭投票、正式双边会议裁决与停滞复盘', supportsFallbacks: true, maxFallbacks: 4, required: true },
  { roleId: 'serialReviewer', label: '串行质询 (Serial Reviewer)', description: '串行阶段依赖合理性独立质询（防伪串行退化）', supportsFallbacks: true, maxFallbacks: 4, required: false },
  { roleId: 'directExec', label: '直接执行 (Direct Exec)', description: '受控单步轻量直接执行代理', supportsFallbacks: true, maxFallbacks: 4, required: false },
]);

const DEFAULT_CUSTOM_THEME = Object.freeze({
  canvasColor: '#F7F8FA',
  surfaceColor: '#FFFFFF',
  inkColor: '#141619',
  accentColor: '#9C5B2E',
  dangerColor: '#A3263F',
  headingFontMode: 'serif',
  cornerStyle: 'balanced',
  density: 'standard',
});

const DEFAULT_UI_PREFERENCES = Object.freeze({
  theme: 'white',
  customTheme: DEFAULT_CUSTOM_THEME,
  usageAnalyticsEnabled: true,
  autoRefreshMs: 3000,
});

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function okEnvelope(data) {
  return Response.json(
    {
      ok: true,
      contract: CONTRACT_ID,
      contractVersion: CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      data,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

function errEnvelope(code, message, status = 200, retriable = false, extraHeaders = {}) {
  return Response.json(
    {
      ok: false,
      contract: CONTRACT_ID,
      contractVersion: CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      error: { code, message, retriable },
    },
    { status, headers: { 'cache-control': 'no-store', ...extraHeaders } },
  );
}

function httpContractError(code, message, status = 400, headers = null) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  if (headers && typeof headers === 'object') {
    err.headers = headers;
  }
  return err;
}

function errFromException(fallbackCode, e) {
  const status = Number.isInteger(e?.status) && e.status >= 400 ? e.status : 200;
  const code = typeof e?.code === 'string' && e.code ? e.code : fallbackCode;
  const extraHeaders = e?.headers && typeof e.headers === 'object' ? e.headers : {};
  return errEnvelope(code, e instanceof Error ? e.message : String(e), status, false, extraHeaders);
}

async function parseJsonRequest(request, { allowGet = false } = {}) {
  if (!request) return {};
  const method = String(request.method || 'POST').toUpperCase();
  if (allowGet) {
    if (method !== 'POST' && method !== 'GET') {
      throw httpContractError('METHOD_NOT_ALLOWED', 'Only GET and POST are allowed on this read-only endpoint', 405, {
        Allow: 'GET, POST',
      });
    }
    if (method === 'GET') return {};
  } else if (method !== 'POST') {
    throw httpContractError('METHOD_NOT_ALLOWED', 'Mutating API endpoint requires HTTP POST', 405, {
      Allow: 'POST',
    });
  }
  const ct = String(request.headers?.get?.('content-type') || '').toLowerCase();
  const cl = request.headers?.get?.('content-length');
  const isJsonCt = ct.includes('application/json');
  if (!isJsonCt) {
    if (ct !== '') {
      throw httpContractError('UNSUPPORTED_MEDIA_TYPE', 'POST requests must use Content-Type: application/json', 415);
    }
    const rawText = await request.text();
    if (rawText.length > 0 || cl !== '0') {
      throw httpContractError('UNSUPPORTED_MEDIA_TYPE', 'POST requests with body must include Content-Type: application/json', 415);
    }
    return {};
  }
  const rawText = await request.text();
  if (!rawText.trim()) return {};
  try {
    const parsed = JSON.parse(rawText);
    return isPlainObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function enrichProviderPresetsKeyOptional(presets, magpieProvidersPayload) {
  if (!Array.isArray(presets)) return [];
  const rawMap = new Map();
  for (const mp of magpieProvidersPayload?.presets ?? []) {
    if (mp?.id) rawMap.set(mp.id, mp);
  }
  return presets.map(pr => {
    const mp = rawMap.get(pr.vendorId);
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(pr.defaultEndpointUrl || ''));
    const keyOptional = Boolean(pr.keyOptional || mp?.noKey || mp?.keyOptional || isLoopback);
    return keyOptional ? { ...pr, keyOptional: true } : pr;
  });
}

function sanitizeDiscoveredModelsResult(raw) {
  const src = Array.isArray(raw?.models)
    ? raw.models
    : (Array.isArray(raw?.provider?.models) ? raw.provider.models : []);
  const models = src
    .map(m => {
      const id = typeof m === 'string' ? m.trim() : String(m?.id ?? '').trim();
      if (!id) return null;
      const name = typeof m === 'object' && m !== null && typeof m.name === 'string' && m.name.trim()
        ? m.name.trim()
        : id;
      return { id, name };
    })
    .filter(Boolean);
  return { models };
}

function sanitizeTestProviderResult(raw) {
  const list = Array.isArray(raw?.results) ? raw.results : [];
  return {
    results: list.map(r => {
      const rawLat = r?.ms ?? r?.latencyMs ?? 0;
      const latencyMs = Number.isFinite(Number(rawLat)) ? Math.max(0, Math.round(Number(rawLat))) : 0;
      return {
        protocol: String(r?.protocol ?? r?.api ?? ''),
        ok: Boolean(r?.ok),
        status: Number.isFinite(Number(r?.status)) ? Number(r.status) : 0,
        latencyMs,
        ms: latencyMs,
        model: String(r?.model ?? ''),
        ...(r?.error ? { error: String(r.error) } : {}),
      };
    }),
  };
}

function sanitizeOAuthSignInResult(raw) {
  const url = typeof raw?.url === 'string' ? raw.url : (typeof raw?.authUrl === 'string' ? raw.authUrl : '');
  const authUrl = typeof raw?.authUrl === 'string' ? raw.authUrl : url;
  const state = typeof raw?.state === 'string' ? raw.state : (typeof raw?.status === 'string' ? raw.status : '');
  const status = typeof raw?.status === 'string' ? raw.status : state;
  return {
    id: String(raw?.id ?? ''),
    agent: String(raw?.agent ?? ''),
    url,
    authUrl,
    state,
    status,
    pasteCallback: Boolean(raw?.pasteCallback),
    code: String(raw?.code ?? ''),
    error: String(raw?.error ?? ''),
  };
}

function resolveDshHomeFromCtx(ctx, rt) {
  let home = process.env.DSH_HOME || null;
  if (!home) {
    try { home = ctx?.get?.('profileContext')?.home ?? null; } catch {}
  }
  if (!home && rt?.storageRoot) {
    home = path.dirname(rt.storageRoot);
  }
  return home ? path.resolve(home) : resolveDefaultDshHome({});
}

function readUiPreferences(storageRoot) {
  const file = path.join(storageRoot, 'ui-preferences.json');
  try {
    if (!fs.existsSync(file)) return structuredClone(DEFAULT_UI_PREFERENCES);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const theme = ['white', 'dark', 'heluoxu', 'custom'].includes(raw?.theme) ? raw.theme : 'white';
    const ct = isPlainObj(raw?.customTheme) ? raw.customTheme : {};
    return {
      theme,
      customTheme: {
        canvasColor: typeof ct.canvasColor === 'string' ? ct.canvasColor : DEFAULT_CUSTOM_THEME.canvasColor,
        surfaceColor: typeof ct.surfaceColor === 'string' ? ct.surfaceColor : DEFAULT_CUSTOM_THEME.surfaceColor,
        inkColor: typeof ct.inkColor === 'string' ? ct.inkColor : DEFAULT_CUSTOM_THEME.inkColor,
        accentColor: typeof ct.accentColor === 'string' ? ct.accentColor : DEFAULT_CUSTOM_THEME.accentColor,
        dangerColor: typeof ct.dangerColor === 'string' ? ct.dangerColor : DEFAULT_CUSTOM_THEME.dangerColor,
        headingFontMode: ct.headingFontMode === 'sans' ? 'sans' : 'serif',
        cornerStyle: ['sharp', 'balanced', 'pill-cta'].includes(ct.cornerStyle) ? ct.cornerStyle : 'balanced',
        density: ['compact', 'standard', 'comfortable'].includes(ct.density) ? ct.density : 'standard',
      },
      usageAnalyticsEnabled: raw?.usageAnalyticsEnabled !== false,
      autoRefreshMs: Number.isInteger(raw?.autoRefreshMs) && raw.autoRefreshMs >= 1000 ? raw.autoRefreshMs : 3000,
    };
  } catch {
    return structuredClone(DEFAULT_UI_PREFERENCES);
  }
}

function writeUiPreferences(storageRoot, patch) {
  const current = readUiPreferences(storageRoot);
  const next = structuredClone(current);
  if (patch.theme && ['white', 'dark', 'heluoxu', 'custom'].includes(patch.theme)) {
    next.theme = patch.theme;
  }
  if (isPlainObj(patch.customTheme)) {
    for (const k of ['canvasColor', 'surfaceColor', 'inkColor', 'accentColor', 'dangerColor']) {
      if (typeof patch.customTheme[k] === 'string' && /^#[0-9A-Fa-f]{3,8}$/.test(patch.customTheme[k].trim())) {
        next.customTheme[k] = patch.customTheme[k].trim();
      }
    }
    if (['serif', 'sans'].includes(patch.customTheme.headingFontMode)) {
      next.customTheme.headingFontMode = patch.customTheme.headingFontMode;
    }
    if (['sharp', 'balanced', 'pill-cta'].includes(patch.customTheme.cornerStyle)) {
      next.customTheme.cornerStyle = patch.customTheme.cornerStyle;
    }
    if (['compact', 'standard', 'comfortable'].includes(patch.customTheme.density)) {
      next.customTheme.density = patch.customTheme.density;
    }
  }
  if (typeof patch.usageAnalyticsEnabled === 'boolean') {
    next.usageAnalyticsEnabled = patch.usageAnalyticsEnabled;
  }
  if (Number.isInteger(patch.autoRefreshMs) && patch.autoRefreshMs >= 1000 && patch.autoRefreshMs <= 60000) {
    next.autoRefreshMs = patch.autoRefreshMs;
  }
  fs.mkdirSync(storageRoot, { recursive: true });
  writeFileAtomic(path.join(storageRoot, 'ui-preferences.json'), JSON.stringify(next, null, 2) + '\n');
  return next;
}

function getHostService(ctx, key) {
  if (!ctx) return null;
  try {
    if (ctx[key]) return ctx[key];
  } catch {}
  try {
    return ctx.get?.(key) ?? null;
  } catch {
    return null;
  }
}

export function buildCapabilitiesPayload(ctx, rt, { hostKindOverride = null } = {}) {
  const sessionController = getHostService(ctx, 'sessionController');
  const webServer = getHostService(ctx, 'webServer');
  const hostKind = hostKindOverride ?? (webServer ? 'dsh-web' : (ctx ? 'dsh-desktop' : 'standalone'));
  const hasDshWeb = hostKind === 'dsh-web';

  return {
    backendLine: 'v2.2.x-oss',
    backendVersion: pkg.version,
    hostKind,
    frontendSwitch: {
      available: hasDshWeb,
      currentSurface: 'lt-native',
      dshFrontendUrl: hasDshWeb ? '../' : null,
      ltFrontendUrl: hasDshWeb ? './' : '/',
      sharesRuntimeAndSessions: hasDshWeb,
    },
    features: {
      liveSessionRpc: Boolean(sessionController),
      magpieGateway: true,
      magpieManagedLifecycle: true,
      magpieProviderAdmin: true,
      magpieOAuthPassthrough: true,
      directProviders: true,
      externalGateways: true,
      modelPoolWrite: Boolean(rt?.configPath),
      roleConfigWrite: Boolean(rt?.configPath),
      roleFallbacks: true,
      teamObservability: Boolean(rt?.storageRoot),
      rollingFrontier: true,
      governanceConferences: true,
      schedulerTelemetry: true,
      planArchive: rt?.config?.planArchive?.enabled !== false,
      usageAnalytics: true,
      usageOfflineImport: true,
      themePersistence: Boolean(rt?.storageRoot),
    },
    supportedRoles: SUPPORTED_V22_ROLES,
  };
}

function buildRichTeamObservations(ctx, rt, currentGovernanceHash, limit = 12) {
  if (!rt?.storageRoot || !rt?.config) return [];
  const baseObs = recentTeamObservability(ctx, rt, limit);
  const nowMs = resolveNowMs();
  const autonomous = isAutonomousGovernance(rt.config);

  return baseObs.map(obs => {
    const teamId = obs.teamId;
    if (obs.error) {
      return {
        teamId,
        sessionId: teamId,
        title: null,
        status: 'idle',
        taskSeq: 1,
        frozenGovernanceHash: null,
        pendingGovernanceUpdate: false,
        timers: null,
        frontierOverview: null,
        frontierStages: [],
        members: [],
        governanceEvents: [],
        roleReceipts: {},
        gateSummary: { reviews: 0, allow: 0, deny: 0, degraded: 0 },
      };
    }

    const store = new TeamStore(rt.storageRoot, teamId);
    const tState = store.readTimerState();
    const taskSeq = tState?.currentTaskSeq ?? 1;
    const timerSnap = tState
      ? computeTimerSnapshot(tState, rt.config, { taskSeq, nowMs })
      : null;

    let frontier = null;
    try {
      frontier = frontierView(store, taskSeq, { autonomous });
    } catch {}

    let govReplay = null;
    try {
      const govEvents = readJsonl(path.join(store.dir, 'governance.jsonl')).records;
      govReplay = replayGovernanceState(govEvents, taskSeq);
    } catch {}

    let agreements = [];
    try {
      agreements = readJsonl(path.join(store.dir, 'agreements.jsonl')).records;
    } catch {}

    let gateRecords = [];
    try {
      gateRecords = readJsonl(path.join(store.dir, 'gate.jsonl')).records;
    } catch {}

    const checkpointsDir = path.join(store.dir, 'checkpoints');
    const checkpointFiles = fs.existsSync(checkpointsDir)
      ? fs.readdirSync(checkpointsDir).filter(f => f.endsWith('.json'))
      : [];

    const fullMembers = [...store.members().values()].map(m => ({
      memberId: m.childId,
      name: m.name || m.childId.slice(0, 8),
      actorRole: m.actorRole || 'member',
      configuredModel: m.model || 'unknown',
      effort: m.effort || 'none',
      status: m.status || 'unknown',
      stageId: m.stageId ?? null,
      taskSummary: typeof m.task === 'string' ? m.task.slice(0, 200) : null,
      writeScope: Array.isArray(m.writeScope) ? m.writeScope : [],
      hasCheckpoint: checkpointFiles.some(f => f.startsWith(`${m.childId}-`)),
    }));

    const governanceEvents = [];
    if (govReplay?.activeHumanEscalation) {
      governanceEvents.push({
        eventId: govReplay.activeHumanEscalation.escalationId || 'esc-active',
        kind: 'human_escalation',
        status: 'waiting_user',
        summary: govReplay.activeHumanEscalation.reason || '三次一致异议触发人工升级裁决',
        at: govReplay.activeHumanEscalation.at ?? null,
        strikeCount: 3,
      });
    }
    if (govReplay?.activeConference) {
      governanceEvents.push({
        eventId: govReplay.activeConference.conferenceId,
        kind: 'conference',
        status: govReplay.activeConference.status || 'open',
        summary: govReplay.activeConference.initialExpectation || `阶段 ${govReplay.activeConference.stageId || '-'} 正式治理会议`,
        at: govReplay.activeConference.openedAt ?? null,
        strikeCount: govReplay.activeConference.strike,
      });
    }
    for (const sup of (govReplay?.pendingSupervisions ?? []).slice(-4)) {
      governanceEvents.push({
        eventId: sup.slotKey || sup.id || 'deferred-sup',
        kind: 'deferred',
        status: 'deferred_retry',
        summary: `异步双监督单边待重试 (${sup.stageId || 'dispatch'})`,
        at: sup.at ?? null,
      });
    }
    for (const dir of (govReplay?.activeDirectives ?? []).slice(-4)) {
      governanceEvents.push({
        eventId: dir.disputeId || 'directive',
        kind: 'directive',
        status: 'active_directive',
        summary: dir.summary || '仲裁修正指令待核验',
        at: dir.at ?? null,
      });
    }
    for (const agr of agreements.slice(-6)) {
      governanceEvents.push({
        eventId: agr.id || `agr-${governanceEvents.length}`,
        kind: 'agreement',
        status: agr.status || agr.verdict || 'recorded',
        summary: `${agr.kind || 'review'} · 第 ${agr.round ?? 1} 轮 (${agr.status || agr.verdict || 'ok'})`,
        at: agr.at ?? null,
      });
    }

    const frontierStages = (frontier?.stages ?? []).map(s => {
      let execState = 'pending';
      if (s.verification?.status === 'verified' || s.execution_state === 'member_done') execState = 'verified';
      else if (s.execution_state === 'running') execState = 'running';
      else if (s.execution_state === 'paused' || s.execution_state === 'waiting_dependencies') execState = 'blocked';
      else if (s.ready || s.execution_state === 'ready_to_dispatch' || s.execution_state === 'approved_unassigned') execState = 'ready';
      return {
        stageId: s.stage_id,
        title: s.goal ? String(s.goal).slice(0, 120) : s.stage_id,
        stageHash: s.hash,
        ready: Boolean(s.ready),
        executionState: execState,
        dependsOn: Array.isArray(s.depends_on) ? s.depends_on : [],
        writeScope: Array.isArray(s.write_scope) ? s.write_scope : [],
      };
    });

    const roleReceipts = {};
    for (const r of obs.roles ?? []) {
      roleReceipts[r.role] = {
        configuredRoute: r.configured?.route ?? 'unconfigured',
        actualRoutes: r.actualRoutes ?? [],
        calls: r.calls ?? 0,
        degradedCalls: r.degraded ? Math.max(1, r.calls ?? 1) : 0,
        totalTokens: r.tokens?.totalTokens ?? null,
      };
    }

    let allow = 0;
    let deny = 0;
    for (const g of gateRecords) {
      if (g?.decision === 'allow') allow += 1;
      else if (g?.decision === 'deny') deny += 1;
    }

    const hasRunning = fullMembers.some(m => ['starting', 'started', 'running'].includes(m.status));
    const status = govReplay?.phase === 'human_escalation'
      ? 'waiting_user'
      : (govReplay?.phase === 'formal_conference' || govReplay?.phase === 'pausing_for_conference'
        ? 'paused'
        : (hasRunning ? 'active' : (fullMembers.length > 0 ? 'completed' : 'idle')));

    return {
      teamId,
      sessionId: teamId,
      title: frontier?.overview?.goal ? String(frontier.overview.goal).slice(0, 100) : null,
      status,
      taskSeq,
      frozenGovernanceHash: obs.governanceSha256 ?? null,
      pendingGovernanceUpdate: Boolean(obs.governanceSha256 && currentGovernanceHash && obs.governanceSha256 !== currentGovernanceHash),
      timers: timerSnap
        ? {
          projectWallMs: timerSnap.project_wall_ms ?? 0,
          projectActiveMs: timerSnap.project_active_ms ?? 0,
          taskWallMs: timerSnap.task_wall_ms ?? 0,
          planningStagnationMs: timerSnap.planning_stagnation_ms ?? 0,
          timePressure: timerSnap.time_pressure ?? 'normal',
          unapprovedPlanAttempts: timerSnap.unapproved_plan_attempts ?? 0,
        }
        : null,
      frontierOverview: frontier?.overview?.summary || frontier?.overview?.goal || null,
      frontierStages,
      members: fullMembers,
      governanceEvents,
      governancePhase: govReplay?.phase ?? 'normal',
      roleReceipts,
      gateSummary: {
        reviews: gateRecords.length,
        allow,
        deny,
        degraded: Object.values(roleReceipts).reduce((n, x) => n + x.degradedCalls, 0),
      },
      usageSummary: obs.usage ?? null,
    };
  });
}

export async function buildRuntimeSnapshotPayload(ctx, rt) {
  syncRuntimeConfig(rt);
  const cfg = rt.config;
  const configSnap = inspectModelConfiguration({ configFile: rt.configPath });
  const govHash = hashJson({ roles: cfg.roles, gate: cfg.gate, governance: cfg.governance });

  const roleAssignments = {};
  for (const [roleId, rSpec] of Object.entries(cfg.roles ?? {})) {
    if (!rSpec) continue;
    roleAssignments[roleId] = {
      route: rSpec.route,
      effort: rSpec.effort,
      ...(rSpec.maxTokens !== undefined ? { maxTokens: rSpec.maxTokens } : {}),
      ...(rSpec.timeoutMs !== undefined ? { timeoutMs: rSpec.timeoutMs } : {}),
      ...(rSpec.retries !== undefined ? { retries: rSpec.retries } : {}),
      fallback: Array.isArray(rSpec.fallback)
        ? rSpec.fallback.map(f => ({
          route: f.route,
          effort: f.effort,
          ...(f.maxTokens !== undefined ? { maxTokens: f.maxTokens } : {}),
          ...(f.timeoutMs !== undefined ? { timeoutMs: f.timeoutMs } : {}),
          ...(f.retries !== undefined ? { retries: f.retries } : {}),
        }))
        : [],
    };
  }

  let powerState = null;
  try {
    const pFile = path.join(rt.storageRoot, 'power-monitor-state.json');
    if (fs.existsSync(pFile)) powerState = JSON.parse(fs.readFileSync(pFile, 'utf8'));
  } catch {}

  const requestWindows = [];
  try {
    const rwCfg = cfg.requestWindow ?? {};
    const defaultWinMs = Number.isFinite(rwCfg.windowMs) && rwCfg.windowMs > 0 ? rwCfg.windowMs : 5 * 3600 * 1000;
    const softThrottlePct = Number.isFinite(rwCfg.softThrottlePct) ? rwCfg.softThrottlePct : 20;
    const hardPausePct = Number.isFinite(rwCfg.hardPausePct) ? rwCfg.hardPausePct : 5;
    const providerLimits = rwCfg.windowsByProvider ?? rwCfg.providers ?? {};
    const nowTs = Date.now();
    const rwFile = path.join(rt.storageRoot, 'request-window-calls.jsonl');
    const records = fs.existsSync(rwFile) ? readJsonl(rwFile).records : [];
    const tsByProv = new Map();
    for (const r of records) {
      const ts = typeof r.at === 'number' ? r.at : Date.parse(r.at);
      if (Number.isFinite(ts)) {
        const p = r.provider || 'unknown';
        if (!tsByProv.has(p)) tsByProv.set(p, []);
        tsByProv.get(p).push(ts);
      }
    }
    const allProvs = new Set([...tsByProv.keys(), ...Object.keys(providerLimits)]);
    for (const p of allProvs) {
      const entry = providerLimits[p];
      const winMs = (Number.isFinite(entry?.windowMs) && entry.windowMs > 0) ? entry.windowMs : defaultWinMs;
      const cutoff = nowTs - winMs;
      const used = (tsByProv.get(p) ?? []).filter(t => t >= cutoff && t <= nowTs + 2000).length;
      const limit = typeof entry === 'number' && Number.isInteger(entry) && entry > 0
        ? entry
        : (Number.isInteger(entry?.maxRequests) && entry.maxRequests > 0 ? entry.maxRequests : null);
      let tier = 'unbounded';
      if (limit && limit > 0) {
        if (rwCfg.enabled === false) {
          tier = 'normal';
        } else {
          const remPct = Math.max(0, ((limit - used) / limit) * 100);
          tier = remPct <= hardPausePct ? 'paused' : (remPct <= softThrottlePct ? 'throttled' : 'normal');
        }
      }
      requestWindows.push({ provider: p, used5h: used, limit5h: limit, tier });
    }
  } catch {}

  const teams = buildRichTeamObservations(ctx, rt, govHash, 12);
  const activeExecCount = teams.reduce(
    (sum, t) => sum + t.members.filter(m => ['starting', 'started', 'running'].includes(m.status)).length,
    0,
  );

  let archiveView = { enabled: false, root: null, stats: null, recentPlans: [] };
  if (cfg.planArchive?.enabled !== false && rt.storageRoot) {
    try {
      const root = resolvePlanArchiveRoot({ config: cfg, storageRoot: rt.storageRoot, workspaceRoot: null });
      const archive = new PlanArchiveStore(root);
      archiveView = {
        enabled: true,
        root: archive.root,
        stats: archive.getStats(),
        recentPlans: archive.listPlans({ limit: 25 }),
      };
    } catch {}
  }

  return {
    activePlugins: activePluginsMap(rt),
    modelPool: {
      configuredRoutes: Object.keys(cfg.models ?? {}),
      executionPool: [...(cfg.team?.executionPool ?? [])],
      disabledRoutes: [...(cfg.team?.disabledModels ?? [])],
    },
    configuredModelsMap: structuredClone(cfg.models ?? {}),
    leaderModelPolicy: cfg.team?.leaderModelPolicy ?? 'warn',
    localOverrides: configSnap.localOverrides,
    roleAssignments,
    syncState: {
      dshSettingsSynced: Boolean(configSnap.desktopSync?.inSync ?? true),
      patchSynced: Boolean(configSnap.patchSync?.allInSync ?? true),
      governanceHash: govHash,
      desktopSync: configSnap.desktopSync,
      patchSync: configSnap.patchSync,
      localOverrides: configSnap.localOverrides,
    },
    scheduler: {
      maxActiveMembers: cfg.team?.maxActiveMembers ?? 6,
      effectiveCap: rt.scheduler?.lastSnapshot?.effective_cap ?? cfg.team?.maxActiveMembers ?? null,
      activeExecutionMembers: activeExecCount,
      pressureBand: rt.scheduler?.lastSnapshot?.pressure_band ?? 'normal',
    },
    power: {
      enabled: cfg.powerMonitor?.enabled !== false,
      onBattery: typeof powerState?.onBattery === 'boolean' ? powerState.onBattery : null,
      batteryPct: Number.isFinite(powerState?.batteryPct) ? powerState.batteryPct : null,
      latched: Boolean(powerState?.latched),
    },
    timerConfig: structuredClone(cfg.timer ?? {}),
    planArchive: archiveView,
    requestWindows,
    teams,
  };
}

export function encodeDshSegment(value) {
  const s = String(value ?? '');
  if (s === '.') return '~002E';
  if (s === '..') return '~002E~002E';
  return s.replace(/[^A-Za-z0-9._-]/g, ch => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

export function extractReadableMessagesFromRows(rows = []) {
  const messages = [];
  const seenMsgIds = new Set();
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const rawRow = rows[rowIdx];
    const row = rawRow && rawRow.type === 'event' && rawRow.event ? rawRow.event : rawRow;
    if (!row || typeof row !== 'object') continue;
    const seq = Number.isInteger(row.seq)
      ? row.seq
      : (Number.isInteger(rawRow?.seq) ? rawRow.seq : rowIdx);
    const surfaceOp = row.surfaceOp ?? row.data?.surfaceOp ?? rawRow?.surfaceOp ?? null;
    if (surfaceOp === 'seed' || surfaceOp?.op === 'seed') continue;

    // Per DSH 0.2.2-rc.5 `@deepseek-ai/dsh-session/surface` (`isAppendSurfaceEvent`),
    // surface replacements (`{ op: 'replace', startSeq, endSeq }`) are model-context
    // compaction copies only; append-origin events remain the durable human transcript.
    if (
      surfaceOp?.op === 'replace'
      || (surfaceOp !== null && surfaceOp !== undefined && surfaceOp !== 'append')
    ) {
      continue;
    }

    if (row.type === 'user/message') {
      const msg = row.data?.message ?? row.data;
      if (msg?.source?.kind && msg.source.kind !== 'user') continue;
      const id = msg?.id || `u-${seq}`;
      if (seenMsgIds.has(id)) continue;
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      const text = blocks.length > 0
        ? blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
        : (typeof msg?.text === 'string' ? msg.text : '');
      if (!text && blocks.length === 0) continue;
      seenMsgIds.add(id);
      messages.push({
        _seq: seq,
        id,
        role: 'user',
        timeMs: row.time ?? null,
        text: text || '(附件或控制指令)',
        model: null,
        toolCalls: [],
      });
    } else if (row.type === 'assistant/message') {
      const msg = row.data?.message;
      const id = msg?.id || `a-${seq}`;
      if (seenMsgIds.has(id)) continue;
      seenMsgIds.add(id);
      const content = Array.isArray(msg?.content) ? msg.content : [];
      const textParts = [];
      const thinkingParts = [];
      const toolCalls = [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
        else if ((block?.type === 'thinking' || block?.type === 'reasoning') && typeof (block.thinking || block.text) === 'string') {
          thinkingParts.push(block.thinking || block.text);
        } else if (block?.type === 'tool_use' || block?.type === 'tool-call' || block?.type === 'toolCall') {
          toolCalls.push({
            id: block.id || block.toolCallId || `tc-${toolCalls.length}`,
            name: block.name || block.toolName || 'tool',
          });
        }
      }
      messages.push({
        _seq: seq,
        id,
        role: 'assistant',
        timeMs: row.time ?? null,
        text: textParts.join('\n'),
        thinkingPreview: thinkingParts.length ? thinkingParts.join('\n').slice(0, 600) : null,
        model: msg?.source?.model ?? null,
        usage: row.data?.usage ?? null,
        toolCalls,
      });
    }
  }
  return messages.map(({ _seq, ...rest }) => rest);
}

export function findDurableSessionRows(dshHome, sessionId) {
  if (!dshHome || typeof sessionId !== 'string' || !sessionId || sessionId.includes('\0')) return null;
  const sessionsRoot = path.resolve(dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  let realRoot;
  try {
    realRoot = fs.realpathSync(sessionsRoot);
  } catch {
    return null;
  }

  const encodedSeg = encodeDshSegment(sessionId);
  const candidateSegs = [encodedSeg];
  if (
    !/[\\/\0]/.test(sessionId) &&
    sessionId !== '.' &&
    sessionId !== '..' &&
    !sessionId.includes('..') &&
    !candidateSegs.includes(sessionId)
  ) {
    candidateSegs.push(sessionId);
  }

  const tryReadFromParent = parentDir => {
    for (const seg of candidateSegs) {
      for (const filename of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const cand = path.resolve(parentDir, seg, filename);
        if (!cand.startsWith(sessionsRoot + path.sep)) continue;
        if (!fs.existsSync(cand)) continue;
        let realCand;
        try {
          realCand = fs.realpathSync(cand);
        } catch {
          continue;
        }
        if (!realCand.startsWith(realRoot + path.sep)) continue;
        let stat;
        try {
          stat = fs.statSync(realCand);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        if (filename.endsWith('.zstd')) {
          const decoded = readSessionFile(realCand);
          return decoded.rows ?? [];
        }
        return parseJsonl(fs.readFileSync(realCand, 'utf8'));
      }
    }
    return null;
  };

  try {
    const directRows = tryReadFromParent(sessionsRoot);
    if (directRows !== null) return directRows;
    for (const slugDir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!slugDir.isDirectory()) continue;
      const slugPath = path.resolve(sessionsRoot, slugDir.name);
      if (!slugPath.startsWith(sessionsRoot + path.sep)) continue;
      const found = tryReadFromParent(slugPath);
      if (found !== null) return found;
    }
  } catch {}
  return null;
}

export async function collectCombinedDiscoveredModels(ctx, rt, gwMgr = null) {
  const dshCatalog = await refreshUpstreamCatalog(ctx, rt, { force: false }).catch(() => null);
  const effectiveGwMgr = gwMgr ?? (rt?.storageRoot ? getOrCreateGatewayManager(rt.storageRoot) : null);
  let gwStatus = null;
  let gwModels = [];
  if (effectiveGwMgr) {
    gwStatus = await effectiveGwMgr.getStatus().catch(() => null);
    if (gwStatus?.state === 'running') {
      gwModels = await effectiveGwMgr.createClient().listGatewayModels().catch(() => []);
    }
  }
  const magpieEntries = gwModels.length > 0
    ? buildPublicModelCatalog({
      magpieGatewayModels: gwModels,
      effectiveConfig: rt?.config,
      dshDiscoveredModels: [],
    }).filter(e => e.sourceKind === 'magpie')
    : [];
  const magpieHostProv = resolveMagpieGatewayHostProvider(rt?.config);
  const magpieDiscovered = buildModelUpsertsFromCatalogEntries(magpieEntries, {
    defaultMagpieHostProvider: magpieHostProv,
    enableInExecutionPool: false,
  });

  const mergedByRoute = new Map();
  for (const dm of dshCatalog?.models ?? []) {
    if (dm?.route) mergedByRoute.set(dm.route, dm);
  }
  for (const mm of magpieDiscovered) {
    if (!mm?.route) continue;
    const prev = mergedByRoute.get(mm.route);
    if (prev) {
      mergedByRoute.set(mm.route, {
        ...prev,
        ...(mm.reasoningEfforts ? { reasoningEfforts: mm.reasoningEfforts } : {}),
        contextWindow: prev.contextWindow ?? mm.contextWindow ?? null,
        maxTokens: prev.maxTokens ?? mm.maxTokens ?? null,
      });
    } else {
      mergedByRoute.set(mm.route, mm);
    }
  }
  return {
    dshCatalog,
    gwStatus,
    gwModels,
    discoveredModels: [...mergedByRoute.values()],
  };
}

export function enrichChangesWithDiscoveredProviders(changes, rtConfig, discoveredModels = []) {
  if (!isPlainObj(changes) || !Array.isArray(changes.upsertModels) || changes.upsertModels.length === 0) {
    return changes;
  }
  const discByRoute = new Map((discoveredModels ?? []).filter(m => m?.route).map(m => [m.route, m]));
  return {
    ...changes,
    upsertModels: changes.upsertModels.map(item => {
      if (!isPlainObj(item) || typeof item.route !== 'string') return item;
      const route = item.route.trim();
      if (!route || item.provider !== undefined || rtConfig?.models?.[route]?.provider !== undefined) {
        return item;
      }
      const dm = discByRoute.get(route);
      if (!dm?.provider) return item;
      return {
        ...item,
        provider: dm.provider,
        ...(item.upstreamModel === undefined && dm.upstreamModel ? { upstreamModel: dm.upstreamModel } : {}),
      };
    }),
  };
}

export async function syncActiveModelsToDshHost(ctx, rt, effective, discoveredModels = [], gwStatus = null, extraUpserts = []) {
  if (!ctx) return { synced: false, reason: 'no-host-context', updatedProviders: [] };
  const magpieProv = resolveMagpieGatewayHostProvider(effective ?? rt?.config);
  const configuredDefaultProv = effective?.magpie?.provider ?? rt?.config?.magpie?.provider ?? magpieProv;
  const templates = buildSoloProviderSettingsTemplates(process.env);
  const rawGwUrl = gwStatus?.gatewayUrl ?? (rt?.storageRoot ? getOrCreateGatewayManager(rt.storageRoot).getActiveEndpoints()?.gatewayUrl : null);
  if (rawGwUrl) {
    const magpieHeaders = { Authorization: 'Bearer magpie-leaderteam' };
    templates[magpieProv] = {
      displayName: 'Magpie Gateway',
      api: 'openai-completions',
      baseURL: `${rawGwUrl.replace(/\/+$/, '')}/v1`,
      headers: magpieHeaders,
      ...(magpieHeaders.Authorization ? { clearApiKeyEnv: true } : { apiKeyEnv: 'MAGPIE_API_KEY' }),
    };
  }
  const discByRoute = new Map((discoveredModels ?? []).filter(m => m?.route).map(m => [m.route, m]));
  const activeRoutes = new Set([
    ...(effective?.executionPool ?? effective?.team?.executionPool ?? []),
    ...Object.values(effective?.roles ?? {}).flatMap(r => [
      r?.route,
      ...(Array.isArray(r?.fallback) ? r.fallback.map(f => f?.route) : []),
    ]).filter(Boolean),
  ]);
  const byRouteToSync = new Map();
  for (const u of extraUpserts ?? []) {
    if (u?.route) byRouteToSync.set(u.route, u);
  }
  for (const route of activeRoutes) {
    if (byRouteToSync.has(route)) continue;
    const spec = effective?.models?.[route];
    if (!spec) continue;
    const dm = discByRoute.get(route);
    const resolvedProv = spec.provider ?? (route.startsWith(`${magpieProv}/`) ? magpieProv : configuredDefaultProv);
    const resolvedUpstream = spec.upstreamModel
      ?? (resolvedProv === magpieProv && route.startsWith(`${magpieProv}/`)
        ? route.slice(magpieProv.length + 1)
        : route);
    byRouteToSync.set(route, {
      route,
      provider: resolvedProv,
      upstreamModel: resolvedUpstream,
      efforts: spec.efforts,
      ...(spec.reasoningEfforts ? { reasoningEfforts: spec.reasoningEfforts } : (dm?.reasoningEfforts ? { reasoningEfforts: dm.reasoningEfforts } : {})),
      vision: spec.vision ?? dm?.vision,
      contextWindow: spec.contextWindow ?? dm?.upstreamContextWindow ?? dm?.contextWindow,
      maxTokens: spec.maxTokens ?? dm?.upstreamMaxTokens ?? dm?.maxTokens ?? dm?.defaultMaxTokens,
    });
  }
  return syncUpstreamModelsToDshSettings(
    ctx,
    [...byRouteToSync.values()],
    magpieProv,
    { providerTemplates: templates },
  ).catch(err => ({
    synced: false,
    reason: err instanceof Error ? err.message : String(err),
    updatedProviders: [],
  }));
}

function resolveAuthorizedUsageHome(bridge, rawHome) {
  const serverHome = bridge.resolveDshHome();
  if (rawHome === undefined || rawHome === null || String(rawHome).trim() === '') {
    return serverHome;
  }
  const requested = path.resolve(String(rawHome).trim());
  const allowed = new Set([
    path.resolve(serverHome),
    ...listKnownHomes(serverHome).map(h => path.resolve(h)),
  ]);
  for (const h of [...allowed]) {
    try { allowed.add(fs.realpathSync(h)); } catch {}
  }
  let requestedReal = requested;
  try { requestedReal = fs.realpathSync(requested); } catch {}
  if (!allowed.has(requested) && !allowed.has(requestedReal)) {
    throw httpContractError('FORBIDDEN_HOME', 'Reading arbitrary host directory via body.home is forbidden', 403);
  }
  return requested;
}

function discoverStandaloneWorkbenchSessions(dshHome, storageRoot, archivedSet) {
  const bySessionId = new Map();
  const childIds = new Set();
  const teamsRoot = storageRoot ? path.join(path.resolve(storageRoot), 'teams') : null;
  const teamDirs = [];

  if (teamsRoot && fs.existsSync(teamsRoot)) {
    try {
      for (const entry of fs.readdirSync(teamsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!TeamStore.exists(storageRoot, entry.name)) continue;
        teamDirs.push(entry.name);
        try {
          const members = foldMembers(readJsonl(path.join(teamsRoot, entry.name, 'members.jsonl')).records);
          for (const m of members.values()) {
            if (m?.childId) childIds.add(String(m.childId));
          }
        } catch {}
      }
    } catch {}
  }

  if (dshHome && fs.existsSync(path.join(dshHome, 'sessions'))) {
    const listed = listSessions(dshHome, { storageRoot: storageRoot || undefined });
    for (const s of listed) {
      const sid = String(s?.id ?? '').trim();
      if (!sid) continue;
      if (s.isChild) {
        childIds.add(sid);
        continue;
      }
      if (childIds.has(sid) || archivedSet.has(sid)) continue;
      const isTeamSess = s.kind === 'team' || Boolean(storageRoot && TeamStore.exists(storageRoot, sid));
      bySessionId.set(sid, {
        sessionId: sid,
        title: s.title ?? null,
        cwd: s.cwd ?? null,
        agentPreset: isTeamSess ? 'leaderteam' : null,
        updatedAt: s.lastActivityMs ?? s.startedAtMs ?? null,
        isTeam: isTeamSess,
      });
    }
  }

  for (const dirName of teamDirs) {
    const dirPath = path.join(teamsRoot, dirName);
    let teamJson = null;
    try {
      const tf = path.join(dirPath, 'team.json');
      if (fs.existsSync(tf)) teamJson = JSON.parse(fs.readFileSync(tf, 'utf8'));
    } catch {}
    const sid = String(teamJson?.sessionId ?? teamJson?.teamId ?? dirName).trim();
    if (!sid || childIds.has(sid) || archivedSet.has(sid)) continue;
    if (teamJson?.parentSessionId || teamJson?.origin === 'subagent') continue;
    const existing = bySessionId.get(sid);
    if (existing) {
      existing.isTeam = true;
      existing.agentPreset = existing.agentPreset ?? 'leaderteam';
      if (!existing.cwd && (teamJson?.workspace || teamJson?.cwd)) {
        existing.cwd = teamJson.workspace ?? teamJson.cwd;
      }
      if (!existing.title && typeof teamJson?.title === 'string' && teamJson.title.trim()) {
        existing.title = teamJson.title.trim();
      }
      continue;
    }
    let updatedAt = Date.parse(teamJson?.updatedAt ?? teamJson?.createdAt ?? '');
    if (!Number.isFinite(updatedAt)) {
      try {
        updatedAt = Math.round(fs.statSync(dirPath).mtimeMs);
      } catch {
        updatedAt = null;
      }
    }
    bySessionId.set(sid, {
      sessionId: sid,
      title: typeof teamJson?.title === 'string' && teamJson.title.trim() ? teamJson.title.trim() : null,
      cwd: teamJson?.workspace ?? teamJson?.cwd ?? null,
      agentPreset: 'leaderteam',
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
      isTeam: true,
    });
  }

  const sessions = [...bySessionId.values()];
  sessions.sort(
    (a, b) =>
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      String(a.sessionId).localeCompare(String(b.sessionId)),
  );
  return sessions;
}

export function createPublicContractHandlers(ctx, rt = runtime(), options = {}) {
  const getDshHome = () => {
    if (typeof options.dshHome === 'string' && options.dshHome.trim()) {
      return path.resolve(options.dshHome.trim());
    }
    return resolveDshHomeFromCtx(ctx, rt);
  };

  const resolveConfiguredRoot = () => {
    const configuredRoot = typeof rt?.config?.storage?.root === 'string' && rt.config.storage.root.trim()
      ? rt.config.storage.root.trim()
      : null;
    if (configuredRoot) {
      const baseHome = getDshHome() || process.cwd();
      return path.resolve(baseHome, configuredRoot);
    }
    if (options.dshHome) return resolveStorageRoot(path.resolve(options.dshHome));
    const home = getDshHome() || path.join(process.cwd(), '.lt-standalone');
    return resolveStorageRoot(home);
  };

  const getStorageRoot = () => {
    if (!options.dshHome && typeof rt?.storageRoot === 'string' && rt.storageRoot.trim()) {
      return path.resolve(rt.storageRoot);
    }
    return resolveConfiguredRoot();
  };

  const ensureConfigLoaded = () => {
    if (options.configPath && rt?.configPath !== path.resolve(options.configPath)) {
      rt.configPath = path.resolve(options.configPath);
      rt.config = null;
    }
    if (rt?.config && rt?.configPath && fs.existsSync(rt.configPath)) {
      const prevConfiguredRoot = typeof rt.config?.storage?.root === 'string'
        ? rt.config.storage.root.trim()
        : (rt.config?.storage?.root ?? null);
      const syncRes = syncRuntimeConfig(rt);
      const nextConfiguredRoot = typeof rt.config?.storage?.root === 'string'
        ? rt.config.storage.root.trim()
        : (rt.config?.storage?.root ?? null);
      if (!rt.storageRoot || options.dshHome || (syncRes?.reloaded && nextConfiguredRoot !== prevConfiguredRoot)) {
        rt.storageRoot = resolveConfiguredRoot();
      }
      return;
    }
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const dshHome = getDshHome();
    const { configPath } = resolveOrBootstrapConfigPath({
      explicitConfigPath: options.configPath || null,
      dshHome,
      bundledDefaultConfigPath: path.join(repoRoot, 'config', 'leaderteam.config.json'),
    });
    bindRuntimeConfigFile(rt, configPath, loadConfig(configPath));
    if (!rt.storageRoot || options.dshHome || options.configPath) {
      rt.storageRoot = resolveConfiguredRoot();
    }
  };

  const getGatewayMgr = () => getOrCreateGatewayManager(getStorageRoot());
  const getUsageBridge = () => {
    const storageRoot = getStorageRoot();
    const bridge = getOrCreateHengzhangBridge(storageRoot, {
      dshHome: getDshHome(),
      gatewayManager: getGatewayMgr(),
    });
    const prefs = readUiPreferences(storageRoot);
    if (bridge.isEnabled() !== prefs.usageAnalyticsEnabled) {
      bridge.setEnabled(prefs.usageAnalyticsEnabled);
    }
    return bridge;
  };

  return {
    async capabilities(request) {
      try {
        if (request) await parseJsonRequest(request, { allowGet: true });
        ensureConfigLoaded();
        return okEnvelope(buildCapabilitiesPayload(ctx, rt, { hostKindOverride: options.hostKindOverride }));
      } catch (e) {
        return errFromException('CAPABILITIES_ERROR', e);
      }
    },

    async bundle(request) {
      try {
        if (request) await parseJsonRequest(request, { allowGet: true });
        ensureConfigLoaded();
        const storageRoot = getStorageRoot();
        const gwMgr = getGatewayMgr();
        const gateway = await gwMgr.getStatus();
        const client = gwMgr.createClient();
        const [provPayload, gwModels, gwAccounts] = gateway.state === 'running'
          ? await Promise.all([
            client.hasWebAdminAuth() ? client.listProviders().catch(() => null) : Promise.resolve(null),
            client.listGatewayModels().catch(() => []),
            client.listGatewayAccounts().catch(() => []),
          ])
          : [null, [], []];

        const dshCatalog = await refreshUpstreamCatalog(ctx, rt, { force: false }).catch(() => null);
        const dshModels = dshCatalog?.models ?? [];
        const { providers, presets: rawPresets } = buildPublicProviders({
          magpieProvidersPayload: provPayload,
          magpieAccounts: gwAccounts,
          magpieGatewayUrl: gateway.gatewayUrl,
          effectiveConfig: rt.config,
          externalGateways: gwMgr.listExternalGateways(),
          magpieGatewayModels: gwModels,
          dshDiscoveredModels: dshModels,
        });
        const presets = enrichProviderPresetsKeyOptional(rawPresets, provPayload);
        const models = buildPublicModelCatalog({
          magpieGatewayModels: gwModels,
          effectiveConfig: rt.config,
          dshDiscoveredModels: dshModels,
        });
        const runtimeSnap = await buildRuntimeSnapshotPayload(ctx, rt);
        const uiPreferences = readUiPreferences(storageRoot);
        const usageStatus = await getUsageBridge().getStatus();

        return okEnvelope({
          capabilities: buildCapabilitiesPayload(ctx, rt, { hostKindOverride: options.hostKindOverride }),
          gateway,
          providers,
          providerPresets: presets,
          models,
          runtime: runtimeSnap,
          uiPreferences,
          usageStatus,
        });
      } catch (e) {
        return errFromException('BUNDLE_FAILED', e);
      }
    },

    async gatewayStatus(request) {
      try {
        if (request) await parseJsonRequest(request, { allowGet: true });
        const status = await getGatewayMgr().getStatus();
        return okEnvelope(status);
      } catch (e) {
        return errFromException('GATEWAY_STATUS_FAILED', e);
      }
    },

    async gatewayControl(request) {
      try {
        const body = await parseJsonRequest(request);
        const mgr = getGatewayMgr();
        const action = String(body.action || 'health');

        if (action === 'install') {
          const res = await mgr.install({
            sourceBinaryPath: body.binaryPath || null,
            downloadFromUpstream: Boolean(body.downloadFromUpstream),
          });
          return okEnvelope({ result: res, status: await mgr.getStatus() });
        }
        if (action === 'start') {
          const status = await mgr.start({ allocateDynamicPortsIfBusy: body.dynamicPorts !== false });
          return okEnvelope({ status });
        }
        if (action === 'stop') {
          const status = await mgr.stop();
          return okEnvelope({ status });
        }
        if (action === 'restart') {
          const status = await mgr.restart({ allocateDynamicPortsIfBusy: body.dynamicPorts !== false });
          return okEnvelope({ status });
        }
        if (action === 'configure') {
          mgr.configure(body.config || body);
          return okEnvelope({ status: await mgr.getStatus() });
        }
        if (action === 'check-compatibility') {
          const compat = await mgr.checkCompatibility();
          return okEnvelope({ compatibility: compat, status: await mgr.getStatus() });
        }
        if (action === 'rollback') {
          const rb = await mgr.rollback();
          return okEnvelope({ rollback: rb, status: await mgr.getStatus() });
        }
        if (action === 'save-external') {
          const list = mgr.saveExternalGateway(body.gateway || body);
          return okEnvelope({ externalGateways: list, status: await mgr.getStatus() });
        }
        if (action === 'remove-external') {
          const list = mgr.removeExternalGateway(body.id);
          return okEnvelope({ externalGateways: list, status: await mgr.getStatus() });
        }
        return okEnvelope({ status: await mgr.getStatus() });
      } catch (e) {
        return errFromException('GATEWAY_CONTROL_FAILED', e);
      }
    },

    async providersList(request) {
      try {
        if (request) await parseJsonRequest(request, { allowGet: true });
        ensureConfigLoaded();
        const mgr = getGatewayMgr();
        const gwStatus = await mgr.getStatus();
        const client = mgr.createClient();
        const [provPayload, gwModels, accounts, dshCatalog] = await Promise.all([
          gwStatus.state === 'running' && client.hasWebAdminAuth()
            ? client.listProviders().catch(() => null)
            : Promise.resolve(null),
          gwStatus.state === 'running'
            ? client.listGatewayModels().catch(() => [])
            : Promise.resolve([]),
          gwStatus.state === 'running'
            ? client.listGatewayAccounts().catch(() => [])
            : Promise.resolve([]),
          refreshUpstreamCatalog(ctx, rt, { force: false }).catch(() => null),
        ]);
        const res = buildPublicProviders({
          magpieProvidersPayload: provPayload,
          magpieAccounts: provPayload ? [] : accounts,
          magpieGatewayUrl: gwStatus.gatewayUrl,
          effectiveConfig: rt.config,
          externalGateways: mgr.listExternalGateways(),
          magpieGatewayModels: gwModels,
          dshDiscoveredModels: dshCatalog?.models ?? [],
        });
        return okEnvelope({
          ...res,
          presets: enrichProviderPresetsKeyOptional(res.presets, provPayload),
        });
      } catch (e) {
        return errFromException('PROVIDERS_LIST_FAILED', e);
      }
    },

    async providersMutate(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const op = String(body.operation || '');
        const mgr = getGatewayMgr();
        const client = mgr.createClient();

        let operationResult = null;
        if (op === 'save-provider') {
          await client.saveProvider(body.spec || {});
        } else if (op === 'delete-provider') {
          await client.deleteProvider(String(body.id || '').replace(/^magpie:/, ''));
        } else if (op === 'toggle-provider') {
          await client.toggleProvider(String(body.id || '').replace(/^magpie:/, ''), Boolean(body.enabled));
        } else if (op === 'discover-models') {
          const rawDisc = await client.discoverProviderModels(body.probe || {});
          operationResult = sanitizeDiscoveredModelsResult(rawDisc);
        } else if (op === 'refresh-models') {
          const rawRef = await client.refreshSavedProviderModels(String(body.id || '').replace(/^magpie:/, ''));
          operationResult = sanitizeDiscoveredModelsResult(rawRef);
        } else if (op === 'test-provider') {
          const rawTest = await client.testProvider({
            id: String(body.id || '').replace(/^magpie:/, ''),
            account: body.account,
            models: body.models,
          });
          operationResult = sanitizeTestProviderResult(rawTest);
        } else if (op === 'set-routing') {
          await client.setProviderRouting({
            id: String(body.id || '').replace(/^magpie:/, ''),
            route: body.keyRotation,
            sessionAffinity: body.sessionAffinity,
          });
        } else if (op === 'mutate-key') {
          const id = String(body.providerId || body.id || '').replace(/^magpie:/, '');
          const ref = body.credentialId
            ? String(body.credentialId).replace(/^key:/, '')
            : (body.ref !== undefined ? String(body.ref).replace(/^key:/, '') : undefined);
          await client.mutateKey(body.keyAction, {
            id,
            ...(ref ? { ref } : {}),
            ...(Array.isArray(body.refs) ? { refs: body.refs.map(r => String(r).replace(/^key:/, '')) } : {}),
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.key !== undefined ? { key: body.key } : {}),
            ...(body.weight !== undefined ? { weight: Number(body.weight) } : {}),
            ...(body.protocol !== undefined ? { protocol: body.protocol } : {}),
            ...(body.plan !== undefined ? { plan: body.plan } : {}),
          });
          operationResult = { applied: true };
        } else if (op === 'oauth-start') {
          const rawOAuth = await client.startSignIn({ agent: body.agent, linkOnly: true });
          operationResult = sanitizeOAuthSignInResult(rawOAuth);
        } else if (op === 'oauth-status') {
          const rawOAuth = await client.getSignInStatus(body.signInId);
          operationResult = sanitizeOAuthSignInResult(rawOAuth);
        } else if (op === 'oauth-callback') {
          const rawOAuth = await client.submitSignInCallback(body.signInId, body.callbackUrl);
          operationResult = sanitizeOAuthSignInResult(rawOAuth);
        } else if (op === 'oauth-cancel') {
          const rawOAuth = await client.cancelSignIn(body.signInId);
          operationResult = sanitizeOAuthSignInResult(rawOAuth);
        } else if (op === 'mutate-login') {
          await client.mutateLogin(body.loginAction, {
            id: String(body.providerId || body.id || '').replace(/^magpie:/, ''),
            user: body.user,
            ...(body.login ? { login: body.login } : {}),
          });
          operationResult = { applied: true };
        } else {
          return errEnvelope('BAD_OPERATION', `Unknown provider operation: ${op}`);
        }

        const [provPayload, gwModels] = await Promise.all([
          client.hasWebAdminAuth() ? client.listProviders().catch(() => null) : Promise.resolve(null),
          client.listGatewayModels().catch(() => []),
        ]);
        const normalized = buildPublicProviders({
          magpieProvidersPayload: provPayload,
          magpieGatewayUrl: mgr.getActiveEndpoints().gatewayUrl,
          effectiveConfig: rt.config,
          externalGateways: mgr.listExternalGateways(),
          magpieGatewayModels: gwModels,
          dshDiscoveredModels: rt.upstreamCatalog?.models ?? [],
        });
        return okEnvelope({
          operationResult,
          ...normalized,
          presets: enrichProviderPresetsKeyOptional(normalized.presets, provPayload),
        });
      } catch (e) {
        return errFromException('PROVIDERS_MUTATE_FAILED', e);
      }
    },

    async modelsCatalog(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request, { allowGet: true });
        const mgr = getGatewayMgr();
        const gwStatus = await mgr.getStatus();
        const gwModels = gwStatus.state === 'running'
          ? await mgr.createClient().listGatewayModels().catch(() => [])
          : [];
        const dshCatalog = await refreshUpstreamCatalog(ctx, rt, {
          force: Boolean(body.forceRefresh),
          probeEndpoints: Boolean(body.probeEndpoints),
        }).catch(() => null);
        const models = buildPublicModelCatalog({
          magpieGatewayModels: gwModels,
          effectiveConfig: rt.config,
          dshDiscoveredModels: dshCatalog?.models ?? [],
        });
        return okEnvelope({ models });
      } catch (e) {
        return errFromException('MODELS_CATALOG_FAILED', e);
      }
    },

    async modelsSyncPool(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const mgr = getGatewayMgr();
        const { dshCatalog, gwStatus, gwModels, discoveredModels } = await collectCombinedDiscoveredModels(ctx, rt, mgr);
        const fullCatalog = buildPublicModelCatalog({
          magpieGatewayModels: gwModels,
          effectiveConfig: rt.config,
          dshDiscoveredModels: dshCatalog?.models ?? [],
        });

        const selectedIds = Array.isArray(body.entryIds) && body.entryIds.length > 0
          ? new Set(body.entryIds)
          : null;
        const chosen = selectedIds
          ? fullCatalog.filter(e => selectedIds.has(e.entryId))
          : fullCatalog.filter(e => e.sourceKind === 'magpie');

        const upserts = buildModelUpsertsFromCatalogEntries(chosen, {
          defaultMagpieHostProvider: resolveMagpieGatewayHostProvider(rt.config),
          enableInExecutionPool: body.enableInExecutionPool !== false,
        });

        const target = body.target === 'base' ? 'base' : 'local';
        const applyResult = applyModelConfigChanges(
          { upsertModels: upserts },
          { configFile: rt.configPath, target, discoveredModels },
        );
        syncRuntimeConfig(rt);

        const dshSettingsSync = await syncActiveModelsToDshHost(
          ctx,
          rt,
          applyResult.effective,
          discoveredModels,
          gwStatus,
          upserts,
        );
        const warnings = [...(applyResult.warnings ?? [])];
        if (
          ctx &&
          !dshSettingsSync.synced &&
          dshSettingsSync.reason &&
          !['settings-service-unavailable', 'no-host-context'].includes(dshSettingsSync.reason)
        ) {
          warnings.push(`DSH settings live-sync warning: ${dshSettingsSync.reason}`);
        }

        const updatedModels = buildPublicModelCatalog({
          magpieGatewayModels: gwModels,
          effectiveConfig: rt.config,
          dshDiscoveredModels: dshCatalog?.models ?? [],
        });
        return okEnvelope({
          syncedCount: upserts.length,
          dshSettingsSync,
          shadowedByLocal: applyResult.shadowedByLocal ?? [],
          warnings,
          models: updatedModels,
          runtime: await buildRuntimeSnapshotPayload(ctx, rt),
        });
      } catch (e) {
        return errFromException('MODELS_SYNC_FAILED', e);
      }
    },

    async runtimeSnapshot(request) {
      try {
        if (request) await parseJsonRequest(request, { allowGet: true });
        ensureConfigLoaded();
        return okEnvelope(await buildRuntimeSnapshotPayload(ctx, rt));
      } catch (e) {
        return errFromException('RUNTIME_SNAPSHOT_FAILED', e);
      }
    },

    async runtimeConfigure(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const target = body.target === 'base' ? 'base' : 'local';
        const rawChanges = isPlainObj(body.changes) ? body.changes : {};
        const mgr = getGatewayMgr();
        const { gwStatus, discoveredModels } = await collectCombinedDiscoveredModels(ctx, rt, mgr);
        const changes = enrichChangesWithDiscoveredProviders(rawChanges, rt.config, discoveredModels);
        const applyResult = applyModelConfigChanges(changes, {
          configFile: rt.configPath,
          target,
          dryRun: Boolean(body.dryRun),
          discoveredModels,
        });
        let dshSettingsSync = { synced: false, reason: body.dryRun ? 'dry-run' : 'no-host-context', updatedProviders: [] };
        const warnings = [...(applyResult.warnings ?? [])];
        if (!body.dryRun) {
          syncRuntimeConfig(rt);
          if (ctx) {
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
          }
        }
        return okEnvelope({
          applyResult: {
            ...applyResult,
            warnings,
          },
          dshSettingsSync,
          shadowedByLocal: applyResult.shadowedByLocal ?? [],
          warnings,
          runtime: await buildRuntimeSnapshotPayload(ctx, rt),
        });
      } catch (e) {
        return errFromException('RUNTIME_CONFIGURE_FAILED', e);
      }
    },

    /* ==================== Live Workbench / DSH Shared Session RPCs ==================== */

    async workbenchSessions(request) {
      try {
        if (request) await parseJsonRequest(request, { allowGet: true });
        ensureConfigLoaded();
        const sessionController = getHostService(ctx, 'sessionController');
        const workspaceRegistry = getHostService(ctx, 'workspaceRegistry');
        const workspaces = workspaceRegistry?.list?.()?.map(w => ({
          workspaceId: String(w.id),
          path: w.path,
          title: w.title,
          sessionIds: [...(w.sessionIds ?? [])].map(String),
        })) ?? [];

        const rawArchived = typeof workspaceRegistry?.archivedSessionIds === 'function'
          ? workspaceRegistry.archivedSessionIds()
          : workspaceRegistry?.archivedSessionIds;
        const archivedSet = new Set(
          rawArchived && typeof rawArchived[Symbol.iterator] === 'function'
            ? [...rawArchived].map(String)
            : [],
        );

        if (sessionController && typeof sessionController.list === 'function') {
          const ac = new AbortController();
          const listed = await sessionController.list({}, ac.signal);
          const workbenchCreatedSet = rt?.workbenchCreatedSessionIds instanceof Set
            ? rt.workbenchCreatedSessionIds
            : null;
          const sessions = (listed?.items ?? [])
            .filter(item => {
              if (!item) return false;
              const sid = String(item.sessionId ?? item.id ?? '');
              if (!sid) return false;
              if (item.origin === 'subagent') return false;
              if (Boolean(item.parentSessionId)) return false;
              if (item.blank === true && !workbenchCreatedSet?.has(sid)) return false;
              if (archivedSet.has(sid)) return false;
              return true;
            })
            .map(item => {
              const sid = String(item.sessionId ?? item.id);
              return {
                sessionId: sid,
                title: item.projections?.values?.title ?? item.title ?? null,
                cwd: item.cwd ?? null,
                agentPreset: item.projections?.values?.agentPreset ?? item.agentPreset ?? null,
                updatedAt: item.updatedAt ?? item.lastActivityAt ?? null,
                isTeam: TeamStore.exists(rt.storageRoot, sid),
              };
            });
          return okEnvelope({ liveHost: true, workspaces, sessions });
        }

        // Standalone fallback: pure local session + team directory scan (independent of Hengzhang usage toggle)
        const sessions = discoverStandaloneWorkbenchSessions(getDshHome(), getStorageRoot(), archivedSet);
        return okEnvelope({ liveHost: false, workspaces, sessions });
      } catch (e) {
        return errFromException('WORKBENCH_SESSIONS_FAILED', e);
      }
    },

    async workbenchTranscript(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const sessionId = String(body.sessionId || '').trim();
        if (!sessionId) return errEnvelope('BAD_REQUEST', 'sessionId is required');

        const dshHome = getDshHome();
        const sessionController = getHostService(ctx, 'sessionController');
        const sessionsRegistry = getHostService(ctx, 'sessions');

        let rows = rt?.actors?.get?.(sessionId)?.agent?.session?.snapshotEvents?.() ?? null;
        if (!rows || rows.length === 0) {
          const liveSess = sessionsRegistry?.get?.(sessionId);
          rows = liveSess?.snapshotEvents?.() ?? liveSess?.session?.snapshotEvents?.() ?? null;
        }
        if ((!rows || rows.length === 0) && sessionController && typeof sessionController.events === 'function') {
          const ac = new AbortController();
          try {
            let evRes;
            try {
              evRes = await sessionController.events({ address: { kind: 'session', sessionId } }, ac.signal);
            } catch {
              evRes = await sessionController.events({ sessionId }, ac.signal);
            }
            if (Array.isArray(evRes)) rows = evRes;
            else if (Array.isArray(evRes?.events)) rows = evRes.events;
            else if (Array.isArray(evRes?.items)) rows = evRes.items;
          } catch {} finally {
            ac.abort();
          }
        }
        if (!rows || rows.length === 0) {
          rows = findDurableSessionRows(dshHome, sessionId) ?? [];
        }

        let passiveState = null;
        if (sessionController && typeof sessionController.state === 'function') {
          try {
            const ac = new AbortController();
            passiveState = await sessionController.state({ sessionId }, ac.signal);
          } catch {}
        }

        return okEnvelope({
          sessionId,
          passiveState,
          messages: extractReadableMessagesFromRows(rows),
        });
      } catch (e) {
        return errFromException('WORKBENCH_TRANSCRIPT_FAILED', e);
      }
    },

    async workbenchCreate(request) {
      try {
        const body = await parseJsonRequest(request);
        const sessionController = getHostService(ctx, 'sessionController');
        if (!sessionController || typeof sessionController.create !== 'function') {
          return errEnvelope('HOST_UNAVAILABLE', 'Live DSH session controller is only available inside DSH web/desktop runtime');
        }
        const created = await sessionController.create({
          ...(body.workspaceId ? { workspaceId: body.workspaceId } : { cwd: body.cwd || process.cwd() }),
          agentPreset: body.agentPreset || 'leaderteam',
        });
        const createdSid = String(created?.sessionId ?? created?.id ?? '').trim();
        const requestedPreset = body.agentPreset || 'leaderteam';
        const effectivePreset = created?.agentPreset ?? requestedPreset;
        if (createdSid && effectivePreset === 'leaderteam' && !body.model && rt?.config?.roles?.leader?.route) {
          const leaderTarget = resolveModelTarget(
            rt.config,
            rt.config.roles.leader.route,
            rt.config.roles.leader.effort,
          );
          if (leaderTarget?.provider && leaderTarget?.model) {
            const selection = {
              provider: leaderTarget.provider,
              model: leaderTarget.model,
              ...(leaderTarget.reasoningEffort ? { reasoningEffort: leaderTarget.reasoningEffort } : {}),
            };
            let selectedViaController = false;
            if (typeof sessionController.selectModel === 'function') {
              try {
                await sessionController.selectModel({
                  sessionId: createdSid,
                  ...selection,
                });
                selectedViaController = true;
              } catch {}
            }
            if (!selectedViaController) {
              const agentsSvc = getHostService(ctx, 'agents');
              const liveAgent =
                agentsSvc?.get?.(createdSid)
                ?? baseRuntime(rt)?.actors?.get?.(createdSid)?.agent
                ?? null;
              if (typeof liveAgent?.model?.select === 'function') {
                try {
                  liveAgent.model.select(selection);
                } catch {}
              }
            }
          }
        }
        if (createdSid && rt && typeof rt === 'object') {
          if (!(rt.workbenchCreatedSessionIds instanceof Set)) {
            rt.workbenchCreatedSessionIds = new Set();
          }
          if (rt.workbenchCreatedSessionIds.size >= 256) {
            const oldest = rt.workbenchCreatedSessionIds.values().next().value;
            if (oldest !== undefined) rt.workbenchCreatedSessionIds.delete(oldest);
          }
          rt.workbenchCreatedSessionIds.add(createdSid);
        }
        return okEnvelope(created);
      } catch (e) {
        return errFromException('WORKBENCH_CREATE_FAILED', e);
      }
    },

    async workbenchPrompt(request) {
      try {
        const body = await parseJsonRequest(request);
        const sessionController = getHostService(ctx, 'sessionController');
        if (!sessionController || typeof sessionController.prompt !== 'function') {
          return errEnvelope('HOST_UNAVAILABLE', 'Live DSH session controller is not attached');
        }
        const sessionId = String(body.sessionId || '').trim();
        const text = String(body.text || '').trim();
        if (!sessionId || !text) {
          return errEnvelope('BAD_REQUEST', 'sessionId and non-empty text are required');
        }
        const ac = new AbortController();
        const res = await sessionController.prompt(
          {
            requestId: body.requestId || `lt-ui-${crypto.randomUUID()}`,
            sessionId,
            mode: body.mode === 'steer' ? 'steer' : 'queue',
            content: [{ type: 'text', text }],
          },
          ac.signal,
        );
        return okEnvelope(res);
      } catch (e) {
        return errFromException('WORKBENCH_PROMPT_FAILED', e);
      }
    },

    async workbenchCancel(request) {
      try {
        const body = await parseJsonRequest(request);
        const sessionController = getHostService(ctx, 'sessionController');
        if (!sessionController || typeof sessionController.cancel !== 'function') {
          return errEnvelope('HOST_UNAVAILABLE', 'Live DSH session controller is not attached');
        }
        const sessionId = String(body.sessionId || '').trim();
        if (!sessionId) return errEnvelope('BAD_REQUEST', 'sessionId is required');
        const res = await sessionController.cancel({ sessionId });
        return okEnvelope(res);
      } catch (e) {
        return errFromException('WORKBENCH_CANCEL_FAILED', e);
      }
    },

    /* ==================== Plan Archive ==================== */

    async archiveQuery(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        if (rt.config.planArchive?.enabled === false) {
          return okEnvelope({ enabled: false, plans: [] });
        }
        const root = resolvePlanArchiveRoot({ config: rt.config, storageRoot: rt.storageRoot, workspaceRoot: null });
        const archive = new PlanArchiveStore(root);
        if (body.planId) {
          return okEnvelope({ enabled: true, root, plan: archive.resolvePlan(String(body.planId)) });
        }
        return okEnvelope({
          enabled: true,
          root,
          stats: archive.getStats(),
          plans: archive.listPlans({ limit: Number(body.limit) || 40 }),
        });
      } catch (e) {
        return errFromException('ARCHIVE_QUERY_FAILED', e);
      }
    },

    async archiveAction(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        if (rt.config.planArchive?.enabled === false) {
          return errEnvelope('PLAN_ARCHIVE_DISABLED', 'external plan archive is disabled');
        }
        const root = resolvePlanArchiveRoot({ config: rt.config, storageRoot: rt.storageRoot, workspaceRoot: null });
        const archive = new PlanArchiveStore(root);
        if (body.action === 'retrospect') {
          const planBefore = archive.resolvePlan(String(body.planId || ''));
          if (!planBefore) return errEnvelope('NOT_FOUND', `Plan not found: ${body.planId}`);
          const teamStoreInstance = planBefore.teamId && TeamStore.exists(rt.storageRoot, planBefore.teamId)
            ? new TeamStore(rt.storageRoot, planBefore.teamId)
            : null;
          const retrospective = archive.createRetrospective(planBefore.planId, {
            teamStoreInstance,
            notes: typeof body.notes === 'string' ? body.notes : '',
          });
          return okEnvelope({ retrospective, plan: archive.getPlan(planBefore.planId) });
        }
        if (body.action === 'clean') {
          const dryRun = body.dryRun !== false;
          if (!dryRun && body.confirm !== true) {
            return errEnvelope('CONFIRMATION_REQUIRED', 'Destructive plan archive cleanup (dryRun=false) requires confirm=true');
          }
          if (body.olderThanDays !== undefined && body.olderThanDays !== null) {
            if (typeof body.olderThanDays !== 'number' || !Number.isFinite(body.olderThanDays) || body.olderThanDays < 0) {
              return errEnvelope('BAD_REQUEST', 'olderThanDays must be a non-negative finite number');
            }
          }
          const res = archive.cleanPlans({
            olderThanDays: typeof body.olderThanDays === 'number' ? body.olderThanDays : null,
            all: Boolean(body.all),
            dryRun,
            confirm: body.confirm === true,
          });
          return okEnvelope({ ...res, stats: archive.getStats() });
        }
        return errEnvelope('BAD_ACTION', `Unsupported archive action: ${body.action}`);
      } catch (e) {
        return errFromException('ARCHIVE_ACTION_FAILED', e);
      }
    },

    /* ==================== Hengzhang Usage Analytics ==================== */

    async usageStatus(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request, { allowGet: true });
        const bridge = getUsageBridge();
        const safeHome = resolveAuthorizedUsageHome(bridge, body.home);
        return okEnvelope(await bridge.getStatus({ home: safeHome }));
      } catch (e) {
        return errFromException('USAGE_STATUS_FAILED', e);
      }
    },

    async usageOverview(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request, { allowGet: true });
        const bridge = getUsageBridge();
        const safeHome = resolveAuthorizedUsageHome(bridge, body.home);
        return okEnvelope(await bridge.getOverview({ home: safeHome, syncGateway: body.syncGateway !== false }));
      } catch (e) {
        return errFromException('USAGE_OVERVIEW_FAILED', e);
      }
    },

    async usageSessions(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request, { allowGet: true });
        const bridge = getUsageBridge();
        const safeHome = resolveAuthorizedUsageHome(bridge, body.home);
        return okEnvelope(await bridge.getSessions({ home: safeHome, syncGateway: Boolean(body.syncGateway) }));
      } catch (e) {
        return errFromException('USAGE_SESSIONS_FAILED', e);
      }
    },

    async usageReport(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const bridge = getUsageBridge();
        const safeHome = resolveAuthorizedUsageHome(bridge, body.home);
        return okEnvelope(await bridge.getSessionReport({
          sessionId: body.sessionId,
          home: safeHome,
          syncGateway: body.syncGateway !== false,
        }));
      } catch (e) {
        return errFromException('USAGE_REPORT_FAILED', e);
      }
    },

    async usagePricing(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const bridge = getUsageBridge();
        if (body.action === 'reset') {
          return okEnvelope({ pricing: bridge.resetPricing() });
        }
        if (body.pricing) {
          return okEnvelope({ pricing: bridge.savePricing(body.pricing) });
        }
        return okEnvelope({ pricing: bridge.getPricing() });
      } catch (e) {
        return errFromException('USAGE_PRICING_FAILED', e);
      }
    },

    async usageToggle(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const enabled = Boolean(body.enabled);
        const storageRoot = getStorageRoot();
        writeUiPreferences(storageRoot, { usageAnalyticsEnabled: enabled });
        const bridge = getUsageBridge();
        bridge.setEnabled(enabled);
        return okEnvelope(await bridge.getStatus());
      } catch (e) {
        return errFromException('USAGE_TOGGLE_FAILED', e);
      }
    },

    /* ==================== UI Theme & Preferences ==================== */

    async uiPreferences(request) {
      try {
        const storageRoot = getStorageRoot();
        const body = await parseJsonRequest(request);
        if (Object.keys(body).length > 0) {
          const updated = writeUiPreferences(storageRoot, body);
          if (typeof body.usageAnalyticsEnabled === 'boolean') {
            getUsageBridge().setEnabled(body.usageAnalyticsEnabled);
          }
          return okEnvelope(updated);
        }
        return okEnvelope(readUiPreferences(storageRoot));
      } catch (e) {
        return errFromException('UI_PREFS_FAILED', e);
      }
    },
  };
}

/* ==================== Static `/lt/` Dist Serving on DSH WebServer ==================== */

const STATIC_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
});

export function resolveLtWebDistDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'web-dist');
}

export async function serveLtWebStaticRequest(request, { distDir = resolveLtWebDistDir(), mountPrefix = '/lt', authorizeIndex = null } = {}) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  // Redirect `/lt` -> `/lt/` so relative `./assets/...` and `/api/lt/v1/...` always resolve identically
  if (mountPrefix && pathname === mountPrefix) {
    return new Response(null, {
      status: 302,
      headers: { location: `${mountPrefix}/${url.search}` },
    });
  }

  const rawRelPath = mountPrefix && pathname.startsWith(`${mountPrefix}/`)
    ? pathname.slice(mountPrefix.length + 1)
    : pathname.replace(/^\/+/, '');
  let relPath;
  try {
    relPath = decodeURIComponent(rawRelPath);
  } catch {
    return new Response('Bad Request', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  relPath = relPath.replace(/^\/+/, '');
  if (relPath.includes('\0')) {
    return new Response('Bad Request', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (!relPath || relPath === 'index.html') relPath = 'index.html';

  const resolvedDist = path.resolve(distDir);
  let realDist = resolvedDist;
  try {
    if (fs.existsSync(resolvedDist)) realDist = fs.realpathSync(resolvedDist);
  } catch {}
  const target = path.resolve(resolvedDist, relPath);
  if (target !== resolvedDist && !target.startsWith(resolvedDist + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  let lstat = null;
  try {
    lstat = fs.lstatSync(target);
  } catch {}
  if (lstat) {
    let realTarget;
    try {
      realTarget = fs.realpathSync(target);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
    if (realTarget !== realDist && !realTarget.startsWith(realDist + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  const isIndex = relPath === 'index.html';
  let filePath = target;
  if (!isIndex && (!lstat || fs.statSync(filePath).isDirectory())) {
    if (!path.extname(relPath)) {
      // Redirect nested SPA subpaths (`/lt/<subpath>` -> `/lt/`) so relative `./assets/*` and API prefixes never break
      const rootDest = mountPrefix ? `${mountPrefix}/${url.search}` : `/${url.search}`;
      return new Response(null, {
        status: 302,
        headers: { location: rootDest },
      });
    }
    return new Response('Not Found', { status: 404 });
  }

  if (filePath.endsWith('index.html') || isIndex) {
    if (typeof authorizeIndex === 'function') {
      const refusal = authorizeIndex(request);
      if (refusal) return refusal;
    }
    if (!fs.existsSync(filePath)) {
      return new Response('LT Native Frontend dist is not built yet', { status: 503 });
    }
    let realIndex;
    try {
      realIndex = fs.realpathSync(filePath);
    } catch {
      return new Response('LT Native Frontend dist is not built yet', { status: 503 });
    }
    if (realIndex !== realDist && !realIndex.startsWith(realDist + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    const html = await readFile(realIndex, 'utf8');
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const realFile = fs.realpathSync(filePath);
  if (realFile !== realDist && !realFile.startsWith(realDist + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  const bytes = await readFile(realFile);
  const etag = `W/"${crypto.createHash('sha1').update(bytes).digest('base64url')}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
  }
  const mime = STATIC_MIME[path.extname(realFile).toLowerCase()] ?? 'application/octet-stream';
  return new Response(request.method === 'HEAD' ? null : bytes, {
    status: 200,
    headers: {
      'content-type': mime,
      'cache-control': 'no-cache',
      etag,
    },
  });
}

export function registerPublicContractRoutes(scopeCtx, connection, rootCtx, rt = runtime()) {
  if (!connection?.fetch?.register) return;
  const h = createPublicContractHandlers(rootCtx, rt);
  const entries = [
    [PUBLIC_API_ROUTES.CAPABILITIES, h.capabilities],
    [PUBLIC_API_ROUTES.BUNDLE, h.bundle],
    [PUBLIC_API_ROUTES.GATEWAY_STATUS, h.gatewayStatus],
    [PUBLIC_API_ROUTES.GATEWAY_CONTROL, h.gatewayControl],
    [PUBLIC_API_ROUTES.PROVIDERS_LIST, h.providersList],
    [PUBLIC_API_ROUTES.PROVIDERS_MUTATE, h.providersMutate],
    [PUBLIC_API_ROUTES.MODELS_CATALOG, h.modelsCatalog],
    [PUBLIC_API_ROUTES.MODELS_SYNC_POOL, h.modelsSyncPool],
    [PUBLIC_API_ROUTES.RUNTIME_SNAPSHOT, h.runtimeSnapshot],
    [PUBLIC_API_ROUTES.RUNTIME_CONFIGURE, h.runtimeConfigure],
    [PUBLIC_API_ROUTES.WORKBENCH_SESSIONS, h.workbenchSessions],
    [PUBLIC_API_ROUTES.WORKBENCH_TRANSCRIPT, h.workbenchTranscript],
    [PUBLIC_API_ROUTES.WORKBENCH_CREATE, h.workbenchCreate],
    [PUBLIC_API_ROUTES.WORKBENCH_PROMPT, h.workbenchPrompt],
    [PUBLIC_API_ROUTES.WORKBENCH_CANCEL, h.workbenchCancel],
    [PUBLIC_API_ROUTES.ARCHIVE_QUERY, h.archiveQuery],
    [PUBLIC_API_ROUTES.ARCHIVE_ACTION, h.archiveAction],
    [PUBLIC_API_ROUTES.USAGE_STATUS, h.usageStatus],
    [PUBLIC_API_ROUTES.USAGE_OVERVIEW, h.usageOverview],
    [PUBLIC_API_ROUTES.USAGE_SESSIONS, h.usageSessions],
    [PUBLIC_API_ROUTES.USAGE_REPORT, h.usageReport],
    [PUBLIC_API_ROUTES.USAGE_PRICING, h.usagePricing],
    [PUBLIC_API_ROUTES.USAGE_TOGGLE, h.usageToggle],
    [PUBLIC_API_ROUTES.UI_PREFERENCES, h.uiPreferences],
  ];

  scopeCtx.effect(() => {
    const disposers = entries.map(([routePath, fetch]) =>
      connection.fetch.register({
        path: routePath,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch,
      }),
    );
    return () => {
      for (const dispose of disposers) {
        try { dispose?.(); } catch {}
      }
    };
  }, { label: 'leaderteam-public-v1-routes' });
}

export function registerLtNativeFrontendStaticRoute(scopeCtx, webServer, connection) {
  if (!webServer?.register) return;
  const authorizeIndex = request => {
    if (!connection?.authorizeIndex) return undefined;
    const hostHeader = typeof request.headers?.get === 'function'
      ? request.headers.get('host')
      : request.headers?.host;
    const baseOrigin = hostHeader ? `http://${hostHeader}` : 'http://127.0.0.1';
    const synthUrl = new URL(request.url || '/', baseOrigin);
    synthUrl.pathname = '/';
    const synthRequest = new Request(synthUrl.toString(), {
      method: request.method || 'GET',
      headers: request.headers,
    });

    let status = 401;
    const headers = new Headers();
    let body;
    return connection.authorizeIndex(synthRequest, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        if (nextHeaders instanceof Headers) {
          nextHeaders.forEach((v, k) => headers.set(k, v));
        } else if (nextHeaders && typeof nextHeaders === 'object') {
          for (const [k, v] of Object.entries(nextHeaders)) {
            if (Array.isArray(v)) {
              for (const item of v) headers.append(k, String(item));
            } else if (v !== undefined) {
              headers.set(k, String(v));
            }
          }
        }
      },
      end(text) {
        body = text;
      },
    })
      ? undefined
      : new Response(body, { status, headers });
  };

  scopeCtx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: '/lt',
        resource: (request, peer) =>
          serveLtWebStaticRequest(request, {
            mountPrefix: '/lt',
            authorizeIndex: peer === undefined ? authorizeIndex : null,
          }),
      }),
    { label: 'leaderteam-native-frontend-static' },
  );
}
