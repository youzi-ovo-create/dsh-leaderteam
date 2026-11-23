// Exact task grants. Discovery never exposes schemas; loading cannot widen a grant.
export const CAPABILITY_TOOLS = Object.freeze(['team_tools', 'team_skills']);

export function memberToolGrant(config, profileId, requested, deferred = []) {
  const profile = config.profiles[profileId];
  if (!profile || profileId === 'leader') throw new Error(`unknown member profile: ${profileId}`);
  if (!Array.isArray(requested) || !requested.length || requested.some(n => typeof n !== 'string' || !n.trim())) {
    throw new Error('tools must explicitly list the tools needed for this task');
  }
  const pool = new Set([...profile.tools, ...(config.toolPolicy?.additionalTools ?? [])]);
  const forbidden = requested.filter(n => !pool.has(n));
  if (forbidden.length) throw new Error(`tools outside ${profileId} deployment policy: ${forbidden.join(', ')}`);
  if (!Array.isArray(deferred) || deferred.some(n => !requested.includes(n))) throw new Error('defer_tools must be a subset of tools');
  if (deferred.some(n => CAPABILITY_TOOLS.includes(n))) throw new Error('capability control tools cannot be deferred');
  const allowedTools = [...new Set([...requested, ...CAPABILITY_TOOLS])];
  const loadedTools = allowedTools.filter(n => !deferred.includes(n));
  return { allowedTools, loadedTools };
}

export function effectiveToolNames(actor) {
  const allowed = new Set(actor?.allowedTools ?? []);
  return new Set((actor?.loadedTools ?? [...allowed]).filter(n => allowed.has(n)));
}

export function filterToolView(view, actor) {
  if (!actor && !CAPABILITY_TOOLS.some(name => view.knownNames.has(name))) return view;
  const allowed = actor ? effectiveToolNames(actor) : null;
  const isVisible = name => allowed ? allowed.has(name) : !CAPABILITY_TOOLS.includes(name);
  const visible = new Map([...view.visible].filter(([name]) => isVisible(name)));
  return { ...view, visible, knownNames: new Set([...view.knownNames].filter(isVisible)) };
}

export function toolCatalog(config, profileId, definitions) {
  const pool = new Set([...(config.profiles[profileId]?.tools ?? []), ...(config.toolPolicy?.additionalTools ?? [])]);
  const byName = new Map(definitions.map(d => [d.name, d]));
  return [...pool].sort().map(name => ({ name, available: byName.has(name), description: String(byName.get(name)?.description ?? '').slice(0, 240) }));
}
