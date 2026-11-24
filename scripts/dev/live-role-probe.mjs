#!/usr/bin/env node
// Live contract probe for the four LeaderTeam model roles (gate allow/deny, discussA, discussB, arbiter) plus the
// plan-review canary (both reviewers must approve a plan faithful to the acceptance SPEC)
// through the official DSH headless runtime and the real Magpie routes from leaderteam.config.json.
//   node scripts/dev/live-role-probe.mjs --out <dir>              real Magpie (default http://127.0.0.1:3425/v1)
//   node scripts/dev/live-role-probe.mjs --out <dir> --selftest   scripted local model, no Magpie, checks the plumbing
// Env: LT_DSH_APP / lab variables (see scripts/dsh-runtime.mjs), LT_MAGPIE_BASEURL, LEADERTEAM_CONFIG.
// Exit 0 only when every probe passed. Result: <out>/role-probe.json and <out>/summary.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshRuntime } from '../dsh-runtime.mjs';
import { gptRoles, NO_GPT_HELP } from './lib/no-gpt.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fwd = p => p.replace(/\\/g, '/');
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const selftest = argv.includes('--selftest');
if (!opt('out')) { console.error('usage: --out <new dir> [--selftest] [--allow-gpt]'); process.exit(2); }
const out = path.resolve(opt('out'));
if (fs.existsSync(out)) { console.error(`output directory already exists: ${out}`); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const cfgFile = path.resolve(process.env.LEADERTEAM_CONFIG ?? path.join(ROOT, 'config', 'leaderteam.config.json'));
const cfg = loadConfig(cfgFile);
if (!selftest && !argv.includes('--allow-gpt')) {
  const gpt = gptRoles(cfg, ['gate', 'discussA', 'discussB', 'arbiter', 'leader']);
  if (gpt.length) { console.error(`refusing: ${gpt.map(g => `${g.role}=${g.route}`).join(', ')} use GPT. ${NO_GPT_HELP}`); process.exit(2); }
}
const home = path.join(out, 'home'), ws = path.join(out, 'workspace');
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(ws, { recursive: true });
const probeFile = path.join(out, 'role-probe.json');

let server, baseURL = process.env.LT_MAGPIE_BASEURL ?? 'http://127.0.0.1:3425/v1';
const seen = [];
if (selftest) {
  server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[]}'); return; }
    const p = JSON.parse(body);
    const sys = (p.messages ?? []).filter(m => m.role === 'system' || m.role === 'developer').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const text = JSON.stringify(p.messages ?? []);
    let reply;
    if (sys.includes('final safety gate')) reply = { content: JSON.stringify(text.includes('Remove-Item') ? { decision: 'deny', risk: 'high', reason: 'deletes user documents' } : { decision: 'allow', risk: 'low', reason: 'in scope' }) };
    else if (sys.includes('independent arbiter')) reply = { content: '{"adopt":"B"}' };
    else if (sys.includes('consensus panel')) reply = { content: JSON.stringify({ stance: 'approve', summary: 'fine', reasons: ['meets the goal'], required_changes: [] }) };
    else reply = text.includes('lt_role_probe') && (p.messages ?? []).some(m => m.role === 'tool') ? { content: 'DONE' } : { tool: 'lt_role_probe' };
    seen.push({ model: p.model, effort: p.reasoning_effort, maxTokens: p.max_completion_tokens ?? p.max_tokens, kind: reply.tool ? 'leader' : 'role' });
    const common = { id: `c${seen.length}`, object: 'chat.completion.chunk', created: 1, model: p.model };
    const delta = { role: 'assistant', ...(reply.tool ? { tool_calls: [{ index: 0, id: `call-${seen.length}`, type: 'function', function: { name: reply.tool, arguments: '{}' } }] } : { content: reply.content }) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${server.address().port}/v1`;
}

const sub = text => text.replaceAll('__LT_ROOT__', fwd(ROOT)).replaceAll('__LT_CONFIG__', fwd(cfgFile)).replaceAll('__MAGPIE_BASEURL__', baseURL)
  .replaceAll('__MAGPIE_KEY_ENV__', 'LEADERTEAM_MAGPIE_KEY').replaceAll('__LEADER_MODEL__', cfg.roles.leader.route).replaceAll('__LEADER_EFFORT__', cfg.roles.leader.effort);
const modelsPatch = path.join(out, 'magpie-models.mat.yml');
fs.writeFileSync(modelsPatch, sub(fs.readFileSync(path.join(ROOT, 'config', 'magpie-models.patch.yml'), 'utf8')));
const disabled = ['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-goal', 'tool-skill', 'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'workflow-ptc', 'ptc-runtime', 'tool-working-directory', 'tool-web', 'session-title-llm'];
const probePatch = path.join(out, 'role-probe.mat.yml');
fs.writeFileSync(probePatch, [
  '# Live role probe composition (generated). No LeaderTeam team runtime; the probe tool only.',
  '- id: tool-fs', '  config: {write: false, edit: false}',
  ...disabled.flatMap(id => [`- id: ${id}`, '  disabled: true']),
  '- insert:', '    - id: leaderteam-role-probe', `      name: "${fwd(ROOT)}/leaderteam/dev/role-probe.mjs"`, '      config:', `        configPath: "${fwd(cfgFile)}"`, `        outFile: "${fwd(probeFile)}"`, '',
].join('\n'));

const runtime = resolveDshRuntime();
const task = 'Call the tool lt_role_probe exactly once with no arguments. After it returns, reply with only the word DONE.';
const child = spawn(runtime.exe, [...runtime.cliArgs, 'headless', '--patch', modelsPatch, '--patch', probePatch, '--json', '-'], {
  cwd: ws, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LEADERTEAM_MAGPIE_KEY: process.env.LEADERTEAM_MAGPIE_KEY ?? 'magpie-local' },
});
let stdout = '', stderr = '';
child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
child.stdin.end(task);
const timer = setTimeout(() => child.kill(), 30 * 60000);
const code = await new Promise(r => child.on('close', r));
clearTimeout(timer);
server?.close();
fs.writeFileSync(path.join(out, 'events.jsonl'), stdout); fs.writeFileSync(path.join(out, 'stderr.log'), stderr);

const problems = [];
let probe = null;
try { probe = JSON.parse(fs.readFileSync(probeFile, 'utf8')); } catch { problems.push('role-probe.json was not written (the root agent did not call lt_role_probe, or the probe failed)'); }
if (code !== 0) problems.push(`DSH exited ${code}`);
if (probe) {
  const want = ['gate-allow', 'gate-deny', 'discussA', 'discussB', 'arbiter', 'plan-review-A', 'plan-review-B'];
  const roleOf = w => (w.startsWith('gate') ? 'gate' : w === 'plan-review-A' ? 'discussA' : w === 'plan-review-B' ? 'discussB' : w);
  for (const w of want) {
    const p = probe.probes.find(x => x.probe === w);
    if (!p) { problems.push(`${w}: missing`); continue; }
    const role = cfg.roles[roleOf(w)];
    if (p.route !== role.route || p.effort !== role.effort) problems.push(`${w}: ran ${p.route} ${p.effort}, configured ${role.route} ${role.effort}`);
    if (!p.pass) problems.push(`${w}: expected ${p.expect}; got ${p.ok ? JSON.stringify(p.value) : `${p.error?.kind} ${p.error?.code}: ${p.error?.message}`}`);
  }
}
const summary = { checkedAt: new Date().toISOString(), mode: selftest ? 'selftest' : 'live', baseURL, dshExit: code, pass: problems.length === 0, problems, probes: probe?.probes?.map(p => ({ probe: p.probe, route: p.route, effort: p.effort, maxTokens: p.maxTokens, pass: p.pass, attempts: p.attempts, wallMs: p.wallMs, usage: p.usage, value: p.value, error: p.error })) ?? [], ...(selftest ? { scriptedRequests: seen } : {}) };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ pass: summary.pass, problems, probes: summary.probes.map(p => `${p.probe} ${p.pass ? 'PASS' : 'FAIL'} ${p.route} ${p.effort} attempts=${p.attempts} ${p.wallMs}ms`) }, null, 1));
process.exitCode = summary.pass ? 0 : 1;
