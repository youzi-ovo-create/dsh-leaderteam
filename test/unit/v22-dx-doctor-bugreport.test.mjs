import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDoctorChecks } from '../../bin/lt-doctor.mjs';
import { generateRedactedBugReport, redactDiagnosticText } from '../../bin/lt-bugreport.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCTOR_BIN = path.join(REPO_ROOT, 'bin', 'lt-doctor.mjs');
const BUGREPORT_BIN = path.join(REPO_ROOT, 'bin', 'lt-bugreport.mjs');

const VALID_PIPELINE_SOURCE = `
export class ToolExecutionPipeline {
  resolveExecution(name, agent, hasParent, toolSet) {
    return { name, description: 'mock' };
  }
  async dispatchToolBody(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
    if (!tool) return undefined;
    return await tool.execute(exec.arguments, exec);
  }
}
`;

const BROKEN_PIPELINE_SOURCE = `
export class ToolExecutionPipeline {
  resolveExecution(name) { return { name }; }
  async dispatchToolBody(exec) {
    return await exec.runDirectly(exec.arguments);
  }
}
`;

function makeMockDshHost(version, pipelineSource, layout = 'desktop-unpacked') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-mock-dsh-'));
  const toolsDir = layout === 'desktop-unpacked'
    ? path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools')
    : path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools');
  fs.mkdirSync(path.join(toolsDir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(toolsDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version }, null, 2),
    'utf8',
  );
  if (pipelineSource !== null) {
    fs.writeFileSync(path.join(toolsDir, 'lib', 'pipeline.js'), pipelineSource, 'utf8');
  }
  if (layout === 'desktop-unpacked') {
    fs.writeFileSync(
      path.join(root, 'resources', 'app.asar', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version }, null, 2),
      'utf8',
    );
  }
  return root;
}

test('lt-doctor: classifies VERIFIED, UNVERIFIED_COMPATIBLE_SHAPE, and INCOMPATIBLE_PIPELINE via --check-host', () => {
  const verifiedHostRc1 = makeMockDshHost('0.2.2-rc.1', VALID_PIPELINE_SOURCE, 'desktop-unpacked');
  const verifiedHostRc5 = makeMockDshHost('0.2.2-rc.5', VALID_PIPELINE_SOURCE, 'npm-module');
  const unverifiedHost = makeMockDshHost('0.2.3-rc.1', VALID_PIPELINE_SOURCE, 'desktop-unpacked');
  const incompatibleHost = makeMockDshHost('0.2.2-rc.1', BROKEN_PIPELINE_SOURCE, 'desktop-unpacked');

  try {
    const resRc1 = runDoctorChecks({
      checkHost: verifiedHostRc1,
      nodeVersion: '22.19.0',
      platform: 'linux',
      osReleaseText: '6.8.0-generic',
      execFileSyncImpl: () => 'GNU bash, version 5.2.21',
      env: { DEEPSEEK_API_KEY: 'sk-test-only-do-not-print' },
    });
    assert.equal(resRc1.checks.dshHost.classification, 'VERIFIED');
    assert.equal(resRc1.checks.dshHost.productionAllowed, true);
    assert.equal(resRc1.checks.dshHost.status, 'pass');
    assert.ok(!JSON.stringify(resRc1).includes('sk-test-only-do-not-print'));

    const resRc5 = runDoctorChecks({
      checkHost: verifiedHostRc5,
      nodeVersion: '24.2.0',
      platform: 'linux',
      execFileSyncImpl: () => 'GNU bash, version 5.2.21',
      env: { DEEPSEEK_API_KEY: 'sk-rc5' },
    });
    assert.equal(resRc5.checks.dshHost.classification, 'VERIFIED');
    assert.equal(resRc5.checks.dshHost.productionAllowed, true);

    const resUnverified = runDoctorChecks({
      checkHost: unverifiedHost,
      nodeVersion: '22.19.0',
      platform: 'linux',
      execFileSyncImpl: () => 'GNU bash, version 5.2.21',
      env: { DEEPSEEK_API_KEY: 'sk-unverified' },
    });
    assert.equal(resUnverified.checks.dshHost.classification, 'UNVERIFIED_COMPATIBLE_SHAPE');
    assert.match(resUnverified.checks.dshHost.classificationLabel, /isolated test only — blocked in production/);
    assert.equal(resUnverified.checks.dshHost.productionAllowed, false);
    assert.equal(resUnverified.checks.dshHost.status, 'warn');
    assert.equal(resUnverified.ok, true);

    const resIncompat = runDoctorChecks({
      checkHost: incompatibleHost,
      nodeVersion: '22.19.0',
      platform: 'linux',
      execFileSyncImpl: () => 'GNU bash, version 5.2.21',
      env: { DEEPSEEK_API_KEY: 'sk-incompat' },
    });
    assert.equal(resIncompat.checks.dshHost.classification, 'INCOMPATIBLE_PIPELINE');
    assert.equal(resIncompat.checks.dshHost.productionAllowed, false);
    assert.equal(resIncompat.checks.dshHost.status, 'fail');
    assert.equal(resIncompat.ok, false);
  } finally {
    for (const d of [verifiedHostRc1, verifiedHostRc5, unverifiedHost, incompatibleHost]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test('lt-doctor: checks Node runtime bounds, Linux cgroup v2/WSL2, Windows Win32 5 ACL remediation, and powerMonitor toggle', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-doc-env-'));
  try {
    // 1. Node <22.15 fails; 22.16 passes core and notes dsh-context build requirement
    const oldNode = runDoctorChecks({
      nodeVersion: '20.12.0',
      platform: 'darwin',
      execFileSyncImpl: () => 'bash 5',
      env: { DEEPSEEK_API_KEY: 'sk-1' },
    });
    assert.equal(oldNode.checks.nodeRuntime.status, 'fail');
    assert.equal(oldNode.ok, false);

    const midNode = runDoctorChecks({
      nodeVersion: '22.16.0',
      platform: 'darwin',
      execFileSyncImpl: () => 'bash 5',
      env: { DEEPSEEK_API_KEY: 'sk-1' },
    });
    assert.equal(midNode.checks.nodeRuntime.status, 'pass');
    assert.equal(midNode.checks.nodeRuntime.coreSupported, true);
    assert.equal(midNode.checks.nodeRuntime.extensionBuildSupported, false);

    // 2. Simulated Linux + WSL2 + cgroup v2 container limit
    const meminfoFile = path.join(tmpRoot, 'meminfo');
    const cgroupDir = path.join(tmpRoot, 'cgroup');
    fs.mkdirSync(cgroupDir, { recursive: true });
    fs.writeFileSync(meminfoFile, 'MemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n', 'utf8');
    fs.writeFileSync(path.join(cgroupDir, 'memory.max'), String(2048 * 1024 * 1024) + '\n', 'utf8');

    const linuxRes = runDoctorChecks({
      nodeVersion: '24.0.0',
      platform: 'linux',
      procMeminfoPath: meminfoFile,
      cgroupRoot: cgroupDir,
      osReleaseText: '5.15.167.4-microsoft-standard-WSL2',
      execFileSyncImpl: () => 'GNU bash, version 5.2.15',
      env: { DASHSCOPE_API_KEY: 'sk-qwen' },
    });
    assert.equal(linuxRes.checks.platformEnvironment.status, 'pass');
    assert.equal(linuxRes.checks.platformEnvironment.linuxVariant, 'wsl2');
    assert.equal(linuxRes.checks.platformEnvironment.bashAvailable, true);
    assert.equal(linuxRes.checks.platformEnvironment.memAvailableMib, 16000);
    assert.equal(linuxRes.checks.platformEnvironment.cgroupV2Present, true);
    assert.equal(linuxRes.checks.platformEnvironment.cgroupMemoryMaxMib, 2048);

    // 3. Simulated Windows workspace missing explicit (F) / WRITE_DAC+WRITE_OWNER -> warns with exact icacls & tools/dsh-sandbox-acl commands
    const winWorkspace = path.join(tmpRoot, 'new-shared-folder');
    fs.mkdirSync(winWorkspace, { recursive: true });
    const winRisky = runDoctorChecks({
      nodeVersion: '22.19.0',
      platform: 'win32',
      workspace: winWorkspace,
      username: 'devuser',
      execFileSyncImpl: () => `${winWorkspace} BUILTIN\\Administrators:(OI)(CI)(F)\n NT AUTHORITY\\Authenticated Users:(OI)(CI)(M)\n`,
      env: { DEEPSEEK_API_KEY: 'sk-ds' },
    });
    assert.equal(winRisky.checks.platformEnvironment.status, 'warn');
    assert.equal(winRisky.checks.platformEnvironment.aclRisky, true);
    assert.ok(winRisky.checks.platformEnvironment.remediationCommands.some(c => c.includes('/grant "%USERNAME%:(OI)(CI)F"')));
    assert.ok(winRisky.checks.platformEnvironment.remediationCommands.some(c => c.includes('tools/dsh-sandbox-acl')));

    // 4. Simulated Windows workspace with explicit (F) grant + powerMonitor disabled in config override
    const customCfgDir = path.join(tmpRoot, 'cfg');
    fs.mkdirSync(customCfgDir, { recursive: true });
    const baseCfgText = fs.readFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), 'utf8');
    fs.writeFileSync(path.join(customCfgDir, 'leaderteam.config.json'), baseCfgText, 'utf8');
    fs.writeFileSync(
      path.join(customCfgDir, 'leaderteam.local.json'),
      JSON.stringify({ powerMonitor: { enabled: false } }, null, 2),
      'utf8',
    );

    const winHealthy = runDoctorChecks({
      nodeVersion: '22.19.0',
      platform: 'win32',
      workspace: winWorkspace,
      username: 'devuser',
      configPath: path.join(customCfgDir, 'leaderteam.config.json'),
      execFileSyncImpl: () => `${winWorkspace} WORKSTATION\\devuser:(OI)(CI)(F)\n`,
      env: { DEEPSEEK_API_KEY: 'sk-ds' },
    });
    assert.equal(winHealthy.checks.platformEnvironment.status, 'pass');
    assert.equal(winHealthy.checks.platformEnvironment.aclRisky, false);
    assert.equal(winHealthy.checks.configuration.powerMonitor.enabled, false);
    assert.match(winHealthy.checks.configuration.powerMonitor.privacyNote, /\(onBattery, batteryPct\)/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('lt-doctor CLI: executes with --json and --check-host without console popups (including packed app.asar)', () => {
  const verifiedHost = makeMockDshHost('0.2.2-rc.1', VALID_PIPELINE_SOURCE, 'npm-module');
  const packedAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-packed-asar-'));
  try {
    // Build a real Chromium-Pickle Electron app.asar binary archive with dsh-tools 0.2.2-rc.3
    const pkgBytes = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.2-rc.3' }), 'utf8');
    const pipeBytes = Buffer.from(VALID_PIPELINE_SOURCE, 'utf8');
    const indexObj = {
      files: {
        dsh: {
          files: {
            node_modules: {
              files: {
                '@deepseek-ai': {
                  files: {
                    'dsh-tools': {
                      files: {
                        'package.json': { size: pkgBytes.length, offset: '0' },
                        lib: {
                          files: {
                            'pipeline.js': { size: pipeBytes.length, offset: String(pkgBytes.length) },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const jsonBuf = Buffer.from(JSON.stringify(indexObj), 'utf8');
    const alignedJsonLen = Math.ceil(jsonBuf.length / 4) * 4;
    const headerPickleSize = 8 + alignedJsonLen;
    const header = Buffer.alloc(8 + headerPickleSize);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(headerPickleSize, 4);
    header.writeUInt32LE(headerPickleSize - 4, 8);
    header.writeUInt32LE(jsonBuf.length, 12);
    jsonBuf.copy(header, 16);
    fs.mkdirSync(path.join(packedAppDir, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(packedAppDir, 'resources', 'app.asar'), Buffer.concat([header, pkgBytes, pipeBytes]));

    const asarCheck = runDoctorChecks({
      checkHost: packedAppDir,
      nodeVersion: '22.19.0',
      platform: 'linux',
      execFileSyncImpl: () => 'bash 5.2',
      env: { DEEPSEEK_API_KEY: 'sk-asar' },
    });
    assert.equal(asarCheck.checks.dshHost.classification, 'UNVERIFIED_COMPATIBLE_SHAPE');
    assert.equal(asarCheck.checks.dshHost.toolsVersion, '0.2.2-rc.3');
    assert.equal(asarCheck.checks.dshHost.status, 'warn');
    assert.equal(asarCheck.checks.dshHost.productionAllowed, false);

    const proc = spawnSync(process.execPath, [DOCTOR_BIN, '--json', '--check-host', verifiedHost], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(proc.status, 0, proc.stderr);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.checks.dshHost.classification, 'VERIFIED');
  } finally {
    fs.rmSync(verifiedHost, { recursive: true, force: true });
    fs.rmSync(packedAppDir, { recursive: true, force: true });
  }
});

test('lt-bugreport: enforces 0 leaks of keys, Windows/POSIX paths, drive paths, usernames, and prompts while preserving exact counts & 4-bucket totals', () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-bugreport-'));
  const teamDir = path.join(storageRoot, 'teams', 'session-redaction-01');
  fs.mkdirSync(teamDir, { recursive: true });

  const FAKE_API_KEY = 'sk-live-1234567890abcdef12345678';
  const FAKE_WIN_USER_PATH = 'C:\\Users\\alice\\secret-proj';
  const FAKE_POSIX_PATH = '/home/bob/private';
  const FAKE_DRIVE_PATH = 'E:\\统一工作区\\foo';
  const FAKE_SECRET_PROMPT = 'TOP_SECRET_PROPRIETARY_PROMPT_PROJECT_ORION_9941';
  const FAKE_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.superSecretPayloadToken999';
  const FAKE_HEX = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  try {
    fs.writeFileSync(
      path.join(teamDir, 'team.json'),
      JSON.stringify({
        v: 1,
        teamId: 'session-redaction-01',
        createdAt: '2026-11-23T12:00:00.000Z',
        workspace: FAKE_WIN_USER_PATH,
        altWorkspace: FAKE_POSIX_PATH,
        sharedDrive: FAKE_DRIVE_PATH,
        userTask: FAKE_SECRET_PROMPT,
        apiKey: FAKE_API_KEY,
        auth: FAKE_BEARER,
        secretDigest: FAKE_HEX,
      }, null, 2),
      'utf8',
    );

    fs.writeFileSync(
      path.join(teamDir, 'governance.json'),
      JSON.stringify({
        v: 1,
        config: {
          governance: { mode: 'autonomous' },
          powerMonitor: { enabled: true },
          plugins: { scheduler: true, consensus: true, timerArchive: true, panel: false },
          models: {
            'https://alice:secretpass@corp-gateway.internal/deepseek-reasoner': { family: 'deepseek' },
            'zcode/GLM-5.3': { family: 'glm' },
          },
          roles: {
            leader: { route: 'https://alice:secretpass@corp-gateway.internal/deepseek-reasoner', effort: 'high' },
            gate: { route: 'zcode/GLM-5.3', effort: 'medium', fallback: [{ route: 'deepseek/deepseek-chat', effort: 'low' }] },
            arbiter: { route: 'zcode/GLM-5.3', effort: 'max' },
          },
        },
      }, null, 2),
      'utf8',
    );

    const membersLines = [
      { v: 1, type: 'member', childId: 'm1', name: 'alice-secret-worker', profile: 'code' },
      { v: 1, type: 'member-status', childId: 'm1', status: 'done' },
      { v: 1, type: 'member', childId: 'm2', name: 'bob-shell-worker', profile: 'shell' },
      { v: 1, type: 'member-status', childId: 'm2', status: 'done' },
      { v: 1, type: 'member', childId: 'm3', name: 'failing-worker', profile: 'shell' },
      { v: 1, type: 'member-status', childId: 'm3', status: 'failed', error: `denied at ${FAKE_WIN_USER_PATH} & ${FAKE_DRIVE_PATH} with ${FAKE_API_KEY}` },
    ];
    fs.writeFileSync(path.join(teamDir, 'members.jsonl'), membersLines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    const gateLines = [
      { decision: 'allow', by: 'sandbox', tool: 'write', argsPreview: `{"file_path":"${FAKE_WIN_USER_PATH}\\\\a.js","prompt":"${FAKE_SECRET_PROMPT}"}` },
      { decision: 'allow', by: 'sandbox', tool: 'edit', argsPreview: `{"file_path":"${FAKE_POSIX_PATH}/b.js"}` },
      { decision: 'allow', by: 'rule-only', tool: 'team_plan', argsPreview: FAKE_SECRET_PROMPT },
      { decision: 'deny', by: 'rule:outside-workspace', tool: 'bash', argsPreview: `cat ${FAKE_POSIX_PATH} > ${FAKE_DRIVE_PATH} ${FAKE_BEARER}`, reason: `blocked ${FAKE_WIN_USER_PATH}` },
      { decision: 'deny', by: 'rule:outside-workspace', tool: 'write', argsPreview: FAKE_API_KEY, reason: FAKE_SECRET_PROMPT },
      { decision: 'deny', by: 'model', tool: 'bash', argsPreview: FAKE_HEX, reason: `denied prompt ${FAKE_SECRET_PROMPT}` },
    ];
    fs.writeFileSync(path.join(teamDir, 'gate.jsonl'), gateLines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    const usageLines = [
      {
        role: 'gate',
        route: 'zcode/GLM-5.3',
        usage: { inputTokens: 1200, cacheReadTokens: 8000, cacheWriteTokens: 400, outputTokens: 150, totalTokens: 9750 },
        prompt: FAKE_SECRET_PROMPT,
      },
      {
        role: 'gate',
        route: 'zcode/GLM-5.3',
        usage: { inputTokens: 800, cacheReadTokens: 6000, cacheWriteTokens: 0, outputTokens: 100, totalTokens: 6900 },
      },
      {
        role: 'discussA',
        route: 'deepseek/deepseek-reasoner',
        usage: { inputTokens: 2500, cacheReadTokens: 15000, cacheWriteTokens: 1000, outputTokens: 600, totalTokens: 19100 },
      },
      {
        role: 'arbiter',
        route: 'zcode/GLM-5.3',
        usage: { inputTokens: 3000, cacheReadTokens: 10000, cacheWriteTokens: 500, outputTokens: 900 },
      },
    ];
    fs.writeFileSync(path.join(teamDir, 'usage.jsonl'), usageLines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    const govLines = [
      { type: 'supervision-completed', summaryA: FAKE_SECRET_PROMPT },
      { type: 'dispute-strike-recorded', strikeCount: 1, summaryA: FAKE_WIN_USER_PATH, summaryB: FAKE_POSIX_PATH },
      { type: 'caucus-completed', tally: { approved: true } },
      { type: 'conference-opened', conferenceId: 'conf-1', initialExpectation: FAKE_SECRET_PROMPT },
      { type: 'conference-concluded', conferenceId: 'conf-1', ruling: { rulingSummary: FAKE_DRIVE_PATH } },
      { kind: 'request-window-throttle', tier: 'cap_new_dispatches' },
      { type: 'power-monitor', action: 'notify_graceful_shutdown', batteryPct: 18 },
    ];
    fs.writeFileSync(path.join(teamDir, 'governance.jsonl'), govLines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

    const report = generateRedactedBugReport({
      storageRoot,
      hostname: 'SECRET-WORKSTATION-HOST',
      username: 'alice',
    });

    const combinedOutput = `${report.markdown}\n${JSON.stringify(report)}`;
    const forbiddenSubstrings = [
      FAKE_API_KEY,
      'sk-live-',
      '1234567890abcdef',
      'alice',
      'secret-proj',
      'bob',
      'private',
      '统一工作区',
      'E:\\',
      'C:\\Users',
      '/home/bob',
      FAKE_SECRET_PROMPT,
      'PROJECT_ORION',
      'superSecretPayloadToken999',
      'secretpass',
      'corp-gateway.internal',
      FAKE_HEX,
      'SECRET-WORKSTATION-HOST',
    ];
    for (const leak of forbiddenSubstrings) {
      assert.equal(combinedOutput.includes(leak), false, `Expected 0 leaks, but output contained "${leak}"`);
    }

    // Verify accurate aggregate counts & 4-bucket physical token totals!
    assert.equal(report.metrics.teamFound, true);
    assert.equal(report.metrics.totalMembers, 3);
    assert.deepEqual(report.metrics.membersByStatus, { done: 2, failed: 1 });

    assert.equal(report.metrics.gate.total, 6);
    assert.equal(report.metrics.gate.allow, 3);
    assert.equal(report.metrics.gate.deny, 3);
    assert.deepEqual(report.metrics.gate.byRule.allow, { sandbox: 2, 'rule-only': 1 });
    assert.deepEqual(report.metrics.gate.byRule.deny, { 'rule:outside-workspace': 2, model: 1 });

    assert.deepEqual(report.metrics.usageByRole.gate, {
      calls: 2,
      inputTokens: 2000,
      cacheReadTokens: 14000,
      cacheWriteTokens: 400,
      outputTokens: 250,
      totalTokens: 16650,
    });
    assert.deepEqual(report.metrics.usageTotal, {
      calls: 4,
      inputTokens: 7500,
      cacheReadTokens: 39000,
      cacheWriteTokens: 1900,
      outputTokens: 1750,
      totalTokens: 50150,
    });

    assert.deepEqual(report.metrics.governance, {
      supervisionReviews: 1,
      strikes: 1,
      caucuses: 1,
      conferencesOpened: 1,
      conferencesConcluded: 1,
      humanEscalations: 0,
      requestWindowEvents: 1,
      lowBatteryEvents: 1,
    });

    // Also test direct inline redaction helper on raw path/secret text
    const rawLine = `key=${FAKE_API_KEY} auth="${FAKE_BEARER}" win=${FAKE_WIN_USER_PATH}\\a.ts nix=${FAKE_POSIX_PATH}/b.ts drv=${FAKE_DRIVE_PATH}\\c.ts`;
    const scrubbedLine = redactDiagnosticText(rawLine, { username: 'alice', hostname: 'MY-PC' });
    assert.match(scrubbedLine, /<USER_HOME>\//);
    assert.match(scrubbedLine, /<LOCAL_PATH>\//);
    for (const leak of [FAKE_API_KEY, 'alice', 'secret-proj', 'bob', 'private', '统一工作区', 'foo', 'superSecretPayloadToken999']) {
      assert.equal(scrubbedLine.includes(leak), false, `Inline redactor leaked "${leak}"`);
    }

    // Verify CLI execution produces clean Markdown
    const cliProc = spawnSync(process.execPath, [BUGREPORT_BIN, '--storage-root', storageRoot], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(cliProc.status, 0, cliProc.stderr);
    assert.match(cliProc.stdout, /LeaderTeam Redacted Diagnostics/);
    assert.match(cliProc.stdout, /50150/);
    assert.equal(cliProc.stdout.includes(FAKE_SECRET_PROMPT), false);
    assert.equal(cliProc.stdout.includes(FAKE_API_KEY), false);
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('examples/smoke-bugfix, GitHub issue templates, and README/docs relative-path hygiene', () => {
  const smokeDir = path.join(REPO_ROOT, 'examples', 'smoke-bugfix');
  for (const rel of ['src/discount.mjs', 'src/invoice.mjs', 'test/invoice.test.mjs', 'leaderteam.smoke.json', 'README.md']) {
    assert.equal(fs.existsSync(path.join(smokeDir, rel)), true, `Missing smoke-bugfix file: ${rel}`);
  }

  // Validate smoke config against LeaderTeam schema and verify bounded low-step limits
  const smokeCfg = loadConfig(path.join(smokeDir, 'leaderteam.smoke.json'));
  assert.equal(smokeCfg.governance.directExecMaxSteps, 8);
  assert.equal(smokeCfg.team.maxMembersPerTeam, 4);
  assert.equal(smokeCfg.team.maxActiveMembers, 2);

  // Verify smoke README explicitly frames time/cost as design experience targets, NOT fixed guarantees
  const smokeReadme = fs.readFileSync(path.join(smokeDir, 'README.md'), 'utf8');
  assert.match(smokeReadme, /设计体验目标/);
  assert.match(smokeReadme, /不构成固定/);

  // Run smoke test suite before fix -> expect 2 pass and 2 fail
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  const testRun = spawnSync(process.execPath, ['--test', '--test-reporter=spec', path.join(smokeDir, 'test', 'invoice.test.mjs')], {
    cwd: smokeDir,
    env: cleanEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.notEqual(testRun.status, 0, 'Smoke test should fail before bugs are fixed');
  const combinedTestOut = `${testRun.stdout}\n${testRun.stderr}`;
  assert.match(combinedTestOut, /(?:ℹ|#)\s*pass\s+2\b/);
  assert.match(combinedTestOut, /(?:ℹ|#)\s*fail\s+2\b/);

  // Verify GitHub issue templates exist
  for (const tpl of ['01-install-and-compat.yml', '02-safety-gate-feedback.yml', '03-community-reproduction.yml']) {
    const p = path.join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE', tpl);
    assert.equal(fs.existsSync(p), true, `Missing issue template ${tpl}`);
    assert.match(fs.readFileSync(p, 'utf8'), /lt-bugreport/);
  }

  // Verify ZERO file:///E:/... or C:\Users\... links anywhere in README.md or docs/**/*.md
  function collectMarkdownFiles(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...collectMarkdownFiles(full));
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
    }
    return out;
  }
  const mdFiles = [path.join(REPO_ROOT, 'README.md'), ...collectMarkdownFiles(path.join(REPO_ROOT, 'docs'))];
  for (const file of mdFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    assert.doesNotMatch(content, /file:\/\/\//i, `Found forbidden file:/// link in ${rel}`);
    assert.doesNotMatch(content, /\b[A-Za-z]:\\Users\\/i, `Found forbidden Windows personal path in ${rel}`);
    assert.doesNotMatch(content, /\bE:[/\\]/i, `Found forbidden local drive path in ${rel}`);
  }
});
