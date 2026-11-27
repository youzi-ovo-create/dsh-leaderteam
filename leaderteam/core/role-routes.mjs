// Route chain of one governance role (gate, discussA, discussB, arbiter): the configured primary route, the configured
// fallbacks in order, then the leader's own current model. A later entry is used ONLY when every earlier one is
// unavailable (transport failure, timeout, exhausted quota, unparseable output). A parsed answer is final: a denial or
// a "revise" is never re-asked on another route. Every entry after the first is marked degraded so receipts, the usage
// ledger and tool results can show that the role did not run on its configured model. Pure.

import { resolveModelTarget } from './upstream-models.mjs';
/** @returns {{provider:string, route:string, effort:string, maxTokens:number, timeoutMs:number, retries:number, via:'primary'|'fallback'|'leader', degraded:boolean}[]} */
export function roleRouteChain(config, roleKey, leaderModel = null) {
  const role = config.roles[roleKey];
  if (!role) throw new Error(`unknown governance role "${roleKey}"`);
  const provider = config.magpie.provider;
  const limits = { maxTokens: role.maxTokens, timeoutMs: role.timeoutMs, retries: role.retries };
  const chain = [{ provider, route: role.route, effort: role.effort, ...limits, via: 'primary', degraded: false }];
  for (const f of role.fallback ?? []) {
    chain.push({
      provider, route: f.route, effort: f.effort,
      maxTokens: f.maxTokens ?? limits.maxTokens, timeoutMs: f.timeoutMs ?? limits.timeoutMs, retries: f.retries ?? limits.retries,
      via: 'fallback', degraded: true,
    });
  }
  if (config.team?.leaderModelAsLastResort !== false && leaderModel && typeof leaderModel.model === 'string') {
    const models = config.models ?? {};
    const leaderDefault = config.roles?.leader;
    const matchesLeaderPair = (rKey, spec) => {
      if (!spec || typeof spec !== 'object') return false;
      const specProv = spec.provider ?? provider;
      const specModel = spec.upstreamModel ?? rKey;
      return (leaderModel.provider === undefined || leaderModel.provider === specProv) && specModel === leaderModel.model;
    };
    let leaderRoute = null;
    if (leaderDefault?.route && Object.hasOwn(models, leaderDefault.route) && matchesLeaderPair(leaderDefault.route, models[leaderDefault.route])) {
      leaderRoute = leaderDefault.route;
    } else if (Object.hasOwn(models, leaderModel.model) && matchesLeaderPair(leaderModel.model, models[leaderModel.model])) {
      leaderRoute = leaderModel.model;
    } else {
      for (const [rKey, spec] of Object.entries(models)) {
        if (matchesLeaderPair(rKey, spec)) {
          leaderRoute = rKey;
          break;
        }
      }
      if (!leaderRoute && leaderModel.provider === undefined && Object.hasOwn(models, leaderModel.model)) {
        leaderRoute = leaderModel.model;
      }
    }
    const m = leaderRoute ? models[leaderRoute] : null;
    const mProv = m?.provider ?? provider;
    // Only a model this configuration knows on the matching provider can stand in: its efforts are validated and its quota is tracked.
    if (m && (leaderModel.provider === undefined || leaderModel.provider === mProv)) {
      const effort = Array.isArray(m.efforts) && m.efforts.includes(leaderModel.reasoningEffort) ? leaderModel.reasoningEffort : m.defaultEffort;
      if (typeof effort === 'string') chain.push({ provider: mProv, route: leaderRoute, effort, ...limits, via: 'leader', degraded: true });
    }
  }
  const seen = new Set();
  return chain.map(t => {
    const x = resolveModelTarget(config, t.route, t.effort);
    const contextWindow = config.models?.[t.route]?.contextWindow;
    return {
      ...t,
      provider: x.provider,
      model: x.model,
      ...(x.maxTokens !== undefined ? { modelMaxTokens: x.maxTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  }).filter(t => { const k = `${t.provider}\u0000${t.model}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Short human-readable note for a degraded answer, or null when the role ran on its configured route. */
export function degradedNote(roleKey, target) {
  if (!target || !target.degraded) return null;
  return `${roleKey} ran on ${target.via === 'leader' ? "the leader's model" : 'a fallback route'} ${target.route} because its configured route was unavailable`;
}
