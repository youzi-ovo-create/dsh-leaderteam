import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAutoAdoptedLocalOverrideFromDshModels } from '../../leaderteam/core/session-config.mjs';
import { scanPosixShell } from '../../leaderteam/core/gate-policy.mjs';
import { samePath, registerHome, registryFile, listKnownHomes } from '../../packages/lt-usage/reader/homes.js';
import { listSessions } from '../../packages/lt-usage/reader/service.js';

test('role adoption merges repeated routes and retains the selected leader within the 24-model limit', () => {
  const chat = { route: 'gateway/chat', efforts: ['none'] };
  const catalog = Array.from({ length: 24 }, (_, i) => ({ route: 'gateway/model-' + i }));
  const primary = { route: 'gateway/reasoner', efforts: ['high'] };
  const config = buildAutoAdoptedLocalOverrideFromDshModels([chat, { ...chat, efforts: ['low'] }, ...catalog, primary]);
  assert.equal(config.roles.leader.route, primary.route);
  assert.equal(config.team.executionPool.length, 24);
  assert.equal(new Set(config.team.executionPool).size, 24);
  assert.ok(config.team.executionPool.includes(primary.route));
  assert.deepEqual(config.models[chat.route].efforts, ['none', 'low']);
});

test('PowerShell tokenization preserves Windows path separators in quoted and unquoted arguments', () => {
  const command = String.raw`Get-Item docs\guide.md "docs\long file.md"`;
  const { tokens } = scanPosixShell(command, { treatBacktickAsSubstitution: false });
  assert.deepEqual(tokens.map(t => t.value), ['Get-Item', 'docs\\guide.md', 'docs\\long file.md']);
});

test('usage directories share one registration across aliases and expose unreadable sessions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt224-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const sessionDir = path.join(home, 'sessions', 'project', 'example');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'unreadable');
  const alias = path.join(dir, 'alias');
  fs.symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const oldHome = process.env.DSH_HOME;
  const oldRegistry = process.env.LT_USAGE_REGISTRY;
  process.env.DSH_HOME = home;
  delete process.env.LT_USAGE_REGISTRY;
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldRegistry === undefined) delete process.env.LT_USAGE_REGISTRY; else process.env.LT_USAGE_REGISTRY = oldRegistry;
  });
  registerHome(home);
  registerHome(alias);
  assert.ok(samePath(home, alias));
  assert.equal(JSON.parse(fs.readFileSync(registryFile(), 'utf8')).homes.length, 1);
  assert.equal(listKnownHomes().filter(item => samePath(item, home)).length, 1);
  assert.ok(listSessions(home).find(row => row.id === 'example')?.error);
});
