// Pure non-diluting 5-hour request window guard for LeaderTeam.
// Honest provenance rule: `local_estimated_requests_5h` (`local-estimate`) is ALWAYS reported
// separately from `provider_confirmed_quota` (`provider-confirmed` | `unknown`).
// Non-governance-weakening invariant: `skipGovernanceReviews` is STRICTLY `false` in EVERY tier —
// `discussA`, `discussB`, `arbiter`, and `gate` are NEVER skipped under rate/window pressure!

export const DEFAULT_REQUEST_WINDOW_CONFIG = Object.freeze({
  enabled: true,
  windowMs: 5 * 60 * 60 * 1000,
  windowsByProvider: Object.freeze({}),
  softThrottlePct: 20,
  hardPausePct: 5,
});

const CAP_DISPATCH_DEFAULT_PCT = 12;

export function pruneRequestWindowTimestamps(timestampsMs = [], windowMs = DEFAULT_REQUEST_WINDOW_CONFIG.windowMs, nowMs = Date.now()) {
  if (!Array.isArray(timestampsMs)) return [];
  const win = typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : DEFAULT_REQUEST_WINDOW_CONFIG.windowMs;
  const lowerBound = nowMs - win;
  const out = [];
  for (const t of timestampsMs) {
    if (typeof t === 'number' && Number.isFinite(t) && t > lowerBound && t <= nowMs) {
      out.push(t);
    }
  }
  return out;
}

export function isUpstream5hWindow429(errOrMessage) {
  if (!errOrMessage) return false;
  const s = typeof errOrMessage === 'string'
    ? errOrMessage
    : `${errOrMessage.code ?? ''} ${errOrMessage.status ?? ''} ${errOrMessage.message ?? ''}`;
  return /\b429\b|too\s+many\s+requests|rate[ _-]?limit/i.test(s)
    && /\b5\s*(?:h|hr|hrs|hours?)\b|window|quota|limit/i.test(s);
}

function extractConfirmedRemainingPct(providerConfirmedQuota) {
  if (providerConfirmedQuota === null || providerConfirmedQuota === undefined || providerConfirmedQuota === 'unknown') {
    return { hasConfirmed: false, remainingPct: null };
  }
  if (typeof providerConfirmedQuota === 'number' && Number.isFinite(providerConfirmedQuota)) {
    return {
      hasConfirmed: true,
      remainingPct: Math.max(0, Math.min(100, providerConfirmedQuota)),
    };
  }
  if (typeof providerConfirmedQuota === 'object' && !Array.isArray(providerConfirmedQuota)) {
    if (providerConfirmedQuota.status === 'unknown') {
      return { hasConfirmed: false, remainingPct: null };
    }
    for (const key of ['remainingPct', 'bestRemainingPct', 'remaining']) {
      const v = providerConfirmedQuota[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        return { hasConfirmed: true, remainingPct: Math.max(0, Math.min(100, v)) };
      }
    }
    const remReq = providerConfirmedQuota.remainingRequests ?? providerConfirmedQuota.remaining_requests;
    const maxReq = providerConfirmedQuota.maxRequests ?? providerConfirmedQuota.limit ?? providerConfirmedQuota.windowMax;
    if (typeof remReq === 'number' && Number.isFinite(remReq) && typeof maxReq === 'number' && Number.isFinite(maxReq) && maxReq > 0) {
      return {
        hasConfirmed: true,
        remainingPct: Math.max(0, Math.min(100, (remReq / maxReq) * 100)),
      };
    }
    // Confirmed object passed without numeric pct: preserve provenance honestly without inventing a percentage
    return { hasConfirmed: true, remainingPct: null };
  }
  return { hasConfirmed: false, remainingPct: null };
}

function resolveConfiguredWindowMax(providerWindowMax, provider, cfg) {
  if (typeof providerWindowMax === 'number' && Number.isFinite(providerWindowMax) && providerWindowMax > 0) {
    return Math.trunc(providerWindowMax);
  }
  if (provider && cfg?.windowsByProvider && typeof cfg.windowsByProvider === 'object') {
    const entry = cfg.windowsByProvider[provider];
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
      return Math.trunc(entry);
    }
    if (entry && typeof entry === 'object' && typeof entry.maxRequests === 'number' && entry.maxRequests > 0) {
      return Math.trunc(entry.maxRequests);
    }
  }
  return null;
}

/**
 * Assess 5-hour request window health and return the 3-tier non-governance-weakening throttle policy.
 */
export function assessRequestWindow({
  localCallTimestampsMs = [],
  providerConfirmedQuota = null,
  providerWindowMax = null,
  provider = null,
  upstream429Burst = false,
  recent429Count = 0,
  upstreamError = null,
  mildPressure = false,
  config = DEFAULT_REQUEST_WINDOW_CONFIG,
  nowMs = Date.now(),
} = {}) {
  const cfg = {
    ...DEFAULT_REQUEST_WINDOW_CONFIG,
    ...(config ?? {}),
  };
  const ts = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  const providerEntry = (provider && cfg?.windowsByProvider && typeof cfg.windowsByProvider === 'object')
    ? cfg.windowsByProvider[provider]
    : null;
  const baseWindowMs = (providerEntry && typeof providerEntry === 'object' && typeof providerEntry.windowMs === 'number' && providerEntry.windowMs > 0)
    ? providerEntry.windowMs
    : cfg.windowMs;
  const windowMs = typeof baseWindowMs === 'number' && Number.isFinite(baseWindowMs) && baseWindowMs > 0
    ? baseWindowMs
    : DEFAULT_REQUEST_WINDOW_CONFIG.windowMs;
  const softThrottlePct = typeof cfg.softThrottlePct === 'number' && Number.isFinite(cfg.softThrottlePct)
    ? cfg.softThrottlePct
    : DEFAULT_REQUEST_WINDOW_CONFIG.softThrottlePct;
  const hardPausePct = typeof cfg.hardPausePct === 'number' && Number.isFinite(cfg.hardPausePct)
    ? cfg.hardPausePct
    : DEFAULT_REQUEST_WINDOW_CONFIG.hardPausePct;
  const capDispatchPct = typeof cfg.capNewDispatchesPct === 'number' && Number.isFinite(cfg.capNewDispatchesPct)
    ? cfg.capNewDispatchesPct
    : Math.max(hardPausePct + 1, Math.min(softThrottlePct, CAP_DISPATCH_DEFAULT_PCT));

  const inWindowTimestamps = pruneRequestWindowTimestamps(localCallTimestampsMs, windowMs, ts);
  const localEstimatedRequests5h = inWindowTimestamps.length;

  const { hasConfirmed, remainingPct: confirmedRemainingPct } = extractConfirmedRemainingPct(providerConfirmedQuota);
  const providerConfirmedQuotaOut = hasConfirmed ? providerConfirmedQuota : 'unknown';
  const confirmedSource = hasConfirmed ? 'provider-confirmed' : 'unknown';

  const effectiveWindowMax = resolveConfiguredWindowMax(providerWindowMax, provider, cfg);
  const localEstimatedRemainingPct = effectiveWindowMax !== null
    ? Math.max(0, Math.min(100, ((effectiveWindowMax - localEstimatedRequests5h) / effectiveWindowMax) * 100))
    : null;

  const provenance = {
    windowMs,
    evaluatedAtMs: ts,
    local_estimated_requests_5h: localEstimatedRequests5h,
    localSource: 'local-estimate',
    localEstimatedRemainingPct,
    provider_confirmed_quota: providerConfirmedQuotaOut,
    confirmedSource,
    confirmedRemainingPct,
    providerWindowMax: effectiveWindowMax,
  };

  if (cfg.enabled === false) {
    return {
      ...provenance,
      enabled: false,
      tier: 'normal',
      suppressOptionalModelProbes: false,
      maxNewDispatchCap: null,
      triggerCheckpointPause: false,
      skipGovernanceReviews: false,
      reason: 'request window guard disabled',
      auditRecord: null,
    };
  }

  const explicitWindow429Burst = Boolean(upstream429Burst)
    || (typeof recent429Count === 'number' && recent429Count >= 2)
    || isUpstream5hWindow429(upstreamError);

  const hardConfirmedHit = confirmedRemainingPct !== null && confirmedRemainingPct <= hardPausePct;
  const hardLocalHit = effectiveWindowMax !== null
    && localEstimatedRequests5h >= effectiveWindowMax * ((100 - hardPausePct) / 100);

  if (hardConfirmedHit || hardLocalHit || explicitWindow429Burst) {
    const reason = explicitWindow429Burst
      ? 'explicit upstream 5h-window HTTP 429 burst detected'
      : hardConfirmedHit
        ? `provider-confirmed 5h quota remaining ${confirmedRemainingPct}% <= ${hardPausePct}%`
        : `local 5h request estimate ${localEstimatedRequests5h}/${effectiveWindowMax} reached >= ${100 - hardPausePct}% of configured window`;
    return {
      ...provenance,
      enabled: true,
      tier: 'checkpoint_pause',
      suppressOptionalModelProbes: true,
      maxNewDispatchCap: 0,
      triggerCheckpointPause: true,
      skipGovernanceReviews: false,
      reason,
      auditRecord: {
        kind: 'request-window-throttle',
        tier: 'checkpoint_pause',
        atMs: ts,
        at: new Date(ts).toISOString(),
        provider: provider ?? null,
        reason,
        local_estimated_requests_5h: localEstimatedRequests5h,
        localSource: 'local-estimate',
        provider_confirmed_quota: providerConfirmedQuotaOut,
        confirmedSource,
        providerWindowMax: effectiveWindowMax,
        skipGovernanceReviews: false,
      },
    };
  }

  const capConfirmedHit = confirmedRemainingPct !== null && confirmedRemainingPct <= capDispatchPct;
  const capLocalHit = localEstimatedRemainingPct !== null && localEstimatedRemainingPct <= capDispatchPct;
  const single429Hit = typeof recent429Count === 'number' && recent429Count === 1;

  if (capConfirmedHit || capLocalHit || single429Hit) {
    const reason = capConfirmedHit
      ? `provider-confirmed 5h quota remaining ${confirmedRemainingPct}% <= ${capDispatchPct}%`
      : capLocalHit
        ? `local 5h request estimate remaining ${Math.round(localEstimatedRemainingPct * 10) / 10}% <= ${capDispatchPct}%`
        : 'recent upstream HTTP 429 signal; capping new execution dispatches to 1';
    return {
      ...provenance,
      enabled: true,
      tier: 'cap_new_dispatches',
      suppressOptionalModelProbes: true,
      maxNewDispatchCap: 1,
      triggerCheckpointPause: false,
      skipGovernanceReviews: false,
      reason,
      auditRecord: {
        kind: 'request-window-throttle',
        tier: 'cap_new_dispatches',
        atMs: ts,
        at: new Date(ts).toISOString(),
        provider: provider ?? null,
        reason,
        local_estimated_requests_5h: localEstimatedRequests5h,
        localSource: 'local-estimate',
        provider_confirmed_quota: providerConfirmedQuotaOut,
        confirmedSource,
        providerWindowMax: effectiveWindowMax,
        skipGovernanceReviews: false,
      },
    };
  }

  const softConfirmedHit = confirmedRemainingPct !== null && confirmedRemainingPct <= softThrottlePct;
  const softLocalHit = localEstimatedRemainingPct !== null && localEstimatedRemainingPct <= softThrottlePct;

  if (softConfirmedHit || softLocalHit || Boolean(mildPressure)) {
    const reason = softConfirmedHit
      ? `provider-confirmed 5h quota remaining ${confirmedRemainingPct}% <= ${softThrottlePct}%`
      : softLocalHit
        ? `local 5h request estimate remaining ${Math.round(localEstimatedRemainingPct * 10) / 10}% <= ${softThrottlePct}%`
        : 'mild request-window pressure; trimming optional background model probes';
    return {
      ...provenance,
      enabled: true,
      tier: 'trim_probes',
      suppressOptionalModelProbes: true,
      maxNewDispatchCap: null,
      triggerCheckpointPause: false,
      skipGovernanceReviews: false,
      reason,
      auditRecord: null,
    };
  }

  return {
    ...provenance,
    enabled: true,
    tier: 'normal',
    suppressOptionalModelProbes: false,
    maxNewDispatchCap: null,
    triggerCheckpointPause: false,
    skipGovernanceReviews: false,
    reason: 'within 5h request window budget',
    auditRecord: null,
  };
}
