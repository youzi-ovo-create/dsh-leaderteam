import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
import {
  readLinuxCgroupLimits,
  readLinuxProcMeminfo,
  sampleDeviceResources,
  ElasticConcurrencyScheduler,
} from '../../leaderteam/core/scheduler.mjs';
import {
  classifySandboxBoundary,
  evaluateHardRules,
  evaluateDirectExecSafetyGate,
  evaluateCrossBoundarySafetyGate,
  parseReadGrants,
} from '../../leaderteam/core/gate-policy.mjs';
import { inspectPatchTextForLegacyLeaderTeam } from '../../leaderteam/core/legacy-patch-guard.mjs';
import {
  checkGovernanceExecutionGate,
  parseConferenceDeliberation,
} from '../../leaderteam/core/governance-protocol.mjs';
import {
  inspectPatchTemplateSync,
  applyModelConfigChanges,
} from '../../leaderteam/core/model-config-writer.mjs';
import { startModelConfigServer } from '../../leaderteam/core/model-config-ui.mjs';
import { resolveOrBootstrapConfigPath } from '../../leaderteam/core/solo-key.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { splitShellArgs } from '../../scripts/dsh-runtime.mjs';
import { runDoctorChecks } from '../../bin/lt-doctor.mjs';
import { redactDiagnosticText } from '../../bin/lt-bugreport.mjs';
import { configWith } from './helpers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function createVirtualPosixFs({ files = new Map(), dirs = new Set(), symlinks = new Map() } = {}) {
  const norm = p => path.posix.normalize(String(p).replaceAll('\\', '/'));
  const allDirs = new Set(['/']);
  for (const d of dirs) {
    let cur = norm(d);
    while (cur && !allDirs.has(cur)) {
      allDirs.add(cur);
      const parent = path.posix.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const normFiles = new Map();
  for (const [k, v] of files.entries()) {
    const nk = norm(k);
    normFiles.set(nk, v);
    let cur = path.posix.dirname(nk);
    while (cur && !allDirs.has(cur)) {
      allDirs.add(cur);
      const parent = path.posix.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const normLinks = new Map();
  for (const [k, v] of symlinks.entries()) {
    const nk = norm(k);
    normLinks.set(nk, norm(v));
    let cur = path.posix.dirname(nk);
    while (cur && !allDirs.has(cur)) {
      allDirs.add(cur);
      const parent = path.posix.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  const resolveReal = inputPath => {
    const target = norm(inputPath);
    const segs = target.split('/').filter(Boolean);
    let cur = '/';
    for (const seg of segs) {
      cur = cur === '/' ? `/${seg}` : `${cur}/${seg}`;
      if (normLinks.has(cur)) {
        cur = normLinks.get(cur);
      }
    }
    if (!allDirs.has(cur) && !normFiles.has(cur)) {
      const err = new Error(`ENOENT: no such file or directory, realpath '${inputPath}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return cur;
  };

  const exists = inputPath => {
    const target = norm(inputPath);
    if (allDirs.has(target) || normFiles.has(target) || normLinks.has(target)) return true;
    try {
      resolveReal(target);
      return true;
    } catch {
      return false;
    }
  };

  return {
    existsSync: p => exists(p),
    lstatSync: p => {
      const target = norm(p);
      if (normLinks.has(target)) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
      const real = resolveReal(target);
      return {
        isSymbolicLink: () => false,
        isDirectory: () => allDirs.has(real),
        isFile: () => normFiles.has(real),
      };
    },
    statSync: p => {
      const real = resolveReal(p);
      return {
        isSymbolicLink: () => false,
        isDirectory: () => allDirs.has(real),
        isFile: () => normFiles.has(real),
      };
    },
    realpathSync: Object.assign(p => resolveReal(p), { native: p => resolveReal(p) }),
    readFileSync: p => {
      const real = resolveReal(p);
      if (!normFiles.has(real)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return normFiles.get(real);
    },
  };
}

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

  const cleanEnv = { ...process.env };
  delete cleanEnv.DSH_HOME;
  delete cleanEnv.LT_DSH_HOME;
  delete cleanEnv.LEADERTEAM_CONFIG;
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

test('[Linux Fix 2] Sysfs power adapter filters peripheral scope=Device batteries, ignores readdirSync order, supports USB-PD & energy/charge weighting, and purges queued notice on user resume', async t => {
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

  // 2. Laptop with `BAT0` before `ucsi-source-psy-USBC000:001` in `readdirSync` order (uses virtual fs so `:` works on Windows NTFS too!)
  const virtualSysfsFiles = new Map([
    ['/sys/class/power_supply/BAT0/type', 'Battery\n'],
    ['/sys/class/power_supply/BAT0/status', 'Unknown\n'],
    ['/sys/class/power_supply/BAT0/energy_now', '48000000\n'],
    ['/sys/class/power_supply/BAT0/energy_full', '60000000\n'],
    ['/sys/class/power_supply/ucsi-source-psy-USBC000:001/type', 'USB_PD\n'],
    ['/sys/class/power_supply/ucsi-source-psy-USBC000:001/online', '1\n'],
  ]);
  const orderedFs = {
    readdirSync: () => ['BAT0', 'ucsi-source-psy-USBC000:001'],
    readFileSync: p => {
      const key = String(p).replaceAll('\\', '/');
      if (!virtualSysfsFiles.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return virtualSysfsFiles.get(key);
    },
  };
  const usbPdSample = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    fs: orderedFs,
    sysfsPowerDir: '/sys/class/power_supply',
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

  // 4. Charge-only dual battery (`charge_now` + `charge_full`, no `energy_full`): 850/1000 (85%) + 150/7000 (2.14%) = 1000/8000 = 12.5% -> 13% (<= 20% threshold, NEVER 43%)
  const chargeOnlyMap = new Map([
    ['/sys/class/power_supply/BAT0/type', 'Battery\n'],
    ['/sys/class/power_supply/BAT0/status', 'Discharging\n'],
    ['/sys/class/power_supply/BAT0/charge_now', '850000\n'],
    ['/sys/class/power_supply/BAT0/charge_full', '1000000\n'],
    ['/sys/class/power_supply/BAT1/type', 'Battery\n'],
    ['/sys/class/power_supply/BAT1/status', 'Discharging\n'],
    ['/sys/class/power_supply/BAT1/charge_now', '150000\n'],
    ['/sys/class/power_supply/BAT1/charge_full', '7000000\n'],
  ]);
  const chargeOnlyFs = {
    readdirSync: () => ['BAT0', 'BAT1'],
    readFileSync: p => {
      const k = String(p).replaceAll('\\', '/');
      if (!chargeOnlyMap.has(k)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return chargeOnlyMap.get(k);
    },
  };
  const chargeOnlySample = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    fs: chargeOnlyFs,
    sysfsPowerDir: '/sys/class/power_supply',
  });
  assert.equal(chargeOnlySample.status, 'ok');
  assert.equal(chargeOnlySample.onBattery, true);
  assert.equal(chargeOnlySample.batteryPct, 13, 'charge_full-weighted dual battery must report 13% (12.5%), never 43%');

  // 5. Explicit user resume unblocks only that team AND purges any queued shutdown notice so next poll does NOT deliver stale stop notice
  const {
    isTeamAwaitingUserAfterPowerPause,
    pollAndDeliverPowerMonitor,
    clearPowerPauseForTeamOnUserMessage,
  } = await import('../../leaderteam/host/concurrency.mjs');

  const storeDir = path.join(tmp, 'pm-store');
  fs.mkdirSync(storeDir, { recursive: true });
  const deliveredToTeam1 = [];
  const deliveredToTeam2 = [];
  let team1CanDeliver = false;
  let team2CanDeliver = false;

  const fakeRt = {
    config: configWith({}),
    storageRoot: storeDir,
    powerMonitorState: createPowerMonitorState(),
    actors: new Map([
      ['team-1', {
        role: 'leader',
        teamId: 'team-1',
        agent: { status: 'idle', get followup() { return team1CanDeliver ? msg => deliveredToTeam1.push(msg) : undefined; } },
      }],
      ['team-2', {
        role: 'leader',
        teamId: 'team-2',
        agent: { status: 'idle', get followup() { return team2CanDeliver ? msg => deliveredToTeam2.push(msg) : undefined; } },
      }],
    ]),
  };

  // Poll 1: battery drops to 15% while both leaders cannot accept followup yet -> queued in `pendingTeams`
  await pollAndDeliverPowerMonitor({}, fakeRt, {
    sample: { status: 'ok', onBattery: true, batteryPct: 15 },
    nowMs: 1000,
  });
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-1'), true);
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-2'), true);
  assert.deepEqual(fakeRt.powerMonitorState.pendingTeams, ['team-1', 'team-2']);

  // User explicitly resumes `team-1` before Poll 2
  clearPowerPauseForTeamOnUserMessage(fakeRt, 'team-1');
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-1'), false);
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-2'), true);

  // Poll 2: both leaders can now accept followup; `team-1` MUST NOT receive the stale shutdown notice, while `team-2` DOES receive it!
  team1CanDeliver = true;
  team2CanDeliver = true;
  await pollAndDeliverPowerMonitor({}, fakeRt, {
    sample: { status: 'ok', onBattery: true, batteryPct: 15 },
    nowMs: 2000,
  });
  assert.equal(deliveredToTeam1.length, 0, 'resumed team-1 must NOT receive stale queued low-battery notice');
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-1'), false, 'resumed team-1 must stay unpaused');
  assert.equal(deliveredToTeam2.length, 1, 'unresumed team-2 still receives its queued low-battery notice');
  assert.equal(isTeamAwaitingUserAfterPowerPause(fakeRt, 'team-2'), true);
});

test('[Linux Fix 3] cgroup v2/v1 parent-vs-leaf headroom, hybrid v1+v2 per-controller merge, non-strict overcommit, and Windows-safe cgroup mocks', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-linux-cg-fix-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 1. Ancestor slice memory limit + reclaimable `inactive_file` cache subtraction (slash-normalized for Windows CI)
  const cgRoot = path.join(tmp, 'cgroup-hier');
  const sliceDir = path.join(cgRoot, 'user.slice', 'user-1000.slice');
  const scopeDir = path.join(sliceDir, 'session-72.scope');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(path.join(cgRoot, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
  fs.writeFileSync(path.join(scopeDir, 'memory.max'), 'max\n');
  fs.writeFileSync(path.join(scopeDir, 'cpu.max'), 'max 100000\n');
  fs.writeFileSync(path.join(sliceDir, 'memory.max'), String(2048 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(sliceDir, 'cpu.max'), '200000 100000\n');
  fs.writeFileSync(path.join(scopeDir, 'memory.current'), String(1800 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(scopeDir, 'memory.stat'), `anon ${400 * 1024 * 1024}\ninactive_file ${1400 * 1024 * 1024}\n`);

  const mockSelfCgFs = {
    existsSync: p => {
      const norm = String(p).replaceAll('\\', '/');
      if (norm === '/proc/self/cgroup') return true;
      const mapped = norm.startsWith('/sys/fs/cgroup')
        ? path.join(cgRoot, ...norm.slice('/sys/fs/cgroup'.length).split('/').filter(Boolean))
        : p;
      return fs.existsSync(mapped);
    },
    readFileSync: (p, enc) => {
      const norm = String(p).replaceAll('\\', '/');
      if (norm === '/proc/self/cgroup') return '0::/user.slice/user-1000.slice/session-72.scope\n';
      const mapped = norm.startsWith('/sys/fs/cgroup')
        ? path.join(cgRoot, ...norm.slice('/sys/fs/cgroup'.length).split('/').filter(Boolean))
        : p;
      return fs.readFileSync(mapped, enc);
    },
  };

  const hierLimits = readLinuxCgroupLimits(mockSelfCgFs, '/sys/fs/cgroup');
  assert.equal(hierLimits.version, 2);
  assert.equal(hierLimits.memoryLimitMib, 2048);
  assert.equal(hierLimits.memoryUsageMib, 400);
  assert.equal(hierLimits.memoryRemainingMib, 1648);
  assert.equal(hierLimits.cpuQuotaCores, 2);

  // 2. [P1-2] Parent cgroup nearly full (4096 MiB max, 4000 MiB current -> 96 MiB left) while leaf uses only 128 MiB:
  //    BOTH cgroup v2 AND cgroup v1 MUST report 96 MiB remaining (NEVER 3968 MiB)!
  const parentFullV2Map = new Map([
    ['/proc/self/cgroup', '0::/user.slice/app.scope\n'],
    ['/sys/fs/cgroup/cgroup.controllers', 'cpu memory\n'],
    ['/sys/fs/cgroup/user.slice/memory.max', String(4096 * 1024 * 1024) + '\n'],
    ['/sys/fs/cgroup/user.slice/memory.current', String(4000 * 1024 * 1024) + '\n'],
    ['/sys/fs/cgroup/user.slice/app.scope/memory.max', 'max\n'],
    ['/sys/fs/cgroup/user.slice/app.scope/memory.current', String(128 * 1024 * 1024) + '\n'],
  ]);
  const mapFs = m => ({
    existsSync: p => m.has(String(p).replaceAll('\\', '/')),
    readFileSync: p => {
      const k = String(p).replaceAll('\\', '/');
      if (!m.has(k)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return m.get(k);
    },
  });
  const parentFullV2 = readLinuxCgroupLimits(mapFs(parentFullV2Map), '/sys/fs/cgroup');
  assert.equal(parentFullV2.memoryLimitMib, 4096);
  assert.equal(parentFullV2.memoryUsageMib, 4000);
  assert.equal(parentFullV2.memoryRemainingMib, 96, 'v2 must report 96 MiB parent headroom, never 3968 MiB');

  const parentFullV1Map = new Map([
    ['/proc/self/cgroup', '5:memory:/kubepods/pod-1/ctr-a\n'],
    ['/sys/fs/cgroup/memory/kubepods/memory.limit_in_bytes', String(4096 * 1024 * 1024) + '\n'],
    ['/sys/fs/cgroup/memory/kubepods/memory.usage_in_bytes', String(4000 * 1024 * 1024) + '\n'],
    ['/sys/fs/cgroup/memory/kubepods/pod-1/ctr-a/memory.limit_in_bytes', '9223372036854771712\n'],
    ['/sys/fs/cgroup/memory/kubepods/pod-1/ctr-a/memory.usage_in_bytes', String(128 * 1024 * 1024) + '\n'],
  ]);
  const parentFullV1 = readLinuxCgroupLimits(mapFs(parentFullV1Map), '/sys/fs/cgroup');
  assert.equal(parentFullV1.version, 1);
  assert.equal(parentFullV1.memoryLimitMib, 4096);
  assert.equal(parentFullV1.memoryUsageMib, 4000);
  assert.equal(parentFullV1.memoryRemainingMib, 96, 'v1 must report 96 MiB parent headroom, never 3968 MiB');

  // 3. [P2-3] Hybrid cgroup: v2 provides CPU quota `2` cores (`memory.max = max`) AND v1 provides memory limit `512 MiB`!
  const hybridBothMap = new Map([
    ['/proc/self/cgroup', '0::/app.scope\n4:memory:/app.scope\n'],
    ['/sys/fs/cgroup/cgroup.controllers', 'cpu\n'],
    ['/sys/fs/cgroup/app.scope/cpu.max', '200000 100000\n'],
    ['/sys/fs/cgroup/app.scope/memory.max', 'max\n'],
    ['/sys/fs/cgroup/memory/app.scope/memory.limit_in_bytes', String(512 * 1024 * 1024) + '\n'],
    ['/sys/fs/cgroup/memory/app.scope/memory.usage_in_bytes', String(128 * 1024 * 1024) + '\n'],
  ]);
  const hybridBoth = readLinuxCgroupLimits(mapFs(hybridBothMap), '/sys/fs/cgroup');
  assert.equal(hybridBoth.cpuQuotaCores, 2, 'must preserve v2 CPU quota of 2 cores');
  assert.equal(hybridBoth.memoryLimitMib, 512, 'must preserve v1 memory limit of 512 MiB instead of returning null');
  assert.equal(hybridBoth.memoryRemainingMib, 384);

  // 4. [P2-4] Non-strict overcommit (`overcommit_memory=1` & `0`) with 12 GiB free RAM and high virtual `Committed_AS` MUST NOT false-throttle,
  //    whereas strict `overcommit_memory=2` DOES enforce `CommitLimit`!
  const baseMeminfoText = [
    'MemTotal:       16777216 kB', // 16 GiB
    'MemAvailable:   12582912 kB', // 12 GiB free!
    'SwapTotal:             0 kB',
    'SwapFree:              0 kB',
    'CommitLimit:     8388608 kB', // 8 GiB
    'Committed_AS:   25165824 kB', // 24 GiB virtual reservations
  ].join('\n') + '\n';

  for (const nonStrictMode of ['1\n', '0\n']) {
    const ocFs = mapFs(new Map([
      ['/proc/meminfo', baseMeminfoText],
      ['/proc/sys/vm/overcommit_memory', nonStrictMode],
      ['/sys/fs/cgroup/cgroup.controllers', 'cpu memory\n'],
      ['/sys/fs/cgroup/memory.max', 'max\n'],
    ]));
    const parsedNonStrict = readLinuxProcMeminfo(ocFs, '/proc/meminfo');
    assert.equal(parsedNonStrict.availPhysMib, 12288);
    assert.equal(parsedNonStrict.availCommitMib, null, `overcommit_memory=${nonStrictMode.trim()} must not report 0 commit headroom`);
    const sched = new ElasticConcurrencyScheduler(configWith({}), {
      platform: 'linux',
      fs: ocFs,
      meminfoPath: '/proc/meminfo',
      cgroupRoot: '/sys/fs/cgroup',
    });
    const check = sched.checkDispatch({
      teamId: 't-oc',
      taskSeq: 1,
      activeMembers: [{ id: 'm1', name: 'w1', status: 'running', profile: 'code' }],
      profile: 'code',
    });
    assert.equal(check.allowed, true, `overcommit_memory=${nonStrictMode.trim()} with 12GiB free RAM must not throttle`);
    assert.equal(check.snapshot.hysteresis.mode, 'normal');
  }

  const strictOcFs = mapFs(new Map([
    ['/proc/meminfo', baseMeminfoText],
    ['/proc/sys/vm/overcommit_memory', '2\n'],
    ['/sys/fs/cgroup/cgroup.controllers', 'cpu memory\n'],
    ['/sys/fs/cgroup/memory.max', 'max\n'],
  ]));
  const parsedStrict = readLinuxProcMeminfo(strictOcFs, '/proc/meminfo');
  assert.equal(parsedStrict.availCommitMib, 0, 'strict overcommit_memory=2 must enforce CommitLimit');
  const strictSched = new ElasticConcurrencyScheduler(configWith({}), {
    platform: 'linux',
    fs: strictOcFs,
    meminfoPath: '/proc/meminfo',
    cgroupRoot: '/sys/fs/cgroup',
  });
  const strictCheck = strictSched.checkDispatch({
    teamId: 't-oc-strict',
    taskSeq: 1,
    activeMembers: [{ id: 'm1', name: 'w1', status: 'running', profile: 'code' }],
    profile: 'code',
  });
  assert.equal(strictCheck.snapshot.hysteresis.mode, 'throttled');
  assert.ok(strictCheck.snapshot.hysteresis.reasons.includes('commit_mem_high'));

  // 5. `lt-doctor` detects cgroup v2 on standard systemd hosts AND deep-merges partial `leaderteam.local.json`
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

test('[Linux Fix 4] Bash safety gate blocks mounted outside dirs, Chinese symlinks, ANSI-C $\'...\' escapes, .. escapes, and allows in-workspace cd .. & spaced paths (cross-platform)', t => {
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

  // Virtual POSIX filesystem so this entire suite passes identically on BOTH Windows CI and Linux CI!
  const vWs = '/work/Leader Team/project';
  const vFs = createVirtualPosixFs({
    dirs: [
      vWs,
      `${vWs}/src`,
      '/outside-mount',
      '/outside-secrets',
      '/opt/refs-service',
    ],
    files: new Map([
      [`${vWs}/src/app.mjs`, 'console.log("ok");\n'],
      ['/outside-mount/secret.txt', 'mounted-secret\n'],
      ['/outside-secrets/secret.txt', 'symlink-secret\n'],
    ]),
    symlinks: new Map([
      [`${vWs}/src/alias-ext`, '/outside-secrets'],
      [`${vWs}/外部软链`, '/outside-secrets'],
      [`${vWs}/src/中文链接.txt`, '/outside-secrets/secret.txt'],
    ]),
  });

  const hard = (command, actor = shellMember, cwd = vWs, extraArgs = {}, fsOverride = vFs) => evaluateHardRules({
    tool: 'bash',
    args: { command, ...extraArgs },
    actor,
    cwd,
    platform: 'linux',
    fs: fsOverride,
  }, cfg);
  const boundary = (command, cwd = vWs, extraArgs = {}, fsOverride = vFs) => classifySandboxBoundary({
    tool: 'bash',
    args: { command, ...extraArgs },
    actor: shellMember,
    cwd,
    platform: 'linux',
    fs: fsOverride,
  }, cfg);
  const directGate = (command, cwd = vWs, extraArgs = {}, fsOverride = vFs) => evaluateDirectExecSafetyGate({
    tool: 'bash',
    args: { command, ...extraArgs },
    actor: directActor,
    cwd,
    platform: 'linux',
    fs: fsOverride,
  }, cfg);

  // 1. Spaced workspace paths, synthetic CLI flags (`--base=/app`), AND [P2-2] `cd ..` within workspace MUST be allowed!
  for (const [cmd, extra] of [
    [`node "${vWs}/src/app.mjs"`, {}],
    ['/usr/bin/python3 -m unittest discover -s src', {}],
    ["awk '/ERROR/ {print $0}' src/app.mjs", {}],
    ['npx vite build --base=/app', {}],
    ['SECRET_KEY=test_only npm test', {}],
    ['git log -n 1 HEAD~1', {}],
    ['cd src && cd .. && pwd', {}],
    ['cd .. && pwd', { workdir: 'src' }],
  ]) {
    assert.equal(hard(cmd, shellMember, vWs, extra), undefined, `valid Linux command must pass hard rules: ${cmd}`);
    assert.equal(boundary(cmd, vWs, extra).confined, true, `valid Linux command must stay sandbox-confined: ${cmd}`);
    assert.equal(hard(cmd, directActor, vWs, extra), undefined, `valid Linux command must pass direct_exec hard rules: ${cmd}`);
    assert.equal(directGate(cmd, vWs, extra).decision, 'allow', `valid Linux command must pass direct_exec gate: ${cmd}`);
  }

  // `cd ../..` from `src` DOES leave workspace and MUST be rejected!
  assert.ok(hard('cd ../.. && pwd', shellMember, vWs, { workdir: 'src' }));
  assert.equal(boundary('cd ../.. && pwd', vWs, { workdir: 'src' }).confined, false);
  assert.equal(directGate('cd ../.. && pwd', vWs, { workdir: 'src' }).decision, 'deny');

  // 2. [P1-1a] Real mounted top-level directory `/outside-mount` (where `realpath('/outside-mount') === '/outside-mount'`)
  //    MUST NOT be mistaken for a synthetic route when quoted or passed via `--flag=/outside-mount/...`!
  for (const mountedEscape of [
    'cat "/outside-mount/secret.txt"',
    'node src/app.mjs --config=/outside-mount/secret.txt',
    'cat /outside-mount/secret.txt',
  ]) {
    assert.equal(boundary(mountedEscape).confined, false, `mounted external dir must NOT skip safety gate: ${mountedEscape}`);
    assert.equal(directGate(mountedEscape).decision, 'deny', `direct_exec must deny mounted external dir: ${mountedEscape}`);
  }

  // 3. [P1-1b] Relative symlinks with Chinese/Unicode names resolving outside workspace MUST NOT get 0ms sandbox allow!
  for (const unicodeSymlinkCmd of [
    'cat 外部软链/secret.txt',
    'cat "外部软链/secret.txt"',
    'cat src/中文链接.txt',
  ]) {
    assert.equal(boundary(unicodeSymlinkCmd).confined, false, `Chinese symlink escape must NOT be confined: ${unicodeSymlinkCmd}`);
    assert.equal(directGate(unicodeSymlinkCmd).decision, 'deny', `direct_exec must deny Chinese symlink escape: ${unicodeSymlinkCmd}`);
  }

  // Also test on real host filesystem + real `fs.symlinkSync` when running on Linux/macOS!
  if (process.platform !== 'win32') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-real-symlink-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const realWs = path.join(tmp, 'Leader Team', 'repo');
    const realOut = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(realWs, 'src'), { recursive: true });
    fs.mkdirSync(realOut, { recursive: true });
    fs.writeFileSync(path.join(realOut, 'secret.txt'), 's\n');
    fs.symlinkSync(realOut, path.join(realWs, '中文软链'), 'dir');

    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: 'cat 中文软链/secret.txt' }, actor: shellMember, cwd: realWs }, cfg).confined, false);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: 'cat 中文软链/secret.txt' }, actor: directActor, cwd: realWs }, cfg).decision, 'deny');
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: 'cd .. && pwd', workdir: 'src' }, actor: directActor, cwd: realWs }, cfg).decision, 'allow');
  }

  const spacedSubCmd = `OUT=$(node "${vWs}/src/app.mjs")`;
  assert.equal(hard(spacedSubCmd), undefined);
  assert.equal(boundary(spacedSubCmd).confined, false);
  assert.equal(hard('node src/app.mjs', shellMember, '/opt/refs-service'), undefined);
  assert.deepEqual(parseReadGrants(['允许读取 ~/reference-docs'], 'linux', '/home/dev'), ['/home/dev/reference-docs']);

  // 4. Deterministic hard-rule blocks on ANSI-C `$'...'`, `${PWD%/*}`, `~user`/`~-`, `ln` multi-source, `env -C`, & heredoc sub-shells
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

  // 5. Mid-token `..`, multi-`..` arguments, bare `~`, and workspace symlinks NEVER get 0ms `by="sandbox"` or `direct_exec` allow
  for (const escCmd of [
    'cp src/app.mjs src/../../../tmp/pwn',
    'cp src/../src/app.mjs ../../../tmp/escaped.txt',
    'cp src/app.mjs ~',
    'cp src/app.mjs ${PWD%/*}/escaped.txt',
    'cp src/app.mjs src/alias-ext/pwn.txt',
  ]) {
    assert.equal(boundary(escCmd).confined, false, `must not grant 0ms sandbox bypass to: ${escCmd}`);
    assert.equal(directGate(escCmd).decision, 'deny', `direct_exec gate must deny: ${escCmd}`);
  }

  const pyInline = 'python3 -c "open(chr(47)+\'tmp/pwn\',\'w\').write(\'1\')"';
  assert.equal(boundary(pyInline).confined, false);
  assert.equal(directGate(pyInline).decision, 'needs-model');

  for (const destructive of ['rm -fr /', 'rm -rf --no-preserve-root /', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/nvme0n1']) {
    const cross = evaluateCrossBoundarySafetyGate({ tool: 'bash', args: { command: destructive } }, cfg);
    assert.equal(cross?.decision, 'deny');
    assert.equal(cross?.by, 'rule:safety-gate-prohibited');
  }
});

test('[Linux Fix 5] legacy-patch-guard prefix boundary, lt-bugreport Chinese spaced redaction, governance invalid blockedTargets enforcement, Windows exec args, and bwrap handling', async () => {
  // 1. [P2-10] `legacy-patch-guard` enforces strict directory boundary (`leaderteam` vs `leaderteam-old`) on POSIX & Windows
  const spacedBundleRoot = '/home/dev/workspace/Leader Team/leaderteam-v2.2-dev';
  const selfFileUrlPatch = '  - id: leaderteam-core\n    name: "file:///home/dev/workspace/Leader%20Team/leaderteam-v2.2-dev/leaderteam/entry-core.mjs"\n';
  const selfPlainQuotedPatch = '  - id: leaderteam-core\n    name: "/home/dev/workspace/Leader Team/leaderteam-v2.2-dev/leaderteam/entry-core.mjs"\n';
  const prefixCollisionPosix = '  - id: leaderteam-core\n    name: "file:///opt/leaderteam-old/leaderteam/entry-core.mjs"\n';
  const prefixCollisionWin = '  - id: leaderteam-core\n    name: "file:///C:/Apps/leaderteam-old/leaderteam/entry-core.mjs"\n';

  assert.equal(inspectPatchTextForLegacyLeaderTeam(selfFileUrlPatch, spacedBundleRoot).hasExternalCoreOverride, false);
  assert.equal(inspectPatchTextForLegacyLeaderTeam(selfPlainQuotedPatch, spacedBundleRoot).hasExternalCoreOverride, false);
  assert.equal(inspectPatchTextForLegacyLeaderTeam(prefixCollisionPosix, '/opt/leaderteam').hasExternalCoreOverride, true, 'must flag /opt/leaderteam-old when current root is /opt/leaderteam');
  assert.equal(inspectPatchTextForLegacyLeaderTeam(prefixCollisionWin, 'C:\\Apps\\leaderteam').hasExternalCoreOverride, true, 'must flag C:/Apps/leaderteam-old when current root is C:\\Apps\\leaderteam');

  // 2. [P2-11] `lt-bugreport` scrubs unquoted spaced Chinese filenames (`报告 二稿.md`) as well as ASCII/WSL2 paths
  const rawDiag = [
    'Workspace at /home/dev/workspace/Leader Team failed with EACCES',
    'Error in /home/dev/My Secret Project/notes.md: permission denied',
    '打开 /home/dev/机密文档/产品方案 二稿.md 失败',
    'Windows 中文路径 C:\\Users\\张三\\Desktop\\架构设计 二稿.docx 拒绝',
    'WSL path /mnt/c/Users/AliceCorp/Confidential Spec/roadmap.docx leaked',
    'Mount path /opt/company-private/gateway.yml unreadable',
    'device mode=autonomous worker=dev-worker',
  ].join('\n');
  const scrubbed = redactDiagnosticText(rawDiag, { username: 'dev', hostname: 'heluweb' });
  for (const forbidden of [
    'Leader Team', 'My Secret Project', 'notes.md', '机密文档', '产品方案', '二稿.md',
    '张三', '架构设计', '二稿.docx', 'AliceCorp', 'Confidential Spec', 'company-private', 'dev-worker',
  ]) {
    assert.equal(scrubbed.includes(forbidden), false, `lt-bugreport leaked "${forbidden}" in:\n${scrubbed}`);
  }
  assert.match(scrubbed, /\bdevice\b/, 'short username "dev" must not corrupt English word "device"');
  assert.match(scrubbed, /mode=autonomous/);

  // 3. [P2-1] Arbitration `parseConferenceDeliberation` rejects all-invalid `blocked_targets` (unless `forceConclude` substitutes fallback),
  //    AND `checkGovernanceExecutionGate` NEVER drops enforcement when `blockedTargets` are all invalid!
  const invalidDelibJson = JSON.stringify({
    status: 'concluded',
    decision: 'enforce_correction',
    ruling_summary: 'Fix auth validation before re-dispatch.',
    delta_from_initial_expectation: 'Matched caucus expectation.',
    binding_directives: ['Validate JWT audience in src/auth.js'],
    blocked_targets: ['/abs/invalid', '../outside'],
    member_resume_policy: 'adjust_disputed_resume_others',
  });
  const strictParse = parseConferenceDeliberation(invalidDelibJson, { forceConclude: false });
  assert.equal(strictParse.ok, false, 'must reject unparseable blocked_targets so arbiter retries');

  const forcedParse = parseConferenceDeliberation(invalidDelibJson, {
    forceConclude: true,
    validStageIds: ['stg-auth'],
    fallbackTargets: ['stg-auth', 'src/auth/**'],
  });
  assert.equal(forcedParse.ok, true);
  assert.deepEqual(forcedParse.result.blockedTargets, ['stg-auth', 'src/auth/**']);

  const allInvalidGovState = {
    activeDirectives: [{
      conferenceId: 'conf-invalid-glob',
      decision: 'enforce_correction',
      directives: ['Fix src/auth.js'],
      blockedTargets: ['/abs/invalid', '..'],
      stageId: null,
      targets: [],
      stageHashAtRuling: 'hash-unamended',
    }],
  };
  const blockedUnamended = checkGovernanceExecutionGate(
    allInvalidGovState,
    { role: 'leader' },
    'team_dispatch',
    { stage_id: 'stg-1', write_scope: ['src/auth.js'] },
    { id: 'stg-1', hash: 'hash-unamended', contract: { write_scope: ['src/auth.js'] } },
    'linux',
  );
  assert.equal(blockedUnamended?.rule, 'arbiter-intervention', 'all-invalid blockedTargets must fail-closed on unamended stage instead of silently dropping');

  const allowedAmended = checkGovernanceExecutionGate(
    allInvalidGovState,
    { role: 'leader' },
    'team_dispatch',
    { stage_id: 'stg-1', write_scope: ['src/auth.js'] },
    { id: 'stg-1', hash: 'hash-amended', contract: { write_scope: ['src/auth.js'] } },
    'linux',
  );
  assert.equal(allowedAmended, undefined, 'amended stage hash must be allowed to execute remediation');

  // 4. [P2-9] `splitShellArgs` preserves Windows backslashes in `LT_DSH_EXEC_ARGS`
  assert.deepEqual(
    splitShellArgs('--require "C:\\Build Tools\\hook.cjs" --trace-warnings'),
    ['--require', 'C:\\Build Tools\\hook.cjs', '--trace-warnings'],
  );
  assert.deepEqual(
    splitShellArgs('--require C:\\Tools\\hook.cjs "/home/dev/Leader Team/preload.mjs"'),
    ['--require', 'C:\\Tools\\hook.cjs', '/home/dev/Leader Team/preload.mjs'],
  );

  // 5. `onToolResult` recognizes Linux `bwrap` OS sandbox startup failures and strips `bash` cleanly
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
    assert.equal(memberActor.loadedTools.includes('bash'), false);
    assert.ok(memberActor.shellFailure?.includes('bwrap:'));
    assert.equal(sections.length, 1);
  } finally {
    rt.actors.delete('m-bwrap');
    rt.config = prevCfg;
    rt.storageRoot = prevRoot;
    fs.rmSync(tmpStore, { recursive: true, force: true });
  }
});

test('[Linux Fix 6] Headless SIGINT group cancellation, pre-first-start npm configure-models + read-only Web UI save, Magpie empty template sync, and plan-archive env discovery', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-audit2-e2e-'));
  t.after(() => {
    try {
      // Restore write perms before cleanup in case a directory was chmod'd 0555
      const roPkg = path.join(tmp, 'ro-app', 'node_modules', 'dsh-leaderteam');
      if (fs.existsSync(roPkg)) {
        fs.chmodSync(roPkg, 0o755);
        const roCfg = path.join(roPkg, 'config');
        if (fs.existsSync(roCfg)) fs.chmodSync(roCfg, 0o755);
      }
    } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // 1. [P2-12] Moving all models off Magpie marks patch templates drifted, cleans them to `models: []`, and round-trips back!
  const patchDir = path.join(tmp, 'patch-sync');
  fs.mkdirSync(patchDir, { recursive: true });
  const cfgPath = path.join(patchDir, 'leaderteam.config.json');
  const magpiePatch = path.join(patchDir, 'magpie-models.patch.yml');
  const desktopPatch = path.join(patchDir, 'desktop-magpie.patch.yml');
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), cfgPath);
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'magpie-models.patch.yml'), magpiePatch);
  fs.copyFileSync(path.join(REPO_ROOT, 'config', 'desktop-magpie.patch.yml'), desktopPatch);

  // Move every model to `deepseek` provider so 0 models remain on `magpie`
  const rawCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const oldRoutes = Object.keys(rawCfg.models);
  const soloCheckCfg = structuredClone(rawCfg);
  for (const r of oldRoutes) soloCheckCfg.models[r].provider = 'deepseek';
  const beforeCleanSync = inspectPatchTemplateSync(soloCheckCfg, cfgPath, [desktopPatch, magpiePatch]);
  assert.equal(beforeCleanSync.inSync, false, 'stale Magpie models in YAML templates must report inSync=false when 0 models use magpie');
  assert.equal(beforeCleanSync.drifted.length, 2);

  applyModelConfigChanges({
    upsertModels: oldRoutes.map(r => ({ route: r, provider: 'deepseek' })),
  }, {
    configFile: cfgPath,
    target: 'base',
    syncPatches: true,
    patchFiles: [desktopPatch, magpiePatch],
  });

  assert.match(fs.readFileSync(magpiePatch, 'utf8'), /models:\s*\[\]/);
  assert.match(fs.readFileSync(desktopPatch, 'utf8'), /models:\s*\[\]/);
  assert.equal(inspectPatchTemplateSync(loadConfig(cfgPath, { includeLocal: false }), cfgPath, [desktopPatch, magpiePatch]).inSync, true);

  // Restore one model back to `magpie` -> rewrites `models: []` back to `- {id: ...}` row cleanly!
  applyModelConfigChanges({
    upsertModels: [{ route: oldRoutes[0], provider: rawCfg.magpie?.provider ?? 'magpie' }],
  }, {
    configFile: cfgPath,
    target: 'base',
    syncPatches: true,
    patchFiles: [desktopPatch, magpiePatch],
  });
  assert.match(fs.readFileSync(magpiePatch, 'utf8'), /- \{id:/);
  assert.equal(inspectPatchTemplateSync(loadConfig(cfgPath, { includeLocal: false }), cfgPath, [desktopPatch, magpiePatch]).inSync, true);

  // 2. [P2-7] & [Extra-1] Installed npm package (`node_modules/dsh-leaderteam`):
  //    - `configure-models --local` BEFORE first DSH host start writes into `<DSH_HOME>/leaderteam/config/`, NOT `node_modules`!
  //    - Web UI `POST /api/apply` succeeds even when `node_modules/dsh-leaderteam` is read-only (`0555`)!
  const fakePkgRoot = path.join(tmp, 'ro-app', 'node_modules', 'dsh-leaderteam');
  const dshHome = path.join(tmp, 'fresh-dsh-home');
  fs.cpSync(path.join(REPO_ROOT, 'config'), path.join(fakePkgRoot, 'config'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'leaderteam'), path.join(fakePkgRoot, 'leaderteam'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(fakePkgRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(fakePkgRoot, 'package.json'));

  const preStartCli = spawnSync(
    process.execPath,
    [
      path.join(fakePkgRoot, 'scripts', 'configure-models.mjs'),
      '--local',
      '--set-role',
      'leader=deepseek/deepseek-flash:none',
    ],
    {
      cwd: tmp,
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: 'sk-test-solo' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(preStartCli.status, 0, preStartCli.stderr);
  assert.equal(
    fs.existsSync(path.join(fakePkgRoot, 'config', 'leaderteam.local.json')),
    false,
    'configure-models --local must NOT write inside node_modules',
  );
  const managedCfgFile = path.join(dshHome, 'leaderteam', 'config', 'leaderteam.config.json');
  const managedLocalFile = path.join(dshHome, 'leaderteam', 'config', 'leaderteam.local.json');
  assert.equal(fs.existsSync(managedCfgFile), true);
  assert.equal(fs.existsSync(managedLocalFile), true);

  // Simulate first DSH host startup (`resolveOrBootstrapConfigPath` + `loadConfig`) -> role edit MUST stick!
  const hostBoot = resolveOrBootstrapConfigPath({
    dshHome,
    env: { DEEPSEEK_API_KEY: 'sk-test-solo' },
    bundledDefaultConfigPath: path.join(fakePkgRoot, 'config', 'leaderteam.config.json'),
  });
  const effectiveAfterHostStart = loadConfig(hostBoot.configPath);
  assert.equal(effectiveAfterHostStart.roles.leader.route, 'deepseek/deepseek-flash');
  assert.equal(effectiveAfterHostStart.roles.leader.effort, 'none');

  // Make `fakePkgRoot` read-only on POSIX and test Web UI `POST /api/apply` (no `backupRoot` passed -> must NOT fail with EACCES!)
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(fakePkgRoot, 'config'), 0o555);
    fs.chmodSync(fakePkgRoot, 0o555);
  }
  const srv = await startModelConfigServer({
    configFile: managedCfgFile,
    dshHome,
    projectRoot: fakePkgRoot,
  });
  try {
    const res = await fetch(`${srv.url}api/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LT-Token': srv.csrfToken,
      },
      body: JSON.stringify({
        target: 'local',
        changes: { leaderModelPolicy: 'off' },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.saved, true);
    assert.ok(body.backupPath.startsWith(path.join(dshHome, 'leaderteam')), `backup must live under writable DSH_HOME, got ${body.backupPath}`);
  } finally {
    await srv.close();
  }

  // 3. [Extra-2] `plan-archive.mjs --status` honors `DSH_HOME` & `LEADERTEAM_CONFIG` custom archive root WITHOUT `--config`!
  const customArchiveRoot = path.join(tmp, 'custom-plan-archive');
  const managedCfgObj = JSON.parse(fs.readFileSync(managedCfgFile, 'utf8'));
  managedCfgObj.planArchive = { ...(managedCfgObj.planArchive ?? {}), root: customArchiveRoot };
  fs.writeFileSync(managedCfgFile, JSON.stringify(managedCfgObj, null, 2) + '\n');

  const cleanArchiveEnv = { ...process.env, DSH_HOME: dshHome };
  delete cleanArchiveEnv.LT_DSH_HOME;
  delete cleanArchiveEnv.LEADERTEAM_CONFIG;
  delete cleanArchiveEnv.LEADERTEAM_PLAN_ARCHIVE_ROOT;

  const statusViaDshHome = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'plan-archive.mjs'), '--status', '--json'],
    { cwd: REPO_ROOT, env: cleanArchiveEnv, encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  assert.equal(statusViaDshHome.status, 0, statusViaDshHome.stderr);
  assert.equal(JSON.parse(statusViaDshHome.stdout).root, customArchiveRoot, 'plan-archive --status must honor DSH_HOME managed config');

  const altArchiveRoot = path.join(tmp, 'env-cfg-archive');
  const altCfgFile = path.join(tmp, 'alt-leaderteam.config.json');
  fs.writeFileSync(altCfgFile, JSON.stringify({ ...managedCfgObj, planArchive: { root: altArchiveRoot } }, null, 2) + '\n');
  const statusViaEnvCfg = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'plan-archive.mjs'), '--status', '--json'],
    {
      cwd: REPO_ROOT,
      env: { ...cleanArchiveEnv, LEADERTEAM_CONFIG: altCfgFile },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    },
  );
  assert.equal(statusViaEnvCfg.status, 0, statusViaEnvCfg.stderr);
  assert.equal(JSON.parse(statusViaEnvCfg.stdout).root, altArchiveRoot, 'plan-archive --status must honor LEADERTEAM_CONFIG');

  // 4. [P1-3] `SIGINT` (`Ctrl+C`) to foreground `headless-run.mjs` terminates detached DSH process group before delayed writes!
  if (process.platform !== 'win32') {
    const hlWs = path.join(tmp, 'hl-ws');
    fs.mkdirSync(hlWs, { recursive: true });
    const postCancelMarker = path.join(tmp, 'post-sigint-leak.txt');
    const readyMarker = path.join(tmp, 'dsh-mock-ready.txt');
    const mockGrandchild = path.join(tmp, 'mock-grandchild.mjs');
    fs.writeFileSync(
      mockGrandchild,
      [
        "import fs from 'node:fs';",
        `setTimeout(() => { fs.writeFileSync(${JSON.stringify(postCancelMarker)}, 'grandchild-leaked'); }, 500);`,
      ].join('\n'),
    );
    const mockDshScript = path.join(tmp, 'mock-dsh.mjs');
    fs.writeFileSync(
      mockDshScript,
      [
        "import fs from 'node:fs';",
        "import { spawn } from 'node:child_process';",
        `const leakFile = ${JSON.stringify(postCancelMarker)};`,
        `const readyFile = ${JSON.stringify(readyMarker)};`,
        `spawn(process.execPath, [${JSON.stringify(mockGrandchild)}], { stdio: 'ignore' });`,
        "fs.writeFileSync(readyFile, String(process.pid));",
        "console.log(JSON.stringify({ type: 'session', sessionId: 'sigint-test' }));",
        "setTimeout(() => { fs.writeFileSync(leakFile, 'dsh-leaked'); process.exit(0); }, 500);",
      ].join('\n'),
    );

    let launcherErr = '';
    const launcher = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts', 'headless-run.mjs'), '--workspace', hlWs, '--task', 'ping'],
      {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LT_DSH_EXEC: process.execPath,
          LT_DSH_ENTRY: mockDshScript,
          LT_DSH_BIN: path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
          LT_DSH_HOME: path.join(tmp, 'hl-home'),
          LT_MAGPIE_BASEURL: 'http://127.0.0.1:1/v1',
        },
      },
    );
    launcher.stderr.on('data', d => { launcherErr += d; });
    launcher.stdout.resume();

    // Wait for mock DSH child to start and write readyMarker
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(readyMarker) && launcher.exitCode === null && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    assert.equal(fs.existsSync(readyMarker), true, `mock DSH process should have started (stderr: ${launcherErr})`);

    // Send SIGINT to foreground launcher's process group (simulating terminal Ctrl+C)
    process.kill(-launcher.pid, 'SIGINT');

    const exitCode = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('headless-run did not exit on SIGINT')), 5000);
      launcher.once('close', code => {
        clearTimeout(to);
        resolve(code);
      });
    });
    assert.equal(exitCode, 130, 'headless-run must exit with 130 on SIGINT');

    // Wait past the 500ms delayed write window to verify neither mock DSH nor its grandchild survived!
    await new Promise(r => setTimeout(r, 650));
    assert.equal(fs.existsSync(postCancelMarker), false, 'detached DSH child/grandchild must NOT complete writes after SIGINT');
  }
});
