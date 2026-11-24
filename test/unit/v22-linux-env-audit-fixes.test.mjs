import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: 'virtual-linux-audit:dsh-llm', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-linux-audit:dsh-llm') {
      return { format: 'module', shortCircuit: true, source: 'export const boundContextSummary = s => s; export const createUserMessage = x => x;' };
    }
    return nextLoad(url, context);
  },
});

import { readSystemPowerSample } from '../../leaderteam/host/power-adapter.mjs';
import {
  createPowerMonitorState,
  evaluatePowerSample,
  registerTeamsForPowerLatch,
  clearTeamPowerPauseOnUserTurn,
} from '../../leaderteam/core/power-monitor.mjs';
import { readLinuxCgroupLimits } from '../../leaderteam/core/scheduler.mjs';
import {
  classifySandboxBoundary,
  evaluateHardRules,
  evaluateDirectExecSafetyGate,
  evaluateCrossBoundarySafetyGate,
  parseReadGrants,
} from '../../leaderteam/core/gate-policy.mjs';
import { inspectPatchTextForLegacyLeaderTeam } from '../../leaderteam/core/legacy-patch-guard.mjs';
import { checkGovernanceExecutionGate } from '../../leaderteam/core/governance-protocol.mjs';
import { runDoctorChecks } from '../../bin/lt-doctor.mjs';
import { redactDiagnosticText } from '../../bin/lt-bugreport.mjs';
import { configWith } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('[Linux Fix 1] Symlinked .bin CLIs (lt-doctor, lt-bugreport, configure-models) and plan-archive --status execute cleanly', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-linux-bin-link-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const binDir = path.join(tmp, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });

  const doctorTarget = path.join(REPO_ROOT, 'bin', 'lt-doctor.mjs');
  const bugreportTarget = path.join(REPO_ROOT, 'bin', 'lt-bugreport.mjs');
  const cfgTarget = path.join(REPO_ROOT, 'scripts', 'configure-models.mjs');

  let doctorEntry = doctorTarget;
  let bugreportEntry = bugreportTarget;
  let cfgEntry = cfgTarget;
  try {
    const dLink = path.join(binDir, 'lt-doctor');
    const bLink = path.join(binDir, 'lt-bugreport');
    const cLink = path.join(binDir, 'configure-models');
    fs.symlinkSync(doctorTarget, dLink);
    fs.symlinkSync(bugreportTarget, bLink);
    fs.symlinkSync(cfgTarget, cLink);
    doctorEntry = dLink;
    bugreportEntry = bLink;
    cfgEntry = cLink;
  } catch (err) {
    if (err?.code !== 'EPERM') throw err;
  }

  const docRun = spawnSync(process.execPath, [doctorEntry, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(docRun.status, 0, docRun.stderr);
  assert.ok(docRun.stdout.trim().length > 10, 'symlinked lt-doctor must emit JSON output instead of silently exiting');
  const docJson = JSON.parse(docRun.stdout);
  assert.equal(typeof docJson.ok, 'boolean');

  const bugRun = spawnSync(process.execPath, [bugreportEntry, '--json', '--storage-root', path.join(tmp, 'empty-store')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(bugRun.status, 0, bugRun.stderr);
  const bugJson = JSON.parse(bugRun.stdout);
  assert.equal(bugJson.ok, true);

  const cfgRun = spawnSync(process.execPath, [cfgEntry, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(cfgRun.status, 0, cfgRun.stderr);
  assert.match(cfgRun.stdout, /LeaderTeam External Model/);

  // Direct shebang execution on POSIX (verifies 0755 mode & LF line endings)
  if (process.platform !== 'win32') {
    const envWithNode = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}` };
    const directDoc = spawnSync(doctorTarget, ['--help'], {
      cwd: REPO_ROOT,
      env: envWithNode,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(directDoc.status, 0, directDoc.stderr);
    assert.match(directDoc.stdout, /Usage: lt-doctor/);
  }

  // `plan-archive.mjs --status --json` must not fail with PLAN_ARCHIVE_INSIDE_PROJECT when DSH_HOME is unset
  const cleanEnv = { ...process.env };
  delete cleanEnv.DSH_HOME;
  delete cleanEnv.LT_DSH_HOME;
  delete cleanEnv.LEADERTEAM_PLAN_ARCHIVE_ROOT;
  const archiveRun = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'plan-archive.mjs'), '--status', '--json'], {
    cwd: REPO_ROOT,
    env: cleanEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(archiveRun.status, 0, archiveRun.stderr);
  const archiveStats = JSON.parse(archiveRun.stdout);
  assert.equal(typeof archiveStats.totalPlans, 'number');
});

test('[Linux Fix 2] Sysfs power adapter filters peripheral scope=Device batteries, ignores readdirSync order, supports USB-PD & energy weighting, and honors explicit user resume', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-linux-power-fix-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 1. Desktop PC with ONLY a 10% wireless mouse (`scope=Device`, `type=Battery`, `status=Discharging`) -> `unsupported`!
  const desktopMouseDir = path.join(tmp, 'desktop-mouse');
  fs.mkdirSync(path.join(desktopMouseDir, 'hidpp_battery_0'), { recursive: true });
  fs.writeFileSync(path.join(desktopMouseDir, 'hidpp_battery_0', 'type'), 'Battery\n');
  fs.writeFileSync(path.join(desktopMouseDir, 'hidpp_battery_0', 'scope'), 'Device\n');
  fs.writeFileSync(path.join(desktopMouseDir, 'hidpp_battery_0', 'status'), 'Discharging\n');
  fs.writeFileSync(path.join(desktopMouseDir, 'hidpp_battery_0', 'capacity'), '10\n');

  const desktopSample = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    sysfsPowerDir: desktopMouseDir,
  });
  assert.equal(desktopSample.status, 'unsupported', 'peripheral wireless mouse battery must NEVER trigger desktop low-battery shutdown');
  assert.equal(desktopSample.onBattery, null);

  // 2. Laptop with `BAT0` before USB-PD charger in `readdirSync` order AND `BAT0/status="Unknown"` (80% charge threshold)
  const thresholdDir = path.join(tmp, 'laptop-threshold');
  fs.mkdirSync(path.join(thresholdDir, 'BAT0'), { recursive: true });
  fs.mkdirSync(path.join(thresholdDir, 'ucsi-source-psy-USBC000:001'), { recursive: true });
  fs.writeFileSync(path.join(thresholdDir, 'BAT0', 'type'), 'Battery\n');
  fs.writeFileSync(path.join(thresholdDir, 'BAT0', 'status'), 'Unknown\n');
  fs.writeFileSync(path.join(thresholdDir, 'BAT0', 'energy_now'), '48000000\n');
  fs.writeFileSync(path.join(thresholdDir, 'BAT0', 'energy_full'), '60000000\n');
  fs.writeFileSync(path.join(thresholdDir, 'ucsi-source-psy-USBC000:001', 'type'), 'USB_PD\n');
  fs.writeFileSync(path.join(thresholdDir, 'ucsi-source-psy-USBC000:001', 'online'), '1\n');

  const orderedFs = {
    readdirSync: () => ['BAT0', 'ucsi-source-psy-USBC000:001'],
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
  };
  const usbPdSample = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    fs: orderedFs,
    sysfsPowerDir: thresholdDir,
  });
  assert.equal(usbPdSample.status, 'ok');
  assert.equal(usbPdSample.onBattery, false);
  assert.equal(usbPdSample.batteryPct, 80);

  // 3. Energy-weighted dual battery (`BAT0` 24Wh @ 80% + `BAT1` 72Wh @ 20% = 35%) + ignored `scope=Device` stylus at 5%
  const dualDir = path.join(tmp, 'dual-bat');
  fs.mkdirSync(path.join(dualDir, 'BAT0'), { recursive: true });
  fs.mkdirSync(path.join(dualDir, 'BAT1'), { recursive: true });
  fs.mkdirSync(path.join(dualDir, 'wacom_battery_0'), { recursive: true });
  fs.writeFileSync(path.join(dualDir, 'BAT0', 'type'), 'Battery\n');
  fs.writeFileSync(path.join(dualDir, 'BAT0', 'status'), 'Discharging\n');
  fs.writeFileSync(path.join(dualDir, 'BAT0', 'capacity'), '80\n');
  fs.writeFileSync(path.join(dualDir, 'BAT0', 'energy_full'), '24000000\n');
  fs.writeFileSync(path.join(dualDir, 'BAT1', 'type'), 'Battery\n');
  fs.writeFileSync(path.join(dualDir, 'BAT1', 'status'), 'Discharging\n');
  fs.writeFileSync(path.join(dualDir, 'BAT1', 'capacity'), '20\n');
  fs.writeFileSync(path.join(dualDir, 'BAT1', 'energy_full'), '72000000\n');
  fs.writeFileSync(path.join(dualDir, 'wacom_battery_0', 'type'), 'Battery\n');
  fs.writeFileSync(path.join(dualDir, 'wacom_battery_0', 'scope'), 'Device\n');
  fs.writeFileSync(path.join(dualDir, 'wacom_battery_0', 'status'), 'Discharging\n');
  fs.writeFileSync(path.join(dualDir, 'wacom_battery_0', 'capacity'), '5\n');

  const dualSample = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    sysfsPowerDir: dualDir,
  });
  assert.equal(dualSample.status, 'ok');
  assert.equal(dualSample.onBattery, true);
  assert.equal(dualSample.batteryPct, 35);

  // 4. Explicit user resume while latched unblocks only that team until a future new low-battery trigger
  const { isTeamAwaitingUserAfterPowerPause } = await import('../../leaderteam/host/concurrency.mjs');
  const pmState = createPowerMonitorState();
  evaluatePowerSample(pmState, { status: 'ok', onBattery: true, batteryPct: 18 }, undefined, 1000);
  registerTeamsForPowerLatch(pmState, ['team-1', 'team-2']);
  const fakeRt = { config: { powerMonitor: { enabled: true } }, powerMonitorState: pmState };
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-1'), true);
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-2'), true);

  clearTeamPowerPauseOnUserTurn(pmState, 'team-1');
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-1'), false, 'explicit user turn unblocks team-1 even before next 12m battery poll');
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-2'), true, 'team-2 remains paused');
});

test('[Linux Fix 3] cgroup v2 ancestor slices, inactive_file page-cache subtraction, hybrid v1+v2 fallback, and lt-doctor root cgroup.controllers', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-linux-cg-fix-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 1. Ancestor slice memory limit + reclaimable `inactive_file` cache subtraction
  const cgRoot = path.join(tmp, 'cgroup-hier');
  const sliceDir = path.join(cgRoot, 'user.slice', 'user-1000.slice');
  const scopeDir = path.join(sliceDir, 'session-72.scope');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(path.join(cgRoot, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
  // Leaf scope has `max`, parent slice enforces 2048 MiB limit & 2.0 CPU cores
  fs.writeFileSync(path.join(scopeDir, 'memory.max'), 'max\n');
  fs.writeFileSync(path.join(scopeDir, 'cpu.max'), 'max 100000\n');
  fs.writeFileSync(path.join(sliceDir, 'memory.max'), String(2048 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(sliceDir, 'cpu.max'), '200000 100000\n');
  // Raw `memory.current` is 1800 MiB, but 1400 MiB is reclaimable `inactive_file` page cache -> effective used = 400 MiB (1648 MiB remaining!)
  fs.writeFileSync(path.join(scopeDir, 'memory.current'), String(1800 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(scopeDir, 'memory.stat'), `anon ${400 * 1024 * 1024}\ninactive_file ${1400 * 1024 * 1024}\n`);

  const mockSelfCgFs = {
    existsSync: p => {
      if (p === '/proc/self/cgroup') return true;
      const mapped = p.startsWith('/sys/fs/cgroup') ? path.join(cgRoot, p.slice('/sys/fs/cgroup'.length)) : p;
      return fs.existsSync(mapped);
    },
    readFileSync: (p, enc) => {
      if (p === '/proc/self/cgroup') return '0::/user.slice/user-1000.slice/session-72.scope\n';
      const mapped = p.startsWith('/sys/fs/cgroup') ? path.join(cgRoot, p.slice('/sys/fs/cgroup'.length)) : p;
      return fs.readFileSync(mapped, enc);
    },
  };

  const hierLimits = readLinuxCgroupLimits(mockSelfCgFs, '/sys/fs/cgroup');
  assert.equal(hierLimits.version, 2);
  assert.equal(hierLimits.memoryLimitMib, 2048, 'must inherit 2048 MiB limit from ancestor user-1000.slice');
  assert.equal(hierLimits.memoryUsageMib, 400, 'must subtract reclaimable inactive_file cache from memory.current');
  assert.equal(hierLimits.memoryRemainingMib, 1648);
  assert.equal(hierLimits.cpuQuotaCores, 2);

  // 2. Hybrid cgroup v1+v2 host (root has `cpu.max = "max 100000"`, while v1 `memory/memory.limit_in_bytes` caps at 1024 MiB)
  const hybridRoot = path.join(tmp, 'cgroup-hybrid');
  fs.mkdirSync(path.join(hybridRoot, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(hybridRoot, 'cpu.max'), 'max 100000\n');
  fs.writeFileSync(path.join(hybridRoot, 'memory', 'memory.limit_in_bytes'), String(1024 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(hybridRoot, 'memory', 'memory.usage_in_bytes'), String(300 * 1024 * 1024) + '\n');
  const hybridLimits = readLinuxCgroupLimits(fs, hybridRoot);
  assert.equal(hybridLimits.version, 1);
  assert.equal(hybridLimits.memoryLimitMib, 1024);
  assert.equal(hybridLimits.memoryRemainingMib, 724);

  // 3. `lt-doctor` detects cgroup v2 on standard systemd hosts (root `cgroup.controllers` without root `memory.max`)
  //    AND deep-merges partial `leaderteam.local.json` when custom `fsImpl` is passed
  const cfgDir = path.join(tmp, 'cfg-merge');
  const bareCg2 = path.join(tmp, 'bare-cg2');
  const memFile = path.join(tmp, 'meminfo');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(bareCg2, { recursive: true });
  fs.writeFileSync(path.join(bareCg2, 'cgroup.controllers'), 'cpu memory pids\n');
  fs.writeFileSync(memFile, 'MemTotal:       16384000 kB\nMemAvailable:   12288000 kB\n');
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), path.join(cfgDir, 'leaderteam.config.json'));
  fs.writeFileSync(path.join(cfgDir, 'leaderteam.local.json'), JSON.stringify({ team: { maxActiveMembers: 4 } }, null, 2));

  const customFs = {
    existsSync: p => fs.existsSync(p),
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    readdirSync: (p, opts) => fs.readdirSync(p, opts),
    statSync: p => fs.statSync(p),
    realpathSync: p => fs.realpathSync(p),
  };
  const docReport = runDoctorChecks({
    nodeVersion: '24.22.3',
    platform: 'linux',
    procMeminfoPath: memFile,
    cgroupRoot: bareCg2,
    osReleaseText: '6.8.0-151-generic',
    configPath: path.join(cfgDir, 'leaderteam.config.json'),
    execFileSyncImpl: () => 'GNU bash, version 5.2.21',
    env: { DEEPSEEK_API_KEY: 'sk-test' },
    fsImpl: customFs,
  });
  assert.equal(docReport.checks.platformEnvironment.cgroupV2Present, true);
  assert.equal(docReport.checks.configuration.status, 'pass', docReport.checks.configuration.summary);
});

test('[Linux Fix 4] Bash safety gate blocks ANSI-C $\'...\' escapes, mid-token/multi .., ${PWD%/*}, ~user/~-, ln multi-source, env -C, and symlink escapes while allowing spaced workspaces ("Leader Team")', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-spaced-gate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const wsSpaced = path.join(tmp, 'Leader Team', 'project');
  const outsideDir = path.join(tmp, 'outside-secrets');
  fs.mkdirSync(path.join(wsSpaced, 'src'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(wsSpaced, 'src', 'app.mjs'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret\n');

  let hasSymlink = false;
  try {
    fs.symlinkSync(outsideDir, path.join(wsSpaced, 'src', 'alias-ext'), 'dir');
    hasSymlink = true;
  } catch (err) {
    if (err?.code !== 'EPERM') throw err;
  }

  const cfg = configWith({
    paths: { globalRefRoots: ['/opt/refs'] },
  });
  const shellMember = {
    role: 'member',
    name: 'impl-linux',
    profile: 'shell',
    allowedTools: cfg.profiles.shell.tools,
    loadedTools: cfg.profiles.shell.tools,
    writeScope: ['src/**'],
    unreadRefs: [],
  };
  const directActor = {
    role: 'direct_exec',
    name: 'direct-exec',
    profile: 'direct_exec',
    allowedTools: ['read', 'write', 'edit', 'bash', 'pwsh'],
    loadedTools: ['read', 'write', 'edit', 'bash', 'pwsh'],
    writeScope: ['src/**'],
    unreadRefs: [],
  };

  const hard = (command, actor = shellMember, cwd = wsSpaced) => evaluateHardRules({
    tool: 'bash',
    args: { command },
    actor,
    cwd,
    platform: 'linux',
  }, cfg);
  const boundary = (command, cwd = wsSpaced) => classifySandboxBoundary({
    tool: 'bash',
    args: { command },
    actor: shellMember,
    cwd,
    platform: 'linux',
  }, cfg);
  const directGate = (command, cwd = wsSpaced) => evaluateDirectExecSafetyGate({
    tool: 'bash',
    args: { command },
    actor: directActor,
    cwd,
    platform: 'linux',
  }, cfg);

  // 1. Spaced workspace paths ("/tmp/.../Leader Team/project") & Linux CLI idioms MUST NOT be falsely blocked!
  for (const validLinuxCmd of [
    `node "${wsSpaced}/src/app.mjs"`,
    '/usr/bin/python3 -m unittest discover -s src',
    "awk '/ERROR/ {print $0}' src/app.mjs",
    'npx vite build --base=/app',
    'SECRET_KEY=test_only npm test',
    'git log -n 1 HEAD~1',
  ]) {
    assert.equal(hard(validLinuxCmd), undefined, `valid Linux command must pass hard rules: ${validLinuxCmd}`);
    assert.equal(boundary(validLinuxCmd).confined, true, `valid Linux command must stay sandbox-confined: ${validLinuxCmd}`);
    assert.equal(hard(validLinuxCmd, directActor), undefined, `valid Linux command must pass direct_exec hard rules: ${validLinuxCmd}`);
    assert.equal(directGate(validLinuxCmd).decision, 'allow', `valid Linux command must pass direct_exec gate: ${validLinuxCmd}`);
  }
  // Substitution referencing quoted spaced workspace path must NOT fail hard rules (only enters gate review via `confined: false`)
  const spacedSubCmd = `OUT=$(node "${wsSpaced}/src/app.mjs")`;
  assert.equal(hard(spacedSubCmd), undefined, 'quoted spaced workspace path inside $(...) must not trigger false path escape');
  assert.equal(boundary(spacedSubCmd).confined, false);

  // Adjacent directory prefix (`/opt/refs-service` vs globalRefRoot `/opt/refs`) must NOT trigger `shell-touches-global-refs`
  assert.equal(hard('node src/app.mjs', shellMember, '/opt/refs-service'), undefined);

  // `parseReadGrants` expands `~/...` on Linux
  assert.deepEqual(parseReadGrants(['允许读取 ~/reference-docs'], 'linux', '/home/dev'), ['/home/dev/reference-docs']);

  // 2. Deterministic hard-rule blocks on ANSI-C `$'...'`, `${PWD%/*}`, `~user`/`~-`, `ln` multi-source, `env -C`, & heredoc sub-shells
  for (const hardEscape of [
    "echo pwn > $'\\x2f\\x74\\x6d\\x70\\x2f\\x65\\x73\\x63'",
    "echo $'1\\'' ; cd $'\\x2f\\x65\\x74\\x63' ; cat passwd > $'\\x2f\\x74\\x6d\\x70\\x2f\\x78' ; echo $'2\\''",
    'echo pwn > ${PWD%/*}/escape',
    'cd ${PWD%/*}',
    'echo pwn > ~dev/escape',
    'cd ~dev',
    'cd ~-',
    'ln -s safe.txt /etc/passwd .',
    'ln -s -t src safe.txt /etc/passwd',
    'env -u FOO nohup node src/app.mjs',
    'nice -n 5 ln -s /etc/passwd src/pw',
    'env -C /tmp touch escaped',
    "bash << 'EOF'\ncd ~\ncp secret pwn\nEOF",
  ]) {
    assert.ok(hard(hardEscape), `escape must be blocked by evaluateHardRules: ${hardEscape}`);
    assert.equal(boundary(hardEscape).confined, false, `escape must never be confined: ${hardEscape}`);
    assert.equal(directGate(hardEscape).decision, 'deny', `escape must be denied in direct_exec: ${hardEscape}`);
  }

  // 3. Mid-token `..`, multi-`..` arguments, bare `~`, and workspace symlinks NEVER get 0ms `by="sandbox"` or `direct_exec` allow
  const nonRedirEscapes = [
    'cp src/app.mjs src/../../../tmp/pwn',
    'cp src/../src/app.mjs ../../../tmp/escaped.txt',
    'cp src/app.mjs ~',
    'cp src/app.mjs ${PWD%/*}/escaped.txt',
    ...(hasSymlink ? ['cp src/app.mjs src/alias-ext/pwn.txt'] : []),
  ];
  for (const escCmd of nonRedirEscapes) {
    assert.equal(boundary(escCmd).confined, false, `must not grant 0ms sandbox bypass to: ${escCmd}`);
    assert.ok(hard(escCmd, directActor), `direct_exec hard rules must block: ${escCmd}`);
    assert.equal(directGate(escCmd).decision, 'deny', `direct_exec gate must deny: ${escCmd}`);
  }

  // 4. Inline interpreter one-liners (`python3 -c`, `find -exec`) require Safety Gate model review (never 0ms bypass)
  const pyInline = 'python3 -c "open(chr(47)+\'tmp/pwn\',\'w\').write(\'1\')"';
  assert.equal(boundary(pyInline).confined, false);
  assert.equal(directGate(pyInline).decision, 'needs-model');

  // 5. Linux destructive host commands blocked deterministically by `evaluateCrossBoundarySafetyGate`
  for (const destructive of ['rm -fr /', 'rm -rf --no-preserve-root /', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/nvme0n1']) {
    const cross = evaluateCrossBoundarySafetyGate({ tool: 'bash', args: { command: destructive } }, cfg);
    assert.equal(cross?.decision, 'deny', `must deterministically reject: ${destructive}`);
    assert.equal(cross?.by, 'rule:safety-gate-prohibited');
  }
});

test('[Linux Fix 5] legacy-patch-guard POSIX file:/// & spaced paths, lt-bugreport spaced/WSL2 redaction, governance BAD_GLOB guard, and bwrap sandbox failure handling', async () => {
  // 1. `legacy-patch-guard` preserves POSIX leading `/` on `file:///home/...` AND handles spaces in bundle root
  const spacedBundleRoot = '/home/dev/workspace/Leader Team/leaderteam-v2.2-dev';
  const selfFileUrlPatch = '  - id: leaderteam-core\n    name: "file:///home/dev/workspace/Leader%20Team/leaderteam-v2.2-dev/leaderteam/entry-core.mjs"\n';
  const selfPlainQuotedPatch = '  - id: leaderteam-core\n    name: "/home/dev/workspace/Leader Team/leaderteam-v2.2-dev/leaderteam/entry-core.mjs"\n';
  const foreignPatch = '  - id: leaderteam-core\n    name: "file:///opt/old-v21-leaderteam/leaderteam/entry-core.mjs"\n';

  assert.equal(inspectPatchTextForLegacyLeaderTeam(selfFileUrlPatch, spacedBundleRoot).hasExternalCoreOverride, false);
  assert.equal(inspectPatchTextForLegacyLeaderTeam(selfPlainQuotedPatch, spacedBundleRoot).hasExternalCoreOverride, false);
  assert.equal(inspectPatchTextForLegacyLeaderTeam(foreignPatch, spacedBundleRoot).hasExternalCoreOverride, true);

  // 2. `lt-bugreport` scrubs unquoted multi-word Linux spaced paths, WSL2 `/mnt/c/Users/...`, `/opt/...`, and short username `dev` without mangling English words
  const rawDiag = [
    'Workspace at /home/dev/workspace/Leader Team failed with EACCES',
    'Error in /home/dev/My Secret Project/notes.md: permission denied',
    'WSL path /mnt/c/Users/AliceCorp/Confidential Spec/roadmap.docx leaked',
    'Mount path /opt/company-private/gateway.yml unreadable',
    'device mode=autonomous worker=dev-worker',
  ].join('\n');
  const scrubbed = redactDiagnosticText(rawDiag, { username: 'dev', hostname: 'heluweb' });
  for (const forbidden of ['Leader Team', 'My Secret Project', 'notes.md', 'AliceCorp', 'Confidential Spec', 'company-private', 'dev-worker']) {
    assert.equal(scrubbed.includes(forbidden), false, `lt-bugreport leaked "${forbidden}" in:\n${scrubbed}`);
  }
  assert.match(scrubbed, /\bdevice\b/, 'short username "dev" must not corrupt English word "device"');
  assert.match(scrubbed, /mode=autonomous/);

  // 3. `checkGovernanceExecutionGate` handles invalid `blockedTargets` (e.g. `/src/app.js`) without throwing uncaught `BAD_GLOB`
  const govState = {
    activeDirectives: [{
      conferenceId: 'conf-1',
      directives: ['Fix src/app.js'],
      blockedTargets: ['/src/app.js', '..', 'src/**'],
      stageHashAtRuling: 'hash-1',
    }],
  };
  const govRes = checkGovernanceExecutionGate(
    govState,
    { role: 'leader' },
    'team_dispatch',
    { stage_id: 'stg-1', write_scope: ['src/app.js'] },
    { id: 'stg-1', hash: 'hash-1', contract: { write_scope: ['src/app.js'] } },
    'linux',
  );
  assert.equal(govRes?.rule, 'arbiter-intervention');

  // 4. `onToolResult` recognizes Linux `bwrap` OS sandbox startup failures and strips `bash` cleanly
  const { onToolResult } = await import('../../leaderteam/host/roles.mjs');
  const { runtime, teamStore } = await import('../../leaderteam/host/runtime.mjs');
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-bwrap-fail-'));
  const rt = runtime();
  const prevCfg = rt.config;
  const prevRoot = rt.storageRoot;
  try {
    const cfg = configWith({});
    rt.config = cfg;
    rt.storageRoot = tmpStore;
    teamStore('team-bwrap').ensure({ workspace: '/tmp/ws-bwrap', surface: 'headless' });
    teamStore('team-bwrap').addMember({ childId: 'm-bwrap', name: 'impl', profile: 'shell', taskSeq: 1 });
    const sections = [];
    const fakeAgent = {
      id: 'm-bwrap',
      ctx: { systemPrompt: { section: s => sections.push(s) } },
    };
    const memberActor = {
      id: 'm-bwrap',
      agentId: 'm-bwrap',
      teamId: 'team-bwrap',
      role: 'member',
      cwd: '/tmp/ws-bwrap',
      allowedTools: ['read', 'write', 'bash'],
      loadedTools: ['read', 'write', 'bash'],
      agent: fakeAgent,
    };
    rt.actors.set('m-bwrap', memberActor);

    onToolResult(
      { name: 'bash', agent: fakeAgent, arguments: { command: 'npm test' } },
      { isError: true, content: [{ type: 'text', text: 'bwrap: setting up uid map: Permission denied' }] },
    );
    assert.equal(memberActor.loadedTools.includes('bash'), false, 'Linux bwrap userns startup error must disable bash to prevent retry loops');
    assert.ok(memberActor.shellFailure?.includes('bwrap:'));
    assert.equal(sections.length, 1);
  } finally {
    rt.actors.delete('m-bwrap');
    rt.config = prevCfg;
    rt.storageRoot = prevRoot;
    fs.rmSync(tmpStore, { recursive: true, force: true });
  }
});
