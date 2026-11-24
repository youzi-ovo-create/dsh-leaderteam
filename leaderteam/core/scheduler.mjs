// Resource-aware elastic concurrency scheduler for execution subagents.
// Governance roles (leader, gate, discussA, discussB, arbiter) are strictly excluded:
// they never count toward execution concurrency and are never throttled or shed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MEMBER_TERMINAL_STATUSES } from './constants.mjs';
import { parseReadGrants } from './gate-policy.mjs';
import { writeFileAtomic } from './store.mjs';

export function concurrencyControlPath(storageRoot) {
  return path.join(storageRoot, 'concurrency.json');
}

export function teamConcurrencyControlPath(storageRoot, teamId) {
  if (typeof teamId !== 'string' || !teamId || /[\\/\0]|^\.\.?$/.test(teamId)) {
    throw new Error(`unsafe teamId for concurrency control path: ${teamId}`);
  }
  return path.join(storageRoot, 'teams', teamId, 'concurrency.json');
}

export function readConcurrencyControlFile(storageRoot) {
  const file = concurrencyControlPath(storageRoot);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return null;
  }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const max = parsed.maxActiveMembers;
    const updatedAtMs = typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
      ? parsed.updatedAtMs
      : (typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) || 0 : 0);
    if (max === null) return { maxActiveMembers: null, source: parsed.source ?? 'file', updatedAtMs };
    if (Number.isInteger(max) && max >= 1 && max <= 200) {
      return { maxActiveMembers: max, source: parsed.source ?? 'file', updatedAtMs };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeConcurrencyControlFile(storageRoot, maxActiveMembers, source = 'cli') {
  const file = concurrencyControlPath(storageRoot);
  const nowMs = Date.now();
  const payload = {
    v: 1,
    maxActiveMembers: maxActiveMembers === null ? null : Math.max(1, Math.min(200, Math.trunc(Number(maxActiveMembers)))),
    source,
    updatedAt: new Date(nowMs).toISOString(),
    updatedAtMs: nowMs,
  };
  writeFileAtomic(file, JSON.stringify(payload, null, 2) + '\n');
  return { file, ...payload };
}

export function readTeamConcurrencyFile(storageRoot, teamId) {
  let file;
  try { file = teamConcurrencyControlPath(storageRoot, teamId); } catch { return null; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const max = parsed.maxActiveMembers;
    const validMax = max === null ? null : (Number.isInteger(max) && max >= 1 && max <= 200 ? max : undefined);
    if (validMax === undefined) return null;
    const updatedAtMs = typeof parsed.updatedAtMs === 'number' && Number.isFinite(parsed.updatedAtMs)
      ? parsed.updatedAtMs
      : (typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) || 0 : 0);
    const lastChatDirectiveIndex = Number.isInteger(parsed.lastChatDirectiveIndex) && parsed.lastChatDirectiveIndex >= -1
      ? parsed.lastChatDirectiveIndex
      : -1;
    return { maxActiveMembers: validMax, source: parsed.source ?? 'chat', updatedAtMs, lastChatDirectiveIndex };
  } catch {
    return null;
  }
}

export function writeTeamConcurrencyFile(storageRoot, teamId, { maxActiveMembers, lastChatDirectiveIndex = -1, source = 'chat', updatedAtMs = Date.now() } = {}) {
  const file = teamConcurrencyControlPath(storageRoot, teamId);
  const payload = {
    v: 1,
    teamId,
    maxActiveMembers: maxActiveMembers === null ? null : Math.max(1, Math.min(200, Math.trunc(Number(maxActiveMembers)))),
    source,
    lastChatDirectiveIndex: Number.isInteger(lastChatDirectiveIndex) ? lastChatDirectiveIndex : -1,
    updatedAt: new Date(updatedAtMs).toISOString(),
    updatedAtMs,
  };
  writeFileAtomic(file, JSON.stringify(payload, null, 2) + '\n');
  return { file, ...payload };
}

/** Clear active session-level chat overrides on disk while preserving `lastChatDirectiveIndex` so resets never replay old messages. */
export function resetAllTeamChatOverridesOnDisk(storageRoot, updatedAtMs = Date.now()) {
  const teamsDir = path.join(storageRoot, 'teams');
  let entries = [];
  try { entries = fs.readdirSync(teamsDir); } catch { return 0; }
  let count = 0;
  for (const tid of entries) {
    const existing = readTeamConcurrencyFile(storageRoot, tid);
    if (!existing || existing.maxActiveMembers === null) continue;
    try {
      writeTeamConcurrencyFile(storageRoot, tid, {
        maxActiveMembers: null,
        lastChatDirectiveIndex: existing.lastChatDirectiveIndex,
        source: 'cli-reset',
        updatedAtMs,
      });
      count += 1;
    } catch {}
  }
  return count;
}

export const ACTIVE_EXECUTION_STATUSES = new Set(['starting', 'started', 'running']);
const TERMINAL_SET = new Set(MEMBER_TERMINAL_STATUSES);

/**
 * Compute exact execution interval concurrency and pairwise millisecond overlap from persisted `members.jsonl` events. Pure.
 */
export function computeMemberConcurrencyTimeline(memberEvents, nowMs = Date.now()) {
  const byId = new Map();
  const intervals = [];
  for (const ev of memberEvents ?? []) {
    if (!ev || typeof ev !== 'object') continue;
    const key = typeof ev.childId === 'string' ? ev.childId : (typeof ev.id === 'string' ? ev.id : null);
    if (!key) continue;
    const atMs = Date.parse(ev.at ?? ev.createdAt ?? '') || 0;
    if (ev.type === 'member') {
      byId.set(key, {
        id: key,
        name: ev.name ?? key,
        profile: ev.profile ?? 'code',
        taskSeq: ev.taskSeq ?? 1,
        openStartMs: atMs > 0 ? atMs : null,
        status: ev.status ?? 'starting',
      });
    } else if (ev.type === 'member-status') {
      const rec = byId.get(key);
      if (!rec) continue;
      rec.status = ev.status;
      if (ACTIVE_EXECUTION_STATUSES.has(ev.status)) {
        if (rec.openStartMs === null && atMs > 0) rec.openStartMs = atMs;
      } else if (TERMINAL_SET.has(ev.status) && rec.openStartMs !== null) {
        const endMs = atMs > 0 ? Math.max(rec.openStartMs, atMs) : rec.openStartMs;
        intervals.push({
          id: rec.id,
          name: rec.name,
          profile: rec.profile,
          taskSeq: rec.taskSeq,
          startMs: rec.openStartMs,
          endMs,
          effectiveEndMs: endMs,
          status: ev.status,
        });
        rec.openStartMs = null;
      }
    }
  }
  for (const rec of byId.values()) {
    if (rec.openStartMs !== null) {
      intervals.push({
        id: rec.id,
        name: rec.name,
        profile: rec.profile,
        taskSeq: rec.taskSeq,
        startMs: rec.openStartMs,
        endMs: null,
        effectiveEndMs: Math.max(rec.openStartMs, nowMs),
        status: rec.status,
      });
    }
  }
  const points = [];
  for (const iv of intervals) {
    points.push({ t: iv.startMs, delta: 1 });
    points.push({ t: iv.effectiveEndMs, delta: -1 });
  }
  points.sort((a, b) => a.t - b.t || a.delta - b.delta); // process ends (-1) before starts (+1) at identical ms
  let cur = 0, peakConcurrent = 0;
  for (const pt of points) {
    cur += pt.delta;
    if (cur > peakConcurrent) peakConcurrent = cur;
  }
  const overlappingPairs = [];
  let maxPairwiseOverlapMs = 0;
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      const a = intervals[i], b = intervals[j];
      if (a.id === b.id) continue;
      const overlapMs = Math.min(a.effectiveEndMs, b.effectiveEndMs) - Math.max(a.startMs, b.startMs);
      if (overlapMs > 0) {
        overlappingPairs.push({ a: a.name, b: b.name, overlapMs });
        if (overlapMs > maxPairwiseOverlapMs) maxPairwiseOverlapMs = overlapMs;
      }
    }
  }
  return { peakConcurrent, maxPairwiseOverlapMs, overlappingPairs, intervals };
}

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  enabled: true,
  sampleIntervalMs: 2000,
  pollControlMs: 500,
  rampStepSize: 5,
  rampObserveMs: 1500,
  hysteresisCooldownMs: 4000,
  hysteresisRecoverSamples: 2,
  highCpuPct: 85,
  recoverCpuPct: 70,
  lowFreePhysMib: 384,
  recoverFreePhysMib: 576,
  criticalFreePhysMib: 224,
  lowFreeCommitMib: 1536,
  recoverFreeCommitMib: 2304,
  highCommitUsedPct: 92,
  recoverCommitUsedPct: 86,
  memberMemoryMib: Object.freeze({
    readonly: 64,
    code: 80,
    shell: 220,
  }),
  maxConcurrentShellMembers: 4,
  gateQueueHighWater: 4,
  gateQueueRecoverWater: 1,
  rateLimitWindowMs: 45000,
  maxAutoWakeupsPerTask: 16,
});

// Line-start directive in user-provenance messages, e.g. "最大并发 6", "最大子代理数: 3", "max concurrent = 10".
// Requiring line-start avoids false triggers on prose like "不要把最大并发设成 20".
const CONCURRENCY_DIRECTIVE_LINE = /^[ \t]*(?:最大并发(?:数)?|最大子代理(?:数)?|max[ _-]?concurrent(?:[ _-]?members)?)[ \t]*[:：=]?[ \t]*(\d{1,3})[ \t]*$/i;

const RATE_LIMIT_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT', 'TOO_MANY_REQUESTS', 'OVERLOADED', '429', '529']);

/** Parse user-provenance messages for live concurrency cap directives. Pure. */
export function parseConcurrencyDirectives(texts) {
  let latest = null;
  const arr = Array.isArray(texts) ? texts : [];
  for (let msgIndex = 0; msgIndex < arr.length; msgIndex++) {
    const lines = String(arr[msgIndex] ?? '').split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 200) continue;
      const m = CONCURRENCY_DIRECTIVE_LINE.exec(line);
      if (!m) continue;
      const n = Number.parseInt(m[1], 10);
      if (Number.isInteger(n) && n >= 1 && n <= 200) {
        latest = { maxActiveMembers: n, messageIndex: msgIndex };
      }
    }
  }
  return latest;
}

/**
 * True when a user message contains ONLY in-task runtime control lines (concurrency cap or read grants),
 * so sending a mid-task control command in chat does not start a new taskSeq and invalidate the active plan_id. Pure.
 */
export function isControlOnlyUserMessage(text, platform = process.platform) {
  if (typeof text !== 'string') return false;
  const nonEmpty = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;
  for (const line of nonEmpty) {
    if (CONCURRENCY_DIRECTIVE_LINE.test(line)) {
      const m = CONCURRENCY_DIRECTIVE_LINE.exec(line);
      const n = Number.parseInt(m[1], 10);
      if (n >= 1 && n <= 200) continue;
    }
    if (parseReadGrants([line], platform).length === 1) continue;
    return false;
  }
  return true;
}

let win32MemoryReader;
function getWin32MemoryReader() {
  if (win32MemoryReader !== undefined) return win32MemoryReader;
  if (process.platform !== 'win32') { win32MemoryReader = null; return null; }
  try {
    const appDir = path.dirname(process.execPath);
    const candidates = [
      path.join(appDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js'),
      path.join(appDir, 'resources', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js'),
    ];
    const anchor = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (!anchor) { win32MemoryReader = null; return null; }
    const req = createRequire(anchor);
    const koffi = req('koffi');
    const MEMORYSTATUSEX = koffi.struct('LEADERTEAM_MEMORYSTATUSEX', {
      dwLength: 'uint32',
      dwMemoryLoad: 'uint32',
      ullTotalPhys: 'uint64',
      ullAvailPhys: 'uint64',
      ullTotalPageFile: 'uint64',
      ullAvailPageFile: 'uint64',
      ullTotalVirtual: 'uint64',
      ullAvailVirtual: 'uint64',
      ullAvailExtendedVirtual: 'uint64',
    });
    const kernel32 = koffi.load('kernel32.dll');
    const GlobalMemoryStatusEx = kernel32.func('int __stdcall GlobalMemoryStatusEx(_Inout_ LEADERTEAM_MEMORYSTATUSEX *lpBuffer)');
    const size = koffi.sizeof(MEMORYSTATUSEX);
    win32MemoryReader = () => {
      const buf = { dwLength: size };
      if (!GlobalMemoryStatusEx(buf)) return null;
      const mib = v => Math.round(Number(v) / (1024 * 1024));
      const totalCommitMib = mib(buf.ullTotalPageFile);
      const availCommitMib = mib(buf.ullAvailPageFile);
      const commitUsedPct = totalCommitMib > 0 ? Math.round(((totalCommitMib - availCommitMib) / totalCommitMib) * 1000) / 10 : null;
      return {
        osMemoryLoadPct: Number(buf.dwMemoryLoad),
        totalPhysMib: mib(buf.ullTotalPhys),
        availPhysMib: mib(buf.ullAvailPhys),
        totalCommitMib,
        availCommitMib,
        commitUsedPct,
      };
    };
  } catch {
    win32MemoryReader = null;
  }
  return win32MemoryReader;
}

function readCpuTotals(cpus = os.cpus()) {
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    const t = cpu?.times;
    if (!t) continue;
    const sum = (t.user ?? 0) + (t.nice ?? 0) + (t.sys ?? 0) + (t.idle ?? 0) + (t.irq ?? 0);
    idle += t.idle ?? 0;
    total += sum;
  }
  return { count: Math.max(1, cpus?.length || 1), idle, total };
}

const CGROUP_UNLIMITED_SENTINEL = 1n << 52n; // 4 PiB: filters Linux PAGE_COUNTER_MAX (~9.22e18) sentinels

function readTextSafe(fsImpl, filePath) {
  try {
    return String(fsImpl.readFileSync(filePath, 'utf8')).trim();
  } catch {
    return null;
  }
}

function parseCgroupByteValue(raw, { allowUnlimited = true } = {}) {
  if (raw === null || raw === '') return null;
  const tok = raw.split(/\s+/)[0];
  if (!tok) return null;
  if (allowUnlimited && tok === 'max') return null;
  if (!/^-?\d+$/.test(tok)) return null;
  let big;
  try { big = BigInt(tok); } catch { return null; }
  if (big < 0n) return null;
  if (allowUnlimited && (big === 0n || big >= CGROUP_UNLIMITED_SENTINEL)) return null;
  return Number(big);
}

function readFirstAvailable(fsImpl, dirs, filename) {
  for (const dir of dirs) {
    if (!dir) continue;
    const val = readTextSafe(fsImpl, path.join(dir, filename));
    if (val !== null) return val;
  }
  return null;
}

function discoverSelfCgroupSubpaths(fsImpl) {
  const raw = readTextSafe(fsImpl, '/proc/self/cgroup');
  if (!raw) return { v2: null, v1Mem: null, v1Cpu: null };
  let v2 = null, v1Mem = null, v1Cpu = null;
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const controllers = parts[1];
    const rel = parts.slice(2).join(':').replace(/^\/+/, '');
    if (!rel) continue;
    if (parts[0] === '0' && controllers === '') {
      v2 = rel;
    } else {
      const list = controllers.split(',');
      if (list.includes('memory')) v1Mem = rel;
      if (list.includes('cpu')) v1Cpu = rel;
    }
  }
  return { v2, v1Mem, v1Cpu };
}

function buildCgroupAncestorChain(cgroupRoot, relSubpath) {
  const dirs = [];
  if (relSubpath) {
    const cleanRel = relSubpath.replace(/^\/+|\/+$/g, '');
    if (cleanRel) {
      const segs = cleanRel.split('/').filter(Boolean);
      for (let len = segs.length; len >= 1; len--) {
        dirs.push(path.join(cgroupRoot, ...segs.slice(0, len)));
      }
    }
  }
  dirs.push(cgroupRoot);
  return [...new Set(dirs)];
}

function readMinFiniteByteLimit(fsImpl, dirs, filenames) {
  let minBytes = null;
  let sawAnyFile = false;
  for (const dir of dirs) {
    if (!dir) continue;
    for (const filename of filenames) {
      const raw = readTextSafe(fsImpl, path.join(dir, filename));
      if (raw === null) continue;
      sawAnyFile = true;
      const parsed = parseCgroupByteValue(raw, { allowUnlimited: true });
      if (parsed !== null && (minBytes === null || parsed < minBytes)) {
        minBytes = parsed;
      }
    }
  }
  return { minBytes, sawAnyFile };
}

function readReclaimablePageCacheBytes(fsImpl, dirs, keyNames) {
  for (const dir of dirs) {
    if (!dir) continue;
    const raw = readTextSafe(fsImpl, path.join(dir, 'memory.stat'));
    if (!raw) continue;
    const map = new Map();
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_]+)\s+(\d+)/.exec(line.trim());
      if (m) map.set(m[1], Number(m[2]));
    }
    for (const k of keyNames) {
      const v = map.get(k);
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
  }
  return 0;
}

/**
 * Read Linux container limits supporting **cgroup v2** (`memory.max`, `memory.high`, `memory.current`,
 * `memory.stat`, `cpu.max` across full ancestor slice hierarchy) and **cgroup v1 fallback**
 * (`memory/memory.limit_in_bytes`, `memory/memory.usage_in_bytes`, `cpu/cpu.cfs_quota_us` + `cpu.cfs_period_us`),
 * including hybrid cgroup v1+v2 hosts. Zero subprocesses; never throws.
 */
export function readLinuxCgroupLimits(fsImpl = fs, cgroupRoot = '/sys/fs/cgroup') {
  const empty = {
    version: null,
    memoryLimitBytes: null,
    memoryUsageBytes: null,
    memoryLimitMib: null,
    memoryUsageMib: null,
    memoryRemainingMib: null,
    swapLimitMib: null,
    swapUsageMib: null,
    cpuQuotaCores: null,
  };
  if (!fsImpl || typeof cgroupRoot !== 'string' || !cgroupRoot) return empty;

  const selfPaths = cgroupRoot === '/sys/fs/cgroup'
    ? discoverSelfCgroupSubpaths(fsImpl)
    : { v2: null, v1Mem: null, v1Cpu: null };

  const v2Dirs = buildCgroupAncestorChain(cgroupRoot, selfPaths.v2);

  const v2MemMax = readMinFiniteByteLimit(fsImpl, v2Dirs, ['memory.max']);
  const v2MemHigh = v2MemMax.minBytes === null ? readMinFiniteByteLimit(fsImpl, v2Dirs, ['memory.high']) : { minBytes: null, sawAnyFile: false };
  const rawV2MemCur = readFirstAvailable(fsImpl, v2Dirs, 'memory.current');
  const rawV2Controllers = readTextSafe(fsImpl, path.join(cgroupRoot, 'cgroup.controllers'));

  let v2CpuQuotaCores = null;
  let sawV2CpuFile = false;
  for (const dir of v2Dirs) {
    const rawCpuMax = readTextSafe(fsImpl, path.join(dir, 'cpu.max'));
    if (rawCpuMax === null) continue;
    sawV2CpuFile = true;
    const [quotaTok, periodTok] = rawCpuMax.split(/\s+/);
    if (quotaTok && quotaTok !== 'max') {
      const quota = Number(quotaTok);
      const period = Number(periodTok || 100000);
      if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
        const cores = Math.round((quota / period) * 1000) / 1000;
        if (v2CpuQuotaCores === null || cores < v2CpuQuotaCores) v2CpuQuotaCores = cores;
      }
    }
  }

  const toMib = b => (b === null ? null : Math.max(0, Math.round(b / (1024 * 1024))));
  const hasAnyV2Signal = v2MemMax.sawAnyFile || v2MemHigh.sawAnyFile || rawV2MemCur !== null || sawV2CpuFile || rawV2Controllers !== null;

  // Also inspect cgroup v1 in case this is a pure v1 or hybrid v1+v2 host where limits live on v1 controllers
  const v1MemDirs = [
    ...buildCgroupAncestorChain(path.join(cgroupRoot, 'memory'), selfPaths.v1Mem),
    cgroupRoot,
  ];
  const v1CpuDirs = [
    ...buildCgroupAncestorChain(path.join(cgroupRoot, 'cpu'), selfPaths.v1Cpu),
    ...buildCgroupAncestorChain(path.join(cgroupRoot, 'cpu,cpuacct'), selfPaths.v1Cpu),
    cgroupRoot,
  ];

  const v1MemLim = readMinFiniteByteLimit(fsImpl, v1MemDirs, ['memory.limit_in_bytes']);
  const rawV1Use = readFirstAvailable(fsImpl, v1MemDirs, 'memory.usage_in_bytes');
  let v1CpuQuotaCores = null;
  let sawV1CpuFile = false;
  for (const dir of v1CpuDirs) {
    const rawQuota = readTextSafe(fsImpl, path.join(dir, 'cpu.cfs_quota_us'));
    if (rawQuota === null) continue;
    sawV1CpuFile = true;
    const quota = Number(rawQuota);
    const period = Number(readTextSafe(fsImpl, path.join(dir, 'cpu.cfs_period_us')) || 100000);
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      const cores = Math.round((quota / period) * 1000) / 1000;
      if (v1CpuQuotaCores === null || cores < v1CpuQuotaCores) v1CpuQuotaCores = cores;
    }
  }
  const hasAnyV1Signal = v1MemLim.sawAnyFile || rawV1Use !== null || sawV1CpuFile;

  if (hasAnyV2Signal && (v2MemMax.minBytes !== null || v2MemHigh.minBytes !== null || v2CpuQuotaCores !== null || (v1MemLim.minBytes === null && v1CpuQuotaCores === null))) {
    const memoryLimitBytes = v2MemMax.minBytes ?? v2MemHigh.minBytes ?? null;
    const rawMemoryUsageBytes = parseCgroupByteValue(rawV2MemCur, { allowUnlimited: false });
    const reclaimableCacheBytes = rawMemoryUsageBytes !== null
      ? readReclaimablePageCacheBytes(fsImpl, v2Dirs, ['inactive_file'])
      : 0;
    const memoryUsageBytes = rawMemoryUsageBytes !== null
      ? Math.max(0, rawMemoryUsageBytes - reclaimableCacheBytes)
      : null;

    let swapLimitBytes = null;
    for (const dir of v2Dirs) {
      const rawSwapMax = readTextSafe(fsImpl, path.join(dir, 'memory.swap.max'));
      if (rawSwapMax === null) continue;
      const parsed = rawSwapMax === '0' ? 0 : parseCgroupByteValue(rawSwapMax, { allowUnlimited: true });
      if (parsed !== null && (swapLimitBytes === null || parsed < swapLimitBytes)) swapLimitBytes = parsed;
    }
    const rawSwapCur = readFirstAvailable(fsImpl, v2Dirs, 'memory.swap.current');
    const swapUsageBytes = parseCgroupByteValue(rawSwapCur, { allowUnlimited: false });

    const memoryLimitMib = toMib(memoryLimitBytes);
    const memoryUsageMib = toMib(memoryUsageBytes);
    const memoryRemainingMib = memoryLimitBytes !== null
      ? Math.max(0, Math.round((memoryLimitBytes - (memoryUsageBytes ?? 0)) / (1024 * 1024)))
      : null;

    return {
      version: 2,
      memoryLimitBytes,
      memoryUsageBytes,
      memoryLimitMib,
      memoryUsageMib,
      memoryRemainingMib,
      swapLimitMib: toMib(swapLimitBytes),
      swapUsageMib: toMib(swapUsageBytes),
      cpuQuotaCores: v2CpuQuotaCores,
    };
  }

  if (!hasAnyV1Signal) {
    return empty;
  }

  const memoryLimitBytes = v1MemLim.minBytes;
  const rawMemoryUsageBytes = parseCgroupByteValue(rawV1Use, { allowUnlimited: false });
  const reclaimableV1CacheBytes = rawMemoryUsageBytes !== null
    ? readReclaimablePageCacheBytes(fsImpl, v1MemDirs, ['total_inactive_file', 'inactive_file'])
    : 0;
  const memoryUsageBytes = rawMemoryUsageBytes !== null
    ? Math.max(0, rawMemoryUsageBytes - reclaimableV1CacheBytes)
    : null;

  const memoryLimitMib = toMib(memoryLimitBytes);
  const memoryUsageMib = toMib(memoryUsageBytes);
  const memoryRemainingMib = memoryLimitBytes !== null
    ? Math.max(0, Math.round((memoryLimitBytes - (memoryUsageBytes ?? 0)) / (1024 * 1024)))
    : null;

  return {
    version: 1,
    memoryLimitBytes,
    memoryUsageBytes,
    memoryLimitMib,
    memoryUsageMib,
    memoryRemainingMib,
    swapLimitMib: null,
    swapUsageMib: null,
    cpuQuotaCores: v1CpuQuotaCores,
  };
}

/**
 * Parse Linux `/proc/meminfo` (`MemAvailable`, `MemTotal`, `CommitLimit`, `Committed_AS`, `SwapFree`).
 * Zero subprocesses; returns `null` when unavailable.
 */
export function readLinuxProcMeminfo(fsImpl = fs, meminfoPath = '/proc/meminfo') {
  if (!fsImpl || typeof meminfoPath !== 'string' || !meminfoPath) return null;
  const text = readTextSafe(fsImpl, meminfoPath);
  if (!text) return null;

  const kibMap = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_()]+):\s*(\d+)/.exec(line);
    if (!m) continue;
    const val = Number.parseInt(m[2], 10);
    if (Number.isFinite(val) && val >= 0) kibMap.set(m[1], val);
  }

  const memTotalKib = kibMap.get('MemTotal') ?? null;
  const memFreeKib = kibMap.get('MemFree') ?? null;
  const buffersKib = kibMap.get('Buffers') ?? 0;
  const cachedKib = kibMap.get('Cached') ?? 0;
  const memAvailableKib = kibMap.get('MemAvailable')
    ?? (memFreeKib !== null ? memFreeKib + buffersKib + cachedKib : null);
  const commitLimitKib = kibMap.get('CommitLimit') ?? null;
  const committedAsKib = kibMap.get('Committed_AS') ?? null;
  const swapTotalKib = kibMap.get('SwapTotal') ?? 0;
  const swapFreeKib = kibMap.get('SwapFree') ?? null;

  if (memTotalKib === null && memAvailableKib === null) return null;

  // On Linux, `/proc/meminfo` `CommitLimit` defaults to `SwapTotal + 50% * MemTotal` and is ONLY enforced when
  // `/proc/sys/vm/overcommit_memory === 2` (strict mode). Under default heuristic overcommit (`0`) or `1`,
  // virtual reservations (V8/Wasm/Electron pointer cages) routinely exceed `50% * MemTotal` even with abundant free RAM;
  // use `Math.max(CommitLimit, MemTotal + SwapTotal)` unless strict `overcommit_memory === 2` is active.
  const rawOvercommitMode = meminfoPath === '/proc/meminfo'
    ? readTextSafe(fsImpl, '/proc/sys/vm/overcommit_memory')
    : null;
  const strictOvercommit = rawOvercommitMode === '2';
  const backingTotalKib = memTotalKib !== null ? memTotalKib + swapTotalKib : null;
  const effectiveCommitTotalKib = strictOvercommit
    ? commitLimitKib
    : (commitLimitKib !== null && backingTotalKib !== null
      ? Math.max(commitLimitKib, backingTotalKib)
      : (commitLimitKib ?? backingTotalKib));

  const kibToMib = k => (k === null ? null : Math.round(k / 1024));
  const memTotalMib = kibToMib(memTotalKib);
  const memAvailableMib = kibToMib(memAvailableKib);
  const commitLimitMib = kibToMib(commitLimitKib);
  const committedAsMib = kibToMib(committedAsKib);
  const swapFreeMib = kibToMib(swapFreeKib);
  const totalCommitMib = kibToMib(effectiveCommitTotalKib);
  const availCommitKib = (effectiveCommitTotalKib !== null && committedAsKib !== null)
    ? Math.max(0, effectiveCommitTotalKib - committedAsKib)
    : (memAvailableKib !== null ? memAvailableKib + (swapFreeKib ?? 0) : null);
  const availCommitMib = kibToMib(availCommitKib);
  const commitUsedPct = (effectiveCommitTotalKib !== null && effectiveCommitTotalKib > 0 && availCommitKib !== null)
    ? Math.round(((effectiveCommitTotalKib - availCommitKib) / effectiveCommitTotalKib) * 1000) / 10
    : null;

  return {
    MemTotal: memTotalKib,
    MemAvailable: memAvailableKib,
    CommitLimit: commitLimitKib,
    Committed_AS: committedAsKib,
    SwapFree: swapFreeKib,
    memTotalMib,
    memAvailableMib,
    totalPhysMib: memTotalMib,
    availPhysMib: memAvailableMib,
    commitLimitMib,
    committedAsMib,
    swapFreeMib,
    totalCommitMib,
    availCommitMib,
    commitUsedPct,
  };
}

/**
 * Sample host + container device resources across Windows, Linux (including cgroup v2/v1 containers), and macOS.
 * On Linux, caps effective physical & commit headroom by cgroup limits so a 1GiB/2GiB container on a 64GiB host
 * never mistakes host RAM for container-available RAM.
 */
export function sampleDeviceResources(options = {}) {
  const ts = typeof options.nowMs === 'number' ? options.nowMs : (typeof options.now === 'function' ? options.now() : Date.now());
  const platform = options.platform ?? process.platform;
  const fsImpl = options.fs ?? fs;
  const osImpl = options.os ?? os;
  const mib = b => Math.round(b / (1024 * 1024));
  const hostRssMib = typeof options.hostRssMib === 'number' ? options.hostRssMib : mib(process.memoryUsage().rss);
  const hostLogicalCores = typeof options.logicalCores === 'number' && options.logicalCores >= 1
    ? options.logicalCores
    : Math.max(1, osImpl.cpus?.()?.length || 1);
  const cpuBusyPct = typeof options.cpuBusyPct === 'number' ? Math.max(0, Math.min(100, options.cpuBusyPct)) : 0;
  const cpuSmoothedPct = typeof options.cpuSmoothedPct === 'number'
    ? Math.max(0, Math.min(100, options.cpuSmoothedPct))
    : cpuBusyPct;

  const useLinux = platform === 'linux'
    || typeof options.linuxMeminfoReader === 'function'
    || typeof options.linuxCgroupReader === 'function'
    || options.cgroupRoot !== undefined
    || options.meminfoPath !== undefined;

  if (useLinux) {
    const meminfo = typeof options.linuxMeminfoReader === 'function'
      ? options.linuxMeminfoReader()
      : readLinuxProcMeminfo(fsImpl, options.meminfoPath ?? '/proc/meminfo');
    const cgroup = typeof options.linuxCgroupReader === 'function'
      ? options.linuxCgroupReader()
      : readLinuxCgroupLimits(fsImpl, options.cgroupRoot ?? '/sys/fs/cgroup');

    const hostTotalPhysMib = meminfo?.totalPhysMib ?? mib(osImpl.totalmem());
    const hostMemAvailableMib = meminfo?.availPhysMib ?? mib(osImpl.freemem());

    const hasCgroupMemLimit = typeof cgroup?.memoryLimitMib === 'number' && Number.isFinite(cgroup.memoryLimitMib) && cgroup.memoryLimitMib > 0;
    const cgroupRemainingMib = hasCgroupMemLimit
      ? (typeof cgroup.memoryRemainingMib === 'number' ? cgroup.memoryRemainingMib : Math.max(0, cgroup.memoryLimitMib - hostRssMib))
      : null;

    const totalPhysMib = hasCgroupMemLimit
      ? Math.min(hostTotalPhysMib, cgroup.memoryLimitMib)
      : hostTotalPhysMib;
    const availPhysMib = hasCgroupMemLimit
      ? Math.min(hostMemAvailableMib, cgroupRemainingMib)
      : hostMemAvailableMib;
    const physUsedPct = totalPhysMib > 0
      ? Math.round(((totalPhysMib - availPhysMib) / totalPhysMib) * 1000) / 10
      : 0;

    const hostTotalCommitMib = meminfo?.totalCommitMib ?? null;
    const hostAvailCommitMib = meminfo?.availCommitMib ?? null;

    let totalCommitMib = hostTotalCommitMib;
    let availCommitMib = hostAvailCommitMib;
    if (hasCgroupMemLimit) {
      const swapLim = typeof cgroup.swapLimitMib === 'number' ? cgroup.swapLimitMib : 0;
      const swapRem = typeof cgroup.swapLimitMib === 'number'
        ? Math.max(0, cgroup.swapLimitMib - (cgroup.swapUsageMib ?? 0))
        : 0;
      const cgroupCommitTotal = cgroup.memoryLimitMib + swapLim;
      const cgroupCommitAvail = cgroupRemainingMib + swapRem;
      totalCommitMib = hostTotalCommitMib !== null ? Math.min(hostTotalCommitMib, cgroupCommitTotal) : cgroupCommitTotal;
      availCommitMib = hostAvailCommitMib !== null ? Math.min(hostAvailCommitMib, cgroupCommitAvail) : cgroupCommitAvail;
    }

    const commitUsedPct = (totalCommitMib !== null && totalCommitMib > 0 && availCommitMib !== null)
      ? Math.round(((totalCommitMib - availCommitMib) / totalCommitMib) * 1000) / 10
      : (meminfo?.commitUsedPct ?? null);

    const cgroupCpuQuotaCores = typeof cgroup?.cpuQuotaCores === 'number' && cgroup.cpuQuotaCores > 0
      ? cgroup.cpuQuotaCores
      : null;
    const logicalCores = cgroupCpuQuotaCores !== null
      ? Math.max(1, Math.min(hostLogicalCores, Math.ceil(cgroupCpuQuotaCores)))
      : hostLogicalCores;

    return {
      sampledAtMs: ts,
      logicalCores,
      cgroupCpuQuotaCores,
      cpuBusyPct: Math.round(cpuBusyPct * 10) / 10,
      cpuSmoothedPct: Math.round(cpuSmoothedPct * 10) / 10,
      totalPhysMib,
      availPhysMib,
      physUsedPct,
      totalCommitMib,
      availCommitMib,
      commitUsedPct,
      hostRssMib,
      cgroupVersion: cgroup?.version ?? null,
      cgroupMemoryLimitMib: hasCgroupMemLimit ? cgroup.memoryLimitMib : null,
      cgroupMemoryRemainingMib: cgroupRemainingMib,
    };
  }

  const winMem = (typeof options.win32MemReader === 'function' ? options.win32MemReader() : getWin32MemoryReader()?.()) ?? null;
  const totalPhysMib = winMem?.totalPhysMib ?? mib(osImpl.totalmem());
  const availPhysMib = winMem?.availPhysMib ?? mib(osImpl.freemem());
  const physUsedPct = winMem?.osMemoryLoadPct
    ?? (totalPhysMib > 0 ? Math.round(((totalPhysMib - availPhysMib) / totalPhysMib) * 1000) / 10 : 0);

  return {
    sampledAtMs: ts,
    logicalCores: hostLogicalCores,
    cpuBusyPct: Math.round(cpuBusyPct * 10) / 10,
    cpuSmoothedPct: Math.round(cpuSmoothedPct * 10) / 10,
    totalPhysMib,
    availPhysMib,
    physUsedPct,
    totalCommitMib: winMem?.totalCommitMib ?? null,
    availCommitMib: winMem?.availCommitMib ?? null,
    commitUsedPct: winMem?.commitUsedPct ?? null,
    hostRssMib,
  };
}

/**
 * Zero-subprocess local hardware sampler. Uses libuv os.cpus() tick deltas, os.freemem()/totalmem(),
 * process RSS, Linux `/proc/meminfo` + cgroup v2/v1, and Win32 GlobalMemoryStatusEx when inside Official DSH.
 * Accepts an optional `probe()` override for deterministic tests.
 */
export function createDeviceSampler(options = {}) {
  const now = options.now ?? (() => Date.now());
  if (typeof options.probe === 'function') {
    let smoothed = null;
    return {
      sample() {
        const raw = options.probe();
        const busy = typeof raw.cpuBusyPct === 'number' ? Math.max(0, Math.min(100, raw.cpuBusyPct)) : 0;
        smoothed = smoothed === null ? busy : Math.round((smoothed * 0.5 + busy * 0.5) * 10) / 10;
        const totalPhysMib = raw.totalPhysMib ?? 16384;
        const availPhysMib = raw.availPhysMib ?? 4096;
        const totalCommitMib = raw.totalCommitMib ?? null;
        const availCommitMib = raw.availCommitMib ?? null;
        const commitUsedPct = raw.commitUsedPct ?? (totalCommitMib && availCommitMib !== null
          ? Math.round(((totalCommitMib - availCommitMib) / totalCommitMib) * 1000) / 10
          : null);
        return {
          sampledAtMs: now(),
          logicalCores: raw.logicalCores ?? 8,
          ...(raw.cgroupCpuQuotaCores != null ? { cgroupCpuQuotaCores: raw.cgroupCpuQuotaCores } : {}),
          cpuBusyPct: Math.round(busy * 10) / 10,
          cpuSmoothedPct: raw.cpuSmoothedPct ?? smoothed,
          totalPhysMib,
          availPhysMib,
          physUsedPct: totalPhysMib > 0 ? Math.round(((totalPhysMib - availPhysMib) / totalPhysMib) * 1000) / 10 : 0,
          totalCommitMib,
          availCommitMib,
          commitUsedPct,
          hostRssMib: raw.hostRssMib ?? 200,
        };
      },
    };
  }

  let prevCpu = readCpuTotals();
  let prevSampleMs = now();
  let lastBusyPct = 0;
  let smoothedBusyPct = null;

  return {
    sample() {
      const ts = now();
      const curCpu = readCpuTotals();
      const deltaTotal = curCpu.total - prevCpu.total;
      const deltaIdle = curCpu.idle - prevCpu.idle;
      if (deltaTotal > 0 && ts - prevSampleMs >= 25) {
        const busy = Math.max(0, Math.min(100, (1 - deltaIdle / deltaTotal) * 100));
        lastBusyPct = Math.round(busy * 10) / 10;
        smoothedBusyPct = smoothedBusyPct === null
          ? lastBusyPct
          : Math.round((smoothedBusyPct * 0.5 + lastBusyPct * 0.5) * 10) / 10;
        prevCpu = curCpu;
        prevSampleMs = ts;
      } else if (smoothedBusyPct === null) {
        smoothedBusyPct = 0;
      }

      return sampleDeviceResources({
        ...options,
        nowMs: ts,
        logicalCores: curCpu.count,
        cpuBusyPct: lastBusyPct,
        cpuSmoothedPct: smoothedBusyPct,
      });
    },
  };
}

export function isRateLimitError(codeOrMessage) {
  const s = String(codeOrMessage ?? '').toUpperCase();
  for (const code of RATE_LIMIT_CODES) if (s.includes(code)) return true;
  return /RATE[ _-]?LIMIT|TOO MANY REQUESTS|HTTP 429|\b429\b/.test(s);
}

/**
 * Stateful elastic concurrency scheduler combining:
 *  1. userMaxConcurrent (hard ceiling, live-updatable via file/CLI/local-config/chat)
 *  2. deviceCapacity    (hard ceiling, hardware + remote-LLM pipeline + hysteresis anti-oscillation)
 *  3. leaderMaxParallel (soft downward refinement + task decomposition preference)
 *  4. progressive ramp-up waves (rampStepSize per observation window)
 */
export class ElasticConcurrencyScheduler {
  constructor(config, options = {}) {
    this.cfg = {
      ...DEFAULT_SCHEDULER_CONFIG,
      ...(config?.scheduler ?? {}),
      memberMemoryMib: {
        ...DEFAULT_SCHEDULER_CONFIG.memberMemoryMib,
        ...(config?.scheduler?.memberMemoryMib ?? {}),
      },
    };
    this.now = options.now ?? (() => Date.now());
    this.sampler = options.sampler ?? createDeviceSampler({ ...options, now: this.now, probe: options.deviceProbe });

    this.baseUserMax = clampCap(config?.team?.maxActiveMembers ?? 8);
    this.userOverride = null; // global override: { maxActiveMembers, source, updatedAtMs }
    this.lastGlobalResetMs = 0;
    this.requestWindowMaxCap = normalizeOptionalRequestWindowCap(options.requestWindowMaxCap);

    // Pipeline bottleneck counters (shared across process)
    this.inFlightShellCalls = 0;
    this.inFlightGateReviews = 0;
    this.rateLimitEvents = [];   // timestamps (ms)
    this.transientErrorEvents = []; // timestamps (ms)
    this.completionEvents = [];  // timestamps (ms)

    // Synchronous in-flight dispatch slot reservations (closes async TOCTOU window in team_dispatch)
    this.reservedDispatches = new Map(); // id -> { id, name, teamId, taskSeq, profile, reservedAtMs }

    // Hysteresis state machine
    this.hysteresis = {
      mode: 'normal',       // 'normal' | 'throttled'
      reasons: [],
      throttledAtMs: 0,
      throttledCap: 200,
      cleanSamples: 0,
      lastSampleEvaluatedAtMs: 0,
    };

    // Per-team / per-task soft preference, progressive wave & wakeup tracking
    this.teams = new Map(); // teamId -> teamState
    this.lastDevice = this.sampler.sample();
  }

  teamState(teamId, taskSeq = 1) {
    let st = this.teams.get(teamId);
    if (!st) {
      st = {
        teamId,
        taskSeq,
        leaderTurnSeq: 1,
        leaderMaxParallel: null,
        pendingParallelTasks: 0,
        pendingSetAtTurn: -1,
        pendingFloorInSetTurn: 0,
        dispatchesSincePendingSet: 0,
        waveFilledSincePendingSet: false,
        awaitingSlots: false,
        hadCappedTurn: false,
        pendingUserScaleUp: false,
        waveStartMs: 0,
        waveDispatched: 0,
        lastObservedEffectiveCap: this.currentUserMax(),
        lastNotifiedKey: '',
        autoWakeups: 0,
        chatOverride: null, // per-session chat override: { maxActiveMembers, updatedAtMs }
        chatLoadedFromDisk: false,
        lastChatDirectiveIndex: -1,
      };
      this.teams.set(teamId, st);
    } else if (st.taskSeq !== taskSeq) {
      st.taskSeq = taskSeq;
      st.leaderTurnSeq = 1;
      st.leaderMaxParallel = null;
      st.pendingParallelTasks = 0;
      st.pendingSetAtTurn = -1;
      st.pendingFloorInSetTurn = 0;
      st.dispatchesSincePendingSet = 0;
      st.waveFilledSincePendingSet = false;
      st.awaitingSlots = false;
      st.hadCappedTurn = false;
      st.pendingUserScaleUp = false;
      st.waveStartMs = 0;
      st.waveDispatched = 0;
      st.lastNotifiedKey = '';
      st.autoWakeups = 0;
    }
    return st;
  }

  /** Hydrate a session's persisted per-team chat override and directive cursor once on cold start/resume. */
  loadTeamChatState(teamId, persisted) {
    const st = this.teams.get(teamId) ?? this.teamState(teamId, 1);
    if (st.chatLoadedFromDisk) return st;
    st.chatLoadedFromDisk = true;
    if (!persisted || typeof persisted !== 'object') return st;
    if (Number.isInteger(persisted.lastChatDirectiveIndex) && persisted.lastChatDirectiveIndex > st.lastChatDirectiveIndex) {
      st.lastChatDirectiveIndex = persisted.lastChatDirectiveIndex;
    }
    if (Number.isInteger(persisted.maxActiveMembers) && persisted.maxActiveMembers >= 1 && persisted.maxActiveMembers <= 200) {
      st.chatOverride = {
        maxActiveMembers: persisted.maxActiveMembers,
        updatedAtMs: typeof persisted.updatedAtMs === 'number' ? persisted.updatedAtMs : 0,
      };
    }
    return st;
  }

  currentUserMax() {
    return this.userOverride ? this.userOverride.maxActiveMembers : this.baseUserMax;
  }

  userMaxSource() {
    return this.userOverride ? this.userOverride.source : 'config';
  }

  /** Effective user cap & source for a specific team (session chat override vs global CLI override vs config). */
  currentUserMaxForTeam(teamId) {
    const st = teamId ? this.teams.get(teamId) : null;
    const chat = (st?.chatOverride && st.chatOverride.updatedAtMs > this.lastGlobalResetMs) ? st.chatOverride : null;
    if (chat && this.userOverride) {
      return chat.updatedAtMs >= this.userOverride.updatedAtMs
        ? { max: chat.maxActiveMembers, source: 'chat' }
        : { max: this.userOverride.maxActiveMembers, source: this.userOverride.source };
    }
    if (chat) return { max: chat.maxActiveMembers, source: 'chat' };
    if (this.userOverride) return { max: this.userOverride.maxActiveMembers, source: this.userOverride.source };
    return { max: this.baseUserMax, source: 'config' };
  }

  /** Global environment pool cap across all concurrent teams in this process. */
  currentGlobalPoolMax() {
    let poolMax = this.userOverride ? this.userOverride.maxActiveMembers : this.baseUserMax;
    const globalFloorTs = Math.max(this.userOverride?.updatedAtMs ?? 0, this.lastGlobalResetMs);
    for (const st of this.teams.values()) {
      if (st.chatOverride && st.chatOverride.updatedAtMs > globalFloorTs && st.chatOverride.maxActiveMembers > poolMax) {
        poolMax = st.chatOverride.maxActiveMembers;
      }
    }
    return poolMax;
  }

  /** Update base default from reloaded config/leaderteam.local.json. */
  setBaseUserMax(maxActiveMembers) {
    const next = clampCap(maxActiveMembers);
    if (next === this.baseUserMax) return false;
    const prev = this.baseUserMax;
    this.baseUserMax = next;
    if (this.userOverride === null && next > prev) this.#markPendingUserScaleUp();
    return this.userOverride === null;
  }

  /** Apply or clear a live GLOBAL user override (CLI / <storageRoot>/concurrency.json). Returns { changed, prev, next }. */
  setUserOverride(maxActiveMembers, source = 'runtime', updatedAtMs = this.now()) {
    const prev = this.currentUserMax();
    if (maxActiveMembers === null || maxActiveMembers === undefined) {
      const hadAnyChat = [...this.teams.values()].some(st => st.chatOverride && st.chatOverride.updatedAtMs <= updatedAtMs);
      this.userOverride = null;
      if (updatedAtMs > this.lastGlobalResetMs) this.lastGlobalResetMs = updatedAtMs;
      const next = this.currentUserMax();
      if (next > prev || hadAnyChat) this.#markPendingUserScaleUp();
      return { changed: prev !== next || hadAnyChat, prev, next };
    }
    const clamped = clampCap(maxActiveMembers);
    if (this.userOverride && updatedAtMs < this.userOverride.updatedAtMs) {
      return { changed: false, prev, next: prev };
    }
    this.userOverride = { maxActiveMembers: clamped, source, updatedAtMs };
    const next = this.currentUserMax();
    if (next > prev) this.#markPendingUserScaleUp();
    return { changed: prev !== next, prev, next };
  }

  /** Clear global `concurrency.json` override when that file is absent/deleted, WITHOUT wiping session-level chat overrides. */
  clearGlobalUserOverride() {
    if (!this.userOverride) return { changed: false, prev: this.baseUserMax, next: this.baseUserMax };
    const prev = this.currentUserMax();
    this.userOverride = null;
    const next = this.currentUserMax();
    if (next > prev) this.#markPendingUserScaleUp();
    return { changed: prev !== next, prev, next };
  }

  /** Apply a session-scoped chat concurrency override without polluting other sessions or global concurrency.json. */
  setTeamChatOverride(teamId, maxActiveMembers, updatedAtMs = this.now()) {
    const st = this.teams.get(teamId) ?? this.teamState(teamId, 1);
    const prev = this.currentUserMaxForTeam(teamId).max;
    if (maxActiveMembers === null || maxActiveMembers === undefined) {
      st.chatOverride = null;
    } else {
      st.chatOverride = { maxActiveMembers: clampCap(maxActiveMembers), updatedAtMs };
    }
    const next = this.currentUserMaxForTeam(teamId).max;
    if (next > prev) this.markPendingUserScaleUpForTeam(teamId);
    return { changed: prev !== next, prev, next };
  }

  #markPendingUserScaleUp() {
    for (const st of this.teams.values()) {
      if (st.pendingParallelTasks > 0 || st.awaitingSlots || st.hadCappedTurn) {
        st.pendingUserScaleUp = true;
      }
    }
  }

  markPendingUserScaleUpForTeam(teamId) {
    const st = this.teams.get(teamId);
    if (st && (st.pendingParallelTasks > 0 || st.awaitingSlots || st.hadCappedTurn)) {
      st.pendingUserScaleUp = true;
    }
  }

  /** Sync user chat directives for a single team; updates ONLY that team's session override. */
  syncChatDirectives(teamId, userTexts, onUserCapChanged) {
    const parsed = parseConcurrencyDirectives(userTexts);
    if (!parsed) return null;
    const st = this.teams.get(teamId) ?? this.teamState(teamId, 1);
    if (parsed.messageIndex <= st.lastChatDirectiveIndex) return null;
    const ts = this.now();
    st.lastChatDirectiveIndex = parsed.messageIndex;
    const res = this.setTeamChatOverride(teamId, parsed.maxActiveMembers, ts);
    if (onUserCapChanged) onUserCapChanged(parsed.maxActiveMembers, res, parsed.messageIndex, ts);
    return res;
  }

  setLeaderPreference(teamId, taskSeq, { leaderMaxParallel, pendingParallelTasks, currentAvailableNow } = {}) {
    const st = this.teamState(teamId, taskSeq);
    if (leaderMaxParallel !== undefined) {
      st.leaderMaxParallel = (leaderMaxParallel === null || leaderMaxParallel === 0)
        ? null
        : clampCap(leaderMaxParallel);
    }
    if (pendingParallelTasks !== undefined) {
      const n = Math.max(0, Math.min(200, Math.trunc(Number(pendingParallelTasks) || 0)));
      st.pendingParallelTasks = n;
      st.awaitingSlots = n > 0;
      st.pendingSetAtTurn = n > 0 ? st.leaderTurnSeq : -1;
      st.dispatchesSincePendingSet = 0;
      st.waveFilledSincePendingSet = false;
      if (n > 0) {
        const avail = typeof currentAvailableNow === 'number' ? Math.max(0, currentAvailableNow) : n;
        // Whether the leader passed total remaining tasks (n > avail) or held-back tasks for later waves (n <= avail),
        // dispatches in THIS same turn never drop pendingParallelTasks below the held-back floor (>= 1).
        st.pendingFloorInSetTurn = n > avail ? (n - avail) : n;
      } else {
        st.pendingFloorInSetTurn = 0;
      }
    }
    return st;
  }

  /** Advance leader turn boundary so followup waves decrement pendingParallelTasks cleanly. */
  advanceLeaderTurn(teamId, taskSeq, endSnapshot = null) {
    const st = this.teams.get(teamId);
    if (!st || st.taskSeq !== taskSeq) return;
    if (
      st.pendingParallelTasks > 0 &&
      st.leaderTurnSeq === st.pendingSetAtTurn &&
      st.dispatchesSincePendingSet > 0 &&
      !st.waveFilledSincePendingSet &&
      endSnapshot &&
      endSnapshot.controls.ramp_available_now > 0 &&
      endSnapshot.active_execution_members.total < endSnapshot.controls.effective_cap
    ) {
      // Leader set a total count before dispatching, did not hit any cap, and ended voluntarily with open slots
      st.pendingParallelTasks = Math.max(0, st.pendingParallelTasks - st.dispatchesSincePendingSet);
      st.awaitingSlots = st.pendingParallelTasks > 0;
    }
    st.leaderTurnSeq += 1;
  }

  markAwaitingSlots(teamId, taskSeq) {
    const st = this.teamState(teamId, taskSeq);
    st.awaitingSlots = true;
    st.hadCappedTurn = true;
  }

  #incrementWave(teamId, taskSeq) {
    const st = this.teamState(teamId, taskSeq);
    const ts = this.now();
    const prevWaveStartMs = st.waveStartMs;
    const prevWaveDispatched = st.waveDispatched;
    if (st.waveStartMs === 0 || (ts - st.waveStartMs >= this.cfg.rampObserveMs && this.hysteresis.mode === 'normal')) {
      st.waveStartMs = ts;
      st.waveDispatched = 0;
    }
    st.waveDispatched += 1;
    return { prevWaveStartMs, prevWaveDispatched };
  }

  #applyPendingAfterDispatch(teamId, taskSeq, postSnapshot = null) {
    const st = this.teamState(teamId, taskSeq);
    st.dispatchesSincePendingSet += 1;
    if (postSnapshot && (postSnapshot.active_execution_members.total >= postSnapshot.controls.effective_cap || postSnapshot.controls.ramp_available_now <= 0)) {
      st.waveFilledSincePendingSet = true;
    }
    if (st.pendingParallelTasks > 0) {
      if (st.leaderTurnSeq === st.pendingSetAtTurn) {
        if (st.pendingParallelTasks > st.pendingFloorInSetTurn) {
          st.pendingParallelTasks -= 1;
        }
      } else {
        st.pendingParallelTasks = Math.max(0, st.pendingParallelTasks - 1);
        if (st.pendingParallelTasks === 0) st.awaitingSlots = false;
      }
    }
  }

  recordDispatchAccepted(teamId, taskSeq, postSnapshot = null) {
    this.#incrementWave(teamId, taskSeq);
    this.#applyPendingAfterDispatch(teamId, taskSeq, postSnapshot);
  }

  /** In-flight reservations for `teamId` and `taskSeq` (used to guard duplicate names and maxMembersPerTeam). */
  reservedForTeamTask(teamId, taskSeq) {
    const list = [];
    for (const r of this.reservedDispatches.values()) {
      if (r.teamId === teamId && (taskSeq === undefined || r.taskSeq === taskSeq)) list.push(r);
    }
    return list;
  }

  /** Set or clear process-level 5h request-window cap on new execution dispatches (`null` clears). */
  setRequestWindowMaxCap(cap) {
    this.requestWindowMaxCap = normalizeOptionalRequestWindowCap(cap);
    return this.requestWindowMaxCap;
  }

  /**
   * Synchronously check and reserve an execution dispatch slot before any `await` in `team_dispatch`.
   * Call `commit(postSnapshot)` once activation succeeds, or `cancel()` if validation/activation fails.
   */
  reserveDispatch({ id = randomUUID(), name = '(starting)', teamId, taskSeq, activeMembers = [], otherActiveMembers = [], profile, requestWindowMaxCap }) {
    const check = this.checkDispatch({ teamId, taskSeq, activeMembers, otherActiveMembers, profile, requestWindowMaxCap });
    if (!check.allowed) return check;
    const waveUndo = this.#incrementWave(teamId, taskSeq);
    const entry = { id, name, teamId, taskSeq, profile, status: 'starting', reservedAtMs: this.now() };
    this.reservedDispatches.set(id, entry);
    let settled = false;
    return {
      allowed: true,
      id,
      snapshot: check.snapshot,
      commit: (postSnapshot = null) => {
        if (settled) return;
        settled = true;
        this.reservedDispatches.delete(id);
        const snap = postSnapshot ?? this.evaluate({
          teamId,
          taskSeq,
          activeMembers: [...activeMembers, { id, name, profile, status: 'started' }],
          otherActiveMembers,
          requestWindowMaxCap,
        });
        this.#applyPendingAfterDispatch(teamId, taskSeq, snap);
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        this.reservedDispatches.delete(id);
        const st = this.teams.get(teamId);
        if (st && st.taskSeq === taskSeq) {
          if (st.waveDispatched > 0) st.waveDispatched -= 1;
          if (st.waveDispatched === 0) st.waveStartMs = 0;
        }
      },
    };
  }

  recordMemberFinished(_teamId, _taskSeq) {
    const ts = this.now();
    this.completionEvents.push(ts);
    this.#pruneEvents(ts);
  }

  beginShellCall() { this.inFlightShellCalls += 1; }
  endShellCall() { this.inFlightShellCalls = Math.max(0, this.inFlightShellCalls - 1); }
  beginGateReview() { this.inFlightGateReviews += 1; }
  endGateReview() { this.inFlightGateReviews = Math.max(0, this.inFlightGateReviews - 1); }

  recordLlmOutcome({ ok, code, message, retryable } = {}) {
    if (ok) return;
    const ts = this.now();
    this.#pruneEvents(ts);
    if (isRateLimitError(code) || isRateLimitError(message)) {
      this.rateLimitEvents.push(ts);
    } else if (retryable || String(code ?? '').toUpperCase() === 'TIMEOUT') {
      this.transientErrorEvents.push(ts);
    }
  }

  #pruneEvents(ts) {
    const cutoff = ts - this.cfg.rateLimitWindowMs;
    while (this.rateLimitEvents.length && this.rateLimitEvents[0] < cutoff) this.rateLimitEvents.shift();
    while (this.transientErrorEvents.length && this.transientErrorEvents[0] < cutoff) this.transientErrorEvents.shift();
    while (this.completionEvents.length && this.completionEvents[0] < cutoff) this.completionEvents.shift();
  }

  #mergeActiveWithReservations(teamId, activeMembers = [], otherActiveMembers = []) {
    const seenTeam = new Set();
    const teamExec = [];
    for (const m of activeMembers) {
      if (!m || !ACTIVE_EXECUTION_STATUSES.has(m.status)) continue;
      const key = m.id ?? m.childId ?? null;
      if (key) {
        if (seenTeam.has(key)) continue;
        seenTeam.add(key);
      }
      teamExec.push(m);
    }
    const seenOther = new Set();
    const otherExec = [];
    for (const m of otherActiveMembers) {
      if (!m || !ACTIVE_EXECUTION_STATUSES.has(m.status)) continue;
      const key = m.id ?? m.childId ?? null;
      if (key) {
        if (seenTeam.has(key) || seenOther.has(key)) continue;
        seenOther.add(key);
      }
      otherExec.push(m);
    }
    for (const r of this.reservedDispatches.values()) {
      if (r.teamId === teamId) {
        if (!seenTeam.has(r.id)) {
          seenTeam.add(r.id);
          teamExec.push(r);
        }
      } else if (!seenTeam.has(r.id) && !seenOther.has(r.id)) {
        seenOther.add(r.id);
        otherExec.push(r);
      }
    }
    return { teamExec, otherExec };
  }

  /**
   * Sample device + pipeline state across ALL active teams, advance hysteresis & progressive ramp windows,
   * and return the concurrency evaluation for `teamId`.
   */
  evaluate({ teamId = 'default', taskSeq = 1, activeMembers = [], otherActiveMembers = [], targetProfile = null, advanceSample = false, requestWindowMaxCap } = {}) {
    const ts = this.now();
    this.#pruneEvents(ts);
    const dev = this.sampler.sample();
    this.lastDevice = dev;

    const st = this.teamState(teamId, taskSeq);
    const { teamExec: execActive, otherExec } = this.#mergeActiveWithReservations(teamId, activeMembers, otherActiveMembers);
    const activeCount = execActive.length;
    const otherActiveCount = otherExec.length;
    const globalActiveCount = activeCount + otherActiveCount;

    const byProfile = { readonly: 0, code: 0, shell: 0 };
    const globalByProfile = { readonly: 0, code: 0, shell: 0 };
    for (const m of execActive) {
      if (m.profile in byProfile) byProfile[m.profile] += 1;
      if (m.profile in globalByProfile) globalByProfile[m.profile] += 1;
    }
    for (const m of otherExec) {
      if (m.profile in globalByProfile) globalByProfile[m.profile] += 1;
    }

    const { max: userMax, source: userMaxSource } = this.currentUserMaxForTeam(teamId);
    const globalPoolMax = this.currentGlobalPoolMax();
    const rwCap = requestWindowMaxCap !== undefined
      ? normalizeOptionalRequestWindowCap(requestWindowMaxCap)
      : this.requestWindowMaxCap;

    if (!this.cfg.enabled) {
      const envShareCap = Math.max(0, globalPoolMax - otherActiveCount);
      let hardCap = Math.min(userMax, envShareCap);
      const preWindowHardCap = hardCap;
      if (rwCap !== null) hardCap = Math.min(hardCap, rwCap);
      const effectiveCap = st.leaderMaxParallel !== null ? Math.min(hardCap, st.leaderMaxParallel) : hardCap;
      const availableNow = Math.max(0, effectiveCap - activeCount);
      const disabledBottlenecks = rwCap !== null && (rwCap < preWindowHardCap || activeCount >= rwCap) ? ['request_window_cap'] : [];
      return this.#buildSnapshot({ ts, dev, execActive, activeCount, globalActiveCount, byProfile, userMax, userMaxSource, globalPoolMax, deviceCapacity: 200, hardCap, effectiveCap, availableNow, rampRemaining: 200, pressure: 'ok', bottlenecks: disabledBottlenecks, shellCapped: false, st, requestWindowMaxCap: rwCap });
    }

    // 1. Hardware carrying capacity (computed over globalActiveCount so multi-session never double-counts headroom)
    const cpuPct = dev.cpuSmoothedPct ?? dev.cpuBusyPct ?? 0;
    const profileMemCost = targetProfile && this.cfg.memberMemoryMib[targetProfile]
      ? this.cfg.memberMemoryMib[targetProfile]
      : Math.round((this.cfg.memberMemoryMib.code + this.cfg.memberMemoryMib.readonly) / 2);

    // Scale commit watermarks proportionally when running inside a small cgroup container (totalCommitMib <= recoverFreeCommitMib)
    const smallCommitContainer = dev.totalCommitMib !== null && dev.totalCommitMib <= this.cfg.recoverFreeCommitMib;
    const effLowFreeCommitMib = smallCommitContainer
      ? Math.min(this.cfg.lowFreeCommitMib, Math.max(128, Math.round(dev.totalCommitMib * (1 - this.cfg.highCommitUsedPct / 100))))
      : this.cfg.lowFreeCommitMib;
    const effRecoverFreeCommitMib = smallCommitContainer
      ? Math.min(this.cfg.recoverFreeCommitMib, Math.max(effLowFreeCommitMib + 64, Math.round(dev.totalCommitMib * (1 - this.cfg.recoverCommitUsedPct / 100))))
      : this.cfg.recoverFreeCommitMib;

    const physHeadroomMib = Math.max(0, dev.availPhysMib - this.cfg.lowFreePhysMib);
    let additionalMemSlots = Math.floor(physHeadroomMib / Math.max(16, profileMemCost));
    if (dev.availCommitMib !== null) {
      const commitHeadroomMib = Math.max(0, dev.availCommitMib - effLowFreeCommitMib);
      const commitSlots = dev.commitUsedPct !== null && dev.commitUsedPct >= this.cfg.highCommitUsedPct
        ? 0
        : Math.floor(commitHeadroomMib / Math.max(32, profileMemCost * 2));
      additionalMemSlots = Math.min(additionalMemSlots, commitSlots);
    }

    const perMemberCpuEst = targetProfile === 'shell' ? 16 : 5;
    const cpuHeadroomPct = Math.max(0, this.cfg.highCpuPct - cpuPct);
    const coreScale = dev.cgroupCpuQuotaCores != null
      ? Math.max(0.25, dev.cgroupCpuQuotaCores / 8)
      : Math.max(1, dev.logicalCores / 8);
    const additionalCpuSlots = cpuPct >= this.cfg.highCpuPct
      ? 0
      : Math.floor((cpuHeadroomPct * coreScale) / perMemberCpuEst);

    const rawHardwareCap = Math.max(1, Math.min(200, globalActiveCount + Math.min(additionalMemSlots, additionalCpuSlots)));

    // 2. Remote-model & approval pipeline bottlenecks (computed over globalActiveCount & globalByProfile)
    const rateLimits = this.rateLimitEvents.length;
    const transientErrors = this.transientErrorEvents.length;
    let pipelineCap = 200;
    const bottlenecks = [];
    if (rateLimits > 0) {
      pipelineCap = Math.min(pipelineCap, Math.max(1, globalActiveCount - 1));
      bottlenecks.push('model_rate_limit');
    } else if (transientErrors >= 3) {
      pipelineCap = Math.min(pipelineCap, Math.max(1, globalActiveCount));
      bottlenecks.push('model_transient_errors');
    }
    if (this.inFlightGateReviews >= this.cfg.gateQueueHighWater) {
      pipelineCap = Math.min(pipelineCap, Math.max(1, globalActiveCount));
      bottlenecks.push('gate_review_backlog');
    }
    const shellCapped = targetProfile === 'shell' && (
      globalByProfile.shell >= this.cfg.maxConcurrentShellMembers ||
      this.inFlightShellCalls >= this.cfg.maxConcurrentShellMembers
    );
    if (shellCapped) {
      pipelineCap = Math.min(pipelineCap, globalActiveCount);
      bottlenecks.push('shell_concurrency_limit');
    }

    // 3. Hysteresis (anti-oscillation between high-water trip and low-water recovery)
    const tripReasons = [];
    if (cpuPct >= this.cfg.highCpuPct) tripReasons.push('cpu_high');
    if (dev.availPhysMib <= this.cfg.lowFreePhysMib) tripReasons.push('phys_mem_low');
    if (dev.availCommitMib !== null && (dev.availCommitMib <= effLowFreeCommitMib || (dev.commitUsedPct ?? 0) >= this.cfg.highCommitUsedPct)) {
      tripReasons.push('commit_mem_high');
    }
    if (rateLimits > 0) tripReasons.push('model_rate_limit');
    if (this.inFlightGateReviews >= this.cfg.gateQueueHighWater) tripReasons.push('gate_review_backlog');

    for (const r of tripReasons) if (!bottlenecks.includes(r)) bottlenecks.push(r);

    if (tripReasons.length > 0) {
      const severeDrop = rateLimits > 0 || dev.availPhysMib <= this.cfg.criticalFreePhysMib;
      const clampTarget = severeDrop ? Math.max(1, globalActiveCount - (rateLimits > 0 ? 1 : 0)) : Math.max(1, globalActiveCount);
      // When critical physical RAM is exhausted while >=1 member is already running, block any additional member
      const critTarget = (dev.availPhysMib <= this.cfg.criticalFreePhysMib && globalActiveCount >= 1) ? globalActiveCount : clampTarget;
      this.hysteresis.throttledCap = this.hysteresis.mode === 'throttled'
        ? Math.min(this.hysteresis.throttledCap, critTarget)
        : critTarget;
      this.hysteresis.mode = 'throttled';
      this.hysteresis.reasons = tripReasons;
      this.hysteresis.throttledAtMs = ts;
      this.hysteresis.cleanSamples = 0;
      this.hysteresis.lastSampleEvaluatedAtMs = ts;
    } else if (this.hysteresis.mode === 'throttled') {
      // Reclaim idle slots while still throttled so capacity does not bounce prematurely
      if (globalActiveCount > 0 && globalActiveCount < this.hysteresis.throttledCap) {
        this.hysteresis.throttledCap = Math.max(1, globalActiveCount);
      }
      const recoveryMet =
        cpuPct <= this.cfg.recoverCpuPct &&
        dev.availPhysMib >= this.cfg.recoverFreePhysMib &&
        (dev.availCommitMib === null || (dev.availCommitMib >= effRecoverFreeCommitMib && (dev.commitUsedPct ?? 0) <= this.cfg.recoverCommitUsedPct)) &&
        rateLimits === 0 &&
        this.inFlightGateReviews <= this.cfg.gateQueueRecoverWater;

      if (advanceSample || ts - this.hysteresis.lastSampleEvaluatedAtMs >= Math.max(250, Math.floor(this.cfg.sampleIntervalMs / 2))) {
        this.hysteresis.lastSampleEvaluatedAtMs = ts;
        if (recoveryMet) this.hysteresis.cleanSamples += 1;
        else this.hysteresis.cleanSamples = 0;
      } else if (!recoveryMet) {
        this.hysteresis.cleanSamples = 0;
      }

      if (
        recoveryMet &&
        this.hysteresis.cleanSamples >= this.cfg.hysteresisRecoverSamples &&
        ts - this.hysteresis.throttledAtMs >= this.cfg.hysteresisCooldownMs
      ) {
        this.hysteresis.mode = 'normal';
        this.hysteresis.reasons = [];
        this.hysteresis.throttledCap = 200;
        this.hysteresis.cleanSamples = 0;
      }
    }

    let deviceCapacity = Math.min(rawHardwareCap, pipelineCap);
    if (this.hysteresis.mode === 'throttled') {
      deviceCapacity = Math.min(deviceCapacity, this.hysteresis.throttledCap);
    }
    // Never deadlock at 0 when nothing is running; only hold at activeCount when >=1 is already running
    deviceCapacity = globalActiveCount === 0 ? Math.max(1, deviceCapacity) : Math.max(0, deviceCapacity);

    const globalHardCap = Math.min(globalPoolMax, deviceCapacity);
    const remainingGlobalForThisTeam = Math.max(0, globalHardCap - otherActiveCount);
    const preWindowHardCap = Math.min(userMax, deviceCapacity, remainingGlobalForThisTeam);
    const hardCap = rwCap !== null ? Math.min(preWindowHardCap, rwCap) : preWindowHardCap;
    const effectiveCap = st.leaderMaxParallel !== null ? Math.min(hardCap, st.leaderMaxParallel) : hardCap;
    if (rwCap !== null && (rwCap < preWindowHardCap || activeCount >= rwCap) && !bottlenecks.includes('request_window_cap')) {
      bottlenecks.push('request_window_cap');
    }

    // 4. Progressive ramp-up wave budget
    if (st.waveStartMs > 0 && ts - st.waveStartMs >= this.cfg.rampObserveMs && this.hysteresis.mode === 'normal') {
      st.waveStartMs = 0;
      st.waveDispatched = 0;
    }
    const rampRemaining = this.hysteresis.mode === 'throttled'
      ? Math.max(0, effectiveCap - activeCount)
      : Math.max(0, this.cfg.rampStepSize - st.waveDispatched);
    const availableNow = activeCount >= effectiveCap
      ? 0
      : Math.min(effectiveCap - activeCount, rampRemaining);

    if (activeCount >= effectiveCap && activeCount > 0) {
      st.hadCappedTurn = true;
    }
    st.lastObservedEffectiveCap = effectiveCap;

    const pressure = dev.availPhysMib <= this.cfg.criticalFreePhysMib
      ? 'critical'
      : (tripReasons.length > 0 || this.hysteresis.mode === 'throttled')
        ? 'high'
        : (cpuPct >= this.cfg.recoverCpuPct || dev.availPhysMib < this.cfg.recoverFreePhysMib || this.inFlightGateReviews > 1)
          ? 'elevated'
          : 'ok';

    return this.#buildSnapshot({
      ts, dev, execActive, activeCount, globalActiveCount, byProfile, userMax, userMaxSource, globalPoolMax, deviceCapacity,
      hardCap, effectiveCap, availableNow, rampRemaining, pressure, bottlenecks, shellCapped, st, requestWindowMaxCap: rwCap,
    });
  }

  #buildSnapshot({ ts, dev, execActive, activeCount, globalActiveCount, byProfile, userMax, userMaxSource, globalPoolMax, deviceCapacity, hardCap, effectiveCap, availableNow, rampRemaining, pressure, bottlenecks, shellCapped, st, requestWindowMaxCap = null }) {
    let scaleState = 'expandable';
    if (activeCount > effectiveCap) scaleState = 'draining_above_cap';
    else if (this.hysteresis.mode === 'throttled' && activeCount >= effectiveCap) scaleState = 'throttled_hold';
    else if (activeCount >= effectiveCap) scaleState = 'at_capacity';
    else if (availableNow === 0 && rampRemaining === 0) scaleState = 'ramp_observing';

    const cooldownRemainingMs = this.hysteresis.mode === 'throttled'
      ? Math.max(0, this.cfg.hysteresisCooldownMs - (ts - this.hysteresis.throttledAtMs))
      : 0;

    return {
      at_ms: ts,
      controls: {
        user_max_concurrent: userMax,
        user_max_source: userMaxSource,
        global_pool_max: globalPoolMax,
        device_capacity: deviceCapacity,
        request_window_max_cap: requestWindowMaxCap,
        hard_cap: hardCap,
        leader_max_parallel: st.leaderMaxParallel,
        effective_cap: effectiveCap,
        ramp_step_size: this.cfg.rampStepSize,
        ramp_available_now: availableNow,
        scale_state: scaleState,
      },
      active_execution_members: {
        total: activeCount,
        global_total: globalActiveCount,
        by_profile: byProfile,
        names: execActive.map(m => m.name),
        governance_roles_excluded: true,
      },
      backlog: {
        pending_parallel_tasks: st.pendingParallelTasks,
        awaiting_slots: st.awaitingSlots,
      },
      device: {
        logical_cores: dev.logicalCores,
        ...(dev.cgroupCpuQuotaCores != null ? { cgroup_cpu_quota_cores: dev.cgroupCpuQuotaCores } : {}),
        ...(dev.cgroupMemoryLimitMib != null ? { cgroup_memory_limit_mib: dev.cgroupMemoryLimitMib } : {}),
        cpu_busy_pct: dev.cpuBusyPct,
        cpu_smoothed_pct: dev.cpuSmoothedPct,
        phys_total_mib: dev.totalPhysMib,
        phys_avail_mib: dev.availPhysMib,
        phys_used_pct: dev.physUsedPct,
        commit_total_mib: dev.totalCommitMib,
        commit_avail_mib: dev.availCommitMib,
        commit_used_pct: dev.commitUsedPct,
        host_rss_mib: dev.hostRssMib,
        pressure,
      },
      pipeline: {
        in_flight_shell_calls: this.inFlightShellCalls,
        in_flight_gate_reviews: this.inFlightGateReviews,
        recent_rate_limits: this.rateLimitEvents.length,
        recent_transient_errors: this.transientErrorEvents.length,
        recent_completions: this.completionEvents.length,
        shell_capped: shellCapped,
        bottlenecks,
      },
      hysteresis: {
        mode: this.hysteresis.mode,
        reasons: [...this.hysteresis.reasons],
        clean_samples: this.hysteresis.cleanSamples,
        cooldown_remaining_ms: cooldownRemainingMs,
      },
      guidance: buildLeaderGuidance({ activeCount, userMax, deviceCapacity, effectiveCap, availableNow, scaleState, pressure, bottlenecks, pending: st.pendingParallelTasks }),
    };
  }

  /**
   * Check whether an execution subagent dispatch may proceed right now.
   * Prefer `reserveDispatch(...)` in async callers so slots are reserved synchronously before any `await`.
   */
  checkDispatch({ teamId, taskSeq, activeMembers = [], otherActiveMembers = [], profile, requestWindowMaxCap }) {
    const snapshot = this.evaluate({ teamId, taskSeq, activeMembers, otherActiveMembers, targetProfile: profile, requestWindowMaxCap });
    const { active_execution_members: active, controls, pipeline } = snapshot;
    if (active.total >= controls.effective_cap) {
      this.markAwaitingSlots(teamId, taskSeq);
      const otherBusy = active.global_total - active.total;
      const why = controls.request_window_max_cap !== null && controls.effective_cap === controls.request_window_max_cap && controls.request_window_max_cap < Math.min(controls.user_max_concurrent, controls.device_capacity)
        ? `request window cap=${controls.request_window_max_cap}`
        : otherBusy > 0 && active.global_total >= Math.min(controls.global_pool_max, controls.device_capacity)
        ? `environment active=${active.global_total}/${Math.min(controls.global_pool_max, controls.device_capacity)} (${otherBusy} in other session(s))`
        : controls.user_max_concurrent <= controls.device_capacity
        ? `user max=${controls.user_max_concurrent}`
        : `device/pipeline capacity=${controls.device_capacity} (${pipeline.bottlenecks.join(', ') || snapshot.device.pressure})`;
      return {
        allowed: false,
        snapshot,
        reason: `active member limit ${controls.effective_cap} reached (${why}, active=${active.total}); wait for running members to finish or capacity recovery`,
      };
    }
    if (controls.ramp_available_now <= 0) {
      this.markAwaitingSlots(teamId, taskSeq);
      return {
        allowed: false,
        snapshot,
        reason: `active member limit ${active.total} reached for current progressive ramp wave (step=${controls.ramp_step_size}, effective_cap=${controls.effective_cap}); end your turn briefly so pressure is observed, and you will be notified to dispatch the next wave`,
      };
    }
    return { allowed: true, snapshot };
  }

  /** Convenience wrapper for unit callers that want check + accept in one step. */
  admitDispatch(input) {
    const res = this.reserveDispatch(input);
    if (!res.allowed) return res;
    const after = this.evaluate({
      teamId: input.teamId,
      taskSeq: input.taskSeq,
      activeMembers: [...(input.activeMembers ?? []), { status: 'starting', profile: input.profile, name: '(starting)' }],
      otherActiveMembers: input.otherActiveMembers ?? [],
      requestWindowMaxCap: input.requestWindowMaxCap,
    });
    res.commit(after);
    return { allowed: true, snapshot: after };
  }

  /**
   * Prepare an asynchronous scale-up wakeup notice WITHOUT mutating deduplication/wakeup counters.
   * Call `commitScaleUpNotice(teamId, taskSeq, notice)` ONLY after `agent.followup` actually succeeds!
   */
  prepareScaleUpNotice({ teamId, taskSeq, activeMembers = [], otherActiveMembers = [], userCapRaised = false }) {
    const st = this.teams.get(teamId);
    if (!st || st.taskSeq !== taskSeq) return null;
    const effectiveUserRaise = Boolean(userCapRaised || st.pendingUserScaleUp);
    const snap = this.evaluate({ teamId, taskSeq, activeMembers, otherActiveMembers, advanceSample: !userCapRaised });
    const { total: activeCount } = snap.active_execution_members;
    const { effective_cap: effectiveCap, ramp_available_now: availableNow, user_max_concurrent: userMax, device_capacity: deviceCap } = snap.controls;
    if (availableNow <= 0 || activeCount >= effectiveCap) return null;

    const hasWaitingWork = st.pendingParallelTasks > 0 || st.awaitingSlots || (effectiveUserRaise && st.hadCappedTurn && activeCount > 0);
    if (!hasWaitingWork) return null;
    if (!effectiveUserRaise && st.autoWakeups >= this.cfg.maxAutoWakeupsPerTask) return null;

    const key = `${taskSeq}:${effectiveCap}:${activeCount}:${availableNow}`;
    if (st.lastNotifiedKey === key) return null;
    return {
      key,
      effectiveUserRaise,
      summary: `并发容量可用：运行中 ${activeCount}/${effectiveCap}（可补派 ${availableNow}）`,
      text: `[LeaderTeam 弹性并发调度通知] 当前运行中执行子代理 ${activeCount} 个，实时有效并发上限为 ${effectiveCap}（用户上限 ${userMax}，设备/链路动态承载 ${deviceCap}），本轮可新增派发 ${availableNow} 个执行子代理${st.pendingParallelTasks > 0 ? `（已登记待派并行任务 ${st.pendingParallelTasks} 个）` : ''}。若当前已批准计划中仍有独立就绪的待派子任务，请按需调用 team_dispatch 补派；若所有合适任务均已派发，切勿为凑满上限强行拆分或新造任务。`,
      snapshot: snap,
    };
  }

  commitScaleUpNotice(teamId, taskSeq, prepared) {
    const st = this.teams.get(teamId);
    if (!st || st.taskSeq !== taskSeq || !prepared) return;
    st.lastNotifiedKey = prepared.key;
    st.pendingUserScaleUp = false;
    if (!prepared.effectiveUserRaise) st.autoWakeups += 1;
  }

  /** Convenience wrapper (used by direct unit callers); commits immediately unless `commit: false`. */
  shouldNotifyScaleUp(input) {
    const prepared = this.prepareScaleUpNotice(input);
    if (!prepared) return null;
    if (input?.commit !== false) this.commitScaleUpNotice(input.teamId, input.taskSeq, prepared);
    return prepared;
  }
}

function clampCap(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(200, n));
}

function normalizeOptionalRequestWindowCap(v) {
  if (v === null || v === undefined) return null;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(200, n));
}

/**
 * Compute an execution concurrency snapshot, optionally applying `requestWindowMaxCap` (e.g. from Tier 2/3
 * 5h request-window guard) to cap *new* execution member dispatches while keeping governance roles excluded.
 */
export function computeConcurrencySnapshot(schedulerOrOptions = {}, maybeOptions = {}) {
  if (schedulerOrOptions instanceof ElasticConcurrencyScheduler) {
    return schedulerOrOptions.evaluate(maybeOptions);
  }
  const opts = {
    ...(schedulerOrOptions && typeof schedulerOrOptions === 'object' ? schedulerOrOptions : {}),
    ...(maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {}),
  };
  const sched = opts.scheduler instanceof ElasticConcurrencyScheduler
    ? opts.scheduler
    : new ElasticConcurrencyScheduler(opts.config ?? {}, {
        now: typeof opts.nowMs === 'number' ? () => opts.nowMs : opts.now,
        sampler: opts.deviceSample ? { sample: () => opts.deviceSample } : opts.sampler,
        deviceProbe: opts.deviceProbe,
        platform: opts.platform,
        fs: opts.fs,
        cgroupRoot: opts.cgroupRoot,
        meminfoPath: opts.meminfoPath,
        linuxMeminfoReader: opts.linuxMeminfoReader,
        linuxCgroupReader: opts.linuxCgroupReader,
        requestWindowMaxCap: opts.requestWindowMaxCap,
      });
  return sched.evaluate(opts);
}

function buildLeaderGuidance({ activeCount, userMax, deviceCapacity, effectiveCap, availableNow, scaleState, pressure, bottlenecks, pending }) {
  if (scaleState === 'draining_above_cap') {
    return `SCALE-DOWN HOLD: ${activeCount} execution members are running above the current cap ${effectiveCap} (user max=${userMax}, device capacity=${deviceCapacity}). Do NOT interrupt healthy running members and do NOT dispatch new execution members right now; let running members finish naturally until active count drops below ${effectiveCap}.`;
  }
  if (scaleState === 'throttled_hold') {
    return `RESOURCE/PIPELINE HOLD: active=${activeCount}/${effectiveCap} (bottlenecks: ${bottlenecks.join(', ') || pressure}). Pause new dispatches until hysteresis recovery completes or running members finish.`;
  }
  if (scaleState === 'at_capacity') {
    return `AT CAPACITY: active=${activeCount}/${effectiveCap} (user max=${userMax}, device capacity=${deviceCapacity}). End your turn and wait for running members or capacity changes${pending > 0 ? ` (${pending} pending task(s) registered)` : ''}.`;
  }
  if (scaleState === 'ramp_observing') {
    return `PROGRESSIVE RAMP OBSERVATION: current wave limit reached (active=${activeCount}/${effectiveCap}). End your turn briefly while pressure and throughput are observed; remaining tasks can launch in the next wave.`;
  }
  return `EXPANDABLE: active=${activeCount}/${effectiveCap} (user max=${userMax}, device capacity=${deviceCapacity}, pressure=${pressure}). Up to ${availableNow} independent execution member(s) may be dispatched in this wave — decompose genuinely parallel work proactively, never pad tasks artificially.`;
}
