export function extractReceipts(rows) {
  let route = null;
  let inSeed = false;
  let pendingRequestTimeMs = null;
  let currentTaskSeq = 0;
  const seen = new Set();
  const receipts = [];
  let skippedSeed = 0;
  let dupSkipped = 0;

  for (const row of rows ?? []) {
    if (row?.type === 'session/seed') {
      inSeed = true;
      continue;
    }
    if (row?.type === 'session/end-seed') {
      inSeed = false;
      continue;
    }
    if (!inSeed && row?.surfaceOp !== 'seed') {
      if (row?.type === 'user/message') {
        currentTaskSeq += 1;
      }
      if (row?.type === 'request/header' && Number.isFinite(row?.time)) {
        pendingRequestTimeMs = row.time;
      }
    }
    route =
      row?.data?.header?.config?.model ??
      (row?.type === 'model/selection' ? row?.data?.model : null) ??
      route;
    const native =
      row?.data?.usage ||
      (row?.type === 'assistant/message' && row?.data?.message?.source?.model);
    if (!native) continue;
    if (row.surfaceOp === 'seed' || inSeed) {
      skippedSeed++;
      continue;
    }
    const key = row?.data?.message?.id ?? `${row?.type}:${row?.seq ?? row?.time}`;
    if (seen.has(key)) {
      dupSkipped++;
      continue;
    }
    seen.add(key);
    // compaction/summary 等事件将实际执行压缩的模型写在顶层 row.data.model，需优先于会话默认 route 读取。
    const rowRoute =
      row?.data?.message?.source?.model ??
      (typeof row?.data?.model === 'string' && row.data.model.trim() ? row.data.model.trim() : null) ??
      route ??
      'unknown';

    let latencyMs = Number.isFinite(row?.data?.latencyMs) && row.data.latencyMs >= 0
      ? Math.round(row.data.latencyMs)
      : null;
    if (latencyMs === null && pendingRequestTimeMs !== null && Number.isFinite(row?.time)) {
      const delta = row.time - pendingRequestTimeMs;
      if (delta >= 0 && delta <= 3_600_000) {
        latencyMs = Math.round(delta);
      }
    }
    pendingRequestTimeMs = null;

    const sourceObj = row?.data?.message?.source ?? null;
    const replayResp = sourceObj?.replayState?.response ?? null;
    receipts.push({
      timeMs: row?.time,
      route: rowRoute,
      usage: row?.data?.usage ?? null,
      ok: true,
      type: row?.type,
      seq: row?.seq,
      messageId: typeof row?.data?.message?.id === 'string' ? row.data.message.id : null,
      hostProvider: typeof sourceObj?.provider === 'string' ? sourceObj.provider : null,
      responseId: typeof replayResp?.responseId === 'string' ? replayResp.responseId : null,
      responseModel: typeof replayResp?.responseModel === 'string' ? replayResp.responseModel : null,
      latencyMs,
      taskSeq: currentTaskSeq > 0 ? currentTaskSeq : null
    });
  }

  return { receipts, skippedSeed, dupSkipped };
}
