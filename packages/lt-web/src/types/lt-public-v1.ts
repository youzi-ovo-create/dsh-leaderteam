/**
 * Leader Team Public Product & Dual-Line Integration Contract
 * Contract ID: lt.public.v1
 * Version: 1.0.0
 * License: Apache-2.0
 *
 * Strictly zero secrets and zero private Core internals.
 */

export type ContractId = 'lt.public.v1';
export type ContractVersion = '1.0.0';

export interface ContractEnvelope<T> {
  ok: true;
  contract: ContractId;
  contractVersion: ContractVersion;
  generatedAt: string;
  data: T;
}

export interface ContractErrorEnvelope {
  ok: false;
  contract: ContractId;
  contractVersion: ContractVersion;
  generatedAt: string;
  error: {
    code: string;
    message: string;
    retriable?: boolean;
  };
}

export type SourceKind = 'magpie' | 'direct' | 'external-gateway' | 'host-settings';
export type ProviderProtocol =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'multi';

/* ==================== 1. Capabilities ==================== */

export interface RoleSchemaDescriptor {
  roleId: string;
  label: string;
  description: string;
  supportsFallbacks: boolean;
  maxFallbacks: number;
  required: boolean;
}

export interface BackendCapabilities {
  backendLine: string;
  backendVersion: string;
  hostKind: 'dsh-web' | 'dsh-desktop' | 'standalone';
  frontendSwitch: {
    available: boolean;
    currentSurface: 'lt-native' | 'dsh-native';
    dshFrontendUrl: string | null;
    ltFrontendUrl: string;
    sharesRuntimeAndSessions: boolean;
  };
  features: {
    liveSessionRpc: boolean;
    magpieGateway: boolean;
    magpieManagedLifecycle: boolean;
    magpieProviderAdmin: boolean;
    magpieOAuthPassthrough: boolean;
    directProviders: boolean;
    externalGateways: boolean;
    modelPoolWrite: boolean;
    roleConfigWrite: boolean;
    roleFallbacks: boolean;
    teamObservability: boolean;
    rollingFrontier: boolean;
    governanceConferences: boolean;
    schedulerTelemetry: boolean;
    planArchive: boolean;
    usageAnalytics: boolean;
    usageOfflineImport: boolean;
    themePersistence: boolean;
  };
  supportedRoles: RoleSchemaDescriptor[];
}

/* ==================== 2. Gateway Lifecycle ==================== */

export type GatewayMode = 'managed' | 'external' | 'disabled';
export type GatewayLifecycleState =
  | 'running'
  | 'starting'
  | 'draining'
  | 'stopped'
  | 'degraded'
  | 'error'
  | 'not_installed';

export interface GatewayStatus {
  mode: GatewayMode;
  state: GatewayLifecycleState;
  gatewayUrl: string | null;
  webAdminUrl: string | null;
  managementAuthenticated: boolean;
  autoRecover: boolean;
  recoveryCount: number;
  version: {
    current: string | null;
    pinned: string;
    testedRange: string;
    compatible: boolean;
    rollbackAvailable: boolean;
    previousVersion: string | null;
    license: 'MIT';
  };
  health: {
    ok: boolean;
    latencyMs: number | null;
    checkedAt: string | null;
    pid: number | null;
    modelCount: number;
  };
  lastError: {
    code: string;
    message: string;
    at: string;
  } | null;
}

/* ==================== 3. Providers & Credentials ==================== */

export interface CredentialRef {
  credentialId: string;
  kind: 'api_key' | 'oauth' | 'env_ref';
  label: string;
  /** Masked preview ONLY (e.g., "sk-****9a2f" or "oauth:team"). Never raw secret! */
  maskedPreview: string;
  enabled: boolean;
  primary: boolean;
  weight: number;
  accountPlan?: string | null;
}

export interface ProviderDescriptor {
  providerId: string;
  sourceKind: 'magpie' | 'direct' | 'external-gateway';
  vendorId: string;
  displayName: string;
  protocol: ProviderProtocol;
  endpointUrl: string;
  status: 'ready' | 'degraded' | 'unconfigured' | 'disabled' | 'auth_required';
  keyRotation: 'fill-first' | 'round-robin' | 'least-used' | 'single';
  sessionAffinity: boolean;
  credentials: CredentialRef[];
  discoveredModelCount: number;
  enabledModelCount: number;
}

export interface ProviderPresetDescriptor {
  vendorId: string;
  displayName: string;
  protocol: ProviderProtocol;
  defaultEndpointUrl: string;
  keyHint: string;
  keyUrl?: string;
  supportsDirectSoloKey: boolean;
  supportsMagpie: boolean;
}

/* ==================== 4. Model Catalog ==================== */

export interface ModelCatalogEntry {
  /** Stable globally-unique catalog entry ID: `${sourceKind}:${providerId}:${upstreamModelId}` */
  entryId: string;
  /** Route ID addressable inside LT / DSH config (disambiguated, never auto-merged by bare model name) */
  routeId: string;
  upstreamModelId: string;
  providerId: string;
  providerDisplayName: string;
  credentialScope: string;
  sourceKind: SourceKind;
  displayName: string;
  family: 'gpt' | 'claude' | 'gemini' | 'deepseek' | 'qwen' | 'glm' | 'other';
  capabilities: {
    vision: boolean;
    pdf: boolean;
    toolCall: boolean;
    reasoning: boolean;
  };
  efforts: {
    supported: string[];
    defaultEffort: string;
    wireEffortMap?: Record<string, string>;
  };
  limits: {
    contextWindow: number | null;
    maxOutputTokens: number | null;
  };
  tier: 'flagship' | 'balanced' | 'fast' | 'reasoning' | 'unspecified';
  inModelPool: boolean;
  inExecutionPool: boolean;
  disabled: boolean;
}

/* ==================== 5. Runtime & Team Observation ==================== */

export interface RoleFallbackSlot {
  route: string;
  effort: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
}

export interface RoleAssignment {
  route: string;
  effort: string;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  fallback: RoleFallbackSlot[];
}

export interface FrontierStageObservation {
  stageId: string;
  title: string;
  stageHash?: string;
  ready: boolean;
  executionState: 'pending' | 'ready' | 'running' | 'verified' | 'blocked';
  dependsOn: string[];
  writeScope: string[];
}

export interface TeamMemberObservation {
  memberId: string;
  name: string;
  actorRole: string;
  configuredModel: string;
  effort: string;
  status: string;
  stageId: string | null;
  taskSummary: string | null;
  writeScope: string[];
  hasCheckpoint: boolean;
}

export interface GovernanceEventObservation {
  eventId: string;
  kind: 'supervision' | 'deferred' | 'caucus' | 'conference' | 'directive' | 'human_escalation' | 'agreement';
  status: string;
  summary: string;
  at: string | null;
  strikeCount?: number;
}

export interface TeamObservation {
  teamId: string;
  sessionId: string;
  title: string | null;
  status: 'active' | 'paused' | 'waiting_user' | 'completed' | 'idle';
  taskSeq: number;
  frozenGovernanceHash: string | null;
  pendingGovernanceUpdate: boolean;
  timers: {
    projectWallMs: number;
    projectActiveMs: number;
    taskWallMs: number;
    planningStagnationMs: number;
    timePressure: 'normal' | 'elevated' | 'critical';
    unapprovedPlanAttempts: number;
  } | null;
  frontierOverview: string | null;
  frontierStages: FrontierStageObservation[];
  members: TeamMemberObservation[];
  governanceEvents: GovernanceEventObservation[];
  roleReceipts: Record<string, {
    configuredRoute: string;
    actualRoutes: string[];
    calls: number;
    degradedCalls: number;
    totalTokens: number | null;
  }>;
  gateSummary: {
    reviews: number;
    allow: number;
    deny: number;
    degraded: number;
  };
}

export interface RuntimeSnapshot {
  modelPool: {
    configuredRoutes: string[];
    executionPool: string[];
    disabledRoutes: string[];
  };
  roleAssignments: Record<string, RoleAssignment>;
  syncState: {
    dshSettingsSynced: boolean;
    patchSynced: boolean;
    governanceHash: string | null;
  };
  scheduler: {
    maxActiveMembers: number;
    effectiveCap: number | null;
    activeExecutionMembers: number;
    pressureBand: string;
  };
  power: {
    enabled: boolean;
    onBattery: boolean | null;
    batteryPct: number | null;
    latched: boolean;
  };
  requestWindows: Array<{
    provider: string;
    used5h: number;
    limit5h: number | null;
    tier: string;
  }>;
  teams: TeamObservation[];
}

/* ==================== 6. Usage Records (Hengzhang Contract) ==================== */

export interface UsageAttemptRecord {
  attemptIndex: number;
  upstreamProvider: string;
  upstreamModel: string;
  status: number | 'ok' | 'error' | 'timeout' | 'unknown';
  latencyMs: number | null;
  ttftMs: number | null;
}

export interface LogicalUsageRecord {
  logicalRequestId: string;
  timestampMs: number;
  status: 'ok' | 'error' | 'aborted' | 'unknown';
  requestedRoute: string;
  /** Must be explicit "unknown" when upstream vendor is unavailable; never fabricated */
  actualProvider: string;
  /** Must be explicit "unknown" when served model is unavailable; never fabricated */
  actualModel: string;
  sourceKind: 'magpie' | 'direct' | 'dsh-session' | 'lt-governance' | 'unknown';
  physicalAttemptCount: number | null;
  attempts?: UsageAttemptRecord[];
  latencyMs: number | null;
  ttftMs: number | null;
  metered: boolean;
  tokens: {
    uncachedInputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    outputTokens: number | null;
    /** Subset of outputTokens (informational only; never summed into totalTokens again) */
    reasoningTokens: number | null;
    totalTokens: number | null;
  };
  cost: {
    known: boolean;
    currency: 'CNY' | 'USD' | null;
    actualCny: number | null;
    peakCny: number | null;
    offPeakCny: number | null;
    actualUsd: number | null;
    priceSource: 'gateway' | 'catalog' | 'custom' | 'unknown';
  };
  attribution: {
    sessionId: string | null;
    teamId: string | null;
    taskSeq: number | null;
    stageId: string | null;
    group: 'leader' | 'execution' | 'governance' | 'main' | 'subagents' | 'unknown';
    role: string | null;
    actorName: string | null;
    degraded: boolean;
  };
}

/* ==================== 7. Theme & UI Preferences ==================== */

export type ThemePresetId = 'white' | 'dark' | 'heluoxu' | 'custom';

export interface CustomThemeSeeds {
  canvasColor: string;
  surfaceColor: string;
  inkColor: string;
  accentColor: string;
  dangerColor: string;
  headingFontMode: 'serif' | 'sans';
  cornerStyle: 'sharp' | 'balanced' | 'pill-cta';
  density: 'compact' | 'standard' | 'comfortable';
}

export interface UiPreferences {
  theme: ThemePresetId;
  customTheme: CustomThemeSeeds;
  usageAnalyticsEnabled: boolean;
  autoRefreshMs: number;
}
