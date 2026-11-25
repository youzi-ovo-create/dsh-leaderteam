/**
 * Anti-Corruption Adapter between Magpie / Direct Solo-Key / External Gateways
 * and Leader Team's Public `lt.public.v1` Contract + LT V2.2 Model Config Writer.
 *
 * Enforces:
 * - Strict separation of `providerId`, `credentialRef`, `sourceKind`, and `entryId`
 *   (same-named models across providers or sources NEVER auto-merge).
 * - Zero raw API key or webKey exposure (`maskedPreview` only).
 * - Canonical DSH/LT reasoning effort mapping (`off` <-> wire `"none"`).
 * - Honest usage record normalization (`unknown != 0`, logical request vs physical `tries`).
 */

import { inferModelFamily, canonicalRouteFor } from '../core/upstream-models.mjs';
import { SOLO_PROVIDER_PRESETS } from '../core/solo-key.mjs';
import { DSH_EFFORTS } from '../core/constants.mjs';

const CANONICAL_DSH_THINKING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function sanitizeMaskedPreview(rawMasked, fallbackKind = 'api_key') {
  const s = typeof rawMasked === 'string' ? rawMasked.trim() : '';
  if (!s) return fallbackKind === 'oauth' ? 'oauth:connected' : 'configured';
  // Guard against any accidental unmasked secret (>16 chars without ellipsis or asterisks)
  if (s.length >= 16 && !s.includes('...') && !s.includes('*')) {
    return `${s.slice(0, 3)}****${s.slice(-4)}`;
  }
  return s;
}

/**
 * Map Magpie's `reasoning_levels` / `supported_reasoning_levels` into LT's canonical efforts
 * and DSH's `reasoningEfforts` wire map (preserving `off -> "none"`).
 */
export function mapGatewayReasoningLevels(rawLevels) {
  const wireMap = {};
  if (Array.isArray(rawLevels)) {
    for (const item of rawLevels) {
      const wire = typeof item === 'string'
        ? item.trim()
        : (typeof item?.effort === 'string' ? item.effort.trim() : '');
      if (!wire) continue;
      if (wire === 'none') {
        wireMap.off = 'none';
      } else if (CANONICAL_DSH_THINKING_ORDER.includes(wire)) {
        if (wire === 'off' && wireMap.off !== undefined) continue;
        wireMap[wire] = wire;
      }
    }
  }
  const orderedKeys = CANONICAL_DSH_THINKING_ORDER.filter(k => Object.hasOwn(wireMap, k));
  // Purely reasonless model (`['none']` only -> `orderedKeys === ['off']` with no thinking tier): treat as chat-only `['none']`
  const hasRealThinking = orderedKeys.some(k => k !== 'off');
  if (!hasRealThinking) {
    return {
      reasoning: false,
      supported: ['none'],
      defaultEffort: 'none',
      wireEffortMap: undefined,
    };
  }
  const defaultEffort = orderedKeys.includes('high')
    ? 'high'
    : (orderedKeys.includes('medium') ? 'medium' : orderedKeys[orderedKeys.length - 1]);
  const orderedWireMap = {};
  for (const k of orderedKeys) orderedWireMap[k] = wireMap[k];
  return {
    reasoning: true,
    supported: orderedKeys,
    defaultEffort,
    wireEffortMap: orderedWireMap,
  };
}

export function inferModelTier({ family, modelId, reasoning }) {
  const s = `${family}/${String(modelId || '')}`.toLowerCase();
  if (/(?:flash|mini|air|haiku|nano|lite|fast)/.test(s)) return 'fast';
  if (/(?:pro|max|opus|gpt-5|gpt-6|sol|carbon|argon)/.test(s)) return 'flagship';
  if (reasoning || /(?:reasoner|o1|o3|o4|qwq|thinking)/.test(s)) return 'reasoning';
  return 'balanced';
}

function mapMagpieProtocol(baseApi, p = {}) {
  const b = String(baseApi || '').toLowerCase();
  if (b === 'responses') return 'openai-responses';
  if (b === 'anthropic') return 'anthropic-messages';
  if (b === 'gemini') return 'google-gemini';
  const count = [p.chat, p.responses, p.anthropic, p.gemini].filter(Boolean).length;
  if (count > 1) return 'multi';
  return 'openai-chat';
}

function sanitizeEndpointUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const u = new URL(rawUrl.trim());
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return rawUrl.trim().split('?')[0];
  }
}

/**
 * Normalize Magpie `/api/providers` (or fallback `/v1/magpie/accounts`) + Direct Solo-Key + External Gateways
 * into `lt.public.v1` `ProviderDescriptor[]` & `ProviderPresetDescriptor[]`.
 */
export function buildPublicProviders({
  magpieProvidersPayload = null,
  magpieAccounts = [],
  magpieGatewayUrl = null,
  env = process.env,
  effectiveConfig = null,
  externalGateways = [],
} = {}) {
  const providers = [];
  const seenProviderIds = new Set();

  // 1. Magpie Providers (rich Web Admin payload when authenticated)
  if (Array.isArray(magpieProvidersPayload?.providers)) {
    for (const p of magpieProvidersPayload.providers) {
      const rawId = String(p?.id || '').trim();
      if (!rawId) continue;
      const providerId = `magpie:${rawId}`;
      seenProviderIds.add(providerId);

      const credentials = [];
      if (p.kind === 'login') {
        const accounts = Array.isArray(p.accounts) ? p.accounts : [];
        if (accounts.length > 0) {
          for (const acc of accounts) {
            const uid = String(acc.user || acc.email || 'account');
            credentials.push({
              credentialId: `oauth:${rawId}:${uid}`,
              kind: 'oauth',
              label: acc.email || uid,
              maskedPreview: `oauth:${acc.plan || 'account'}`,
              enabled: !acc.disabled && !acc.expired,
              primary: Boolean(acc.active),
              weight: 1,
              accountPlan: acc.plan || null,
            });
          }
        } else if (p.loggedIn) {
          credentials.push({
            credentialId: `oauth:${rawId}:default`,
            kind: 'oauth',
            label: p.user || p.name || rawId,
            maskedPreview: `oauth:${p.plan || 'active'}`,
            enabled: true,
            primary: true,
            weight: 1,
            accountPlan: p.plan || null,
          });
        }
      } else if (Array.isArray(p.keys) && p.keys.length > 0) {
        for (const k of p.keys) {
          credentials.push({
            credentialId: `key:${k.id}`,
            kind: 'api_key',
            label: k.name || 'API Key',
            maskedPreview: sanitizeMaskedPreview(k.masked, 'api_key'),
            enabled: !k.disabled,
            primary: Boolean(k.primary),
            weight: Number.isFinite(k.weight) && k.weight > 0 ? k.weight : 1,
            accountPlan: k.plan || null,
          });
        }
      } else if (p.hasKey) {
        credentials.push({
          credentialId: `key:${p.keyId || 'primary'}`,
          kind: 'api_key',
          label: p.keyName || 'Primary',
          maskedPreview: sanitizeMaskedPreview(p.maskedKey, 'api_key'),
          enabled: !p.keyDisabled,
          primary: true,
          weight: Number.isFinite(p.keyWeight) && p.keyWeight > 0 ? p.keyWeight : 1,
        });
      }

      const usableCreds = credentials.filter(c => c.enabled).length;
      const status = p.disabled
        ? 'disabled'
        : (usableCreds > 0 ? 'ready' : (p.kind === 'login' ? 'auth_required' : 'unconfigured'));

      const endpoint = sanitizeEndpointUrl(p.chat || p.responses || p.anthropic || p.gemini || magpieGatewayUrl || '');
      const discoveredCount = Array.isArray(p.listed) ? p.listed.length : 0;
      const enabledCount = Array.isArray(p.models) && p.models.length > 0 ? p.models.length : discoveredCount;

      providers.push({
        providerId,
        sourceKind: 'magpie',
        vendorId: p.preset || p.loginAgent || rawId,
        displayName: `${p.name || rawId} (Magpie)`,
        protocol: mapMagpieProtocol(p.baseAPI, p),
        endpointUrl: endpoint,
        status,
        keyRotation: p.route === 'round-robin' || p.route === 'least-used' || p.route === 'fill-first'
          ? p.route
          : (credentials.length > 1 ? 'fill-first' : 'single'),
        sessionAffinity: p.sessionAffinity !== false,
        credentials,
        discoveredModelCount: discoveredCount,
        enabledModelCount: p.disabled ? 0 : enabledCount,
      });
    }
  } else if (Array.isArray(magpieAccounts) && magpieAccounts.length > 0) {
    // Read-only fallback from loopback `/v1/magpie/accounts?models=1` when Web Admin key is not supplied
    const grouped = new Map();
    for (const acc of magpieAccounts) {
      const rawId = String(acc?.provider || '').trim();
      if (!rawId) continue;
      if (!grouped.has(rawId)) {
        grouped.set(rawId, {
          rawId,
          name: acc.providerName || rawId,
          creds: [],
          models: new Set(),
        });
      }
      const g = grouped.get(rawId);
      g.creds.push({
        credentialId: `${acc.kind === 'login' ? 'oauth' : 'key'}:${acc.id || g.creds.length + 1}`,
        kind: acc.kind === 'login' ? 'oauth' : 'api_key',
        label: acc.label || rawId,
        maskedPreview: acc.kind === 'login' ? 'oauth:active' : `pin:${acc.id || 'key'}`,
        enabled: Boolean(acc.on),
        primary: g.creds.length === 0,
        weight: 1,
      });
      for (const m of acc.models || []) g.models.add(m);
    }
    for (const g of grouped.values()) {
      const providerId = `magpie:${g.rawId}`;
      seenProviderIds.add(providerId);
      providers.push({
        providerId,
        sourceKind: 'magpie',
        vendorId: g.rawId,
        displayName: `${g.name} (Magpie)`,
        protocol: 'multi',
        endpointUrl: sanitizeEndpointUrl(magpieGatewayUrl || ''),
        status: g.creds.some(c => c.enabled) ? 'ready' : 'disabled',
        keyRotation: g.creds.length > 1 ? 'fill-first' : 'single',
        sessionAffinity: true,
        credentials: g.creds,
        discoveredModelCount: g.models.size,
        enabledModelCount: g.models.size,
      });
    }
  }

  // 2. Direct Solo-Key Providers (configured via env or LT models with explicit provider)
  const configuredDirectProviders = new Set();
  const defaultMagpieProv = effectiveConfig?.magpie?.provider ?? 'magpie';
  for (const spec of Object.values(effectiveConfig?.models ?? {})) {
    if (spec?.provider && spec.provider !== defaultMagpieProv) {
      configuredDirectProviders.add(spec.provider);
    }
  }
  for (const preset of SOLO_PROVIDER_PRESETS) {
    const activeEnv = preset.envVars.find(v => typeof env?.[v] === 'string' && env[v].trim().length > 0);
    if (!activeEnv && !configuredDirectProviders.has(preset.provider)) continue;
    const providerId = `direct:${preset.provider}`;
    if (seenProviderIds.has(providerId)) continue;
    seenProviderIds.add(providerId);
    const credVar = activeEnv || preset.envVars[0];
    providers.push({
      providerId,
      sourceKind: 'direct',
      vendorId: preset.id,
      displayName: `${preset.displayName} (直连 API)`,
      protocol: 'openai-chat',
      endpointUrl: sanitizeEndpointUrl(preset.defaultBaseURL),
      status: activeEnv ? 'ready' : 'unconfigured',
      keyRotation: 'single',
      sessionAffinity: false,
      credentials: [
        {
          credentialId: `env:${credVar}`,
          kind: 'env_ref',
          label: credVar,
          maskedPreview: activeEnv ? `env:${credVar} (已设置)` : `env:${credVar} (未设置)`,
          enabled: Boolean(activeEnv),
          primary: true,
          weight: 1,
        },
      ],
      discoveredModelCount: 2,
      enabledModelCount: activeEnv ? 2 : 0,
    });
  }

  // 3. Registered External OpenAI-Compatible Gateways
  for (const ext of externalGateways) {
    if (!ext?.id) continue;
    const providerId = `ext:${ext.id}`;
    if (seenProviderIds.has(providerId)) continue;
    seenProviderIds.add(providerId);
    providers.push({
      providerId,
      sourceKind: 'external-gateway',
      vendorId: 'custom',
      displayName: ext.displayName || `${ext.id} (外部网关)`,
      protocol: ext.protocol || 'openai-chat',
      endpointUrl: sanitizeEndpointUrl(ext.endpointUrl || ''),
      status: ext.disabled ? 'disabled' : (ext.hasKey || ext.keyOptional ? 'ready' : 'unconfigured'),
      keyRotation: 'single',
      sessionAffinity: false,
      credentials: ext.hasKey
        ? [{
          credentialId: `key:${ext.keyId || 'ext'}`,
          kind: 'api_key',
          label: 'Gateway Key',
          maskedPreview: sanitizeMaskedPreview(ext.maskedPreview, 'api_key'),
          enabled: true,
          primary: true,
          weight: 1,
        }]
        : [],
      discoveredModelCount: ext.modelCount ?? 0,
      enabledModelCount: ext.disabled ? 0 : (ext.modelCount ?? 0),
    });
  }

  // Presets catalog merging Magpie presets + Solo-Key presets
  const presetMap = new Map();
  for (const p of SOLO_PROVIDER_PRESETS) {
    presetMap.set(p.id, {
      vendorId: p.id,
      displayName: p.displayName,
      protocol: 'openai-chat',
      defaultEndpointUrl: p.defaultBaseURL,
      keyHint: 'sk-...',
      supportsDirectSoloKey: true,
      supportsMagpie: true,
    });
  }
  for (const mp of magpieProvidersPayload?.presets ?? []) {
    if (!mp?.id) continue;
    const prev = presetMap.get(mp.id);
    presetMap.set(mp.id, {
      vendorId: mp.id,
      displayName: mp.name || prev?.displayName || mp.id,
      protocol: mapMagpieProtocol(mp.responses ? 'responses' : 'chat', mp),
      defaultEndpointUrl: sanitizeEndpointUrl(mp.chat || mp.responses || prev?.defaultEndpointUrl || ''),
      keyHint: mp.keyHint || 'sk-...',
      ...(mp.keyUrl ? { keyUrl: mp.keyUrl } : {}),
      supportsDirectSoloKey: Boolean(prev?.supportsDirectSoloKey),
      supportsMagpie: true,
    });
  }

  return {
    providers,
    presets: [...presetMap.values()],
  };
}

/**
 * Build unified `ModelCatalogEntry[]` across Magpie `/v1/models`, LT configured models, and DSH discovered models.
 * Strictly preserves separate `entryId` and `routeId` for same-named models from different providers/sources!
 */
export function buildPublicModelCatalog({
  magpieGatewayModels = [],
  effectiveConfig = null,
  dshDiscoveredModels = [],
} = {}) {
  const entries = [];
  const seenEntries = new Set();
  const workingRoutes = { ...(effectiveConfig?.models ?? {}) };
  const defaultMagpieHostProv = effectiveConfig?.magpie?.provider ?? 'magpie';
  const executionPoolSet = new Set(effectiveConfig?.team?.executionPool ?? []);
  const disabledSet = new Set(effectiveConfig?.team?.disabledModels ?? []);

  // 1. Live Magpie `/v1/models` items
  for (const raw of magpieGatewayModels) {
    const fullId = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!fullId) continue;
    const slashIdx = fullId.indexOf('/');
    const vendorPart = slashIdx > 0 ? fullId.slice(0, slashIdx) : (raw.owned_by || 'magpie');
    const upstreamModelId = slashIdx > 0 ? fullId.slice(slashIdx + 1) : fullId;
    const providerId = `magpie:${vendorPart}`;
    const entryId = `magpie:${providerId}:${upstreamModelId}`;
    if (seenEntries.has(entryId)) continue;
    seenEntries.add(entryId);

    // Compute collision-safe LT routeId (never overwriting a direct route with the same bare name)
    const routeId = canonicalRouteFor(defaultMagpieHostProv, fullId, {
      defaultProvider: defaultMagpieHostProv,
      existingModels: workingRoutes,
    }) || fullId;

    const existingSpec = effectiveConfig?.models?.[routeId] ?? null;
    const mappedEff = mapGatewayReasoningLevels(raw.reasoning_levels ?? raw.supported_reasoning_levels);
    const supportedEfforts = mappedEff.reasoning
      ? mappedEff.supported
      : (Array.isArray(existingSpec?.efforts) && existingSpec.efforts.length > 0 ? [...existingSpec.efforts] : ['none']);
    const defaultEffort = (existingSpec?.defaultEffort && supportedEfforts.includes(existingSpec.defaultEffort))
      ? existingSpec.defaultEffort
      : mappedEff.defaultEffort;

    const family = existingSpec?.family || inferModelFamily(fullId, vendorPart);
    const inputMods = Array.isArray(raw?.modalities?.input) ? raw.modalities.input : [];
    const vision = inputMods.length > 0 ? inputMods.includes('image') : Boolean(existingSpec?.vision);
    const pdf = inputMods.includes('pdf');
    const contextWindow = Number.isInteger(raw.context_window) && raw.context_window > 0
      ? raw.context_window
      : (existingSpec?.contextWindow ?? null);
    const maxOutputTokens = Number.isInteger(raw.max_output_tokens) && raw.max_output_tokens > 0
      ? raw.max_output_tokens
      : (existingSpec?.maxTokens ?? null);

    workingRoutes[routeId] ??= {
      provider: defaultMagpieHostProv,
      upstreamModel: fullId,
    };

    entries.push({
      entryId,
      routeId,
      upstreamModelId,
      magpieModelId: fullId,
      providerId,
      providerDisplayName: `${vendorPart} (Magpie)`,
      credentialScope: 'provider-pool',
      sourceKind: 'magpie',
      displayName: existingSpec?.label || raw.display_name || fullId,
      family,
      capabilities: {
        vision,
        pdf,
        toolCall: raw.tool_call !== false,
        reasoning: mappedEff.reasoning || supportedEfforts.some(e => e !== 'none' && e !== 'off'),
      },
      efforts: {
        supported: supportedEfforts,
        defaultEffort,
        ...(mappedEff.wireEffortMap ? { wireEffortMap: mappedEff.wireEffortMap } : (existingSpec?.reasoningEfforts ? { wireEffortMap: { ...existingSpec.reasoningEfforts } } : {})),
      },
      limits: {
        contextWindow,
        maxOutputTokens,
      },
      tier: inferModelTier({ family, modelId: fullId, reasoning: mappedEff.reasoning }),
      inModelPool: Boolean(effectiveConfig?.models?.[routeId]),
      inExecutionPool: executionPoolSet.has(routeId),
      disabled: disabledSet.has(routeId),
    });
  }

  // 2. Configured LT models not already covered by live Magpie catalog (e.g., Direct Solo-Key or offline Magpie routes)
  for (const [routeId, spec] of Object.entries(effectiveConfig?.models ?? {})) {
    const hostProv = spec?.provider ?? defaultMagpieHostProv;
    const isMagpie = hostProv === defaultMagpieHostProv;
    const sourceKind = isMagpie ? 'magpie' : 'direct';
    const rawUpstream = spec?.upstreamModel ?? routeId;
    const slashIdx = rawUpstream.indexOf('/');
    const vendorPart = isMagpie
      ? (slashIdx > 0 ? rawUpstream.slice(0, slashIdx) : 'magpie')
      : hostProv;
    const upstreamModelId = isMagpie && slashIdx > 0 ? rawUpstream.slice(slashIdx + 1) : rawUpstream;
    const providerId = `${sourceKind}:${vendorPart}`;
    const entryId = `${sourceKind}:${providerId}:${upstreamModelId}`;
    if (seenEntries.has(entryId)) continue;
    seenEntries.add(entryId);

    const supported = Array.isArray(spec.efforts) && spec.efforts.length > 0 ? [...spec.efforts] : ['none'];
    const reasoning = supported.some(e => e !== 'none' && e !== 'off');
    entries.push({
      entryId,
      routeId,
      upstreamModelId,
      ...(isMagpie ? { magpieModelId: rawUpstream } : {}),
      providerId,
      providerDisplayName: isMagpie ? `${vendorPart} (Magpie)` : `${hostProv} (直连 API)`,
      credentialScope: isMagpie ? 'provider-pool' : `env:${hostProv.toUpperCase()}_API_KEY`,
      sourceKind,
      displayName: spec.label || routeId,
      family: spec.family || inferModelFamily(routeId, hostProv),
      capabilities: {
        vision: Boolean(spec.vision),
        pdf: false,
        toolCall: true,
        reasoning,
      },
      efforts: {
        supported,
        defaultEffort: spec.defaultEffort || supported[0],
        ...(spec.reasoningEfforts ? { wireEffortMap: { ...spec.reasoningEfforts } } : {}),
      },
      limits: {
        contextWindow: spec.contextWindow ?? null,
        maxOutputTokens: spec.maxTokens ?? null,
      },
      tier: inferModelTier({ family: spec.family, modelId: routeId, reasoning }),
      inModelPool: true,
      inExecutionPool: executionPoolSet.has(routeId),
      disabled: disabledSet.has(routeId),
    });
  }

  // 3. Additional DSH runtime discovered models (never merging onto existing entryIds)
  for (const dm of dshDiscoveredModels) {
    if (!dm?.route || !dm?.provider) continue;
    const isMagpie = dm.provider === defaultMagpieHostProv;
    const rawUpstream = dm.upstreamModel || dm.route;
    const slashIdx = rawUpstream.indexOf('/');
    const vendorPart = isMagpie
      ? (slashIdx > 0 ? rawUpstream.slice(0, slashIdx) : 'magpie')
      : dm.provider;
    const upstreamModelId = isMagpie && slashIdx > 0 ? rawUpstream.slice(slashIdx + 1) : rawUpstream;
    const sourceKind = isMagpie ? 'magpie' : 'host-settings';
    const providerId = `${sourceKind === 'magpie' ? 'magpie' : 'direct'}:${vendorPart}`;
    const entryId = `${sourceKind}:${providerId}:${upstreamModelId}`;
    if (seenEntries.has(entryId)) continue;
    seenEntries.add(entryId);

    // Ensure routeId never collides with an existing catalog route
    let routeId = dm.route;
    if (entries.some(e => e.routeId === routeId)) {
      routeId = canonicalRouteFor(dm.provider, rawUpstream, {
        defaultProvider: defaultMagpieHostProv,
        existingModels: Object.fromEntries(entries.map(e => [e.routeId, { provider: e.sourceKind === 'magpie' ? defaultMagpieHostProv : dm.provider, upstreamModel: e.upstreamModelId }])),
      }) || `${dm.provider}@host/${upstreamModelId}`;
    }

    const supported = Array.isArray(dm.efforts) && dm.efforts.length > 0
      ? dm.efforts.filter(e => DSH_EFFORTS.includes(e))
      : ['none'];
    const reasoning = supported.some(e => e !== 'none' && e !== 'off');
    entries.push({
      entryId,
      routeId,
      upstreamModelId,
      providerId,
      providerDisplayName: `${dm.provider} (DSH Host)`,
      credentialScope: 'host-settings',
      sourceKind,
      displayName: dm.label || routeId,
      family: dm.family || inferModelFamily(routeId, dm.provider),
      capabilities: {
        vision: Boolean(dm.vision),
        pdf: false,
        toolCall: true,
        reasoning,
      },
      efforts: {
        supported: supported.length ? supported : ['none'],
        defaultEffort: dm.defaultEffort || supported[0] || 'none',
      },
      limits: {
        contextWindow: dm.contextWindow ?? null,
        maxOutputTokens: dm.maxTokens ?? dm.defaultMaxTokens ?? null,
      },
      tier: inferModelTier({ family: dm.family, modelId: routeId, reasoning }),
      inModelPool: Boolean(effectiveConfig?.models?.[routeId]),
      inExecutionPool: executionPoolSet.has(routeId),
      disabled: disabledSet.has(routeId),
    });
  }

  return entries;
}

/**
 * Convert selected `ModelCatalogEntry[]` into `applyModelConfigChanges` `upsertModels` payloads
 * so Magpie / Direct models enter LT's model catalog and `executionPool` cleanly with `off -> "none"` preserved.
 */
export function buildModelUpsertsFromCatalogEntries(entries, {
  defaultMagpieHostProvider = 'magpie',
  enableInExecutionPool = true,
} = {}) {
  return entries.map(entry => {
    const isMagpie = entry.sourceKind === 'magpie';
    const hostProvider = isMagpie
      ? defaultMagpieHostProvider
      : entry.providerId.replace(/^(?:direct|ext):/, '');
    const upstreamModel = isMagpie
      ? (entry.magpieModelId || `${entry.providerId.replace(/^magpie:/, '')}/${entry.upstreamModelId}`)
      : entry.upstreamModelId;
    return {
      route: entry.routeId,
      provider: hostProvider,
      upstreamModel,
      family: entry.family,
      label: entry.displayName,
      efforts: [...entry.efforts.supported],
      defaultEffort: entry.efforts.defaultEffort,
      ...(entry.efforts.wireEffortMap ? { reasoningEfforts: { ...entry.efforts.wireEffortMap } } : {}),
      vision: Boolean(entry.capabilities.vision),
      ...(entry.limits.contextWindow ? { contextWindow: entry.limits.contextWindow } : {}),
      ...(entry.limits.maxOutputTokens ? { maxTokens: entry.limits.maxOutputTokens } : {}),
      enableInPool: Boolean(enableInExecutionPool && entry.family !== 'gemini'),
    };
  });
}

/**
 * Normalize a single Magpie usage row (from either `/v1/magpie/usage/requests` page mode or cursor feed mode)
 * into a clean gateway usage record for Hengzhang correlation without leaking Magpie internals.
 */
export function normalizeMagpieUsageRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.rid || `magpie-seq-${raw.seq ?? ''}`).trim();
  if (!id) return null;
  const timeMs = typeof raw.t === 'string' ? Date.parse(raw.t) : Number(raw.timeMs || 0);
  const statusNum = Number.isFinite(raw.status) ? Number(raw.status) : null;
  const ok = statusNum === null ? true : (statusNum >= 200 && statusNum < 400);

  const uncachedIn = Number.isFinite(raw.in) ? Math.max(0, Math.trunc(raw.in)) : null;
  const out = Number.isFinite(raw.out) ? Math.max(0, Math.trunc(raw.out)) : null;
  const cacheReadRaw = raw.cacheRead ?? raw.cache_read;
  const cacheWriteRaw = raw.cacheWrite ?? raw.cache_write;
  const cacheRead = Number.isFinite(cacheReadRaw) ? Math.max(0, Math.trunc(cacheReadRaw)) : 0;
  const cacheWrite = Number.isFinite(cacheWriteRaw) ? Math.max(0, Math.trunc(cacheWriteRaw)) : 0;
  const reasoning = Number.isFinite(raw.reasoning) ? Math.max(0, Math.trunc(raw.reasoning)) : null;
  const metered = uncachedIn !== null && out !== null;
  const totalTokens = metered ? (uncachedIn + cacheRead + cacheWrite + out) : null;

  const ttftRaw = raw.ttftMs ?? raw.ttft_ms;
  const gatewayCostUsd = typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost > 0
    ? raw.cost
    : null;

  return {
    gatewayRecordId: id,
    seq: Number.isInteger(raw.seq) ? raw.seq : null,
    responseId: typeof (raw.responseId ?? raw.response_id) === 'string' && (raw.responseId ?? raw.response_id)
      ? (raw.responseId ?? raw.response_id)
      : null,
    sessionId: typeof raw.session === 'string' && raw.session.trim() ? raw.session.trim() : null,
    agent: typeof raw.agent === 'string' && raw.agent.trim() ? raw.agent.trim() : null,
    timeMs: Number.isFinite(timeMs) && timeMs > 0 ? timeMs : Date.now(),
    status: ok ? 'ok' : 'error',
    httpStatus: statusNum,
    requestedRoute: typeof raw.req === 'string' && raw.req.trim() ? raw.req.trim() : 'unknown',
    actualProvider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : 'unknown',
    actualModel: typeof (raw.served || raw.model) === 'string' && String(raw.served || raw.model).trim()
      ? String(raw.served || raw.model).trim()
      : 'unknown',
    physicalAttempts: Number.isInteger(raw.tries) && raw.tries > 0 ? raw.tries : 1,
    latencyMs: Number.isFinite(raw.ms) && raw.ms >= 0 ? Math.round(raw.ms) : null,
    ttftMs: Number.isFinite(ttftRaw) && ttftRaw >= 0 ? Math.round(ttftRaw) : null,
    effort: typeof raw.effort === 'string' && raw.effort.trim() ? raw.effort.trim() : null,
    metered,
    tokens: {
      uncachedInputTokens: metered ? uncachedIn : null,
      cacheReadTokens: metered ? cacheRead : null,
      cacheWriteTokens: metered ? cacheWrite : null,
      outputTokens: metered ? out : null,
      reasoningTokens: metered ? reasoning : null,
      totalTokens,
    },
    gatewayCostUsd,
  };
}
