// Execution model catalog rows and choice validation. Pure.
import { routeQuota, routeUsage } from './quota.mjs';
import { resolveModelTarget } from './upstream-models.mjs';

export function executionModelRows(config, quotaState, now) {
  return config.team.executionPool.map(route => {
    const m = (config.derived.executionModels ?? config.models)[route];
    const target = resolveModelTarget(config, route, m.defaultEffort);
    return {
      route, family: m.family, label: m.label, efforts: [...m.efforts], defaultEffort: m.defaultEffort,
      provider: target.provider, upstreamModel: target.model,
      contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null,
      strengths: m.strengths ?? '', vision: m.vision === true,
      quota: routeQuota(quotaState, route, m, config.quota, now),
      usage: routeUsage(quotaState, route),
    };
  });
}
/** Validate a leader's execution choice. Returns {ok:true} or {ok:false, error}. Never substitutes. */
export function validateExecutionChoice(config, route, effort) {
  if (!config.team.executionPool.includes(route)) return { ok: false, error: `model "${route}" is not in the execution pool: ${config.team.executionPool.join(', ')}` };
  const m = (config.derived.executionModels ?? config.models)[route];
  if (!m.efforts.includes(effort)) return { ok: false, error: `effort "${effort}" is not supported by ${route}; supported: ${m.efforts.join(', ')}` };
  return { ok: true };
}
/** Quota decision for a spawn or a consensus call: {allowed, quota, error?}. */
export function quotaGate(config, quotaState, route, now) {
  const modelCfg = config.models[route];
  const quota = routeQuota(quotaState, route, modelCfg, config.quota, now);
  if (quota.status === 'exhausted') return { allowed: false, quota, error: `model ${route} quota is exhausted (${quota.reason}${quota.nextResetAt ? `, resets ${quota.nextResetAt}` : ''}); choose another model` };
  if (quota.status === 'unknown') {
    const isGpt = modelCfg?.family === 'gpt';
    // Only guard Magpie's shared Codex reserve by default; user-configured direct GPT providers pass freely when stateFile is null.
    const isMagpieSharedGpt = isGpt && (!modelCfg?.provider || modelCfg.provider === config.magpie?.provider);
    const allow = isMagpieSharedGpt ? (config.quota.allowUnknownGpt && config.quota.allowUnknown) : config.quota.allowUnknown;
    if (!allow) {
      const flag = isMagpieSharedGpt && !config.quota.allowUnknownGpt ? 'quota.allowUnknownGpt' : 'quota.allowUnknown';
      return { allowed: false, quota, error: `quota for ${route} is unknown (${quota.reason}) and ${flag} is false` };
    }
  }
  return { allowed: true, quota };
}
/**
 * Compare the leader session's live model selection with roles.leader.
 * selection: {provider, model, reasoningEffort?} | undefined (unknown). Policy team.leaderModelPolicy:
 * - "follow" (default): automatically syncs user session model/effort changes without throwing mismatch errors;
 * - "enforce" (opt-in): strictly blocks team tools on mismatch or unknown;
 * - "warn": reports mismatch without blocking;
 * - "off": skips the check.
 */
export function checkLeaderModel(config, selection) {
  const policy = config.team.leaderModelPolicy ?? 'follow';
  const target = resolveModelTarget(config, config.roles.leader.route, config.roles.leader.effort);
  const configured = { provider: target.provider, model: target.model, route: config.roles.leader.route, effort: config.roles.leader.effort };
  const actual = selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
    ? { provider: selection.provider, model: selection.model, effort: selection.reasoningEffort ?? null }
    : null;
  const base = { policy, configured, actual };
  if (policy === 'off') return { ...base, status: 'unchecked', blocked: false };
  if (policy === 'follow') {
    if (actual === null) return { ...base, status: 'follow-default', blocked: false };
    const effortMatches = configured.effort === 'none'
      ? (actual.effort === null || actual.effort === 'none')
      : (actual.effort === null || actual.effort === configured.effort);
    if (actual.provider === configured.provider && actual.model === configured.model && effortMatches) {
      return { ...base, status: 'match', blocked: false };
    }
    return {
      ...base,
      status: 'synced',
      blocked: false,
      note: `session leader synced to ${actual.provider}/${actual.model}${actual.effort ? ` (${actual.effort})` : ''}`,
    };
  }
  if (actual === null) {
    const message = `cannot determine this leader session's model; the configured leader is ${configured.provider}/${configured.model} (roles.leader)`;
    return { ...base, status: 'unknown', blocked: policy === 'enforce', message };
  }
  if (actual.provider === configured.provider && actual.model === configured.model) {
    const effortMatches = configured.effort === 'none'
      ? (actual.effort === null || actual.effort === 'none')
      : (actual.effort === configured.effort);
    if (!effortMatches) {
      return { ...base, status: actual.effort === null ? 'unknown' : 'mismatch', blocked: policy === 'enforce', message: `leader reasoning effort is ${actual.effort ?? 'Auto/unknown'}; configured ${configured.effort}. Select that effort or update roles.leader.effort.` };
    }
    return { ...base, status: 'match', blocked: false };
  }
  const message = `this LeaderTeam session runs ${actual.provider}/${actual.model}, but the configured leader is ${configured.provider}/${configured.model} (${configured.effort}). Switch this session's model to it, or change roles.leader in leaderteam.config.json.`;
  return { ...base, status: 'mismatch', blocked: policy === 'enforce', message };
}
