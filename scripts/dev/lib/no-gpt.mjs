// Tests avoid GPT routes by default: the Codex quota funds automatic approvals and is lost once exhausted.
// Real-model test tools refuse GPT roles and drop GPT models from the execution pool unless --allow-gpt is given.
export const ROLE_KEYS = ['leader', 'gate', 'discussA', 'discussB', 'arbiter', 'serialReviewer'];
export function gptRoutes(cfg) {
  return Object.entries(cfg.models ?? {}).filter(([, m]) => m?.family === 'gpt').map(([route]) => route);
}
/** Roles whose configured route is a GPT model: [{role, route}]. Pure. */
export function gptRoles(cfg, keys = ROLE_KEYS) {
  const gpt = new Set(gptRoutes(cfg));
  return keys.filter(k => gpt.has(cfg.roles?.[k]?.route)).map(k => ({ role: k, route: cfg.roles[k].route }));
}
/** A copy of the raw config whose execution pool has no GPT model; throws when nothing would remain. Pure. */
export function withoutGptPool(cfg) {
  const gpt = new Set(gptRoutes(cfg));
  const pool = (cfg.team?.executionPool ?? []).filter(r => !gpt.has(r));
  if (pool.length === 0) throw new Error('the execution pool has no non-GPT model; add one or pass --allow-gpt');
  return { ...structuredClone(cfg), team: { ...structuredClone(cfg.team), executionPool: pool } };
}
export const NO_GPT_HELP = 'Tests avoid GPT by default to preserve the Codex quota (it funds automatic approvals and is lost once exhausted). Change these roles to a non-GPT route, or pass --allow-gpt deliberately.';
