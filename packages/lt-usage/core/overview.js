const TOKEN_FIELDS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'];
const COST_FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];

const round2 = (n) => Number(Number(n).toFixed(2));
const round4 = (n) => Number(Number(n).toFixed(4));

function addCost(target, cost) {
  for (const field of COST_FIELDS) target[field] += cost?.[field] ?? 0;
  target.total += cost?.total ?? 0;
}

function finalizeCost(cost) {
  const out = {};
  for (const field of COST_FIELDS) out[field] = round4(cost[field]);
  out.total = round4(cost.total);
  return out;
}

export function aggregateOverview(reports, options = {}) {
  const totals = {
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
    costPeakCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    costOffPeakCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    costActualCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
    costPeakUsd: 0,
    costOffPeakUsd: 0,
    costActualUsd: 0,
    cacheSavingsCny: 0
  };
  let hasKnownSucceededSessionCost = false;
  const models = new Map();
  const sessions = [];

  for (const report of reports ?? []) {
    const t = report?.totals ?? {};
    const reportCallsSucceeded = t.callsSucceeded ?? 0;
    const reportCostKnown = reportCallsSucceeded === 0 || t.costActualCny != null;
    if (reportCallsSucceeded > 0 && t.costActualCny != null) {
      hasKnownSucceededSessionCost = true;
    }
    totals.callsTotal += t.callsTotal ?? 0;
    totals.callsSucceeded += reportCallsSucceeded;
    totals.unmeteredCalls += t.unmeteredCalls ?? 0;
    for (const field of TOKEN_FIELDS) totals[field] += t[field] ?? 0;
    totals.unpricedCalls += t.unpricedCalls ?? 0;
    if (t.costPeakCny != null) addCost(totals.costPeakCny, t.costPeakCny);
    if ((t.costOffPeakCny ?? t.costActualCny) != null) {
      addCost(totals.costOffPeakCny, t.costOffPeakCny ?? t.costActualCny);
    }
    if (t.costActualCny != null) addCost(totals.costActualCny, t.costActualCny);
    totals.costPeakUsd += t.costPeakUsd ?? 0;
    totals.costOffPeakUsd += t.costOffPeakUsd ?? t.costActualUsd ?? 0;
    totals.costActualUsd += t.costActualUsd ?? 0;
    totals.cacheSavingsCny += t.cacheSavingsCny ?? 0;

    for (const item of report?.byModel ?? []) {
      if (!models.has(item.route)) {
        models.set(item.route, {
          route: item.route,
          label: item.label,
          vendor: item.vendor,
          callsTotal: 0,
          callsSucceeded: 0,
          unmeteredCalls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          priced: item.priced,
          hasKnownCost: false,
          costPeakCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
          costOffPeakCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
          costActualCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
        });
      }
      const model = models.get(item.route);
      model.callsTotal += item.callsTotal ?? 0;
      model.callsSucceeded += item.callsSucceeded ?? 0;
      model.unmeteredCalls += item.unmeteredCalls ?? 0;
      model.priced = model.priced || item.priced;
      if ((item.callsSucceeded ?? 0) > 0 && item.costActualCny != null) {
        model.hasKnownCost = true;
      }
      for (const field of TOKEN_FIELDS) model[field] += item[field] ?? 0;
      if (item.costPeakCny != null) addCost(model.costPeakCny, item.costPeakCny);
      if ((item.costOffPeakCny ?? item.costActualCny) != null) {
        addCost(model.costOffPeakCny, item.costOffPeakCny ?? item.costActualCny);
      }
      if (item.costActualCny != null) addCost(model.costActualCny, item.costActualCny);
    }

    const meta = report?.meta ?? {};
    sessions.push({
      sessionId: meta.sessionId,
      kind: meta.kind,
      cwd: meta.cwd ?? null,
      title: meta.title ?? null,
      startedAtMs: meta.startedAtMs ?? null,
      lastActivityMs: meta.lastActivityMs ?? null,
      callsTotal: t.callsTotal ?? 0,
      callsSucceeded: reportCallsSucceeded,
      unmeteredCalls: t.unmeteredCalls ?? 0,
      inputTokens: t.inputTokens ?? 0,
      cacheReadTokens: t.cacheReadTokens ?? 0,
      cacheWriteTokens: t.cacheWriteTokens ?? 0,
      outputTokens: t.outputTokens ?? 0,
      totalTokens: t.totalTokens ?? 0,
      unpricedCalls: t.unpricedCalls ?? 0,
      costPeakCny: reportCostKnown ? round4(t.costPeakCny?.total ?? 0) : null,
      costOffPeakCny: reportCostKnown ? round4((t.costOffPeakCny ?? t.costActualCny)?.total ?? 0) : null,
      costActualCny: reportCostKnown ? round4(t.costActualCny?.total ?? 0) : null
    });
  }

  const tokenDenom = totals.inputTokens + totals.cacheReadTokens;
  totals.cacheHitRatePct = tokenDenom > 0 ? round2((totals.cacheReadTokens / tokenDenom) * 100) : 0;
  if (totals.callsSucceeded > 0 && !hasKnownSucceededSessionCost) {
    totals.costPeakCny = null;
    totals.costOffPeakCny = null;
    totals.costActualCny = null;
    totals.costPeakUsd = null;
    totals.costOffPeakUsd = null;
    totals.costActualUsd = null;
    totals.cacheSavingsCny = 0;
  } else {
    totals.costPeakCny = finalizeCost(totals.costPeakCny);
    totals.costOffPeakCny = finalizeCost(totals.costOffPeakCny);
    totals.costActualCny = finalizeCost(totals.costActualCny);
    totals.costPeakUsd = round4(totals.costPeakUsd);
    totals.costOffPeakUsd = round4(totals.costOffPeakUsd);
    totals.costActualUsd = round4(totals.costActualUsd);
    totals.cacheSavingsCny = round4(totals.cacheSavingsCny);
  }

  const byModel = [];
  for (const model of models.values()) {
    const denom = model.inputTokens + model.cacheReadTokens;
    const costAvailable = model.callsSucceeded === 0 ? true : model.hasKnownCost;
    byModel.push({
      route: model.route,
      ...(model.label ? { label: model.label } : {}),
      ...(model.vendor ? { vendor: model.vendor } : {}),
      callsTotal: model.callsTotal,
      callsSucceeded: model.callsSucceeded,
      unmeteredCalls: model.unmeteredCalls,
      inputTokens: model.inputTokens,
      cacheReadTokens: model.cacheReadTokens,
      cacheWriteTokens: model.cacheWriteTokens,
      outputTokens: model.outputTokens,
      totalTokens: model.totalTokens,
      cacheHitRatePct: denom > 0 ? round2((model.cacheReadTokens / denom) * 100) : 0,
      shareOfTotalTokensPct:
        totals.totalTokens > 0 ? round2((model.totalTokens / totals.totalTokens) * 100) : 0,
      priced: model.priced,
      costPeakCny: costAvailable ? finalizeCost(model.costPeakCny) : null,
      costOffPeakCny: costAvailable ? finalizeCost(model.costOffPeakCny) : null,
      costActualCny: costAvailable ? finalizeCost(model.costActualCny) : null
    });
  }

  sessions.sort((a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0));
  const errors = Array.isArray(options.errors) ? options.errors : [];
  return { totals, byModel, sessions, errors };
}
