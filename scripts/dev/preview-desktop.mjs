#!/usr/bin/env node
// Preview the official DSH Web composition used by Desktop, with isolated data.
// No installed Desktop data is read or changed. No models are called on startup.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { resolveDshRuntime } from '../dsh-runtime.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const opts = {};
for (let i = 2; i < process.argv.length; i += 2) opts[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const port = Number(opts.port ?? 3438);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
await new Promise((resolve, reject) => {
  const check = net.createServer();
  check.once('error', reject);
  check.listen(port, '127.0.0.1', () => check.close(resolve));
});
const workspace = path.resolve(opts.workspace ?? path.join(root, 'scratch', 'desktop-preview', 'workspace'));
const home = path.resolve(process.env.LT_DSH_HOME ?? path.join(root, 'scratch', 'desktop-preview', 'home'));
const evidence = path.join(root, 'reports', 'desktop-preview');
for (const dir of [workspace, home, evidence]) fs.mkdirSync(dir, { recursive: true });
const fwd = s => s.replaceAll('\\', '/');
const patches = ['desktop.patch.yml', 'desktop-magpie.patch.yml'].map(name => {
  const source = fs.readFileSync(path.join(root, 'config', name), 'utf8')
    .replaceAll('__LT_ROOT_URL__', pathToFileURL(root).href).replaceAll('__LT_ROOT__', fwd(root)).replaceAll('__LT_CONFIG__', fwd(path.join(root, 'config', 'leaderteam.config.json')))
    .replaceAll('__MAGPIE_BASEURL__', 'http://127.0.0.1:3425/v1');
  const output = path.join(evidence, name.replace('.yml', '.mat.yml'));
  fs.writeFileSync(output, source); return output;
});
const runtime = resolveDshRuntime();
const args = [...runtime.cliArgs, 'web', ...patches.flatMap(p => ['--patch', p]), '--no-open', '--host', '127.0.0.1', '--port', String(port)];
const child = spawn(runtime.exe, args, { cwd: workspace, windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const log = fs.createWriteStream(path.join(evidence, 'server.log'));
let pending = '';
const consume = line => {
  const address = line.match(/dsh web:\s+(https?:\/\/\S+)/)?.[1];
  if (address) {
    fs.writeFileSync(path.join(home, 'preview-url.private'), address, { mode: 0o600 });
    const url = new URL(address); url.search = ''; url.hash = '';
    console.log(`preview ready: ${url.href}`);
  }
  log.write(line.replace(/([?&]token=)[^\s&]+/g, '$1[REDACTED]'));
};
const capture = d => {
  pending += d;
  let newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    consume(pending.slice(0, newline + 1)); pending = pending.slice(newline + 1);
  }
};
child.stdout.on('data', capture); child.stderr.on('data', capture);
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('close', code => { if (pending) consume(pending); log.end(); process.exitCode = code ?? 1; });
const metadata = { pid: child.pid ?? null, port, url: `http://127.0.0.1:${port}`, workspace, home, evidence };
fs.writeFileSync(path.join(evidence, 'server.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata, null, 2));
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
