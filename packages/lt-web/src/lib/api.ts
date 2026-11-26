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

export interface HydratedBundle {
  capabilities: BackendCapabilities;
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
