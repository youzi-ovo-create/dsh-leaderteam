#!/usr/bin/env node
// One-command real-model acceptance of the LeaderTeam core design (autonomous model choice, two parallel
// writing members, gate on every controlled operation, plan and delivery agreements), judged only by
// scripts/dev/check-team-acceptance.mjs from persisted records plus an independent test re-run.
//   node scripts/dev/run-live-acceptance.mjs --workspace <ACL-prepared dir> --out <new dir> [--python <exe>] [--timeout-min 60]
// The workspace must already allow DSH's Windows sandbox (see docs/官方Desktop部署与恢复.md); it must not
// contain LT-E2E-SPEC.md, textstats/ or money/. Uses real Magpie (LT_MAGPIE_BASEURL, default local).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workspaceManifest } from './lib/session-rows.mjs';
import { gptRoles, withoutGptPool, NO_GPT_HELP } from './lib/no-gpt.mjs';
import { loadConfig, loadRawConfig } from '../../leaderteam/core/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'test', 'live', 'e2e-parallel');
const a = process.argv.slice(2);
const opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
if (!opt('workspace') || !opt('out')) { console.error('usage: --workspace <dir> --out <new dir> [--python <exe>] [--timeout-min 60] [--allow-gpt]'); process.exit(2); }
const allowGpt = a.includes('--allow-gpt');
const ws = path.resolve(opt('workspace')), out = path.resolve(opt('out'));
const localAppPy = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe') : '';
const python = opt('python') ?? process.env.LT_PYTHON ?? (localAppPy && fs.existsSync(localAppPy) ? localAppPy : 'python');
const fail = m => { console.error(m); process.exit(2); };
if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) fail(`workspace not found: ${ws}`);
for (const x of ['LT-E2E-SPEC.md', 'textstats', 'money']) if (fs.existsSync(path.join(ws, x))) fail(`workspace already contains ${x}: move it away first (a fresh acceptance needs a clean slate)`);
if (fs.existsSync(out)) fail(`output directory already exists: ${out}`);
const py = spawnSync(python, ['--version'], { encoding: 'utf8' });
if (py.status !== 0) fail(`python not runnable: ${python}`);
const baseCfgFile = path.resolve(process.env.LEADERTEAM_CONFIG ?? path.join(ROOT, 'config', 'leaderteam.config.json'));
loadConfig(baseCfgFile);
const baseCfg = loadRawConfig(baseCfgFile);
if (!allowGpt) { const gpt = gptRoles(baseCfg); if (gpt.length) fail(`refusing: ${gpt.map(g => `${g.role}=${g.route}`).join(', ')} use GPT. ${NO_GPT_HELP}`); }
fs.mkdirSync(out, { recursive: true });
// Without --allow-gpt the leader chooses execution models from a pool that has no GPT route.
let cfgFile = baseCfgFile;
if (!allowGpt) { cfgFile = path.join(out, 'leaderteam.test.config.json'); fs.writeFileSync(cfgFile, JSON.stringify(withoutGptPool(baseCfg), null, 1)); }
const home = path.join(out, 'home');
fs.writeFileSync(path.join(ws, 'LT-E2E-SPEC.md'), fs.readFileSync(path.join(FIX, 'LT-E2E-SPEC.md'), 'utf8').replaceAll('__PYTHON__', python.replace(/\\/g, '/')));
const taskFile = path.join(out, 'task.md');
fs.copyFileSync(path.join(FIX, 'task.md'), taskFile);
const preFile = path.join(out, 'pre-manifest.json');
fs.writeFileSync(preFile, JSON.stringify({ takenAt: new Date().toISOString(), files: workspaceManifest(ws) }, null, 1));
const runsDir = path.join(ws, '.leaderteam', 'runs');
const runsBefore = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []);
console.log(`acceptance: workspace ${ws}\n            home ${home}\n            python ${python} (${(py.stdout || py.stderr).trim()})`);
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'headless-run.mjs'), '--workspace', ws, '--task-file', taskFile, '--timeout-min', opt('timeout-min') ?? '60'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LT_DSH_HOME: home, LEADERTEAM_CONFIG: cfgFile } });
const log = fs.createWriteStream(path.join(out, 'headless-run.log'));
child.stdout.on('data', d => { process.stdout.write(d); log.write(d); }); child.stderr.on('data', d => { process.stderr.write(d); log.write(d); });
const code = await new Promise(r => child.on('close', r));
log.end();
const newRuns = (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []).filter(d => !runsBefore.has(d)).sort();
if (newRuns.length !== 1) fail(`expected exactly one new run directory under ${runsDir}, found ${newRuns.length}`);
const runDir = path.join(runsDir, newRuns[0]);
const summary = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
const finalFile = path.join(out, 'final.txt');
fs.writeFileSync(finalFile, summary.final?.text ?? '');
if (!summary.sessionId) fail('the run produced no session id');
const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'dev', 'check-team-acceptance.mjs'), '--home', home, '--workspace', ws,
  '--leader-session', summary.sessionId, '--exit-code', String(summary.code ?? code), '--final-file', finalFile, '--acceptance', path.join(FIX, 'acceptance.json'),
  '--task-file', taskFile, '--pre-manifest', preFile, '--config', cfgFile, '--python', python, '--out', path.join(out, 'acceptance-report.json')], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(check.stdout); process.stderr.write(check.stderr);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ workspace: ws, home, runDir, sessionId: summary.sessionId, dshExit: summary.code, checkerExit: check.status, report: path.join(out, 'acceptance-report.json'), config: cfgFile, gptExcluded: !allowGpt }, null, 1));
process.exitCode = check.status === 0 ? 0 : 1;
