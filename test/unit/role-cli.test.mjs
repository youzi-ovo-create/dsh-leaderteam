import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts', 'dev', 'set-role-model.mjs');
const SOURCE = path.join(ROOT, 'config', 'leaderteam.config.json');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}
function tempCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-role-cli-'));
  const file = path.join(dir, 'leaderteam.config.json');
  fs.copyFileSync(SOURCE, file);
  return file;
}

test('invalid settings fail and leave the copied config byte-identical', () => {
  const file = tempCopy();
  try {
    const before = fs.readFileSync(file);
    const cases = [
      ['--role', 'boss', '--model', 'codex/gpt-6.1-sol', '--effort', 'low'],
      ['--role', 'gate', '--model', 'nope/x', '--effort', 'low'],
      ['--role', 'gate', '--model', 'codex/gpt-6.1-sol', '--effort', 'ultra'],
      ['--role', 'gate', '--model', 'codex/gpt-6.1-sol'],
      ['--bogus', 'x'],
    ];
    for (const args of cases) {
      const r = runCli(['--config', file, ...args]);
      assert.notEqual(r.status, 0, args.join(' '));
      assert.ok(r.stderr.length > 0, args.join(' '));
      assert.deepEqual(fs.readFileSync(file), before, `bytes unchanged after: ${args.join(' ')}`);
    }
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('valid update rewrites only the target role; unrelated config is preserved', () => {
  const file = tempCopy();
  try {
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = runCli(['--config', file, '--role', 'discussB', '--model', 'codex/gpt-6.1-sol', '--effort', 'high']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.saved, true);
    assert.equal(out.roles.discussB.route, 'codex/gpt-6.1-sol');
    assert.equal(out.roles.discussB.effort, 'high');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of Object.keys(before).filter(k => k !== 'roles')) assert.deepEqual(after[key], before[key], key);
    for (const role of ['leader', 'gate', 'discussA', 'arbiter']) assert.deepEqual(after.roles[role], before.roles[role], role);
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test('dry run reports the change without writing the file', () => {
  const file = tempCopy();
  try {
    const before = fs.readFileSync(file);
    const r = runCli(['--config', file, '--dry-run', '--role', 'arbiter', '--model', 'zcode/GLM-5.3', '--effort', 'high']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.saved, false);
    assert.equal(out.roles.arbiter.route, 'zcode/GLM-5.3');
    assert.equal(out.roles.arbiter.effort, 'high');
    assert.deepEqual(fs.readFileSync(file), before, 'dry run left the file untouched');
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});
