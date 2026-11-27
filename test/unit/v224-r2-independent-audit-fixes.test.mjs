import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: `virtual-v224-r2:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v224-r2:@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";',
      };
    }
    if (url === 'virtual-v224-r2:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class ToolExecutionPipeline { async dispatchToolBody(exec) { const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet); return await tool.execute(exec.arguments, exec); } }',
      };
    }
    if (url === 'virtual-v224-r2:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: '{"version":"0.2.2-rc.5"}' };
    }
    if (url.startsWith('virtual-v224-r2:')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler {} export const createUserMessage = x => x; export default {};',
      };
    }
    return nextLoad(url, context);
  },
});

import { loadConfig } from '../../leaderteam/core/config.mjs';
import { hashJson } from '../../leaderteam/core/canonical.mjs';
import {
  sessionConfigPath,
  readSessionConfigRecord,
  purgePreCreationOrphanSessionConfig,
  hasLiveCrossProcessActiveTurn,
} from '../../leaderteam/core/session-config.mjs';
import {
  checkForUpdates,
  createPreUpgradeBackup,
  performOneClickUpgrade,
  rollbackToSavedBackup,
  verifyBackupSnapshotIntegrity,
  reconcileConfigForTargetCapabilities,
} from '../../leaderteam/core/updater.mjs';
import {
  inspectInstallerEnvironment,
  runOneClickInstallation,
} from '../../leaderteam/core/installer.mjs';
import { applyQuickOnboardingSetup } from '../../leaderteam/core/onboarding.mjs';
import { HengzhangUsageBridge } from '../../leaderteam/usage/hengzhang-bridge.mjs';
import {
  runtime,
  bindRuntimeConfigFile,
  inspectSessionBusyForConfig,
} from '../../leaderteam/host/runtime.mjs';
import { leaderAllowedTools } from '../../leaderteam/host/roles.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { createPanelHandlers } from '../../leaderteam/plugins/leaderteam-panel/panel-api.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

function makeSandbox(t, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lt-v224-r2-${label}-`));
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });
  const dshHome = path.join(tmp, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const baseCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), 'utf8'));
  baseCfg.storage = { root: storageRoot };
  const cfgFile = path.join(storageRoot, 'config', 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, `${JSON.stringify(baseCfg, null, 2)}\n`);
  return { tmp, dshHome, storageRoot, cfgFile };
}

function buildSyntheticTgz(entries) {
  const blocks = [];
  for (const { name, data, mode = 0o644 } of entries) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, Math.min(name.length, 100), 'utf8');
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header);
    if (content.length > 0) {
      blocks.push(content);
      const rem = content.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function createFreshRt(storageRoot, cfgFile) {
  const rt = runtime();
  Object.assign(rt, {
    storageRoot,
    actors: new Map(),
    stores: new Map(),
    teamConfigViews: new Map(),
    inFlightToolDispatchesByTeam: new Map(),
    inFlightShellCallsBySession: new Map(),
    simpleDispatchInFlight: new Map(),
    executionReviewJobs: new Map(),
    governanceJobs: new Map(),
    stopReviewPending: new Set(),
    directiveVerifyPending: new Set(),
    liveProcessMemberIds: new Set(),
    upstreamCatalog: null,
  });
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));
  return rt;
}

test('R1 & R4: historical V2.2.1 backup rolls back cleanly while legacy V2.2.2+ backup missing web-dist JS fails closed', async t => {
  const { tmp, dshHome, storageRoot } = makeSandbox(t, 'r1-r4');

  // --- R1: Complete historical V2.2.1 backup (embedded panel only, NO public-api.mjs / NO web-dist) ---
  const v221Plugin = path.join(tmp, 'installed-v221');
  fs.mkdirSync(path.join(v221Plugin, 'leaderteam', 'plugins', 'leaderteam-panel'), { recursive: true });
  fs.mkdirSync(path.join(v221Plugin, 'leaderteam', 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(v221Plugin, 'package.json'),
    JSON.stringify({
      name: 'dsh-leaderteam',
      version: '2.2.1',
      license: 'Apache-2.0',
      engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  fs.writeFileSync(
    path.join(v221Plugin, 'leaderteam', 'package.json'),
    JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.1', leaderteam: { distributionTrack: 'open-source' } }),
  );
  fs.writeFileSync(path.join(v221Plugin, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
  fs.writeFileSync(path.join(v221Plugin, 'leaderteam', 'entry-core.mjs'), 'export const name = "leaderteam-core";\n');
  fs.writeFileSync(path.join(v221Plugin, 'leaderteam', 'core', 'config.mjs'), 'export const POLICIES = ["enforce", "warn", "off"];\n');
  fs.writeFileSync(path.join(v221Plugin, 'leaderteam', 'plugins', 'leaderteam-panel', 'index.mjs'), 'export const panel = true;\n');
  fs.writeFileSync(path.join(v221Plugin, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'console.log("v221");\n');

  const v221Backup = createPreUpgradeBackup({
    storageRoot,
    pluginRoot: v221Plugin,
    targetVersion: '2.2.4',
    targetTrack: 'open-source',
  });
  const v221Verify = verifyBackupSnapshotIntegrity(v221Backup.manifest);
  assert.equal(v221Verify.intact, true, `V2.2.1 backup should be intact, got: ${v221Verify.reason}`);
  assert.deepEqual(v221Verify.missing, []);

  let restoredSpec = null;
  const v221Rollback = await rollbackToSavedBackup({
    storageRoot,
    dshHome,
    backupId: v221Backup.backupId,
    installerHook: async ({ spec }) => {
      restoredSpec = spec;
    },
  });
  assert.equal(v221Rollback.ok, true);
  assert.equal(restoredSpec, v221Backup.manifest.pluginSnapshotDir);

  // Removing embedded client.js from V2.2.1 backup MUST still fail closed
  fs.rmSync(path.join(v221Backup.manifest.pluginSnapshotDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'));
  const v221Tampered = verifyBackupSnapshotIntegrity(v221Backup.manifest);
  assert.equal(v221Tampered.intact, false);
  assert.ok(v221Tampered.missing.includes('leaderteam/plugins/leaderteam-panel/client.js'));

  // --- R4: Legacy V2.2.3 backup WITHOUT fileHashes referencing web-dist/assets/index-r4test.js ---
  const legacyDir = path.join(storageRoot, 'updater', 'backups', 'legacy-r4-backup');
  const legacySnap = path.join(legacyDir, 'plugin-package');
  fs.mkdirSync(path.join(legacySnap, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(legacySnap, 'package.json'),
    JSON.stringify({
      name: 'dsh-leaderteam',
      version: '2.2.3',
      bin: { 'lt-ui': './bin/lt-ui.mjs' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  fs.writeFileSync(path.join(legacySnap, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
  fs.writeFileSync(path.join(legacySnap, 'leaderteam', 'package.json'), JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.3' }));
  fs.writeFileSync(path.join(legacySnap, 'leaderteam', 'entry-core.mjs'), 'export const name = "core";\n');
  fs.writeFileSync(path.join(legacySnap, 'leaderteam', 'plugins', 'leaderteam-panel', 'index.mjs'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(legacySnap, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'export const y = 1;\n');
  fs.writeFileSync(path.join(legacySnap, 'leaderteam', 'plugins', 'leaderteam-panel', 'public-api.mjs'), 'export const z = 1;\n');
  fs.writeFileSync(
    path.join(legacySnap, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'index.html'),
    '<!doctype html><html><head><title>Leader Team</title><script type="module" crossorigin src="./assets/index-r4test.js"></script></head><body><div id="root"></div></body></html>\n',
  );
  const mainJsPath = path.join(legacySnap, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'assets', 'index-r4test.js');
  fs.writeFileSync(mainJsPath, 'console.log("workbench");\n');

  const legacyMeta = {
    backupId: 'legacy-r4-backup',
    createdAt: new Date().toISOString(),
    fromVersion: '2.2.3',
    fromTrack: 'open-source',
    toVersion: '2.2.4',
    toTrack: 'open-source',
    pluginSnapshotDir: legacySnap,
    // Intentionally NO fileHashes (pre-V2.2.4 legacy backup)
  };
  fs.writeFileSync(path.join(legacyDir, 'manifest.json'), JSON.stringify(legacyMeta, null, 2));

  assert.equal(verifyBackupSnapshotIntegrity(legacyMeta).intact, true);

  // Delete the referenced main JS bundle — must fail closed even with zero fileHashes
  fs.rmSync(mainJsPath);
  const corruptCheck = verifyBackupSnapshotIntegrity(legacyMeta);
  assert.equal(corruptCheck.intact, false);
  assert.ok(corruptCheck.missing.includes('leaderteam/plugins/leaderteam-panel/web-dist/assets/index-r4test.js'));

  await assert.rejects(
    rollbackToSavedBackup({
      storageRoot,
      dshHome,
      backupId: 'legacy-r4-backup',
      installerHook: async () => {},
    }),
    err => err?.code === 'CORRUPT_BACKUP_SNAPSHOT',
  );
});

test('R2: upgrading back from R3 via official installer or startup reconciles follow policy without clobbering enforce', async t => {
  const { tmp, dshHome, storageRoot, cfgFile } = makeSandbox(t, 'r2');

  const pluginRoot = path.join(tmp, 'installed-v224');
  fs.mkdirSync(path.join(pluginRoot, 'leaderteam', 'core'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: 'dsh-leaderteam',
      version: '2.2.4',
      engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  fs.writeFileSync(path.join(pluginRoot, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
  fs.writeFileSync(path.join(pluginRoot, 'leaderteam', 'package.json'), JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.4', leaderteam: { distributionTrack: 'open-source' } }));
  fs.writeFileSync(path.join(pluginRoot, 'leaderteam', 'core', 'config.mjs'), 'export const POLICIES = ["follow", "enforce", "warn", "off"];\n');

  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.team.leaderModelPolicy = 'follow';
  fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.mkdirSync(path.join(storageRoot, 'teams', 'team-r2'), { recursive: true });
  const govCfg = structuredClone(cfg);
  const govFile = path.join(storageRoot, 'teams', 'team-r2', 'governance.json');
  fs.writeFileSync(govFile, JSON.stringify({ v: 1, createdAt: new Date().toISOString(), sourceSha256: hashJson(govCfg), config: govCfg }, null, 2));

  // Step 1: Downgrade to legacy R3 tarball (no `follow` support) -> downgrades config & governance to `warn` and writes compat marker
  const r3TgzBuf = buildSyntheticTgz([
    { name: 'package/package.json', data: JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.3', engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }) },
    { name: 'package/leaderteam/package.json', data: JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.3', leaderteam: { distributionTrack: 'open-source' } }) },
    { name: 'package/cordis.patch.yml', data: '- name: dsh-leaderteam/core\n' },
    { name: 'package/leaderteam/core/config.mjs', data: 'export const LEGACY_POLICIES = ["enforce", "warn", "off"];\n' },
  ]);
  const r3TgzPath = path.join(tmp, 'r3.tgz');
  fs.writeFileSync(r3TgzPath, r3TgzBuf);

  const downRes = await performOneClickUpgrade({
    pluginRoot,
    storageRoot,
    dshHome,
    localTgzPath: r3TgzPath,
    expectedSha256: hashFile(r3TgzPath),
    currentHostVersion: '0.2.2-rc.5',
    installerHook: async () => ({ requiresRestart: true }),
  });
  assert.equal(downRes.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).team.leaderModelPolicy, 'warn');
  assert.equal(JSON.parse(fs.readFileSync(govFile, 'utf8')).config.team.leaderModelPolicy, 'warn');
  const markerPath = path.join(storageRoot, 'updater', 'compat-downgraded-policy.json');
  assert.equal(fs.existsSync(markerPath), true);

  // Step 2: Upgrade back to V2.2.4 via `runOneClickInstallation` (official installer path!) -> restores `follow`
  const v224TgzBuf = buildSyntheticTgz([
    { name: 'package/package.json', data: JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.4', engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }) },
    { name: 'package/leaderteam/package.json', data: JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.4', leaderteam: { distributionTrack: 'open-source' } }) },
    { name: 'package/cordis.patch.yml', data: '- name: dsh-leaderteam/core\n' },
    { name: 'package/leaderteam/core/config.mjs', data: 'export const POLICIES = ["follow", "enforce", "warn", "off"];\n' },
  ]);
  const v224TgzPath = path.join(tmp, 'dsh-leaderteam-2.2.4.tgz');
  fs.writeFileSync(v224TgzPath, v224TgzBuf);

  const fakeTarget = {
    id: 'official-web',
    kind: 'official-web',
    label: 'Mock DSH Web',
    profile: 'web',
    dshVersion: '0.2.2-rc.5',
    toolsVersion: '0.2.2-rc.5',
    dshHome,
    cliCommand: 'dsh',
    cliUsesNode: false,
    compatibility: { status: 'compatible', productionAllowed: true },
  };
  const installRes = await runOneClickInstallation({
    targetId: 'official-web',
    localTgzPath: v224TgzPath,
    dshHome,
    detectedTargets: [fakeTarget],
    installerRunner: async () => {},
  });
  assert.equal(installRes.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).team.leaderModelPolicy, 'follow');
  const restoredGov = JSON.parse(fs.readFileSync(govFile, 'utf8'));
  assert.equal(restoredGov.config.team.leaderModelPolicy, 'follow');
  assert.equal(restoredGov.sourceSha256, hashJson(restoredGov.config));
  assert.equal(fs.existsSync(markerPath), false);

  // Step 3: Startup reconciliation restores `follow` after raw `dsh plugin add`, but NEVER clobbers user-chosen `enforce`
  reconcileConfigForTargetCapabilities(storageRoot, { supportsFollowPolicy: false });
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).team.leaderModelPolicy, 'warn');
  // User manually switches to `enforce` before upgrading back
  const edited = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  edited.team.leaderModelPolicy = 'enforce';
  fs.writeFileSync(cfgFile, `${JSON.stringify(edited, null, 2)}\n`);
  reconcileConfigForTargetCapabilities(storageRoot, { supportsFollowPolicy: true });
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).team.leaderModelPolicy, 'enforce');
  assert.equal(fs.existsSync(markerPath), false);
});

test('R3: HengzhangUsageBridge.getOverview keeps billed cost and honest unknown (null) for failed-with-tokens calls in totals, sessions, byModel and today', async t => {
  const { dshHome, storageRoot } = makeSandbox(t, 'r3');
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Case A: Single session with ONLY a failed priced governance call (42k in + 16k out on dashscope/qwen-max)
  const pricedSid = 'team-r3-priced';
  fs.mkdirSync(path.join(dshHome, 'sessions', pricedSid), { recursive: true });
  fs.writeFileSync(
    path.join(dshHome, 'sessions', pricedSid, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: pricedSid, createdAt: nowMs, cwd: dshHome })}\n`)),
  );
  fs.mkdirSync(path.join(storageRoot, 'teams', pricedSid), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'teams', pricedSid, 'team.json'),
    JSON.stringify({ sessionId: pricedSid, createdAt: nowIso }),
  );
  fs.writeFileSync(
    path.join(storageRoot, 'teams', pricedSid, 'usage.jsonl'),
    `${JSON.stringify({ at: nowIso, role: 'gate', purpose: 'gate-review', route: 'bailian-token-plan/qwen4-max-preview', ok: false, attempts: 1, usage: { inputTokens: 42_000, outputTokens: 16_000, totalTokens: 58_000 } })}\n`,
  );

  const bridgePriced = new HengzhangUsageBridge({
    dshHome,
    storageRoot,
    enabled: true,
    magpieBaseUrl: null,
  });
  const ovPricedRes = await bridgePriced.getOverview({ home: dshHome, syncGateway: false });
  assert.equal(ovPricedRes.enabled, true);
  assert.equal(ovPricedRes.overview.totals.totalTokens, 58_000);
  assert.ok(ovPricedRes.overview.totals.costActualCny.total > 0, 'priced failed call total cost must be > 0');
  assert.ok(ovPricedRes.overview.sessions[0].costActualCny > 0, 'priced failed session cost must be > 0');
  assert.ok(ovPricedRes.overview.byModel[0].costActualCny.total > 0, 'priced failed model cost must be > 0');
  assert.ok(ovPricedRes.overview.today.costActualCny > 0, 'priced failed today cost must be > 0');

  // Case B: Isolated home with ONLY a failed UNPRICED governance call (must be null, NEVER 0!)
  const { dshHome: dshHomeU, storageRoot: storageRootU } = makeSandbox(t, 'r3-unpriced');
  const unpricedSid = 'team-r3-unpriced';
  fs.mkdirSync(path.join(dshHomeU, 'sessions', unpricedSid), { recursive: true });
  fs.writeFileSync(
    path.join(dshHomeU, 'sessions', unpricedSid, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id: unpricedSid, createdAt: nowMs, cwd: dshHomeU })}\n`)),
  );
  fs.mkdirSync(path.join(storageRootU, 'teams', unpricedSid), { recursive: true });
  fs.writeFileSync(
    path.join(storageRootU, 'teams', unpricedSid, 'team.json'),
    JSON.stringify({ sessionId: unpricedSid, createdAt: nowIso }),
  );
  fs.writeFileSync(
    path.join(storageRootU, 'teams', unpricedSid, 'usage.jsonl'),
    `${JSON.stringify({ at: nowIso, role: 'gate', purpose: 'gate-review', route: 'unpriced-local/indigo', ok: false, attempts: 1, usage: { inputTokens: 42_000, outputTokens: 16_000, totalTokens: 58_000 } })}\n`,
  );

  const bridgeUnpriced = new HengzhangUsageBridge({
    dshHome: dshHomeU,
    storageRoot: storageRootU,
    enabled: true,
    magpieBaseUrl: null,
  });
  const ovUnpricedRes = await bridgeUnpriced.getOverview({ home: dshHomeU, syncGateway: false });
  assert.equal(ovUnpricedRes.overview.totals.totalTokens, 58_000);
  assert.equal(ovUnpricedRes.overview.totals.unpricedCalls, 1);
  assert.equal(ovUnpricedRes.overview.totals.costActualCny, null);
  assert.equal(ovUnpricedRes.overview.sessions[0].costActualCny, null);
  assert.equal(ovUnpricedRes.overview.byModel[0].costActualCny, null);
  assert.equal(ovUnpricedRes.overview.today.unpricedCalls, 1);
  assert.equal(ovUnpricedRes.overview.today.costActualCny, null);
});

test('R5: legacy orphan session-configs/<ghost>.json is rejected with 404 across public-api & panel-api and purged on new session creation', async t => {
  const { dshHome, storageRoot, cfgFile } = makeSandbox(t, 'r5');
  const rt = createFreshRt(storageRoot, cfgFile);

  const ghostId = 'ghost-legacy-orphan';
  const ghostCfgPath = sessionConfigPath(storageRoot, ghostId);
  fs.mkdirSync(path.dirname(ghostCfgPath), { recursive: true });
  fs.writeFileSync(
    ghostCfgPath,
    JSON.stringify({
      v: 1,
      sessionId: ghostId,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      override: { roles: { leader: { route: 'dashscope/qwen-plus', effort: 'none' } } },
      pendingOverride: null,
      history: [],
    }),
  );
  assert.ok(readSessionConfigRecord(storageRoot, ghostId));

  // Public API must reject legacy orphan with 404 SESSION_NOT_FOUND
  const publicHandlers = createPublicContractHandlers(null, rt, { dshHome });
  for (const action of ['get', 'set']) {
    const res = await publicHandlers.workbenchSessionConfig(
      new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          sessionId: ghostId,
          ...(action === 'set' ? { patch: { roles: { gate: { route: 'dashscope/qwen-max', effort: 'none' } } } } : {}),
        }),
      }),
    );
    assert.equal(res.status, 404, `public-api ${action} must return 404 for legacy orphan`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'SESSION_NOT_FOUND');
  }

  // Panel API must ALSO reject legacy orphan with 404 SESSION_NOT_FOUND
  const panelHandlers = createPanelHandlers(null, rt, { dshHome });
  const panelRes = await panelHandlers.sessionConfig(
    new Request('http://127.0.0.1/api/leaderteam-panel/session-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'get', sessionId: ghostId }),
    }),
  );
  assert.equal(panelRes.status, 404);
  const panelBody = await panelRes.json();
  assert.equal(panelBody.ok, false);
  assert.equal(panelBody.error.code, 'SESSION_NOT_FOUND');

  // Pre-creation orphan is purged when a brand-new session starts after updatedAt
  const purged = purgePreCreationOrphanSessionConfig(storageRoot, ghostId, Date.now());
  assert.equal(purged, true);
  assert.equal(fs.existsSync(ghostCfgPath), false);

  // Valid session config written AFTER session creation is NEVER purged
  const freshSid = 'real-session-r5';
  const createdMs = Date.now() - 5000;
  const freshCfgPath = sessionConfigPath(storageRoot, freshSid);
  fs.mkdirSync(path.dirname(freshCfgPath), { recursive: true });
  fs.writeFileSync(
    freshCfgPath,
    JSON.stringify({
      v: 1,
      sessionId: freshSid,
      updatedAt: new Date(createdMs + 2000).toISOString(),
      activePatch: { roles: { leader: { route: 'dashscope/qwen-plus', effort: 'none' } } },
      pendingPatch: null,
      audit: [],
    }),
  );
  const keptPurge = purgePreCreationOrphanSessionConfig(storageRoot, freshSid, createdMs);
  assert.equal(keptPurge, false);
  assert.equal(fs.existsSync(freshCfgPath), true);
  assert.equal(readSessionConfigRecord(storageRoot, freshSid).activePatch.roles.leader.route, 'dashscope/qwen-plus');
});

test('R6: cross-process active-turn marker stages peer session-config and blocks GET /workbench/mode with 0 disk writes', async t => {
  const { dshHome, storageRoot, cfgFile } = makeSandbox(t, 'r6');
  const rt = createFreshRt(storageRoot, cfgFile);

  const sid = 'sess-r6-cross-proc';
  fs.mkdirSync(path.join(dshHome, 'sessions', sid), { recursive: true });
  fs.writeFileSync(
    path.join(dshHome, 'sessions', sid, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(
      Buffer.from(`${JSON.stringify({ type: 'session', id: sid, createdAt: Date.now(), cwd: dshHome, agentPreset: 'leaderteam' })}\n`),
    ),
  );

  // Spawn a real live peer child process to represent another DSH host PID holding an active turn
  const peer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => {
    try { peer.kill('SIGKILL'); } catch {}
  });
  const leasePath = path.join(storageRoot, 'active-turns', `${sid}--${peer.pid}.json`);
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  fs.writeFileSync(leasePath, JSON.stringify({ v: 1, pid: peer.pid, sessionId: sid, startedAt: Date.now() }));

  // 1. Read-only cross-process check detects live peer PID
  const crossCheck = hasLiveCrossProcessActiveTurn(storageRoot, sid, { includeSelf: false });
  assert.equal(crossCheck.active, true);
  assert.ok(crossCheck.pids.includes(peer.pid));
  const busy = inspectSessionBusyForConfig(rt, sid);
  assert.equal(busy.busy, true);
  assert.ok(busy.reasons.includes('leader_turn_running'));

  // 2. Peer POST /workbench/session-config stages override instead of applying immediately
  const handlers = createPublicContractHandlers(null, rt, { dshHome });
  const setRes = await handlers.workbenchSessionConfig(
    new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'set',
        sessionId: sid,
        patch: { roles: { gate: { route: 'dashscope/qwen-plus', effort: 'none' } } },
      }),
    }),
  );
  const setJson = await setRes.json();
  assert.equal(setJson.ok, true);
  assert.equal(setJson.data.appliedImmediately, false);
  assert.equal(setJson.data.stagedForSafeBoundary, true);

  // 3. GET /workbench/mode reports activeTurn busy AND performs 0 disk writes
  const beforeFiles = fs.readdirSync(path.dirname(leasePath)).sort();
  const beforeStat = fs.statSync(leasePath).mtimeMs;
  const modeRes = await handlers.workbenchMode(
    new Request(`http://127.0.0.1/api/lt/v1/workbench/mode?sessionId=${encodeURIComponent(sid)}`, { method: 'GET' }),
  );
  const modeJson = await modeRes.json();
  assert.equal(modeJson.ok, true);
  assert.equal(modeJson.data.modeState.canSwitch, false);
  assert.equal(modeJson.data.modeState.activeTurn, true);
  assert.deepEqual(fs.readdirSync(path.dirname(leasePath)).sort(), beforeFiles);
  assert.equal(fs.statSync(leasePath).mtimeMs, beforeStat);

  // 4. Killing peer process makes the stale PID marker non-blocking (O9 preserved)
  peer.kill('SIGKILL');
  await new Promise(resolve => peer.once('exit', resolve));
  assert.equal(hasLiveCrossProcessActiveTurn(storageRoot, sid, { includeSelf: false }).active, false);
  assert.equal(inspectSessionBusyForConfig(rt, sid).busy, false);
});

test('R7 & R8: updater skips auxiliary-only and foreign-arch releases and isolates stable vs prerelease caches', async t => {
  const { tmp, storageRoot } = makeSandbox(t, 'r7-r8');
  const pluginRoot = path.join(tmp, 'installed-v224');
  fs.mkdirSync(path.join(pluginRoot, 'leaderteam'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.4' }));
  fs.writeFileSync(path.join(pluginRoot, 'leaderteam', 'package.json'), JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.4', leaderteam: { distributionTrack: 'open-source' } }));

  // R7a: Auxiliary-only release (`lt-usage-plugin-2.2.7.tgz`) must be skipped in favor of primary `dsh-leaderteam-2.2.6-linux-x64.tgz`
  const auxCheck = await checkForUpdates({
    pluginRoot,
    storageRoot,
    force: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: 'linux-v2.2.7',
            prerelease: false,
            assets: [
              { name: 'lt-usage-plugin-2.2.7.tgz', browser_download_url: 'https://mock/aux.tgz' },
              { name: 'SHA256SUMS.txt', browser_download_url: 'https://mock/SHA256SUMS.txt' },
            ],
          },
          {
            tag_name: 'linux-v2.2.6',
            prerelease: false,
            assets: [{ name: 'dsh-leaderteam-2.2.6-linux-x64.tgz', browser_download_url: 'https://mock/lin226.tgz' }],
          },
        ]),
        { status: 200 },
      ),
  });
  assert.equal(auxCheck.hasUpdate, true);
  assert.equal(auxCheck.latestRelease.version, '2.2.6');
  assert.equal(auxCheck.latestRelease.asset.name, 'dsh-leaderteam-2.2.6-linux-x64.tgz');

  // R7b: Foreign-arch release (`linux-armv7l`) must be skipped on `linux/x64`
  const archCheck = await checkForUpdates({
    pluginRoot,
    storageRoot,
    force: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: 'linux-v2.2.7',
            prerelease: false,
            assets: [{ name: 'dsh-leaderteam-2.2.7-linux-armv7l.tgz', browser_download_url: 'https://mock/armv7l.tgz' }],
          },
          {
            tag_name: 'linux-v2.2.6',
            prerelease: false,
            assets: [{ name: 'dsh-leaderteam-2.2.6-linux-x64.tgz', browser_download_url: 'https://mock/lin226.tgz' }],
          },
        ]),
        { status: 200 },
      ),
  });
  assert.equal(archCheck.hasUpdate, true);
  assert.equal(archCheck.latestRelease.version, '2.2.6');
  assert.equal(archCheck.latestRelease.asset.name, 'dsh-leaderteam-2.2.6-linux-x64.tgz');

  // R8: Prerelease and stable queries use isolated cache entries and never cross-contaminate
  const { storageRoot: r8StorageRoot } = makeSandbox(t, 'r8-cache');
  let fetchCount = 0;
  const mockReleases = [
    {
      tag_name: 'linux-v2.2.8-beta.1',
      prerelease: true,
      assets: [{ name: 'dsh-leaderteam-2.2.8-beta.1-linux-x64.tgz', browser_download_url: 'https://mock/beta228.tgz' }],
    },
    {
      tag_name: 'linux-v2.2.6',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-2.2.6-linux-x64.tgz', browser_download_url: 'https://mock/lin226.tgz' }],
    },
  ];
  const countedFetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify(mockReleases), { status: 200 });
  };

  const pre1 = await checkForUpdates({
    pluginRoot,
    storageRoot: r8StorageRoot,
    force: true,
    includePrerelease: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: countedFetch,
  });
  assert.equal(pre1.latestRelease.version, '2.2.8-beta.1');
  assert.equal(pre1.fromCache, false);

  const stable1 = await checkForUpdates({
    pluginRoot,
    storageRoot: r8StorageRoot,
    force: false,
    includePrerelease: false,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: countedFetch,
  });
  assert.equal(stable1.latestRelease.version, '2.2.6', 'stable check must NOT reuse prerelease cache');
  assert.equal(stable1.fromCache, false);
  assert.equal(fetchCount, 2);

  const pre2 = await checkForUpdates({
    pluginRoot,
    storageRoot: r8StorageRoot,
    force: false,
    includePrerelease: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: countedFetch,
  });
  assert.equal(pre2.fromCache, true);
  assert.equal(pre2.latestRelease.version, '2.2.8-beta.1');
  assert.equal(fetchCount, 2);
});

test('R9: WorkbenchView scopes send/error feedback per session so delayed 503 on Session A never leaks onto Session B', async () => {
  const webRequire = createRequire(path.join(REPO_ROOT, 'packages', 'lt-web', 'package.json'));
  const esbuild = webRequire('esbuild');
  const built = await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, 'packages', 'lt-web', 'src', 'views', 'WorkbenchView.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'transform',
    tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react' } }),
    external: ['react'],
  });
  const compiledJs = built.outputFiles[0].text;

  const states = [];
  const refs = [];
  const callbacks = [];
  const effects = [];
  let stateCursor = 0;
  let refCursor = 0;
  let cbCursor = 0;
  let effectCursor = 0;

  // Strict 6-hook mockReact (also enforces no useMemo/useContext/useReducer invariant!)
  const mockReact = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) =>
      typeof type === 'function'
        ? type(Object.assign({}, props, { children }))
        : { type, props: props || {}, children },
    useState(init) {
      const idx = stateCursor++;
      if (states.length <= idx) states[idx] = typeof init === 'function' ? init() : init;
      const set = next => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], set];
    },
    useRef(init) {
      const idx = refCursor++;
      if (refs.length <= idx) refs[idx] = { current: init };
      return refs[idx];
    },
    useCallback(fn, deps) {
      const idx = cbCursor++;
      const prev = callbacks[idx];
      if (!prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]))) {
        callbacks[idx] = { fn, deps };
      }
      return callbacks[idx].fn;
    },
    useEffect(fn, deps) {
      const idx = effectCursor++;
      effects[idx] = { fn, deps };
    },
  };

  let rejectSessionASend = null;
  const sentToSessions = [];
  let parentDrafts = {};
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  globalThis.window = { location: { pathname: '/lt/' } };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith('/workbench/sessions')) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            sessions: [
              { sessionId: 'sess-a', title: 'Session A', executionMode: 'team', status: 'idle', busy: false },
              { sessionId: 'sess-b', title: 'Session B', executionMode: 'team', status: 'idle', busy: false },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/workbench/transcript')) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            sessionId: body.sessionId || 'sess-a',
            executionMode: 'team',
            canSwitchMode: true,
            messages: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/workbench/session-config')) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            sessionId: body.sessionId || 'sess-a',
            hasOverride: false,
            hasPending: false,
            isBusy: false,
            busyReasons: [],
            effective: { roles: {}, executionPool: [], maxActiveMembers: 3, leaderModelPolicy: 'follow' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/workbench/prompt')) {
      sentToSessions.push(body.sessionId);
      if (body.sessionId === 'sess-a') {
        return await new Promise((_resolve, reject) => {
          rejectSessionASend = () => reject(new Error('HTTP 503 upstream failed for A'));
        });
      }
      return new Response(JSON.stringify({ ok: true, data: { accepted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const mod = { exports: {} };
    const fn = new Function('require', 'module', 'exports', compiledJs);
    fn(id => (id === 'react' ? mockReact : webRequire(id)), mod, mod.exports);
    const { WorkbenchView } = mod.exports;

    const bundle = {
      capabilities: {
        backendLine: 'v2.2.x-oss',
        backendVersion: '2.2.4',
        hostKind: 'dsh-web',
        frontendSwitch: { available: true, currentSurface: 'lt-native', dshFrontendUrl: '../', ltFrontendUrl: './', sharesRuntimeAndSessions: true },
        features: { liveSessionRpc: true, inSessionDualMode: true },
        supportedRoles: [],
      },
      gateway: {},
      providers: [],
      providerPresets: [],
      models: [],
      runtime: {
        modelPool: { configuredRoutes: [], executionPool: [], disabledRoutes: [] },
        roleAssignments: { leader: { route: 'dashscope/qwen-max', effort: 'high', fallback: [] } },
        scheduler: { maxActiveMembers: 4, effectiveCap: 4, activeExecutionMembers: 0, pressureBand: 'normal' },
        teams: [],
      },
      uiPreferences: { theme: 'white', customTheme: {}, usageAnalyticsEnabled: true, autoRefreshMs: 3000 },
      usageStatus: { enabled: true, healthy: true, dshHome: '/tmp', homeExists: true, cachedGatewayRecords: 0, lastSyncAt: null, lastSyncError: null },
    };

    const render = () => {
      stateCursor = 0;
      refCursor = 0;
      cbCursor = 0;
      effectCursor = 0;
      return WorkbenchView({
        bundle,
        onRefreshBundle: async () => {},
        onNavigateTab: () => {},
        draftsBySession: parentDrafts,
        onDraftChange: (sid, txt) => {
          const next = { ...parentDrafts };
          if (txt) next[sid] = txt;
          else delete next[sid];
          parentDrafts = next;
        },
      });
    };

    const collectNodes = (node, acc = []) => {
      if (!node || typeof node !== 'object') return acc;
      if (Array.isArray(node)) {
        for (const n of node) collectNodes(n, acc);
        return acc;
      }
      acc.push(node);
      if (Array.isArray(node.children)) {
        for (const ch of node.children) collectNodes(ch, acc);
      }
      return acc;
    };

    const collectText = node => {
      if (node == null || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(collectText).join(' ');
      if (typeof node === 'object') return collectText(node.children);
      return '';
    };

    render();
    // Trigger initial load effect
    for (const ef of effects) {
      if (typeof ef?.fn === 'function') {
        try { ef.fn(); } catch {}
      }
    }
    await new Promise(r => setTimeout(r, 30));

    // Select Session A, type a prompt, and submit form (stays pending)
    let tree = render();
    const sessionABtn = collectNodes(tree).find(n => n.type === 'button' && collectText(n).includes('Session A'));
    assert.ok(sessionABtn, 'Session A button must render');
    sessionABtn.props.onClick();
    await new Promise(r => setTimeout(r, 20));

    tree = render();
    let textarea = collectNodes(tree).find(n => n.type === 'textarea');
    assert.ok(textarea, 'Prompt textarea must render');
    textarea.props.onChange({ target: { value: 'hello from A' } });

    tree = render();
    let form = collectNodes(tree).find(n => n.type === 'form');
    assert.ok(form, 'Prompt form must render for Session A');
    const sendAPromise = form.props.onSubmit({ preventDefault() {} });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(typeof rejectSessionASend, 'function', 'Session A send must be in flight');

    // Switch to Session B BEFORE Session A rejects
    tree = render();
    const sessionBBtn = collectNodes(tree).find(n => n.type === 'button' && collectText(n).includes('Session B'));
    assert.ok(sessionBBtn, 'Session B button must render');
    sessionBBtn.props.onClick();
    await new Promise(r => setTimeout(r, 20));

    // Now Session A fails with 503 while user is viewing Session B
    rejectSessionASend();
    await sendAPromise;
    await new Promise(r => setTimeout(r, 20));

    // Session B MUST NOT display Session A's error
    tree = render();
    const textOnB = collectText(tree);
    assert.ok(!textOnB.includes('HTTP 503 upstream failed for A'), `Session B must not show Session A 503 error, got: ${textOnB}`);

    // Session B can send independently and succeed
    textarea = collectNodes(tree).find(n => n.type === 'textarea');
    textarea.props.onChange({ target: { value: 'hello from B' } });
    tree = render();
    form = collectNodes(tree).find(n => n.type === 'form');
    await form.props.onSubmit({ preventDefault() {} });
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(sentToSessions, ['sess-a', 'sess-b']);

    // Switching back to Session A reveals Session A's scoped 503 error banner
    tree = render();
    const backToA = collectNodes(tree).find(n => n.type === 'button' && collectText(n).includes('Session A'));
    backToA.props.onClick();
    await new Promise(r => setTimeout(r, 20));
    tree = render();
    const textOnA = collectText(tree);
    assert.ok(textOnA.includes('HTTP 503 upstream failed for A'), 'Session A should retain its own scoped error banner');
  } finally {
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
    globalThis.setInterval = prevSetInterval;
    globalThis.clearInterval = prevClearInterval;
  }
});

test('R10: openai-compatible custom relay discovers and configures live /v1/models (local-reasoner) on both fresh save and re-save', async t => {
  const { dshHome, storageRoot, cfgFile } = makeSandbox(t, 'r10');

  // Local loopback OpenAI-compatible server offering `local-reasoner` & `local-chat`
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'local-reasoner', object: 'model' },
            { id: 'local-chat', object: 'model' },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const customBaseURL = `http://127.0.0.1:${port}/v1`;

  // 1. Fresh save with `openai-compatible` + `apiKey`
  const res1 = await applyQuickOnboardingSetup({
    storageRoot,
    dshHome,
    configPath: cfgFile,
    bundledDefaultConfigPath: path.join(REPO_ROOT, 'config', 'leaderteam.config.json'),
    providerId: 'openai-compatible',
    apiKey: 'local-relay-token-demo',
    customBaseURL,
    verifyConnectivity: true,
  });
  assert.equal(res1.applied, true);
  assert.match(res1.provider.reasoningRoute, /local-reasoner/);
  assert.ok(!res1.provider.reasoningRoute.includes('deepseek-v4-pro'), 'must never fall back to non-existent deepseek-v4-pro');

  // 2. Re-save with empty `apiKey` (relying on saved credential) still discovers `local-reasoner`
  const res2 = await applyQuickOnboardingSetup({
    storageRoot,
    dshHome,
    configPath: cfgFile,
    bundledDefaultConfigPath: path.join(REPO_ROOT, 'config', 'leaderteam.config.json'),
    providerId: 'openai-compatible',
    apiKey: '',
    customBaseURL,
    verifyConnectivity: false,
  });
  assert.equal(res2.applied, true);
  assert.match(res2.provider.reasoningRoute, /local-reasoner/);
  assert.ok(!res2.provider.reasoningRoute.includes('deepseek-v4-pro'));
});

test('R11: Team leader retains web_fetch and web_search via @deepseek-ai/dsh-tool-web while Single mode retains 11 direct tools', () => {
  const cordisYml = fs.readFileSync(path.join(REPO_ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(cordisYml, /@deepseek-ai\/dsh-tool-web/, 'cordis.patch.yml must mount @deepseek-ai/dsh-tool-web');
  assert.match(cordisYml, /fetch:\s*true/, 'tool-web must enable web_fetch');

  const cfg = loadConfig(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'));
  const rt = { config: cfg, activePlugins: { scheduler: true, consensus: true, timerArchive: true, panel: true } };
  const teamTools = leaderAllowedTools(rt, 'team', 'linux');
  const singleTools = leaderAllowedTools(rt, 'single', 'linux');

  assert.ok(teamTools.includes('web_fetch'), 'Team leader must retain web_fetch');
  assert.ok(teamTools.includes('web_search'), 'Team leader must retain web_search');
  assert.equal(singleTools.length, 11, 'Single mode on Linux must retain 11 direct tools');
});

test('PUB-01: standalone install-leaderteam.sh boots from sibling .tgz or unpacked package/ without repo checkout', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v224-pub01-'));
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  const installerScriptSrc = path.join(REPO_ROOT, 'install-leaderteam.sh');
  const mockTgzBuf = buildSyntheticTgz([
    {
      name: 'package/package.json',
      data: JSON.stringify({
        name: 'dsh-leaderteam',
        version: '2.2.4',
        engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    },
    {
      name: 'package/cordis.patch.yml',
      data: '- name: dsh-leaderteam/core\n',
    },
    {
      name: 'package/leaderteam/package.json',
      data: JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.4', leaderteam: { distributionTrack: 'open-source' } }),
    },
    {
      name: 'package/leaderteam/core/installer.mjs',
      data: 'export const ok = true;\n',
    },
    {
      name: 'package/bin/lt-installer.mjs',
      data: 'console.log(JSON.stringify({ ok: true, sourceDir: process.env.LT_INSTALLER_SOURCE_DIR || null, args: process.argv.slice(2) }));\n',
      mode: 0o755,
    },
  ]);

  // Case A: GitHub Release download folder with ONLY `install-leaderteam.sh` + `dsh-leaderteam-2.2.4.tgz`
  const releaseDir = path.join(tmp, 'release-assets-only');
  fs.mkdirSync(releaseDir, { recursive: true });
  const scriptA = path.join(releaseDir, 'install-leaderteam.sh');
  fs.copyFileSync(installerScriptSrc, scriptA);
  fs.chmodSync(scriptA, 0o755);
  fs.writeFileSync(path.join(releaseDir, 'dsh-leaderteam-2.2.4.tgz'), mockTgzBuf);

  const runA = spawnSync('bash', [scriptA, '--inspect', '--json'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(runA.status, 0, `Case A failed: stderr=${runA.stderr}`);
  const outA = JSON.parse(runA.stdout.trim());
  assert.equal(outA.ok, true);
  assert.equal(fs.realpathSync(outA.sourceDir), fs.realpathSync(releaseDir));
  assert.ok(outA.args.includes('--inspect') && outA.args.includes('--json'));

  // Case B: Unpacked tarball (`package/bin/lt-installer.mjs`) next to `install-leaderteam.sh`
  const unpackedDir = path.join(tmp, 'unpacked-layout');
  fs.mkdirSync(path.join(unpackedDir, 'package', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(unpackedDir, 'package', 'leaderteam', 'core'), { recursive: true });
  const scriptB = path.join(unpackedDir, 'install-leaderteam.sh');
  fs.copyFileSync(installerScriptSrc, scriptB);
  fs.chmodSync(scriptB, 0o755);
  fs.writeFileSync(path.join(unpackedDir, 'package', 'leaderteam', 'core', 'installer.mjs'), 'export const ok = true;\n');
  fs.writeFileSync(
    path.join(unpackedDir, 'package', 'bin', 'lt-installer.mjs'),
    'console.log(JSON.stringify({ ok: true, unpacked: true, sourceDir: process.env.LT_INSTALLER_SOURCE_DIR || null }));\n',
  );
  const runB = spawnSync('bash', [scriptB, '--inspect', '--json'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(runB.status, 0, `Case B failed: stderr=${runB.stderr}`);
  const outB = JSON.parse(runB.stdout.trim());
  assert.equal(outB.ok, true);
  assert.equal(outB.unpacked, true);

  // Case C: `inspectInstallerEnvironment` locates sibling tarball via `LT_INSTALLER_SOURCE_DIR`
  const emptyCwd = path.join(tmp, 'empty-cwd');
  fs.mkdirSync(emptyCwd, { recursive: true });
  const envInfo = inspectInstallerEnvironment({
    cwd: emptyCwd,
    env: { ...process.env, LT_INSTALLER_SOURCE_DIR: releaseDir },
  });
  assert.ok(envInfo.bundledTarballs.some(b => b.path === path.join(releaseDir, 'dsh-leaderteam-2.2.4.tgz')));
});
