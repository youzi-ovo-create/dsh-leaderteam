// Quota assessment over the user's existing quota tool output (state.json, schema_version 1). Pure except readQuotaStateFile.
import fs from 'node:fs';
import { routeProvider, routeModel } from './config.mjs';

/** Normalize state.json content. Unknown shapes degrade to empty lists, never throw. */
export function parseQuotaState(json) {
  const out = { schemaVersion: null, generatedAt: null, accounts: [], models: [] };
  if (!json || typeof json !== 'object') return out;
  out.schemaVersion = Number.isInteger(json.schema_version) ? json.schema_version : null;
  out.generatedAt = toDate(json.generated_at);
  for (const a of Array.isArray(json.accounts) ? json.accounts : []) {
    if (!a || typeof a.provider !== 'string') continue;
    const windows = [];
    for (const w of Array.isArray(a.windows) ? a.windows : []) {
      if (!w || typeof w.name !== 'string') continue;
      const rem = typeof w.remaining === 'number' && Number.isFinite(w.remaining) ? Math.max(0, Math.min(100, w.remaining)) : null;
      windows.push({ name: w.name, remainingPct: rem, resetsAt: toDate(w.resetsAt) });
    }
    out.accounts.push({ id: typeof a.id === 'string' ? a.id : '', provider: a.provider, windows });
  }
  for (const m of Array.isArray(json.models) ? json.models : []) {
    if (!m || typeof m.provider !== 'string' || typeof m.model !== 'string') continue;
    const byEffort = {};
    if (m.recent_by_effort && typeof m.recent_by_effort === 'object') for (const [eff, s] of Object.entries(m.recent_by_effort)) {
      if (!s || typeof s !== 'object') continue;
      byEffort[eff] = { count: num(s.record_count), p50Tokens: num(s.processed_tokens_p50), p90Tokens: num(s.processed_tokens_p90), p50DurationMs: num(s.duration_ms_p50) };
    }
    out.models.push({ provider: m.provider, model: m.model, recordedCalls: num(m.recorded_calls), byEffort });
  }
  return out;
}
function toDate(v) { if (typeof v !== 'string') return null; const t = Date.parse(v); return Number.isFinite(t) ? new Date(t) : null; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

export function readQuotaStateFile(file) {
  if (file === null || file === undefined || (typeof file === 'string' && file.trim() === '')) {
    return { ok: false, error: 'quota.stateFile is not configured' };
  }
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, state: parseQuotaState(JSON.parse(text)) };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Quota status for one route.
 * status: 'unknown' (no/old snapshot or no account), 'exhausted' (best < exhaustedBelowPct), 'low' (best < lowBelowPct), else 'ok'.
 * best = max over the provider's accounts of (min remainingPct over the considered windows of that account).
 */
export function routeQuota(state, route, modelCfg, quotaCfg, now) {
  const base = { route, status: 'unknown', bestRemainingPct: null, bestAccount: null, nextResetAt: null, snapshotAgeSec: null, reason: '' };
  if (!state || !state.generatedAt) return { ...base, reason: 'no quota snapshot' };
  const age = Math.round((now.getTime() - state.generatedAt.getTime()) / 1000);
  base.snapshotAgeSec = age;
  if (age > quotaCfg.maxSnapshotAgeSec) return { ...base, reason: `quota snapshot is ${age}s old (limit ${quotaCfg.maxSnapshotAgeSec}s)` };
  const provider = routeProvider(route);
  const accounts = state.accounts.filter(a => a.provider === provider);
  if (accounts.length === 0) return { ...base, reason: `no quota account for provider "${provider}"` };
  let best = null, bestAccount = null; const lowResets = [];
  for (const acc of accounts) {
    const considered = acc.windows.filter(w => !modelCfg?.quotaWindows || modelCfg.quotaWindows.includes(w.name));
    if (modelCfg?.family === 'gpt' && considered.some(w => w.remainingPct === null)) continue;
    const wins = acc.windows.filter(w => w.remainingPct !== null && (!modelCfg?.quotaWindows || modelCfg.quotaWindows.includes(w.name)));
    if (modelCfg?.quotaWindows && !modelCfg.quotaWindows.every(wn => wins.some(w => w.name === wn))) continue;
    if (modelCfg?.family === 'gpt' && !modelCfg?.quotaWindows) {
      const has5h = wins.some(w => w.name === '5 hours');
      const has7d = wins.some(w => w.name === '7 days');
      if (has5h !== has7d) continue;
    }
    if (wins.length === 0) continue;
    const min = Math.min(...wins.map(w => w.remainingPct));
    for (const w of wins) if (w.remainingPct < quotaCfg.lowBelowPct && w.resetsAt) lowResets.push(w.resetsAt.getTime());
    if (best === null || min > best) { best = min; bestAccount = acc.id; }
  }
  if (best === null) return { ...base, reason: `no usable quota windows for provider "${provider}"` };
  const exhaustedThreshold = modelCfg?.family === 'gpt'
    ? Math.max(quotaCfg.exhaustedBelowPct, quotaCfg.gptReservePct ?? 0)
    : quotaCfg.exhaustedBelowPct;
  const status = best < exhaustedThreshold ? 'exhausted' : best < quotaCfg.lowBelowPct ? 'low' : 'ok';
  const nextResetAt = status === 'ok' || lowResets.length === 0 ? null : new Date(Math.min(...lowResets)).toISOString();
  const reserveNote = status === 'exhausted' && modelCfg?.family === 'gpt' && exhaustedThreshold > quotaCfg.exhaustedBelowPct
    ? ` (GPT reserve requires >= ${exhaustedThreshold}%)`
    : '';
  return { ...base, status, bestRemainingPct: best, bestAccount, nextResetAt, reason: status === 'ok' ? '' : `best account has ${best}% left${reserveNote}` };
}

const FIVE_HOUR_WINDOW_NAME_RE = /^(?:5\s*(?:h|hr|hrs|hours?)|300\s*(?:m|min|mins|minutes?))$/i;

/**
 * Quota status strictly for the 5-hour request window of `route` (never conflating 7-day / weekly / monthly windows).
 */
export function routeQuota5hWindow(state, route, modelCfg, quotaCfg, now) {
  const base = { route, status: 'unknown', bestRemainingPct: null, bestAccount: null, nextResetAt: null, snapshotAgeSec: null, reason: '' };
  if (!state || !state.generatedAt) return { ...base, reason: 'no quota snapshot' };
  const age = Math.round((now.getTime() - state.generatedAt.getTime()) / 1000);
  base.snapshotAgeSec = age;
  if (age > quotaCfg.maxSnapshotAgeSec) return { ...base, reason: `quota snapshot is ${age}s old (limit ${quotaCfg.maxSnapshotAgeSec}s)` };
  const provider = routeProvider(route);
  const accounts = state.accounts.filter(a => a.provider === provider);
  if (accounts.length === 0) return { ...base, reason: `no quota account for provider "${provider}"` };
  let best = null;
  let bestAccount = null;
  const lowResets = [];
  for (const acc of accounts) {
    const wins5h = acc.windows.filter(w =>
      w.remainingPct !== null
      && FIVE_HOUR_WINDOW_NAME_RE.test(w.name.trim())
      && (!modelCfg?.quotaWindows || modelCfg.quotaWindows.includes(w.name)),
    );
    if (wins5h.length === 0) continue;
    const min5h = Math.min(...wins5h.map(w => w.remainingPct));
    for (const w of wins5h) {
      if (w.remainingPct < quotaCfg.lowBelowPct && w.resetsAt) lowResets.push(w.resetsAt.getTime());
    }
    if (best === null || min5h > best) {
      best = min5h;
      bestAccount = acc.id;
    }
  }
  if (best === null) return { ...base, reason: `no 5-hour quota window for provider "${provider}"` };
  const exhaustedThreshold = modelCfg?.family === 'gpt'
    ? Math.max(quotaCfg.exhaustedBelowPct, quotaCfg.gptReservePct ?? 0)
    : quotaCfg.exhaustedBelowPct;
  const status = best < exhaustedThreshold ? 'exhausted' : best < quotaCfg.lowBelowPct ? 'low' : 'ok';
  const nextResetAt = status === 'ok' || lowResets.length === 0 ? null : new Date(Math.min(...lowResets)).toISOString();
  return { ...base, status, bestRemainingPct: best, bestAccount, nextResetAt, reason: status === 'ok' ? '' : `best 5h window has ${best}% left` };
}

/** Recent per-effort usage samples for one route, or {} when absent. */
export function routeUsage(state, route) {
  const m = state?.models.find(x => x.provider === routeProvider(route) && x.model === routeModel(route));
  return m ? { recordedCalls: m.recordedCalls, byEffort: m.byEffort } : { recordedCalls: null, byEffort: {} };
}
