#!/usr/bin/env node
// Machine check of the production Desktop smoke after a LeaderTeam update. Read-only.
// Finds the newest LeaderTeam leader session created after --since in --home and checks, from its
// persisted session log: configured leader model, exact leader tool surface, a successful team_models
// call (leader model check "match", the whole execution pool) and quota rows equal to the quota tool's
// state.json (verdicts recomputed with the product's own quota code).
//   node scripts/dev/check-desktop-smoke.mjs --home <DSH_HOME> --since <ISO time> [--config <cfg>] [--out <json>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessions } from './lib/session-rows.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { readQuotaStateFile, routeQuota } from '../../leaderteam/core/quota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const a = process.argv.slice(2);
const opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
if (!opt('home') || !opt('since')) { console.error('usage: --home <DSH_HOME> --since <ISO time> [--config <cfg>] [--out <json>]'); process.exit(2); }
const since = Date.parse(opt('since'));
if (!Number.isFinite(since)) { console.error('--since must be an ISO time'); process.exit(2); }
const cfg = loadConfig(path.resolve(opt('config') ?? path.join(ROOT, 'config', 'leaderteam.config.json')));
const checks = [];
const check = (id, title, pass, detail, warn) => checks.push({ id, title, pass: Boolean(pass), ...(warn ? { warn } : {}), detail });

const leaders = readSessions(path.resolve(opt('home')))
  .filter(s => s.rows.some(r => r.type === 'agent-preset/selected' && r.data?.agentPreset === cfg.profiles.leader.preset) && (s.header?.createdAt ?? 0) >= since)
  .sort((x, y) => y.header.createdAt - x.header.createdAt);
const leader = leaders[0];
check('S1', 'a LeaderTeam leader session was created after --since', leader, leader ? { session: leader.id, createdAt: new Date(leader.header.createdAt).toISOString(), candidates: leaders.length } : 'none');
const headers = leader ? leader.rows.filter(r => r.type === 'request/header').map(r => r.data.header) : [];
check('S2', 'every leader request used the configured leader route (roles.leader)', headers.length && headers.every(h => h.config.provider === cfg.magpie.provider && h.config.model === cfg.roles.leader.route),
  headers.map(h => `${h.config.provider}/${h.config.model} (${h.config.reasoningEffort ?? 'default'})`));
const tools = [...new Set(headers.flatMap(h => (h.tools ?? []).map(t => t.name)))].sort();
const extra = tools.filter(t => !cfg.profiles.leader.tools.includes(t));
check('S3', 'the leader saw exactly its profile tools (masked globals absent, team tools present)', headers.length && extra.length === 0 && ['team_models', 'team_dispatch', 'team_discuss'].every(t => tools.includes(t)), { tools, extra });
const callRow = leader?.rows.find(r => r.type === 'tool/call' && r.data?.name === 'team_models');
const resultRow = callRow && leader.rows.find(r => r.type === 'tool/result' && r.data?.message?.toolCallId === callRow.data.callId);
let models = null;
try { models = resultRow && !resultRow.data.message.isError ? JSON.parse(resultRow.data.message.content.map(b => b.text ?? '').join('')) : null; } catch { models = null; }
check('S4', 'team_models succeeded: leader model "match" and the whole execution pool listed', models && models.leader_model?.status === 'match' && models.models?.length === cfg.team.executionPool.length,
  models ? { leader_model: models.leader_model, routes: models.models?.length, snapshotAgeSec: models.quota_snapshot_age_sec } : (resultRow ? 'team_models returned an error or non-JSON' : 'team_models not called'));
if (models) {
  const q = readQuotaStateFile(cfg.quota.stateFile);
  const callTime = callRow.time;
  const rows = cfg.team.executionPool.map(route => {
    const shown = models.models.find(m => m.route === route);
    const now = routeQuota(q.ok ? q.state : null, route, cfg.models[route], cfg.quota, new Date(Math.max(callTime, q.ok && q.state.generatedAt ? q.state.generatedAt.getTime() : callTime)));
    return { route, shown: shown?.quota ?? null, shownPct: shown?.best_remaining_pct ?? null, stateFile: now.status, stateFilePct: now.bestRemainingPct };
  });
  // Exact match when state.json is the snapshot the call saw; after a refresh, same verdict and at most
  // 10 percentage points of drift (the quota tool refreshes every minute).
  const changedSince = Boolean(q.ok && q.state.generatedAt && q.state.generatedAt.getTime() > callTime);
  const drift = r => (r.shownPct === null || r.stateFilePct === null) ? (r.shownPct === r.stateFilePct ? 0 : Infinity) : Math.abs(r.shownPct - r.stateFilePct);
  const bad = rows.filter(r => changedSince ? (r.shown !== r.stateFile || drift(r) > 10) : (r.shown !== r.stateFile || drift(r) !== 0));
  const fresh = typeof models.quota_snapshot_age_sec === 'number' && models.quota_snapshot_age_sec <= cfg.quota.maxSnapshotAgeSec;
  check('S5', 'quota rows match the quota tool state.json (same verdicts; exact, or <=10 points drift after a refresh)', q.ok && fresh && bad.length === 0,
    { stateFileRead: q.ok, fresh, snapshotChangedSinceCall: changedSince, bad, rows });
}
const report = { checkedAt: new Date().toISOString(), pass: checks.every(c => c.pass), checks };
if (opt('out')) fs.writeFileSync(path.resolve(opt('out')), JSON.stringify(report, null, 1));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id} ${c.title}${c.warn ? ` (WARN: ${c.warn})` : ''}${c.pass ? '' : `\n     ${JSON.stringify(c.detail)}`}`);
console.log(report.pass ? '\nDESKTOP SMOKE PASSED' : '\nDESKTOP SMOKE FAILED');
process.exitCode = report.pass ? 0 : 1;
