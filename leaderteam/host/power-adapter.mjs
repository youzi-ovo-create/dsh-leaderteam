// Cross-platform system battery adapter for LeaderTeam.
// Zero external npm dependencies.
// Privacy & security invariant: ONLY reads `(onBattery, batteryPct)` — NEVER reads serial numbers,
// battery model names, OEM/manufacturer strings, uevent dumps, or hardware identifiers.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function readTrimmedSafe(fsImpl, filePath) {
  try {
    return String(fsImpl.readFileSync(filePath, 'utf8')).trim();
  } catch {
    return null;
  }
}

export function detectWslEnvironment(fsImpl = fs, {
  platform = process.platform,
  procOsReleasePath = '/proc/sys/kernel/osrelease',
  procVersionPath = '/proc/version',
} = {}) {
  if (platform !== 'linux') return false;
  const osRelease = readTrimmedSafe(fsImpl, procOsReleasePath) ?? '';
  if (/microsoft|wsl/i.test(osRelease)) return true;
  const procVer = readTrimmedSafe(fsImpl, procVersionPath) ?? '';
  return /microsoft|wsl/i.test(procVer);
}

function parseLinuxSysfsPower(fsImpl, sysfsDir, isWsl, sampledAt) {
  let entries;
  try {
    entries = fsImpl.readdirSync(sysfsDir);
  } catch {
    return isWsl
      ? { status: 'unknown', onBattery: null, batteryPct: null, source: 'wsl-no-battery', sampledAt }
      : { status: 'unsupported', onBattery: null, batteryPct: null, source: 'linux-sysfs', sampledAt };
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return isWsl
      ? { status: 'unknown', onBattery: null, batteryPct: null, source: 'wsl-no-battery', sampledAt }
      : { status: 'unsupported', onBattery: null, batteryPct: null, source: 'linux-sysfs', sampledAt };
  }

  let anyMainsOnline = false;
  const batteryCandidates = [];
  let sawBatteryDevice = false;

  for (const rawEntry of entries) {
    const name = typeof rawEntry === 'string' ? rawEntry : rawEntry?.name;
    if (!name) continue;
    const devDir = path.join(sysfsDir, name);
    // Privacy rule: strictly read ONLY `type`, `online`, `capacity`, and `status`.
    const devType = readTrimmedSafe(fsImpl, path.join(devDir, 'type')) ?? '';
    const isMains = /^Mains$/i.test(devType) || /^(?:AC|ADP|ACAD)/i.test(name);
    if (isMains) {
      const online = readTrimmedSafe(fsImpl, path.join(devDir, 'online'));
      if (online === '1') anyMainsOnline = true;
    }

    const isBattery = /^Battery$/i.test(devType) || /^BAT/i.test(name);
    if (!isBattery) continue;
    sawBatteryDevice = true;

    const rawCap = readTrimmedSafe(fsImpl, path.join(devDir, 'capacity'));
    const rawStatus = readTrimmedSafe(fsImpl, path.join(devDir, 'status'));
    const capNum = rawCap !== null && rawCap !== '' ? Number(rawCap) : Number.NaN;
    if (!Number.isFinite(capNum) || capNum < 0 || capNum > 100) continue;
    if (!rawStatus) continue;

    let devOnBattery = null;
    if (/^Discharging$/i.test(rawStatus)) {
      devOnBattery = true;
    } else if (/^(?:Charging|Full|Not charging)$/i.test(rawStatus)) {
      devOnBattery = false;
    } else if (anyMainsOnline) {
      devOnBattery = false;
    }

    if (devOnBattery !== null) {
      batteryCandidates.push({ capacity: Math.round(capNum), onBattery: devOnBattery });
    }
  }

  if (batteryCandidates.length === 0) {
    if (isWsl) {
      return { status: 'unknown', onBattery: null, batteryPct: null, source: 'wsl-no-battery', sampledAt };
    }
    if (!sawBatteryDevice) {
      return { status: 'unsupported', onBattery: null, batteryPct: null, source: 'linux-sysfs', sampledAt };
    }
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'linux-sysfs', sampledAt };
  }

  const avgPct = Math.round(
    batteryCandidates.reduce((acc, b) => acc + b.capacity, 0) / batteryCandidates.length,
  );
  const onBattery = anyMainsOnline
    ? false
    : batteryCandidates.some(b => b.onBattery === true);

  return {
    status: 'ok',
    onBattery,
    batteryPct: Math.max(0, Math.min(100, avgPct)),
    source: 'linux-sysfs',
    sampledAt,
  };
}

function execFileAsync(execFileImpl, cmd, args, opts) {
  return new Promise(resolve => {
    try {
      execFileImpl(cmd, args, opts, (error, stdout) => {
        if (error) {
          resolve({ ok: false, stdout: '' });
          return;
        }
        resolve({ ok: true, stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

async function readWin32PowerSample(execFileImpl, timeoutMs, sampledAt) {
  // Privacy rule: query ONLY BatteryStatus and EstimatedChargeRemaining (never DeviceID, Name, SerialNumber, etc.).
  const psScript = '(Get-CimInstance -ClassName Win32_Battery -Property BatteryStatus,EstimatedChargeRemaining | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress)';
  const psArgs = ['-NoProfile', '-NonInteractive', '-Command', psScript];
  const execOpts = { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 };

  const res = await execFileAsync(execFileImpl, 'powershell.exe', psArgs, execOpts);
  if (!res.ok) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'win32-cim', sampledAt };
  }

  const trimmed = res.stdout.trim();
  if (!trimmed || trimmed === 'null') {
    // Desktop PC / workstation / VM without battery hardware
    return { status: 'unsupported', onBattery: null, batteryPct: null, source: 'win32-cim', sampledAt };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'win32-cim', sampledAt };
  }

  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!item || typeof item !== 'object') {
    return { status: 'unsupported', onBattery: null, batteryPct: null, source: 'win32-cim', sampledAt };
  }

  const statusCode = Number(item.BatteryStatus);
  const charge = Number(item.EstimatedChargeRemaining);
  if (!Number.isFinite(charge) || charge < 0 || charge > 100) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'win32-cim', sampledAt };
  }

  // Win32_Battery BatteryStatus:
  // 1 = Discharging / Other (on battery), 4 = Low, 5 = Critical (on battery)
  // 2 = AC online, 3 = Fully Charged, 6 = Charging, 7 = Charging+High, 8 = Charging+Low, 9 = Charging+Critical
  let onBattery = null;
  if (statusCode === 1 || statusCode === 4 || statusCode === 5) {
    onBattery = true;
  } else if ([2, 3, 6, 7, 8, 9].includes(statusCode)) {
    onBattery = false;
  }

  if (onBattery === null) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'win32-cim', sampledAt };
  }

  return {
    status: 'ok',
    onBattery,
    batteryPct: Math.max(0, Math.min(100, Math.round(charge))),
    source: 'win32-cim',
    sampledAt,
  };
}

async function readDarwinPowerSample(execFileImpl, timeoutMs, sampledAt) {
  const res = await execFileAsync(execFileImpl, 'pmset', ['-g', 'batt'], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024,
  });
  if (!res.ok) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'darwin-pmset', sampledAt };
  }
  const out = res.stdout;
  if (!/InternalBattery/i.test(out)) {
    return { status: 'unsupported', onBattery: null, batteryPct: null, source: 'darwin-pmset', sampledAt };
  }
  const pctMatch = /\b(\d{1,3})%/.exec(out);
  if (!pctMatch) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'darwin-pmset', sampledAt };
  }
  const pct = Number.parseInt(pctMatch[1], 10);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'darwin-pmset', sampledAt };
  }
  const onBattery = /Battery Power/i.test(out) || (/;\s*discharging\b/i.test(out) && !/AC Power/i.test(out));
  return {
    status: 'ok',
    onBattery,
    batteryPct: pct,
    source: 'darwin-pmset',
    sampledAt,
  };
}

function normalizeInjectedSample(raw, sampledAt) {
  if (!raw || typeof raw !== 'object') {
    return { status: 'unknown', onBattery: null, batteryPct: null, source: 'host-reader', sampledAt };
  }
  const status = raw.status === 'ok' || raw.status === 'unsupported' || raw.status === 'unknown'
    ? raw.status
    : (typeof raw.onBattery === 'boolean' && typeof raw.batteryPct === 'number' ? 'ok' : 'unknown');
  const source = typeof raw.source === 'string' && raw.source ? raw.source : 'host-reader';
  const ts = typeof raw.sampledAt === 'string' && raw.sampledAt ? raw.sampledAt : sampledAt;
  if (status !== 'ok') {
    return { status, onBattery: null, batteryPct: null, source, sampledAt: ts };
  }
  const pct = typeof raw.batteryPct === 'number' && Number.isFinite(raw.batteryPct)
    ? Math.max(0, Math.min(100, Math.round(raw.batteryPct)))
    : null;
  const onBattery = typeof raw.onBattery === 'boolean' ? raw.onBattery : null;
  if (pct === null || onBattery === null) {
    return { status: 'unknown', onBattery: null, batteryPct: null, source, sampledAt: ts };
  }
  return { status: 'ok', onBattery, batteryPct: pct, source, sampledAt: ts };
}

/**
 * Sample system `(onBattery, batteryPct)` safely across Linux, WSL2, Windows, and macOS.
 * Never throws; degrades gracefully to `{ status: 'unsupported' | 'unknown' }`.
 */
export async function readSystemPowerSample(options = {}) {
  const nowMs = typeof options.nowMs === 'number' && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const sampledAt = new Date(nowMs).toISOString();

  if (typeof options.hostPowerReader === 'function') {
    try {
      const injected = await options.hostPowerReader(options);
      return normalizeInjectedSample(injected, sampledAt);
    } catch {
      return { status: 'unknown', onBattery: null, batteryPct: null, source: 'host-reader-error', sampledAt };
    }
  }

  const platform = options.platform ?? process.platform;
  const fsImpl = options.fs ?? fs;
  const execFileImpl = options.execFile ?? execFile;
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 5000;

  if (platform === 'linux') {
    const sysfsDir = options.sysfsPowerDir ?? options.powerSupplyDir ?? '/sys/class/power_supply';
    const isWsl = typeof options.isWsl === 'boolean'
      ? options.isWsl
      : detectWslEnvironment(fsImpl, {
          platform,
          procOsReleasePath: options.procOsReleasePath,
          procVersionPath: options.procVersionPath,
        });
    return parseLinuxSysfsPower(fsImpl, sysfsDir, isWsl, sampledAt);
  }

  if (platform === 'win32') {
    return readWin32PowerSample(execFileImpl, timeoutMs, sampledAt);
  }

  if (platform === 'darwin') {
    return readDarwinPowerSample(execFileImpl, timeoutMs, sampledAt);
  }

  return {
    status: 'unknown',
    onBattery: null,
    batteryPct: null,
    source: `platform-${platform}`,
    sampledAt,
  };
}
