import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  ensureDesktopProfileInitialized,
  parseWindowsUninstallRegistryOutput,
  discoverWindowsDesktopCandidates,
  sanitizeDesktopCordisPatchText,
  inspectInstallerEnvironment,
  runOneClickInstallation,
  translateInstallErrorToPlainChinese,
} from '../../leaderteam/core/installer.mjs';
import {
  resolveDshCliCommand,
} from '../../leaderteam/core/updater.mjs';
import {
  discoverSystemMagpieBinary,
  MagpieGatewayManager,
} from '../../leaderteam/gateway/magpie-process.mjs';
import {
  QUICK_PROVIDER_PRESETS,
  TEAM_COLLAB_PRESETS,
  STARTER_TASK_TEMPLATES,
  buildOnboardingSnapshot,
  probeProviderKeyConnectivity,
  applyQuickOnboardingSetup,
  recordOnboardingFirstTask,
  dismissOnboardingWizard,
} from '../../leaderteam/core/onboarding.mjs';
import {
  renderInstallerHtml,
  startInstallerGuiServer,
} from '../../bin/lt-installer.mjs';
import {
  ensureDesktopProfileInitialized as ensureStandaloneDesktopProfile,
  parseWindowsUninstallRegistryOutput as parseStandaloneRegistry,
  sanitizeDesktopCordisPatchText as sanitizeStandalonePatchText,
  filterStandaloneReleasesForPlatform,
  assertStandalonePlatformReleaseTagCompatible,
  parseStandaloneArgs,
  scanDshTargets,
  downloadAndInstallStandalone,
  renderStandaloneHtml,
  startStandaloneInstallerServer,
} from '../../installer/lt-installer-standalone.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

const CANONICAL_PIPELINE_JS = `
export class ToolExecutionPipeline {
  async dispatchToolBody(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
    return await tool.execute(exec.arguments, exec);
  }
}
`;

function createMockDesktopFixture(dir, version = '0.2.2-rc.1') {
  fs.mkdirSync(path.join(dir, 'resources', 'runtime', 'cli', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resources', 'runtime', 'primary-runtime'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'DeepSeek Harness.exe'), 'mock-exe');
  fs.writeFileSync(path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), '@echo off\r\n');
  fs.writeFileSync(
    path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    '// mock desktop host cli\n',
  );
  fs.writeFileSync(
    path.join(dir, 'resources', 'runtime', 'primary-runtime', 'runtime.json'),
    JSON.stringify({ desktopVersion: version }),
  );
  fs.writeFileSync(
    path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version }),
  );
  fs.writeFileSync(
    path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'pipeline.js'),
    CANONICAL_PIPELINE_JS,
  );
}

function buildMinimalTgzBuffer(entries) {
  const blocks = [];
  for (const [entryPath, contentStr] of Object.entries(entries)) {
    const data = Buffer.from(contentStr, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(entryPath, 0, Math.min(Buffer.byteLength(entryPath), 100), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('Windows Registry Uninstall parser extracts InstallLocation, DisplayIcon, and UninstallString while ignoring legacy DataElement DSH Desktop', () => {
  const sampleOutput = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\63aba052-legacy',
    '    DisplayName    REG_SZ    DSH Desktop 0.9.2',
    '    InstallLocation    REG_SZ    C:\\Users\\demo\\AppData\\Local\\Programs\\DSH Desktop',
    '    Comments    REG_SZ    A cross-platform desktop shell for DeepSeek Harness.',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dsh-official-1',
    '    DisplayName    REG_SZ    DeepSeek Harness 0.2.2-rc.1',
    '    InstallLocation    REG_SZ    "D:\\Apps\\DeepSeek-Harness\\"',
    '',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dsh-official-2',
    '    DisplayName    REG_SZ    DeepSeek Harness',
    '    DisplayIcon    REG_EXPAND_SZ    "E:\\Tools\\DeepSeek Harness\\DeepSeek Harness.exe",0',
    '',
    'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\dsh-official-3',
    '    DisplayName    REG_SZ    DeepSeek-Harness',
    '    UninstallString    REG_SZ    "F:\\CustomDir\\DeepSeek-Harness\\Uninstall DeepSeek Harness.exe" /allusers /S',
    '    QuietUninstallString    REG_SZ    C:\\Windows\\System32\\msiexec.exe /x {1234}',
    '',
    'End of search: 4 match(es) found.',
  ].join('\r\n');

  for (const parser of [parseWindowsUninstallRegistryOutput, parseStandaloneRegistry]) {
    const parsed = parser(sampleOutput);
    assert.deepEqual(parsed.dirs, [
      'D:\\Apps\\DeepSeek-Harness',
      'E:\\Tools\\DeepSeek Harness',
      'F:\\CustomDir\\DeepSeek-Harness',
    ]);
    assert.equal(parsed.matchedSubkeys.length, 3);
    assert.ok(!parsed.dirs.some(d => d.includes('DSH Desktop')));
    assert.ok(!parsed.dirs.some(d => d.toLowerCase().includes('system32')));
  }
});

test('Windows custom-path discovery combines env vars, drive-letter scan, two-phase Registry expansion, and running process path', () => {
  const virtualPaths = new Set([
    'C:\\',
    'D:\\',
    'G:\\',
    'D:\\Apps\\DeepSeek-Harness',
    'G:\\DeepSeek Harness',
  ]);
  const mockFs = {
    existsSync: p => virtualPaths.has(p),
  };

  const mockSpawnSync = (cmd, args) => {
    if (cmd === 'reg.exe' && args.includes('/f') && args[1].startsWith('HKCU\\')) {
      return {
        status: 0,
        stdout: [
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\official-guid',
          '    DisplayName    REG_SZ    DeepSeek Harness',
          'End of search: 1 match(es) found.',
        ].join('\r\n'),
      };
    }
    if (cmd === 'reg.exe' && args[1] === 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\official-guid') {
      return {
        status: 0,
        stdout: [
          'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\official-guid',
          '    DisplayName    REG_SZ    DeepSeek Harness',
          '    InstallLocation    REG_SZ    H:\\PortableApps\\DeepSeek-Harness',
        ].join('\r\n'),
      };
    }
    if (cmd === 'tasklist') {
      return { status: 0, stdout: '"DeepSeek Harness.exe","12345","Console","1","180,000 K"\r\n' };
    }
    if (cmd === 'powershell.exe') {
      return { status: 0, stdout: 'M:\\RunningCustom\\DeepSeek-Harness\\DeepSeek Harness.exe\r\n' };
    }
    return { status: 1, stdout: '' };
  };

  const cands = discoverWindowsDesktopCandidates({
    env: {
      DSH_DESKTOP_DIR: 'Z:\\ExplicitEnv\\DeepSeek-Harness',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
    },
    fsImpl: mockFs,
    spawnSyncImpl: mockSpawnSync,
    driveLetters: ['C', 'D', 'E', 'G'],
  });

  assert.ok(cands.includes('Z:\\ExplicitEnv\\DeepSeek-Harness'), 'discovers DSH_DESKTOP_DIR env var');
  assert.ok(cands.includes('D:\\Apps\\DeepSeek-Harness'), 'discovers D:\\Apps\\DeepSeek-Harness via drive scan');
  assert.ok(cands.includes('G:\\DeepSeek Harness'), 'discovers G:\\DeepSeek Harness via drive scan');
  assert.ok(cands.includes('H:\\PortableApps\\DeepSeek-Harness'), 'discovers Registry InstallLocation via two-phase subkey query');
  assert.ok(cands.includes('M:\\RunningCustom\\DeepSeek-Harness'), 'discovers running DeepSeek Harness.exe parent directory');
});

test('inspectInstallerEnvironment & scanDshTargets detect custom DSH directory and block install cleanly when DeepSeek Harness.exe is running', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-win-inst-test-'));
  try {
    const customApp = path.join(tmp, 'CustomDisk', 'Apps', 'DeepSeek-Harness');
    const dshHome = path.join(tmp, 'dsh-home');
    fs.mkdirSync(path.join(dshHome, 'profiles', 'desktop'), { recursive: true });
    createMockDesktopFixture(customApp, '0.2.2-rc.1');

    const mockRunningSpawn = cmd => {
      if (cmd === 'tasklist') {
        return { status: 0, stdout: 'DeepSeek Harness.exe          4321 Console                    1    152,000 K\r\n' };
      }
      return { status: 1, stdout: '' };
    };

    const snapCore = inspectInstallerEnvironment({
      repoRoot: REPO_ROOT,
      dshHome,
      platform: 'win32',
      env: { DSH_DESKTOP_DIR: customApp, HOME: tmp, USERPROFILE: tmp, PATH: '' },
      spawnSyncImpl: mockRunningSpawn,
      driveLetters: [],
    });
    assert.equal(snapCore.targets.length, 1);
    assert.equal(snapCore.targets[0].installDir, path.win32.normalize(customApp));
    assert.equal(snapCore.targets[0].dshVersion, '0.2.2-rc.1');
    assert.equal(snapCore.targets[0].compatible, true);
    assert.equal(snapCore.targets[0].verified, true);
    assert.equal(snapCore.targets[0].desktopRunning, true);

    const snapStandalone = scanDshTargets({
      dshHome,
      platform: 'win32',
      env: { DSH_APP_DIR: customApp, HOME: tmp, USERPROFILE: tmp, PATH: '' },
      spawnSyncImpl: mockRunningSpawn,
      driveLetters: [],
    });
    assert.equal(snapStandalone.targets.length, 1);
    assert.equal(snapStandalone.targets[0].dshVersion, '0.2.2-rc.1');
    assert.equal(snapStandalone.targets[0].compatible, true);
    assert.equal(snapStandalone.targets[0].verified, true);
    assert.equal(snapStandalone.targets[0].desktopRunning, true);

    await assert.rejects(
      () =>
        runOneClickInstallation({
          repoRoot: REPO_ROOT,
          dshHome,
          customDshPath: customApp,
          spawnSyncImpl: mockRunningSpawn,
          installerRunner: async () => {
            throw new Error('SHOULD_NOT_RUN_WHILE_LOCKED');
          },
        }),
      err => {
        const friendly = err.friendly || translateInstallErrorToPlainChinese(err);
        assert.equal(friendly.code, 'CLIENT_RUNNING_OR_LOCKED');
        assert.match(friendly.title, /DeepSeek Harness/);
        assert.match(friendly.friendlyMessage, /退出/);
        return true;
      },
    );

    await assert.rejects(
      () =>
        downloadAndInstallStandalone({
          dshHome,
          customPath: customApp,
          spawnSyncImpl: mockRunningSpawn,
          runner: async () => {
            throw new Error('SHOULD_NOT_RUN_WHILE_LOCKED');
          },
        }),
      /正在运行/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Zero-state profiles/desktop auto-initialization before --profile desktop plugin add & post-install cordis.patch.yml hygiene', async () => {
  const dirtyPatch = [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '  config:',
    '    transcriptView: standard',
    '# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)',
    '- id: tool-executor-native',
    '  disabled: true',
    '- insert:',
    '    - id: tool-executor-native',
    '      name: "file:///D:/old-lt/leaderteam/entry-native-executor.mjs"',
    '    - id: leaderteam-core',
    '      name: "file:///D:/old-lt/leaderteam/entry-core.mjs"',
    '    - id: leaderteam-scheduler',
    '      name: "file:///D:/old-lt/leaderteam/plugins/leaderteam-scheduler/index.mjs"',
    '    - id: preset-leaderteam',
    '      name: "@deepseek-ai/dsh-agent-preset"',
    '      config:',
    '        id: leaderteam',
    '    - id: preset-lt-member-shell',
    '      name: "@deepseek-ai/dsh-agent-preset"',
    '    - id: custom-user-helper',
    '      name: "@example/custom-user-helper"',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: lt-magpie',
    '    model: zcode/GLM-5.4',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      lt-magpie:',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:3425/v1',
    '        models:',
    '          - id: "zcode/GLM-5.4"',
    '            input: [text, image]',
    '# <<< leaderteam',
    '',
  ].join('\n');

  for (const fn of [sanitizeDesktopCordisPatchText, sanitizeStandalonePatchText]) {
    const res = fn(dirtyPatch);
    assert.equal(res.changed, true);
    assert.equal(res.markersStripped, true);
    assert.ok(res.removedLegacyItems >= 6);
    assert.equal(res.toolWebEnsured, true);
    assert.equal(res.toolWebAdded, true);
    assert.ok(!res.text.includes('leaderteam-core'));
    assert.ok(!res.text.includes('preset-leaderteam'));
    assert.ok(!res.text.includes('entry-native-executor.mjs'));
    assert.ok(!res.text.includes('tool-executor-native'));
    assert.ok(!res.text.includes('# >>> leaderteam'));
    assert.ok(res.text.includes('- id: ui-chat'));
    assert.ok(res.text.includes('- id: custom-user-helper'));
    assert.ok(res.text.includes('- id: agent-default-model'));
    assert.ok(res.text.includes('- id: llm-pi-ai'));
    assert.ok(res.text.includes('- id: tool-web\n  config: {fetch: true, searchTimeoutMs: 60000}'));
    const second = fn(res.text);
    assert.equal(second.changed, false);
  }

  // Fact 1: Brand-new `$DSH_HOME` with ZERO `profiles/desktop` folder initializes `package.json` & `cordis.patch.yml` BEFORE plugin add!
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-zero-state-desktop-'));
  try {
    const appDir = path.join(tmp, 'DeepSeek-Harness');
    createMockDesktopFixture(appDir, '0.2.2-rc.1');

    const tgzPath = path.join(tmp, 'dsh-leaderteam-2.2.2.tgz');
    fs.writeFileSync(
      tgzPath,
      buildMinimalTgzBuffer({
        'package/package.json': JSON.stringify({
          name: 'dsh-leaderteam',
          version: '2.2.2',
          engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/cordis.patch.yml': '- id: tool-executor-native\n  disabled: true\n',
      }),
    );

    // 1. Core `runOneClickInstallation` on zero-state `dshHome1`
    const dshHome1 = path.join(tmp, 'fresh-dsh-home-1');
    let pkgExistedDuringCoreAdd = false;
    let parsedDesktopPkg1 = null;
    const out1 = await runOneClickInstallation({
      repoRoot: REPO_ROOT,
      dshHome: dshHome1,
      customDshPath: appDir,
      sourceKind: 'local-tgz',
      localTgzPath: tgzPath,
      providerId: 'deepseek',
      apiKey: 'sk-test-installer-key-999999',
      spawnSyncImpl: () => ({ status: 1, stdout: '' }),
      installerRunner: async () => {
        const pkgFile = path.join(dshHome1, 'profiles', 'desktop', 'package.json');
        pkgExistedDuringCoreAdd = fs.existsSync(pkgFile);
        parsedDesktopPkg1 = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      },
    });
    assert.equal(out1.ok, true);
    assert.equal(out1.installedVersion, '2.2.2');
    assert.equal(pkgExistedDuringCoreAdd, true, 'profiles/desktop/package.json must exist BEFORE dsh plugin --profile desktop add runs');
    assert.deepEqual(parsedDesktopPkg1, {
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    });
    assert.match(fs.readFileSync(path.join(dshHome1, '.credentials.yaml'), 'utf8'), /DEEPSEEK_API_KEY:\s*"sk-test-installer-key-999999"/);

    // 2. Standalone `downloadAndInstallStandalone` on zero-state `dshHome2` + platform tag filtering
    const dshHome2 = path.join(tmp, 'fresh-dsh-home-2');
    let pkgExistedDuringStandaloneAdd = false;
    const out2 = await downloadAndInstallStandalone({
      dshHome: dshHome2,
      customPath: appDir,
      localTgzPath: tgzPath,
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      apiKey: 'sk-standalone-key-777777',
      spawnSyncImpl: () => ({ status: 1, stdout: '' }),
      runner: async () => {
        pkgExistedDuringStandaloneAdd = fs.existsSync(path.join(dshHome2, 'profiles', 'desktop', 'package.json'));
      },
    });
    assert.equal(out2.ok, true);
    assert.equal(out2.versionInstalled, '2.2.2');
    assert.equal(pkgExistedDuringStandaloneAdd, true);
    assert.match(fs.readFileSync(path.join(dshHome2, '.credentials.yaml'), 'utf8'), /DEEPSEEK_API_KEY:\s*"sk-standalone-key-777777"/);

    // Direct helper idempotence check
    assert.equal(ensureDesktopProfileInitialized(dshHome1).createdPackageJson, false);
    assert.equal(ensureStandaloneDesktopProfile(dshHome2).createdPackageJson, false);

    // 3. `--dsh-dir` / `--dsh-app` + `--profile web` allows conflict-free `web` profile installation even when `DeepSeek Harness.exe` is running!
    const parsedCli = parseStandaloneArgs(['--cli', '--dsh-dir', appDir, '--profile', 'web', '--tgz', tgzPath]);
    assert.equal(parsedCli.customPath, appDir);
    assert.equal(parsedCli.profile, 'web');

    const dshHomeWeb = path.join(tmp, 'fresh-dsh-home-web');
    let webRunnerTarget = null;
    const outWeb = await downloadAndInstallStandalone({
      dshHome: dshHomeWeb,
      customPath: appDir,
      profile: 'web',
      localTgzPath: tgzPath,
      spawnSyncImpl: cmd => (cmd === 'tasklist' ? { status: 0, stdout: 'DeepSeek Harness.exe  1234\r\n' } : { status: 1, stdout: '' }),
      runner: async info => { webRunnerTarget = info.target; },
    });
    assert.equal(outWeb.ok, true);
    assert.equal(webRunnerTarget.profile, 'web');
    assert.equal(webRunnerTarget.desktopRunning, false);
    assert.equal(fs.existsSync(path.join(dshHomeWeb, 'profiles', 'desktop', 'package.json')), false, 'must not touch profiles/desktop when --profile web');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Empirical Windows Host Facts 4, 5 & updater custom-path CLI: magpie-cli.exe priority, cross-process managed-pid preservation, standalone platform tag filtering, and updater D:\\Apps\\DeepSeek-Harness discovery', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-win-host-facts-'));
  try {
    // Fact 4: `discoverSystemMagpieBinary` checks `magpie-cli.exe` BEFORE `magpie.exe` on Windows!
    const localAppData = path.join(tmp, 'LocalAppData');
    const magpieDir = path.join(localAppData, 'Programs', 'Magpie');
    fs.mkdirSync(magpieDir, { recursive: true });
    const guiExe = path.join(magpieDir, 'magpie.exe');
    const cliExe = path.join(magpieDir, 'magpie-cli.exe');
    fs.writeFileSync(guiExe, 'gui-shell-114mb');
    fs.writeFileSync(cliExe, 'cli-server-50mb');

    const discoveredBin = discoverSystemMagpieBinary({ LOCALAPPDATA: localAppData }, 'win32', fs);
    assert.equal(discoveredBin, cliExe, 'must select magpie-cli.exe before magpie.exe when both exist');

    // Fact 5: `_stopManagedProcessesImmediateSync` preserves `managed-pid.json` when `_verifyOwnedPidSync` returns `null` (Windows cross-process live PID)
    const storageRoot = path.join(tmp, 'lt-storage');
    const mgr = new MagpieGatewayManager({ storageRoot });
    const fakeRelBin = path.join(mgr.releasesDir, '0.1.4731', 'magpie.exe');
    fs.mkdirSync(path.dirname(fakeRelBin), { recursive: true });
    fs.writeFileSync(fakeRelBin, 'bin');
    mgr._writeManagedPidRecord({
      pid: 999991,
      binaryPath: fakeRelBin,
      gatewayPort: 13425,
      webPort: 13430,
      startedAt: new Date().toISOString(),
    });
    mgr._verifyOwnedPidSync = () => null;
    mgr._stopManagedProcessesImmediateSync();
    assert.ok(fs.existsSync(mgr.pidFile), 'must NOT blindly delete managed-pid.json when _verifyOwnedPidSync is indeterminate (null)');

    // Updater custom-path CLI discovery (`LT_DSH_APP` / custom drive `Apps\DeepSeek-Harness` for BOTH `desktop` and `web` profiles)
    const customDsh = path.join(tmp, 'Apps', 'DeepSeek-Harness');
    createMockDesktopFixture(customDsh, '0.2.2-rc.1');
    for (const prof of ['desktop', 'web']) {
      const cli = resolveDshCliCommand({
        profile: prof,
        platform: 'win32',
        env: { LT_DSH_APP: customDsh, PATH: '', USERPROFILE: tmp, HOME: tmp },
        driveLetters: [],
      });
      assert.ok(cli, `resolveDshCliCommand must find custom DSH for profile=${prof}`);
      assert.equal(cli.cmd, path.join(customDsh, 'DeepSeek Harness.exe'));
      assert.equal(cli.prefixArgs[0], '--expose-internals');
      assert.equal(cli.extraEnv?.ELECTRON_RUN_AS_NODE, '1');
    }

    // Standalone installer platform release tag filtering (`windows-v2.2.3` vs `linux-v2.2.4` + `PLATFORM_RELEASE_TAG_MISMATCH`)
    const mixed = [
      { tag_name: 'linux-v2.2.4', prerelease: false },
      { tag_name: 'windows-v2.2.3', prerelease: false },
      { tag_name: 'v2.2.1', prerelease: false },
    ];
    assert.deepEqual(filterStandaloneReleasesForPlatform(mixed, 'win32').map(r => r.tag_name), ['windows-v2.2.3']);
    assert.deepEqual(filterStandaloneReleasesForPlatform(mixed, 'linux').map(r => r.tag_name), ['linux-v2.2.4']);
    assert.throws(
      () => assertStandalonePlatformReleaseTagCompatible('linux-v2.2.2', 'win32'),
      err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Web Installer UIs expose manual custom path input, Rescan button, local .tgz controls, and loopback security', async () => {
  const repoHtml = renderInstallerHtml();
  const standaloneHtml = renderStandaloneHtml('tok-demo');
  for (const html of [repoHtml, standaloneHtml]) {
    assert.ok(html.includes('手动指定 DeepSeek Harness 安装目录（可选）'));
    assert.ok(html.includes('重新扫描'));
    assert.ok(html.includes('tgzFileInput'));
    assert.ok(html.includes('localTgzPathInput'));
    assert.ok(html.includes('dsh-leaderteam-2.2.2.tgz'));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gui-srv-'));
  const srv1 = await startInstallerGuiServer({ port: 0, dshHome: tmp, openBrowser: false });
  const srv2 = await startStandaloneInstallerServer({ port: 0, dshHome: tmp, openBrowser: false });
  try {
    const unauth1 = await fetch(`http://127.0.0.1:${srv1.port}/api/installer/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauth1.status, 401);

    const authInspect = await fetch(`http://127.0.0.1:${srv1.port}/api/installer/inspect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${srv1.launchToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(authInspect.status, 200);
    const j1 = await authInspect.json();
    assert.equal(j1.ok, true);

    const scanRes = await fetch(`http://127.0.0.1:${srv2.port}/scan?token=${srv2.token}`);
    assert.equal(scanRes.status, 200);
    const j2 = await scanRes.json();
    assert.ok(Array.isArray(j2.targets));
  } finally {
    await srv1.close();
    await srv2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Onboarding Wizard 3-step flow: connectivity check, Solo-Key model & team setup (strictly Team-mode in v2.2.2), secret redaction, and first-task completion', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-onboarding-3step-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    const configPath = path.join(storageRoot, 'config', 'leaderteam.config.json');
    const bundledDefaultConfigPath = path.join(REPO_ROOT, 'config', 'leaderteam.config.json');
    const isolatedEnv = {};

    const initialSnap = buildOnboardingSnapshot({
      storageRoot,
      dshHome,
      sessionCount: 0,
      env: isolatedEnv,
    });
    assert.equal(initialSnap.shouldAutoOpen, true);
    assert.equal(QUICK_PROVIDER_PRESETS.length >= 4, true);
    assert.equal(TEAM_COLLAB_PRESETS.length, 3);
    assert.equal(TEAM_COLLAB_PRESETS.every(p => p.defaultSessionMode === 'team'), true);
    assert.equal(STARTER_TASK_TEMPLATES.length, 3);
    assert.equal(STARTER_TASK_TEMPLATES.every(t => t.recommendedMode === 'team'), true);

    const failProbe = await probeProviderKeyConnectivity({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-invalid',
      fetchImpl: async () => new Response('{}', { status: 401 }),
    });
    assert.equal(failProbe.ok, false);
    assert.equal(failProbe.code, 'AUTH_FAILED');

    const savedCreds = new Map();
    let updatedLlmSettings = null;
    const mockCtx = {
      credentials: {
        set: async (k, v) => savedCreds.set(k, v),
      },
      get: name => {
        if (name === 'settings') {
          return {
            describe: () => ({ namespaces: [{ ns: 'llm-pi-ai', data: { providers: {} } }] }),
            update: async (_ns, data) => { updatedLlmSettings = data; },
          };
        }
        return null;
      },
    };
    const mockRt = {};

    const rawSecret = 'sk-onboarding-super-secret-20261127';
    const setupRes = await applyQuickOnboardingSetup({
      ctx: mockCtx,
      rt: mockRt,
      storageRoot,
      dshHome,
      configPath,
      bundledDefaultConfigPath,
      providerId: 'openai',
      apiKey: rawSecret,
      collabPresetId: 'lightweight-team',
      verifyConnectivity: true,
      fetchImpl: async () => new Response('{"data":[]}', { status: 200 }),
      env: isolatedEnv,
    });

    assert.equal(setupRes.applied, true);
    assert.equal(setupRes.provider.id, 'openai');
    assert.equal(setupRes.collabPreset.id, 'lightweight-team');
    assert.equal(setupRes.collabPreset.defaultSessionMode, 'team');
    assert.equal(savedCreds.get('OPENAI_API_KEY'), rawSecret);
    assert.ok(updatedLlmSettings?.providers?.openai);
    assert.equal(mockRt.config.team.maxActiveMembers, 2);
    assert.ok(!JSON.stringify(setupRes).includes(rawSecret));
    const persistedJson = fs.readFileSync(path.join(storageRoot, 'onboarding.json'), 'utf8');
    assert.ok(!persistedJson.includes(rawSecret));

    recordOnboardingFirstTask({ storageRoot, sessionId: 'sess-first-001', completed: true });
    const snapDone = buildOnboardingSnapshot({
      storageRoot,
      dshHome,
      sessionCount: 1,
      env: isolatedEnv,
    });
    assert.equal(snapDone.completed, true);
    assert.equal(snapDone.firstSessionId, 'sess-first-001');
    assert.equal(snapDone.shouldAutoOpen, false);

    const dismissRoot = path.join(tmp, 'dismiss-root');
    dismissOnboardingWizard({ storageRoot: dismissRoot });
    const snapDismissed = buildOnboardingSnapshot({ storageRoot: dismissRoot, sessionCount: 0, env: {} });
    assert.equal(snapDismissed.dismissed, true);
    assert.equal(snapDismissed.shouldAutoOpen, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Install-LeaderTeam.cmd and install-leaderteam.sh support both standalone and repo layouts plus Windows custom path zero-Node fallback', () => {
  const cmdText = fs.readFileSync(path.join(REPO_ROOT, 'Install-LeaderTeam.cmd'), 'utf8');
  assert.ok(cmdText.includes('installer\\lt-installer-standalone.mjs'));
  assert.ok(cmdText.includes('bin\\lt-installer.mjs'));
  assert.ok(cmdText.includes('Apps\\DeepSeek-Harness\\DeepSeek Harness.exe'));
  assert.ok(cmdText.includes('ELECTRON_RUN_AS_NODE=1'));
  assert.ok(cmdText.includes('CurrentVersion\\Uninstall'));

  const shText = fs.readFileSync(path.join(REPO_ROOT, 'install-leaderteam.sh'), 'utf8');
  assert.ok(shText.includes('installer/lt-installer-standalone.mjs'));
  assert.ok(shText.includes('bin/lt-installer.mjs'));
});
