#!/usr/bin/env node
// LeaderTeam integration suite: real DSH headless runner + scripted model server.
// Usage: node test/integration/run.mjs [scenario-name ...]
// Windows: LT_DSH_APP=<runtime app directory> (default: official Desktop 0.2.2-rc.1)
// Lab:     LT_DSH_EXEC=node LT_DSH_EXEC_ARGS=--expose-internals LT_DSH_ENTRY=<harness-node-entry.mjs> LT_DSH_BIN=<dsh/lib/bin.js>
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { scriptedReview } from '../scripted-review.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify } from './lib.mjs';
import { resolveDshRuntime } from '../../scripts/dsh-runtime.mjs';
import { validateConfig } from '../../leaderteam/core/config.mjs';
import { renderMagpieModelRows, rewriteModelsBlock } from '../../leaderteam/core/model-config-writer.mjs';
import { parseUpstreamModelsPayload, enrichConfigModelsFromCatalog, canonicalRouteFor } from '../../leaderteam/core/upstream-models.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fwd = p => p.replace(/\\/g, '/');

function merge(a, b) { for (const [k, v] of Object.entries(b ?? {})) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v); else a[k] = v; } return a; }

async function runScenario(name, scenario) {
  const workDir = path.join(process.env.LT_WORK_DIR ?? path.join(ROOT, 'test-work'), `${name}-${Date.now()}`);
  const ws = path.join(workDir, 'ws'), home = path.join(workDir, 'home'), store = path.join(workDir, 'lt-store'), globalRefs = path.join(workDir, 'global-refs');
  for (const d of [ws, home, store, globalRefs]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(globalRefs, 'GLOBAL.md'), 'global reference\n');
  for (const [rel, text] of Object.entries(scenario.files ?? {})) { const f = path.join(ws, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  const quota = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/quota-state.json'), 'utf8'));
  quota.generated_at = new Date().toISOString();
  for (const acc of quota.accounts) for (const w of acc.windows) if (typeof w.remaining === 'number' && !(scenario.keepLowQuota)) w.remaining = Math.max(w.remaining, 50);
  if (scenario.quotaPatch) scenario.quotaPatch(quota);
  fs.writeFileSync(path.join(workDir, 'quota.json'), JSON.stringify(quota));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));
  merge(cfg, { storage: { root: store }, quota: { stateFile: path.join(workDir, 'quota.json') }, paths: { globalRefRoots: [globalRefs] } });
  merge(cfg, { planArchive: { root: path.join(os.tmpdir(), 'leaderteam-integration-plan-archives', path.basename(workDir)) } });
  // Preserve old protocol coverage; rolling / sandbox-direct / autonomous scenarios explicitly enable the new protocol.
  merge(cfg, { team: { rollingPlanning: false }, gate: { sandboxDirectAllow: false }, governance: { mode: 'approval' } });
  merge(cfg, scenario.config);
  const cfgFile = path.join(workDir, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1));

  const calls = [];
  const t = { name, workDir, ws, home, store, globalRefs, config: cfg, calls, runs: [], state: {} };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(scenario.modelsEndpoint ?? { object: 'list', data: [] })); return; }
    let payload; try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('bad'); return; }
    const c = classify(payload);
    c.index = calls.filter(x => x.kind === c.kind && x.who === c.who).length + 1;
    let reply;
    try { reply = await scenario.respond(c, t); } catch (e) { reply = { content: `SCENARIO_ERROR ${e.message}` }; }
    reply ??= { content: 'NO_SCRIPT' };
    if (c.kind === 'discuss' && reply.json) reply = { ...reply, json:scriptedReview(reply.json,c.request) };

    calls.push({ ...c, reply });
    if (reply.httpStatus) { res.writeHead(reply.httpStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'scripted failure' } })); return; }
    const common = { id: `chatcmpl-${calls.length}`, object: 'chat.completion.chunk', created: 1, model: payload.model };
    const adaptToolArgs = (toolName, rawArgs) => {
      if ((toolName === 'send_message' || toolName === 'interrupt_agent') && rawArgs && typeof rawArgs === 'object' && 'agent_id' in rawArgs && !('agent' in rawArgs)) {
        const smDef = (payload.tools ?? []).find(td => (td.function?.name ?? td.name) === toolName);
        const props = smDef?.function?.parameters?.properties ?? smDef?.parameters?.properties;
        if (props && 'agent' in props && !('agent_id' in props)) {
          const { agent_id, ...rest } = rawArgs;
          return { agent: agent_id, ...rest };
        }
      }
      return rawArgs ?? {};
    };
    const delta = { role: 'assistant' };
    if (reply.tools) delta.tool_calls = reply.tools.map((tool, index) => ({ index, id: `call-${calls.length}-${index}`, type: 'function', function: { name: tool.tool, arguments: JSON.stringify(adaptToolArgs(tool.tool, tool.args)) } }));
    else if (reply.tool) delta.tool_calls = [{ index: 0, id: `call-${calls.length}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(adaptToolArgs(reply.tool, reply.args)) } }];
    else delta.content = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.json);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? (reply.tool || reply.tools ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mat = (src, extra = {}) => {
    let text = fs.readFileSync(src, 'utf8').replaceAll('__LT_ROOT__', fwd(ROOT)).replaceAll('__LT_CONFIG__', fwd(cfgFile)).replaceAll('__MAGPIE_BASEURL__', `http://127.0.0.1:${port}/v1`).replaceAll('__MAGPIE_KEY_ENV__', 'LT_TEST_KEY')
      .replaceAll('__LEADER_MODEL__', cfg.roles?.leader?.route ?? '');
    text = cfg.roles?.leader?.effort === 'none'
      ? text.replace(/\r?\n[ \t]*reasoningEffort:\s*__LEADER_EFFORT__/, '')
      : text.replaceAll('__LEADER_EFFORT__', cfg.roles?.leader?.effort ?? 'high');
    if (path.basename(src) === 'magpie-models.patch.yml') {
      try {
        let modelCfg = validateConfig(cfg);
        if (scenario.modelsEndpoint) {
          const defaultProvider = modelCfg.magpie?.provider ?? 'magpie';
          const parsed = parseUpstreamModelsPayload(scenario.modelsEndpoint).map(m => ({
            route: canonicalRouteFor(defaultProvider, m.id, { defaultProvider, existingModels: modelCfg.models }) ?? m.id,
            provider: defaultProvider,
            upstreamModel: m.id,
            upstreamContextWindow: m.contextWindow ?? null,
            upstreamMaxTokens: m.maxTokens ?? null,
            contextWindow: m.contextWindow ?? null,
            maxTokens: m.maxTokens ?? null,
          }));
          modelCfg = enrichConfigModelsFromCatalog(modelCfg, { models: parsed });
        }
        text = rewriteModelsBlock(text, renderMagpieModelRows(modelCfg));
      } catch {}
    }
    for (const [k, v] of Object.entries(extra)) text = text.replaceAll(k, v);
    const out = path.join(workDir, path.basename(src).replace('.yml', '.mat.yml'));
    fs.writeFileSync(out, text); return out;
  };
  const patches = [mat(path.join(ROOT, 'config/magpie-models.patch.yml')), mat(path.join(ROOT, 'config/headless.patch.yml')), ...(scenario.extraPatches ?? []).map(p => mat(path.join(ROOT, p)))];
  const runtime = resolveDshRuntime();
  const runOnce = (task, sessionId) => new Promise(resolve => {
    const args = [...runtime.cliArgs, 'headless', ...patches.flatMap(p => ['--patch', p]), '--json', ...(sessionId ? ['--session-id', sessionId] : []), '-'];
    const nodeBinDir = path.dirname(process.execPath);
    const curPath = process.env.PATH ?? '';
    const childPath = curPath.split(path.delimiter).includes(nodeBinDir) ? curPath : `${nodeBinDir}${path.delimiter}${curPath}`;
    const child = spawn(runtime.exe, args, { cwd: ws, env: { ...process.env, PATH: childPath, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LT_TEST_KEY: 'local-test-key', LEADERTEAM_HEADLESS_LEADER: scenario.teamLeader === false ? '0' : '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
    child.stdin.end(task);
    const timer = setTimeout(() => child.kill(), (scenario.timeoutSec ?? 150) * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      const events = out.split(/\r?\n/).filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const run = { code, events, stderr: err, final: events.find(e => e.type === 'final'), sessionId: events.find(e => e.type === 'session')?.sessionId };
      t.runs.push(run); resolve(run);
    });
  });
  const started = Date.now();
  let result;
  try {
    for (const step of scenario.runs ?? [{ task: 'Run the LeaderTeam scripted scenario.' }]) {
      const prev = t.runs.at(-1);
      if (scenario.beforeRun) await scenario.beforeRun(t, { cfgFile, index: t.runs.length });
      await runOnce(step.task, step.resume ? prev?.sessionId : undefined);
    }
    await scenario.assert(t);
    result = { name, pass: true, ms: Date.now() - started };
  } catch (e) {
    result = { name, pass: false, ms: Date.now() - started, error: e.stack ?? String(e), stderrTail: t.runs.at(-1)?.stderr.split('\n').filter(l => !l.startsWith('[harness-node]')).slice(-25).join('\n') };
  } finally { await new Promise(r => server.close(r)); }
  fs.writeFileSync(path.join(workDir, 'result.json'), JSON.stringify({ ...result, calls: calls.map(({ payload, ...c }) => c), runs: t.runs.map(r => ({ code: r.code, final: r.final, events: r.events })) }, null, 1));
  return result;
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenarios');
const rawArgs = process.argv.slice(2);
const wanted = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--filter') {
    if (rawArgs[i + 1]) wanted.push(rawArgs[++i]);
  } else if (arg.startsWith('--filter=')) {
    const val = arg.slice('--filter='.length);
    if (val) wanted.push(val);
  } else if (!arg.startsWith('--')) {
    wanted.push(arg);
  }
}
const names = fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).map(f => f.slice(0, -4)).filter(n => wanted.length === 0 || wanted.some(w => n.startsWith(w))).sort();
let failed = 0, ran = 0;
for (const n of names) {
  const scenario = (await import(pathToFileURL(path.join(dir, `${n}.mjs`)).href)).default;
  // A scenario may declare the platforms it can run on (e.g. it needs the Windows pwsh tool); elsewhere it is skipped, not counted.
  if (Array.isArray(scenario.platforms) && !scenario.platforms.includes(process.platform)) { console.log(`SKIP ${n} (requires ${scenario.platforms.join('/')})`); continue; }
  ran++;
  const r = await runScenario(n, scenario);
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${n} (${r.ms} ms)${r.pass ? '' : `\n${r.error}\n--- stderr tail ---\n${r.stderrTail ?? ''}`}`);
}
console.log(`\n${ran - failed}/${ran} scenarios passed`);
process.exitCode = failed ? 1 : 0;
