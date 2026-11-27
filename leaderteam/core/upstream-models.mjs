// Dynamic upstream model discovery & multi-provider route resolution for DeepSeek Harness.
// Queries live DSH `ctx.llm` adapters and `/v1/models` endpoints so LeaderTeam automatically
// obtains real `contextWindow` and `maxTokens` capacities without hardcoded caps.
import fs from 'node:fs';
import path from 'node:path';
import { EFFORT_ID_RE, MODEL_ROUTE_RE, DSH_EFFORTS } from './constants.mjs';
import { deepFreeze } from './canonical.mjs';
import { writeFileAtomic } from './store.mjs';

const LEGACY_HARDCODED_CONTEXT_WINDOW = 131072;
const LEGACY_HARDCODED_MAX_TOKENS = 16384;
const VALID_PI_AI_EFFORT_KEYS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const BUILTIN_OPENAI_MODEL_PREFIX_RE = /^(?:gpt-3\.5|gpt-4|gpt-5|o1|o3|o4|codex|chatgpt)/i;

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

function applyModelsToProvidersMap(curProviders = {}, modelsToEnsure = [], defaultProvider = 'magpie', providerTemplates = null) {
  const nextProviders = structuredClone(curProviders && typeof curProviders === 'object' ? curProviders : {});
  const updatedProviders = [];

  for (const item of modelsToEnsure) {
    if (!item || typeof item !== 'object') continue;
    const prov = item.provider ?? defaultProvider;
    const modelId = item.upstreamModel ?? item.route;
    if (!prov || !modelId) continue;
    const tpl = providerTemplates?.[prov] ?? null;
    let provObj = nextProviders[prov];
    if ((!provObj || typeof provObj !== 'object') && tpl) {
      const { modelMetadata: _meta, clearApiKeyEnv: _clearKey, ...profileFields } = tpl;
      if (_clearKey === true) delete profileFields.apiKeyEnv;
      provObj = { ...profileFields, models: [] };
      nextProviders[prov] = provObj;
      if (!updatedProviders.includes(prov)) updatedProviders.push(prov);
    } else if (provObj && typeof provObj === 'object' && tpl && typeof tpl === 'object') {
      let provChanged = false;
      const isAuthoritativeTpl =
        !tpl.modelMetadata || Boolean(tpl.clearApiKeyEnv || tpl.headers || tpl.forceBaseURL === true);
      if (tpl.baseURL && (isAuthoritativeTpl ? provObj.baseURL !== tpl.baseURL : !provObj.baseURL)) {
        provObj.baseURL = tpl.baseURL;
        provChanged = true;
      }
      if (tpl.api && !provObj.api) {
        provObj.api = tpl.api;
        provChanged = true;
      }
      if (tpl.apiKeyEnv && !provObj.apiKeyEnv && tpl.clearApiKeyEnv !== true) {
        provObj.apiKeyEnv = tpl.apiKeyEnv;
        provChanged = true;
      }
      if (tpl.displayName && !provObj.displayName) {
        provObj.displayName = tpl.displayName;
        provChanged = true;
      }
      if (tpl.headers && typeof tpl.headers === 'object' && !Array.isArray(tpl.headers)) {
        const curHeaders = (provObj.headers && typeof provObj.headers === 'object' && !Array.isArray(provObj.headers))
          ? provObj.headers
          : {};
        if (Object.keys(tpl.headers).some(k => curHeaders[k] !== tpl.headers[k])) {
          provObj.headers = { ...curHeaders, ...tpl.headers };
          provChanged = true;
        }
      }
      if (tpl.clearApiKeyEnv === true && 'apiKeyEnv' in provObj) {
        delete provObj.apiKeyEnv;
        provChanged = true;
      }
      if (provChanged && !updatedProviders.includes(prov)) {
        updatedProviders.push(prov);
      }
    }
    if (!provObj || typeof provObj !== 'object') continue;
    provObj.models = Array.isArray(provObj.models) ? provObj.models : [];

    // Guard against PiAiCatalogError when custom baseURL is set on builtin `openai` provider
    if (
      prov === 'openai' &&
      !provObj.api &&
      typeof provObj.baseURL === 'string' &&
      provObj.baseURL.trim() &&
      provObj.baseURL.trim().replace(/\/+$/, '') !== 'https://api.openai.com/v1'
    ) {
      provObj.api = 'openai-completions';
      if (!updatedProviders.includes(prov)) updatedProviders.push(prov);
    }

    const rawEfforts = Array.isArray(item.efforts) ? item.efforts : [];
    const realEfforts = rawEfforts.filter(e => typeof e === 'string' && e !== 'none' && VALID_PI_AI_EFFORT_KEYS.has(e));
    const hasNoneWithThinking = realEfforts.length > 0 && rawEfforts.includes('none') && !realEfforts.includes('off');
    const existingIdx = provObj.models.findIndex(m => (typeof m === 'string' ? m : m?.id) === modelId);
    const rawWireMap = (item.reasoningEfforts && typeof item.reasoningEfforts === 'object' && !Array.isArray(item.reasoningEfforts))
      ? item.reasoningEfforts
      : null;
    const explicitWireMap = rawWireMap
      ? Object.fromEntries(
          Object.entries(rawWireMap).filter(([k, v]) => VALID_PI_AI_EFFORT_KEYS.has(k) && typeof v === 'string' && v.trim()),
        )
      : null;
    const reasoningEfforts = realEfforts.length > 0
      ? {
          ...(hasNoneWithThinking ? { off: explicitWireMap?.off ?? 'none' } : {}),
          ...Object.fromEntries(realEfforts.map(e => [
            e,
            explicitWireMap?.[e] ?? (e === 'off' ? 'none' : e),
          ])),
        }
      : undefined;
    const tplModelMeta = tpl?.modelMetadata?.[modelId] ?? null;
    const desiredCtx = positiveInt(item.contextWindow, tplModelMeta?.contextWindow);
    const desiredMax = positiveInt(item.maxTokens, item.defaultMaxTokens ?? tplModelMeta?.maxTokens);
    const desiredCompat = item.compat ?? tplModelMeta?.compat ?? undefined;
    const needsCustomModelApi =
      !provObj.api &&
      prov === 'openai' &&
      !BUILTIN_OPENAI_MODEL_PREFIX_RE.test(modelId);

    if (existingIdx < 0) {
      provObj.models.push({
        id: modelId,
        ...(needsCustomModelApi ? { api: 'openai-completions' } : {}),
        ...(desiredCtx !== undefined ? { contextWindow: desiredCtx } : {}),
        ...(desiredMax !== undefined ? { maxTokens: desiredMax } : {}),
        input: item.vision ? ['text', 'image'] : ['text'],
        ...(reasoningEfforts ? { reasoningEfforts } : (tplModelMeta ? { reasoningEfforts: false } : {})),
        ...(desiredCompat ? { compat: { ...desiredCompat } } : {}),
      });
      if (!updatedProviders.includes(prov)) updatedProviders.push(prov);
    } else if (typeof provObj.models[existingIdx] === 'object' && provObj.models[existingIdx] !== null) {
      const cur = { ...provObj.models[existingIdx] };
      let entryChanged = false;
      if (needsCustomModelApi && !cur.api) {
        cur.api = 'openai-completions';
        entryChanged = true;
      }
      if (reasoningEfforts) {
        const curEff = (cur.reasoningEfforts && typeof cur.reasoningEfforts === 'object')
          ? Object.fromEntries(Object.entries(cur.reasoningEfforts).filter(([k]) => VALID_PI_AI_EFFORT_KEYS.has(k)))
          : {};
        const nextEff = { ...reasoningEfforts, ...curEff, ...(explicitWireMap ?? {}) };
        if (
          typeof cur.reasoningEfforts !== 'object' ||
          cur.reasoningEfforts === null ||
          Object.keys(nextEff).some(k => curEff[k] !== nextEff[k]) ||
          Object.keys(cur.reasoningEfforts).some(k => !VALID_PI_AI_EFFORT_KEYS.has(k))
        ) {
          cur.reasoningEfforts = nextEff;
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

    // DSH PiAiCatalogError forbids setting both `models` and `modelOverrides` on the same provider
    if (provObj.models.length > 0 && 'modelOverrides' in provObj) {
      delete provObj.modelOverrides;
      if (!updatedProviders.includes(prov)) updatedProviders.push(prov);
    }
  }

  return { providers: nextProviders, updatedProviders };
}

/**
 * Live-register or update upstream models into DSH's `settings` service (`llm-pi-ai`).
 * Never injects hardcoded `131072` / `16384` limits: passes real `contextWindow` and `maxTokens`
 * when known, omits them otherwise (letting DSH `llm-pi-ai` use its native unthrottled defaults),
 * and cleans up stale hardcoded `131072`/`16384` entries on existing models.
 */
export async function syncUpstreamModelsToDshSettings(ctx, modelsToEnsure = [], defaultProvider = 'magpie', options = {}) {
  const providerTemplates = options?.providerTemplates ?? null;
  const defaultSelection = options?.defaultSelection ?? null;
  const syncDefaultModel = Boolean(options?.syncDefaultModel);
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
  const nsList = Array.isArray(desc) ? desc : (Array.isArray(desc?.namespaces) ? desc.namespaces : []);
  const resolveNsPayload = entry => {
    if (entry?.value && typeof entry.value === 'object') return entry.value;
    if (entry?.data && typeof entry.data === 'object') return entry.data;
    return null;
  };
  const llmNs = nsList.find(n => {
    const payload = resolveNsPayload(n);
    if (!payload) return false;
    return n?.ns === 'llm-pi-ai' || n?.namespace === 'llm-pi-ai' || ('providers' in payload);
  });
  const targetNs = llmNs?.ns ?? llmNs?.namespace;
  const curPayload = resolveNsPayload(llmNs);
  if (!targetNs || !curPayload) {
    return { synced: false, reason: 'llm-namespace-not-found', updatedProviders: [] };
  }

  const nextData = structuredClone(curPayload);
  const { providers: mergedProviders, updatedProviders } = applyModelsToProvidersMap(
    nextData.providers ?? {},
    modelsToEnsure,
    defaultProvider,
    providerTemplates,
  );
  nextData.providers = mergedProviders;

  let defaultModelSynced = false;
  const syncLiveDefaultSelection = async () => {
    if (!syncDefaultModel || !defaultSelection?.provider || !defaultSelection?.model) return;
    const cleanSel = {
      provider: String(defaultSelection.provider),
      model: String(defaultSelection.model),
      ...(defaultSelection.reasoningEffort ? { reasoningEffort: String(defaultSelection.reasoningEffort) } : {}),
    };
    const admSvc = ctx?.get?.('agentDefaultModel') ?? ctx?.root?.get?.('agentDefaultModel') ?? null;
    if (admSvc && typeof admSvc.saveSelection === 'function') {
      try {
        await admSvc.saveSelection(cleanSel);
        defaultModelSynced = true;
        return;
      } catch {}
    }
    const defNs = nsList.find(n => (n?.ns ?? n?.namespace) === 'agent-default-model');
    if (defNs) {
      try {
        await settings.update(defNs.ns ?? defNs.namespace, cleanSel);
        defaultModelSynced = true;
      } catch {}
    }
  };

  if (updatedProviders.length === 0) {
    await syncLiveDefaultSelection();
    return { synced: true, changed: defaultModelSynced, defaultModelSynced, updatedProviders: [] };
  }
  try {
    await settings.update(targetNs, nextData);
    await syncLiveDefaultSelection();
    return { synced: true, changed: true, defaultModelSynced, updatedProviders };
  } catch (e) {
    return { synced: false, reason: e instanceof Error ? e.message : String(e), updatedProviders: [] };
  }
}

function writeAtomicWithFs(filePath, content, fsImpl = fs, mode = null) {
  if (fsImpl === fs) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(filePath, content);
    if (mode !== null && process.platform !== 'win32') {
      try { fs.chmodSync(filePath, mode); } catch {}
    }
    return;
  }
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fsImpl.writeFileSync(tmp, content, 'utf8');
  if (mode !== null && process.platform !== 'win32' && typeof fsImpl.chmodSync === 'function') {
    try { fsImpl.chmodSync(tmp, mode); } catch {}
  }
  fsImpl.renameSync(tmp, filePath);
}

/**
 * Write or update an API key inside `$DSH_HOME/.credentials.yaml` (`version: 1`, `refs:`)
 * matching `@deepseek-ai/dsh-credentials-local`'s exact live-watched schema while preserving
 * existing `refs` and `records`.
 */
export function writeDshCredentialsYamlEntry({
  dshHome,
  envVarName,
  apiKey,
  onlyIfMissing = false,
  fsImpl = fs,
} = {}) {
  const cleanVar = String(envVarName ?? '').trim();
  const cleanKey = String(apiKey ?? '').trim();
  if (!dshHome || !/^[A-Z_][A-Z0-9_]*$/.test(cleanVar) || !cleanKey || /[\r\n\0]/.test(cleanKey)) {
    return { updated: false, credFile: dshHome ? path.join(dshHome, '.credentials.yaml') : null };
  }
  const credFile = path.join(dshHome, '.credentials.yaml');
  const serializedValue = JSON.stringify(cleanKey);
  const existed = fsImpl.existsSync(credFile);
  const rawPrev = existed ? String(fsImpl.readFileSync(credFile, 'utf8') ?? '').replace(/\r\n/g, '\n') : '';

  if (!rawPrev.trim()) {
    const fresh = `version: 1\nrefs:\n  ${cleanVar}: ${serializedValue}\n`;
    writeAtomicWithFs(credFile, fresh, fsImpl, 0o600);
    return { updated: true, credFile };
  }

  const lines = rawPrev.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const hasVersion = lines.some(l => /^version\s*:\s*\d+/.test(l.trim()));
  if (!hasVersion) {
    lines.unshift('version: 1');
  }

  let refsIdx = lines.findIndex(l => /^refs\s*:(?:\s*\{\s*\})?\s*(?:#.*)?$/.test(l));
  if (refsIdx < 0) {
    const verIdx = lines.findIndex(l => /^version\s*:/.test(l));
    const insertAt = verIdx >= 0 ? verIdx + 1 : lines.length;
    lines.splice(insertAt, 0, 'refs:', `  ${cleanVar}: ${serializedValue}`);
    writeAtomicWithFs(credFile, `${lines.join('\n')}\n`, fsImpl, 0o600);
    return { updated: true, credFile };
  }

  // Normalize `refs: {}` into block `refs:`
  lines[refsIdx] = 'refs:';
  let blockEnd = refsIdx + 1;
  while (blockEnd < lines.length) {
    const l = lines[blockEnd];
    if (l.trim() === '' || /^\s+#/.test(l) || /^[ \t]+/.test(l)) {
      blockEnd++;
    } else {
      break;
    }
  }

  const keyLineRe = new RegExp(`^[ \\t]+${cleanVar}\\s*:\\s*(.*)$`);
  let matchedIdx = -1;
  for (let i = refsIdx + 1; i < blockEnd; i++) {
    const m = keyLineRe.exec(lines[i]);
    if (m) {
      matchedIdx = i;
      const existingVal = m[1].trim();
      if (onlyIfMissing && existingVal && existingVal !== '""' && existingVal !== "''" && existingVal !== 'null') {
        return { updated: false, credFile };
      }
      break;
    }
  }

  if (matchedIdx >= 0) {
    const nextLine = `  ${cleanVar}: ${serializedValue}`;
    if (lines[matchedIdx] === nextLine) {
      return { updated: false, credFile };
    }
    lines[matchedIdx] = nextLine;
  } else {
    let insertPos = blockEnd;
    while (insertPos > refsIdx + 1 && lines[insertPos - 1].trim() === '') {
      insertPos--;
    }
    lines.splice(insertPos, 0, `  ${cleanVar}: ${serializedValue}`);
  }

  const nextContent = `${lines.join('\n')}\n`;
  writeAtomicWithFs(credFile, nextContent, fsImpl, 0o600);
  return { updated: true, credFile };
}

/**
 * Read ambient provider credentials from `$DSH_HOME/.env` + `env` so standalone/panel saves can
 * mirror active `apiKeyEnv` secrets into `$DSH_HOME/.credentials.yaml` (`dsh-credentials-local` live store).
 */
export function readDshEnvCredentialsMap({ dshHome = null, env = process.env, fsImpl = fs } = {}) {
  const out = {};
  if (dshHome) {
    const envFile = path.join(dshHome, '.env');
    if (fsImpl.existsSync(envFile)) {
      try {
        const txt = fsImpl.readFileSync(envFile, 'utf8');
        for (const rawLine of txt.split(/\r?\n/)) {
          const trimmed = rawLine.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
          if (!m) continue;
          const k = m[1];
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            if (v.startsWith('"')) {
              try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
            } else {
              v = v.slice(1, -1);
            }
          }
          if (typeof v === 'string' && v.trim()) out[k] = v.trim();
        }
      } catch {}
    }
  }
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === 'string' && v.trim() && !/[\r\n\0]/.test(v)) {
        out[k] = v.trim();
      }
    }
  }
  return out;
}

function parseYamlScalarValue(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(part => parseYamlScalarValue(part));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    try { return JSON.parse(s); } catch {}
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    const obj = {};
    for (const pair of inner.split(',')) {
      const idx = pair.indexOf(':');
      if (idx > 0) {
        const k = parseYamlScalarValue(pair.slice(0, idx));
        obj[String(k)] = parseYamlScalarValue(pair.slice(idx + 1));
      }
    }
    return obj;
  }
  return s;
}

function parseSimpleIndentedYaml(lines, startIdx = 0, minIndent = 0) {
  let idx = startIdx;
  const skipIgnorable = () => {
    while (idx < lines.length && (lines[idx].trim() === '' || /^\s*#/.test(lines[idx]))) idx++;
  };
  skipIgnorable();
  if (idx >= lines.length) return { value: undefined, nextIdx: idx };
  const firstIndent = /^([ \t]*)/.exec(lines[idx])[1].length;
  if (firstIndent < minIndent) return { value: undefined, nextIdx: idx };

  const trimmedFirst = lines[idx].trim();
  if (trimmedFirst.startsWith('- ') || trimmedFirst === '-') {
    const arr = [];
    while (idx < lines.length) {
      skipIgnorable();
      if (idx >= lines.length) break;
      const ind = /^([ \t]*)/.exec(lines[idx])[1].length;
      if (ind < firstIndent) break;
      const t = lines[idx].trim();
      if (!(t.startsWith('- ') || t === '-')) break;
      const rest = t === '-' ? '' : t.slice(2).trim();
      idx++;
      if (!rest) {
        const sub = parseSimpleIndentedYaml(lines, idx, ind + 1);
        arr.push(sub.value);
        idx = sub.nextIdx;
      } else if (/^[^'"[{][^:]*:(?:\s+.*)?$/.test(rest) || /^['"][^'"]+['"]\s*:(?:\s+.*)?$/.test(rest)) {
        const virtualLines = [`${' '.repeat(ind + 2)}${rest}`];
        while (idx < lines.length) {
          const l = lines[idx];
          if (l.trim() === '' || /^\s*#/.test(l)) { idx++; continue; }
          const subInd = /^([ \t]*)/.exec(l)[1].length;
          if (subInd <= ind) break;
          virtualLines.push(l);
          idx++;
        }
        const sub = parseSimpleIndentedYaml(virtualLines, 0, ind + 2);
        arr.push(sub.value);
      } else {
        arr.push(parseYamlScalarValue(rest));
      }
    }
    return { value: arr, nextIdx: idx };
  }

  const obj = {};
  while (idx < lines.length) {
    skipIgnorable();
    if (idx >= lines.length) break;
    const ind = /^([ \t]*)/.exec(lines[idx])[1].length;
    if (ind < firstIndent) break;
    const t = lines[idx].trim();
    if (t.startsWith('- ') || t === '-') break;
    const kvMatch = /^(?:"([^"]+)"|'([^']+)'|([^:#]+?))\s*:\s*(.*?)(?:\s+#.*)?$/.exec(t);
    if (!kvMatch) { idx++; continue; }
    const key = (kvMatch[1] ?? kvMatch[2] ?? kvMatch[3]).trim();
    const valRest = kvMatch[4].trim();
    idx++;
    if (valRest === '') {
      const sub = parseSimpleIndentedYaml(lines, idx, ind + 1);
      obj[key] = sub.value ?? {};
      idx = sub.nextIdx;
    } else {
      obj[key] = parseYamlScalarValue(valRest);
    }
  }
  return { value: obj, nextIdx: idx };
}

function formatYamlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(String(key));
}

function formatYamlScalar(val) {
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  if (val === null) return 'null';
  return JSON.stringify(String(val));
}

function serializeYamlValueLines(val, indent = 2) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(val)) {
    if (val.length === 0) return [`${pad}[]`];
    if (val.every(x => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
      return [`${pad}[${val.map(formatYamlScalar).join(', ')}]`];
    }
    const out = [];
    for (const item of val) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          out.push(`${pad}- {}`);
          continue;
        }
        const [firstK, firstV] = entries[0];
        if (firstV !== null && typeof firstV === 'object') {
          out.push(`${pad}- ${formatYamlKey(firstK)}:`);
          out.push(...serializeYamlValueLines(firstV, indent + 4));
        } else {
          out.push(`${pad}- ${formatYamlKey(firstK)}: ${formatYamlScalar(firstV)}`);
        }
        for (let i = 1; i < entries.length; i++) {
          const [k, v] = entries[i];
          if (v !== null && typeof v === 'object') {
            if (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
              out.push(`${' '.repeat(indent + 2)}${formatYamlKey(k)}: [${v.map(formatYamlScalar).join(', ')}]`);
            } else if (!Array.isArray(v) && Object.keys(v).length === 0) {
              out.push(`${' '.repeat(indent + 2)}${formatYamlKey(k)}: {}`);
            } else {
              out.push(`${' '.repeat(indent + 2)}${formatYamlKey(k)}:`);
              out.push(...serializeYamlValueLines(v, indent + 4));
            }
          } else {
            out.push(`${' '.repeat(indent + 2)}${formatYamlKey(k)}: ${formatYamlScalar(v)}`);
          }
        }
      } else {
        out.push(`${pad}- ${formatYamlScalar(item)}`);
      }
    }
    return out;
  }
  if (val && typeof val === 'object') {
    const entries = Object.entries(val).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return [`${pad}{}`];
    const out = [];
    for (const [k, v] of entries) {
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
          out.push(`${pad}${formatYamlKey(k)}: [${v.map(formatYamlScalar).join(', ')}]`);
        } else if (Array.isArray(v) && v.length === 0) {
          out.push(`${pad}${formatYamlKey(k)}: []`);
        } else if (!Array.isArray(v) && Object.keys(v).length === 0) {
          out.push(`${pad}${formatYamlKey(k)}: {}`);
        } else {
          out.push(`${pad}${formatYamlKey(k)}:`);
          out.push(...serializeYamlValueLines(v, indent + 2));
        }
      } else {
        out.push(`${pad}${formatYamlKey(k)}: ${formatYamlScalar(v)}`);
      }
    }
    return out;
  }
  return [`${pad}${formatYamlScalar(val)}`];
}

function partitionCordisPatchBlocks(rawText) {
  const normalized = String(rawText ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headerLines = [];
  const blocks = [];
  let pendingComments = [];
  let curLines = null;
  let seenFirst = false;

  const flush = () => {
    if (curLines) {
      while (curLines.length > 1 && curLines[curLines.length - 1].trim() === '') curLines.pop();
      blocks.push({ comments: pendingComments, lines: curLines });
      pendingComments = [];
      curLines = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[\]\s*(?:#.*)?$/.test(trimmed) && !line.startsWith(' ')) continue;
    if (/^-\s/.test(line)) {
      flush();
      seenFirst = true;
      curLines = [line];
    } else if (!seenFirst) {
      headerLines.push(line);
    } else if (/^#/.test(line)) {
      flush();
      pendingComments.push(line);
    } else if (curLines) {
      curLines.push(line);
    } else if (trimmed !== '') {
      pendingComments.push(line);
    }
  }
  flush();
  return { headerLines, blocks };
}

function extractBlockIdAndName(lines) {
  let id = null;
  let name = null;
  if (!Array.isArray(lines) || lines.length === 0) return { id, name };
  const m0 = /^\s*-\s*id\s*:\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/.exec(lines[0]);
  if (m0) id = m0[1].trim();
  for (let i = 1; i < lines.length; i++) {
    if (!id) {
      const mi = /^  id\s*:\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/.exec(lines[i]);
      if (mi) id = mi[1].trim();
    }
    if (!name) {
      const mn = /^  name\s*:\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/.exec(lines[i]);
      if (mn) name = mn[1].trim();
    }
  }
  return { id, name };
}

/**
 * Directly synchronize provider & model definitions (and optional `agent-default-model`) into
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml` on disk so standalone `lt-ui` / `lt-installer`
 * (`ctx === null`) and DSH Desktop / `dsh web` stay 100% in sync without wiping other profile patches.
 */
export function syncModelsToDshDiskProfiles({
  dshHome,
  modelsToEnsure = [],
  defaultProvider = 'magpie',
  providerTemplates = null,
  defaultSelection = null,
  syncDefaultModel = false,
  targetProfiles = null,
  createDefaultProfilesIfNone = false,
  fsImpl = fs,
} = {}) {
  if (!dshHome) {
    return { synced: false, changed: false, reason: 'no-dsh-home', updatedProviders: [], updatedProfiles: [] };
  }
  const profilesRoot = path.join(dshHome, 'profiles');
  let profileNames = [];
  if (Array.isArray(targetProfiles) && targetProfiles.length > 0) {
    profileNames = [...new Set(targetProfiles.map(String).filter(Boolean))];
  } else if (fsImpl.existsSync(profilesRoot)) {
    try {
      profileNames = fsImpl
        .readdirSync(profilesRoot, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {}
  }
  if (profileNames.length === 0 && createDefaultProfilesIfNone) {
    profileNames = ['desktop', 'web'];
  }
  if (profileNames.length === 0) {
    return { synced: false, changed: false, reason: 'no-initialized-profiles', updatedProviders: [], updatedProfiles: [] };
  }

  const allUpdatedProviders = new Set();
  const updatedProfiles = [];
  let anyChanged = false;

  for (const profName of profileNames) {
    const profDir = path.join(profilesRoot, profName);
    const patchFile = path.join(profDir, 'cordis.patch.yml');
    const existed = fsImpl.existsSync(patchFile);
    const prevRaw = existed ? String(fsImpl.readFileSync(patchFile, 'utf8') ?? '') : '';
    const { headerLines, blocks } = partitionCordisPatchBlocks(prevRaw);

    let existingProviders = {};
    let llmBlockIdx = -1;
    let llmPluginName = null;
    let defaultModelIdx = -1;
    let defaultModelPluginName = null;
    let existingDefaultModelCfg = null;

    for (let i = 0; i < blocks.length; i++) {
      const { id, name } = extractBlockIdAndName(blocks[i].lines);
      if (id === 'llm-pi-ai') {
        llmBlockIdx = i;
        llmPluginName = name;
        const parsedItem = parseSimpleIndentedYaml(blocks[i].lines, 0, 0).value;
        const itemObj = Array.isArray(parsedItem) ? parsedItem[0] : parsedItem;
        if (itemObj?.config?.providers && typeof itemObj.config.providers === 'object') {
          existingProviders = itemObj.config.providers;
        }
      } else if (id === 'agent-default-model') {
        defaultModelIdx = i;
        defaultModelPluginName = name;
        const parsedItem = parseSimpleIndentedYaml(blocks[i].lines, 0, 0).value;
        const itemObj = Array.isArray(parsedItem) ? parsedItem[0] : parsedItem;
        if (itemObj?.config && typeof itemObj.config === 'object') {
          existingDefaultModelCfg = itemObj.config;
        }
      }
    }

    const { providers: mergedProviders, updatedProviders } = applyModelsToProvidersMap(
      existingProviders,
      modelsToEnsure,
      defaultProvider,
      providerTemplates,
    );
    for (const p of updatedProviders) allUpdatedProviders.add(p);

    const hasProvidersToWrite = Object.keys(mergedProviders).length > 0;
    if (hasProvidersToWrite && (updatedProviders.length > 0 || llmBlockIdx < 0)) {
      const llmLines = ['- id: llm-pi-ai'];
      if (llmPluginName) llmLines.push(`  name: ${JSON.stringify(llmPluginName)}`);
      llmLines.push('  config:');
      llmLines.push('    providers:');
      llmLines.push(...serializeYamlValueLines(mergedProviders, 6));
      if (llmBlockIdx >= 0) {
        blocks[llmBlockIdx] = { comments: blocks[llmBlockIdx].comments, lines: llmLines };
      } else {
        blocks.push({ comments: [], lines: llmLines });
      }
    }

    const shouldWriteDefaultModel =
      Boolean(defaultSelection?.provider && defaultSelection?.model) &&
      (syncDefaultModel || defaultModelIdx < 0 || !existingDefaultModelCfg?.provider || !existingDefaultModelCfg?.model);

    if (shouldWriteDefaultModel) {
      const cleanSel = {
        provider: String(defaultSelection.provider),
        model: String(defaultSelection.model),
        ...(defaultSelection.reasoningEffort ? { reasoningEffort: String(defaultSelection.reasoningEffort) } : {}),
      };
      const dmLines = ['- id: agent-default-model'];
      if (defaultModelPluginName) dmLines.push(`  name: ${JSON.stringify(defaultModelPluginName)}`);
      dmLines.push('  config:');
      dmLines.push(...serializeYamlValueLines(cleanSel, 4));
      if (defaultModelIdx >= 0) {
        blocks[defaultModelIdx] = { comments: blocks[defaultModelIdx].comments, lines: dmLines };
      } else {
        blocks.push({ comments: [], lines: dmLines });
      }
    }

    const cleanHeader = [...headerLines];
    while (cleanHeader.length > 0 && cleanHeader[cleanHeader.length - 1].trim() === '') cleanHeader.pop();
    const outLines = [];
    if (cleanHeader.length > 0) {
      outLines.push(...cleanHeader);
    } else if (!existed) {
      outLines.push('# Your patch layer for this dsh profile, applied after every bundle layer:');
    }
    for (const b of blocks) {
      if (b.comments.length > 0) outLines.push(...b.comments);
      outLines.push(...b.lines);
    }
    const nextText = blocks.length > 0 ? `${outLines.join('\n').trimEnd()}\n` : `${outLines.join('\n').trimEnd()}\n[]\n`;
    const normPrev = `${prevRaw.replace(/\r\n/g, '\n').trimEnd()}\n`;
    if (!existed || nextText !== normPrev) {
      writeAtomicWithFs(patchFile, nextText, fsImpl);
      anyChanged = true;
      updatedProfiles.push(profName);
    }
  }

  return {
    synced: true,
    changed: anyChanged,
    updatedProviders: [...allUpdatedProviders],
    updatedProfiles,
  };
}
