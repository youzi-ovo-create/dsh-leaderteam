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
  VERIFIED_CORE_VERSIONS,
  SUPPORTED_DSH_ENGINE_RANGE,
  parseDshSemver,
  compareDshSemver,
  satisfiesDshRange,
  evaluateDispatchToolBodyContract,
  evaluateHostCompatibility,
  getHostCompatibilityMatrix,
} from '../../leaderteam/core/host-compat.mjs';
import {
  UPDATE_TRACKS,
  parseReleaseTagInfo,
  assertPlatformReleaseTagCompatible,
  filterReleasesForPlatform,
  requiredTrackSwitchToken,
  validateTrackSwitch,
  parseSha256SumsText,
  inspectTgzPackage,
  checkCandidatePackageCompatibility,
  checkForUpdates,
  performOneClickUpgrade,
  rollbackToSavedBackup,
} from '../../leaderteam/core/updater.mjs';
import {
  TEAM_COLLAB_PRESETS,
  STARTER_TASK_TEMPLATES,
  applyQuickOnboardingSetup,
} from '../../leaderteam/core/onboarding.mjs';
import { syncUpstreamModelsToDshSettings } from '../../leaderteam/core/upstream-models.mjs';
import { buildSoloProviderSettingsTemplates } from '../../leaderteam/core/solo-key.mjs';
import {
  translateInstallErrorToPlainChinese,
  inspectInstallerEnvironment,
  runOneClickInstallation,
} from '../../leaderteam/core/installer.mjs';
import { startInstallerGuiServer } from '../../bin/lt-installer.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

/** Build a minimal valid POSIX `.tgz` buffer containing `package/package.json` and `package/leaderteam/package.json`. */
function createSyntheticLtTgz({
  version = '2.2.9',
  track = 'open-source',
  enginesDsh = '>=0.2.2-alpha.2 <1.0.0',
  nativeFiles = [],
} = {}) {
  const entries = [
    {
      name: 'package/package.json',
      data: Buffer.from(
        JSON.stringify(
          {
            name: 'dsh-leaderteam',
            version,
            license: track === 'open-source' ? 'Apache-2.0' : 'UNLICENSED',
            engines: { node: '>=22.15', dsh: enginesDsh },
            dsh: { bundle: { patch: './cordis.patch.yml' } },
          },
          null,
          2,
        ),
        'utf8',
      ),
    },
    {
      name: 'package/leaderteam/package.json',
      data: Buffer.from(
        JSON.stringify(
          {
            name: 'dsh-leaderteam-internal',
            version,
            leaderteam: {
              distributionTrack: track,
              supportedCoreRange: enginesDsh,
              compatibilityPolicy: 'adaptive',
              supportedCoreVersions: [...VERIFIED_CORE_VERSIONS],
            },
          },
          null,
          2,
        ),
        'utf8',
      ),
    },
    {
      name: 'package/cordis.patch.yml',
      data: Buffer.from('- name: dsh-leaderteam/core\n', 'utf8'),
    },
    ...nativeFiles.map(nf => ({
      name: `package/leaderteam/native/${nf}`,
      data: Buffer.from('FAKE_NATIVE_BINARY', 'utf8'),
    })),
  ];

  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, Math.min(100, Buffer.byteLength(entry.name)), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156); // checksum placeholder spaces
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    header.write(`${chksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    blocks.push(header);
    blocks.push(entry.data);
    const rem = entry.data.length % 512;
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // EOF blocks
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('Issue #1: SemVer comparator, structural pipeline contract, adaptive host policy & matrix CLI', () => {
  const ordered = [
    '0.2.0-rc.2',
    '0.2.1-rc.5',
    '0.2.2-alpha.2',
    '0.2.2-alpha.3',
    '0.2.2-rc.1',
    '0.2.2-rc.4',
    '0.2.2-rc.5',
    '0.2.2',
    '0.2.3-alpha.1',
    '0.2.3-alpha.2',
    '0.2.3',
    '0.9.9',
    '1.0.0-alpha.1',
    '1.0.0',
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(
      compareDshSemver(ordered[i], ordered[i + 1]),
      -1,
      `expected ${ordered[i]} < ${ordered[i + 1]}`,
    );
  }
  assert.equal(satisfiesDshRange('0.2.1-rc.5', SUPPORTED_DSH_ENGINE_RANGE), false);
  assert.equal(satisfiesDshRange('0.2.2-alpha.2', SUPPORTED_DSH_ENGINE_RANGE), true);
  assert.equal(satisfiesDshRange('0.2.2-rc.3', SUPPORTED_DSH_ENGINE_RANGE), true);
  assert.equal(satisfiesDshRange('0.2.2', SUPPORTED_DSH_ENGINE_RANGE), true);
  assert.equal(satisfiesDshRange('0.2.3-alpha.2', SUPPORTED_DSH_ENGINE_RANGE), true);
  assert.equal(satisfiesDshRange('0.3.1', SUPPORTED_DSH_ENGINE_RANGE), true);
  assert.equal(satisfiesDshRange('1.0.0-alpha.1', SUPPORTED_DSH_ENGINE_RANGE), false);
  assert.equal(satisfiesDshRange('1.0.0', SUPPORTED_DSH_ENGINE_RANGE), false);

  // Structural contract tolerates transpiler/bundler idioms (`undefined`, `Boolean()`, formatting)
  const transpiledVariant = `
    async dispatchToolBody(ctxExec) {
      const def = this.resolveExecution(
        ctxExec.name,
        ctxExec.agent,
        Boolean(ctxExec.parent),
        ctxExec.toolSet
      );
      return await def.execute(ctxExec.arguments, ctxExec);
    }
  `;
  const variantRes = evaluateDispatchToolBodyContract(transpiledVariant);
  assert.equal(variantRes.compatible, true);
  assert.equal(variantRes.exactCanonicalMatch, false);

  // Reversed or missing resolveExecution MUST fail closed
  const brokenVariant = `
    async dispatchToolBody(exec) {
      return await tool.execute(exec.arguments, exec);
    }
  `;
  assert.equal(evaluateDispatchToolBodyContract(brokenVariant).compatible, false);

  const adaptiveEval = evaluateHostCompatibility({
    toolsVersion: '0.2.4',
    pipelineSource: transpiledVariant,
    policy: 'adaptive',
  });
  assert.equal(adaptiveEval.classification, 'CONTRACT_COMPATIBLE');
  assert.equal(adaptiveEval.productionAllowed, true);

  const cliMatrix = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/lt-doctor.mjs'), '--compatibility-matrix', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(cliMatrix.status, 0, cliMatrix.stderr);
  const matrixJson = JSON.parse(cliMatrix.stdout);
  assert.equal(matrixJson.engineRange, SUPPORTED_DSH_ENGINE_RANGE);
  assert.ok(matrixJson.verifiedVersions.includes('0.2.3-alpha.2'));
  assert.ok(matrixJson.rows.length >= 6);
});

test('Issue #2: One-Click Graphical Installer environment detection, CSRF security, error translation & Onboarding API', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-issue2-test-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const mockDshDir = path.join(tmp, 'mock-dsh-cli');
    fs.mkdirSync(path.join(mockDshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(mockDshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin\n');
    fs.mkdirSync(path.join(mockDshDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(mockDshDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.3-alpha.2' }),
    );
    fs.writeFileSync(
      path.join(mockDshDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'pipeline.js'),
      `export class ToolExecutionPipeline {
        resolveExecution() {}
        async dispatchToolBody(exec) {
          const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
          return await tool.execute(exec.arguments, exec);
        }
      }`,
    );

    const envSnap = inspectInstallerEnvironment({
      repoRoot: REPO_ROOT,
      dshHome,
      customDshPath: mockDshDir,
    });
    const matchedTarget = envSnap.targets.find(t => t.installDir === mockDshDir);
    assert.ok(matchedTarget, 'detects custom DSH 0.2.3-alpha.2 installation');
    assert.equal(matchedTarget.compatibility.classification, 'VERIFIED');
    assert.equal(matchedTarget.compatibility.productionAllowed, true);

    // Error translation checks
    assert.equal(translateInstallErrorToPlainChinese('SHA256_MISMATCH').code, 'SHA256_MISMATCH');
    assert.equal(translateInstallErrorToPlainChinese('EBUSY: still running in this profile').code, 'CLIENT_RUNNING_OR_LOCKED');
    assert.equal(translateInstallErrorToPlainChinese('spawn pnpm ENOENT').code, 'PNPM_MISSING');

    // Automated install with starter API key provisioning
    const tgzBuf = createSyntheticLtTgz({ version: '2.2.2', track: 'open-source' });
    const localTgz = path.join(tmp, 'dsh-leaderteam-2.2.2.tgz');
    fs.writeFileSync(localTgz, tgzBuf);

    let runnerCalledWith = null;
    const installRes = await runOneClickInstallation({
      repoRoot: REPO_ROOT,
      dshHome,
      targetId: matchedTarget.id,
      sourceKind: 'local-tgz',
      localTgzPath: localTgz,
      providerId: 'deepseek',
      apiKey: 'sk-test-onboarding-secret-9999',
      installerRunner: async args => {
        runnerCalledWith = args;
      },
    });
    assert.equal(installRes.ok, true);
    assert.equal(installRes.installedVersion, '2.2.2');
    assert.equal(installRes.starterModelConfigured, true);
    assert.equal(runnerCalledWith.installSpec, localTgz);
    const envFileText = fs.readFileSync(path.join(dshHome, '.env'), 'utf8');
    assert.match(envFileText, /DEEPSEEK_API_KEY="sk-test-onboarding-secret-9999"/);
    const credYamlText = fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8');
    assert.match(credYamlText, /^version:\s*1/m);
    assert.match(credYamlText, /DEEPSEEK_API_KEY:\s*"sk-test-onboarding-secret-9999"/);

    // Verify v2.2.2 strictly advertises Team-mode presets only (no Single-mode leak)
    assert.equal(TEAM_COLLAB_PRESETS.every(p => p.defaultSessionMode === 'team'), true);
    assert.equal(STARTER_TASK_TEMPLATES.every(t => t.recommendedMode === 'team'), true);

    // Loopback GUI server auth & CSRF fences
    const gui = await startInstallerGuiServer({ port: 0, dshHome, repoRoot: REPO_ROOT, openBrowser: false });
    try {
      const unauth = await fetch(`http://127.0.0.1:${gui.port}/api/installer/inspect`, { method: 'POST' });
      assert.equal(unauth.status, 401);

      const crossOrigin = await fetch(`http://127.0.0.1:${gui.port}/api/installer/inspect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gui.launchToken}`,
          Origin: 'http://evil.example.com',
        },
      });
      assert.equal(crossOrigin.status, 403);

      const okInspect = await fetch(`http://127.0.0.1:${gui.port}/api/installer/inspect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gui.launchToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ customDshPath: mockDshDir }),
      });
      assert.equal(okInspect.status, 200);
      const okJson = await okInspect.json();
      assert.equal(okJson.ok, true);
    } finally {
      await gui.close();
    }

    // Public API Onboarding endpoint end-to-end (ensuring zero raw API key leakage & contractVersion 1.0.1)
    const handlers = createPublicContractHandlers(null, { config: null, configPath: null, storageRoot: null }, { dshHome });
    const setupReq = new Request('http://127.0.0.1/api/lt/v1/onboarding', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'apply-quick-setup',
        providerId: 'dashscope',
        apiKey: 'sk-dashscope-super-secret-123456',
        collabPresetId: 'lightweight-team',
      }),
    });
    const setupRes = await handlers.onboarding(setupReq);
    const setupJson = await setupRes.json();
    assert.equal(setupJson.ok, true);
    assert.equal(setupJson.contractVersion, '1.0.1');
    assert.equal(setupJson.data.provider.id, 'dashscope');
    assert.equal(setupJson.data.collabPreset.defaultSessionMode, 'team');
    assert.ok(!JSON.stringify(setupJson).includes('sk-dashscope-super-secret-123456'), 'raw key never leaked in response');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Issue #3: Dual-track isolation, SHA-256 verification, host pre-check, data preservation & automatic rollback', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-issue3-test-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(storageRoot, 'teams', 'session-keep-1'), { recursive: true });

    // Seed pre-existing model config, UI preferences, and team history to verify 100% preservation
    const localCfgPath = path.join(storageRoot, 'config', 'leaderteam.local.json');
    const memberLedgerPath = path.join(storageRoot, 'teams', 'session-keep-1', 'members.jsonl');
    fs.writeFileSync(localCfgPath, JSON.stringify({ customMarker: 'preserve-me' }, null, 2));
    fs.writeFileSync(memberLedgerPath, '{"id":"m1","status":"done"}\n');

    // Create isolated installed plugin root v2.2.2 (open-source)
    const fakePluginRoot = path.join(tmp, 'installed-plugin');
    fs.mkdirSync(path.join(fakePluginRoot, 'leaderteam'), { recursive: true });
    fs.writeFileSync(
      path.join(fakePluginRoot, 'package.json'),
      JSON.stringify({
        name: 'dsh-leaderteam',
        version: '2.2.2',
        license: 'Apache-2.0',
        engines: { dsh: SUPPORTED_DSH_ENGINE_RANGE },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    );
    fs.writeFileSync(
      path.join(fakePluginRoot, 'leaderteam', 'package.json'),
      JSON.stringify({
        name: 'dsh-leaderteam-internal',
        version: '2.2.2',
        leaderteam: { distributionTrack: 'open-source', supportedCoreVersions: [...VERIFIED_CORE_VERSIONS] },
      }),
    );
    fs.writeFileSync(path.join(fakePluginRoot, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');

    // 1. Track switch without explicit confirmation token MUST fail with TRACK_SWITCH_CONFIRMATION_REQUIRED
    assert.throws(
      () => validateTrackSwitch({ currentTrack: 'open-source', targetTrack: 'closed-free' }),
      err => err.code === 'TRACK_SWITCH_CONFIRMATION_REQUIRED' && err.statusCode === 409,
    );
    assert.equal(
      validateTrackSwitch({
        currentTrack: 'open-source',
        targetTrack: 'closed-free',
        confirmTrackSwitch: requiredTrackSwitchToken('closed-free'),
      }),
      'closed-free',
    );

    // 2. Build mock v2.2.9 release tarball + SHA256SUMS.txt
    const v229Tgz = createSyntheticLtTgz({ version: '2.2.9', track: 'open-source' });
    const v229Sha = crypto.createHash('sha256').update(v229Tgz).digest('hex');
    const sumsText = `${v229Sha}  dsh-leaderteam-2.2.9.tgz\n`;
    assert.equal(parseSha256SumsText(sumsText, 'dsh-leaderteam-2.2.9.tgz'), v229Sha);

    const mockFetch = async url => {
      const u = String(url);
      if (u.includes('/repos/youzi-ovo-create/dsh-leaderteam/releases')) {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'v2.2.9',
              name: 'LeaderTeam v2.2.9',
              prerelease: false,
              published_at: '2026-11-26T12:00:00Z',
              body: '### Highlights\n- Auto update & rollback',
              assets: [
                {
                  name: 'dsh-leaderteam-2.2.9.tgz',
                  size: v229Tgz.length,
                  browser_download_url: 'https://mock.example/dsh-leaderteam-2.2.9.tgz',
                },
                {
                  name: 'SHA256SUMS.txt',
                  size: sumsText.length,
                  browser_download_url: 'https://mock.example/SHA256SUMS.txt',
                },
              ],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u === 'https://mock.example/SHA256SUMS.txt') {
        return new Response(sumsText, { status: 200 });
      }
      if (u === 'https://mock.example/dsh-leaderteam-2.2.9.tgz') {
        return new Response(v229Tgz, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const checkRes = await checkForUpdates({
      pluginRoot: fakePluginRoot,
      storageRoot,
      force: true,
      currentHostVersion: '0.2.2-rc.5',
      fetchImpl: mockFetch,
    });
    assert.equal(checkRes.installedTrack, 'open-source');
    assert.equal(checkRes.queriedTrack, 'open-source');
    assert.equal(checkRes.hasUpdate, true);
    assert.equal(checkRes.latestRelease.version, '2.2.9');
    assert.match(checkRes.latestRelease.body, /Auto update & rollback/);

    // 3. Tampered SHA-256 MUST abort before installerHook runs
    let hookCalls = [];
    await assert.rejects(
      () =>
        performOneClickUpgrade({
          pluginRoot: fakePluginRoot,
          storageRoot,
          dshHome,
          expectedSha256: '0'.repeat(64),
          currentHostVersion: '0.2.2-rc.5',
          fetchImpl: mockFetch,
          installerHook: async call => { hookCalls.push(call); },
        }),
      err => err.code === 'SHA256_MISMATCH',
    );
    assert.equal(hookCalls.length, 0);

    // 4. Incompatible DSH host MUST abort before installerHook runs
    const futureDshOnlyTgz = createSyntheticLtTgz({
      version: '2.9.0',
      track: 'open-source',
      enginesDsh: '>=0.9.0 <1.0.0',
    });
    const futureTgzPath = path.join(tmp, 'dsh-leaderteam-2.9.0.tgz');
    fs.writeFileSync(futureTgzPath, futureDshOnlyTgz);
    await assert.rejects(
      () =>
        performOneClickUpgrade({
          pluginRoot: fakePluginRoot,
          storageRoot,
          dshHome,
          localTgzPath: futureTgzPath,
          currentHostVersion: '0.2.2-rc.5',
          installerHook: async call => { hookCalls.push(call); },
        }),
      err => err.code === 'HOST_INCOMPATIBLE_WITH_UPDATE',
    );
    assert.equal(hookCalls.length, 0);

    // 5. Busy session guard blocks upgrade while members are running
    await assert.rejects(
      () =>
        performOneClickUpgrade({
          rt: { liveProcessMemberIds: new Set(['m-active-1']) },
          pluginRoot: fakePluginRoot,
          storageRoot,
          dshHome,
          currentHostVersion: '0.2.2-rc.5',
          fetchImpl: mockFetch,
          installerHook: async () => {},
        }),
      err => err.code === 'UPGRADE_BUSY' && err.statusCode === 409,
    );

    // 6. Simulated install failure MUST automatically roll back to v2.2.3 backup!
    let rollbackCalledSpec = null;
    await assert.rejects(
      () =>
        performOneClickUpgrade({
          pluginRoot: fakePluginRoot,
          storageRoot,
          dshHome,
          currentHostVersion: '0.2.2-rc.5',
          fetchImpl: mockFetch,
          installerHook: async call => {
            if (call.mode === 'install') throw new Error('simulated disk full mid-install');
            if (call.mode === 'rollback') rollbackCalledSpec = call.spec;
          },
        }),
      err => err.code === 'UPGRADE_FAILED_ROLLED_BACK',
    );
    assert.ok(rollbackCalledSpec && fs.existsSync(path.join(rollbackCalledSpec, 'package.json')));

    // 7. Successful one-click upgrade + preserve user configs/teams + manual one-click rollback
    let installedSpecVersion = '2.2.2';
    const upgOk = await performOneClickUpgrade({
      pluginRoot: fakePluginRoot,
      storageRoot,
      dshHome,
      currentHostVersion: '0.2.2-rc.5',
      fetchImpl: mockFetch,
      installerHook: async call => {
        if (call.mode === 'install') {
          installedSpecVersion = call.inspection.version;
        }
      },
    });
    assert.equal(upgOk.ok, true);
    assert.equal(upgOk.toVersion, '2.2.9');
    assert.equal(installedSpecVersion, '2.2.9');
    // Verify model config and team ledger untouched
    assert.equal(JSON.parse(fs.readFileSync(localCfgPath, 'utf8')).customMarker, 'preserve-me');
    assert.equal(fs.readFileSync(memberLedgerPath, 'utf8'), '{"id":"m1","status":"done"}\n');

    // Manual rollback
    const rbOk = await rollbackToSavedBackup({
      storageRoot,
      dshHome,
      backupId: upgOk.backupId,
      installerHook: async call => {
        const snapPkg = JSON.parse(fs.readFileSync(path.join(call.spec, 'package.json'), 'utf8'));
        installedSpecVersion = snapPkg.version;
      },
    });
    assert.equal(rbOk.ok, true);
    assert.equal(rbOk.restoredVersion, '2.2.2');
    assert.equal(installedSpecVersion, '2.2.2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Cross-Platform Release Governance: windows-vX.Y.Z vs linux-vX.Y.Z filtering, legacy vX.Y.Z fallback, and PLATFORM_RELEASE_TAG_MISMATCH guard', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-platform-tags-'));
  try {
    assert.deepEqual(parseReleaseTagInfo('windows-v2.2.3'), {
      rawTag: 'windows-v2.2.3',
      canonicalTag: 'windows-v2.2.3',
      platformPrefix: 'windows',
      targetPlatform: 'win32',
      version: '2.2.3',
    });
    assert.deepEqual(parseReleaseTagInfo('linux-v2.2.4'), {
      rawTag: 'linux-v2.2.4',
      canonicalTag: 'linux-v2.2.4',
      platformPrefix: 'linux',
      targetPlatform: 'linux',
      version: '2.2.4',
    });
    assert.deepEqual(parseReleaseTagInfo('v2.2.1'), {
      rawTag: 'v2.2.1',
      canonicalTag: 'v2.2.1',
      platformPrefix: null,
      targetPlatform: null,
      version: '2.2.1',
    });

    assert.throws(
      () => assertPlatformReleaseTagCompatible('linux-v2.2.2', 'win32'),
      err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
    );
    assert.throws(
      () => assertPlatformReleaseTagCompatible('windows-v2.2.2', 'linux'),
      err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
    );

    const mixedReleases = [
      { tag_name: 'linux-v2.2.4', prerelease: false },
      { tag_name: 'windows-v2.2.3', prerelease: false },
      { tag_name: 'v2.2.1', prerelease: false },
    ];
    assert.deepEqual(
      filterReleasesForPlatform(mixedReleases, 'win32').map(r => r.tag_name),
      ['windows-v2.2.3'],
    );
    assert.deepEqual(
      filterReleasesForPlatform(mixedReleases, 'linux').map(r => r.tag_name),
      ['linux-v2.2.4'],
    );
    assert.deepEqual(
      filterReleasesForPlatform([{ tag_name: 'v2.2.1', prerelease: false }], 'win32').map(r => r.tag_name),
      ['v2.2.1'],
    );

    const fakePluginRoot = path.join(tmp, 'plugin');
    const storageRoot = path.join(tmp, 'storage');
    fs.mkdirSync(path.join(fakePluginRoot, 'leaderteam'), { recursive: true });
    fs.writeFileSync(
      path.join(fakePluginRoot, 'package.json'),
      JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.2', license: 'Apache-2.0', engines: { dsh: SUPPORTED_DSH_ENGINE_RANGE } }),
    );
    fs.writeFileSync(
      path.join(fakePluginRoot, 'leaderteam', 'package.json'),
      JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.2', leaderteam: { distributionTrack: 'open-source' } }),
    );

    const win223Tgz = createSyntheticLtTgz({ version: '2.2.3', track: 'open-source' });
    const lin224Tgz = createSyntheticLtTgz({ version: '2.2.4', track: 'open-source' });
    let queriedUrls = [];
    const mockFetch = async url => {
      const u = String(url);
      queriedUrls.push(u);
      assert.equal(u.includes('/releases/latest'), false, 'must NEVER query /releases/latest blindly');
      if (u.includes('/releases')) {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'linux-v2.2.4',
              name: 'Linux v2.2.4',
              prerelease: false,
              published_at: '2026-11-27T10:00:00Z',
              body: 'Linux ahead release',
              assets: [{ name: 'dsh-leaderteam-2.2.4.tgz', size: lin224Tgz.length, browser_download_url: 'https://mock.example/releases/download/linux-v2.2.4/dsh-leaderteam-2.2.4.tgz' }],
            },
            {
              tag_name: 'windows-v2.2.3',
              name: 'Windows v2.2.3',
              prerelease: false,
              published_at: '2026-11-26T10:00:00Z',
              body: 'Windows verified release',
              assets: [{ name: 'dsh-leaderteam-2.2.3.tgz', size: win223Tgz.length, browser_download_url: 'https://mock.example/releases/download/windows-v2.2.3/dsh-leaderteam-2.2.3.tgz' }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const winCheck = await checkForUpdates({
      pluginRoot: fakePluginRoot,
      storageRoot,
      platform: 'win32',
      force: true,
      fetchImpl: mockFetch,
    });
    assert.equal(winCheck.hasUpdate, true);
    assert.equal(winCheck.latestRelease.tagName, 'windows-v2.2.3');
    assert.equal(winCheck.latestRelease.version, '2.2.3');

    const linCheck = await checkForUpdates({
      pluginRoot: fakePluginRoot,
      storageRoot,
      platform: 'linux',
      force: true,
      fetchImpl: mockFetch,
    });
    assert.equal(linCheck.hasUpdate, true);
    assert.equal(linCheck.latestRelease.tagName, 'linux-v2.2.4');
    assert.equal(linCheck.latestRelease.version, '2.2.4');

    await assert.rejects(
      () =>
        checkForUpdates({
          pluginRoot: fakePluginRoot,
          storageRoot,
          platform: 'win32',
          releaseTag: 'linux-v2.2.4',
          force: true,
          fetchImpl: mockFetch,
        }),
      err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DSH 0.2.2-rc.1..rc.5 Host Model Selection Closure: top-level Array describe(), credentials.set, /v1/models dynamic route adoption, and non-reasoning schema compliance', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dsh-modelsel-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    const cfgDir = path.join(storageRoot, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });
    fs.writeFileSync(
      path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
      '- id: existing-bundle\n  name: dsh-leaderteam\n',
      'utf8',
    );
    const cfgPath = path.join(cfgDir, 'leaderteam.config.json');
    fs.copyFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), cfgPath);

    // 1. Live DSH `settings.describe()` returning top-level Array + `ctx.credentials.set` + `ctx.agentDefaultModel.saveSelection`
    let savedLlmConfig = null;
    let savedDefaultSelection = null;
    const savedCreds = new Map();
    const mockHostCtx = {
      credentials: {
        async set(k, v) { savedCreds.set(k, v); },
      },
      agentDefaultModel: {
        async saveSelection(sel) { savedDefaultSelection = sel; },
      },
      settings: {
        describe() {
          // Exact DSH 0.2.2-rc.1 top-level Array shape with `.value` and prior `modelOverrides`
          return [
            {
              ns: 'llm-pi-ai',
              value: {
                providers: {
                  deepseek: {
                    baseURL: 'https://api.deepseek.com',
                    modelOverrides: { 'legacy-override': { maxTokens: 4096 } },
                  },
                },
              },
            },
          ];
        },
        async update(ns, val) {
          if (ns === 'llm-pi-ai') savedLlmConfig = val;
        },
      },
    };

    const applied = await applyQuickOnboardingSetup({
      ctx: mockHostCtx,
      dshHome,
      storageRoot,
      configPath: cfgPath,
      bundledDefaultConfigPath: path.join(REPO_ROOT, 'config', 'leaderteam.config.json'),
      providerId: 'deepseek',
      apiKey: 'sk-live-deepseek-key-8888',
      customBaseURL: 'https://relay.example.com/v1/',
      verifyConnectivity: true,
      fetchImpl: async url => {
        assert.equal(String(url), 'https://relay.example.com/v1/models');
        return new Response(
          JSON.stringify({
            data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
      env: {},
    });

    assert.equal(applied.applied, true);
    assert.equal(savedCreds.get('DEEPSEEK_API_KEY'), 'sk-live-deepseek-key-8888');
    assert.equal(applied.provider.reasoningRoute, 'deepseek/deepseek-reasoner');
    assert.equal(applied.provider.chatRoute, 'deepseek/deepseek-chat');
    assert.ok(savedLlmConfig?.providers?.deepseek);
    // Preserves `/v1` on custom OpenAI-compatible gateway baseURL and apiKeyEnv, removes modelOverrides
    assert.equal(savedLlmConfig.providers.deepseek.baseURL, 'https://relay.example.com/v1');
    assert.equal(savedLlmConfig.providers.deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(savedLlmConfig.providers.deepseek.modelOverrides, undefined);
    const chatEntry = savedLlmConfig.providers.deepseek.models.find(m => m.id === 'deepseek-chat');
    assert.ok(chatEntry, 'deepseek-chat registered in llm-pi-ai');
    assert.notDeepEqual(chatEntry.reasoningEfforts, { off: 'none' }, 'non-reasoning model must never emit { off: "none" }');
    assert.deepEqual(savedDefaultSelection, {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });

    // Also verify disk persistence into `profiles/desktop/cordis.patch.yml` preserved `existing-bundle`
    const patchAfter = fs.readFileSync(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
    assert.match(patchAfter, /existing-bundle/);
    assert.match(patchAfter, /@deepseek-ai\/dsh-llm-pi-ai/);
    assert.match(patchAfter, /@deepseek-ai\/dsh-agent-default-model/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
