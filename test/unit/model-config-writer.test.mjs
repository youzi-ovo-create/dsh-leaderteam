import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import {
  inspectModelConfiguration,
  applyModelConfigChanges,
  parseMagpiePatchModels,
  renderMagpieModelRows,
  rewriteModelsBlock,
} from '../../leaderteam/core/model-config-writer.mjs';
import { startModelConfigServer } from '../../leaderteam/core/model-config-ui.mjs';
import { runtime, bindRuntimeConfigFile, syncRuntimeConfig } from '../../leaderteam/host/runtime.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: 'virtual-mcw:dsh-llm', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-mcw:dsh-llm') {
      return { format: 'module', shortCircuit: true, source: 'export const boundContextSummary = s => s; export const createUserMessage = x => x;' };
    }
    return nextLoad(url, context);
  },
});
const { ensureScheduler } = await import('../../leaderteam/host/concurrency.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts', 'configure-models.mjs');
const ROLE_CLI = path.join(ROOT, 'scripts', 'dev', 'set-role-model.mjs');

test('editing a governance role preserves its backup chain and promoting a backup removes the duplicate', t => {
  const fx = makeFixture(t);
  applyModelConfigChanges({ setRoles: [{ role: 'gate', route: 'codex/gpt-6.1-sol', effort: 'high', maxTokens: 1234 }] }, { configFile: fx.configFile, syncPatches: false });
  assert.equal(loadConfig(fx.configFile).roles.gate.fallback[0].route, 'zcode/GLM-5.3');
  applyModelConfigChanges({ setRoles: [{ role: 'gate', route: 'zcode/GLM-5.3', effort: 'high' }] }, { configFile: fx.configFile, syncPatches: false });
  assert.deepEqual(loadConfig(fx.configFile).roles.gate.fallback, []);
});

test('governance edits persist attributable before/after receipts; dry runs and no-ops add none', t => {
  const fx = makeFixture(t);
  const changes = { setRoles: [{ role: 'gate', route: 'zcode/GLM-5.3', effort: 'high' }] };
  const options = { configFile: fx.configFile, syncPatches: false };
  const preview = applyModelConfigChanges(changes, { ...options, dryRun: true });
  assert.equal(fs.existsSync(preview.governanceAudit.file), false);
  const saved = applyModelConfigChanges(changes, options);
  const rows = fs.readFileSync(saved.governanceAudit.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.event), ['prepared', 'applied']);
  assert.equal(rows[0].id, rows[1].id);
  assert.ok(rows[0].actor.user);
  assert.equal(rows[0].after.roles.gate.route, 'zcode/GLM-5.3');
  assert.notEqual(rows[0].beforeSha256, rows[0].afterSha256);
  assert.equal(loadConfig(fx.configFile).roles.gate.route, 'zcode/GLM-5.3');
  applyModelConfigChanges(changes, options);
  assert.equal(fs.readFileSync(saved.governanceAudit.file, 'utf8').trim().split('\n').length, 2);
});

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-model-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfgDir = path.join(dir, 'config');
  const dshHome = path.join(dir, 'dsh-home');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  for (const name of ['leaderteam.config.json', 'desktop-magpie.patch.yml', 'magpie-models.patch.yml']) {
    fs.copyFileSync(path.join(ROOT, 'config', name), path.join(cfgDir, name));
  }

  const desktopBlock = fs.readFileSync(path.join(cfgDir, 'desktop-magpie.patch.yml'), 'utf8')
    .replace('__MAGPIE_BASEURL__', 'http://127.0.0.1:3425/v1')
    .trim();
  const cordisPatch = [
    '# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)',
    desktopBlock,
    '# <<< leaderteam',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), cordisPatch, 'utf8');

  return {
    dir,
    cfgDir,
    configFile: path.join(cfgDir, 'leaderteam.config.json'),
    localFile: path.join(cfgDir, 'leaderteam.local.json'),
    desktopPatch: path.join(cfgDir, 'desktop-magpie.patch.yml'),
    headlessPatch: path.join(cfgDir, 'magpie-models.patch.yml'),
    dshHome,
    cordisPatchFile: path.join(profileDir, 'cordis.patch.yml'),
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
}

test('upserting models updates catalog, executionPool, and both Magpie YAML patch templates atomically', t => {
  const fx = makeFixture(t);
  const r = runCli([
    '--config', fx.configFile,
    '--dsh-home', fx.dshHome,
    '--upsert-model', 'antigravity/gemini-4-carbon',
    '--family', 'gemini',
    '--label', 'Gemini 4 Carbon',
    '--efforts', 'low,medium,high',
    '--default-effort', 'medium',
    '--strengths', '高难度编码与复杂调试',
    '--enable-in-pool',
    '--upsert-model', 'antigravity/claude-opus-5-5',
    '--family', 'claude',
    '--label', 'Claude Opus 5.5',
    '--efforts', 'low,medium,high',
    '--default-effort', 'high',
    '--quota-windows', 'Claude & GPT · 7 days,Claude & GPT · 5 hours',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.saved, true);
  assert.equal(out.patchesUpdated.length, 2);
  assert.ok(out.effective.executionPool.includes('antigravity/gemini-4-carbon'));
  assert.ok(!out.effective.executionPool.includes('antigravity/claude-opus-5-5'));
  assert.deepEqual(
    out.effective.models['antigravity/claude-opus-5-5'].quotaWindows,
    ['Claude & GPT · 7 days', 'Claude & GPT · 5 hours'],
  );

  // Both Magpie YAML patch templates stay in exact sync with base config (H7 invariant)
  const cfg = loadConfig(fx.configFile, { includeLocal: false });
  const expectedRows = renderMagpieModelRows(cfg);
  for (const pf of [fx.desktopPatch, fx.headlessPatch]) {
    const text = fs.readFileSync(pf, 'utf8');
    assert.equal(text.replace(/\r\n/g, '\n'), rewriteModelsBlock(text, expectedRows).replace(/\r\n/g, '\n'));
    const parsed = parseMagpiePatchModels(text);
    assert.deepEqual(parsed.get('antigravity/gemini-4-carbon'), ['low', 'medium', 'high']);
    assert.deepEqual(parsed.get('antigravity/claude-opus-5-5'), ['low', 'medium', 'high']);
  }

  // Desktop cordis.patch.yml has not been synced yet, so active new route flags hotReloadableNow=false
  assert.equal(out.desktopSync.inSync, false);
  assert.equal(out.desktopSync.hotReloadableNow, false);
  assert.deepEqual(out.desktopSync.missingActiveRoutes, ['antigravity/gemini-4-carbon']);
});

test('rejects unsafe effort strings that could inject flow YAML and performs zero disk writes', t => {
  const fx = makeFixture(t);
  const beforeCfg = fs.readFileSync(fx.configFile);
  const beforePatch = fs.readFileSync(fx.desktopPatch);

  const badCases = [
    ['--upsert-model', 'zcode/GLM-5.3-Flash', '--efforts', 'low,high}, evil: {x', '--default-effort', 'low'],
    ['--pool-set', ''],
    ['--remove-model', 'zcode/GLM-5.3', '--prune-pool'], // still used by gate, discussA, arbiter
  ];
  for (const args of badCases) {
    const r = runCli(['--config', fx.configFile, ...args]);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.deepEqual(fs.readFileSync(fx.configFile), beforeCfg);
    assert.deepEqual(fs.readFileSync(fx.desktopPatch), beforePatch);
  }
});

test('unsupported host effort is rejected before any config or provider file is written', t => {
  const fx = makeFixture(t);
  const files = [fx.configFile, fx.desktopPatch, fx.headlessPatch, fx.cordisPatchFile];
  const before = files.map(f => fs.readFileSync(f));
  assert.throws(() => applyModelConfigChanges({ upsertModels: [{
    route: 'other/new-model', family: 'other', label: 'New model',
    efforts: ['high', 'ultra'], defaultEffort: 'high',
  }] }, { configFile: fx.configFile, dshHome: fx.dshHome }), /ultra.*unsupported by DSH/);
  files.forEach((f, i) => assert.deepEqual(fs.readFileSync(f), before[i]));
  assert.throws(() => renderMagpieModelRows({ models: { 'other/new-model': { efforts: ['ultra'] } } }), /unsupported by DSH/);
  const none = renderMagpieModelRows({ models: { 'other/new-model': { efforts: ['none'] } } });
  assert.doesNotMatch(none, /reasoningEfforts/);
});

test('member pool family toggles, effort narrowing, and dry-run zero-write guarantee', t => {
  const fx = makeFixture(t);
  const beforeCfg = fs.readFileSync(fx.configFile);

  // Dry-run leaves file untouched
  const dry = runCli([
    '--config', fx.configFile,
    '--dsh-home', fx.dshHome,
    '--dry-run',
    '--pool-disable-family', 'gpt',
    '--upsert-model', 'zcode/GLM-5.3-Flash',
    '--efforts', 'low,high',
    '--default-effort', 'high',
  ]);
  assert.equal(dry.status, 0, dry.stderr);
  const dryOut = JSON.parse(dry.stdout);
  assert.equal(dryOut.saved, false);
  assert.equal(dryOut.changed, true);
  assert.ok(dryOut.effective.executionPool.every(r => !r.startsWith('codex/')));
  assert.equal(dryOut.desktopSync.hotReloadableNow, true, 'narrowing existing models is immediately hot-reloadable');
  assert.deepEqual(fs.readFileSync(fx.configFile), beforeCfg);

  // Real apply writes atomically and backupDir preserves original copy
  const backupDir = path.join(fx.dir, 'backup-1');
  const real = runCli([
    '--config', fx.configFile,
    '--dsh-home', fx.dshHome,
    '--backup-dir', backupDir,
    '--pool-disable-family', 'gpt',
    '--upsert-model', 'zcode/GLM-5.3-Flash',
    '--efforts', 'low,high',
    '--default-effort', 'high',
  ]);
  assert.equal(real.status, 0, real.stderr);
  const realOut = JSON.parse(real.stdout);
  assert.equal(realOut.saved, true);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, 'leaderteam.config.json')), beforeCfg);
  assert.deepEqual(realOut.effective.models['zcode/GLM-5.3-Flash'].efforts, ['low', 'high']);
});

test('local overrides (--local), shadow warnings, safe clearLocal, and set-role-model.mjs [P2] merged validation', t => {
  const fx = makeFixture(t);
  // Seed machine-local paths/quota in leaderteam.local.json
  fs.writeFileSync(fx.localFile, JSON.stringify({
    quota: { stateFile: 'E:/local-quota/state.json' },
    paths: { globalRefRoots: ['E:/shared-refs'] },
    roles: { gate: { route: 'zcode/GLM-5.3-Flash', effort: 'high', maxTokens: 2000, timeoutMs: 60000, retries: 1 } },
  }, null, 2));

  // [P2] regression check: narrowing gemini-3.8-flash in base config to exclude 'high' MUST fail because local roles.gate uses 'high'!
  assert.throws(
    () => applyModelConfigChanges(
      { upsertModels: [{ route: 'zcode/GLM-5.3-Flash', efforts: ['low'], defaultEffort: 'low' }] },
      { configFile: fx.configFile },
    ),
    /roles\.gate\.effort "high" is not supported/,
  );

  // Editing base roles.gate while local roles.gate exists succeeds AND warns about local shadow
  const roleRes = spawnSync(process.execPath, [
    ROLE_CLI, '--config', fx.configFile, '--role', 'gate', '--model', 'zcode/GLM-5.3', '--effort', 'low',
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(roleRes.status, 0, roleRes.stderr);
  const roleOut = JSON.parse(roleRes.stdout);
  assert.equal(roleOut.saved, true);
  assert.deepEqual(roleOut.shadowedByLocal, ['roles.gate']);
  assert.equal(roleOut.effectiveRoles.gate.route, 'zcode/GLM-5.3-Flash');

  // Apply local member pool override, then clear all local model/role overrides without losing quota/paths!
  const localApply = runCli(['--config', fx.configFile, '--local', '--pool-set', 'zcode/GLM-5.3,zcode/GLM-5.3-Flash']);
  assert.equal(localApply.status, 0, localApply.stderr);
  const snap1 = inspectModelConfiguration({ configFile: fx.configFile });
  assert.deepEqual(snap1.executionPool, ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash']);
  assert.equal(snap1.localOverrides.executionPool, true);

  const clearRes = runCli(['--config', fx.configFile, '--clear-local-all']);
  assert.equal(clearRes.status, 0, clearRes.stderr);
  const preservedLocal = JSON.parse(fs.readFileSync(fx.localFile, 'utf8'));
  assert.equal(preservedLocal.quota.stateFile, 'E:/local-quota/state.json');
  assert.deepEqual(preservedLocal.paths.globalRefRoots, ['E:/shared-refs']);
  assert.equal(preservedLocal.roles, undefined);
  assert.equal(preservedLocal.team, undefined);
});

test('live syncRuntimeConfig hot-reloads same-size edits, preserves scheduler state, and rejects broken JSON safely', t => {
  const fx = makeFixture(t);
  const storeRoot = path.join(fx.dir, 'lt-store');
  fs.mkdirSync(storeRoot, { recursive: true });

  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const initialCfg = loadConfig(fx.configFile);
  Object.assign(rt, {
    storageRoot: storeRoot,
    llm: {},
    surface: 'headless',
    scheduler: null,
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 10, totalPhysMib: 16384, availPhysMib: 8192 }),
  });
  bindRuntimeConfigFile(rt, fx.configFile, initialCfg);
  const sched = ensureScheduler(rt);
  sched.setLeaderPreference('team-live-1', 1, { pendingParallelTasks: 4, currentAvailableNow: 2 });
  assert.equal(rt.config.roles.arbiter.effort, 'max');

  // Same byte-length edit ("max" -> "low", both 3 chars) via atomic write is immediately detected via bigint stat signature
  applyModelConfigChanges(
    {
      setRoles: [{ role: 'arbiter', route: 'zcode/GLM-5.3', effort: 'low' }],
      poolDisableFamilies: ['gpt'],
    },
    { configFile: fx.configFile },
  );
  const sync1 = syncRuntimeConfig(rt);
  assert.equal(sync1.reloaded, true);
  assert.equal(rt.config.roles.arbiter.effort, 'low');
  assert.ok(rt.config.team.executionPool.every(r => !r.startsWith('codex/')));
  assert.equal(ensureScheduler(rt), sched, 'scheduler instance and in-memory team backlog preserved across reload');
  const snapAfter = sched.evaluate({ teamId: 'team-live-1', taskSeq: 1, activeMembers: [], otherActiveMembers: [] });
  assert.equal(snapAfter.backlog.pending_parallel_tasks, 4);

  // Corrupt leaderteam.local.json -> rejected safely, retaining valid rt.config; subsequent fix reloads cleanly
  fs.writeFileSync(fx.localFile, '{ broken json', 'utf8');
  const syncBad = syncRuntimeConfig(rt);
  assert.equal(syncBad.reloaded, false);
  assert.equal(rt.config.roles.arbiter.effort, 'low');

  fs.writeFileSync(fx.localFile, JSON.stringify({ team: { maxActiveMembers: 3 } }, null, 2), 'utf8');
  const syncRecovered = syncRuntimeConfig(rt);
  assert.equal(syncRecovered.reloaded, true);
  assert.equal(rt.config.team.maxActiveMembers, 3);
  assert.equal(sched.currentUserMax(), 3);
});

test('loopback visual server enforces Host/Origin/CSRF protections and applies changes atomically', async t => {
  const fx = makeFixture(t);
  const srv = await startModelConfigServer({
    configFile: fx.configFile,
    dshHome: fx.dshHome,
    backupRoot: path.join(fx.dir, 'ui-backups'),
  });
  t.after(() => srv.close());

  // 1. Rejects DNS-rebinding Host header
  const badHostStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: srv.port,
      path: '/api/state',
      method: 'GET',
      headers: { Host: 'evil.example.com', 'X-LT-Token': srv.csrfToken },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(badHostStatus, 403);

  // 2. Rejects missing CSRF token and cross-origin Origin header
  const noTokenRes = await fetch(`${srv.url}api/state`);
  assert.equal(noTokenRes.status, 403);

  const badOriginRes = await fetch(`${srv.url}api/apply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LT-Token': srv.csrfToken,
      Origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ dryRun: true, changes: {} }),
  });
  assert.equal(badOriginRes.status, 403);

  // 3. Valid loopback GET + POST apply works end-to-end
  const htmlRes = await fetch(srv.url);
  assert.equal(htmlRes.status, 200);
  assert.match(await htmlRes.text(), /LeaderTeam 外部模型与成员配置器/);

  const applyRes = await fetch(`${srv.url}api/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LT-Token': srv.csrfToken },
    body: JSON.stringify({
      target: 'base',
      dryRun: false,
      changes: {
        poolDisableFamilies: ['gpt'],
        setRoles: [{ role: 'gate', route: 'zcode/GLM-5.3-Flash', effort: 'high' }],
      },
    }),
  });
  assert.equal(applyRes.status, 200);
  const body = await applyRes.json();
  assert.equal(body.saved, true);
  assert.equal(body.effective.roles.gate.route, 'zcode/GLM-5.3-Flash');
  assert.equal(body.effective.roles.gate.effort, 'high');
});
