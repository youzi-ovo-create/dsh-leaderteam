// Shared constants. Pure module: no DSH imports.
export const PRODUCT = 'leaderteam';
export const GATE_DENIED_CODE = 'LT_GATE_DENIED';
export const GATE_DENIED_NAME = 'LeaderTeamGateDenied';
export const ROLES = Object.freeze(['leader', 'member', 'direct_exec']);
export const STANCES = Object.freeze(['approve', 'reject', 'revise']);
export const AGREEMENT_KINDS = Object.freeze(['plan', 'delivery', 'dispute', 'architecture', 'security-design', 'interface', 'risk']);
export const MODEL_USES = Object.freeze(['leader', 'execute', 'gate', 'discuss', 'arbiter']);
export const FAMILIES = Object.freeze(['gpt', 'glm', 'gemini', 'deepseek', 'claude', 'qwen', 'other']);
export const QUOTA_STATUS = Object.freeze(['ok', 'low', 'exhausted', 'unknown']);
export const MEMBER_TERMINAL_STATUSES = Object.freeze(['done', 'blocked', 'failed', 'cancelled']);
export const MEMBER_PAUSED_STATUSES = Object.freeze(['paused']);
export const DIRECT_EXEC_ALLOWED_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'pwsh', 'bash']);
export const LEADER_AUTONOMOUS_TOOLS = Object.freeze(['team_direct_exec', 'team_conference']);
export const PLAN_CATEGORIES = Object.freeze([
  'architecture',
  'feature',
  'bugfix',
  'refactor',
  'security',
  'performance',
  'testing',
  'docs',
  'ops',
  'general',
]);
export const TIME_PRESSURE_LEVELS = Object.freeze(['normal', 'elevated', 'critical']);
export const PLAN_LIFECYCLE_STATES = Object.freeze([
  'open',
  'approved',
  'revised',
  'rejected',
  'superseded',
  'selected_best_fallback',
  'executed',
  'retrospected',
]);
export const MEMBER_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const MODEL_ROUTE_RE = /^[A-Za-z0-9._@-]+\/[A-Za-z0-9._:\-@/]+$/;
export const EFFORT_ID_RE = /^[A-Za-z0-9._-]{1,32}$/;
// DSH's adapter schema accepts only these reasoning-effort keys. `none` means
// omit reasoningEffort entirely; it must never be emitted as a YAML key.
export const DSH_EFFORTS = Object.freeze(['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const DETACHABLE_PLUGINS = Object.freeze([
  'scheduler',
  'consensus',
  'timerArchive',
  'panel',
]);

/** Error thrown for invalid input at module boundaries; `code` is stable. */
export class LtError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LtError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
/** Tools that may be listed in gate.ruleOnlyTools: they have no effect outside LeaderTeam's own references directory, and
 *  their own deterministic checks (path containment, no symlinks, size) are the whole policy. Everything else stays reviewed. */
export const RULE_ONLY_ELIGIBLE_TOOLS = Object.freeze(['team_note', 'team_plan', 'team_conference']);
