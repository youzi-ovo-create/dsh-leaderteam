import { extractReceipts } from './receipts.js';
import { costOfUsage, defaultPricing, lookupPricingEntry, normalizeRoute, resolveRates } from './pricing.js';

const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
const COST_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

const round2 = (n) => Number(Number(n).toFixed(2));
const round4 = (n) => Number(Number(n).toFixed(4));

function zeroUsage() {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function sanitizeTokenNumber(raw, issues, field) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(num)) {
    issues.invalidValues += 1;
    return 0;
  }
  if (num < 0) {
    issues.negativeValues += 1;
    return 0;
  }
  return Math.trunc(num);
}

function hasPositiveTokens(u) {
  return Boolean(
    u &&
    (u.inputTokens > 0 ||
      u.cacheReadTokens > 0 ||
      u.cacheWriteTokens > 0 ||
      u.outputTokens > 0 ||
      u.totalTokens > 0)
  );
}

function normalizeUsage(usage, ok, issues) {
  if (!usage || typeof usage !== 'object') {
    return { usage: zeroUsage(), unmetered: Boolean(ok) };
  }
  const hasAnyTokenField =
    usage.inputTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined;
  if (!hasAnyTokenField) {
    return { usage: zeroUsage(), unmetered: Boolean(ok) };
  }
  const inputTokens = sanitizeTokenNumber(usage.inputTokens, issues, 'inputTokens');
  const cacheReadTokens = sanitizeTokenNumber(usage.cacheReadTokens, issues, 'cacheReadTokens');
  const cacheWriteTokens = sanitizeTokenNumber(usage.cacheWriteTokens, issues, 'cacheWriteTokens');
  const outputTokens = sanitizeTokenNumber(usage.outputTokens, issues, 'outputTokens');
  const sum = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  let totalTokens = sum;
  if (usage.totalTokens !== undefined && usage.totalTokens !== null && usage.totalTokens !== '') {
    const reportedTotal = sanitizeTokenNumber(usage.totalTokens, issues, 'totalTokens');
    if (reportedTotal !== sum) {
      issues.totalMismatches += 1;
    }
    totalTokens = reportedTotal;
  }
  const parsed = { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens };
  if (!ok && !hasPositiveTokens(parsed)) {
    return { usage: zeroUsage(), unmetered: false };
  }
  return {
    usage: parsed,
    unmetered: false
  };
}

function zeroCost() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
}

function emptyAgg() {
  return {
    callsTotal: 0,
    callsSucceeded: 0,
    unmeteredCalls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheHitRatePct: 0,
    unpricedCalls: 0,
    costPeakCny: zeroCost(),
    costOffPeakCny: zeroCost(),
    costActualCny: zeroCost(),
    costPeakUsd: 0,
    costOffPeakUsd: 0,
    costActualUsd: 0,
    cacheSavingsCny: 0
  };
}

function cacheHitRate(agg) {
  const denom = agg.inputTokens + agg.cacheReadTokens;
  return denom > 0 ? round2((agg.cacheReadTokens / denom) * 100) : 0;
}

function scaleCost(cost, factor) {
  return {
    input: cost.input * factor,
    cacheRead: cost.cacheRead * factor,
    cacheWrite: cost.cacheWrite * factor,
    output: cost.output * factor,
    total: cost.total * factor
  };
}

const KNOWN_DIRECT_VENDOR_PREFIXES = new Set([
  'deepseek',
  'openai',
  'codex',
  'anthropic',
  'claude',
  'gemini',
  'google',
  'antigravity',
  'dashscope',
  'bailian',
  'bailian-token-plan',
  'zhipu',
  'zcode'
]);

function resolveFallbackAttribution(route, hostProvider) {
  const cleanRoute = typeof route === 'string' ? route.trim() : '';
  if (!cleanRoute || cleanRoute === 'unknown') {
    return { actualProvider: 'unknown', actualModel: 'unknown' };
  }
  if (cleanRoute.startsWith('group/')) {
    return { actualProvider: 'unknown', actualModel: 'unknown' };
  }
  if (cleanRoute.startsWith('auto/')) {
    return { actualProvider: 'unknown', actualModel: cleanRoute.slice('auto/'.length) || 'unknown' };
  }
  const slashIdx = cleanRoute.indexOf('/');
  if (slashIdx > 0) {
    const prefix = cleanRoute.slice(0, slashIdx).replace(/@.*$/, '').toLowerCase();
    const modelPart = cleanRoute.slice(slashIdx + 1) || 'unknown';
    if (KNOWN_DIRECT_VENDOR_PREFIXES.has(prefix)) {
      return { actualProvider: prefix, actualModel: modelPart };
    }
    if (hostProvider && KNOWN_DIRECT_VENDOR_PREFIXES.has(String(hostProvider).toLowerCase())) {
      return { actualProvider: String(hostProvider).toLowerCase(), actualModel: modelPart };
    }
    return { actualProvider: 'unknown', actualModel: modelPart };
  }
  if (hostProvider && KNOWN_DIRECT_VENDOR_PREFIXES.has(String(hostProvider).toLowerCase())) {
    return { actualProvider: String(hostProvider).toLowerCase(), actualModel: cleanRoute };
  }
  return { actualProvider: 'unknown', actualModel: cleanRoute };
}

function createGatewayMatcher(gatewayRecords) {
  const list = Array.isArray(gatewayRecords) ? gatewayRecords.filter(Boolean) : [];
  const usedIndices = new Set();
  const byResponseId = new Map();
  list.forEach((rec, idx) => {
    if (typeof rec.responseId === 'string' && rec.responseId) {
      byResponseId.set(rec.responseId, idx);
    }
  });

  return function matchRow(spec, usage) {
    if (list.length === 0) return null;
    if (spec.responseId && byResponseId.has(spec.responseId)) {
      const idx = byResponseId.get(spec.responseId);
      if (!usedIndices.has(idx)) {
        usedIndices.add(idx);
        return list[idx];
      }
    }
    // Bounded fallback match by session/route + timestamp proximity + token parity
    const rowTimeMs = Number.isFinite(spec.timeMs) ? spec.timeMs : null;
    if (rowTimeMs === null) return null;
    let bestIdx = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (usedIndices.has(i)) continue;
      const cand = list[i];
      if (!Number.isFinite(cand.timeMs)) continue;
      const delta = Math.abs(cand.timeMs - rowTimeMs);
      if (delta > 15_000) continue;
      if (cand.sessionId && spec.sessionId && cand.sessionId !== spec.sessionId) continue;
      const candTotal = cand.tokens?.totalTokens;
      if (Number.isFinite(candTotal) && usage.totalTokens > 0 && candTotal !== usage.totalTokens) continue;
      const reqNorm = normalizeRoute(cand.requestedRoute || '').replace(/^magpie\//i, '');
      const specNorm = normalizeRoute(spec.route || '').replace(/^magpie\//i, '');
      if (reqNorm && specNorm && reqNorm !== specNorm && !reqNorm.startsWith('group/') && !specNorm.startsWith('group/')) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      usedIndices.add(bestIdx);
      return list[bestIdx];
    }
    return null;
  };
}

function makeLedgerRow(spec, pricing, issues, matchGateway = null) {
  const ok = spec.ok !== false;
  const { usage, unmetered } = normalizeUsage(spec.usage, ok, issues);
  const route = normalizeRoute(spec.route);
  const gw = matchGateway ? matchGateway(spec, usage) : null;
  const fallbackAttr = resolveFallbackAttribution(route, spec.hostProvider);
  const actualProvider = gw?.actualProvider && gw.actualProvider !== 'unknown'
    ? gw.actualProvider
    : fallbackAttr.actualProvider;
  const actualModel = gw?.actualModel && gw.actualModel !== 'unknown'
    ? gw.actualModel
    : fallbackAttr.actualModel;
  const latencyMs = Number.isFinite(gw?.latencyMs)
    ? gw.latencyMs
    : (Number.isFinite(spec.latencyMs) ? spec.latencyMs : null);
  const ttftMs = Number.isFinite(gw?.ttftMs) ? gw.ttftMs : null;
  const physicalAttempts = Number.isInteger(gw?.physicalAttempts) && gw.physicalAttempts > 0
    ? gw.physicalAttempts
    : (Number.isInteger(spec.attempts) && spec.attempts > 0 ? spec.attempts : null);

  // Pricing resolution: prefer exact route pricing (preserves golden snapshot calibration),
  // else if gateway revealed concrete upstream vendor/model on a custom/group route, try pricing `${actualProvider}/${actualModel}`,
  // else never fabricate a price (null -> unpricedCalls++).
  let resolved = resolveRates(route, spec.timeMs, pricing);
  if (!resolved && actualProvider !== 'unknown' && actualModel !== 'unknown') {
    resolved = resolveRates(`${actualProvider}/${actualModel}`, spec.timeMs, pricing);
  }
  const billedWork = ok || hasPositiveTokens(usage);
  let cnyPeak = null;
  let cnyOffPeak = null;
  let cnyActual = null;
  let usdPeak = null;
  let usdOffPeak = null;
  let usdActual = null;
  let cacheSavingsCny = 0;

  if (!billedWork) {
    // 失败调用且未产生任何计费 Token，费用确认为 0，不误报为未定价。
    cnyPeak = zeroCost();
    cnyOffPeak = zeroCost();
    cnyActual = zeroCost();
    usdPeak = 0;
    usdOffPeak = 0;
    usdActual = 0;
  } else if (!unmetered && resolved) {
    const peak = costOfUsage(usage, resolved.peak);
    const offPeak = costOfUsage(usage, resolved.offPeak);
    const actual = costOfUsage(usage, resolved.actual);
    const cnyFactor = resolved.entry.currency === 'USD' ? resolved.usdToCny : 1;
    const usdFactor = resolved.entry.currency === 'USD' ? 1 : 1 / resolved.usdToCny;
    cnyPeak = scaleCost(peak, cnyFactor);
    cnyOffPeak = scaleCost(offPeak, cnyFactor);
    cnyActual = scaleCost(actual, cnyFactor);
    usdPeak = peak.total * usdFactor;
    usdOffPeak = offPeak.total * usdFactor;
    usdActual = actual.total * usdFactor;
    if (usage.cacheReadTokens > 0) {
      const withoutCache = costOfUsage(
        {
          inputTokens: usage.inputTokens + usage.cacheReadTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens
        },
        resolved.actual
      );
      cacheSavingsCny = Math.max(0, (withoutCache.total - actual.total) * cnyFactor);
    }
  }

  const rawReasoning =
    gw?.tokens?.reasoningTokens ??
    spec.usage?.reasoningTokens ??
    spec.usage?.outputTokensDetails?.reasoningTokens ??
    spec.usage?.completion_tokens_details?.reasoning_tokens;
  let reasoningTokens =
    rawReasoning !== null && rawReasoning !== undefined && rawReasoning !== '' && Number.isFinite(Number(rawReasoning))
      ? Math.max(0, Math.trunc(Number(rawReasoning)))
      : null;
  if (!billedWork || unmetered) {
    reasoningTokens = null;
  } else if (reasoningTokens !== null && reasoningTokens > usage.outputTokens) {
    reasoningTokens = usage.outputTokens;
  }

  return {
    timeMs: Number.isFinite(spec.timeMs) ? spec.timeMs : null,
    group: spec.group,
    actor: spec.actor,
    role: spec.role,
    stageId: spec.stageId ?? null,
    taskSeq: Number.isInteger(spec.taskSeq) && spec.taskSeq > 0 ? spec.taskSeq : null,
    sessionId: spec.sessionId,
    agentKey: spec.agentKey,
    route,
    hostProvider: spec.hostProvider ?? null,
    gatewayMatched: Boolean(gw),
    matchedPriceRoute: resolved?.matchedRoute ?? null,
    actualProvider,
    actualModel,
    latencyMs,
    ttftMs,
    physicalAttempts,
    responseId: spec.responseId ?? gw?.responseId ?? null,
    ok,
    unmetered,
    degraded: !!spec.degraded,
    usage,
    reasoningTokens,
    priced: resolved !== null,
    costKnown: !billedWork || (!unmetered && resolved !== null),
    cnyPeak,
    cnyOffPeak,
    cnyActual,
    usdPeak,
    usdOffPeak,
    usdActual,
    cacheSavingsCny
  };
}

function aggregateRows(rows) {
  const agg = emptyAgg();
  const peak = zeroCost();
  const offPeak = zeroCost();
  const actual = zeroCost();
  let peakCnyTotal = 0;
  let offPeakCnyTotal = 0;
  let actualCnyTotal = 0;
  let savingsTotal = 0;
  let knownBilledCount = 0;
  let anyBilledCall = false;

  for (const row of rows) {
    const rowBilled = row.ok || hasPositiveTokens(row.usage);
    if (rowBilled) anyBilledCall = true;
    agg.callsTotal++;
    if (row.ok) agg.callsSucceeded++;
    if (row.unmetered) agg.unmeteredCalls++;
    for (const field of TOKEN_FIELDS) agg[field] += row.usage[field];
    if (rowBilled && !row.unmetered && !row.priced) {
      agg.unpricedCalls++;
      continue;
    }
    if (!row.costKnown) continue;
    if (rowBilled) knownBilledCount++;
    for (const field of COST_FIELDS) {
      peak[field] += row.cnyPeak[field];
      offPeak[field] += row.cnyOffPeak[field];
      actual[field] += row.cnyActual[field];
    }
    peakCnyTotal += row.cnyPeak.total;
    offPeakCnyTotal += row.cnyOffPeak.total;
    actualCnyTotal += row.cnyActual.total;
    agg.costPeakUsd += row.usdPeak;
    agg.costOffPeakUsd += row.usdOffPeak;
    agg.costActualUsd += row.usdActual;
    savingsTotal += row.cacheSavingsCny;
  }

  agg.cacheHitRatePct = cacheHitRate(agg);
  if (anyBilledCall && knownBilledCount === 0) {
    agg.costPeakCny = null;
    agg.costOffPeakCny = null;
    agg.costActualCny = null;
    agg.costPeakUsd = null;
    agg.costOffPeakUsd = null;
    agg.costActualUsd = null;
    agg.cacheSavingsCny = 0;
    return agg;
  }

  agg.costPeakCny = {
    input: round4(peak.input),
    cacheRead: round4(peak.cacheRead),
    cacheWrite: round4(peak.cacheWrite),
    output: round4(peak.output),
    total: round4(peakCnyTotal)
  };
  agg.costOffPeakCny = {
    input: round4(offPeak.input),
    cacheRead: round4(offPeak.cacheRead),
    cacheWrite: round4(offPeak.cacheWrite),
    output: round4(offPeak.output),
    total: round4(offPeakCnyTotal)
  };
  agg.costActualCny = {
    input: round4(actual.input),
    cacheRead: round4(actual.cacheRead),
    cacheWrite: round4(actual.cacheWrite),
    output: round4(actual.output),
    total: round4(actualCnyTotal)
  };
  agg.costPeakUsd = round4(agg.costPeakUsd);
  agg.costOffPeakUsd = round4(agg.costOffPeakUsd);
  agg.costActualUsd = round4(agg.costActualUsd);
  agg.cacheSavingsCny = round4(savingsTotal);
  return agg;
}

function rowTime(row) {
  return row.timeMs ?? 0;
}

function assignOrder(ledger) {
  const ordered = [...ledger].sort((a, b) => rowTime(a) - rowTime(b));
  const steps = new Map();
  ordered.forEach((row, index) => {
    row.n = index + 1;
    // 黄金口径：治理调用（gate/discussA/discussB…）共用一个步号计数器，其余按执行体各自计数。
    const stepOwner = row.group === 'governance' ? 'governance' : row.actor;
    const key = `${row.sessionId}\u0000${stepOwner}`;
    const step = (steps.get(key) ?? 0) + 1;
    steps.set(key, step);
    row.step = step;
  });
  return ordered;
}

function toCall(row) {
  return {
    n: row.n,
    timeMs: row.timeMs,
    group: row.group,
    actor: row.actor,
    role: row.role,
    stageId: row.stageId,
    taskSeq: row.taskSeq ?? null,
    step: row.step,
    route: row.route,
    hostProvider: row.hostProvider ?? null,
    gatewayMatched: Boolean(row.gatewayMatched),
    matchedPriceRoute: row.matchedPriceRoute ?? null,
    actualProvider: row.actualProvider ?? 'unknown',
    actualModel: row.actualModel ?? 'unknown',
    latencyMs: row.latencyMs ?? null,
    ttftMs: row.ttftMs ?? null,
    physicalAttempts: row.physicalAttempts ?? null,
    responseId: row.responseId ?? null,
    ok: row.ok,
    unmetered: row.unmetered,
    degraded: row.degraded,
    ...row.usage,
    reasoningTokens: row.reasoningTokens ?? null,
    costPeakCny: row.costKnown ? row.cnyPeak.total : null,
    costOffPeakCny: row.costKnown ? row.cnyOffPeak.total : null,
    costActualCny: row.costKnown ? row.cnyActual.total : null,
    sessionId: row.sessionId
  };
}

function catalogOf(sessions) {
  const catalog = new Map();
  for (const session of sessions) {
    for (const row of session.rows ?? []) {
      if (row?.type === 'subagent/catalog' && row?.data?.childId) {
        catalog.set(row.data.childId, row.data.label);
      }
    }
  }
  return catalog;
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function titleOf(rows) {
  let title;
  for (const row of rows ?? []) {
    if (row?.type === 'session/title' && typeof row?.data?.title === 'string' && row.data.title.trim()) {
      title = row.data.title;
    }
  }
  return title;
}

function governanceActor(record) {
  if (record?.purpose) return `${record.role}:${record.purpose}`;
  if (record?.role === 'gate') return 'gate:safety-gate';
  return record?.role ?? 'governance';
}

function buildMeta({ home, sessionId, kind, main, sessions, ledger, notes }) {
  let startMs = Infinity;
  let rowMaxMs = -Infinity;
  for (const session of sessions) {
    for (const row of session.rows ?? []) {
      if (Number.isFinite(row?.time)) {
        startMs = Math.min(startMs, row.time);
        rowMaxMs = Math.max(rowMaxMs, row.time);
      }
    }
  }
  let lastMs = -Infinity;
  for (const row of ledger) {
    if (Number.isFinite(row.timeMs)) lastMs = Math.max(lastMs, row.timeMs);
  }
  if (!Number.isFinite(startMs)) startMs = main?.header?.createdAt ?? null;
  if (!Number.isFinite(lastMs)) lastMs = Number.isFinite(rowMaxMs) ? rowMaxMs : startMs;
  const title = titleOf(main?.rows);
  const meta = {
    home: home ?? null,
    sessionId,
    kind,
    cwd: main?.header?.cwd ?? null
  };
  if (title !== undefined) meta.title = title;
  meta.startedAtMs = Number.isFinite(startMs) ? startMs : null;
  meta.lastActivityMs = Number.isFinite(lastMs) ? lastMs : null;
  meta.generatedAtMs = Date.now();
  meta.complete = !notes.some((note) => note.startsWith('missing session'));
  meta.notes = notes;
  return meta;
}

function buildByModel(ledger, pricing, grandTotalTokens) {
  const map = new Map();
  for (const row of ledger) {
    if (!map.has(row.route)) map.set(row.route, []);
    map.get(row.route).push(row);
  }
  const out = [];
  for (const [route, rows] of map) {
    const agg = aggregateRows(rows);
    const found = lookupPricingEntry(route, pricing);
    const entry = found?.entry;
    const hasRate = Boolean(entry?.peak);
    const hasKnownBilled = rows.some((r) => (r.ok || hasPositiveTokens(r.usage)) && r.costKnown);
    const zeroOnlyUnbilledFailed =
      agg.callsSucceeded === 0 && agg.totalTokens === 0 && agg.unmeteredCalls === 0 && agg.unpricedCalls === 0;
    const costAvailable = zeroOnlyUnbilledFailed ? true : hasKnownBilled;
    const item = { route };
    if (entry?.label) item.label = entry.label;
    if (entry?.vendor) item.vendor = entry.vendor;
    Object.assign(item, {
      callsTotal: agg.callsTotal,
      callsSucceeded: agg.callsSucceeded,
      unmeteredCalls: agg.unmeteredCalls,
      inputTokens: agg.inputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      cacheHitRatePct: agg.cacheHitRatePct,
      shareOfTotalTokensPct:
        grandTotalTokens > 0 ? round2((agg.totalTokens / grandTotalTokens) * 100) : 0,
      priced: hasRate || hasKnownBilled,
      costPeakCny: costAvailable ? agg.costPeakCny : null,
      costOffPeakCny: costAvailable ? agg.costOffPeakCny : null,
      costActualCny: costAvailable ? agg.costActualCny : null
    });
    out.push(item);
  }
  return out;
}

function buildGroups(ledger, kinds) {
  const labels = {
    leader: 'Leader',
    execution: 'Execution',
    governance: 'Governance',
    main: 'Main',
    subagents: 'Subagents'
  };
  return kinds.map((id) => {
    const agg = aggregateRows(ledger.filter((row) => row.group === id));
    return {
      id,
      label: labels[id],
      callsTotal: agg.callsTotal,
      callsSucceeded: agg.callsSucceeded,
      unmeteredCalls: agg.unmeteredCalls,
      inputTokens: agg.inputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      costPeakCny: agg.costPeakCny,
      costOffPeakCny: agg.costOffPeakCny,
      costActualCny: agg.costActualCny
    };
  });
}

function buildAgents(ledger, specs) {
  return specs.map((spec) => {
    const rows = ledger.filter((row) => row.agentKey === spec.agentKey);
    const agg = aggregateRows(rows);
    const times = rows.map((row) => row.timeMs).filter(Number.isFinite);
    const routes = [...new Set(rows.map((row) => row.route))];
    const item = {
      name: spec.name,
      actorRole: spec.actorRole,
      stageId: spec.stageId ?? null,
      sessionId: spec.sessionId,
      group: spec.group,
      routes
    };
    if (spec.status !== undefined) item.status = spec.status;
    Object.assign(item, {
      callsTotal: agg.callsTotal,
      callsSucceeded: agg.callsSucceeded,
      unmeteredCalls: agg.unmeteredCalls,
      inputTokens: agg.inputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      cacheHitRatePct: agg.cacheHitRatePct,
      durationSec:
        times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0,
      costPeakCny: agg.costPeakCny ? agg.costPeakCny.total : null,
      costOffPeakCny: agg.costOffPeakCny ? agg.costOffPeakCny.total : null,
      costActualCny: agg.costActualCny ? agg.costActualCny.total : null
    });
    return item;
  });
}

function buildByProvider(ledger, grandTotalTokens) {
  const map = new Map();
  for (const row of ledger) {
    const prov = row.actualProvider || 'unknown';
    if (!map.has(prov)) map.set(prov, []);
    map.get(prov).push(row);
  }
  const out = [];
  for (const [provider, rows] of map) {
    const agg = aggregateRows(rows);
    const hasAnyKnownCost = rows.some((r) => (r.ok || hasPositiveTokens(r.usage)) && r.costKnown && r.priced);
    const zeroOnlyUnbilledFailed =
      agg.callsSucceeded === 0 && agg.totalTokens === 0 && agg.unmeteredCalls === 0 && agg.unpricedCalls === 0;
    const costAvailable = (hasAnyKnownCost && agg.unpricedCalls === 0) || zeroOnlyUnbilledFailed;
    out.push({
      provider,
      callsTotal: agg.callsTotal,
      callsSucceeded: agg.callsSucceeded,
      unmeteredCalls: agg.unmeteredCalls,
      unpricedCalls: agg.unpricedCalls,
      inputTokens: agg.inputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      outputTokens: agg.outputTokens,
      totalTokens: agg.totalTokens,
      shareOfTotalTokensPct: grandTotalTokens > 0 ? round2((agg.totalTokens / grandTotalTokens) * 100) : 0,
      costActualCny: costAvailable && agg.costActualCny ? agg.costActualCny.total : null
    });
  }
  return out;
}

function buildByTask(ledger) {
  const map = new Map();
  for (const row of ledger) {
    const key = row.taskSeq ?? 'unassigned';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const out = [];
  for (const [taskKey, rows] of map) {
    const agg = aggregateRows(rows);
    const zeroOnlyUnbilledFailed =
      agg.callsSucceeded === 0 && agg.totalTokens === 0 && agg.unmeteredCalls === 0 && agg.unpricedCalls === 0;
    const costAvailable = (agg.unpricedCalls === 0 && agg.unmeteredCalls === 0) || zeroOnlyUnbilledFailed;
    out.push({
      taskSeq: typeof taskKey === 'number' ? taskKey : null,
      callsTotal: agg.callsTotal,
      callsSucceeded: agg.callsSucceeded,
      totalTokens: agg.totalTokens,
      costActualCny: costAvailable && agg.costActualCny ? agg.costActualCny.total : null
    });
  }
  return out;
}

function appendGovernanceRows({
  ledger,
  specs,
  ownerSessionId,
  governance,
  pricing,
  issues,
  matchGateway,
  notes,
  filterLeaderRole = false
}) {
  const governanceAgents = new Map();
  const records = filterLeaderRole
    ? (governance ?? []).filter((record) => record && record.role !== 'leader')
    : (governance ?? []);
  for (const record of records) {
    const timeMs = Date.parse(record?.at);
    if (!Number.isFinite(timeMs)) {
      notes.push(`governance record without valid at: ${String(record?.at)}`);
      continue;
    }
    const actor = governanceActor(record);
    if (!governanceAgents.has(actor)) {
      governanceAgents.set(actor, true);
      specs.push({
        agentKey: `governance|${ownerSessionId}|${actor}`,
        group: 'governance',
        name: actor,
        actorRole: record.role ?? 'governance',
        stageId: record.purpose ?? (record.role === 'gate' ? 'safety-gate' : null),
        sessionId: ownerSessionId
      });
    }
    ledger.push(
      makeLedgerRow(
        {
          timeMs,
          group: 'governance',
          actor,
          role: record.role ?? 'governance',
          stageId: null,
          taskSeq: Number.isInteger(record.taskSeq) ? record.taskSeq : null,
          sessionId: ownerSessionId,
          agentKey: `governance|${ownerSessionId}|${actor}`,
          route: record.route ?? 'unknown',
          hostProvider: record.hostProvider ?? null,
          responseId: record.responseId ?? null,
          attempts: Number.isInteger(record.attempts) ? record.attempts : null,
          latencyMs: Number.isFinite(record.latencyMs) ? record.latencyMs : null,
          usage: record.usage ?? null,
          ok: record.ok !== false,
          degraded: record.degraded
        },
        pricing,
        issues,
        matchGateway
      )
    );
  }
}

function buildTeamReport(input, notes, issues, matchGateway) {
  const { home, sessionId, sessions, governance, members, pricing, approvedDeliveryTimes, modeBoundaries } = input;
  const leader = sessions[0];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const catalog = catalogOf(sessions);
  const ledger = [];
  const specs = [];

  const leaderReceipts = extractReceipts(leader.rows ?? [], { approvedDeliveryTimes, modeBoundaries });
  for (const receipt of leaderReceipts.receipts) {
    ledger.push(
      makeLedgerRow(
        {
          timeMs: receipt.timeMs,
          group: 'leader',
          actor: 'leader',
          role: 'leader',
          stageId: null,
          taskSeq: receipt.taskSeq ?? null,
          sessionId: leader.id,
          agentKey: `leader|${leader.id}|leader`,
          route: receipt.route,
          hostProvider: receipt.hostProvider,
          responseId: receipt.responseId,
          latencyMs: receipt.latencyMs,
          usage: receipt.usage,
          ok: receipt.ok
        },
        pricing,
        issues,
        matchGateway
      )
    );
  }
  specs.push({
    agentKey: `leader|${leader.id}|leader`,
    group: 'leader',
    name: 'leader',
    actorRole: 'leader',
    stageId: null,
    sessionId: leader.id
  });

  for (const member of members?.values?.() ?? []) {
    const childId = member.childId;
    const name = member.name ?? catalog.get(childId) ?? shortId(childId);
    const actorRole = member.actorRole ?? 'member';
    const agentKey = `execution|${childId}|${name}`;
    const child = byId.get(childId);
    if (!child) {
      notes.push(`missing session ${childId} (${name})`);
      specs.push({
        agentKey,
        group: 'execution',
        name,
        actorRole,
        stageId: member.stageId ?? null,
        sessionId: childId,
        status: member.status
      });
      continue;
    }
    const receipts = extractReceipts(child.rows ?? []);
    for (const receipt of receipts.receipts) {
      ledger.push(
        makeLedgerRow(
          {
            timeMs: receipt.timeMs,
            group: 'execution',
            actor: name,
            role: actorRole,
            stageId: member.stageId ?? null,
            taskSeq: member.taskSeq ?? receipt.taskSeq ?? null,
            sessionId: childId,
            agentKey,
            route: receipt.route,
            hostProvider: receipt.hostProvider,
            responseId: receipt.responseId,
            latencyMs: receipt.latencyMs,
            usage: receipt.usage,
            ok: receipt.ok
          },
          pricing,
          issues,
          matchGateway
        )
      );
    }
    specs.push({
      agentKey,
      group: 'execution',
      name,
      actorRole,
      stageId: member.stageId ?? null,
      sessionId: childId,
      status: member.status
    });
  }

  // Include any native DSH subagent descendants (via parentSession) not listed in members.jsonl
  const handledSessionIds = new Set([
    leader.id,
    ...Array.from(members?.values?.() ?? [], (m) => m.childId).filter(Boolean)
  ]);
  for (const extra of sessions.slice(1)) {
    if (!extra?.id || handledSessionIds.has(extra.id)) continue;
    handledSessionIds.add(extra.id);
    const name = catalog.get(extra.id) ?? shortId(extra.id);
    const actorRole = 'subagent';
    const agentKey = `execution|${extra.id}|${name}`;
    const receipts = extractReceipts(extra.rows ?? []);
    for (const receipt of receipts.receipts) {
      ledger.push(
        makeLedgerRow(
          {
            timeMs: receipt.timeMs,
            group: 'execution',
            actor: name,
            role: actorRole,
            stageId: null,
            taskSeq: receipt.taskSeq ?? null,
            sessionId: extra.id,
            agentKey,
            route: receipt.route,
            hostProvider: receipt.hostProvider,
            responseId: receipt.responseId,
            latencyMs: receipt.latencyMs,
            usage: receipt.usage,
            ok: receipt.ok
          },
          pricing,
          issues,
          matchGateway
        )
      );
    }
    specs.push({
      agentKey,
      group: 'execution',
      name,
      actorRole,
      stageId: null,
      sessionId: extra.id
    });
  }

  appendGovernanceRows({
    ledger,
    specs,
    ownerSessionId: leader.id,
    governance,
    pricing,
    issues,
    matchGateway,
    notes
  });

  return { ledger, specs, groups: ['leader', 'execution', 'governance'] };
}

function buildSessionReport(input, notes, issues, matchGateway) {
  const { sessions, governance, pricing, approvedDeliveryTimes, modeBoundaries } = input;
  const catalog = catalogOf(sessions);
  const ledger = [];
  const specs = [];
  const main = sessions[0];

  sessions.forEach((session, index) => {
    const group = index === 0 ? 'main' : 'subagents';
    const name =
      index === 0 ? 'main' : catalog.get(session.id) ?? shortId(session.id);
    const role = index === 0 ? 'main' : 'subagent';
    const agentKey = `${group}|${session.id}|${name}`;
    const receipts = extractReceipts(
      session.rows ?? [],
      index === 0 ? { approvedDeliveryTimes, modeBoundaries } : undefined
    );
    for (const receipt of receipts.receipts) {
      ledger.push(
        makeLedgerRow(
          {
            timeMs: receipt.timeMs,
            group,
            actor: name,
            role,
            stageId: null,
            taskSeq: index === 0 ? (receipt.taskSeq ?? null) : null,
            sessionId: session.id,
            agentKey,
            route: receipt.route,
            hostProvider: receipt.hostProvider,
            responseId: receipt.responseId,
            latencyMs: receipt.latencyMs,
            usage: receipt.usage,
            ok: receipt.ok
          },
          pricing,
          issues,
          matchGateway
        )
      );
    }
    specs.push({
      agentKey,
      group,
      name,
      actorRole: role,
      stageId: null,
      sessionId: session.id
    });
  });

  appendGovernanceRows({
    ledger,
    specs,
    ownerSessionId: main.id,
    governance,
    pricing,
    issues,
    matchGateway,
    notes,
    filterLeaderRole: true
  });

  const hasGovernance = ledger.some((row) => row.group === 'governance');
  const groups = [
    ...(sessions.length > 1 ? ['main', 'subagents'] : ['main']),
    ...(hasGovernance ? ['governance'] : [])
  ];
  return { ledger, specs, groups, main };
}

export function buildReport(input) {
  const {
    home = null,
    sessionId,
    sessions = [],
    governance = [],
    gateSummary,
    approvedDeliveryTimes,
    modeBoundaries,
    members,
    kind,
    pricing = defaultPricing,
    gatewayRecords = []
  } = input ?? {};
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('buildReport: at least one session is required');
  }
  if (kind !== 'team' && kind !== 'session') {
    throw new Error(`buildReport: unsupported kind ${String(kind)}`);
  }
  const notes = [];
  const issues = { invalidValues: 0, negativeValues: 0, totalMismatches: 0 };
  const matchGateway = createGatewayMatcher(gatewayRecords);
  const built =
    kind === 'team'
      ? buildTeamReport(
          { home, sessionId, sessions, governance, members, pricing, approvedDeliveryTimes, modeBoundaries },
          notes,
          issues,
          matchGateway
        )
      : buildSessionReport(
          { home, sessionId, sessions, governance, members, pricing, approvedDeliveryTimes, modeBoundaries },
          notes,
          issues,
          matchGateway
        );
  const ordered = assignOrder(built.ledger);
  const totals = aggregateRows(ordered);
  if (totals.unmeteredCalls > 0) {
    notes.push(`含 ${totals.unmeteredCalls} 次成功调用缺失 usage 字段（未计量，不伪作 0 费用）`);
  }
  if (issues.invalidValues > 0 || issues.negativeValues > 0) {
    notes.push(
      `已清洗异常 Token 数值（非法值 ${issues.invalidValues} 处、负数截断 ${issues.negativeValues} 处）`
    );
  }
  if (issues.totalMismatches > 0) {
    notes.push(`发现 ${issues.totalMismatches} 条回执上报 totalTokens 与四桶之和存在偏差`);
  }
  const byModel = buildByModel(ordered, pricing, totals.totalTokens);
  const byProvider = buildByProvider(ordered, totals.totalTokens);
  const byTask = buildByTask(ordered);
  const groups = buildGroups(ordered, built.groups);
  const agents = buildAgents(ordered, built.specs);
  const main = sessions[0];
  const meta = buildMeta({ home, sessionId, kind, main, sessions, ledger: ordered, notes });

  const out = {
    meta,
    totals,
    byModel,
    byProvider,
    byTask,
    groups,
    agents,
    calls: ordered.map(toCall)
  };
  if (gateSummary && kind === 'session') {
    out.gateSummary = gateSummary;
  }
  return out;
}
