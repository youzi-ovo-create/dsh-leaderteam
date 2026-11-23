import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_POWER_MONITOR_CONFIG,
  createPowerMonitorState,
  evaluatePowerSample,
  acknowledgePowerShutdownNotice,
  serializePowerState,
  hydratePowerState,
} from '../../leaderteam/core/power-monitor.mjs';
import { readSystemPowerSample } from '../../leaderteam/host/power-adapter.mjs';
import {
  DEFAULT_REQUEST_WINDOW_CONFIG,
  assessRequestWindow,
} from '../../leaderteam/core/request-window.mjs';
import {
  ElasticConcurrencyScheduler,
  readLinuxCgroupLimits,
  readLinuxProcMeminfo,
  sampleDeviceResources,
  computeConcurrencySnapshot,
} from '../../leaderteam/core/scheduler.mjs';
import {
  classifySandboxBoundary,
  evaluateHardRules,
  evaluateDirectExecSafetyGate,
} from '../../leaderteam/core/gate-policy.mjs';
import { configWith } from './helpers.mjs';

test('[V2.2 Power 1] Battery-Aware Graceful Shutdown state machine: notify once, durable retry until ack, silent after ack, rearm with autoResumeAllowed=false, VPS/WSL2/disabled no-ops', () => {
  assert.equal(DEFAULT_POWER_MONITOR_CONFIG.enabled, true);
  assert.equal(DEFAULT_POWER_MONITOR_CONFIG.pollIntervalMs, 720000);
  assert.equal(DEFAULT_POWER_MONITOR_CONFIG.minPollIntervalMs, 600000);
  assert.equal(DEFAULT_POWER_MONITOR_CONFIG.maxPollIntervalMs, 900000);
  assert.equal(DEFAULT_POWER_MONITOR_CONFIG.lowBatteryPct, 20);
  assert.equal(DEFAULT_POWER_MONITOR_CONFIG.resetBatteryPct, 25);

  const state = createPowerMonitorState();
  let nowMs = 1_700_000_000_000;

  // 1. Linux VPS (`unsupported`) & WSL2 without battery (`unknown`) -> silent no-op
  const vpsRes = evaluatePowerSample(state, { status: 'unsupported', onBattery: null, batteryPct: null }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(vpsRes.action, 'none');
  assert.equal(state.latched, false);
  assert.equal(vpsRes.autoResumeAllowed, false);

  const wslRes = evaluatePowerSample(state, { status: 'unknown', onBattery: null, batteryPct: null }, DEFAULT_POWER_MONITOR_CONFIG, nowMs + 1000);
  assert.equal(wslRes.action, 'none');
  assert.equal(state.latched, false);
  assert.equal(wslRes.autoResumeAllowed, false);

  // 2. `enabled: false` -> disabled even if battery is 5% on battery
  const disabledRes = evaluatePowerSample(
    state,
    { status: 'ok', onBattery: true, batteryPct: 5 },
    { ...DEFAULT_POWER_MONITOR_CONFIG, enabled: false },
    nowMs + 2000,
  );
  assert.equal(disabledRes.action, 'none');
  assert.equal(disabledRes.disabled, true);
  assert.equal(state.latched, false);

  // 3. 19% on battery -> triggers `notify_graceful_shutdown` once, latches, and holds `pendingNotice = true`
  nowMs += 720_000;
  const trig = evaluatePowerSample(state, { status: 'ok', onBattery: true, batteryPct: 19 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(trig.action, 'notify_graceful_shutdown');
  assert.equal(state.latched, true);
  assert.equal(state.pendingNotice, true);
  assert.equal(trig.autoResumeAllowed, false);
  assert.equal(trig.killProcesses, false);
  assert.equal(trig.instructions.stopNewNonEssentialDispatches, true);
  assert.equal(trig.instructions.allowInFlightSafeCheckpoint, true);
  assert.equal(trig.instructions.persistProgressAndResumeEntry, true);
  assert.equal(trig.instructions.killProcesses, false);

  // 4. Next poll at 19% BEFORE ack (e.g. Leader was mid-turn busy) -> durable `retry_pending_notice`
  nowMs += 720_000;
  const retryBeforeAck = evaluatePowerSample(state, { status: 'ok', onBattery: true, batteryPct: 19 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(retryBeforeAck.action, 'retry_pending_notice');
  assert.equal(state.latched, true);
  assert.equal(state.pendingNotice, true);
  assert.ok(retryBeforeAck.notice);

  // Persist & hydrate while `pendingNotice === true` -> survives cold restart!
  const serializedPending = JSON.stringify(serializePowerState(state));
  const hydratedPending = hydratePowerState(serializedPending);
  assert.equal(hydratedPending.latched, true);
  assert.equal(hydratedPending.pendingNotice, true);
  assert.equal(hydratedPending.autoResumeAllowed, false);

  // Acknowledge notice delivery -> clears `pendingNotice`, keeps `latched = true`
  acknowledgePowerShutdownNotice(state, { teamId: 'team-1', nowMs });
  assert.equal(state.latched, true);
  assert.equal(state.pendingNotice, false);

  // Next poll at 18% and hysteresis deadband 24% on battery AFTER ack -> silent (`action: 'none'`, zero spam!)
  nowMs += 720_000;
  const afterAck18 = evaluatePowerSample(state, { status: 'ok', onBattery: true, batteryPct: 18 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(afterAck18.action, 'none');
  assert.equal(state.latched, true);

  nowMs += 720_000;
  const deadband24 = evaluatePowerSample(state, { status: 'ok', onBattery: true, batteryPct: 24 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(deadband24.action, 'none', '24% (< resetBatteryPct 25%) on battery stays latched without oscillating');
  assert.equal(state.latched, true);

  // 5. Battery recovers to >= 25% on battery -> rearms detector ONLY, `autoResumeAllowed` MUST be `false`!
  nowMs += 720_000;
  const rearmedByPct = evaluatePowerSample(state, { status: 'ok', onBattery: true, batteryPct: 25 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(rearmedByPct.action, 'rearmed');
  assert.equal(state.latched, false);
  assert.equal(state.pendingNotice, false);
  assert.equal(rearmedByPct.autoResumeAllowed, false, 'CRITICAL: rearmed NEVER auto-resumes paused projects');
  assert.equal(state.autoResumeAllowed, false);

  // Trigger a second low-battery cycle (20% on battery), then plug in AC (`onBattery: false` at 17%) -> rearms with `autoResumeAllowed: false`!
  nowMs += 720_000;
  const trig2 = evaluatePowerSample(state, { status: 'ok', onBattery: true, batteryPct: 20 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(trig2.action, 'notify_graceful_shutdown');
  assert.equal(state.triggerCount, 2);

  nowMs += 60_000;
  const rearmedByAc = evaluatePowerSample(state, { status: 'ok', onBattery: false, batteryPct: 17 }, DEFAULT_POWER_MONITOR_CONFIG, nowMs);
  assert.equal(rearmedByAc.action, 'rearmed');
  assert.equal(state.latched, false);
  assert.equal(state.pendingNotice, false);
  assert.equal(rearmedByAc.autoResumeAllowed, false);

  // Tampered raw state with `autoResumeAllowed: true` is stripped to `false` on hydrate
  const hydratedTampered = hydratePowerState({ latched: false, pendingNotice: false, autoResumeAllowed: true });
  assert.equal(hydratedTampered.autoResumeAllowed, false);
});

test('[V2.2 Power 2] System power adapter: simulated /sys/class/power_supply temp dir, privacy isolation, WSL2, and Win32 CIM', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v22-sysfs-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // 1. Linux laptop discharging at 19% (with decoy serial_number / model_name files that MUST NEVER be read)
  const sysfsLaptop = path.join(tmp, 'laptop-power');
  fs.mkdirSync(path.join(sysfsLaptop, 'BAT0'), { recursive: true });
  fs.mkdirSync(path.join(sysfsLaptop, 'AC'), { recursive: true });
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'type'), 'Battery\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'capacity'), '19\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'status'), 'Discharging\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'serial_number'), 'PRIVACY-FORBIDDEN-SERIAL-999\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'model_name'), 'PRIVACY-FORBIDDEN-OEM-MODEL\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'AC', 'type'), 'Mains\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'AC', 'online'), '0\n');

  const filesRead = [];
  const trackingFs = {
    readdirSync: p => fs.readdirSync(p),
    readFileSync: (p, enc) => {
      filesRead.push(path.basename(String(p)));
      return fs.readFileSync(p, enc);
    },
  };

  const sampleDischarging = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    fs: trackingFs,
    sysfsPowerDir: sysfsLaptop,
  });
  assert.equal(sampleDischarging.status, 'ok');
  assert.equal(sampleDischarging.onBattery, true);
  assert.equal(sampleDischarging.batteryPct, 19);
  assert.equal(sampleDischarging.source, 'linux-sysfs');
  assert.equal(filesRead.includes('serial_number'), false, 'privacy rule: serial_number is NEVER read');
  assert.equal(filesRead.includes('model_name'), false, 'privacy rule: model_name is NEVER read');
  assert.equal(JSON.stringify(sampleDischarging).includes('PRIVACY-FORBIDDEN'), false);

  // Plug in AC (`online = 1`, `status = Charging`, `capacity = 26`)
  fs.writeFileSync(path.join(sysfsLaptop, 'AC', 'online'), '1\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'status'), 'Charging\n');
  fs.writeFileSync(path.join(sysfsLaptop, 'BAT0', 'capacity'), '26\n');
  const sampleCharging = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    sysfsPowerDir: sysfsLaptop,
  });
  assert.equal(sampleCharging.status, 'ok');
  assert.equal(sampleCharging.onBattery, false);
  assert.equal(sampleCharging.batteryPct, 26);

  // 2. Linux VPS (missing `/sys/class/power_supply` or empty dir) -> `unsupported`
  const vpsMissing = await readSystemPowerSample({
    platform: 'linux',
    isWsl: false,
    sysfsPowerDir: path.join(tmp, 'nonexistent-sysfs'),
  });
  assert.equal(vpsMissing.status, 'unsupported');
  assert.equal(vpsMissing.onBattery, null);
  assert.equal(vpsMissing.batteryPct, null);
  assert.equal(vpsMissing.source, 'linux-sysfs');

  // 3. WSL2 detected via `/proc/sys/kernel/osrelease` without battery -> `unknown` (`wsl-no-battery`)
  const fakeOsRelease = path.join(tmp, 'osrelease');
  fs.writeFileSync(fakeOsRelease, '5.15.153.1-microsoft-standard-WSL2\n');
  const emptySysfs = path.join(tmp, 'wsl-empty-power');
  fs.mkdirSync(emptySysfs, { recursive: true });
  const wslSample = await readSystemPowerSample({
    platform: 'linux',
    sysfsPowerDir: emptySysfs,
    procOsReleasePath: fakeOsRelease,
    procVersionPath: path.join(tmp, 'missing-version'),
  });
  assert.equal(wslSample.status, 'unknown');
  assert.equal(wslSample.onBattery, null);
  assert.equal(wslSample.batteryPct, null);
  assert.equal(wslSample.source, 'wsl-no-battery');

  // 4. Win32 CIM adapter: verifies `windowsHide: true`, no bogus CreateNoWindow, discharging, desktop unsupported, timeout degradation
  let capturedExecOpts = null;
  let capturedCmdArgs = null;
  const winDischarging = await readSystemPowerSample({
    platform: 'win32',
    execFile: (_cmd, args, opts, cb) => {
      capturedCmdArgs = args;
      capturedExecOpts = opts;
      cb(null, '{"BatteryStatus":1,"EstimatedChargeRemaining":18}\r\n', '');
    },
  });
  assert.equal(capturedExecOpts.windowsHide, true);
  assert.equal('CreateNoWindow' in capturedExecOpts, false);
  assert.ok(capturedCmdArgs.some(a => a.includes('BatteryStatus,EstimatedChargeRemaining')));
  assert.equal(winDischarging.status, 'ok');
  assert.equal(winDischarging.onBattery, true);
  assert.equal(winDischarging.batteryPct, 18);

  const winDesktop = await readSystemPowerSample({
    platform: 'win32',
    execFile: (_cmd, _args, _opts, cb) => cb(null, '', ''),
  });
  assert.equal(winDesktop.status, 'unsupported');

  const winTimeout = await readSystemPowerSample({
    platform: 'win32',
    execFile: (_cmd, _args, _opts, cb) => cb(new Error('ETIMEDOUT'), '', ''),
  });
  assert.equal(winTimeout.status, 'unknown');
});

test('[V2.2 Cgroup] Linux /proc/meminfo + cgroup v2 & cgroup v1 container caps throttle concurrency on a 64GiB host', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v22-cgroup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Simulated 64 GiB / 32-core host `/proc/meminfo`
  const meminfoFile = path.join(tmp, 'meminfo');
  fs.writeFileSync(meminfoFile, [
    'MemTotal:       67108864 kB',
    'MemFree:        16777216 kB',
    'MemAvailable:   50331648 kB',
    'Buffers:         1048576 kB',
    'Cached:         32505856 kB',
    'SwapTotal:       8388608 kB',
    'SwapFree:        8388608 kB',
    'CommitLimit:    50331648 kB',
    'Committed_AS:    8388608 kB',
  ].join('\n') + '\n');

  const parsedMem = readLinuxProcMeminfo(fs, meminfoFile);
  assert.equal(parsedMem.memTotalMib, 65536);
  assert.equal(parsedMem.memAvailableMib, 49152);
  assert.equal(parsedMem.commitLimitMib, 49152);
  assert.equal(parsedMem.committedAsMib, 8192);
  assert.equal(parsedMem.swapFreeMib, 8192);

  // 1. cgroup v2 container with 1 GiB limit (1024 MiB), 550 MiB used (474 MiB free), 2.0 CPU quota cores
  const cgV2Dir = path.join(tmp, 'cgroup-v2');
  fs.mkdirSync(cgV2Dir, { recursive: true });
  fs.writeFileSync(path.join(cgV2Dir, 'memory.max'), String(1024 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(cgV2Dir, 'memory.current'), String(550 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(cgV2Dir, 'memory.swap.max'), '0\n');
  fs.writeFileSync(path.join(cgV2Dir, 'cpu.max'), '200000 100000\n');

  const v2Limits = readLinuxCgroupLimits(fs, cgV2Dir);
  assert.equal(v2Limits.version, 2);
  assert.equal(v2Limits.memoryLimitMib, 1024);
  assert.equal(v2Limits.memoryUsageMib, 550);
  assert.equal(v2Limits.memoryRemainingMib, 474);
  assert.equal(v2Limits.cpuQuotaCores, 2);

  const devSampleV2 = sampleDeviceResources({
    platform: 'linux',
    fs,
    meminfoPath: meminfoFile,
    cgroupRoot: cgV2Dir,
    logicalCores: 32,
    cpuBusyPct: 20,
    hostRssMib: 180,
  });
  assert.equal(devSampleV2.totalPhysMib, 1024, '1GiB container reports 1024 MiB total, NEVER 65536 MiB host RAM');
  assert.equal(devSampleV2.availPhysMib, 474, '1GiB container reports 474 MiB remaining, NEVER 49152 MiB host free RAM');
  assert.equal(devSampleV2.logicalCores, 2, '32-core host capped to 2 cores by cgroup v2 cpu.max');

  // Compare scheduler capacity on bare 64GiB host vs 1GiB cgroup v2 container when userMax=16
  const cfg = configWith({
    team: { maxActiveMembers: 16, maxMembersPerTeam: 32 },
    scheduler: { rampStepSize: 16, lowFreePhysMib: 384, recoverFreePhysMib: 576 },
  });

  const cgUnboundedDir = path.join(tmp, 'cgroup-v2-max');
  fs.mkdirSync(cgUnboundedDir, { recursive: true });
  fs.writeFileSync(path.join(cgUnboundedDir, 'memory.max'), 'max\n');
  fs.writeFileSync(path.join(cgUnboundedDir, 'memory.current'), String(550 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(cgUnboundedDir, 'cpu.max'), 'max 100000\n');

  const hostSnap = computeConcurrencySnapshot({
    config: cfg,
    platform: 'linux',
    fs,
    meminfoPath: meminfoFile,
    cgroupRoot: cgUnboundedDir,
    targetProfile: 'code',
  });
  const containerSnap = computeConcurrencySnapshot({
    config: cfg,
    platform: 'linux',
    fs,
    meminfoPath: meminfoFile,
    cgroupRoot: cgV2Dir,
    targetProfile: 'code',
  });
  assert.ok(hostSnap.controls.effective_cap >= 8, `unbounded 64GiB host has generous cap (${hostSnap.controls.effective_cap})`);
  assert.ok(
    containerSnap.controls.effective_cap <= 2,
    `1GiB cgroup v2 container throttles concurrency to ${containerSnap.controls.effective_cap} (<= 2) on 64GiB host`,
  );

  // Push container usage to 700 MiB (324 MiB remaining <= lowFreePhysMib 384 MiB) -> trips `phys_mem_low` hysteresis!
  fs.writeFileSync(path.join(cgV2Dir, 'memory.current'), String(700 * 1024 * 1024) + '\n');
  const schedV2 = new ElasticConcurrencyScheduler(cfg, {
    platform: 'linux',
    fs,
    meminfoPath: meminfoFile,
    cgroupRoot: cgV2Dir,
  });
  const blockedInContainer = schedV2.checkDispatch({
    teamId: 't-cg',
    taskSeq: 1,
    activeMembers: [{ id: 'm1', name: 'worker-1', status: 'running', profile: 'code' }],
    profile: 'code',
  });
  assert.equal(blockedInContainer.allowed, false);
  assert.equal(blockedInContainer.snapshot.hysteresis.mode, 'throttled');
  assert.ok(blockedInContainer.snapshot.pipeline.bottlenecks.includes('phys_mem_low'));

  // 2. cgroup v1 fallback (`memory/memory.limit_in_bytes`, `memory/memory.usage_in_bytes`, `cpu/cpu.cfs_quota_us`)
  const cgV1Dir = path.join(tmp, 'cgroup-v1');
  fs.mkdirSync(path.join(cgV1Dir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(cgV1Dir, 'cpu'), { recursive: true });
  fs.writeFileSync(path.join(cgV1Dir, 'memory', 'memory.limit_in_bytes'), String(1024 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(cgV1Dir, 'memory', 'memory.usage_in_bytes'), String(640 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(cgV1Dir, 'cpu', 'cpu.cfs_quota_us'), '150000\n');
  fs.writeFileSync(path.join(cgV1Dir, 'cpu', 'cpu.cfs_period_us'), '100000\n');

  const v1Limits = readLinuxCgroupLimits(fs, cgV1Dir);
  assert.equal(v1Limits.version, 1);
  assert.equal(v1Limits.memoryLimitMib, 1024);
  assert.equal(v1Limits.memoryUsageMib, 640);
  assert.equal(v1Limits.memoryRemainingMib, 384);
  assert.equal(v1Limits.cpuQuotaCores, 1.5);

  const devSampleV1 = sampleDeviceResources({
    platform: 'linux',
    fs,
    meminfoPath: meminfoFile,
    cgroupRoot: cgV1Dir,
    logicalCores: 32,
  });
  assert.equal(devSampleV1.availPhysMib, 384);
  assert.equal(devSampleV1.logicalCores, 2);

  // cgroup v1 kernel unlimited sentinel (`9223372036854771712` & `-1` cfs_quota_us) is treated as unbounded
  const cgV1Unlimited = path.join(tmp, 'cgroup-v1-unlim');
  fs.mkdirSync(path.join(cgV1Unlimited, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(cgV1Unlimited, 'cpu'), { recursive: true });
  fs.writeFileSync(path.join(cgV1Unlimited, 'memory', 'memory.limit_in_bytes'), '9223372036854771712\n');
  fs.writeFileSync(path.join(cgV1Unlimited, 'memory', 'memory.usage_in_bytes'), String(512 * 1024 * 1024) + '\n');
  fs.writeFileSync(path.join(cgV1Unlimited, 'cpu', 'cpu.cfs_quota_us'), '-1\n');
  fs.writeFileSync(path.join(cgV1Unlimited, 'cpu', 'cpu.cfs_period_us'), '100000\n');
  const v1Unlim = readLinuxCgroupLimits(fs, cgV1Unlimited);
  assert.equal(v1Unlim.memoryLimitMib, null);
  assert.equal(v1Unlim.cpuQuotaCores, null);
});

test('[V2.2 Request Window] 5h non-diluting request window: honest provenance, 3-tier progression, skipGovernanceReviews===false in every tier, and scheduler cap', () => {
  const nowMs = 1_800_000_000_000;
  const fiveHoursMs = DEFAULT_REQUEST_WINDOW_CONFIG.windowMs;
  assert.equal(fiveHoursMs, 5 * 60 * 60 * 1000);

  // Timestamps: 2 expired (>5h ago) + 3 inside `(nowMs - 5h, nowMs]`
  const callTimestamps = [
    nowMs - fiveHoursMs - 5000,
    nowMs - fiveHoursMs, // exact boundary `nowMs - windowMs` is outside `(nowMs - windowMs, nowMs]`
    nowMs - 60_000,
    nowMs - 10_000,
    nowMs,
  ];

  // 1. Unconfigured `providerWindowMax` & null `providerConfirmedQuota`: honest provenance, never fabricates global count
  const unknownRes = assessRequestWindow({
    localCallTimestampsMs: callTimestamps,
    providerConfirmedQuota: null,
    providerWindowMax: null,
    nowMs,
  });
  assert.equal(unknownRes.local_estimated_requests_5h, 3);
  assert.equal(unknownRes.localSource, 'local-estimate');
  assert.equal(unknownRes.provider_confirmed_quota, 'unknown');
  assert.equal(unknownRes.confirmedSource, 'unknown');
  assert.equal(unknownRes.localEstimatedRemainingPct, null);
  assert.equal(unknownRes.tier, 'normal');
  assert.equal(unknownRes.skipGovernanceReviews, false);

  // 2. Tier 1 (`trim_probes`): provider-confirmed remaining 18% (<= softThrottlePct 20%)
  const tier1 = assessRequestWindow({
    localCallTimestampsMs: callTimestamps,
    providerConfirmedQuota: { remainingPct: 18, windowName: '5 hours' },
    nowMs,
  });
  assert.equal(tier1.tier, 'trim_probes');
  assert.equal(tier1.confirmedSource, 'provider-confirmed');
  assert.equal(tier1.suppressOptionalModelProbes, true);
  assert.equal(tier1.maxNewDispatchCap, null);
  assert.equal(tier1.triggerCheckpointPause, false);
  assert.equal(tier1.skipGovernanceReviews, false);

  // 3. Tier 2 (`cap_new_dispatches`): provider-confirmed remaining 11% (<= 12%)
  const tier2 = assessRequestWindow({
    localCallTimestampsMs: callTimestamps,
    providerConfirmedQuota: { remainingPct: 11, windowName: '5 hours' },
    nowMs,
  });
  assert.equal(tier2.tier, 'cap_new_dispatches');
  assert.equal(tier2.suppressOptionalModelProbes, true);
  assert.equal(tier2.maxNewDispatchCap, 1);
  assert.equal(tier2.triggerCheckpointPause, false);
  assert.equal(tier2.skipGovernanceReviews, false);

  // 4. Tier 3 (`checkpoint_pause`):
  //   a) confirmed remaining <= 5%
  const tier3Confirmed = assessRequestWindow({
    localCallTimestampsMs: callTimestamps,
    providerConfirmedQuota: { remainingPct: 4, windowName: '5 hours' },
    nowMs,
  });
  assert.equal(tier3Confirmed.tier, 'checkpoint_pause');
  assert.equal(tier3Confirmed.suppressOptionalModelProbes, true);
  assert.equal(tier3Confirmed.maxNewDispatchCap, 0);
  assert.equal(tier3Confirmed.triggerCheckpointPause, true);
  assert.equal(tier3Confirmed.skipGovernanceReviews, false);
  assert.equal(tier3Confirmed.auditRecord?.kind, 'request-window-throttle');

  //   b) local estimate >= configured `providerWindowMax * 0.95` (95 / 100 calls) while confirmed is still unknown!
  const ninetyFiveCalls = Array.from({ length: 95 }, (_, i) => nowMs - i * 1000);
  const tier3Local = assessRequestWindow({
    localCallTimestampsMs: ninetyFiveCalls,
    providerConfirmedQuota: null,
    providerWindowMax: 100,
    nowMs,
  });
  assert.equal(tier3Local.tier, 'checkpoint_pause');
  assert.equal(tier3Local.local_estimated_requests_5h, 95);
  assert.equal(tier3Local.provider_confirmed_quota, 'unknown', 'local estimate never masquerades as provider-confirmed');
  assert.equal(tier3Local.confirmedSource, 'unknown');
  assert.equal(tier3Local.maxNewDispatchCap, 0);
  assert.equal(tier3Local.triggerCheckpointPause, true);
  assert.equal(tier3Local.skipGovernanceReviews, false);

  //   c) explicit upstream 5h-window 429 burst
  const tier3Burst = assessRequestWindow({
    localCallTimestampsMs: [],
    upstreamError: { code: '429', message: 'HTTP 429 rate limit exceeded for 5 hours window' },
    nowMs,
  });
  assert.equal(tier3Burst.tier, 'checkpoint_pause');
  assert.equal(tier3Burst.skipGovernanceReviews, false);

  //   d) disabled config also keeps `skipGovernanceReviews === false`
  const disabledTier = assessRequestWindow({
    localCallTimestampsMs: ninetyFiveCalls,
    providerConfirmedQuota: { remainingPct: 1 },
    config: { ...DEFAULT_REQUEST_WINDOW_CONFIG, enabled: false },
    nowMs,
  });
  assert.equal(disabledTier.tier, 'normal');
  assert.equal(disabledTier.skipGovernanceReviews, false);

  // 5. Integration with `computeConcurrencySnapshot` / `ElasticConcurrencyScheduler`:
  //    Tier 2 (`requestWindowMaxCap: 1`) caps new execution dispatches to 1 without killing active members or touching governance!
  const cfg = configWith({ team: { maxActiveMembers: 8 }, scheduler: { rampStepSize: 8 } });
  const sched = new ElasticConcurrencyScheduler(cfg, {
    deviceProbe: () => ({ logicalCores: 16, cpuBusyPct: 10, totalPhysMib: 32768, availPhysMib: 20000 }),
  });
  const snapTier2 = computeConcurrencySnapshot(sched, {
    teamId: 't-rw',
    taskSeq: 1,
    activeMembers: [],
    requestWindowMaxCap: tier2.maxNewDispatchCap, // 1
  });
  assert.equal(snapTier2.controls.effective_cap, 1);
  assert.equal(snapTier2.controls.ramp_available_now, 1);
  assert.equal(snapTier2.active_execution_members.governance_roles_excluded, true);

  const admit1 = sched.admitDispatch({ teamId: 't-rw', taskSeq: 1, activeMembers: [], profile: 'code', requestWindowMaxCap: 1 });
  assert.equal(admit1.allowed, true);
  const admit2 = sched.admitDispatch({
    teamId: 't-rw',
    taskSeq: 1,
    activeMembers: [{ id: 'm1', name: 'impl-1', status: 'running', profile: 'code' }],
    profile: 'code',
    requestWindowMaxCap: 1,
  });
  assert.equal(admit2.allowed, false);
  assert.match(admit2.reason, /request window cap=1/);

  // Tier 3 (`requestWindowMaxCap: 0`) drains existing members gracefully without killing them and blocks new dispatches
  const snapTier3 = computeConcurrencySnapshot(sched, {
    teamId: 't-rw',
    taskSeq: 1,
    activeMembers: [
      { id: 'm1', name: 'impl-1', status: 'running', profile: 'code' },
      { id: 'm2', name: 'impl-2', status: 'running', profile: 'code' },
    ],
    requestWindowMaxCap: tier3Confirmed.maxNewDispatchCap, // 0
  });
  assert.equal(snapTier3.controls.effective_cap, 0);
  assert.equal(snapTier3.controls.ramp_available_now, 0);
  assert.equal(snapTier3.controls.scale_state, 'draining_above_cap');
});

test('[V2.2 Gate] Linux & cross-shell bash escape hard rules and sandbox boundary confinement', () => {
  const linuxCfg = configWith({
    paths: {
      globalRefRoots: ['/opt/shared-refs'],
    },
  });
  const wsLinux = '/home/dev/project';
  const shellMember = {
    role: 'member',
    name: 'impl-linux',
    profile: 'shell',
    allowedTools: linuxCfg.profiles.shell.tools,
    loadedTools: linuxCfg.profiles.shell.tools,
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

  const hardLinux = (command, actor = shellMember, extraArgs = {}) => evaluateHardRules({
    tool: 'bash',
    args: { command, ...extraArgs },
    actor,
    cwd: wsLinux,
    platform: 'linux',
  }, linuxCfg);

  const boundaryLinux = (command, extraArgs = {}) => classifySandboxBoundary({
    tool: 'bash',
    args: { command, ...extraArgs },
    actor: shellMember,
    cwd: wsLinux,
    platform: 'linux',
  }, linuxCfg);

  // 1. Safe in-workspace bash commands pass `evaluateHardRules` AND stay confined (`by="sandbox"`)
  for (const okCmd of [
    'npm test',
    'cd src && node --test index.test.mjs',
    'echo "build ok" > src/output.txt',
    'node --check src/app.mjs > /dev/null 2>&1',
    `node "${wsLinux}/src/app.mjs"`,
  ]) {
    assert.equal(hardLinux(okCmd), undefined, `safe bash command should pass hard rules: ${okCmd}`);
    assert.equal(boundaryLinux(okCmd).confined, true, `safe bash command should be sandbox-confined: ${okCmd}`);
  }

  // 2. Command substitution `$(...)`, backticks `` `...` ``, and process substitution `<(...)` / `>(...)`:
  //    - In-workspace substitutions NEVER bypass model review as `by="sandbox"` (`confined: false`)!
  for (const subCmd of [
    'echo $(git rev-parse HEAD)',
    'echo `git branch --show-current`',
    'diff <(sort src/a.txt) <(sort src/b.txt)',
    'tee >(wc -l > src/count.txt) < src/a.txt > /dev/null',
  ]) {
    const b = boundaryLinux(subCmd);
    assert.equal(b.confined, false, `substitution must NEVER bypass safety gate review as sandbox: ${subCmd}`);
  }
  //    - Obvious outside-path escapes inside substitutions are deterministically blocked by `evaluateHardRules`!
  for (const escapeSub of [
    'cat $(echo /etc/passwd)',
    'cat `echo /tmp/secret.txt`',
    'diff <(cat /etc/passwd) src/a.txt',
    'echo $(cd /tmp && ls)',
    'echo `ln -s /etc/passwd src/pwn`',
    'cat $(echo ../../outside.txt)',
  ]) {
    const hit = hardLinux(escapeSub);
    assert.ok(hit, `outside escape in substitution must be blocked by hard rules: ${escapeSub}`);
    assert.equal(boundaryLinux(escapeSub).confined, false);
  }

  // 3. `cd <outside>` / `pushd <outside>` (including chained `cd src && cd ../..` and bare `cd`)
  for (const cdEscape of [
    'cd /tmp',
    'cd /tmp && ls',
    'pushd /var/log',
    'cd ../outside-project',
    'cd src && cd ../..',
    'cd && pwd',
    'cd ~/secrets',
  ]) {
    assert.ok(hardLinux(cdEscape), `cd/pushd escape must be blocked by hard rules: ${cdEscape}`);
    assert.equal(boundaryLinux(cdEscape).confined, false, `cd/pushd escape cannot be confined: ${cdEscape}`);
  }

  // 4. Output redirection (`>`, `>>`, `2>`, `&>`, `| tee`) targeting outside workspace, protectedDirs, or globalRefRoots
  for (const redirEscape of [
    'echo pwn > ../escape',
    'echo pwn >> /tmp/out.txt',
    'ls 2> /outside/err.log',
    'echo hook > .git/hooks/pre-commit',
    'echo cfg &> .leaderteam/override.json',
    'echo rules > AGENTS.md',
    'echo leak > /opt/shared-refs/tamper.md',
    'echo pwn | tee /outside',
    'echo pwn | tee -a ../escape',
    'echo pwn | tee .git/config',
  ]) {
    assert.ok(hardLinux(redirEscape), `redirection/tee escape must be blocked by hard rules: ${redirEscape}`);
    assert.equal(boundaryLinux(redirEscape).confined, false, `redirection/tee escape cannot be confined: ${redirEscape}`);
  }

  // 5. Symlink creation (`ln -s` / `ln -sf`) pointing outside workspace or into protected/global-ref dirs
  for (const lnEscape of [
    'ln -s /etc/passwd',
    'ln -sf /etc/passwd src/passwd-link',
    'ln -s ../../outside-secret src/rel-escape',
    'ln -s ../.git/config src/git-config-link',
    'ln -sf /opt/shared-refs/doc.md src/ref-link',
  ]) {
    assert.ok(hardLinux(lnEscape), `symlink escape must be blocked by hard rules: ${lnEscape}`);
    assert.equal(boundaryLinux(lnEscape).confined, false, `symlink escape cannot be confined: ${lnEscape}`);
  }

  // 6. Detached background daemons (`nohup`, `disown`, `setsid`, and trailing `&` in `direct_exec`)
  for (const daemonCmd of [
    'nohup node src/server.js &',
    'nohup python3 -m http.server 8080 >/dev/null 2>&1 &',
    'node src/worker.js & disown',
    'setsid ./src/daemon.sh',
  ]) {
    assert.ok(hardLinux(daemonCmd), `detached daemon must be blocked by hard rules: ${daemonCmd}`);
    assert.equal(boundaryLinux(daemonCmd).confined, false);
  }

  // Trailing `&` in `direct_exec` is blocked by BOTH `evaluateHardRules` and `evaluateDirectExecSafetyGate`
  const directTrailBgHard = hardLinux('node src/worker.js &', directActor);
  assert.equal(directTrailBgHard?.rule, 'direct-exec-sandbox-lock');
  const directTrailBgGate = evaluateDirectExecSafetyGate({
    tool: 'bash',
    args: { command: 'node src/worker.js &' },
    actor: directActor,
    cwd: wsLinux,
    platform: 'linux',
  }, linuxCfg);
  assert.equal(directTrailBgGate.decision, 'deny');

  // 7. Cross-shell `bash` tool invoked on `platform: 'win32'` (e.g. Git Bash / MSYS on `D:\` root or `D:\proj`)
  const winCfg = configWith({});
  const winShellMember = {
    role: 'member',
    name: 'impl-win-bash',
    profile: 'shell',
    allowedTools: winCfg.profiles.shell.tools,
    loadedTools: winCfg.profiles.shell.tools,
    writeScope: ['src/**'],
    unreadRefs: [],
  };
  for (const crossBashEscape of [
    'cd /tmp',
    'ln -s /etc/passwd src/pw',
    'echo x > ../escape',
    'echo x | tee /outside',
    'nohup node src/a.js &',
  ]) {
    const hitWinBash = evaluateHardRules({
      tool: 'bash',
      args: { command: crossBashEscape },
      actor: winShellMember,
      cwd: 'D:\\proj',
      platform: 'win32',
    }, winCfg);
    assert.ok(hitWinBash, `cross-shell bash on win32 must block: ${crossBashEscape}`);
  }
});
