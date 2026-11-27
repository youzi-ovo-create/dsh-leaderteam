#!/usr/bin/env node
// Cross-platform pre-flight diagnostics CLI for LeaderTeam V2.2 (Windows + Linux + macOS).
// Pure Node ESM, zero external npm dependencies, zero console popups.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadRawConfig, validateConfig, deepMergePlain } from '../leaderteam/core/config.mjs';
import { detectLegacyProfilePatchConflicts, cleanLegacyProfilePatches } from '../leaderteam/core/legacy-patch-guard.mjs';
import {
  VERIFIED_CORE_VERSIONS,
  SUPPORTED_DSH_ENGINE_RANGE,
  CANONICAL_PIPELINE_SNIPPETS,
  evaluateHostCompatibility,
  getHostCompatibilityMatrix,
  renderCompatibilityMatrixMarkdown,
} from '../leaderteam/core/host-compat.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');

export const DEFAULT_SUPPORTED_CORE_VERSIONS = VERIFIED_CORE_VERSIONS;

export const REQUIRED_PIPELINE_INVARIANTS = CANONICAL_PIPELINE_SNIPPETS;

export const SOLO_KEY_ENV_NAMES = Object.freeze([
  'DEEPSEEK_API_KEY',
  'DASHSCOPE_API_KEY',
  'BAILIAN_API_KEY',
  'ZHIPU_API_KEY',
  'OPENAI_API_KEY',
  'QWEN_API_KEY',
  'GLM_API_KEY',
  'ANTHROPIC_API_KEY',
]);

function parseSemver(ver) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(ver ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function readSupportedCoreVersions(fsImpl = fs) {
  const merged = new Set(DEFAULT_SUPPORTED_CORE_VERSIONS);
  for (const rel of ['leaderteam/package.json', 'package.json']) {
    try {
      const pkg = JSON.parse(fsImpl.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      const list = pkg?.leaderteam?.supportedCoreVersions;
      if (Array.isArray(list)) {
        for (const v of list) if (typeof v === 'string' && v.trim()) merged.add(v.trim());
      }
    } catch {}
  }
  return [...merged];
}

/**
 * Minimal zero-dependency Electron ASAR reader so plain `node bin/lt-doctor.mjs`
 * can inspect `resources/app.asar` in <2ms without spawning Electron or installing `asar`.
 */
function readFileFromAsarArchive(asarFile, relPosixPath, fsImpl = fs) {
  let fd;
  try {
    fd = fsImpl.openSync(asarFile, 'r');
    const prefix = Buffer.alloc(16);
    if (fsImpl.readSync(fd, prefix, 0, 16, 0) < 16) return null;
    const headerPickleSize = prefix.readUInt32LE(4);
    const jsonByteLength = prefix.readUInt32LE(12);
    if (headerPickleSize < 8 || jsonByteLength < 2 || jsonByteLength > 32 * 1024 * 1024) return null;
    const jsonBuf = Buffer.alloc(jsonByteLength);
    if (fsImpl.readSync(fd, jsonBuf, 0, jsonByteLength, 16) < jsonByteLength) return null;
    const index = JSON.parse(jsonBuf.toString('utf8'));
    const parts = relPosixPath.split('/').filter(Boolean);
    let cursor = index;
    for (const seg of parts) {
      cursor = cursor?.files?.[seg];
      if (!cursor) return null;
    }
    if (cursor.unpacked) {
      const unpackedFile = path.join(`${asarFile}.unpacked`, ...parts);
      return fsImpl.readFileSync(unpackedFile, 'utf8');
    }
    if (typeof cursor.size !== 'number' || cursor.offset === undefined) return null;
    const dataOffset = 8 + headerPickleSize + Number(cursor.offset);
    if (!Number.isFinite(dataOffset) || cursor.size < 0 || cursor.size > 16 * 1024 * 1024) return null;
    const contentBuf = Buffer.alloc(cursor.size);
    const bytesRead = fsImpl.readSync(fd, contentBuf, 0, cursor.size, dataOffset);
    if (bytesRead < cursor.size) return null;
    return contentBuf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }
}

function readCandidateText(basePath, relPosixPath, fsImpl = fs) {
  try {
    const st = fsImpl.statSync(basePath);
    if (st.isDirectory()) {
      const full = path.join(basePath, ...relPosixPath.split('/').filter(Boolean));
      return fsImpl.readFileSync(full, 'utf8');
    }
    if (st.isFile() && basePath.toLowerCase().endsWith('.asar')) {
      return readFileFromAsarArchive(basePath, relPosixPath, fsImpl);
    }
  } catch {}
  return null;
}

function probeDshTarget(targetPath, fsImpl = fs) {
  const resolved = path.resolve(targetPath);
  const probes = [
    // 1. Direct @deepseek-ai/dsh-tools package folder
    { base: resolved, pkgRel: 'package.json', pipeRel: 'lib/pipeline.js', desktopPkgRel: null },
    // 2. Module root containing node_modules/@deepseek-ai/dsh-tools (e.g. unpacked dsh dir or npm prefix/lib)
    {
      base: resolved,
      pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json',
      pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      desktopPkgRel: 'package.json',
    },
    // 3. Global npm lib/node_modules/@deepseek-ai/dsh or prefix/lib/node_modules/@deepseek-ai/dsh
    {
      base: path.join(resolved, 'lib'),
      pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json',
      pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      desktopPkgRel: null,
    },
    // 4. Sibling package when pointing directly at node_modules/@deepseek-ai/dsh
    {
      base: path.dirname(resolved),
      pkgRel: 'dsh-tools/package.json',
      pipeRel: 'dsh-tools/lib/pipeline.js',
      desktopPkgRel: null,
    },
    // 5. Direct app.asar file or unpacked app.asar dir
    {
      base: resolved,
      pkgRel: 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json',
      pipeRel: 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      desktopPkgRel: 'package.json',
    },
    // 6. Desktop app root -> resources/app/dsh or resources/app.asar(/dsh)
    {
      base: path.join(resolved, 'resources', 'app', 'dsh'),
      pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json',
      pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      desktopPkgRel: '../package.json',
    },
    {
      base: path.join(resolved, 'resources', 'app.asar'),
      pkgRel: 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json',
      pipeRel: 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      desktopPkgRel: 'package.json',
    },
    {
      base: path.join(resolved, 'resources', 'app.asar'),
      pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json',
      pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js',
      desktopPkgRel: 'package.json',
    },
  ];

  for (const p of probes) {
    const pkgText = readCandidateText(p.base, p.pkgRel, fsImpl);
    if (!pkgText) continue;
    let toolsPkg;
    try { toolsPkg = JSON.parse(pkgText); } catch { continue; }
    if (toolsPkg?.name && toolsPkg.name !== '@deepseek-ai/dsh-tools') continue;
    if (!toolsPkg?.version) continue;

    let desktopVersion = null;
    if (p.desktopPkgRel && !p.desktopPkgRel.startsWith('..')) {
      const dText = readCandidateText(p.base, p.desktopPkgRel, fsImpl);
      if (dText) {
        try {
          const dPkg = JSON.parse(dText);
          if (dPkg?.name === '@deepseek-ai/dsh-desktop' && typeof dPkg.version === 'string') {
            desktopVersion = dPkg.version;
          }
        } catch {}
      }
    }
    const pipelineSource = readCandidateText(p.base, p.pipeRel, fsImpl);
    return {
      found: true,
      resolvedFrom: p.base,
      toolsVersion: String(toolsPkg.version),
      desktopVersion,
      pipelineSource,
    };
  }

  // Fallback for strict non-hoisted pnpm layouts (`@deepseek-ai/dsh` -> `@deepseek-ai/dsh-base` -> `@deepseek-ai/dsh-tools`)
  if (fsImpl === fs) {
    const candidatePkgs = [
      path.join(resolved, 'package.json'),
      path.join(resolved, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      path.join(resolved, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    ];
    for (const startPkg of candidatePkgs) {
      if (!fs.existsSync(startPkg)) continue;
      const queue = [startPkg];
      const visited = new Set([startPkg]);
      for (let depth = 0; depth < 3 && queue.length > 0; depth++) {
        const nextQueue = [];
        for (const curPkg of queue) {
          let req;
          try { req = createRequire(curPkg); } catch { continue; }
          try {
            const toolsPkgPath = req.resolve('@deepseek-ai/dsh-tools/package.json');
            if (toolsPkgPath && fs.existsSync(toolsPkgPath)) {
              const toolsPkg = JSON.parse(fs.readFileSync(toolsPkgPath, 'utf8'));
              const pipePath = path.join(path.dirname(toolsPkgPath), 'lib', 'pipeline.js');
              const pipelineSource = fs.existsSync(pipePath) ? fs.readFileSync(pipePath, 'utf8') : null;
              return {
                found: true,
                resolvedFrom: path.dirname(toolsPkgPath),
                toolsVersion: String(toolsPkg.version),
                desktopVersion: null,
                pipelineSource,
              };
            }
          } catch {}
          for (const hop of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-desktop-host/package.json', '@deepseek-ai/dsh-headless/package.json', '@deepseek-ai/dsh-web/package.json']) {
            try {
              const hp = req.resolve(hop);
              if (hp && !visited.has(hp) && fs.existsSync(hp)) {
                visited.add(hp);
                nextQueue.push(hp);
              }
            } catch {}
          }
        }
        queue.splice(0, queue.length, ...nextQueue);
      }
    }
  }
  return null;
}

function extractDispatchToolBodySlice(source) {
  if (typeof source !== 'string') return '';
  const idx = source.indexOf('dispatchToolBody');
  if (idx < 0) return '';
  // Slice a generous window covering dispatchToolBody without requiring full JS AST parsing.
  return source.slice(idx, idx + 8192);
}

function discoverDefaultHostCandidates({ platform, env, fsImpl }) {
  const candidates = [];
  if (env.LT_DSH_APP) candidates.push(env.LT_DSH_APP);
  if (env.LT_DSH_BIN) {
    const normalized = String(env.LT_DSH_BIN).replaceAll('\\', '/');
    const idx = normalized.lastIndexOf('/node_modules/');
    if (idx > 0) candidates.push(String(env.LT_DSH_BIN).slice(0, idx));
  }
  try {
    const pathsFile = path.join(REPO_ROOT, 'config', 'official-desktop.paths.json');
    if (fsImpl.existsSync(pathsFile)) {
      const parsed = JSON.parse(fsImpl.readFileSync(pathsFile, 'utf8'));
      if (typeof parsed?.app === 'string' && parsed.app.trim()) candidates.push(parsed.app.trim());
    }
  } catch {}
  try {
    const rtDir = path.join(REPO_ROOT, 'runtime', 'official-desktop');
    if (fsImpl.existsSync(rtDir)) {
      const subdirs = fsImpl.readdirSync(rtDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(rtDir, d.name))
        .sort()
        .reverse();
      candidates.push(...subdirs);
    }
  } catch {}

  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'DeepSeek Harness'));
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents');
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
    candidates.push('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh');
  } else {
    candidates.push('/opt/DeepSeek Harness');
    candidates.push('/opt/deepseek-harness');
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh');
    candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh');
    if (env.HOME) candidates.push(path.join(env.HOME, '.local', 'share', 'dsh-runtime', 'current'));
  }

  // Also inspect PATH entries (plus ~/.local/bin) for an npm-installed `dsh` binary symlink or global node_modules
  const pathSep = platform === 'win32' ? ';' : ':';
  const searchBins = [
    ...String(env.PATH ?? '').split(pathSep).filter(Boolean),
    ...(platform !== 'win32' && env.HOME ? [path.join(env.HOME, '.local', 'bin')] : []),
  ];
  for (const binDir of searchBins) {
    try {
      const dshBin = path.join(binDir, platform === 'win32' ? 'dsh.cmd' : 'dsh');
      if (fsImpl.existsSync(dshBin)) {
        candidates.push(path.join(binDir, 'node_modules', '@deepseek-ai', 'dsh'));
        candidates.push(path.join(path.dirname(binDir), 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
        try {
          const real = fsImpl.realpathSync(dshBin);
          const norm = real.replaceAll('\\', '/');
          const nmIdx = norm.lastIndexOf('/node_modules/');
          if (nmIdx > 0) candidates.push(real.slice(0, nmIdx));
        } catch {}
      }
    } catch {}
  }

  return [...new Set(candidates)];
}

export function checkNodeRuntime(nodeVersion = process.versions.node) {
  const parsed = parseSemver(nodeVersion);
  if (!parsed) {
    return {
      status: 'fail',
      nodeVersion: String(nodeVersion),
      coreSupported: false,
      extensionBuildSupported: false,
      summary: `Unparseable Node.js version "${nodeVersion}" (requires >=22.15).`,
    };
  }
  const coreSupported = parsed.major > 22 || (parsed.major === 22 && parsed.minor >= 15);
  const extensionBuildSupported = (parsed.major === 22 && parsed.minor >= 19) || parsed.major >= 24;
  if (!coreSupported) {
    return {
      status: 'fail',
      nodeVersion,
      coreSupported: false,
      extensionBuildSupported: false,
      summary: `Node.js ${nodeVersion} is below LeaderTeam core requirement (>=22.15). Upgrade to Node 22.19+ or 24.x.`,
    };
  }
  const extNote = extensionBuildSupported
    ? 'satisfies both LT core (>=22.15) and extensions/dsh-context build (^22.19.0 || >=24.0.0)'
    : 'satisfies LT core (>=22.15); note that building extensions/dsh-context from source requires ^22.19.0 || >=24.0.0';
  return {
    status: 'pass',
    nodeVersion,
    coreSupported: true,
    extensionBuildSupported,
    summary: `Node.js v${nodeVersion} (${extNote}).`,
  };
}

export function checkDshHostCompatibility({
  checkHost = null,
  supportedCoreVersions = null,
  supportedCoreRange = SUPPORTED_DSH_ENGINE_RANGE,
  policy = 'adaptive',
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
} = {}) {
  const supported = Array.isArray(supportedCoreVersions) && supportedCoreVersions.length > 0
    ? [...supportedCoreVersions]
    : readSupportedCoreVersions(fsImpl);
  const isolatedProbeMode = Boolean(checkHost);
  const targets = isolatedProbeMode
    ? [checkHost]
    : discoverDefaultHostCandidates({ platform, env, fsImpl });

  let hit = null;
  for (const t of targets) {
    hit = probeDshTarget(t, fsImpl);
    if (hit) break;
  }

  if (!hit) {
    return {
      status: isolatedProbeMode ? 'fail' : 'warn',
      classification: 'NOT_FOUND',
      classificationLabel: 'NOT_FOUND',
      policy,
      isolatedProbeMode,
      toolsVersion: null,
      desktopVersion: null,
      supportedCoreVersions: supported,
      supportedCoreRange,
      requiredInvariants: {
        dispatchToolBodyPresent: false,
        resolveExecutionPresent: false,
        toolExecutePresent: false,
      },
      resolvedFrom: checkHost ? path.resolve(checkHost) : null,
      productionAllowed: false,
      summary: isolatedProbeMode
        ? `Could not locate @deepseek-ai/dsh-tools under --check-host "${checkHost}".`
        : 'No local DeepSeek Harness installation auto-detected (pass --check-host <dir> to inspect a custom path).',
    };
  }

  const src = hit.pipelineSource ?? '';
  const bodySlice = extractDispatchToolBodySlice(src);
  const dispatchSliceOrEmpty = Boolean(bodySlice) && src.includes('resolveExecution') ? bodySlice : '';
  const evalRes = evaluateHostCompatibility({
    toolsVersion: hit.toolsVersion,
    desktopVersion: hit.desktopVersion,
    pipelineSource: dispatchSliceOrEmpty,
    supportedVersions: supported,
    supportedRange: supportedCoreRange,
    policy,
  });

  return {
    status: evalRes.status,
    classification: evalRes.classification,
    classificationLabel: evalRes.classificationLabel,
    policy: evalRes.policy,
    isolatedProbeMode,
    toolsVersion: hit.toolsVersion,
    desktopVersion: hit.desktopVersion,
    supportedCoreVersions: supported,
    supportedCoreRange,
    requiredInvariants: {
      dispatchToolBodyPresent: Boolean(bodySlice) && src.includes('resolveExecution'),
      resolveExecutionPresent: evalRes.requiredInvariants.resolveExecutionPresent,
      toolExecutePresent: evalRes.requiredInvariants.toolExecutePresent,
    },
    resolvedFrom: hit.resolvedFrom,
    productionAllowed: evalRes.productionAllowed,
    summary: evalRes.summary,
  };
}

function parseWindowsIcaclsForUser(icaclsOutput, username) {
  const text = String(icaclsOutput ?? '');
  const cleanUser = String(username ?? '').trim();
  if (!cleanUser) {
    return { hasExplicitGrant: false, grantedTokens: [], hasDeny: false };
  }
  const escapedUser = cleanUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match either `<DOMAIN>\<username>:(...)` or standalone `<username>:(...)`
  const userLineRe = new RegExp(`(?:^|[\\s\\\\])${escapedUser}:(\\(?:?[^\\r\\n]+)`, 'gim');
  let hasExplicitGrant = false;
  let hasDeny = false;
  const grantedTokens = [];

  for (const m of text.matchAll(userLineRe)) {
    const spec = m[1] ?? '';
    const upper = spec.toUpperCase();
    if (upper.includes('(DENY)') || upper.includes('(N)')) {
      hasDeny = true;
      continue;
    }
    const groups = [...upper.matchAll(/\(([^)]+)\)/g)].map(g => g[1]);
    const rights = new Set(groups.flatMap(g => g.split(',').map(s => s.trim()).filter(Boolean)));
    for (const r of rights) grantedTokens.push(r);
    if (rights.has('F') || (rights.has('WDAC') && rights.has('WO')) || (rights.has('WRITE_DAC') && rights.has('WRITE_OWNER'))) {
      hasExplicitGrant = true;
    }
  }
  return { hasExplicitGrant, grantedTokens: [...new Set(grantedTokens)], hasDeny };
}

export function checkPlatformEnvironment({
  platform = process.platform,
  workspace = process.cwd(),
  env = process.env,
  username = null,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  procMeminfoPath = '/proc/meminfo',
  cgroupRoot = '/sys/fs/cgroup',
  osReleaseText = null,
} = {}) {
  const resolvedWorkspace = path.resolve(workspace);

  if (platform === 'linux') {
    let bashAvailable = false;
    let bashVersion = null;
    try {
      const out = execFileSyncImpl('bash', ['--version'], {
        windowsHide: true,
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      bashAvailable = true;
      bashVersion = String(out ?? '').split(/\r?\n/)[0]?.trim() || 'bash';
    } catch {
      bashAvailable = fsImpl.existsSync('/bin/bash') || fsImpl.existsSync('/usr/bin/bash');
    }

    let meminfoReadable = false;
    let memTotalMib = null;
    let memAvailableMib = null;
    try {
      const rawMem = fsImpl.readFileSync(procMeminfoPath, 'utf8');
      meminfoReadable = true;
      const totMatch = /^MemTotal:\s+(\d+)\s+kB/m.exec(rawMem);
      const availMatch = /^MemAvailable:\s+(\d+)\s+kB/m.exec(rawMem);
      if (totMatch) memTotalMib = Math.round(Number(totMatch[1]) / 1024);
      if (availMatch) memAvailableMib = Math.round(Number(availMatch[1]) / 1024);
    } catch {}

    let cgroupV2Present = false;
    let cgroupMemoryMaxRaw = null;
    let cgroupMemoryMaxMib = null;
    const normCgRoot = cgroupRoot.replaceAll('\\', '/');
    try {
      // On systemd cgroup v2 hosts (Ubuntu 22.04+, Debian 12+, Fedora), `memory.max` lives in slice/scope subdirs
      // discovered via `/proc/self/cgroup` while root `/sys/fs/cgroup` exposes `cgroup.controllers`.
      const candidateCgDirs = [];
      if (normCgRoot === '/sys/fs/cgroup') {
        try {
          const selfCg = fsImpl.readFileSync('/proc/self/cgroup', 'utf8');
          for (const line of selfCg.split(/\r?\n/)) {
            const parts = line.split(':');
            if (parts.length >= 3 && parts[0] === '0' && parts[1] === '') {
              const rel = parts.slice(2).join(':').replace(/^\/+|\/+$/g, '');
              if (rel) {
                const segs = rel.split('/').filter(Boolean);
                for (let len = segs.length; len >= 1; len--) {
                  candidateCgDirs.push(path.posix.join(normCgRoot, ...segs.slice(0, len)));
                }
              }
            }
          }
        } catch {}
      }
      candidateCgDirs.push(normCgRoot);

      if (fsImpl.existsSync(path.posix.join(normCgRoot, 'cgroup.controllers'))) {
        cgroupV2Present = true;
      }
      for (const cgDir of candidateCgDirs) {
        const memMaxFile = path.posix.join(cgDir, 'memory.max');
        if (!fsImpl.existsSync(memMaxFile)) continue;
        cgroupV2Present = true;
        const raw = fsImpl.readFileSync(memMaxFile, 'utf8').trim();
        if (cgroupMemoryMaxRaw === null) cgroupMemoryMaxRaw = raw;
        if (raw !== 'max' && /^\d+$/.test(raw)) {
          const bytes = Number(raw);
          if (Number.isFinite(bytes) && bytes > 0 && bytes < Number.MAX_SAFE_INTEGER) {
            const mib = Math.round(bytes / (1024 * 1024));
            if (cgroupMemoryMaxMib === null || mib < cgroupMemoryMaxMib) {
              cgroupMemoryMaxMib = mib;
              cgroupMemoryMaxRaw = raw;
            }
          }
        }
      }
      if (cgroupV2Present && cgroupMemoryMaxRaw === null) {
        cgroupMemoryMaxRaw = 'max';
      }
    } catch {}

    let bwrapAvailable = false;
    let apparmorRestrictUserns = null;
    try {
      bwrapAvailable = fsImpl.existsSync('/usr/bin/bwrap') || fsImpl.existsSync('/bin/bwrap');
      if (fsImpl.existsSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')) {
        apparmorRestrictUserns = fsImpl.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
      }
    } catch {}

    let pnpmAvailable = false;
    try {
      execFileSyncImpl('pnpm', ['--version'], {
        windowsHide: true,
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      pnpmAvailable = true;
    } catch {
      const pathDirs = [
        ...String(env?.PATH ?? '').split(':').filter(Boolean),
        ...(env?.HOME ? [path.join(env.HOME, '.local', 'bin')] : []),
      ];
      pnpmAvailable = pathDirs.some(d => {
        try { return fsImpl.existsSync(path.join(d, 'pnpm')); } catch { return false; }
      });
    }

    let kernelText = osReleaseText;
    if (kernelText === null) {
      try { kernelText = fsImpl.readFileSync('/proc/sys/kernel/osrelease', 'utf8'); } catch {
        try { kernelText = fsImpl.readFileSync('/proc/version', 'utf8'); } catch { kernelText = ''; }
      }
    }
    const isWsl2 = /microsoft|wsl/i.test(String(kernelText ?? ''));
    const linuxVariant = isWsl2 ? 'wsl2' : 'native-linux';

    const status = !bashAvailable ? 'fail' : (!meminfoReadable || (cgroupMemoryMaxMib !== null && cgroupMemoryMaxMib < 1024) ? 'warn' : 'pass');
    const cgroupDesc = cgroupV2Present
      ? (cgroupMemoryMaxMib !== null ? `cgroup v2 memory.max=${cgroupMemoryMaxMib} MiB` : 'cgroup v2 memory.max=max (unrestricted)')
      : 'cgroup v2 memory.max not present';
    const bwrapDesc = bwrapAvailable
      ? `, bwrap=present${apparmorRestrictUserns ? ' (apparmor_userns=1)' : ''}`
      : '';
    const pnpmDesc = pnpmAvailable ? ', pnpm=ok' : ', pnpm=missing (run "corepack enable pnpm" for "dsh plugin add")';
    return {
      status,
      platform: 'linux',
      linuxVariant,
      bashAvailable,
      bashVersion,
      pnpmAvailable,
      bwrapAvailable,
      apparmorRestrictUserns,
      meminfoReadable,
      memTotalMib,
      memAvailableMib,
      cgroupV2Present,
      cgroupMemoryMaxRaw,
      cgroupMemoryMaxMib,
      summary: `Linux (${linuxVariant}): bash=${bashAvailable ? 'ok' : 'MISSING'}, /proc/meminfo=${meminfoReadable ? `ok (${memAvailableMib ?? '?'} MiB avail)` : 'unreadable'}, ${cgroupDesc}${bwrapDesc}${pnpmDesc}.`,
    };
  }

  if (platform === 'win32') {
    let effectiveUser = username ?? env.USERNAME ?? null;
    if (!effectiveUser) {
      try { effectiveUser = os.userInfo().username; } catch { effectiveUser = 'CURRENT_USER'; }
    }
    const icaclsRemediateCmd = `icacls "${resolvedWorkspace}" /grant "%USERNAME%:(OI)(CI)F"`;
    const recoveryOut = path.join(path.dirname(resolvedWorkspace), 'lt-acl-recovery');
    const toolRemediateCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File tools/dsh-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1 -Path "${resolvedWorkspace}" -AllowRoot "${resolvedWorkspace}" -Out "${recoveryOut}"`;

    if (!fsImpl.existsSync(resolvedWorkspace)) {
      return {
        status: 'warn',
        platform: 'win32',
        workspace: resolvedWorkspace,
        username: effectiveUser,
        aclChecked: false,
        aclRisky: true,
        remediationCommands: [icaclsRemediateCmd, toolRemediateCmd],
        summary: `Workspace directory does not exist yet: "${resolvedWorkspace}". After creating it, ensure explicit (F) permission to avoid DSH SetNamedSecurityInfoW (Win32 5).`,
      };
    }

    let icaclsRaw = '';
    try {
      icaclsRaw = execFileSyncImpl('icacls', [resolvedWorkspace], {
        windowsHide: true,
        timeout: 4000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return {
        status: 'warn',
        platform: 'win32',
        workspace: resolvedWorkspace,
        username: effectiveUser,
        aclChecked: false,
        aclRisky: true,
        remediationCommands: [icaclsRemediateCmd, toolRemediateCmd],
        summary: `Unable to inspect Windows ACL via icacls (${err instanceof Error ? err.message : String(err)}). If pwsh fails with Win32 5, run: ${icaclsRemediateCmd}`,
      };
    }

    const parsedAcl = parseWindowsIcaclsForUser(icaclsRaw, effectiveUser);
    const aclRisky = !parsedAcl.hasExplicitGrant || parsedAcl.hasDeny;
    return {
      status: aclRisky ? 'warn' : 'pass',
      platform: 'win32',
      workspace: resolvedWorkspace,
      username: effectiveUser,
      aclChecked: true,
      aclRisky,
      hasExplicitFullOrDacOwner: parsedAcl.hasExplicitGrant,
      hasUserDenyAce: parsedAcl.hasDeny,
      remediationCommands: [icaclsRemediateCmd, toolRemediateCmd],
      summary: aclRisky
        ? `Windows workspace "${resolvedWorkspace}" lacks explicit (${effectiveUser}):(F) / WRITE_DAC+WRITE_OWNER ACE (root cause of DSH SetNamedSecurityInfoW Win32 5). Remediate with: ${icaclsRemediateCmd} or tools/dsh-sandbox-acl.`
        : `Windows workspace ACL verified for user "${effectiveUser}" (explicit Full Control / WRITE_DAC+WRITE_OWNER present).`,
    };
  }

  // macOS / other POSIX
  let bashAvailable = false;
  try {
    execFileSyncImpl('bash', ['--version'], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bashAvailable = true;
  } catch {
    bashAvailable = fsImpl.existsSync('/bin/bash');
  }
  return {
    status: bashAvailable ? 'pass' : 'warn',
    platform,
    bashAvailable,
    summary: `${platform}: bash=${bashAvailable ? 'ok' : 'missing'}.`,
  };
}

function validateConfigStrict(raw) {
  try {
    return { valid: true, config: validateConfig(raw), problems: [] };
  } catch (err) {
    return {
      valid: false,
      config: null,
      problems: err?.details?.problems ?? [err instanceof Error ? err.message : String(err)],
    };
  }
}

export function checkConfigurationAndSoloKey({
  configPath = null,
  dshHome = null,
  env = process.env,
  fsImpl = fs,
} = {}) {
  const effectiveDshHome = dshHome ?? env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dshConfigFile = path.join(effectiveDshHome, 'leaderteam', 'config', 'leaderteam.config.json');
  const repoConfigFile = path.join(REPO_ROOT, 'config', 'leaderteam.config.json');

  let selectedConfig = configPath ? path.resolve(configPath) : (env.LEADERTEAM_CONFIG ? path.resolve(env.LEADERTEAM_CONFIG) : null);
  let configSource = 'explicit';
  if (!selectedConfig) {
    if (fsImpl.existsSync(dshConfigFile)) {
      selectedConfig = dshConfigFile;
      configSource = 'dsh-home';
    } else {
      selectedConfig = repoConfigFile;
      configSource = 'repo-default';
    }
  }

  const detectedSoloKeys = SOLO_KEY_ENV_NAMES.filter(k => typeof env[k] === 'string' && env[k].trim().length > 0);

  if (!fsImpl.existsSync(selectedConfig)) {
    return {
      status: 'fail',
      configFile: selectedConfig,
      configSource,
      configValid: false,
      soloKeyEnvVarsPresent: detectedSoloKeys,
      gatewayProvider: null,
      powerMonitor: {
        enabled: true,
        pollIntervalMinutes: 12,
        disableSnippet: '"powerMonitor": { "enabled": false }',
        privacyNote: 'Reads ONLY (onBattery, batteryPct) every 12m; set "powerMonitor": { "enabled": false } to disable.',
      },
      summary: `Configuration file not found: ${selectedConfig}`,
    };
  }

  let raw;
  try {
    if (fsImpl === fs) {
      raw = loadRawConfig(selectedConfig);
    } else {
      raw = JSON.parse(fsImpl.readFileSync(selectedConfig, 'utf8').replace(/^\uFEFF/, ''));
      if (path.basename(selectedConfig) === 'leaderteam.config.json') {
        const localOverride = path.join(path.dirname(selectedConfig), 'leaderteam.local.json');
        if (fsImpl.existsSync(localOverride)) {
          const over = JSON.parse(fsImpl.readFileSync(localOverride, 'utf8').replace(/^\uFEFF/, ''));
          raw = deepMergePlain(raw, over);
        }
      }
    }
  } catch (err) {
    return {
      status: 'fail',
      configFile: selectedConfig,
      configSource,
      configValid: false,
      soloKeyEnvVarsPresent: detectedSoloKeys,
      gatewayProvider: null,
      powerMonitor: {
        enabled: true,
        pollIntervalMinutes: 12,
        disableSnippet: '"powerMonitor": { "enabled": false }',
        privacyNote: 'Reads ONLY (onBattery, batteryPct) every 12m; set "powerMonitor": { "enabled": false } to disable.',
      },
      summary: `Failed to parse config "${selectedConfig}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = validateConfigStrict(raw);
  const powerEnabled = raw?.powerMonitor?.enabled !== false;
  const pollMinutes = Math.round(((raw?.powerMonitor?.pollIntervalMs ?? 720000) / 60000) * 10) / 10;
  const gatewayProvider = typeof raw?.magpie?.provider === 'string' ? raw.magpie.provider : null;
  const hasLocalOverride = fsImpl.existsSync(path.join(path.dirname(selectedConfig), 'leaderteam.local.json'));
  const readinessReady = detectedSoloKeys.length > 0 || hasLocalOverride || configSource === 'dsh-home' || configSource === 'explicit';
  const legacyPatchConflicts = detectLegacyProfilePatchConflicts({
    dshHome: effectiveDshHome,
    currentBundleRoot: REPO_ROOT,
    fsImpl,
  });
  const activeBundleConflicts = legacyPatchConflicts.filter(c => c.bundleInstalled || c.corruptedBlock);

  if (!validation.valid) {
    return {
      status: 'fail',
      configFile: selectedConfig,
      configSource,
      configValid: false,
      problems: validation.problems,
      legacyPatchConflicts,
      soloKeyEnvVarsPresent: detectedSoloKeys,
      gatewayProvider,
      powerMonitor: {
        enabled: powerEnabled,
        pollIntervalMinutes: pollMinutes,
        disableSnippet: '"powerMonitor": { "enabled": false }',
        privacyNote: 'Reads ONLY (onBattery, batteryPct) every 12m; set "powerMonitor": { "enabled": false } to disable.',
      },
      summary: `Invalid LeaderTeam config (${selectedConfig}): ${validation.problems.join('; ')}`,
    };
  }

  if (activeBundleConflicts.length > 0) {
    const conflictFiles = activeBundleConflicts.map(c => c.patchFile).join(', ');
    return {
      status: 'fail',
      configFile: selectedConfig,
      configSource,
      configValid: true,
      legacyPatchConflicts,
      soloKeyEnvVarsPresent: detectedSoloKeys,
      gatewayProvider,
      powerMonitor: {
        enabled: powerEnabled,
        pollIntervalMinutes: pollMinutes,
        disableSnippet: '"powerMonitor": { "enabled": false }',
        privacyNote: 'Reads ONLY (onBattery, batteryPct) every 12m; set "powerMonitor": { "enabled": false } to disable.',
      },
      summary: `Legacy V2.1 profile patch conflict detected (${conflictFiles}): overrides installed dsh-leaderteam bundle entries. Run "npx lt-doctor --clean-legacy-patch" and restart DSH.`,
    };
  }

  const dshCredentialsFile = path.join(effectiveDshHome, '.credentials.yaml');
  const dshCredentialsPresent = fsImpl.existsSync(dshCredentialsFile);
  const desktopPatchFile = path.join(effectiveDshHome, 'profiles', 'desktop', 'cordis.patch.yml');
  const webPatchFile = path.join(effectiveDshHome, 'profiles', 'web', 'cordis.patch.yml');
  const existingProfilePatches = [desktopPatchFile, webPatchFile].filter(p => fsImpl.existsSync(p));
  const dshPatchHasProvider = existingProfilePatches.some(p => {
    try {
      return /\bllm-pi-ai\b/.test(fsImpl.readFileSync(p, 'utf8'));
    } catch {
      return false;
    }
  });
  const missingHostProviderSync = detectedSoloKeys.length === 0
    && existingProfilePatches.length > 0
    && !dshPatchHasProvider;

  const authSummary = detectedSoloKeys.length > 0
    ? `Solo-Key env detected (${detectedSoloKeys.join(', ')})`
    : (hasLocalOverride || configSource === 'dsh-home'
      ? `Gateway/profile config present (provider="${gatewayProvider ?? 'custom'}")${missingHostProviderSync ? '; note: DSH profile cordis.patch.yml has no llm-pi-ai provider entry yet — start DSH once or save provider credentials in Open Leader Team Settings' : ''}`
      : `Using example repo config (set DEEPSEEK_API_KEY for Solo-Key quick start or create config/leaderteam.local.json for gateway "${gatewayProvider ?? 'magpie'}")`);

  return {
    status: readinessReady && !missingHostProviderSync ? 'pass' : 'warn',
    configFile: selectedConfig,
    configSource,
    configValid: true,
    governanceMode: validation.config.governance?.mode ?? 'autonomous',
    soloKeyEnvVarsPresent: detectedSoloKeys,
    gatewayProvider,
    hasLocalOverride,
    dshCredentialsPresent,
    dshPatchHasProvider: existingProfilePatches.length > 0 ? dshPatchHasProvider : null,
    powerMonitor: {
      enabled: powerEnabled,
      pollIntervalMinutes: pollMinutes,
      disableSnippet: '"powerMonitor": { "enabled": false }',
      privacyNote: 'Battery monitor reads ONLY (onBattery, batteryPct) every 12m with zero hardware/serial reads. Set "powerMonitor": { "enabled": false } to turn off.',
    },
    summary: `Config valid (${configSource}, mode=${validation.config.governance?.mode ?? 'autonomous'}). ${authSummary}. powerMonitor.enabled=${powerEnabled} (reads ONLY (onBattery, batteryPct) every ${pollMinutes}m; disable via "powerMonitor": { "enabled": false }).`,
  };
}

/**
 * Core pre-flight diagnostic runner (pure/fast local checks, ~50ms typical, zero console popups).
 */
export function runDoctorChecks(options = {}) {
  const startedAt = Date.now();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;

  const nodeRuntime = checkNodeRuntime(options.nodeVersion ?? process.versions.node);
  const dshHost = checkDshHostCompatibility({
    checkHost: options.checkHost ?? null,
    supportedCoreVersions: options.supportedCoreVersions ?? null,
    policy: options.strictVerified ? 'strict-verified' : (options.policy ?? 'adaptive'),
    platform,
    env,
    fsImpl,
  });
  const platformEnvironment = checkPlatformEnvironment({
    platform,
    workspace: options.workspace ?? process.cwd(),
    env,
    username: options.username ?? null,
    fsImpl,
    execFileSyncImpl: options.execFileSyncImpl ?? execFileSync,
    procMeminfoPath: options.procMeminfoPath ?? '/proc/meminfo',
    cgroupRoot: options.cgroupRoot ?? '/sys/fs/cgroup',
    osReleaseText: options.osReleaseText ?? null,
  });
  const configuration = checkConfigurationAndSoloKey({
    configPath: options.configPath ?? null,
    dshHome: options.dshHome ?? null,
    env,
    fsImpl,
  });

  const statuses = [nodeRuntime.status, dshHost.status, platformEnvironment.status, configuration.status];
  const overallStatus = statuses.includes('fail') ? 'fail' : (statuses.includes('warn') ? 'warn' : 'pass');

  return {
    ok: overallStatus !== 'fail',
    status: overallStatus,
    durationMs: Math.max(0, Date.now() - startedAt),
    platform,
    checks: {
      nodeRuntime,
      dshHost,
      platformEnvironment,
      configuration,
    },
  };
}

function formatHumanReport(report) {
  const icon = s => (s === 'pass' ? '[PASS]' : s === 'warn' ? '[WARN]' : '[FAIL]');
  const lines = [
    `LeaderTeam V2.2 Doctor (${report.platform}, ${report.durationMs}ms) — Overall: ${report.status.toUpperCase()}`,
    '',
    `${icon(report.checks.nodeRuntime.status)} Node.js Runtime: ${report.checks.nodeRuntime.summary}`,
    `${icon(report.checks.dshHost.status)} DSH Host & Pipeline: ${report.checks.dshHost.summary}`,
    `${icon(report.checks.platformEnvironment.status)} Platform & Sandbox: ${report.checks.platformEnvironment.summary}`,
  ];
  if (report.checks.platformEnvironment.aclRisky && Array.isArray(report.checks.platformEnvironment.remediationCommands)) {
    lines.push('  Remediation (ready to paste):');
    for (const cmd of report.checks.platformEnvironment.remediationCommands) {
      lines.push(`    ${cmd}`);
    }
  }
  lines.push(`${icon(report.checks.configuration.status)} Config & Solo-Key: ${report.checks.configuration.summary}`);
  lines.push(`  Privacy & Battery Toggle: ${report.checks.configuration.powerMonitor.privacyNote}`);
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const opts = { json: false, help: false, cleanLegacyPatch: false, compatibilityMatrix: false, strictVerified: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--clean-legacy-patch') opts.cleanLegacyPatch = true;
    else if (a === '--compatibility-matrix' || a === '--matrix') opts.compatibilityMatrix = true;
    else if (a === '--strict-verified') opts.strictVerified = true;
    else if (a === '--workspace' && argv[i + 1]) opts.workspace = argv[++i];
    else if (a === '--dsh-home' && argv[i + 1]) opts.dshHome = argv[++i];
    else if (a === '--config' && argv[i + 1]) opts.configPath = argv[++i];
    else if (a === '--check-host' && argv[i + 1]) opts.checkHost = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return opts;
}

function printUsage() {
  console.log([
    'Usage: lt-doctor [options]',
    '',
    'Options:',
    '  --json                      Output machine-readable JSON',
    '  --compatibility-matrix      Print the DSH Host Compatibility Matrix and exit',
    '  --strict-verified           Require exact verified version list instead of adaptive contract policy',
    '  --workspace <dir>           Target workspace folder to inspect (Windows ACL / sandbox)',
    '  --dsh-home <dir>            Override DSH_HOME directory',
    '  --config <file>             Explicit leaderteam.config.json path to validate',
    '  --check-host <dir>          Isolated compatibility probe against a DSH app/module directory',
    '  --clean-legacy-patch        Backup and remove legacy V2.1 cordis.patch.yml LeaderTeam blocks',
    '  -h, --help                  Show this help message',
  ].join('\n'));
}

function isMainCliModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const selfPath = fileURLToPath(metaUrl);
  const resolvedArgv = path.resolve(argv1);
  if (resolvedArgv === selfPath) return true;
  try {
    return fs.realpathSync(resolvedArgv) === fs.realpathSync(selfPath);
  } catch {
    return false;
  }
}

if (isMainCliModule(import.meta.url)) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.help) {
      printUsage();
      process.exit(0);
    }
    if (cli.compatibilityMatrix) {
      if (cli.json) {
        console.log(JSON.stringify(getHostCompatibilityMatrix(), null, 2));
      } else {
        console.log(renderCompatibilityMatrixMarkdown());
      }
      process.exit(0);
    }
    let cleanedPatches = [];
    if (cli.cleanLegacyPatch) {
      const targetHome = cli.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
      cleanedPatches = cleanLegacyProfilePatches({ dshHome: targetHome });
    }
    const report = runDoctorChecks(cli);
    if (cleanedPatches.length > 0) {
      report.cleanedLegacyPatches = cleanedPatches;
    }
    if (cli.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (cleanedPatches.length > 0) {
        console.log(`Cleaned ${cleanedPatches.length} legacy LeaderTeam profile patch block(s): ${cleanedPatches.map(c => c.patchFile).join(', ')}`);
      }
      console.log(formatHumanReport(report));
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`lt-doctor error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
