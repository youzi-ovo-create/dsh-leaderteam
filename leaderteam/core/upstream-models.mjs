// Dynamic upstream model discovery & multi-provider route resolution for DeepSeek Harness.
// Queries live DSH `ctx.llm` adapters and `/v1/models` endpoints so LeaderTeam automatically
// obtains real `contextWindow` and `maxTokens` capacities without hardcoded caps.
import { EFFORT_ID_RE, MODEL_ROUTE_RE, DSH_EFFORTS } from './constants.mjs';
import { deepFreeze } from './canonical.mjs';

const LEGACY_HARDCODED_CONTEXT_WINDOW = 131072;
const LEGACY_HARDCODED_MAX_TOKENS = 16384;

function positiveInt(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isInteger(c) && c > 0) return c;
  }
  return undefined;
}

export function inferModelFamily(routeOrId, providerId = '') {
  const lower = `${providerId}/${String(routeOrId ?? '')}`.toLowerCase();
  if (lower.includes('codex/') || /(?:^|\/)(?:gpt-|o1|o3|o4|chatgpt)/.test(lower)) return 'gpt';
  if (lower.includes('zcode/') || lower.includes('glm')) return 'glm';
  if (lower.includes('gemini') || lower.includes('antigravity/gemini')) return 'gemini';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('qwen') || lower.includes('tongyi')) return 'qwen';
  return 'other';
}

export function sanitizeModelIdForRoute(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._:\-@/]/g, '-');
}

/**
 * Compute a collision-free LeaderTeam route `<prefix>/<name>` for an upstream `(provider, modelId)`.
 * Existing routes bound to a different `(provider, upstreamModel)` are never overwritten.
 */
export function canonicalRouteFor(providerId, modelId, {
  defaultProvider = 'magpie',
  existingModels = {},
} = {}) {
  const prov = sanitizeModelIdForRoute(providerId || defaultProvider) || 'magpie';
  const cleanId = sanitizeModelIdForRoute(modelId);
  if (!cleanId) return null;

  for (const [existingRoute, spec] of Object.entries(existingModels ?? {})) {
    const exProv = spec?.provider ?? defaultProvider;
    const exModel = spec?.upstreamModel ?? existingRoute;
    if (exProv === prov && exModel === modelId) {
      return existingRoute;
    }
  }

  const candidates = [];
  if (prov === defaultProvider) {
    if (cleanId.includes('/')) candidates.push(cleanId);
    candidates.push(`${prov}/${cleanId}`);
    candidates.push(`${prov}@upstream/${cleanId}`);
  } else {
    candidates.push(`${prov}/${cleanId}`);
    candidates.push(`${prov}@direct/${cleanId}`);
  }

  for (const cand of candidates) {
    if (!MODEL_ROUTE_RE.test(cand)) continue;
    const collision = existingModels?.[cand];
    if (!collision) return cand;
    const colProv = collision.provider ?? defaultProvider;
    const colModel = collision.upstreamModel ?? cand;
    if (colProv === prov && colModel === modelId) return cand;
  }
  return null;
}

export function inferEffortsFromMetadata({ family, modelId, resolvedInfo, fromEndpointOnly = false }) {
  const rawList = Array.isArray(resolvedInfo?.reasoning?.efforts)
    ? resolvedInfo.reasoning.efforts
    : Array.isArray(resolvedInfo?.reasoningEfforts)
      ? resolvedInfo.reasoningEfforts
      : Array.isArray(resolvedInfo?.reasoning_levels)
        ? resolvedInfo.reasoning_levels
        : [];
  const rawEfforts = rawList
    .map(e => (typeof e === 'string' ? e : e?.id))
    .filter(e => typeof e === 'string' && EFFORT_ID_RE.test(e) && DSH_EFFORTS.includes(e));
  if (rawEfforts.length > 0) {
    const deduped = [...new Set(rawEfforts)];
    const def = resolvedInfo?.reasoning?.defaultEffort ?? resolvedInfo?.defaultEffort;
    return {
      efforts: deduped,
      defaultEffort: (typeof def === 'string' && deduped.includes(def)) ? def : deduped[0],
    };
  }
  if (resolvedInfo && !fromEndpointOnly) {
    return { efforts: ['none'], defaultEffort: 'none' };
  }
  const lower = String(modelId ?? '').toLowerCase();
  if (/(?:gpt-6|gpt-5|o1|o3|o4)/.test(lower)) {
    return { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' };
  }
  if (/glm-5/.test(lower)) {
    return { efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
  }
  if (/deepseek-v4/.test(lower)) {
    return { efforts: ['low', 'high', 'max'], defaultEffort: 'high' };
  }
  if (/(?:gemini-3|gemini-4|reasoner|deepseek-r1|qwq|thinking|claude-opus|claude-sonnet)/.test(lower)) {
    return { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' };
  }
  return { efforts: ['none'], defaultEffort: 'none' };
}

/**
 * Parse a `/v1/models` JSON payload (`{ data: [...] }` or `{ models: {...} }`) into normalized records
 * preserving vendor `contextWindow`, `maxTokens`, `vision`, and `reasoningEfforts`. Pure.
 */
export function parseUpstreamModelsPayload(body) {
  if (!body || typeof body !== 'object') return [];
  let listed = [];
  if (Array.isArray(body.data)) {
    listed = body.data.map(raw => ({ raw }));
  } else if (body.models && typeof body.models === 'object' && !Array.isArray(body.models)) {
    listed = Object.entries(body.models)
      .filter(([, raw]) => raw && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }));
  } else {
    return [];
  }

  const out = [];
  for (const { key, raw } of listed) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (typeof key === 'string' && key.trim()) ? key.trim() : (typeof raw.id === 'string' ? raw.id.trim() : '');
    if (!id) continue;
    const name = [raw.name, raw.display_name, raw.displayName].find(s => typeof s === 'string' && s.trim())?.trim() ?? id;
    const contextWindow = positiveInt(
      raw.contextWindow,
      raw.context_window,
      raw.context_length,
      raw.max_input_tokens,
      raw.limit?.context,
      raw.top_provider?.context_length,
    );
    const maxTokens = positiveInt(
      raw.maxOutputTokens,
      raw.max_output_tokens,
      raw.maxTokens,
      raw.max_tokens,
      raw.limit?.output,
      raw.top_provider?.max_completion_tokens,
    );
    const inputMods = Array.isArray(raw.inputModalities)
      ? raw.inputModalities
      : Array.isArray(raw.input)
        ? raw.input
        : Array.isArray(raw.modalities?.input)
          ? raw.modalities.input
          : Array.isArray(raw.architecture?.input_modalities)
            ? raw.architecture.input_modalities
            : null;
    const vision = inputMods ? inputMods.includes('image') : undefined;
    const reasoningLevels = Array.isArray(raw.reasoning_levels)
      ? raw.reasoning_levels.filter(e => typeof e === 'string' && DSH_EFFORTS.includes(e))
      : undefined;
    out.push({
      id,
      name,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(reasoningLevels?.length ? { reasoning_levels: reasoningLevels } : {}),
    });
  }
  return out;
}

/**
 * Directly query an OpenAI-compatible `/v1/models` endpoint (such as local Magpie) to discover
 * live model capacities (`contextWindow`, `maxTokens`, `vision`, `reasoning_levels`). Never throws.
 */
export async function fetchEndpointModelsCatalog(baseURL, {
  apiKey,
  headers: extraHeaders,
  timeoutMs = 4000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof baseURL !== 'string' || !baseURL.trim() || typeof fetchImpl !== 'function') {
    return { ok: false, error: 'missing-baseurl-or-fetch', models: [] };
  }
  const url = `${baseURL.trim().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(extraHeaders ? Object.entries(extraHeaders) : undefined);
    headers.set('accept', 'application/json');
    if (typeof apiKey === 'string' && apiKey.trim()) {
      headers.set('authorization', `Bearer ${apiKey.trim()}`);
    }
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} from ${url}`, models: [] };
    }
    const json = await res.json();
    return { ok: true, models: parseUpstreamModelsPayload(json) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the exact DSH `{ provider, model, reasoningEffort?, maxTokens? }` call target for a LeaderTeam route.
 * Non-reasoning models (`effort === 'none'`) omit `reasoningEffort` so DSH adapters never reject them.
 * Explicit or upstream-discovered `spec.maxTokens` is forwarded without imposing any artificial ceiling.
 */
export function resolveModelTarget(config, route, effort) {
  const spec = config?.models?.[route];
  const provider = spec?.provider ?? config?.magpie?.provider ?? 'magpie';
  const model = spec?.upstreamModel ?? route;
  const normalizedEffort = (typeof effort === 'string' && effort.trim() !== '' && effort !== 'none')
    ? effort.trim()
    : undefined;
  const maxTokens = positiveInt(spec?.maxTokens);
  return {
    provider,
    model,
    ...(normalizedEffort ? { reasoningEffort: normalizedEffort } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/**
 * Interrogate DSH's live `ctx.llm` providers/models and (when `probeEndpoints` is true) upstream `/v1/models` endpoints.
 * Enriches already-registered DSH models with live upstream `contextWindow` and `maxTokens` so stale static caps are replaced.
 */
export async function discoverRuntimeModels(ctx, config, {
  probeEndpoints = false,
  endpointBaseUrl = null,
  endpointApiKey = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  let llm = null;
  try { llm = ctx?.llm ?? null; } catch {}
  if (!llm) {
    try { llm = ctx?.get?.('llm') ?? null; } catch {}
  }
  const defaultProvider = config?.magpie?.provider ?? 'magpie';
  const workingModels = { ...(config?.models ?? {}) };
  const providers = [];
  const discovered = [];
  const endpointErrors = [];
  const byPairKey = new Map();

  if (llm && typeof llm.listProviders === 'function') {
    let providerList = [];
    try { providerList = llm.listProviders() ?? []; } catch {}
    for (const p of providerList) {
      const pid = typeof p === 'string' ? p : p?.id;
      if (!pid || typeof pid !== 'string') continue;
      providers.push({ id: pid, name: (typeof p === 'object' && p?.name) ? p.name : pid, source: 'dsh-llm' });
      let models = [];
      try {
        if (typeof llm.listModels === 'function') {
          models = (await llm.listModels(pid)) ?? [];
        }
      } catch (e) {
        endpointErrors.push({ provider: pid, stage: 'listModels', error: e instanceof Error ? e.message : String(e) });
      }
      for (const m of models) {
        const mid = typeof m === 'string' ? m : m?.id;
        if (!mid || typeof mid !== 'string') continue;
        const pairKey = `${pid}\u0000${mid}`;
        if (byPairKey.has(pairKey)) continue;

        let info = null;
        try {
          if (typeof llm.resolveModelInfo === 'function') {
            info = await llm.resolveModelInfo(pid, mid);
          }
        } catch {}
        const family = inferModelFamily(mid, pid);
        const { efforts, defaultEffort } = inferEffortsFromMetadata({
          family,
          modelId: mid,
          resolvedInfo: info,
          fromEndpointOnly: false,
        });
        const route = canonicalRouteFor(pid, mid, { defaultProvider, existingModels: workingModels });
        if (!route) continue;
        const label = (typeof info?.name === 'string' && info.name.trim())
          ? info.name.trim()
          : ((typeof m === 'object' && typeof m?.name === 'string' && m.name.trim()) ? m.name.trim() : mid);
        const infoCtx = positiveInt(info?.context?.contextWindow);
        const infoMax = positiveInt(info?.defaultMaxTokens);
        const isLegacyStaticCap = infoCtx === LEGACY_HARDCODED_CONTEXT_WINDOW && infoMax === LEGACY_HARDCODED_MAX_TOKENS;
        const entry = {
          route,
          provider: pid,
          upstreamModel: mid,
          family,
          label,
          efforts,
          defaultEffort,
          strengths: (typeof m === 'object' && typeof m?.description === 'string' && m.description.trim())
            ? m.description.trim()
            : `DSH upstream (${pid})`,
          vision: info?.input?.includes?.('image') === true || info?.inputModalities?.includes?.('image') === true,
          contextWindow: isLegacyStaticCap ? null : (infoCtx ?? null),
          defaultMaxTokens: isLegacyStaticCap ? null : (infoMax ?? null),
          maxTokens: isLegacyStaticCap ? null : (infoMax ?? null),
          upstreamContextWindow: null,
          upstreamMaxTokens: null,
          registeredInDsh: true,
          inStaticConfig: Boolean(Object.hasOwn(config?.models ?? {}, route)),
          source: 'dsh-llm',
        };
        byPairKey.set(pairKey, entry);
        workingModels[route] ??= entry;
        discovered.push(entry);
      }
    }
  }

  const mergeRemoteList = (pid, remoteModels) => {
    if (!providers.some(x => x.id === pid)) {
      providers.push({ id: pid, name: pid, source: 'upstream-endpoint' });
    }
    for (const rm of remoteModels) {
      const mid = typeof rm === 'string' ? rm : rm?.id;
      if (!mid || typeof mid !== 'string') continue;
      const pairKey = `${pid}\u0000${mid}`;
      const upCtx = positiveInt(rm?.contextWindow);
      const upMax = positiveInt(rm?.maxTokens);
      const existing = byPairKey.get(pairKey);
      if (existing) {
        if (upCtx !== undefined) {
          existing.upstreamContextWindow = upCtx;
          existing.contextWindow = upCtx;
        }
        if (upMax !== undefined) {
          existing.upstreamMaxTokens = upMax;
          existing.defaultMaxTokens = upMax;
          existing.maxTokens = upMax;
        }
        if (typeof rm?.vision === 'boolean') existing.vision = rm.vision;
        if (Array.isArray(rm?.reasoning_levels) && rm.reasoning_levels.length > 0 && existing.efforts.length === 1 && existing.efforts[0] === 'none') {
          const inferred = inferEffortsFromMetadata({ family: existing.family, modelId: mid, resolvedInfo: rm, fromEndpointOnly: true });
          existing.efforts = inferred.efforts;
          existing.defaultEffort = inferred.defaultEffort;
        }
        continue;
      }
      const family = inferModelFamily(mid, pid);
      const { efforts, defaultEffort } = inferEffortsFromMetadata({
        family,
        modelId: mid,
        resolvedInfo: rm,
        fromEndpointOnly: true,
      });
      const route = canonicalRouteFor(pid, mid, { defaultProvider, existingModels: workingModels });
      if (!route) continue;
      const entry = {
        route,
        provider: pid,
        upstreamModel: mid,
        family,
        label: (typeof rm === 'object' && typeof rm?.name === 'string' && rm.name.trim()) ? rm.name.trim() : mid,
        efforts,
        defaultEffort,
        strengths: `Discovered from upstream endpoint (${pid})`,
        ...(typeof rm?.vision === 'boolean' ? { vision: rm.vision } : {}),
        contextWindow: upCtx ?? null,
        defaultMaxTokens: upMax ?? null,
        maxTokens: upMax ?? null,
        upstreamContextWindow: upCtx ?? null,
        upstreamMaxTokens: upMax ?? null,
        registeredInDsh: false,
        inStaticConfig: Boolean(Object.hasOwn(config?.models ?? {}, route)),
        source: 'upstream-endpoint',
      };
      byPairKey.set(pairKey, entry);
      workingModels[route] ??= entry;
      discovered.push(entry);
    }
  };

  if (probeEndpoints) {
    const probedBaseUrls = new Set();
    if (llm && typeof llm.discoverModels === 'function') {
      const settings = ctx?.get?.('settings');
      const settingsMap = new Map();
      try {
        const desc = settings?.describe?.({ redactSecrets: false }) ?? settings?.describe?.({ redactSecrets: true });
        for (const ns of desc?.namespaces ?? []) {
          if (ns?.ns) settingsMap.set(ns.ns, ns);
        }
      } catch {
        try {
          const desc = settings?.describe?.({ redactSecrets: true });
          for (const ns of desc?.namespaces ?? []) {
            if (ns?.ns) settingsMap.set(ns.ns, ns);
          }
        } catch {}
      }

      let configurable = [];
      try {
        if (typeof llm.listConfigurableProviders === 'function') {
          configurable = llm.listConfigurableProviders() ?? [];
        }
      } catch {}

      for (const cp of configurable) {
        const ns = cp?.settingsNs;
        if (!ns) continue;
        const nsSnap = settingsMap.get(ns);
        const rawProviders = nsSnap?.data?.providers;
        const provIds = rawProviders && typeof rawProviders === 'object'
          ? Object.keys(rawProviders)
          : providers.map(p => p.id);
        for (const pid of provIds) {
          const provCfg = rawProviders?.[pid];
          try {
            const req = {
              provider: pid,
              ...(typeof provCfg?.baseURL === 'string' && provCfg.baseURL ? { baseURL: provCfg.baseURL } : {}),
              ...(typeof provCfg?.api === 'string' && provCfg.api ? { api: provCfg.api } : {}),
            };
            const remoteModels = (await llm.discoverModels(ns, req)) ?? [];
            mergeRemoteList(pid, remoteModels);
          } catch (e) {
            endpointErrors.push({ provider: pid, stage: 'discoverModels', error: e instanceof Error ? e.message : String(e) });
          }
          if (typeof provCfg?.baseURL === 'string' && provCfg.baseURL.startsWith('http')) {
            const keyEnv = typeof provCfg.apiKeyEnv === 'string' ? process.env[provCfg.apiKeyEnv] : undefined;
            probedBaseUrls.add(`${pid}\u0000${provCfg.baseURL.replace(/\/+$/, '')}`);
            const direct = await fetchEndpointModelsCatalog(provCfg.baseURL, {
              apiKey: keyEnv ?? endpointApiKey,
              headers: provCfg.headers,
              fetchImpl,
            });
            if (direct.ok) mergeRemoteList(pid, direct.models);
          }
        }
      }
    }

    const fallbackUrl = endpointBaseUrl ?? process.env.LT_MAGPIE_BASEURL ?? null;
    if (typeof fallbackUrl === 'string' && fallbackUrl.startsWith('http')) {
      const normKey = `${defaultProvider}\u0000${fallbackUrl.replace(/\/+$/, '')}`;
      if (!probedBaseUrls.has(normKey)) {
        const direct = await fetchEndpointModelsCatalog(fallbackUrl, {
          apiKey: endpointApiKey ?? process.env.LEADERTEAM_MAGPIE_KEY,
          fetchImpl,
        });
        if (direct.ok) mergeRemoteList(defaultProvider, direct.models);
        else endpointErrors.push({ provider: defaultProvider, stage: 'fetchEndpointModelsCatalog', error: direct.error });
      }
    }
  }

  return {
    discoveredAt: new Date().toISOString(),
    providers,
    models: discovered,
    endpointErrors,
  };
}

/**
 * Enrich existing `baseConfig.models` entries with upstream-discovered `contextWindow` and `maxTokens`
 * whenever the user did not explicitly set them in `baseConfig.models[route]`.
 * Never overrides user-configured capacities and never modifies `executionPool`.
 */
export function enrichConfigModelsFromCatalog(baseConfig, catalog) {
  if (!baseConfig || !catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return baseConfig;
  }
  const defaultProvider = baseConfig.magpie?.provider ?? 'magpie';
  const byRoute = new Map();
  const byPair = new Map();
  for (const item of catalog.models) {
    if (!item) continue;
    if (item.route) byRoute.set(item.route, item);
    if (item.provider && item.upstreamModel) byPair.set(`${item.provider}\u0000${item.upstreamModel}`, item);
  }

  let changed = false;
  const nextModels = { ...baseConfig.models };
  for (const [route, spec] of Object.entries(baseConfig.models ?? {})) {
    const prov = spec?.provider ?? defaultProvider;
    const upModel = spec?.upstreamModel ?? route;
    const dm = byRoute.get(route) ?? byPair.get(`${prov}\u0000${upModel}`);
    if (!dm) continue;
    const discCtx = positiveInt(dm.upstreamContextWindow, dm.contextWindow);
    const discMax = positiveInt(dm.upstreamMaxTokens, dm.maxTokens, dm.defaultMaxTokens);
    const needCtx = spec.contextWindow === undefined && discCtx !== undefined;
    const needMax = spec.maxTokens === undefined && discMax !== undefined;
    if (!needCtx && !needMax) continue;
    changed = true;
    nextModels[route] = {
      ...spec,
      ...(needCtx ? { contextWindow: discCtx } : {}),
      ...(needMax ? { maxTokens: discMax } : {}),
    };
  }

  if (!changed) return baseConfig;
  const cloned = structuredClone(baseConfig);
  cloned.models = nextModels;
  if (cloned.derived?.executionModels) {
    cloned.derived.executionModels = { ...cloned.derived.executionModels, ...nextModels };
  }
  return deepFreeze(cloned);
}

/**
 * Return an effective runtime config with upstream capacities enriched on existing models AND
 * newly connected DSH `ctx.llm` models merged into `models` (and `team.executionPool` when `autoIncludeUpstreamModels === true`).
 */
export function mergeUpstreamModelsIntoConfig(baseConfig, catalog) {
  if (!baseConfig || !catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return baseConfig;
  }
  const enriched = enrichConfigModelsFromCatalog(baseConfig, catalog);
  const autoPool = enriched.team?.autoIncludeUpstreamModels === true;
  const disabledRoutes = new Set(enriched.team?.disabledModels ?? []);
  const disabledFamilies = new Set(enriched.team?.disabledFamilies ?? []);
  const defaultProvider = enriched.magpie?.provider ?? 'magpie';

  let addedAny = false;
  const nextModels = { ...enriched.models };
  const nextPool = [...enriched.team.executionPool];
  const poolSet = new Set(nextPool);

  for (const item of catalog.models) {
    if (!item?.registeredInDsh || !item.route || !MODEL_ROUTE_RE.test(item.route)) continue;
    if (Object.hasOwn(enriched.models, item.route)) continue;
    addedAny = true;
    const discCtx = positiveInt(item.upstreamContextWindow, item.contextWindow);
    const discMax = positiveInt(item.upstreamMaxTokens, item.maxTokens, item.defaultMaxTokens);
    nextModels[item.route] = {
      family: item.family ?? inferModelFamily(item.upstreamModel ?? item.route, item.provider),
      label: item.label ?? item.upstreamModel ?? item.route,
      efforts: Array.isArray(item.efforts) && item.efforts.length ? [...item.efforts] : ['none'],
      defaultEffort: item.defaultEffort ?? (item.efforts?.[0] ?? 'none'),
      strengths: item.strengths ?? `DSH upstream (${item.provider ?? defaultProvider})`,
      ...(typeof item.vision === 'boolean' ? { vision: item.vision } : {}),
      ...(item.provider && item.provider !== defaultProvider ? { provider: item.provider } : {}),
      ...((item.upstreamModel && item.upstreamModel !== item.route) ? { upstreamModel: item.upstreamModel } : {}),
      ...(discCtx !== undefined ? { contextWindow: discCtx } : {}),
      ...(discMax !== undefined ? { maxTokens: discMax } : {}),
    };
    if (
      autoPool &&
      !poolSet.has(item.route) &&
      !disabledRoutes.has(item.route) &&
      !disabledFamilies.has(nextModels[item.route].family)
    ) {
      nextPool.push(item.route);
      poolSet.add(item.route);
    }
  }

  if (!addedAny) return enriched;
  const cloned = structuredClone(enriched);
  cloned.models = nextModels;
  cloned.team.executionPool = nextPool;
  if (cloned.derived?.executionModels) {
    cloned.derived.executionModels = { ...cloned.derived.executionModels, ...nextModels };
  }
  return deepFreeze(cloned);
}

/**
 * Live-register or update upstream models into DSH's `settings` service (`llm-pi-ai`).
 * Never injects hardcoded `131072` / `16384` limits: passes real `contextWindow` and `maxTokens`
 * when known, omits them otherwise (letting DSH `llm-pi-ai` use its native unthrottled defaults),
 * and cleans up stale hardcoded `131072`/`16384` entries on existing models.
 */
export async function syncUpstreamModelsToDshSettings(ctx, modelsToEnsure = [], defaultProvider = 'magpie') {
  const settings = ctx?.get?.('settings');
  if (!settings || typeof settings.describe !== 'function' || typeof settings.update !== 'function') {
    return { synced: false, reason: 'settings-service-unavailable', updatedProviders: [] };
  }
  let desc;
  try { desc = settings.describe({ redactSecrets: false }); } catch {
    try { desc = settings.describe({ redactSecrets: true }); } catch {
      return { synced: false, reason: 'settings-describe-failed', updatedProviders: [] };
    }
  }
  const llmNs = (desc?.namespaces ?? []).find(n => n?.ns === 'llm-pi-ai' || (n?.data && typeof n.data === 'object' && 'providers' in n.data));
  if (!llmNs?.ns || !llmNs.data || typeof llmNs.data !== 'object') {
    return { synced: false, reason: 'llm-namespace-not-found', updatedProviders: [] };
  }
  const nextData = structuredClone(llmNs.data);
  nextData.providers ??= {};
  const updatedProviders = [];

  for (const item of modelsToEnsure) {
    const prov = item.provider ?? defaultProvider;
    const modelId = item.upstreamModel ?? item.route;
    const provObj = nextData.providers[prov];
    if (!provObj || typeof provObj !== 'object') continue;
    provObj.models = Array.isArray(provObj.models) ? provObj.models : [];
    const realEfforts = (item.efforts ?? []).filter(e => e && e !== 'none');
    const existingIdx = provObj.models.findIndex(m => (typeof m === 'string' ? m : m?.id) === modelId);
    const reasoningEfforts = realEfforts.length > 0
      ? Object.fromEntries(realEfforts.map(e => [e, e]))
      : undefined;
    const desiredCtx = positiveInt(item.contextWindow);
    const desiredMax = positiveInt(item.maxTokens, item.defaultMaxTokens);

    if (existingIdx < 0) {
      provObj.models.push({
        id: modelId,
        ...(desiredCtx !== undefined ? { contextWindow: desiredCtx } : {}),
        ...(desiredMax !== undefined ? { maxTokens: desiredMax } : {}),
        input: item.vision ? ['text', 'image'] : ['text'],
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
      });
      if (!updatedProviders.includes(prov)) updatedProviders.push(prov);
    } else if (typeof provObj.models[existingIdx] === 'object' && provObj.models[existingIdx] !== null) {
      const cur = { ...provObj.models[existingIdx] };
      let entryChanged = false;
      if (reasoningEfforts) {
        const curEff = cur.reasoningEfforts ?? {};
        if (realEfforts.some(e => !(e in curEff))) {
          cur.reasoningEfforts = { ...curEff, ...reasoningEfforts };
          entryChanged = true;
        }
      }
      if (desiredCtx !== undefined && cur.contextWindow !== desiredCtx) {
        cur.contextWindow = desiredCtx;
        entryChanged = true;
      } else if (desiredCtx === undefined && cur.contextWindow === LEGACY_HARDCODED_CONTEXT_WINDOW && cur.maxTokens === LEGACY_HARDCODED_MAX_TOKENS) {
        delete cur.contextWindow;
        entryChanged = true;
      }
      if (desiredMax !== undefined && cur.maxTokens !== desiredMax) {
        cur.maxTokens = desiredMax;
        entryChanged = true;
      } else if (desiredMax === undefined && cur.maxTokens === LEGACY_HARDCODED_MAX_TOKENS) {
        delete cur.maxTokens;
        entryChanged = true;
      }
      if (entryChanged) {
        provObj.models[existingIdx] = cur;
        if (!updatedProviders.includes(prov)) updatedProviders.push(prov);
      }
    }
  }

  if (updatedProviders.length === 0) {
    return { synced: true, changed: false, updatedProviders: [] };
  }
  try {
    await settings.update(llmNs.ns, nextData);
    return { synced: true, changed: true, updatedProviders };
  } catch (e) {
    return { synced: false, reason: e instanceof Error ? e.message : String(e), updatedProviders: [] };
  }
}
