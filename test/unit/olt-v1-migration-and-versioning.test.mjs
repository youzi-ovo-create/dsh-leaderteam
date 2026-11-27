import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  OLT_BRAND_ID,
  LEGACY_LT_EPOCH,
  OLT_RELEASE_EPOCH,
  inferPackageReleaseEpoch,
  inferGitHubReleaseEpoch,
  compareReleaseVersions,
  parseReleaseTagForPlatform,
  selectReleasesForPlatform,
  checkForUpdates,
  createPreUpgradeBackup,
  verifyBackupSnapshotIntegrity,
  performOneClickUpgrade,
  rollbackToSavedBackup,
} from '../../leaderteam/core/updater.mjs';
import { inspectInstallerEnvironment } from '../../leaderteam/core/installer.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

function makeTmp(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `olt-v1-${label}-`));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('OLT V1.0.0 epoch comparison: OLT 1.0.0 > legacy LT 2.2.3, future OLT 1.0.1/2.0.0 > OLT 1.0.0, closed-free unaffected', () => {
  assert.equal(inferPackageReleaseEpoch({ version: '2.2.3', track: 'open-source' }), LEGACY_LT_EPOCH);
  assert.equal(inferPackageReleaseEpoch({ version: '1.0.0', track: 'open-source' }), OLT_RELEASE_EPOCH);
  assert.equal(
    inferPackageReleaseEpoch({
      version: '2.0.0',
      track: 'open-source',
      rootPkg: { leaderteam: { brand: OLT_BRAND_ID, releaseEpoch: 2 } },
    }),
    OLT_RELEASE_EPOCH,
  );
  assert.equal(inferPackageReleaseEpoch({ version: '2.5.1', track: 'closed-free' }), LEGACY_LT_EPOCH);

  assert.ok(
    compareReleaseVersions(
      { version: '1.0.0', releaseEpoch: OLT_RELEASE_EPOCH, track: 'open-source' },
      { version: '2.2.3', releaseEpoch: LEGACY_LT_EPOCH, track: 'open-source' },
    ) > 0,
    'OLT 1.0.0 MUST sort strictly newer than legacy LT 2.2.3',
  );
  assert.ok(
    compareReleaseVersions(
      { version: '2.2.3', releaseEpoch: LEGACY_LT_EPOCH, track: 'open-source' },
      { version: '1.0.0', releaseEpoch: OLT_RELEASE_EPOCH, track: 'open-source' },
    ) < 0,
    'Legacy LT 2.2.3 MUST sort strictly older than OLT 1.0.0',
  );
  assert.ok(
    compareReleaseVersions(
      { version: '1.0.1', releaseEpoch: OLT_RELEASE_EPOCH, track: 'open-source' },
      { version: '1.0.0', releaseEpoch: OLT_RELEASE_EPOCH, track: 'open-source' },
    ) > 0,
  );
  assert.ok(
    compareReleaseVersions(
      { version: '2.0.0', releaseEpoch: OLT_RELEASE_EPOCH, track: 'open-source' },
      { version: '1.0.0', releaseEpoch: OLT_RELEASE_EPOCH, track: 'open-source' },
    ) > 0,
  );
  assert.ok(
    compareReleaseVersions(
      { version: '2.6.0', releaseEpoch: LEGACY_LT_EPOCH, track: 'closed-free' },
      { version: '2.5.1', releaseEpoch: LEGACY_LT_EPOCH, track: 'closed-free' },
    ) > 0,
  );

  // Tag parsing accepts canonical `linux-v1.0.0` AND optional `olt-linux-v1.0.0`
  assert.deepEqual(parseReleaseTagForPlatform('linux-v1.0.0'), {
    tagName: 'linux-v1.0.0',
    version: '1.0.0',
    prefix: 'linux',
    platformScope: 'linux',
  });
  assert.deepEqual(parseReleaseTagForPlatform('olt-linux-v1.0.0'), {
    tagName: 'olt-linux-v1.0.0',
    version: '1.0.0',
    prefix: 'linux',
    platformScope: 'linux',
  });
  assert.equal(
    inferGitHubReleaseEpoch(
      { tag_name: 'linux-v2.0.0', name: 'Open Leader Team (OLT) linux-v2.0.0', body: '<!-- LT-RELEASE-EPOCH: 2 -->' },
      { track: 'open-source', parsedTag: parseReleaseTagForPlatform('linux-v2.0.0') },
    ),
    OLT_RELEASE_EPOCH,
  );
});

test('OLT V1.0.0 auto-updater: legacy LT 2.2.3 sees OLT 1.0.0 as forward migration upgrade, and OLT 1.0.0 NEVER downgrades to legacy 2.2.3', async t => {
  const tmp = makeTmp(t, 'updater');
  const storageRoot = path.join(tmp, 'leaderteam');
  fs.mkdirSync(storageRoot, { recursive: true });

  const mixedFeed = [
    {
      tag_name: 'linux-v2.2.3',
      name: 'LeaderTeam linux-v2.2.3 (2.2.3 · Linux x64)',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-2.2.3-linux-x64.tgz', browser_download_url: 'https://mock/223.tgz' }],
    },
    {
      tag_name: 'linux-v1.0.0',
      name: 'Open Leader Team (OLT) linux-v1.0.0 (1.0.0 · Linux x64)',
      body: '<!-- LT-RELEASE-EPOCH: 2 -->\nFirst Open Leader Team release.',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-1.0.0-linux-x64.tgz', browser_download_url: 'https://mock/olt100.tgz' }],
    },
    {
      tag_name: 'windows-v1.0.0',
      name: 'Open Leader Team (OLT) windows-v1.0.0 (1.0.0 · Windows x64)',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-1.0.0.tgz', browser_download_url: 'https://mock/olt100-win.tgz' }],
    },
    {
      tag_name: 'linux-v2.2.2',
      name: 'LeaderTeam linux-v2.2.2',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-2.2.2-linux-x64.tgz', browser_download_url: 'https://mock/222.tgz' }],
    },
  ];

  // Platform selection sorts OLT linux-v1.0.0 ABOVE historical linux-v2.2.3
  const selected = selectReleasesForPlatform(mixedFeed, { track: 'open-source', platform: 'linux', arch: 'x64' });
  assert.deepEqual(selected.map(r => r.tagName), ['linux-v1.0.0', 'linux-v2.2.3', 'linux-v2.2.2']);

  // 1. Legacy LT 2.2.3 installed -> sees OLT 1.0.0 as forward migration upgrade (NOT downgrade!)
  const legacy223Dir = path.join(tmp, 'legacy-223');
  fs.mkdirSync(path.join(legacy223Dir, 'leaderteam'), { recursive: true });
  fs.writeFileSync(path.join(legacy223Dir, 'package.json'), JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.3' }));
  fs.writeFileSync(path.join(legacy223Dir, 'leaderteam', 'package.json'), JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.3', leaderteam: { distributionTrack: 'open-source' } }));

  const legacyCheck = await checkForUpdates({
    pluginRoot: legacy223Dir,
    storageRoot,
    force: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(JSON.stringify(mixedFeed), { status: 200 }),
  });
  assert.equal(legacyCheck.hasUpdate, true);
  assert.equal(legacyCheck.isDowngrade, false);
  assert.equal(legacyCheck.migrationFromLegacyLt, true);
  assert.equal(legacyCheck.latestRelease.tagName, 'linux-v1.0.0');
  assert.equal(legacyCheck.latestRelease.releaseEpoch, OLT_RELEASE_EPOCH);

  // 2. OLT 1.0.0 installed -> MUST NOT offer historical linux-v2.2.3 as an update, and MUST NOT reuse legacy cache!
  const olt100Dir = path.join(tmp, 'olt-100');
  fs.mkdirSync(path.join(olt100Dir, 'leaderteam'), { recursive: true });
  fs.writeFileSync(
    path.join(olt100Dir, 'package.json'),
    JSON.stringify({ name: 'dsh-leaderteam', version: '1.0.0', leaderteam: { brand: OLT_BRAND_ID, releaseEpoch: 2 } }),
  );
  fs.writeFileSync(
    path.join(olt100Dir, 'leaderteam', 'package.json'),
    JSON.stringify({ name: 'dsh-leaderteam-internal', version: '1.0.0', leaderteam: { distributionTrack: 'open-source', brand: OLT_BRAND_ID, releaseEpoch: 2 } }),
  );

  const oltCheck = await checkForUpdates({
    pluginRoot: olt100Dir,
    storageRoot,
    force: false,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(JSON.stringify(mixedFeed), { status: 200 }),
  });
  assert.equal(oltCheck.fromCache, false, 'migrated OLT installation must not hit legacy LT cache');
  assert.equal(oltCheck.hasUpdate, false, 'OLT 1.0.0 must NOT treat historical linux-v2.2.3 as an upgrade');
  assert.equal(oltCheck.latestRelease.tagName, 'linux-v1.0.0');

  // 3. OLT 1.0.0 detects future OLT 1.0.1 and future OLT 2.0.0 (epoch 2) cleanly
  const nextFeed = [
    {
      tag_name: 'linux-v1.0.1',
      name: 'Open Leader Team (OLT) linux-v1.0.1',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-1.0.1-linux-x64.tgz', browser_download_url: 'https://mock/olt101.tgz' }],
    },
    ...mixedFeed,
  ];
  const nextCheck = await checkForUpdates({
    pluginRoot: olt100Dir,
    storageRoot,
    force: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(JSON.stringify(nextFeed), { status: 200 }),
  });
  assert.equal(nextCheck.hasUpdate, true);
  assert.equal(nextCheck.latestRelease.tagName, 'linux-v1.0.1');
});

test('OLT V1.0.0 migration upgrade, backup integrity protection, and rollback to legacy LT 2.2.3', async t => {
  const tmp = makeTmp(t, 'migrate-rb');
  const dshHome = path.join(tmp, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });

  const cfgPath = path.join(storageRoot, 'config', 'leaderteam.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ team: { leaderModelPolicy: 'warn', maxActiveMembers: 4 } }, null, 2));
  fs.mkdirSync(path.join(storageRoot, 'updater'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'updater', 'compat-downgraded-policy.json'),
    JSON.stringify({ v: 1, files: { 'leaderteam.config.json': 'follow' }, teams: {} }),
  );

  // Installed Legacy LT 2.2.3
  const legacyDir = path.join(tmp, 'installed-legacy-223');
  fs.mkdirSync(path.join(legacyDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(legacyDir, 'leaderteam', 'core'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'package.json'), JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.3', bin: { 'lt-ui': './bin/lt-ui.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  fs.writeFileSync(path.join(legacyDir, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'package.json'), JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.3', leaderteam: { distributionTrack: 'open-source' } }));
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'entry-core.mjs'), 'export const name = "core";\n');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'core', 'config.mjs'), 'export const POLICIES = ["enforce", "warn", "off"];\n');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'index.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'public-api.mjs'), 'export const c = 1;\n');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'index.html'), '<html><script src="./assets/index-old.js"></script></html>');
  fs.writeFileSync(path.join(legacyDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'assets', 'index-old.js'), 'console.log(1);');

  const oltTgzBuf = buildSyntheticTgz([
    {
      name: 'package/package.json',
      data: JSON.stringify({
        name: 'dsh-leaderteam',
        version: '1.0.0',
        license: 'Apache-2.0',
        engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
        leaderteam: { distributionTrack: 'open-source', brand: OLT_BRAND_ID, releaseEpoch: 2 },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    },
    {
      name: 'package/leaderteam/package.json',
      data: JSON.stringify({
        name: 'dsh-leaderteam-internal',
        version: '1.0.0',
        leaderteam: { distributionTrack: 'open-source', brand: OLT_BRAND_ID, releaseEpoch: 2 },
      }),
    },
    { name: 'package/cordis.patch.yml', data: '- name: dsh-leaderteam/core\n' },
    { name: 'package/leaderteam/core/config.mjs', data: 'export const POLICIES = ["follow", "enforce", "warn", "off"];\n' },
  ]);
  const oltTgzPath = path.join(tmp, 'dsh-leaderteam-1.0.0-linux-x64.tgz');
  fs.writeFileSync(oltTgzPath, oltTgzBuf);

  // 1. Upgrade Legacy LT 2.2.3 -> OLT 1.0.0: recognized as forward migration (NOT downgrade) and restores `follow`
  const upg = await performOneClickUpgrade({
    pluginRoot: legacyDir,
    storageRoot,
    dshHome,
    localTgzPath: oltTgzPath,
    expectedSha256: sha256(oltTgzBuf),
    currentHostVersion: '0.2.2-rc.5',
    installerHook: async () => ({ requiresRestart: true }),
  });
  assert.equal(upg.ok, true);
  assert.equal(upg.migrationFromLegacyLt, true);
  assert.equal(upg.isDowngrade, false);
  assert.equal(upg.fromVersion, '2.2.3');
  assert.equal(upg.fromEpoch, LEGACY_LT_EPOCH);
  assert.equal(upg.toVersion, '1.0.0');
  assert.equal(upg.toEpoch, OLT_RELEASE_EPOCH);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).team.leaderModelPolicy, 'follow');

  // 2. Roll back from OLT 1.0.0 -> saved Legacy LT 2.2.3 backup works cleanly and reconciles policy for legacy target
  const rb = await rollbackToSavedBackup({
    storageRoot,
    dshHome,
    backupId: upg.backupId,
    installerHook: async () => {},
  });
  assert.equal(rb.ok, true);
  assert.equal(rb.restoredVersion, '2.2.3');
  assert.equal(rb.restoredEpoch, LEGACY_LT_EPOCH);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).team.leaderModelPolicy, 'warn');

  // 3. OLT 1.0.0 backup missing web-dist/ & public-api.mjs MUST fail closed (never treated as pre-2.2.2 V2.2.1!)
  const oltPluginDir = path.join(tmp, 'installed-olt-100');
  fs.mkdirSync(path.join(oltPluginDir, 'leaderteam', 'plugins', 'leaderteam-panel'), { recursive: true });
  fs.writeFileSync(
    path.join(oltPluginDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-leaderteam',
      version: '1.0.0',
      leaderteam: { brand: OLT_BRAND_ID, releaseEpoch: 2 },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  fs.writeFileSync(path.join(oltPluginDir, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
  fs.writeFileSync(
    path.join(oltPluginDir, 'leaderteam', 'package.json'),
    JSON.stringify({ name: 'dsh-leaderteam-internal', version: '1.0.0', leaderteam: { distributionTrack: 'open-source', brand: OLT_BRAND_ID, releaseEpoch: 2 } }),
  );
  fs.writeFileSync(path.join(oltPluginDir, 'leaderteam', 'entry-core.mjs'), 'export const name = "core";\n');
  fs.writeFileSync(path.join(oltPluginDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'index.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(oltPluginDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'export const b = 1;\n');

  const brokenOltBackup = createPreUpgradeBackup({
    storageRoot,
    pluginRoot: oltPluginDir,
    targetVersion: '1.0.1',
    targetTrack: 'open-source',
  });
  const checkBroken = verifyBackupSnapshotIntegrity(brokenOltBackup.manifest);
  assert.equal(checkBroken.intact, false, 'OLT 1.0.0 backup missing public-api.mjs / web-dist must NEVER pass as pre-2.2.2');
  assert.ok(checkBroken.missing.includes('leaderteam/plugins/leaderteam-panel/public-api.mjs'));
  assert.ok(checkBroken.missing.includes('leaderteam/plugins/leaderteam-panel/web-dist/index.html'));
});

test('OLT V1.0.0 installer & install-leaderteam.sh prefer OLT 1.0.0 over co-located legacy 2.2.3 tarball', t => {
  const tmp = makeTmp(t, 'mixed-folder');
  const dlDir = path.join(tmp, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });

  const makeMockTgz = (ver, extraMeta = {}) =>
    buildSyntheticTgz([
      {
        name: 'package/package.json',
        data: JSON.stringify({
          name: 'dsh-leaderteam',
          version: ver,
          engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
          ...extraMeta,
        }),
      },
      { name: 'package/cordis.patch.yml', data: '- name: dsh-leaderteam/core\n' },
      { name: 'package/leaderteam/package.json', data: JSON.stringify({ name: 'dsh-leaderteam-internal', version: ver, leaderteam: { distributionTrack: 'open-source', ...(extraMeta.leaderteam || {}) } }) },
      { name: 'package/leaderteam/core/installer.mjs', data: 'export const ok = true;\n' },
      { name: 'package/bin/lt-installer.mjs', data: `console.log(JSON.stringify({ selectedVersion: ${JSON.stringify(ver)} }));\n`, mode: 0o755 },
    ]);

  fs.writeFileSync(path.join(dlDir, 'dsh-leaderteam-2.2.3.tgz'), makeMockTgz('2.2.3'));
  fs.writeFileSync(
    path.join(dlDir, 'dsh-leaderteam-1.0.0-linux-x64.tgz'),
    makeMockTgz('1.0.0', { leaderteam: { brand: OLT_BRAND_ID, releaseEpoch: 2 } }),
  );
  const scriptPath = path.join(dlDir, 'install-leaderteam.sh');
  fs.copyFileSync(path.join(REPO_ROOT, 'install-leaderteam.sh'), scriptPath);
  fs.chmodSync(scriptPath, 0o755);

  // 1. inspectInstallerEnvironment ranks OLT 1.0.0 ahead of legacy 2.2.3
  const envSnap = inspectInstallerEnvironment({
    cwd: tmp,
    env: { ...process.env, LT_INSTALLER_SOURCE_DIR: dlDir },
  });
  assert.equal(envSnap.bundledTarballs[0].version, '1.0.0');
  assert.equal(envSnap.bundledTarballs[0].releaseEpoch, OLT_RELEASE_EPOCH);

  // 2. install-leaderteam.sh extracts and runs OLT 1.0.0 instead of legacy 2.2.3
  const runSh = spawnSync('bash', [scriptPath, '--inspect', '--json'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(runSh.status, 0, `stderr=${runSh.stderr}`);
  assert.equal(JSON.parse(runSh.stdout.trim()).selectedVersion, '1.0.0');
});
