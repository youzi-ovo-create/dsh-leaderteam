const READ_GRANT_LINE = /^[ \t]*(?:READ_GRANT|允许读取|allow[ \t]+read)[ \t]*[:：]?[ \t]*(\S.*?)[ \t]*$/i;
const BARE_CONTINUE = /^(?:请)?(?:继续|继续吧|继续做|继续执行|接着|接着做|接着来|continue|go on|carry on|proceed|resume)[\s。.!！~～]*$/i;
const CONCURRENCY_DIRECTIVE_LINE = /^[ \t]*(?:最大并发(?:数)?|最大子代理(?:数)?|max[ _-]?concurrent(?:[ _-]?members)?)[ \t]*[:：=]?[ \t]*(\d{1,3})[ \t]*$/i;

function isValidReadGrantLine(line) {
  if (typeof line !== 'string' || line.length > 1000) return false;
  const m = READ_GRANT_LINE.exec(line);
  if (!m) return false;
  const raw = m[1]
    .replace(/^["'`“”‘’「『]+/, '')
    .replace(/["'`“”‘’」』。；，、]+$/, '')
    .trim();
  if (!raw) return false;
  if (/^\/+$/.test(raw) || /^[A-Za-z]:[\\/]*$/.test(raw)) return false;
  return raw.startsWith('/') || raw === '~' || raw.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(raw);
}

function isReadGrantOnlyMessage(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => READ_GRANT_LINE.test(l));
}

function isBareContinueMessage(text) {
  return BARE_CONTINUE.test(String(text ?? '').trim());
}

function isControlOnlyUserMessage(text) {
  if (typeof text !== 'string') return false;
  const nonEmpty = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;
  for (const line of nonEmpty) {
    if (line.length <= 200 && CONCURRENCY_DIRECTIVE_LINE.test(line)) {
      const m = CONCURRENCY_DIRECTIVE_LINE.exec(line);
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n >= 1 && n <= 200) continue;
    }
    if (isValidReadGrantLine(line)) continue;
    return false;
  }
  return true;
}

function consumeMatchingModeBoundary(state, rowTime) {
  let matched = false;
  while (state.boundaryIdx < state.boundaries.length && state.boundaries[state.boundaryIdx].atMs <= rowTime) {
    const b = state.boundaries[state.boundaryIdx];
    state.boundaryIdx += 1;
    if (state.lastTaskStartMs !== null && b.atMs > state.lastTaskStartMs) {
      if (b.taskSeqHint === null || b.taskSeqHint >= state.currentTaskSeq) {
        matched = true;
      }
    }
  }
  return matched;
}

function shouldAdvanceTaskSeqOnUserMessage(row, state) {
  const src = row?.data?.source ?? row?.data?.message?.source ?? null;
  if (src && typeof src === 'object' && typeof src.kind === 'string' && src.kind !== 'user') {
    return false;
  }

  const contentArr = Array.isArray(row?.data?.content)
    ? row.data.content
    : (Array.isArray(row?.data?.message?.content) ? row.data.message.content : null);
  const directText = typeof row?.data?.text === 'string'
    ? row.data.text
    : (typeof row?.data?.message?.text === 'string' ? row.data.message.text : null);

  let text = null;
  if (typeof directText === 'string') {
    text = directText.trim();
  } else if (contentArr !== null) {
    text = contentArr
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }

  if (contentArr !== null) {
    const hasNonTextAttachment = contentArr.some(
      (b) => b && typeof b === 'object' && typeof b.type === 'string' && b.type !== 'text'
    );
    if (!text && !hasNonTextAttachment) {
      return false;
    }
  } else if (directText !== null && !text) {
    return false;
  }

  if (text) {
    if (isReadGrantOnlyMessage(text)) {
      return false;
    }
    if (state.currentTaskSeq >= 1 && !isBareContinueMessage(text) && isControlOnlyUserMessage(text)) {
      return false;
    }
    if (state.currentTaskSeq >= 1 && isBareContinueMessage(text) && Number.isFinite(row?.time)) {
      if (consumeMatchingModeBoundary(state, row.time)) {
        return true;
      }
      if (state.approvedDeliveryTimes instanceof Map) {
        const deliveredAt = state.approvedDeliveryTimes.get(state.currentTaskSeq) ?? [];
        if (!deliveredAt.some((t) => t <= row.time)) {
          return false;
        }
      }
    }
  }

  return true;
}

function hasMeteredUsage(usage) {
  return Boolean(
    usage &&
    typeof usage === 'object' &&
    (
      usage.inputTokens !== undefined ||
      usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.totalTokens !== undefined
    )
  );
}

export function extractReceipts(rows, options = {}) {
  let route = null;
  let inSeed = false;
  let pendingRequestTimeMs = null;
  const boundaries = Array.isArray(options?.modeBoundaries)
    ? options.modeBoundaries
        .filter((b) => b && Number.isFinite(Number(b.atMs)))
        .map((b) => ({
          atMs: Number(b.atMs),
          taskSeqHint: Number.isInteger(b.taskSeqHint) && b.taskSeqHint >= 1 ? b.taskSeqHint : null
        }))
        .sort((a, b) => a.atMs - b.atMs)
    : [];
  const taskState = {
    currentTaskSeq: 0,
    lastTaskStartMs: null,
    approvedDeliveryTimes: options?.approvedDeliveryTimes instanceof Map ? options.approvedDeliveryTimes : null,
    boundaries,
    boundaryIdx: 0
  };
  const seen = new Map();
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
      if (row?.type === 'user/message' && shouldAdvanceTaskSeqOnUserMessage(row, taskState)) {
        taskState.currentTaskSeq += 1;
        if (Number.isFinite(row?.time)) {
          taskState.lastTaskStartMs = row.time;
          while (
            taskState.boundaryIdx < taskState.boundaries.length &&
            taskState.boundaries[taskState.boundaryIdx].atMs <= row.time
          ) {
            const b = taskState.boundaries[taskState.boundaryIdx];
            if (taskState.currentTaskSeq > 1 && b.taskSeqHint !== null && b.taskSeqHint > taskState.currentTaskSeq) {
              taskState.currentTaskSeq = b.taskSeqHint;
            }
            taskState.boundaryIdx += 1;
          }
        }
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

    const sourceObj = row?.data?.message?.source ?? null;
    const replayResp = sourceObj?.replayState?.response ?? null;
    const key = row?.data?.message?.id ?? `${row?.type}:${row?.seq ?? row?.time}`;

    if (seen.has(key)) {
      const prevIdx = seen.get(key);
      const prev = receipts[prevIdx];
      // Streaming sessions may emit an initial partial assistant/message without usage
      // followed by the finalized message carrying usage for the same message.id.
      if (prev && !hasMeteredUsage(prev.usage) && hasMeteredUsage(row?.data?.usage)) {
        pendingRequestTimeMs = null;
        receipts[prevIdx] = {
          ...prev,
          timeMs: Number.isFinite(row?.time) ? row.time : prev.timeMs,
          route: rowRoute !== 'unknown' ? rowRoute : prev.route,
          usage: row.data.usage,
          seq: row?.seq ?? prev.seq,
          hostProvider: typeof sourceObj?.provider === 'string' ? sourceObj.provider : prev.hostProvider,
          responseId: typeof replayResp?.responseId === 'string' ? replayResp.responseId : prev.responseId,
          responseModel: typeof replayResp?.responseModel === 'string' ? replayResp.responseModel : prev.responseModel,
          latencyMs: latencyMs ?? prev.latencyMs,
        };
      } else {
        dupSkipped++;
      }
      continue;
    }

    pendingRequestTimeMs = null;
    seen.set(key, receipts.length);
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
      taskSeq: taskState.currentTaskSeq > 0 ? taskState.currentTaskSeq : null
    });
  }

  return { receipts, skippedSeed, dupSkipped };
}
