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

const LOCAL_PREFS_KEY = 'lt-ui-preferences-v1';

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

function hexToRgb(hex: string): [number, number, number] | null {
  const m = String(hex || '').trim().replace(/^#/, '');
  if (m.length === 3) {
    return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)];
  }
  if (m.length >= 6) {
    return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  }
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const norm = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * norm[0] + 0.7152 * norm[1] + 0.0722 * norm[2];
}

export function computeContrastRatio(hexA: string, hexB: string): number {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return 10;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function applyThemeToDom(theme: ThemePresetId, customTheme: CustomThemeSeeds): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const st = html.style;
  html.setAttribute('data-lt-theme', theme);

  if (theme === 'custom') {
    html.setAttribute('data-lt-heading', customTheme.headingFontMode || 'serif');
    html.setAttribute('data-lt-corners', customTheme.cornerStyle || 'balanced');
    html.setAttribute('data-lt-density', customTheme.density || 'standard');
    st.setProperty('--user-bg-canvas', customTheme.canvasColor);
    st.setProperty('--user-bg-surface', customTheme.surfaceColor);
    st.setProperty('--user-fg-primary', customTheme.inkColor);
    st.setProperty('--user-accent', customTheme.accentColor);
    st.setProperty('--user-danger', customTheme.dangerColor);
    const inkRgb = hexToRgb(customTheme.inkColor);
    const inkLum = inkRgb ? relativeLuminance(inkRgb) : 0.05;
    st.setProperty('--user-fg-on-ink', inkLum > 0.45 ? '#141619' : '#FFFFFF');
    const surfRgb = hexToRgb(customTheme.surfaceColor);
    st.colorScheme = surfRgb && relativeLuminance(surfRgb) < 0.25 ? 'dark' : 'light';
  } else {
    html.removeAttribute('data-lt-heading');
    html.removeAttribute('data-lt-corners');
    html.removeAttribute('data-lt-density');
    st.removeProperty('--user-bg-canvas');
    st.removeProperty('--user-bg-surface');
    st.removeProperty('--user-fg-primary');
    st.removeProperty('--user-accent');
    st.removeProperty('--user-danger');
    st.removeProperty('--user-fg-on-ink');
    st.removeProperty('color-scheme');
  }

  try {
    localStorage.setItem(LOCAL_PREFS_KEY, JSON.stringify({ theme, customTheme }));
  } catch {}
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function formatNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '未知';
  return n.toLocaleString('en-US');
}

export function formatCny(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '未知';
  return `¥${n.toFixed(4)}`;
}
