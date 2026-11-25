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
  const models = new Map();
  const sessions = [];

  for (const report of reports ?? []) {
    const t = report?.totals ?? {};
    totals.callsTotal += t.callsTotal ?? 0;
    totals.callsSucceeded += t.callsSucceeded ?? 0;
    totals.unmeteredCalls += t.unmeteredCalls ?? 0;
    for (const field of TOKEN_FIELDS) totals[field] += t[field] ?? 0;
    totals.unpricedCalls += t.unpricedCalls ?? 0;
    addCost(totals.costPeakCny, t.costPeakCny);
    addCost(totals.costOffPeakCny, t.costOffPeakCny ?? t.costActualCny);
    addCost(totals.costActualCny, t.costActualCny);
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
      for (const field of TOKEN_FIELDS) model[field] += item[field] ?? 0;
      addCost(model.costPeakCny, item.costPeakCny);
      addCost(model.costOffPeakCny, item.costOffPeakCny ?? item.costActualCny);
      addCost(model.costActualCny, item.costActualCny);
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
      callsSucceeded: t.callsSucceeded ?? 0,
      unmeteredCalls: t.unmeteredCalls ?? 0,
      inputTokens: t.inputTokens ?? 0,
      cacheReadTokens: t.cacheReadTokens ?? 0,
      cacheWriteTokens: t.cacheWriteTokens ?? 0,
      outputTokens: t.outputTokens ?? 0,
      totalTokens: t.totalTokens ?? 0,
      unpricedCalls: t.unpricedCalls ?? 0,
      costPeakCny: round4(t.costPeakCny?.total ?? 0),
      costOffPeakCny: round4((t.costOffPeakCny ?? t.costActualCny)?.total ?? 0),
      costActualCny: round4(t.costActualCny?.total ?? 0)
    });
  }

  const tokenDenom = totals.inputTokens + totals.cacheReadTokens;
  totals.cacheHitRatePct = tokenDenom > 0 ? round2((totals.cacheReadTokens / tokenDenom) * 100) : 0;
  totals.costPeakCny = finalizeCost(totals.costPeakCny);
  totals.costOffPeakCny = finalizeCost(totals.costOffPeakCny);
  totals.costActualCny = finalizeCost(totals.costActualCny);
  totals.costPeakUsd = round4(totals.costPeakUsd);
  totals.costOffPeakUsd = round4(totals.costOffPeakUsd);
  totals.costActualUsd = round4(totals.costActualUsd);
  totals.cacheSavingsCny = round4(totals.cacheSavingsCny);

  const byModel = [];
  for (const model of models.values()) {
    const denom = model.inputTokens + model.cacheReadTokens;
    const costAvailable = model.priced || model.callsSucceeded === 0;
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
