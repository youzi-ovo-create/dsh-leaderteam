#!/usr/bin/env node
// Run the official `dsh headless` runner with the LeaderTeam composition against real Magpie.
// node scripts/headless-run.mjs --workspace <dir> (--task-file <file> | --task "<text>") [--session <id>] [--timeout-min 120]
// Env: LT_DSH_APP, LT_DSH_EXEC, LT_DSH_HOME; default is the official Desktop runtime.
//      LT_DSH_HOME (default <repo>/home-headless), LT_MAGPIE_BASEURL (default http://127.0.0.1:3425/v1)
import { resolveDshRuntime } from './dsh-runtime.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../leaderteam/core/config.mjs';
import { renderMagpieModelRows, rewriteModelsBlock } from '../leaderteam/core/model-config-writer.mjs';
import { fetchEndpointModelsCatalog, enrichConfigModelsFromCatalog, canonicalRouteFor } from '../leaderteam/core/upstream-models.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = p => p.replace(/\\/g, '/');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.workspace || !(args['task-file'] || args.task)) { console.error('usage: --workspace <dir> (--task-file <file> | --task "<text>") [--session <id>]'); process.exit(2); }
const ws = path.resolve(args.workspace);
if (!fs.existsSync(ws)) { console.error(`workspace not found: ${ws}`); process.exit(2); }
const task = args.task ?? fs.readFileSync(args['task-file'], 'utf8');
const runtime = resolveDshRuntime();
const home = process.env.LT_DSH_HOME ?? path.join(ROOT, 'home-headless');
const runDir = path.join(ws, '.leaderteam', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true }); fs.mkdirSync(home, { recursive: true });
const cfgFile = path.resolve(process.env.LEADERTEAM_CONFIG ?? path.join(ROOT, 'config', 'leaderteam.config.json'));
let runnerConfig = loadConfig(cfgFile);
const magpieBaseUrl = process.env.LT_MAGPIE_BASEURL ?? 'http://127.0.0.1:3425/v1';
const magpieKey = process.env.LEADERTEAM_MAGPIE_KEY ?? 'magpie-local';
const upstreamProbe = await fetchEndpointModelsCatalog(magpieBaseUrl, { apiKey: magpieKey, timeoutMs: 3000 });
if (upstreamProbe.ok && upstreamProbe.models.length > 0) {
  const defaultProvider = runnerConfig.magpie?.provider ?? 'magpie';
  const catalogModels = upstreamProbe.models.map(m => ({
    route: canonicalRouteFor(defaultProvider, m.id, { defaultProvider, existingModels: runnerConfig.models }) ?? m.id,
    provider: defaultProvider,
    upstreamModel: m.id,
    upstreamContextWindow: m.contextWindow ?? null,
    upstreamMaxTokens: m.maxTokens ?? null,
    contextWindow: m.contextWindow ?? null,
    maxTokens: m.maxTokens ?? null,
  }));
  runnerConfig = enrichConfigModelsFromCatalog(runnerConfig, { models: catalogModels });
}
const leaderRole = runnerConfig.roles?.leader;
if (typeof leaderRole?.route !== 'string' || typeof leaderRole?.effort !== 'string') { console.error(`roles.leader.route/effort missing in ${cfgFile}`); process.exit(2); }
const mat = name => {
  let text = fs.readFileSync(path.join(ROOT, 'config', name), 'utf8').replaceAll('__LT_ROOT__', fwd(ROOT)).replaceAll('__LT_CONFIG__', fwd(cfgFile))
    .replaceAll('__MAGPIE_BASEURL__', magpieBaseUrl).replaceAll('__MAGPIE_KEY_ENV__', 'LEADERTEAM_MAGPIE_KEY')
    .replaceAll('__LEADER_MODEL__', leaderRole.route);
  text = leaderRole.effort === 'none'
    ? text.replace(/\r?\n[ \t]*reasoningEffort:\s*__LEADER_EFFORT__/, '')
    : text.replaceAll('__LEADER_EFFORT__', leaderRole.effort);
  if (name === 'magpie-models.patch.yml') text = rewriteModelsBlock(text, renderMagpieModelRows(runnerConfig));
  const out = path.join(runDir, name.replace('.yml', '.mat.yml')); fs.writeFileSync(out, text); return out;
};
const patches = [mat('magpie-models.patch.yml'), mat('headless.patch.yml'), ...(args['extra-patch'] ? [path.resolve(args['extra-patch'])] : [])];
const argv = [...runtime.cliArgs, 'headless', ...patches.flatMap(p => ['--patch', p]), '--json', ...(args.session ? ['--session-id', args.session] : []), '-'];
const child = spawn(runtime.exe, argv, { cwd: ws, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LEADERTEAM_HEADLESS_LEADER: '1', LEADERTEAM_MAGPIE_KEY: process.env.LEADERTEAM_MAGPIE_KEY ?? 'magpie-local' } });
const events = fs.createWriteStream(path.join(runDir, 'events.jsonl')); const errlog = fs.createWriteStream(path.join(runDir, 'stderr.log'));
let buf = '', final, sessionId;
child.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith('{')) continue;
    events.write(line + '\n');
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session') { sessionId = e.sessionId; console.log(`session ${sessionId}`); }
    else if (e.type === 'tool_call') console.log(`  > ${e.tool} ${JSON.stringify(e.input).slice(0, 160)}`);
    else if (e.type === 'tool_result' && e.status !== 'completed') console.log(`  ! ${String(e.result).slice(0, 240)}`);
    else if (e.type === 'final') final = e;
  }
});
child.stderr.on('data', d => errlog.write(d));
child.stdin.end(task);
const timer = setTimeout(() => {
  console.error('timeout: stopping DSH');
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); return; } catch {}
  }
  child.kill();
}, Number(args['timeout-min'] ?? 120) * 60000);
child.on('close', code => {
  clearTimeout(timer); events.end(); errlog.end();
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ code, sessionId, final }, null, 2));
  console.log(`\nexit ${code}; session ${sessionId ?? '-'}; run dir ${runDir}`);
  if (final?.text) console.log(`\n${final.text}`);
  process.exitCode = code ?? 1;
});
