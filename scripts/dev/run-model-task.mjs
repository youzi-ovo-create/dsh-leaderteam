#!/usr/bin/env node
// Development worker: existing Codex CLI -> existing Magpie Responses endpoint.
// Does not change global configuration or the LeaderTeam product runtime.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const opts = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || process.argv[i + 1] === undefined) throw new Error('Expected --option value pairs');
  opts[process.argv[i].slice(2)] = process.argv[i + 1];
}
const allowed = {
  'zcode/GLM-5.3-Flash': ['low', 'high', 'max'],
  'zcode/GLM-5.3': ['low', 'high', 'max'],
};
if (!allowed[opts.model]?.includes(opts.effort) || !opts['task-file'] || !opts.out) {
  throw new Error('Usage: --model <whitelisted GLM ID> --effort <level> --task-file <path> --out <dir> [--sandbox read-only|workspace-write] [--timeout-min 20]');
}
const sandbox = opts.sandbox ?? 'workspace-write';
if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Unsupported sandbox');
const timeoutMin = Number(opts['timeout-min'] ?? 20);
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || timeoutMin > 120) throw new Error('Invalid timeout');
const configPath = path.join(os.homedir(), '.codex', 'config.toml');
const config = fs.readFileSync(configPath, 'utf8');
const section = config.match(/^\[model_providers\.magpie\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
if (!section) throw new Error('Existing model_providers.magpie configuration is required');
const value = (text, name) => {
  const match = text.match(new RegExp('^' + name + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")', 'm'));
  return match ? JSON.parse(match[1]) : undefined;
};
const baseURL = value(section, 'base_url');
if (!baseURL || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Expected existing local Magpie URL');
const keyEnv = value(section, 'env_key');
const key = value(section, 'experimental_bearer_token') || (keyEnv && process.env[keyEnv]) || 'magpie-local';
const catalogSetting = value(config, 'model_catalog_json');
const catalog = catalogSetting && path.resolve(path.dirname(configPath), catalogSetting);
const tomlString = s => JSON.stringify(s);
const overrides = {
  model_provider: 'magpie', model_reasoning_effort: opts.effort,
  'model_providers.magpie.name': 'Magpie',
  'model_providers.magpie.base_url': baseURL,
  'model_providers.magpie.wire_api': 'responses',
  'model_providers.magpie.env_key': 'LT_WORKER_MAGPIE_KEY',
};
if (catalog) overrides.model_catalog_json = catalog;
const windowsSection = config.match(/^\[windows\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? '';
const windowsSandbox = value(windowsSection, 'sandbox');
if (process.platform === 'win32' && ['elevated', 'unelevated'].includes(windowsSandbox)) overrides['windows.sandbox'] = windowsSandbox;
const argv = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '-s', sandbox, '-m', opts.model,
  ...Object.entries(overrides).flatMap(([k, v]) => ['-c', `${k}=${tomlString(v)}`]),
  '-c', 'model_providers.magpie.requires_openai_auth=false', '-c', 'agents.enabled=false', '-c', 'features.goals=false', '-c', 'approval_policy="never"', '-'];
const task = fs.readFileSync(path.resolve(opts['task-file']), 'utf8') + '\nIf a command is blocked by policy, stop immediately and report the exact error. Do not try alternate shells or work around that policy. Do not read credentials or change model routing.\n';
const outDir = path.resolve(opts.out);
fs.mkdirSync(outDir, { recursive: true });
const started = new Date().toISOString();
console.log(`worker ${opts.model} ${opts.effort}; evidence ${outDir}`);
const child = spawn(process.env.LT_CODEX_CLI ?? 'codex', argv, {
  cwd: process.cwd(), env: { ...process.env, LT_WORKER_MAGPIE_KEY: key },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '', stderr = '', launchError, timedOut = false, progressBuffer = '';
const progressFile = path.join(outDir, 'progress.jsonl');
fs.writeFileSync(progressFile, '');
child.stdout.on('data', d => {
  stdout += d;
  progressBuffer += d;
  let newline;
  while ((newline = progressBuffer.indexOf('\n')) >= 0) {
    const line = progressBuffer.slice(0, newline + 1);
    progressBuffer = progressBuffer.slice(newline + 1);
    fs.appendFileSync(progressFile, line.split(key).join('[REDACTED]'));
  }
});
child.stderr.on('data', d => stderr += d);
child.on('error', e => { launchError = e.message; });
child.stdin.on('error', () => {});
child.stdin.end(task);
const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMin * 60000);
child.on('close', code => {
  clearTimeout(timer);
  const redact = s => key ? s.split(key).join('[REDACTED]') : s;
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const messages = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text);
  const summary = { model: opts.model, effort: opts.effort, sandbox, started, ended: new Date().toISOString(), code, timedOut,
    ...(launchError ? { launchError } : {}), final: messages.at(-1) ?? null,
    usage: events.findLast(e => e.type === 'turn.completed')?.usage ?? null };
  fs.writeFileSync(path.join(outDir, 'events.jsonl'), redact(stdout));
  fs.writeFileSync(path.join(outDir, 'stderr.log'), redact(stderr));
  fs.writeFileSync(path.join(outDir, 'summary.json'), redact(JSON.stringify(summary, null, 2)));
  console.log(redact(JSON.stringify(summary, null, 2)));
  process.exitCode = code === 0 && !timedOut && !launchError ? 0 : 1;
});
