#!/usr/bin/env node
// Real-product arbiter chain probe through DSH headless + real team_discuss.
// Exercises BOTH:
//   1. primary-normal: configured primary arbiter (zcode/GLM-5.3 max) receives both reviewers' opinions and rules once;
//      a valid ruling (whichever side it adopts) is final and never re-asked on fallback, and hard rules remain enforced.
//   2. primary-outage-fallback: injected transport 503 on the primary arbiter causes callRoleJson to switch to configured
//      fallback (codex/gpt-6.1-sol max), duplicate leader route is deduped, degraded_roles & usage.jsonl record
//      via="fallback" / degraded=true, and hard rules remain enforced.
//
// Usage:
//   node scripts/dev/live-arbiter-chain-probe.mjs --out <new dir> --selftest
//   node scripts/dev/live-arbiter-chain-probe.mjs --out <new dir> --allow-gpt
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshRuntime } from '../dsh-runtime.mjs';
import { loadConfig, loadRawConfig } from '../../leaderteam/core/config.mjs';
import { roleRouteChain } from '../../leaderteam/core/role-routes.mjs';
import { readQuotaStateFile, parseQuotaState } from '../../leaderteam/core/quota.mjs';
import { quotaGate } from '../../leaderteam/core/models.mjs';
import { gptRoles, NO_GPT_HELP } from './lib/no-gpt.mjs';
import { classify } from '../../test/integration/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fwd = p => p.replace(/\\/g, '/');
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const selftest = argv.includes('--selftest');
if (!opt('out')) {
  console.error('usage: --out <new dir> [--selftest] [--allow-gpt]');
  process.exit(2);
}
const out = path.resolve(opt('out'));
if (fs.existsSync(out)) {
  console.error(`output directory already exists: ${out}`);
  process.exit(2);
}

const cfgFile = path.resolve(process.env.LEADERTEAM_CONFIG ?? path.join(ROOT, 'config', 'leaderteam.config.json'));
const rawCfg = loadRawConfig(cfgFile);
const cfg = loadConfig(cfgFile);
const leaderSel = { provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort };
const expectedChain = roleRouteChain(cfg, 'arbiter', leaderSel);

if (!selftest && !argv.includes('--allow-gpt')) {
  const gpt = gptRoles(cfg, ['gate', 'discussA', 'discussB', 'arbiter', 'leader']);
  const arbiterGpt = (cfg.roles.arbiter.fallback ?? []).some(f => cfg.models?.[f.route]?.family === 'gpt');
  if (gpt.length || arbiterGpt) {
    console.error(`refusing: configured roles or arbiter fallback include GPT. ${NO_GPT_HELP}`);
    process.exit(2);
  }
}

function checkCodexReserve(stateFile) {
  if (!stateFile) return { ok: false, reason: 'quota.stateFile is not configured' };
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
  const parsed = parseQuotaState(raw);
  const codexAccounts = parsed.accounts.filter(a => a.provider === 'codex').map(a => {
    const w5h = a.windows.find(w => w.name === '5 hours')?.remainingPct ?? null;
    const w7d = a.windows.find(w => w.name === '7 days')?.remainingPct ?? null;
    return {
      id: a.id,
      plan: raw.accounts?.find(x => x.id === a.id)?.plan ?? null,
      fiveHoursRemainingPct: w5h,
      sevenDaysRemainingPct: w7d,
      bothWindowsAvailable: typeof w5h === 'number' && w5h > 0 && typeof w7d === 'number' && w7d > 0,
    };
  });
  const usable = codexAccounts.filter(a => a.bothWindowsAvailable);
  return {
    ok: usable.length > 0,
    generatedAt: raw.generated_at ?? null,
    codexAccounts,
    usableAccountIds: usable.map(a => a.id),
  };
}

let quotaPre = null;
if (!selftest) {
  quotaPre = checkCodexReserve(cfg.quota.stateFile);
  if (!quotaPre.ok) {
    console.error(`refusing live GPT fallback probe: no Codex account has both 5 hours and 7 days quota > 0 (${JSON.stringify(quotaPre)})`);
    process.exit(1);
  }
  const qr = readQuotaStateFile(cfg.quota.stateFile);
  if (!qr.ok) {
    console.error(`cannot read quota snapshot: ${qr.error}`);
    process.exit(1);
  }
  for (const step of expectedChain) {
    const qg = quotaGate(cfg, qr.state, step.route, new Date());
    if (!qg.allowed) {
      console.error(`route ${step.route} in arbiter chain is quota-blocked: ${qg.error}`);
      process.exit(1);
    }
  }
}

fs.mkdirSync(out, { recursive: true });

const baseURL = process.env.LT_MAGPIE_BASEURL ?? 'http://127.0.0.1:3425/v1';
const TOPIC = 'Plan: ISO date parsing helper with whitespace ambiguity check';
const PLAN = [
  'Member impl-date (zcode/GLM-5.3-Flash, high, code profile, write scope src/date_util.py and tests/test_date_util.py):',
  '1. Implement parse_date(text) returning datetime.date for ISO YYYY-MM-DD and raising ValueError otherwise.',
  '2. Add four unittest cases in tests/test_date_util.py (valid date, leap day rejection on non-leap year, invalid month, malformed string).',
  '3. Verify with python -m unittest discover -s tests.',
].join('\n');

function forwardToUpstream(reqHeaders, bodyText, targetBase) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${targetBase.replace(/\/+$/, '')}/chat/completions`);
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyText, 'utf8'),
    };
    if (reqHeaders.authorization) headers.authorization = reqHeaders.authorization;
    const up = http.request({
      hostname: u.hostname,
      port: Number(u.port || 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: cfg.roles.arbiter.timeoutMs,
    }, upRes => {
      const chunks = [];
      upRes.on('data', d => chunks.push(d));
      upRes.on('end', () => {
        resolve({ statusCode: upRes.statusCode ?? 502, headers: upRes.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    up.on('timeout', () => up.destroy(new Error('upstream proxy timeout')));
    up.on('error', reject);
    up.end(bodyText);
  });
}

function sendSseReply(res, model, reply) {
  const common = { id: `chatcmpl-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, object: 'chat.completion.chunk', created: 1, model };
  const delta = { role: 'assistant' };
  if (reply.tool) {
    delta.tool_calls = [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }];
  } else {
    delta.content = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.json);
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function lastToolJson(c) {
  const msgs = c.payload?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'tool') continue;
    const text = typeof msgs[i].content === 'string' ? msgs[i].content : (msgs[i].content ?? []).map(b => b.text ?? '').join('');
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  return null;
}

function jsonl(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
}

async function runCase({ caseName, injectPrimaryOutage }) {
  const caseDir = path.join(out, caseName);
  const ws = path.join(caseDir, 'workspace');
  const home = path.join(caseDir, 'home');
  const store = path.join(caseDir, 'lt-store');
  const globalRefs = path.join(caseDir, 'global-refs');
  for (const d of [ws, home, store, globalRefs]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(globalRefs, 'GLOBAL.md'), 'global reference\n');
  fs.writeFileSync(path.join(ws, 'spec.md'), 'Implement parse_date(text) -> datetime.date or raise ValueError.\n');

  const caseRawCfg = structuredClone(rawCfg);
  caseRawCfg.storage = { root: store };
  caseRawCfg.paths = { ...caseRawCfg.paths, globalRefRoots: [globalRefs] };
  const caseCfgFile = path.join(caseDir, 'leaderteam.config.json');
  fs.writeFileSync(caseCfgFile, JSON.stringify(caseRawCfg, null, 2));

  const trace = [];
  let leaderIndex = 0;
  let discussToolResult = null;
  let escapedNoteResult = null;

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"object":"list","data":[]}');
      return;
    }
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('bad'); return; }
    const c = classify(payload);
    if (c.kind === 'leader') {
      leaderIndex++;
      trace.push({ kind: 'leader', index: leaderIndex, model: c.model, effort: c.effort });
      if (leaderIndex === 1) {
        sendSseReply(res, payload.model, { tool: 'team_discuss', args: { kind: 'plan', topic: TOPIC, proposal: PLAN } });
        return;
      }
      if (leaderIndex === 2) {
        discussToolResult = lastToolJson(c);
        sendSseReply(res, payload.model, { tool: 'team_note', args: { path: '../../../outside-escape.md', content: 'escaped\n' } });
        return;
      }
      if (leaderIndex === 3) {
        escapedNoteResult = lastToolJson(c);
      }
      sendSseReply(res, payload.model, { content: `DONE ${caseName}` });
      return;
    }
    if (c.kind === 'discuss') {
      const round = c.request?.round;
      const who = c.who;
      trace.push({ kind: 'discuss', who, round, model: c.model, effort: c.effort });
      const reply = who === 'A'
        ? { stance: 'approve', summary: 'Complete and faithful to requirements; 4 unittests cover specified contract.', reasons: ['Spec leaves surrounding whitespace unspecified; implementer may follow fromisoformat strictness.'], required_changes: [] }
        : { stance: 'revise', summary: 'Clarify surrounding whitespace behavior and add a dedicated unittest.', reasons: ['Edge input with surrounding whitespace can diverge across Python strict/loose parsing choices.'], required_changes: ['Specify whether leading/trailing whitespace raises ValueError and add a fifth unittest case.'] };
      sendSseReply(res, payload.model, { json: reply });
      return;
    }
    if (c.kind === 'arbiter') {
      const started = Date.now();
      const attemptNo = trace.filter(x => x.kind === 'arbiter').length + 1;
      if (injectPrimaryOutage && payload.model === cfg.roles.arbiter.route) {
        trace.push({ kind: 'arbiter', attemptNo, model: c.model, effort: c.effort, injectedOutageHttpStatus: 503, upstreamCalled: false, wallMs: Date.now() - started });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'injected 503 outage for primary arbiter route' } }));
        return;
      }
      if (selftest) {
        const reply = { json: { adopt: injectPrimaryOutage ? 'A' : 'B' } };
        trace.push({ kind: 'arbiter', attemptNo, model: c.model, effort: c.effort, upstreamCalled: false, selftestAnswer: reply.json, wallMs: Date.now() - started });
        sendSseReply(res, payload.model, reply);
        return;
      }
      try {
        const up = await forwardToUpstream(req.headers, body, baseURL);
        trace.push({ kind: 'arbiter', attemptNo, model: c.model, effort: c.effort, upstreamCalled: true, upstreamHttpStatus: up.statusCode, wallMs: Date.now() - started });
        res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] ?? 'text/event-stream' });
        res.end(up.body);
      } catch (e) {
        trace.push({ kind: 'arbiter', attemptNo, model: c.model, effort: c.effort, upstreamCalled: true, proxyError: e.message, wallMs: Date.now() - started });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
      return;
    }
    trace.push({ kind: c.kind, model: c.model, effort: c.effort });
    sendSseReply(res, payload.model, { content: 'NOOP' });
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sub = text => text
    .replaceAll('__LT_ROOT__', fwd(ROOT))
    .replaceAll('__LT_CONFIG__', fwd(caseCfgFile))
    .replaceAll('__MAGPIE_BASEURL__', `http://127.0.0.1:${port}/v1`)
    .replaceAll('__MAGPIE_KEY_ENV__', 'LEADERTEAM_MAGPIE_KEY')
    .replaceAll('__LEADER_MODEL__', cfg.roles.leader.route)
    .replaceAll('__LEADER_EFFORT__', cfg.roles.leader.effort);
  const modelsPatch = path.join(caseDir, 'magpie-models.mat.yml');
  const headlessPatch = path.join(caseDir, 'headless.mat.yml');
  fs.writeFileSync(modelsPatch, sub(fs.readFileSync(path.join(ROOT, 'config', 'magpie-models.patch.yml'), 'utf8')));
  fs.writeFileSync(headlessPatch, sub(fs.readFileSync(path.join(ROOT, 'config', 'headless.patch.yml'), 'utf8')));

  const runtime = resolveDshRuntime();
  const child = spawn(runtime.exe, [...runtime.cliArgs, 'headless', '--patch', modelsPatch, '--patch', headlessPatch, '--json', '-'], {
    cwd: ws,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
      LEADERTEAM_MAGPIE_KEY: selftest ? 'selftest-key' : (process.env.LEADERTEAM_MAGPIE_KEY ?? 'magpie-local'),
      LEADERTEAM_HEADLESS_LEADER: '1',
    },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d);
  child.stderr.on('data', d => stderr += d);
  child.stdin.end('Submit the plan to team_discuss and verify post-ruling hard gate boundaries.');
  const timer = setTimeout(() => child.kill(), 20 * 60000);
  const code = await new Promise(r => child.on('close', r));
  clearTimeout(timer);
  await new Promise(r => server.close(r));

  fs.writeFileSync(path.join(caseDir, 'events.jsonl'), stdout);
  fs.writeFileSync(path.join(caseDir, 'stderr.log'), stderr);

  const teamsDir = path.join(store, 'teams');
  const teamIds = fs.existsSync(teamsDir) ? fs.readdirSync(teamsDir) : [];
  const teamPath = teamIds.length === 1 ? path.join(teamsDir, teamIds[0]) : null;
  const usageRows = teamPath ? jsonl(path.join(teamPath, 'usage.jsonl')) : [];
  const arbiterUsage = usageRows.filter(u => u.role === 'arbiter');
  const gateUsage = usageRows.filter(u => u.role === 'gate');
  const agreements = teamPath ? jsonl(path.join(teamPath, 'agreements.jsonl')) : [];
  const gateReceipts = teamPath ? jsonl(path.join(teamPath, 'gate.jsonl')) : [];
  const arbiterTraces = trace.filter(x => x.kind === 'arbiter');
  const escapedFileExists = fs.existsSync(path.join(caseDir, 'outside-escape.md'));

  const problems = [];
  const check = (fn, label) => { try { fn(); } catch (e) { problems.push(`${label}: ${e.message}`); } };
  check(() => assert.equal(code, 0), 'dshExit');
  check(() => assert.equal(teamIds.length, 1), 'teamCount');
  check(() => assert.equal(discussToolResult?.status, 'settled'), 'discuss.status');
  check(() => assert.equal(discussToolResult?.outcome?.by, 'arbiter'), 'discuss.outcome.by');
  check(() => assert.ok(['A', 'B'].includes(discussToolResult?.outcome?.adopted), 'discuss.outcome.adopted'), 'discuss.outcome.adopted');
  check(() => assert.equal(agreements.filter(e => e.type === 'ruling').length, 1), 'rulingEventCount');
  check(() => assert.equal(escapedFileExists, false), 'escapedFileExists');
  check(() => assert.ok(gateReceipts.some(r => r.tool === 'team_note' && r.decision === 'deny' && String(r.by).startsWith('rule:')), 'escaped team_note denied by hard rule'), 'gateHardRule');
  check(() => assert.equal(gateUsage.length, 0), 'zeroGateModelCallsForHardRuleAndNote');

  if (!injectPrimaryOutage) {
    check(() => assert.equal(discussToolResult?.degraded_roles, undefined), 'primary.noDegradedRoles');
    check(() => assert.equal(arbiterTraces.length, 1), 'primary.arbiterCalls');
    check(() => assert.equal(arbiterTraces[0]?.model, cfg.roles.arbiter.route), 'primary.route');
    check(() => assert.equal(arbiterTraces[0]?.effort, cfg.roles.arbiter.effort), 'primary.effort');
    check(() => assert.equal(arbiterUsage.length, 1), 'primary.usageLen');
    check(() => assert.equal(arbiterUsage[0]?.ok, true), 'primary.usageOk');
    check(() => assert.equal(arbiterUsage[0]?.degraded, undefined), 'primary.usageNotDegraded');
    check(() => assert.equal(arbiterUsage[0]?.via, undefined), 'primary.usageNoVia');
  } else {
    const fb = cfg.roles.arbiter.fallback?.[0];
    check(() => assert.ok(fb, 'arbiter fallback configured'), 'fallback.configured');
    check(() => assert.equal(discussToolResult?.degraded_roles?.length, 1), 'fallback.degradedRolesLen');
    check(() => assert.match(discussToolResult?.degraded_roles?.[0] ?? '', new RegExp(`^arbiter ran on a fallback route ${fb.route.replace('/', '\\/')} `)), 'fallback.degradedNote');
    const primaryAttempts = arbiterTraces.filter(a => a.model === cfg.roles.arbiter.route);
    const fbAttempts = arbiterTraces.filter(a => a.model === fb.route);
    check(() => assert.equal(primaryAttempts.length, 1 + cfg.roles.arbiter.retries), 'fallback.primaryExhaustedRetries');
    check(() => assert.equal(fbAttempts.length, 1), 'fallback.singleFallbackAttempt');
    check(() => assert.equal(fbAttempts[0]?.effort, fb.effort), 'fallback.effort');
    check(() => assert.equal(arbiterUsage.length, 2), 'fallback.usageRows');
    check(() => assert.deepEqual([arbiterUsage[0]?.route, arbiterUsage[0]?.ok], [cfg.roles.arbiter.route, false]), 'fallback.primaryFailedLedger');
    check(() => assert.deepEqual([arbiterUsage[1]?.route, arbiterUsage[1]?.effort, arbiterUsage[1]?.ok, arbiterUsage[1]?.degraded, arbiterUsage[1]?.via], [fb.route, fb.effort, true, true, 'fallback']), 'fallback.fallbackSuccessLedger');
  }

  return {
    caseName,
    injectPrimaryOutage,
    pass: problems.length === 0,
    problems,
    dshExit: code,
    arbiterTraces,
    discussOutcome: discussToolResult?.outcome ?? null,
    degradedRoles: discussToolResult?.degraded_roles ?? [],
    arbiterUsage,
    hardConstraintNoteDenied: gateReceipts.find(r => r.tool === 'team_note' && r.decision === 'deny') ?? null,
    escapedNoteToolOutput: escapedNoteResult,
    escapedFileExists,
    trace,
  };
}

const case1 = await runCase({ caseName: 'case-1-primary', injectPrimaryOutage: false });
const case2 = await runCase({ caseName: 'case-2-fallback', injectPrimaryOutage: true });
const quotaPost = selftest ? null : checkCodexReserve(cfg.quota.stateFile);

const summary = {
  checkedAt: new Date().toISOString(),
  mode: selftest ? 'selftest' : 'live',
  configPath: cfgFile,
  upstreamBaseURL: baseURL,
  configuredArbiterRole: cfg.roles.arbiter,
  dedupedArbiterRouteChain: expectedChain.map(x => ({ route: x.route, effort: x.effort, via: x.via, degraded: x.degraded })),
  quotaPre,
  quotaPost,
  pass: case1.pass && case2.pass && expectedChain.length === 2,
  cases: [case1, case2],
};

fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({
  mode: summary.mode,
  pass: summary.pass,
  chain: summary.dedupedArbiterRouteChain,
  quotaPreUsable: quotaPre?.usableAccountIds ?? null,
  quotaPostUsable: quotaPost?.usableAccountIds ?? null,
  cases: summary.cases.map(c => ({
    caseName: c.caseName,
    pass: c.pass,
    problems: c.problems,
    outcome: c.discussOutcome,
    degradedRoles: c.degradedRoles,
    arbiterUsage: c.arbiterUsage,
    hardDenyBy: c.hardConstraintNoteDenied?.by ?? null,
  })),
}, null, 2));
process.exitCode = summary.pass ? 0 : 1;
