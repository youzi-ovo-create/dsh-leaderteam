import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveDshRuntime } from '../../scripts/dsh-runtime.mjs';

function fixture(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-runtime-${name}-`));
}

function write(file, contents = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

test('resolves the official Desktop layout', () => {
  const app = fixture('official');
  write(path.join(app, 'DeepSeek Harness.exe'));
  write(path.join(app, 'resources/app.asar'));
  write(path.join(app, 'resources/runtime/cli/bin/dsh.cmd'));
  write(path.join(app, 'resources/runtime/primary-runtime/runtime.json'), JSON.stringify({ desktopVersion: '0.2.2-rc.1' }));
  const runtime = resolveDshRuntime(app);
  assert.equal(runtime.kind, 'official-desktop');
  assert.equal(runtime.profile, 'desktop');
  assert.equal(runtime.version, '0.2.2-rc.1');
  const appUrl = runtime.app.replaceAll('\\', '/');
  assert.equal(runtime.cliArgs.at(-1).replaceAll('\\', '/'), `${appUrl}/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`);
  assert.equal(runtime.moduleRoot.replaceAll('\\', '/'), `${appUrl}/resources/app.asar/dsh`);
});

test('resolves the historical Dataelem layout', () => {
  const app = path.join(fixture('legacy'), 'dsh-desktop-0.13.2');
  write(path.join(app, 'DSH Desktop.exe'));
  write(path.join(app, 'resources/app.asar'));
  write(path.join(app, 'resources/harness-node-entry.mjs'));
  const runtime = resolveDshRuntime(app);
  assert.equal(runtime.kind, 'legacy-dataelem');
  assert.equal(runtime.version, '0.13.2');
  assert.equal(runtime.cliArgs.length, 2);
  assert.equal(runtime.moduleRoot.replaceAll('\\', '/'), `${runtime.app.replaceAll('\\', '/')}/resources/app.asar`);
});

test('rejects unknown runtime layouts', () => {
  assert.throws(() => resolveDshRuntime(fixture('unknown')), /Unknown DSH runtime layout/);
});
