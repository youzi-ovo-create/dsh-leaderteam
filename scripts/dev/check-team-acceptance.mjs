#!/usr/bin/env node
// Machine check of one real LeaderTeam run against an acceptance spec. Read-only except --out.
// Every verdict comes from persisted records (DSH session logs, team store, workspace files) and an
// independent re-run of the module tests; nothing is taken from the models' own claims.
//   node scripts/dev/check-team-acceptance.mjs --home <DSH_HOME> --workspace <ws> --leader-session <id>
//     --exit-code <n> --final-file <file> --acceptance <json> --task-file <file> [--config <cfg>]
//     --pre-manifest <json {files:{rel:sha256}} taken before the run> [--storage <team storage root>]
//     [--python <exe>] [--out <report.json>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSessions, teamStore, shellTestRuns, workspaceManifest } from './lib/session-rows.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { replay } from '../../leaderteam/core/agreement.mjs';
import { globToRegExp } from '../../leaderteam/core/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const a = process.argv.slice(2);
const opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
for (const req of ['home', 'workspace', 'leader-session', 'exit-code', 'final-file', 'acceptance', 'task-file', 'pre-manifest']) if (opt(req) === undefined) { console.error(`missing --${req}`); process.exit(2); }
const home = path.resolve(opt('home')), ws = path.resolve(opt('workspace')), leaderId = opt('leader-session');
const cfg = loadConfig(path.resolve(opt('config') ?? path.join(ROOT, 'config', 'leaderteam.config.json')));
const storage = path.resolve(opt('storage') ?? cfg.storage.root ?? path.join(home, 'leaderteam'));
const acc = JSON.parse(fs.readFileSync(opt('acceptance'), 'utf8'));
const task = fs.readFileSync(opt('task-file'), 'utf8');
const finalText = fs.readFileSync(opt('final-file'), 'utf8');
const exitCode = Number(opt('exit-code'));
const python = opt('python') ?? 'python';

const checks = [];
const check = (id, title, pass, detail) => { checks.push({ id, title, pass: Boolean(pass), detail }); };
const safe = (id, title, fn) => { try { const r = fn(); check(id, title, r.pass, r.detail); } catch (e) { check(id, title, false, `check error: ${e.message}`); } };

const sessions = readSessions(home);
const leader = sessions.find(s => s.id === leaderId);
const memberSessions = sessions.filter(s => s.header?.parentSession === leaderId);
const team = teamStore(storage, leaderId);
const members = team.members.filter(r => r.type === 'member');
const headersOf = s => (s?.rows ?? []).filter(r => r.type === 'request/header').map(r => r.data.header);
const headerOf = s => headersOf(s)[0];
const toolsOf = s => [...new Set(headersOf(s).flatMap(h => (h.tools ?? []).map(t => t.name)))].sort();
const calls = s => s.rows.filter(r => r.type === 'tool/call').map(r => ({ time: r.time, callId: r.data.callId, name: r.data.name, args: safeJson(r.data.arguments) }));
function safeJson(x) { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return x; } }
const agreements = new Map();
for (const ev of team.agreements) { if (!agreements.has(ev.id)) agreements.set(ev.id, []); agreements.get(ev.id).push(ev); }
const agrState = id => { const evs = agreements.get(id); if (!evs) return null; return { state: replay(evs.map(({ v, at, ...e }) => e)), lastAt: evs.at(-1).at }; };

safe('C01', 'run exited 0 and the final answer claims an approved delivery', () => {
  const m = finalText.match(/^\s*DELIVERY: approved \((agr-[0-9a-f]{8})\)/);
  return { pass: exitCode === 0 && m, detail: { exitCode, claimedAgreement: m?.[1] ?? null, finalHead: finalText.slice(0, 120) } };
});
const claimed = finalText.match(/^\s*DELIVERY: approved \((agr-[0-9a-f]{8})\)/)?.[1];
safe('C02', 'the claimed delivery agreement exists and is settled approve', () => {
  const s = claimed && agrState(claimed);
  return { pass: s && s.state.kind === 'delivery' && s.state.status === 'settled' && s.state.outcome.decision === 'approve', detail: s ? { kind: s.state.kind, status: s.state.status, outcome: s.state.outcome } : 'not found' };
});
const writing = members.filter(m => cfg.profiles[m.profile]?.mutating);
const firstWriteDispatch = writing.map(m => Date.parse(m.at)).sort((x, y) => x - y)[0];
safe('C03', 'an approved plan agreement settled before the first writing member was dispatched', () => {
  const plans = [...agreements.keys()].map(id => ({ id, s: agrState(id) })).filter(x => x.s.state.kind === 'plan' && x.s.state.status === 'settled' && x.s.state.outcome.decision === 'approve');
  const before = plans.filter(p => Date.parse(p.s.lastAt) <= firstWriteDispatch);
  return { pass: before.length > 0, detail: { approvedPlans: plans.map(p => ({ id: p.id, settledAt: p.s.lastAt })), firstWritingDispatch: firstWriteDispatch ? new Date(firstWriteDispatch).toISOString() : null } };
});
safe('C04', 'every leader request used the configured leader route (roles.leader)', () => {
  const hs = headersOf(leader).map(h => h.config);
  return { pass: hs.length > 0 && hs.every(h => h.provider === cfg.magpie.provider && h.model === cfg.roles.leader.route && h.reasoningEffort === cfg.roles.leader.effort), detail: { actual: hs.map(h => `${h.provider}/${h.model} (${h.reasoningEffort ?? 'default'})`), configured: `${cfg.magpie.provider}/${cfg.roles.leader.route} (${cfg.roles.leader.effort})` } };
});
safe('C05', 'leader and members saw only task-authorized tools; deferred schemas absent initially', () => {
  const extra = [];
  const lt = toolsOf(leader).filter(t => !cfg.profiles.leader.tools.includes(t)); if (lt.length) extra.push({ who: 'leader', extra: lt });
  for (const s of memberSessions) {
    const m = members.find(x => x.childId === s.id);
    const allowed = m?.allowedTools ?? [];
    const x = toolsOf(s).filter(t => !allowed.includes(t));
    const first = (headerOf(s)?.tools ?? []).map(t => t.name);
    const initialExtra = first.filter(t => !(m?.loadedTools ?? []).includes(t));
    if (x.length || initialExtra.length || !m || !Array.isArray(m.allowedTools)) extra.push({ who: m?.name ?? s.id, extra: x, initialExtra, missingTaskGrant: !Array.isArray(m?.allowedTools) });
  }
  return { pass: extra.length === 0, detail: extra.length ? extra : 'exact' };
});
const leaderCalls = leader ? calls(leader) : [];
safe('C06', 'team_models was called before the first team_dispatch', () => {
  const tm = leaderCalls.findIndex(c => c.name === 'team_models'), td = leaderCalls.findIndex(c => c.name === 'team_dispatch');
  return { pass: tm >= 0 && td >= 0 && tm < td, detail: { order: leaderCalls.map(c => c.name) } };
});
safe('C07', 'the task did not prescribe execution models (the leader chose them)', () => {
  const named = cfg.team.executionPool.flatMap(r => [r, r.split('/')[1], cfg.models[r].label]).filter(n => task.toLowerCase().includes(n.toLowerCase()));
  return { pass: named.length === 0, detail: named.length ? { namedInTask: named } : 'no model named' };
});
safe('C08', 'writing members: pool model, supported effort, quota not exhausted, no substitution', () => {
  const rows = writing.map(m => { const s = memberSessions.find(x => x.id === m.childId); const hs = headersOf(s).map(h => h.config); return { name: m.name, model: m.model, effort: m.effort, profile: m.profile, quota: m.quotaAtDispatch, ran: hs.map(h => `${h.model} (${h.reasoningEffort})`), ok: cfg.team.executionPool.includes(m.model) && cfg.models[m.model].efforts.includes(m.effort) && m.quotaAtDispatch !== 'exhausted' && hs.length > 0 && hs.every(h => h.provider === cfg.magpie.provider && h.model === m.model && h.reasoningEffort === m.effort) }; });
  return { pass: rows.length >= acc.minWritingMembers && rows.every(r => r.ok), detail: rows };
});
const interval = s => { const t = s.rows.filter(r => ['step/start', 'tool/call', 'tool/result', 'turn/end'].includes(r.type)).map(r => r.time); return t.length ? [Math.min(...t), Math.max(...t)] : null; };
safe('C09', 'at least two writing members were active at the same time', () => {
  const iv = writing.map(m => ({ name: m.name, iv: interval(memberSessions.find(x => x.id === m.childId) ?? { rows: [] }) })).filter(x => x.iv);
  let overlap = null;
  for (let i = 0; i < iv.length; i++) for (let j = i + 1; j < iv.length; j++) { const o = Math.min(iv[i].iv[1], iv[j].iv[1]) - Math.max(iv[i].iv[0], iv[j].iv[0]); if (o > 0 && (!overlap || o > overlap.ms)) overlap = { a: iv[i].name, b: iv[j].name, ms: o }; }
  return { pass: !acc.requireParallel || overlap !== null, detail: { intervals: iv.map(x => ({ name: x.name, from: new Date(x.iv[0]).toISOString(), to: new Date(x.iv[1]).toISOString() })), overlap } };
});
safe('C10', 'every controlled member operation has a gate receipt; no gate errors; reviews use the configured route and effort', () => {
  // Calls the pipeline rejected before dispatch never reach the gate: unknown or masked tools, or a
  // cancellation before dispatch. Those are listed, not counted as missing reviews.
  const missing = [], notDispatched = [];
  const NOT_DISPATCHED = new Set(['UNKNOWN_TOOL', 'ABORTED_BEFORE_DISPATCH']);
  for (const s of memberSessions) {
    const errorOf = new Map(s.rows.filter(r => r.type === 'tool/result').map(r => [r.data?.message?.toolCallId, r.data?.error?.code]));
    for (const c of calls(s)) {
      if (cfg.gate.uncontrolledTools.includes(c.name)) continue;
      if (team.gate.some(g => g.callId === c.callId && g.tool === c.name)) continue;
      if (NOT_DISPATCHED.has(errorOf.get(c.callId))) notDispatched.push({ member: s.id, tool: c.name, code: errorOf.get(c.callId) });
      else missing.push({ member: s.id, tool: c.name, callId: c.callId });
    }
  }
  const errors = team.gate.filter(g => g.by === 'gate-error');
  const wrongModel = team.gate.filter(g => ['model', 'gpt'].includes(g.by) && (g.model !== cfg.roles.gate.route || (g.by === 'model' && g.effort !== cfg.roles.gate.effort)));
  return { pass: missing.length === 0 && errors.length === 0 && wrongModel.length === 0 && team.gate.some(g => ['model', 'gpt'].includes(g.by)), detail: { receipts: team.gate.length, byModel: team.gate.filter(g => ['model', 'gpt'].includes(g.by)).length, denied: team.gate.filter(g => g.decision !== 'allow').map(g => ({ tool: g.tool, member: g.member, by: g.by, reason: g.reason })), missing, notDispatched, errors: errors.length, wrongModel: wrongModel.length } };
});
safe('C11', 'each module was tested by a member through the shell, with a completed zero-exit job', () => {
  if (acc.requireShellTestRun === false) return { pass: true, detail: 'not required by this acceptance spec' };
  const rows = acc.modules.map(mod => shellTestRuns(memberSessions, members, mod));
  return { pass: rows.every(r => r.ok), detail: rows };
});
safe('C12', 'independent re-run: every module test suite passes with the expected number of tests', () => {
  const rows = acc.modules.map(mod => {
    const missing = mod.files.filter(f => !fs.existsSync(path.join(ws, f)));
    if (missing.length) return { module: mod.dir, ok: false, missing };
    const r = spawnSync(python, mod.testArgs, { cwd: ws, encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const outText = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const ran = Number(outText.match(new RegExp(mod.countRegex ?? 'Ran (\\d+) tests?'))?.[1] ?? -1);
    return { module: mod.dir, ok: r.status === 0 && new RegExp(mod.okRegex ?? '\\nOK\\b').test(outText) && ran === mod.expectTests, exit: r.status, ran, expect: mod.expectTests, tail: outText.trim().split('\n').slice(-3).join(' | ') };
  });
  return { pass: rows.every(r => r.ok), detail: rows };
});
safe('C13', 'files outside the allowed paths are byte-identical to the pre-run manifest; nothing else was created', () => {
  const before = JSON.parse(fs.readFileSync(opt('pre-manifest'), 'utf8')).files;
  const after = workspaceManifest(ws);
  const allowed = acc.allowedChanges.map(g => globToRegExp(g, process.platform));
  const inAllowed = f => allowed.some(re => re.test(f));
  const changed = Object.keys(before).filter(f => !inAllowed(f) && after[f] !== before[f]);
  const created = Object.keys(after).filter(f => !(f in before) && !inAllowed(f));
  return { pass: changed.length === 0 && created.length === 0, detail: { changedOrDeleted: changed, createdOutsideAllowed: created, filesBefore: Object.keys(before).length, filesAfter: Object.keys(after).length } };
});

const report = { checkedAt: new Date().toISOString(), leaderSession: leaderId, workspace: ws, pass: checks.every(c => c.pass), checks };
if (opt('out')) fs.writeFileSync(path.resolve(opt('out')), JSON.stringify(report, null, 1));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id} ${c.title}${c.pass ? '' : `\n     ${JSON.stringify(c.detail)}`}`);
console.log(report.pass ? `\nACCEPTANCE PASSED (${checks.length}/${checks.length})` : `\nACCEPTANCE FAILED (${checks.filter(c => c.pass).length}/${checks.length})`);
process.exitCode = report.pass ? 0 : 1;
