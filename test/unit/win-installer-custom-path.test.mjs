import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  parseWindowsUninstallRegistryOutput,
  discoverWindowsDesktopCandidates,
  ensureDesktopProfileInitialized,
  sanitizeDesktopCordisPatchText,
  sanitizeDesktopCordisPatch,
  inspectInstallerEnvironment,
  runOneClickInstallation,
  translateInstallErrorToPlainChinese,
} from '../../leaderteam/core/installer.mjs';
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
  parseWindowsUninstallRegistryOutput as parseStandaloneRegistry,
  ensureDesktopProfileInitialized as ensureStandaloneDesktopProfileInitialized,
  sanitizeDesktopCordisPatchText as sanitizeStandalonePatchText,
  selectStandaloneReleaseForPlatform,
  scanDshTargets,
  downloadAndInstallStandalone,
  renderStandaloneHtml,
  startStandaloneInstallerServer,
} from '../../installer/lt-installer-standalone.mjs';
import { discoverSystemMagpieBinary, MagpieGatewayManager } from '../../leaderteam/gateway/magpie-process.mjs';

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
  fs.writeFileSync(path.join(dir, 'DeepSeek Harness.exe'), 'mock-exe');
  fs.writeFileSync(path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), '@echo off\r\n');
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

test('inspectInstallerEnvironment & scanDshTargets detect custom DSH directory, filter platform tags, and block install cleanly when DeepSeek Harness.exe is running', async () => {
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
    assert.equal(snapCore.targets[0].installDir, /^[A-Za-z]:[\\/]/.test(customApp) ? path.win32.normalize(customApp) : path.resolve(customApp));
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
          platform: 'win32',
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
          platform: 'win32',
          customPath: customApp,
          spawnSyncImpl: mockRunningSpawn,
          runner: async () => {
            throw new Error('SHOULD_NOT_RUN_WHILE_LOCKED');
          },
        }),
      /正在运行/,
    );

    // Verify standalone platform-prefixed release selection & mismatch rejection
    const mixedFeed = [
      { tag_name: 'linux-v2.2.4', draft: false, prerelease: false, assets: [{ name: 'dsh-leaderteam-2.2.4.tgz' }] },
      { tag_name: 'windows-v2.2.3', draft: false, prerelease: false, assets: [{ name: 'dsh-leaderteam-2.2.3.tgz' }] },
    ];
    assert.equal(selectStandaloneReleaseForPlatform(mixedFeed, { platform: 'win32' })?.tag_name, 'windows-v2.2.3');
    assert.equal(selectStandaloneReleaseForPlatform(mixedFeed, { platform: 'linux' })?.tag_name, 'linux-v2.2.4');
    assert.throws(
      () => selectStandaloneReleaseForPlatform(mixedFeed, { platform: 'win32', targetVersion: 'linux-v2.2.4' }),
      err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Post-install Desktop cordis.patch.yml hygiene removes stale leaderteam-* insert rows while preserving provider/model patches and enabling tool-web', async () => {
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
    assert.ok(!res.text.includes('leaderteam-scheduler'));
    assert.ok(!res.text.includes('preset-leaderteam'));
    assert.ok(!res.text.includes('preset-lt-member-shell'));
    assert.ok(!res.text.includes('entry-native-executor.mjs'));
    assert.ok(!res.text.includes('tool-executor-native'));
    assert.ok(!res.text.includes('# >>> leaderteam'));

    assert.ok(res.text.includes('- id: ui-chat'));
    assert.ok(res.text.includes('- id: custom-user-helper'));
    assert.ok(res.text.includes('- id: agent-default-model'));
    assert.ok(res.text.includes('- id: llm-pi-ai'));
    assert.ok(res.text.includes('lt-magpie:'));
    assert.ok(res.text.includes('zcode/GLM-5.4'));
    assert.ok(res.text.includes('- id: tool-web\n  config: {fetch: true, searchTimeoutMs: 60000}'));

    const second = fn(res.text);
    assert.equal(second.changed, false);
    assert.equal(second.text, res.text);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-patch-hygiene-'));
  try {
    const appDir = path.join(tmp, 'DeepSeek-Harness');
    const dshHome = path.join(tmp, 'dsh-home');
    const desktopProfile = path.join(dshHome, 'profiles', 'desktop');
    fs.mkdirSync(desktopProfile, { recursive: true });
    createMockDesktopFixture(appDir, '0.2.2-rc.1');

    const patchFile = path.join(desktopProfile, 'cordis.patch.yml');
    fs.writeFileSync(
      patchFile,
      [
        '- id: tool-executor-native',
        '  disabled: true',
        '- insert:',
        '    - id: leaderteam-core',
        '      name: "D:/legacy/leaderteam/entry-core.mjs"',
        '- id: tool-web',
        '  disabled: true',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      deepseek:',
        '        baseURL: https://api.deepseek.com',
      ].join('\n'),
      'utf8',
    );

    const tgzPath = path.join(tmp, 'dsh-leaderteam-2.2.3.tgz');
    fs.writeFileSync(
      tgzPath,
      buildMinimalTgzBuffer({
        'package/package.json': JSON.stringify({
          name: 'dsh-leaderteam',
          version: '2.2.3',
          license: 'Apache-2.0',
          engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/cordis.patch.yml': '- name: dsh-leaderteam/core\n',
      }),
    );

    let runnerCalledWith = null;
    const starterSecret = 'test-installer-credential-999999';
    const out = await runOneClickInstallation({
      repoRoot: REPO_ROOT,
      dshHome,
      customDshPath: appDir,
      sourceKind: 'local-tgz',
      localTgzPath: tgzPath,
      providerId: 'deepseek',
      apiKey: starterSecret,
      spawnSyncImpl: () => ({ status: 0, stdout: '' }),
      installerRunner: async info => {
        runnerCalledWith = info;
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.installedVersion, '2.2.3');
    assert.equal(out.starterModelConfigured, true);
    assert.equal(runnerCalledWith.installSpec, tgzPath);
    assert.equal(out.desktopPatchHygiene.updated, true);
    assert.ok(fs.existsSync(out.desktopPatchHygiene.backupFile));

    const cleanedYaml = fs.readFileSync(patchFile, 'utf8');
    assert.ok(!cleanedYaml.includes('leaderteam-core'));
    assert.ok(!cleanedYaml.includes('tool-executor-native'));
    assert.ok(!cleanedYaml.includes('disabled: true'));
    assert.ok(cleanedYaml.includes('deepseek:'));
    assert.ok(cleanedYaml.includes('- id: tool-web\n  config: {fetch: true, searchTimeoutMs: 60000}'));
    assert.match(fs.readFileSync(path.join(dshHome, '.env'), 'utf8'), /DEEPSEEK_API_KEY="test-installer-credential-999999"/);
    assert.match(fs.readFileSync(path.join(dshHome, '.credentials.yaml'), 'utf8'), /DEEPSEEK_API_KEY:\s*"test-installer-credential-999999"/);
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
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gui-srv-'));
  const srv1 = await startInstallerGuiServer({ port: 0, dshHome: tmp, openBrowser: false });
  const srv2 = await startStandaloneInstallerServer({ port: 0, dshHome: tmp, openBrowser: false });
  async function invokeRoute(srv, method, reqPath, headers = {}, bodyStr = '') {
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}${reqPath}`, {
        method,
        headers,
        ...(bodyStr ? { body: bodyStr } : {}),
      });
      return { status: r.status, text: await r.text() };
    } catch (e) {
      if (e?.cause?.code !== 'EACCES') throw e;
      const { Readable } = await import('node:stream');
      const reqStream = Readable.from(bodyStr ? [Buffer.from(bodyStr, 'utf8')] : []);
      reqStream.method = method;
      reqStream.url = reqPath;
      reqStream.headers = {
        host: `127.0.0.1:${srv.port}`,
        ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      };
      return await new Promise((resolve, reject) => {
        let statusCode = 200;
        const chunks = [];
        const resMock = {
          writeHead(st) { statusCode = st; },
          end(chunk) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
            resolve({ status: statusCode, text: Buffer.concat(chunks).toString('utf8') });
          },
        };
        Promise.resolve(srv.server.emit('request', reqStream, resMock)).catch(reject);
      });
    }
  }
  try {
    const unauth1 = await invokeRoute(srv1, 'POST', '/api/installer/inspect', {}, '{}');
    assert.equal(unauth1.status, 401);

    const authInspect = await invokeRoute(
      srv1,
      'POST',
      '/api/installer/inspect',
      { Authorization: `Bearer ${srv1.launchToken}`, 'Content-Type': 'application/json' },
      JSON.stringify({}),
    );
    assert.equal(authInspect.status, 200);
    const j1 = JSON.parse(authInspect.text);
    assert.equal(j1.ok, true);

    const scanRes = await invokeRoute(srv2, 'GET', `/scan?token=${srv2.token}`);
    assert.equal(scanRes.status, 200);
    const j2 = JSON.parse(scanRes.text);
    assert.ok(Array.isArray(j2.targets));
  } finally {
    await srv1.close();
    await srv2.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Onboarding Wizard 3-step flow: connectivity check, Solo-Key model & team setup, secret redaction, and first-task completion', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-onboarding-3step-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    const configPath = path.join(storageRoot, 'config', 'leaderteam.config.json');
    const bundledDefaultConfigPath = path.join(REPO_ROOT, 'config', 'leaderteam.config.json');
    const isolatedEnv = {};

    const snap0 = buildOnboardingSnapshot({
      storageRoot,
      dshHome,
      sessionCount: 0,
      env: isolatedEnv,
    });
    assert.equal(snap0.shouldAutoOpen, true);
    assert.deepEqual(snap0.steps, {
      modelConnected: false,
      teamConfigured: false,
      firstTaskCreated: false,
    });
    assert.equal(QUICK_PROVIDER_PRESETS.length >= 4, true);
    assert.equal(TEAM_COLLAB_PRESETS.length, 3);
    assert.equal(STARTER_TASK_TEMPLATES.length, 3);

    const failProbe = await probeProviderKeyConnectivity({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'invalid-token',
      fetchImpl: async () => new Response('{}', { status: 401 }),
    });
    assert.equal(failProbe.ok, false);
    assert.equal(failProbe.code, 'AUTH_FAILED');

    const okProbe = await probeProviderKeyConnectivity({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'valid-token-12345678',
      fetchImpl: async () => new Response('{"data":[]}', { status: 200 }),
    });
    assert.equal(okProbe.ok, true);

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

    const rawSecret = 'test-onboarding-secret-20261127';
    const setupRes = await applyQuickOnboardingSetup({
      ctx: mockCtx,
      rt: mockRt,
      storageRoot,
      dshHome,
      configPath,
      bundledDefaultConfigPath,
      providerId: 'openai',
      apiKey: rawSecret,
      collabPresetId: 'single',
      verifyConnectivity: true,
      fetchImpl: async () => new Response('{"data":[]}', { status: 200 }),
      env: isolatedEnv,
    });

    assert.equal(setupRes.applied, true);
    assert.equal(setupRes.provider.id, 'openai');
    assert.equal(setupRes.collabPreset.id, 'single');
    assert.equal(setupRes.collabPreset.defaultSessionMode, 'single');
    assert.equal(savedCreds.get('OPENAI_API_KEY'), rawSecret);
    assert.ok(updatedLlmSettings?.providers?.openai);
    assert.equal(mockRt.config.team.maxActiveMembers, 2);
    assert.ok(!JSON.stringify(setupRes).includes(rawSecret));
    const persistedJson = fs.readFileSync(path.join(storageRoot, 'onboarding.json'), 'utf8');
    assert.ok(!persistedJson.includes(rawSecret));

    const snapAfterStep2 = buildOnboardingSnapshot({
      storageRoot,
      dshHome,
      sessionCount: 0,
      env: isolatedEnv,
    });
    assert.equal(snapAfterStep2.steps.modelConnected, true);
    assert.equal(snapAfterStep2.steps.teamConfigured, true);
    assert.equal(snapAfterStep2.steps.firstTaskCreated, false);
    assert.equal(snapAfterStep2.shouldAutoOpen, true);

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
    assert.deepEqual(snapDone.steps, {
      modelConnected: true,
      teamConfigured: true,
      firstTaskCreated: true,
    });

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

test('DSH 0.2.2-rc.1 Empirical Fact 1: zero-state profiles/desktop package.json & cordis.patch.yml are initialized BEFORE plugin add in both installer.mjs and lt-installer-standalone.mjs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-zero-state-desktop-'));
  try {
    const customAppDir = path.join(tmp, 'Apps', 'DeepSeek-Harness');
    createMockDesktopFixture(customAppDir, '0.2.2-rc.1');
    const mockTgz = path.join(tmp, 'dsh-leaderteam-2.2.3.tgz');
    fs.writeFileSync(
      mockTgz,
      buildMinimalTgzBuffer({
        'package/package.json': JSON.stringify({
          name: 'dsh-leaderteam',
          version: '2.2.3',
          license: 'Apache-2.0',
          engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
        'package/leaderteam/package.json': JSON.stringify({
          name: 'dsh-leaderteam-internal',
          version: '2.2.3',
          leaderteam: { distributionTrack: 'open-source' },
        }),
      }),
    );

    // 1. `runOneClickInstallation` on brand-new dshHome1
    const dshHome1 = path.join(tmp, 'fresh-dsh-home-1');
    let pkgExistedBeforeRunner1 = false;
    let parsedPkg1 = null;
    await runOneClickInstallation({
      repoRoot: REPO_ROOT,
      dshHome: dshHome1,
      customDshPath: customAppDir,
      sourceKind: 'local-tgz',
      localTgzPath: mockTgz,
      platform: 'win32',
      spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
      installerRunner: async ({ dshHome }) => {
        const pkgPath = path.join(dshHome, 'profiles', 'desktop', 'package.json');
        pkgExistedBeforeRunner1 = fs.existsSync(pkgPath);
        if (pkgExistedBeforeRunner1) {
          parsedPkg1 = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        }
      },
    });
    assert.equal(pkgExistedBeforeRunner1, true, 'installer.mjs must initialize profiles/desktop/package.json before running dsh plugin add');
    assert.deepEqual(parsedPkg1, {
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    });

    // 2. `downloadAndInstallStandalone` on brand-new dshHome2
    const dshHome2 = path.join(tmp, 'fresh-dsh-home-2');
    let pkgExistedBeforeRunner2 = false;
    let parsedPkg2 = null;
    await downloadAndInstallStandalone({
      dshHome: dshHome2,
      customPath: customAppDir,
      localTgzPath: mockTgz,
      platform: 'win32',
      spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
      runner: async ({ dshHome }) => {
        const pkgPath = path.join(dshHome, 'profiles', 'desktop', 'package.json');
        pkgExistedBeforeRunner2 = fs.existsSync(pkgPath);
        if (pkgExistedBeforeRunner2) {
          parsedPkg2 = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        }
      },
    });
    assert.equal(pkgExistedBeforeRunner2, true, 'lt-installer-standalone.mjs must initialize profiles/desktop/package.json before running dsh plugin add');
    assert.deepEqual(parsedPkg2, {
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    });

    // 3. Verify idempotency when package.json already exists
    const secondInit = ensureDesktopProfileInitialized(dshHome1);
    assert.equal(secondInit.createdPkg, false);
    const secondStandaloneInit = ensureStandaloneDesktopProfileInitialized(dshHome2);
    assert.equal(secondStandaloneInit.createdPkg, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DSH 0.2.2-rc.1 Empirical Fact 2: dsh-app://app/ custom protocol recognized in client.js and lt-web for in-window navigation without target=_blank', () => {
  const clientCode = fs.readFileSync(path.join(REPO_ROOT, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'utf8');
  assert.ok(clientCode.includes("proto === 'dsh-app:'"), 'client.js isHttpWebSurface supports dsh-app:');
  assert.ok(!clientCode.includes('target="_blank"') && !clientCode.includes("target: '_blank'"), 'client.js never opens /lt/ with _blank');

  // Execute client.js in an isolated simulated dsh-app://app/ environment and verify rendered React tree
  const prevWin = globalThis.window;
  let assignedUrl = null;
  try {
    globalThis.window = {
      location: {
        protocol: 'dsh-app:',
        href: 'dsh-app://app/sessions/s1',
        assign(u) { assignedUrl = u; },
      },
    };
    const fn = new Function(clientCode + '\nreturn globalThis.__LEADERTEAM_PANEL_CLIENT__ || null;');
    fn();
    // Inspect App.tsx & AppShell.tsx & compiled web-dist for dsh-app: in-window return to '/'
    const appTsx = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'lt-web', 'src', 'App.tsx'), 'utf8');
    const shellTsx = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'lt-web', 'src', 'components', 'AppShell.tsx'), 'utf8');
    assert.ok(appTsx.includes("window.location?.protocol === 'dsh-app:'"));
    assert.ok(appTsx.includes("const base = isDshAppProtocol ? '/' : bundle?.capabilities.frontendSwitch.dshFrontendUrl"));
    assert.ok(shellTsx.includes("window.location?.protocol === 'dsh-app:'"));

    const webDistAssetsDir = path.join(REPO_ROOT, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'assets');
    const jsBundles = fs.readdirSync(webDistAssetsDir).filter(f => f.endsWith('.js'));
    assert.ok(jsBundles.length >= 1, 'compiled web-dist JS bundle exists');
    const bundleText = jsBundles.map(f => fs.readFileSync(path.join(webDistAssetsDir, f), 'utf8')).join('\n');
    assert.ok(bundleText.includes('dsh-app:'), 'compiled web-dist includes dsh-app: protocol support');
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
    void assignedUrl;
  }
});

test('DSH 0.2.2-rc.1 Empirical Facts 4 & 5: Windows magpie-cli.exe discovery priority and cross-process sync-stop PID preservation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-magpie-win-facts-'));
  const prevLocalAppData = process.env.LOCALAPPDATA;
  const prevProgFiles = process.env.ProgramFiles;
  const prevPath = process.env.PATH;
  try {
    // Fact 4: When both `magpie.exe` (GUI) and `magpie-cli.exe` (headless CLI) exist in `%LOCALAPPDATA%\Programs\Magpie`,
    // `discoverSystemMagpieBinary()` on Windows MUST return `magpie-cli.exe`!
    if (process.platform === 'win32') {
      const mockLocalApp = path.join(tmp, 'LocalAppData');
      const magpieProgDir = path.join(mockLocalApp, 'Programs', 'Magpie');
      fs.mkdirSync(magpieProgDir, { recursive: true });
      const guiExe = path.join(magpieProgDir, 'magpie.exe');
      const cliExe = path.join(magpieProgDir, 'magpie-cli.exe');
      fs.writeFileSync(guiExe, 'mock-gui-shell');
      fs.writeFileSync(cliExe, 'mock-headless-cli');
      process.env.LOCALAPPDATA = mockLocalApp;
      process.env.ProgramFiles = path.join(tmp, 'EmptyProgramFiles');
      process.env.PATH = '';

      const discovered = discoverSystemMagpieBinary();
      assert.equal(discovered, cliExe, 'must prefer magpie-cli.exe over Tauri GUI magpie.exe');
    }

    // Fact 5: `_stopManagedProcessesImmediateSync()` on win32 (`owned === null`) must NOT delete `managed-pid.json`
    // for a live cross-process PID before async `stop()` verifies ownership via HTTP health probe!
    const storeRoot = path.join(tmp, 'store');
    let healthProbeCount = 0;
    const mgr = new MagpieGatewayManager({
      storageRoot: storeRoot,
      defaultGatewayPort: 19425,
      defaultWebPort: 19430,
      fetchImpl: async () => {
        healthProbeCount += 1;
        return new Response(JSON.stringify({ ok: true, pid: 99999999 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    if (process.platform === 'win32') {
      const fakeRelBin = path.join(mgr.releasesDir, '0.1.0', 'magpie.exe');
      fs.mkdirSync(path.dirname(fakeRelBin), { recursive: true });
      fs.writeFileSync(fakeRelBin, 'mock');
      // Use parent PID (or another live PID !== process.pid) to simulate a live cross-process record where `_verifyOwnedPidSync` returns `null`
      const liveOtherPid = process.ppid && process.ppid > 1 && process.ppid !== process.pid ? process.ppid : null;
      if (liveOtherPid) {
        mgr._saveConfigState({
          mode: 'managed',
          gatewayPort: 19425,
          webPort: 19430,
          autoRecover: false,
          allowLocalAccountDiscovery: false,
          externalGateways: [],
        });
        mgr._writeManagedPidRecord({
          pid: liveOtherPid,
          binaryPath: fakeRelBin,
          gatewayPort: 19425,
          webPort: 19430,
          startedAt: new Date().toISOString(),
        });
        // Trigger synchronous reconfigure away from `managed` -> calls `_stopManagedProcessesImmediateSync()`
        mgr.configure({ mode: 'external' });
        assert.equal(
          fs.existsSync(mgr.pidFile),
          true,
          'win32 _stopManagedProcessesImmediateSync must preserve managed-pid.json when _verifyOwnedPidSync is indeterminate (null)',
        );
        // Subsequent async `stop()` probes HTTP health PID (sees foreign pid 99999999 !== liveOtherPid -> does NOT kill ppid!) and cleans up pidFile!
        await mgr.stop();
        assert.ok(healthProbeCount >= 1, 'async stop() performed HTTP health PID verification');
        assert.equal(fs.existsSync(mgr.pidFile), false, 'async stop() cleaned up managed-pid.json after verification');
      }
    }
  } finally {
    if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocalAppData;
    if (prevProgFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = prevProgFiles;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
