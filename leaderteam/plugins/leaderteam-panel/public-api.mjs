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
import { syncUpstreamModelsToDshSettings } from '../../core/upstream-models.mjs';
import { hashJson } from '../../core/canonical.mjs';
import {
  runtime,
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
} from '../../gateway/index.mjs';
import { getOrCreateHengzhangBridge } from '../../usage/index.mjs';
import { readSessionFile } from '../../../packages/lt-usage/index.mjs';
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

function errEnvelope(code, message, status = 200, retriable = false) {
  return Response.json(
    {
      ok: false,
      contract: CONTRACT_ID,
      contractVersion: CONTRACT_VERSION,
      generatedAt: new Date().toISOString(),
      error: { code, message, retriable },
    },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

async function parseJsonRequest(request) {
  if (!request || request.method === 'GET' || request.method === 'HEAD') return {};
  try {
    const parsed = await request.json();
    return isPlainObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
    const rwFile = path.join(rt.storageRoot, 'request-window-calls.jsonl');
    const cutoff = Date.now() - 5 * 3600 * 1000;
    const records = fs.existsSync(rwFile) ? readJsonl(rwFile).records : [];
    const byProv = new Map();
    for (const r of records) {
      const ts = typeof r.at === 'number' ? r.at : Date.parse(r.at);
      if (Number.isFinite(ts) && ts >= cutoff) {
        const p = r.provider || 'unknown';
        byProv.set(p, (byProv.get(p) ?? 0) + 1);
      }
    }
    const providerLimits = cfg.requestWindow?.providers ?? {};
    const allProvs = new Set([...byProv.keys(), ...Object.keys(providerLimits)]);
    for (const p of allProvs) {
      const used = byProv.get(p) ?? 0;
      const limit = Number.isInteger(providerLimits[p]?.maxRequests) ? providerLimits[p].maxRequests : null;
      const remRatio = limit && limit > 0 ? Math.max(0, (limit - used) / limit) : 1;
      const tier = limit ? (remRatio <= 0.05 ? 'paused' : (remRatio <= 0.2 ? 'throttled' : 'normal')) : 'unbounded';
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
    roleAssignments,
    syncState: {
      dshSettingsSynced: Boolean(configSnap.desktopSync?.inSync ?? true),
      patchSynced: Boolean(configSnap.patchSync?.allInSync ?? true),
      governanceHash: govHash,
      desktopSync: configSnap.desktopSync,
      patchSync: configSnap.patchSync,
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

function extractReadableMessagesFromRows(rows = []) {
  const messages = [];
  const seenMsgIds = new Set();
  for (const row of rows) {
    if (!row || row.surfaceOp === 'seed') continue;
    if (row.type === 'user/message') {
      const msg = row.data?.message ?? row.data;
      const id = msg?.id || `u-${row.seq ?? row.time ?? messages.length}`;
      if (seenMsgIds.has(id)) continue;
      seenMsgIds.add(id);
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      const text = blocks.length > 0
        ? blocks.map(b => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
        : (typeof msg?.text === 'string' ? msg.text : '');
      messages.push({
        id,
        role: 'user',
        timeMs: row.time ?? null,
        text: text || '(附件或控制指令)',
        model: null,
        toolCalls: [],
      });
    } else if (row.type === 'assistant/message') {
      const msg = row.data?.message;
      const id = msg?.id || `a-${row.seq ?? row.time ?? messages.length}`;
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
  return messages;
}

function findDurableSessionRows(dshHome, sessionId) {
  if (!dshHome || !sessionId) return null;
  const sessionsRoot = path.join(dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return null;
  try {
    for (const slugDir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!slugDir.isDirectory()) continue;
      const cand = path.join(sessionsRoot, slugDir.name, sessionId, 'session.v4.jsonl.zstd');
      if (fs.existsSync(cand)) {
        const decoded = readSessionFile(cand);
        return decoded.rows ?? [];
      }
    }
  } catch {}
  return null;
}

export function createPublicContractHandlers(ctx, rt = runtime(), options = {}) {
  const getStorageRoot = () => {
    if (rt?.storageRoot) return rt.storageRoot;
    const home = resolveDshHomeFromCtx(ctx, rt) || path.join(process.cwd(), '.lt-standalone');
    return path.join(home, 'leaderteam');
  };

  const ensureConfigLoaded = () => {
    if (rt?.config && rt?.configPath) {
      syncRuntimeConfig(rt);
      return;
    }
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const dshHome = resolveDshHomeFromCtx(ctx, rt);
    const { configPath } = resolveOrBootstrapConfigPath({
      explicitConfigPath: options.configPath || null,
      dshHome,
      bundledDefaultConfigPath: path.join(repoRoot, 'config', 'leaderteam.config.json'),
    });
    rt.configPath = configPath;
    rt.storageRoot = getStorageRoot();
    syncRuntimeConfig(rt);
  };

  const getGatewayMgr = () => getOrCreateGatewayManager(getStorageRoot());
  const getUsageBridge = () => {
    const storageRoot = getStorageRoot();
    const bridge = getOrCreateHengzhangBridge(storageRoot, {
      dshHome: resolveDshHomeFromCtx(ctx, rt),
      gatewayManager: getGatewayMgr(),
    });
    const prefs = readUiPreferences(storageRoot);
    if (bridge.isEnabled() !== prefs.usageAnalyticsEnabled) {
      bridge.setEnabled(prefs.usageAnalyticsEnabled);
    }
    return bridge;
  };

  return {
    async capabilities() {
      try {
        ensureConfigLoaded();
        return okEnvelope(buildCapabilitiesPayload(ctx, rt, { hostKindOverride: options.hostKindOverride }));
      } catch (e) {
        return errEnvelope('CAPABILITIES_ERROR', e instanceof Error ? e.message : String(e));
      }
    },

    async bundle() {
      try {
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
        const { providers, presets } = buildPublicProviders({
          magpieProvidersPayload: provPayload,
          magpieAccounts: gwAccounts,
          magpieGatewayUrl: gateway.gatewayUrl,
          effectiveConfig: rt.config,
          externalGateways: gwMgr.listExternalGateways(),
        });
        const models = buildPublicModelCatalog({
          magpieGatewayModels: gwModels,
          effectiveConfig: rt.config,
          dshDiscoveredModels: dshCatalog?.models ?? [],
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
        return errEnvelope('BUNDLE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async gatewayStatus() {
      try {
        const status = await getGatewayMgr().getStatus();
        return okEnvelope(status);
      } catch (e) {
        return errEnvelope('GATEWAY_STATUS_FAILED', e instanceof Error ? e.message : String(e));
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
        return errEnvelope('GATEWAY_CONTROL_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async providersList() {
      try {
        ensureConfigLoaded();
        const mgr = getGatewayMgr();
        const gwStatus = await mgr.getStatus();
        const client = mgr.createClient();
        const provPayload = gwStatus.state === 'running' && client.hasWebAdminAuth()
          ? await client.listProviders().catch(() => null)
          : null;
        const accounts = gwStatus.state === 'running' && !provPayload
          ? await client.listGatewayAccounts().catch(() => [])
          : [];
        const res = buildPublicProviders({
          magpieProvidersPayload: provPayload,
          magpieAccounts: accounts,
          magpieGatewayUrl: gwStatus.gatewayUrl,
          effectiveConfig: rt.config,
          externalGateways: mgr.listExternalGateways(),
        });
        return okEnvelope(res);
      } catch (e) {
        return errEnvelope('PROVIDERS_LIST_FAILED', e instanceof Error ? e.message : String(e));
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
          operationResult = await client.discoverProviderModels(body.probe || {});
        } else if (op === 'refresh-models') {
          operationResult = await client.refreshSavedProviderModels(String(body.id || '').replace(/^magpie:/, ''));
        } else if (op === 'test-provider') {
          operationResult = await client.testProvider({
            id: String(body.id || '').replace(/^magpie:/, ''),
            account: body.account,
            models: body.models,
          });
        } else if (op === 'set-routing') {
          await client.setProviderRouting({
            id: String(body.id || '').replace(/^magpie:/, ''),
            route: body.keyRotation,
            sessionAffinity: body.sessionAffinity,
          });
        } else if (op === 'mutate-key') {
          const id = String(body.providerId || body.id || '').replace(/^magpie:/, '');
          const ref = body.credentialId ? String(body.credentialId).replace(/^key:/, '') : body.ref;
          operationResult = await client.mutateKey(body.keyAction, {
            id,
            ...(ref ? { ref } : {}),
            ...(body.name ? { name: body.name } : {}),
            ...(body.key ? { key: body.key } : {}),
            ...(body.weight !== undefined ? { weight: Number(body.weight) } : {}),
          });
        } else if (op === 'oauth-start') {
          operationResult = await client.startSignIn({ agent: body.agent, linkOnly: true });
        } else if (op === 'oauth-status') {
          operationResult = await client.getSignInStatus(body.signInId);
        } else if (op === 'oauth-callback') {
          operationResult = await client.submitSignInCallback(body.signInId, body.callbackUrl);
        } else {
          return errEnvelope('BAD_OPERATION', `Unknown provider operation: ${op}`);
        }

        const provPayload = client.hasWebAdminAuth() ? await client.listProviders().catch(() => null) : null;
        const normalized = buildPublicProviders({
          magpieProvidersPayload: provPayload,
          magpieGatewayUrl: mgr.getActiveEndpoints().gatewayUrl,
          effectiveConfig: rt.config,
          externalGateways: mgr.listExternalGateways(),
        });
        return okEnvelope({ operationResult, ...normalized });
      } catch (e) {
        return errEnvelope(e?.code || 'PROVIDERS_MUTATE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async modelsCatalog(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
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
        return errEnvelope('MODELS_CATALOG_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async modelsSyncPool(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const mgr = getGatewayMgr();
        const gwStatus = await mgr.getStatus();
        const gwModels = gwStatus.state === 'running'
          ? await mgr.createClient().listGatewayModels().catch(() => [])
          : [];
        const dshCatalog = await refreshUpstreamCatalog(ctx, rt, { force: false }).catch(() => null);
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
          defaultMagpieHostProvider: rt.config.magpie?.provider ?? 'magpie',
          enableInExecutionPool: body.enableInExecutionPool !== false,
        });

        const target = body.target === 'base' ? 'base' : 'local';
        const applyResult = applyModelConfigChanges(
          { upsertModels: upserts },
          { configFile: rt.configPath, target, discoveredModels: dshCatalog?.models ?? [] },
        );
        syncRuntimeConfig(rt);

        // Also sync newly imported routes into live DSH settings if running inside DSH host
        let dshSettingsSync = { synced: false };
        if (ctx) {
          const gwBaseUrl = gwStatus.gatewayUrl ? `${gwStatus.gatewayUrl.replace(/\/+$/, '')}/v1` : undefined;
          const templates = buildSoloProviderSettingsTemplates(process.env);
          const magpieProv = rt.config.magpie?.provider ?? 'magpie';
          if (gwBaseUrl) {
            templates[magpieProv] = {
              displayName: 'Magpie Gateway',
              api: 'openai-completions',
              baseURL: gwBaseUrl,
            };
          }
          dshSettingsSync = await syncUpstreamModelsToDshSettings(
            ctx,
            upserts,
            magpieProv,
            { providerTemplates: templates },
          ).catch(err => ({ synced: false, error: err.message }));
        }

        const updatedModels = buildPublicModelCatalog({
          magpieGatewayModels: gwModels,
          effectiveConfig: rt.config,
          dshDiscoveredModels: dshCatalog?.models ?? [],
        });
        return okEnvelope({
          syncedCount: upserts.length,
          dshSettingsSync,
          models: updatedModels,
          runtime: await buildRuntimeSnapshotPayload(ctx, rt),
        });
      } catch (e) {
        return errEnvelope(e?.code || 'MODELS_SYNC_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async runtimeSnapshot() {
      try {
        ensureConfigLoaded();
        return okEnvelope(await buildRuntimeSnapshotPayload(ctx, rt));
      } catch (e) {
        return errEnvelope('RUNTIME_SNAPSHOT_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async runtimeConfigure(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const target = body.target === 'base' ? 'base' : 'local';
        const changes = isPlainObj(body.changes) ? body.changes : {};
        const dshCatalog = await refreshUpstreamCatalog(ctx, rt, { force: false }).catch(() => null);
        const applyResult = applyModelConfigChanges(changes, {
          configFile: rt.configPath,
          target,
          dryRun: Boolean(body.dryRun),
          discoveredModels: dshCatalog?.models ?? [],
        });
        if (!body.dryRun) {
          syncRuntimeConfig(rt);
          if (ctx) {
            const activeRoutes = new Set([
              ...(applyResult.effective?.executionPool ?? []),
              ...Object.values(applyResult.effective?.roles ?? {}).flatMap(r => [r?.route, ...(r?.fallback ?? []).map(f => f.route)]).filter(Boolean),
            ]);
            const toSync = [...activeRoutes]
              .map(route => {
                const spec = applyResult.effective?.models?.[route];
                if (!spec) return null;
                return {
                  route,
                  provider: spec.provider ?? rt.config.magpie?.provider ?? 'magpie',
                  upstreamModel: spec.upstreamModel ?? route,
                  efforts: spec.efforts,
                  reasoningEfforts: spec.reasoningEfforts,
                  vision: spec.vision,
                  contextWindow: spec.contextWindow,
                  maxTokens: spec.maxTokens,
                };
              })
              .filter(Boolean);
            await syncUpstreamModelsToDshSettings(
              ctx,
              toSync,
              rt.config.magpie?.provider ?? 'magpie',
              { providerTemplates: buildSoloProviderSettingsTemplates(process.env) },
            ).catch(() => {});
          }
        }
        return okEnvelope({
          applyResult,
          runtime: await buildRuntimeSnapshotPayload(ctx, rt),
        });
      } catch (e) {
        return errEnvelope(e?.code || 'RUNTIME_CONFIGURE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    /* ==================== Live Workbench / DSH Shared Session RPCs ==================== */

    async workbenchSessions() {
      try {
        ensureConfigLoaded();
        const sessionController = getHostService(ctx, 'sessionController');
        const workspaceRegistry = getHostService(ctx, 'workspaceRegistry');
        const workspaces = workspaceRegistry?.list?.()?.map(w => ({
          workspaceId: String(w.id),
          path: w.path,
          title: w.title,
          sessionIds: [...(w.sessionIds ?? [])].map(String),
        })) ?? [];

        if (sessionController && typeof sessionController.list === 'function') {
          const ac = new AbortController();
          const listed = await sessionController.list({}, ac.signal);
          const sessions = (listed?.items ?? []).map(item => ({
            sessionId: String(item.sessionId ?? item.id),
            title: item.title ?? null,
            cwd: item.cwd ?? null,
            agentPreset: item.agentPreset ?? null,
            updatedAt: item.updatedAt ?? item.lastActivityAt ?? null,
            isTeam: TeamStore.exists(rt.storageRoot, String(item.sessionId ?? item.id)),
          }));
          return okEnvelope({ liveHost: true, workspaces, sessions });
        }

        // Standalone fallback: list durable root sessions via Hengzhang
        const usageSessions = await getUsageBridge().getSessions();
        const sessions = (usageSessions.sessions ?? [])
          .filter(s => !s.isChild)
          .map(s => ({
            sessionId: s.id,
            title: s.title ?? null,
            cwd: s.cwd ?? null,
            agentPreset: s.kind === 'team' ? 'leaderteam' : null,
            updatedAt: s.lastActivityMs ?? s.startedAtMs ?? null,
            isTeam: s.kind === 'team',
          }));
        return okEnvelope({ liveHost: false, workspaces, sessions });
      } catch (e) {
        return errEnvelope('WORKBENCH_SESSIONS_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async workbenchTranscript(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
        const sessionId = String(body.sessionId || '').trim();
        if (!sessionId) return errEnvelope('BAD_REQUEST', 'sessionId is required');

        const dshHome = resolveDshHomeFromCtx(ctx, rt);
        let rows = rt?.actors?.get?.(sessionId)?.agent?.session?.snapshotEvents?.() ?? null;
        if (!rows || rows.length === 0) {
          rows = findDurableSessionRows(dshHome, sessionId) ?? [];
        }

        let passiveState = null;
        const sessionController = getHostService(ctx, 'sessionController');
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
        return errEnvelope('WORKBENCH_TRANSCRIPT_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async workbenchCreate(request) {
      try {
        const sessionController = getHostService(ctx, 'sessionController');
        if (!sessionController || typeof sessionController.create !== 'function') {
          return errEnvelope('HOST_UNAVAILABLE', 'Live DSH session controller is only available inside DSH web/desktop runtime');
        }
        const body = await parseJsonRequest(request);
        const created = await sessionController.create({
          ...(body.workspaceId ? { workspaceId: body.workspaceId } : { cwd: body.cwd || process.cwd() }),
          agentPreset: body.agentPreset || 'leaderteam',
        });
        return okEnvelope(created);
      } catch (e) {
        return errEnvelope('WORKBENCH_CREATE_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async workbenchPrompt(request) {
      try {
        const sessionController = getHostService(ctx, 'sessionController');
        if (!sessionController || typeof sessionController.prompt !== 'function') {
          return errEnvelope('HOST_UNAVAILABLE', 'Live DSH session controller is not attached');
        }
        const body = await parseJsonRequest(request);
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
        return errEnvelope('WORKBENCH_PROMPT_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async workbenchCancel(request) {
      try {
        const sessionController = getHostService(ctx, 'sessionController');
        if (!sessionController || typeof sessionController.cancel !== 'function') {
          return errEnvelope('HOST_UNAVAILABLE', 'Live DSH session controller is not attached');
        }
        const body = await parseJsonRequest(request);
        const sessionId = String(body.sessionId || '').trim();
        if (!sessionId) return errEnvelope('BAD_REQUEST', 'sessionId is required');
        const res = await sessionController.cancel({ sessionId });
        return okEnvelope(res);
      } catch (e) {
        return errEnvelope('WORKBENCH_CANCEL_FAILED', e instanceof Error ? e.message : String(e));
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
        return errEnvelope('ARCHIVE_QUERY_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async archiveAction(request) {
      try {
        ensureConfigLoaded();
        const body = await parseJsonRequest(request);
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
          const res = archive.cleanPlans({
            olderThanDays: typeof body.olderThanDays === 'number' ? body.olderThanDays : null,
            all: Boolean(body.all),
            dryRun: body.dryRun !== false,
            confirm: Boolean(body.confirm),
          });
          return okEnvelope({ ...res, stats: archive.getStats() });
        }
        return errEnvelope('BAD_ACTION', `Unsupported archive action: ${body.action}`);
      } catch (e) {
        return errEnvelope('ARCHIVE_ACTION_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    /* ==================== Hengzhang Usage Analytics ==================== */

    async usageStatus(request) {
      const body = await parseJsonRequest(request);
      return okEnvelope(await getUsageBridge().getStatus({ home: body.home }));
    },

    async usageOverview(request) {
      try {
        const body = await parseJsonRequest(request);
        return okEnvelope(await getUsageBridge().getOverview({ home: body.home, syncGateway: body.syncGateway !== false }));
      } catch (e) {
        return errEnvelope('USAGE_OVERVIEW_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async usageSessions(request) {
      try {
        const body = await parseJsonRequest(request);
        return okEnvelope(await getUsageBridge().getSessions({ home: body.home, syncGateway: Boolean(body.syncGateway) }));
      } catch (e) {
        return errEnvelope('USAGE_SESSIONS_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async usageReport(request) {
      try {
        const body = await parseJsonRequest(request);
        return okEnvelope(await getUsageBridge().getSessionReport({
          sessionId: body.sessionId,
          home: body.home,
          syncGateway: body.syncGateway !== false,
        }));
      } catch (e) {
        return errEnvelope('USAGE_REPORT_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async usagePricing(request) {
      try {
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
        return errEnvelope('USAGE_PRICING_FAILED', e instanceof Error ? e.message : String(e));
      }
    },

    async usageToggle(request) {
      try {
        const body = await parseJsonRequest(request);
        const enabled = Boolean(body.enabled);
        const storageRoot = getStorageRoot();
        writeUiPreferences(storageRoot, { usageAnalyticsEnabled: enabled });
        const bridge = getUsageBridge();
        bridge.setEnabled(enabled);
        return okEnvelope(await bridge.getStatus());
      } catch (e) {
        return errEnvelope('USAGE_TOGGLE_FAILED', e instanceof Error ? e.message : String(e));
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
        return errEnvelope('UI_PREFS_FAILED', e instanceof Error ? e.message : String(e));
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

  // Redirect `/lt` -> `/lt/` so relative `./assets/...` and `../api/lt/v1/...` always resolve identically
  if (mountPrefix && pathname === mountPrefix) {
    return new Response(null, {
      status: 302,
      headers: { location: `${mountPrefix}/${url.search}` },
    });
  }

  let relPath = mountPrefix && pathname.startsWith(`${mountPrefix}/`)
    ? pathname.slice(mountPrefix.length + 1)
    : pathname.replace(/^\/+/, '');
  relPath = decodeURIComponent(relPath);
  if (!relPath || relPath === 'index.html') relPath = 'index.html';

  const resolvedDist = path.resolve(distDir);
  const target = path.resolve(resolvedDist, relPath);
  if (target !== resolvedDist && !target.startsWith(resolvedDist + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  const isIndex = relPath === 'index.html';
  let filePath = target;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback to index.html for client routes without extensions
    if (!path.extname(relPath)) {
      filePath = path.join(resolvedDist, 'index.html');
    } else {
      return new Response('Not Found', { status: 404 });
    }
  }

  if (filePath.endsWith('index.html') || isIndex) {
    if (typeof authorizeIndex === 'function') {
      const refusal = authorizeIndex(request);
      if (refusal) return refusal;
    }
    if (!fs.existsSync(filePath)) {
      return new Response('LT Native Frontend dist is not built yet', { status: 503 });
    }
    const html = await readFile(filePath, 'utf8');
    return new Response(request.method === 'HEAD' ? null : html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  const bytes = await readFile(filePath);
  const etag = `W/"${crypto.createHash('sha1').update(bytes).digest('base64url')}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
  }
  const mime = STATIC_MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
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
    let status = 401;
    let headers = new Headers();
    let body;
    return connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus;
        headers = new Headers(nextHeaders);
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
