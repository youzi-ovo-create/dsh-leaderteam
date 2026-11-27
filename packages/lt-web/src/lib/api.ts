import type {
  BackendCapabilities,
  ContractEnvelope,
  ContractErrorEnvelope,
  CustomThemeSeeds,
  ExecutionMode,
  GatewayStatus,
  ModelCatalogEntry,
  ProviderDescriptor,
  ProviderPresetDescriptor,
  RuntimeSnapshot,
  SessionModeSnapshot,
  ThemePresetId,
  UiPreferences,
} from '../types/lt-public-v1';
import {
  applyAppearanceToDom,
  computeContrastRatio as themeComputeContrastRatio,
  type DensityMode,
  type DisplayFontMode,
} from './theme.ts';

export class LtApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retriable: boolean;
  readonly details: Record<string, any> | null;

  constructor(
    message: string,
    opts: {
      code?: string;
      status?: number;
      retriable?: boolean;
      details?: Record<string, any> | null;
    } = {},
  ) {
    super(message);
    this.name = 'LtApiError';
    this.code = opts.code || 'API_ERROR';
    this.status = opts.status ?? 200;
    this.retriable = Boolean(opts.retriable);
    this.details = opts.details ?? null;
  }
}

export interface LocalOverridesSummary {
  exists: boolean;
  models: string[];
  executionPool: boolean;
  leaderModelPolicy: boolean;
  roles: string[];
}

export interface OnboardingBundleSnapshot {
  completed: boolean;
  dismissed: boolean;
  shouldAutoOpen: boolean;
  selectedProviderId: string | null;
  keyPreview: string | null;
  selectedCollabPreset: string;
  defaultSessionMode: 'team' | 'single';
  firstSessionId: string | null;
  defaultWorkspace: string;
  detectedEnvVars: string[];
  steps: {
    modelConnected: boolean;
    teamConfigured: boolean;
    firstTaskCreated: boolean;
  };
  providerPresets: Array<{
    id: string;
    provider: string;
    displayName: string;
    envVar: string;
    defaultBaseURL: string;
    reasoningRoute: string;
    reasoningLabel: string;
    chatRoute: string;
    chatLabel: string;
    keyPlaceholder: string;
    guideHint: string;
  }>;
  collabPresets: Array<{
    id: string;
    label: string;
    defaultSessionMode: 'team' | 'single';
    maxActiveMembers: number;
    summary: string;
  }>;
  starterTasks: Array<{
    id: string;
    title: string;
    recommendedMode: 'team' | 'single';
    description: string;
    prompt: string;
  }>;
}

export interface UpdaterReleaseEntry {
  track: string;
  tagName: string;
  version: string;
  name: string;
  prerelease: boolean;
  publishedAt: string | null;
  htmlUrl: string | null;
  body: string;
  asset: {
    name: string;
    size: number | null;
    downloadUrl: string;
    sha256: string | null;
  } | null;
  sha256SumsUrl: string | null;
}

export interface UpdaterBundleSnapshot {
  installed: {
    name: string;
    version: string;
    track: 'open-source' | 'closed-free';
    trackInfo: {
      id: string;
      label: string;
      shortLabel: string;
      license: string;
      repo: string;
      releasesHtmlUrl: string;
      description: string;
    };
    enginesDsh: string;
  };
  tracks: Array<{
    id: string;
    label: string;
    shortLabel: string;
    license: string;
    repo: string;
    releasesHtmlUrl: string;
    description: string;
  }>;
  state: {
    phase: string;
    autoCheckEnabled: boolean;
    lastCheckedAt: string | null;
    lastError: string | null;
    availableUpdate: UpdaterReleaseEntry | null;
    lastCompletedUpgrade: Record<string, any> | null;
  };
  backups: Array<{
    backupId: string;
    createdAt: string;
    fromVersion: string;
    fromTrack: string;
    toVersion: string;
    toTrack: string;
  }>;
}

export interface HostCompatibilityMatrixSnapshot {
  track: string;
  engineRange: string;
  minSupportedVersion: string;
  verifiedVersions: string[];
  defaultPolicy: string;
  rows: Array<{
    series: string;
    versionPattern: string;
    surfaces: string[];
    platforms: string[];
    status: string;
    statusLabel: string;
    productionAllowed: boolean;
    notes: string;
  }>;
}

export interface HydratedBundle {
  capabilities: BackendCapabilities & {
    distributionTrack?: string;
    hostCompatibility?: {
      status: string;
      classification: string;
      toolsVersion: string | null;
      productionAllowed: boolean;
      summary: string;
    } | null;
    features: BackendCapabilities['features'] & {
      autoUpdate?: boolean;
      onboardingWizard?: boolean;
      hostCompatibilityMatrix?: boolean;
    };
  };
  gateway: GatewayStatus;
  providers: ProviderDescriptor[];
  providerPresets: ProviderPresetDescriptor[];
  models: ModelCatalogEntry[];
  runtime: RuntimeSnapshot & {
    activePlugins?: Record<string, boolean>;
    configuredModelsMap?: Record<string, unknown>;
    leaderModelPolicy?: string;
    localOverrides?: LocalOverridesSummary;
    planArchive?: {
      enabled: boolean;
      root: string | null;
      stats: Record<string, unknown> | null;
      recentPlans: Array<Record<string, unknown>>;
    };
  };
  uiPreferences: UiPreferences;
  usageStatus: {
    enabled: boolean;
    healthy: boolean;
    dshHome: string | null;
    homeExists: boolean;
    cachedGatewayRecords: number;
    lastSyncAt: string | null;
    lastSyncError: string | null;
  };
  onboarding?: OnboardingBundleSnapshot;
  updater?: UpdaterBundleSnapshot;
  compatibilityMatrix?: HostCompatibilityMatrixSnapshot;
}

export function resolveApiPrefix(): string {
  if (typeof window === 'undefined') return '/api/lt/v1';
  const pathname = window.location.pathname || '/';
  // Compute exact mount root when mounted at `/lt` or `/<prefix>/lt/*` so nested SPA paths never resolve to `/lt/api/lt/v1`
  const ltMountMatch = pathname.match(/^(.*?)\/lt(?:\/|$)/);
  if (ltMountMatch) {
    const mountRoot = ltMountMatch[1] || '';
    return `${mountRoot}/api/lt/v1`;
  }
  return '/api/lt/v1';
}

export async function callLtApi<T = any>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const clean = endpoint.replace(/^\/+/, '');
  const url = `${resolveApiPrefix()}/${clean}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    throw new LtApiError('未通过本地会话鉴权（401）：请使用终端输出的完整带 token 启动链接访问', {
      code: 'UNAUTHORIZED',
      status: 401,
    });
  }
  let json: ContractEnvelope<T> | ContractErrorEnvelope | null = null;
  try {
    json = (await res.json()) as ContractEnvelope<T> | ContractErrorEnvelope;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const errObj = (json as ContractErrorEnvelope | null)?.error;
    const errMsg = errObj?.message || `HTTP ${res.status}`;
    throw new LtApiError(errMsg, {
      code: errObj?.code || `HTTP_${res.status}`,
      status: res.status,
      retriable: Boolean(errObj?.retriable),
      details: (errObj?.details as Record<string, any> | null) ?? null,
    });
  }
  return json.data;
}

export interface WorkbenchModeSetResult {
  changed: boolean;
  previousMode: ExecutionMode;
  modeState: SessionModeSnapshot;
}

export async function fetchWorkbenchSessionMode(sessionId: string): Promise<{ modeState: SessionModeSnapshot }> {
  return callLtApi<{ modeState: SessionModeSnapshot }>('workbench/mode', {
    action: 'get',
    sessionId,
  });
}

export async function switchWorkbenchSessionMode(
  sessionId: string,
  mode: ExecutionMode,
): Promise<WorkbenchModeSetResult> {
  return callLtApi<WorkbenchModeSetResult>('workbench/mode', {
    action: 'set',
    sessionId,
    mode,
  });
}

export function computeContrastRatio(hexA: string, hexB: string): number {
  return themeComputeContrastRatio(hexA, hexB);
}

export function applyThemeToDom(
  theme: ThemePresetId,
  customTheme: CustomThemeSeeds,
  globalOverride?: { density?: DensityMode; display?: DisplayFontMode },
): void {
  applyAppearanceToDom(theme, customTheme, globalOverride);
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

export function formatNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

export function formatTokensCompact(n: number | null | undefined): { value: string; unit: string } | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n >= 1e6) return { value: (n / 1e6).toFixed(2), unit: 'M' };
  if (n >= 1e3) return { value: (n / 1e3).toFixed(1), unit: 'k' };
  return { value: String(Math.round(n)), unit: '' };
}

export function formatCny(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(Math.abs(n) < 1 ? 3 : 2)}`;
}

export function extractCnyAmount(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (val && typeof val === 'object') {
    const total = (val as { total?: unknown }).total;
    if (typeof total === 'number' && Number.isFinite(total)) return total;
  }
  return null;
}

export function computeTodayUsageSummary(
  overview: any,
  activeReport?: any,
  nowMs: number = Date.now(),
): { costCny: number | null; unknownCount: number } {
  if (overview?.today && typeof overview.today === 'object') {
    const todayObj = overview.today;
    const costCny = extractCnyAmount(todayObj.costActualCny);
    const unknownCount =
      (Number(todayObj.unmeteredCalls) || 0) + (Number(todayObj.unpricedCalls) || 0);
    return { costCny, unknownCount };
  }

  const now = new Date(nowMs);
  const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sessions: any[] = Array.isArray(overview?.sessions) ? overview.sessions : [];

  let costSum = 0;
  let knownCount = 0;
  let succeededCount = 0;
  let unknownCount = 0;

  if (sessions.length > 0) {
    for (const s of sessions) {
      const lastMs =
        typeof s?.lastActivityMs === 'number' && Number.isFinite(s.lastActivityMs)
          ? s.lastActivityMs
          : typeof s?.startedAtMs === 'number' && Number.isFinite(s.startedAtMs)
            ? s.startedAtMs
            : null;
      const startMs =
        typeof s?.startedAtMs === 'number' && Number.isFinite(s.startedAtMs)
          ? s.startedAtMs
          : lastMs;
      if (lastMs === null || lastMs < startOfTodayMs) continue;

      if (
        startMs !== null &&
        startMs < startOfTodayMs &&
        activeReport?.meta?.sessionId === s.sessionId &&
        Array.isArray(activeReport?.calls)
      ) {
        for (const c of activeReport.calls) {
          if (typeof c?.timeMs !== 'number' || c.timeMs < startOfTodayMs) continue;
          const billed = c.ok !== false || (Number(c.totalTokens) || 0) > 0 || (Number(c.inputTokens) || 0) > 0 || (Number(c.outputTokens) || 0) > 0;
          if (billed) succeededCount += 1;
          if (c.unmetered) {
            unknownCount += 1;
          } else if (billed) {
            const amt = extractCnyAmount(c.costActualCny);
            if (amt !== null) {
              costSum += amt;
              knownCount += 1;
            } else {
              unknownCount += 1;
            }
          }
        }
        continue;
      }

      const sessBilled =
        (Number(s?.callsSucceeded) || 0) > 0 ||
        (Number(s?.totalTokens) || 0) > 0 ||
        (Number(s?.unpricedCalls) || 0) > 0 ||
        (Number(s?.unmeteredCalls) || 0) > 0;
      if (sessBilled) succeededCount += 1;
      unknownCount += (Number(s?.unmeteredCalls) || 0) + (Number(s?.unpricedCalls) || 0);
      const amt = extractCnyAmount(s?.costActualCny);
      if (amt !== null) {
        costSum += amt;
        knownCount += 1;
      }
    }
    return {
      costCny: succeededCount > 0 && knownCount === 0 ? null : Number(costSum.toFixed(4)),
      unknownCount,
    };
  }

  if (Array.isArray(activeReport?.calls)) {
    for (const c of activeReport.calls) {
      if (typeof c?.timeMs !== 'number' || c.timeMs < startOfTodayMs) continue;
      const billed = c.ok !== false || (Number(c.totalTokens) || 0) > 0 || (Number(c.inputTokens) || 0) > 0 || (Number(c.outputTokens) || 0) > 0;
      if (billed) succeededCount += 1;
      if (c.unmetered) {
        unknownCount += 1;
      } else if (billed) {
        const amt = extractCnyAmount(c.costActualCny);
        if (amt !== null) {
          costSum += amt;
          knownCount += 1;
        } else {
          unknownCount += 1;
        }
      }
    }
    return {
      costCny: succeededCount > 0 && knownCount === 0 ? null : Number(costSum.toFixed(4)),
      unknownCount,
    };
  }

  return { costCny: null, unknownCount: 0 };
}

export function formatClockTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatRelativeGroup(ms: number | null | undefined): '今天' | '昨天' | '更早' {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '更早';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86_400_000;
  if (ms >= startToday) return '今天';
  if (ms >= startYesterday) return '昨天';
  return '更早';
}

export function formatSessionUpdatedLabel(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const grp = formatRelativeGroup(ms);
  if (grp === '今天') return formatClockTime(ms);
  if (grp === '昨天') return '昨天';
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface SessionScopedConfigSnapshot {
  sessionId: string;
  hasOverride: boolean;
  hasPending: boolean;
  isBusy: boolean;
  busyReasons: string[];
  record: {
    updatedAt: string | null;
    updatedBy: string | null;
    activePatch: Record<string, any>;
    pendingPatch: Record<string, any> | null;
  };
  effective: {
    roles: Record<string, { route: string; effort: string; fallback?: Array<{ route: string; effort: string }> }>;
    executionPool: string[];
    maxActiveMembers: number;
    leaderModelPolicy: 'follow' | 'enforce' | 'warn' | 'off' | string;
  };
}

export async function fetchWorkbenchSessionConfig(sessionId: string): Promise<SessionScopedConfigSnapshot> {
  return callLtApi<SessionScopedConfigSnapshot>('workbench/session-config', {
    action: 'get',
    sessionId,
  });
}

export async function updateWorkbenchSessionConfig(params: {
  sessionId: string;
  patch: Record<string, any>;
  syncAllRolesToLeader?: boolean;
  replaceAll?: boolean;
}): Promise<{
  appliedImmediately: boolean;
  stagedForSafeBoundary: boolean;
  busyReasons: string[];
  sessionConfig: SessionScopedConfigSnapshot;
}> {
  return callLtApi('workbench/session-config', {
    action: 'set',
    ...params,
  });
}

export async function resetWorkbenchSessionConfig(sessionId: string): Promise<{
  appliedImmediately: boolean;
  stagedForSafeBoundary: boolean;
  sessionConfig: SessionScopedConfigSnapshot;
}> {
  return callLtApi('workbench/session-config', {
    action: 'reset',
    sessionId,
  });
}

export async function promoteWorkbenchSessionConfigToGlobal(sessionId: string): Promise<{
  promoted: boolean;
  sessionConfig: SessionScopedConfigSnapshot;
}> {
  return callLtApi('workbench/session-config', {
    action: 'promote-to-global',
    sessionId,
  });
}

export async function autoAdoptHostModels(params: {
  scope: 'global' | 'session';
  sessionId?: string;
}): Promise<any> {
  return callLtApi('workbench/session-config', {
    action: 'auto-adopt-host',
    ...params,
  });
}
