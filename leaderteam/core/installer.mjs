// Cross-platform One-Click Installer Engine for LeaderTeam (Issue #2).
// Auto-discovers Official DSH Desktop (including custom Windows paths such as D:\Apps\DeepSeek-Harness,
// Registry Uninstall entries, env vars, and running processes) & CLI/Web installations, initializes zero-state
// `profiles/desktop` before `--profile desktop` plugin add, checks dependencies & compatibility,
// cleans legacy V2.1 patches and stale manual `leaderteam-*` insert rows while preserving provider/model patches
// and enabling `tool-web`, filters platform release tags (`windows-vX.Y.Z` vs `linux-vX.Y.Z`),
// installs `.tgz` or local package, provisions optional starter API Key into `.credentials.yaml` + `.env` + `llm-pi-ai`,
// translates technical errors into beginner-friendly Chinese hints, and launches the client directly.
// Pure Node.js ESM, zero external dependencies, Apache-2.0.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_PATCH_BEGIN,
  LEGACY_PATCH_END,
  detectLegacyProfilePatchConflicts,
  cleanLegacyProfilePatches,
} from './legacy-patch-guard.mjs';
import {
  VERIFIED_CORE_VERSIONS,
  SUPPORTED_DSH_ENGINE_RANGE,
  compareDshSemver,
  satisfiesDshRange,
  evaluateHostCompatibility,
  getHostCompatibilityMatrix,
} from './host-compat.mjs';
import {
  QUICK_PROVIDER_PRESETS,
  persistProviderApiKey,
} from './onboarding.mjs';
import {
  SOLO_PROVIDER_PRESETS,
  buildSoloKeyStarterConfig,
  buildSoloProviderSettingsTemplates,
} from './solo-key.mjs';
import { resolveModelTarget, syncUpstreamModelsToDshSettings } from './upstream-models.mjs';
import { loadConfig } from './config.mjs';
import { writeFileAtomic } from './store.mjs';
import {
  UPDATE_TRACKS,
  assertPlatformReleaseTagCompatible,
  checkForUpdates,
  downloadAndVerifyReleaseTarball,
  inspectTgzPackage,
  checkCandidatePackageCompatibility,
  computeFileSha256,
} from './updater.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

export { UPDATE_TRACKS };
export const checkReleaseUpdates = checkForUpdates;

const WINDOWS_UNINSTALL_REGISTRY_ROOTS = Object.freeze([
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]);

const WINDOWS_DRIVE_SUBPATHS = Object.freeze([
  ['Apps', 'DeepSeek-Harness'],
  ['Apps', 'DeepSeek Harness'],
  ['Program Files', 'DeepSeek Harness'],
  ['Program Files', 'DeepSeek-Harness'],
  ['DeepSeek-Harness'],
  ['DeepSeek Harness'],
  ['Programs', 'DeepSeek-Harness'],
  ['Programs', 'DeepSeek Harness'],
]);

const DESKTOP_PROFILE_PKG_JSON =
  '{"name":"dsh-profile-desktop","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}\n';

/**
 * Idempotently initialize `<dshHome>/profiles/desktop/package.json` and `cordis.patch.yml`
 * on a brand-new `$DSH_HOME` where Official DeepSeek Harness Desktop has never been opened yet,
 * preventing `dsh plugin --profile desktop add` from exiting with code 1 (`Open DeepSeek Harness Desktop once to initialize its profile...`).
 */
export function ensureDesktopProfileInitialized(dshHome, fsImpl = fs) {
  const desktopProfileDir = path.join(path.resolve(dshHome), 'profiles', 'desktop');
  const pkgPath = path.join(desktopProfileDir, 'package.json');
  const patchPath = path.join(desktopProfileDir, 'cordis.patch.yml');
  fsImpl.mkdirSync(desktopProfileDir, { recursive: true });
  let createdPackageJson = false;
  let createdPatchYml = false;
  if (!fsImpl.existsSync(pkgPath)) {
    fsImpl.writeFileSync(pkgPath, DESKTOP_PROFILE_PKG_JSON, 'utf8');
    createdPackageJson = true;
  }
  if (!fsImpl.existsSync(patchPath)) {
    fsImpl.writeFileSync(patchPath, '[]\n', 'utf8');
    createdPatchYml = true;
  }
  return { desktopProfileDir, pkgPath, patchPath, createdPackageJson, createdPatchYml };
}

export function resolveDefaultDshHomePath(platform = process.platform, env = process.env) {
  if (env?.DSH_HOME && String(env.DSH_HOME).trim()) {
    return path.resolve(String(env.DSH_HOME).trim());
  }
  const home = env?.USERPROFILE || env?.HOME || os.homedir();
  return home ? path.join(home, '.dsh') : path.resolve('.dsh');
}

/**
 * Translate technical CLI / OS / pnpm / DSH errors into clear, non-technical Chinese guidance.
 */
export function translateInstallErrorToPlainChinese(rawErrorOrMessage) {
  const msg = String(rawErrorOrMessage instanceof Error ? rawErrorOrMessage.message : rawErrorOrMessage ?? '').trim();
  const lower = msg.toLowerCase();

  if (lower.includes('platform_release_tag_mismatch')) {
    return {
      code: 'PLATFORM_RELEASE_TAG_MISMATCH',
      title: '跨平台发行标签不匹配',
      friendlyMessage: msg,
      suggestion: '请选用与当前操作系统一致的发行标签（Windows 使用 windows-vX.Y.Z，Linux 使用 linux-vX.Y.Z），或留空自动匹配当前系统。',
      rawDetail: msg,
    };
  }
  if (lower.includes('sha256_mismatch') || lower.includes('sha-256')) {
    return {
      code: 'SHA256_MISMATCH',
      title: '安装包完整性校验未通过',
      friendlyMessage: '下载的安装包与官方校验值不一致（可能是网络中断或缓存损坏导致下载不完整）。',
      suggestion: '请点击“重新下载并安装”，或检查网络代理后重试。',
      rawDetail: msg,
    };
  }
  if (lower.includes('incompatible-version') || lower.includes('host_incompatible') || lower.includes('not a verified core')) {
    return {
      code: 'INCOMPATIBLE_HOST',
      title: '当前 DeepSeek Harness 版本暂不兼容',
      friendlyMessage: '检测到您本机的 DeepSeek Harness 客户端版本过旧（低于 0.2.2-alpha.2）或不在当前安装包支持范围内。',
      suggestion: '请先将官方 DeepSeek Harness 客户端更新至 0.2.2-rc.1 / 0.2.2-rc.5 或更新版本，然后再点击安装。',
      rawDetail: msg,
    };
  }
  if (
    lower.includes('ebusy') ||
    lower.includes('eperm') ||
    lower.includes('still running in this profile') ||
    lower.includes('deepseek harness.exe') ||
    lower.includes('正在运行') ||
    lower.includes('lock')
  ) {
    return {
      code: 'CLIENT_RUNNING_OR_LOCKED',
      title: '检测到 DeepSeek Harness 正在运行或目录被占用',
      friendlyMessage: '安装或更新桌面端插件前，需要先完全退出正在运行的 DeepSeek Harness 客户端（含右下角系统托盘图标）。',
      suggestion: '请先关闭 DeepSeek Harness 窗口并右键退出托盘程序，然后点击“重新扫描”或“立即一键安装”。',
      rawDetail: msg,
    };
  }
  if (lower.includes('pnpm') && (lower.includes('enoent') || lower.includes('not found') || lower.includes('不是内部或外部命令'))) {
    return {
      code: 'PNPM_MISSING',
      title: '缺少包管理组件 pnpm',
      friendlyMessage: 'DSH 命令行安装插件需要系统具备 pnpm 工具。',
      suggestion: '安装器支持自动启用 Node 内置的 corepack pnpm；若权限受限，可在终端执行一次 corepack enable pnpm 后重试。',
      rawDetail: msg,
    };
  }
  if (lower.includes('desktop') && (lower.includes('not initialized') || lower.includes('no such file') || lower.includes('profiles/desktop'))) {
    return {
      code: 'DESKTOP_PROFILE_UNINITIALIZED',
      title: '官方桌面端尚未完成首次初始化',
      friendlyMessage: '新安装的 DeepSeek Harness 桌面客户端需要先打开一次以生成本地配置目录，然后才能安装插件。',
      suggestion: '请先双击打开一次 DeepSeek Harness 客户端，看到主界面后将其完全关闭，再回到本页面点击安装。',
      rawDetail: msg,
    };
  }
  if (lower.includes('eacces') || lower.includes('permission denied')) {
    return {
      code: 'PERMISSION_DENIED',
      title: '目录写入权限不足',
      friendlyMessage: '当前用户没有修改 DSH 插件目录或配置文件的权限。',
      suggestion: '请确认当前登录账户对 ~/.dsh 目录拥有读写权限（Windows 下避免将数据目录放在受保护系统盘根目录）。',
      rawDetail: msg,
    };
  }
  if (lower.includes('etimedout') || lower.includes('fetch failed') || lower.includes('network') || lower.includes('econnreset')) {
    return {
      code: 'NETWORK_ERROR',
      title: '网络连接超时或受阻',
      friendlyMessage: '连接 GitHub Releases 或包仓库时超时。',
      suggestion: '请检查本机网络连接，或直接选择已下载到本地电脑的 dsh-leaderteam-*.tgz 安装包进行离线安装。',
      rawDetail: msg,
    };
  }
  return {
    code: 'INSTALL_ERROR',
    title: '安装过程中遇到问题',
    friendlyMessage: '自动安装步骤未能完成，您的原有配置未被破坏。',
    suggestion: '请查看下方详细诊断信息，或使用“选择本地 .tgz 包”重试。',
    rawDetail: msg,
  };
}

function normalizeWindowsDirCandidate(rawVal) {
  let s = String(rawVal ?? '').trim();
  if (!s) return null;
  s = s.replace(/,\s*-?\d+\s*$/, '').trim();
  if (s.startsWith('"')) {
    const endQuote = s.indexOf('"', 1);
    if (endQuote > 1) s = s.slice(1, endQuote).trim();
    else s = s.replace(/^"+|"+$/g, '').trim();
  } else {
    const exeMatch = /^([A-Za-z]:\\.+?\.(?:exe|ico))(?:\s+.*)?$/i.exec(s);
    if (exeMatch) s = exeMatch[1].trim();
  }
  s = s.replace(/[\\/]+$/, '');
  if (!/^[A-Za-z]:\\/.test(s) && !s.startsWith('\\\\')) return null;
  if (/\\system32\\msiexec(?:\.exe)?$/i.test(s)) return null;
  if (/\.(?:exe|ico|cmd|bat)$/i.test(s)) {
    return path.win32.dirname(s);
  }
  return s;
}

/**
 * Pure parser for `reg.exe query` Uninstall output on Windows.
 */
export function parseWindowsUninstallRegistryOutput(rawText) {
  const dirs = [];
  const matchedSubkeys = [];
  let currentSubkey = null;
  let currentDisplayName = '';
  let currentBlockDirs = [];

  const flushBlock = () => {
    if (!currentSubkey) return;
    const isLegacyDataElem = /\bdsh\s+desktop\b/i.test(currentDisplayName) && !/deepseek[-\s]*harness/i.test(currentDisplayName);
    if (!isLegacyDataElem) {
      for (const d of currentBlockDirs) {
        if (d && !dirs.includes(d)) dirs.push(d);
      }
      if (!matchedSubkeys.includes(currentSubkey)) matchedSubkeys.push(currentSubkey);
    }
    currentSubkey = null;
    currentDisplayName = '';
    currentBlockDirs = [];
  };

  for (const rawLine of String(rawText ?? '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^End of search:/i.test(trimmed)) continue;
    if (/^HKEY_(?:CURRENT_USER|LOCAL_MACHINE|USERS|CLASSES_ROOT)\\/i.test(trimmed)) {
      flushBlock();
      currentSubkey = trimmed;
      continue;
    }
    const valMatch = /^([A-Za-z0-9_]+)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(trimmed);
    if (!valMatch) continue;
    const [, keyName, rawVal] = valMatch;
    const lowerKey = keyName.toLowerCase();
    if (lowerKey === 'displayname') {
      currentDisplayName = rawVal.trim();
      continue;
    }
    if (
      lowerKey === 'installlocation' ||
      lowerKey === 'displayicon' ||
      lowerKey === 'uninstallstring' ||
      lowerKey === 'quietuninstallstring' ||
      lowerKey === 'apppath'
    ) {
      const cand = normalizeWindowsDirCandidate(rawVal);
      if (cand) {
        if (currentSubkey) currentBlockDirs.push(cand);
        else if (!dirs.includes(cand)) dirs.push(cand);
      }
    }
  }
  flushBlock();
  return { dirs, matchedSubkeys };
}

export function isOfficialDesktopProcessRunning(platform = process.platform, spawnSyncImpl = spawnSync) {
  try {
    if (platform === 'win32') {
      const res = spawnSyncImpl('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
      return String(res?.stdout || '').toLowerCase().includes('deepseek harness.exe');
    }
  } catch {}
  return false;
}

/**
 * Discover all candidate Official DeepSeek Harness Desktop directories on Windows (`win32`):
 * 1) `DSH_DESKTOP_DIR` / `DSH_APP_DIR` / `LT_DSH_APP` env vars
 * 2) `%LOCALAPPDATA%` / `%ProgramFiles%` + drive scan across existing `C:`..`Z:` (`D:\Apps\DeepSeek-Harness`, etc.)
 * 3) Windows Registry `Uninstall` keys (`HKCU`, `HKLM`, `WOW6432Node`) with two-phase subkey expansion
 * 4) Running `DeepSeek Harness.exe` executable path when running
 */
export function discoverWindowsDesktopCandidates({
  env = process.env,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  driveLetters = null,
} = {}) {
  const candidates = [];
  const addCandidate = raw => {
    if (!raw || typeof raw !== 'string') return;
    const trimmed = raw.trim().replace(/^"+|"+$/g, '');
    if (!trimmed) return;
    const dir = /\.(?:exe|cmd|bat)$/i.test(trimmed) ? path.dirname(trimmed) : trimmed;
    const resolved = /^[A-Za-z]:[\\/]/.test(dir) ? path.win32.normalize(dir) : path.resolve(dir);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  for (const envKey of ['DSH_DESKTOP_DIR', 'DSH_APP_DIR', 'LT_DSH_APP']) {
    if (env?.[envKey]) addCandidate(env[envKey]);
  }
  if (env?.LOCALAPPDATA) {
    addCandidate(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
    addCandidate(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek-Harness'));
  }
  if (env?.PROGRAMFILES || env?.ProgramFiles) {
    const pf = env.PROGRAMFILES || env.ProgramFiles;
    addCandidate(path.join(pf, 'DeepSeek Harness'));
    addCandidate(path.join(pf, 'DeepSeek-Harness'));
  }
  if (env?.['ProgramFiles(x86)']) {
    addCandidate(path.join(env['ProgramFiles(x86)'], 'DeepSeek Harness'));
    addCandidate(path.join(env['ProgramFiles(x86)'], 'DeepSeek-Harness'));
  }

  const letters = Array.isArray(driveLetters)
    ? driveLetters.map(l => String(l).replace(/:.*$/, '').toUpperCase())
    : Array.from({ length: 24 }, (_, idx) => String.fromCharCode(67 + idx));

  for (const letter of letters) {
    const driveRoot = `${letter}:\\`;
    let rootExists = false;
    try { rootExists = fsImpl.existsSync(driveRoot); } catch { rootExists = false; }
    if (!rootExists) continue;
    for (const segs of WINDOWS_DRIVE_SUBPATHS) {
      addCandidate(path.win32.join(driveRoot, ...segs));
    }
  }

  if (typeof spawnSyncImpl === 'function') {
    const subkeysToExpand = new Set();
    for (const regRoot of WINDOWS_UNINSTALL_REGISTRY_ROOTS) {
      for (const term of ['DeepSeek Harness', 'DeepSeek-Harness']) {
        try {
          const res = spawnSyncImpl('reg.exe', ['query', regRoot, '/s', '/f', term], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 3500,
          });
          if (res?.stdout) {
            const parsed = parseWindowsUninstallRegistryOutput(res.stdout);
            for (const d of parsed.dirs) addCandidate(d);
            for (const sk of parsed.matchedSubkeys) subkeysToExpand.add(sk);
          }
        } catch {}
      }
    }
    for (const subkey of subkeysToExpand) {
      try {
        const fullRes = spawnSyncImpl('reg.exe', ['query', subkey], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 2500,
        });
        if (fullRes?.stdout) {
          const parsed = parseWindowsUninstallRegistryOutput(fullRes.stdout);
          for (const d of parsed.dirs) addCandidate(d);
        }
      } catch {}
    }

    if (isOfficialDesktopProcessRunning('win32', spawnSyncImpl)) {
      try {
        const psRes = spawnSyncImpl(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            "(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique)",
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 4000 },
        );
        for (const line of String(psRes?.stdout || '').split(/\r?\n/)) {
          if (line.trim()) addCandidate(line.trim());
        }
      } catch {}
    }
  }

  return candidates;
}

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
    let cursor = index;
    for (const seg of relPosixPath.split('/').filter(Boolean)) {
      cursor = cursor?.files?.[seg];
      if (!cursor) return null;
    }
    if (cursor.unpacked) {
      return fsImpl.readFileSync(path.join(`${asarFile}.unpacked`, ...relPosixPath.split('/').filter(Boolean)), 'utf8');
    }
    if (typeof cursor.size !== 'number' || cursor.offset === undefined) return null;
    const dataOffset = 8 + headerPickleSize + Number(cursor.offset);
    if (!Number.isFinite(dataOffset) || cursor.size < 0 || cursor.size > 16 * 1024 * 1024) return null;
    const buf = Buffer.alloc(cursor.size);
    if (fsImpl.readSync(fd, buf, 0, cursor.size, dataOffset) < cursor.size) return null;
    return buf.toString('utf8');
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
      return fsImpl.readFileSync(path.join(basePath, ...relPosixPath.split('/').filter(Boolean)), 'utf8');
    }
    if (st.isFile() && basePath.toLowerCase().endsWith('.asar')) {
      return readFileFromAsarArchive(basePath, relPosixPath, fsImpl);
    }
  } catch {}
  return null;
}

function probeDshHostCompatibilityAt(targetDir, fsImpl = fs) {
  const resolved = path.resolve(targetDir);
  let runtimeDesktopVersion = null;
  const runtimeJsonFile = path.join(resolved, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
  if (fsImpl.existsSync(runtimeJsonFile)) {
    try {
      const rt = JSON.parse(fsImpl.readFileSync(runtimeJsonFile, 'utf8'));
      if (typeof rt?.desktopVersion === 'string') runtimeDesktopVersion = rt.desktopVersion.trim();
    } catch {}
  }

  const probes = [
    { base: resolved, pkgRel: 'package.json', pipeRel: 'lib/pipeline.js', desktopPkgRel: null },
    { base: resolved, pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json', pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js', desktopPkgRel: 'package.json' },
    { base: path.join(resolved, 'lib'), pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json', pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js', desktopPkgRel: null },
    { base: path.join(resolved, 'resources', 'app', 'dsh'), pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json', pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js', desktopPkgRel: null },
    { base: path.join(resolved, 'resources', 'app.asar'), pkgRel: 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json', pipeRel: 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js', desktopPkgRel: 'package.json' },
    { base: path.join(resolved, 'resources', 'app.asar'), pkgRel: 'node_modules/@deepseek-ai/dsh-tools/package.json', pipeRel: 'node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js', desktopPkgRel: 'package.json' },
  ];

  for (const p of probes) {
    const pkgTxt = readCandidateText(p.base, p.pkgRel, fsImpl);
    if (!pkgTxt) continue;
    let toolsPkg;
    try { toolsPkg = JSON.parse(pkgTxt); } catch { continue; }
    if (toolsPkg?.name && toolsPkg.name !== '@deepseek-ai/dsh-tools') continue;
    if (!toolsPkg?.version) continue;

    let desktopVersion = runtimeDesktopVersion;
    if (!desktopVersion && p.desktopPkgRel) {
      const dTxt = readCandidateText(p.base, p.desktopPkgRel, fsImpl);
      if (dTxt) {
        try {
          const dPkg = JSON.parse(dTxt);
          if (dPkg?.name === '@deepseek-ai/dsh-desktop' && typeof dPkg.version === 'string') {
            desktopVersion = dPkg.version.trim();
          }
        } catch {}
      }
    }

    const fullPipe = readCandidateText(p.base, p.pipeRel, fsImpl) ?? '';
    const idx = fullPipe.indexOf('dispatchToolBody');
    const slice = idx >= 0 && fullPipe.includes('resolveExecution') ? fullPipe.slice(idx, idx + 8192) : '';
    return evaluateHostCompatibility({
      toolsVersion: String(toolsPkg.version),
      desktopVersion,
      pipelineSource: slice,
      supportedVersions: VERIFIED_CORE_VERSIONS,
      supportedRange: SUPPORTED_DSH_ENGINE_RANGE,
      policy: 'adaptive',
    });
  }

  return {
    status: 'fail',
    classification: 'NOT_FOUND',
    toolsVersion: runtimeDesktopVersion,
    desktopVersion: runtimeDesktopVersion,
    productionAllowed: false,
    summary: `未在目录 "${resolved}" 下找到有效的 @deepseek-ai/dsh-tools 运行时组件。`,
  };
}

function extractYamlItemIdAndName(lines) {
  let id = null;
  let name = null;
  if (!Array.isArray(lines) || lines.length === 0) return { id, name };
  const firstId = /^\s*-\s*id\s*:\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/.exec(lines[0]);
  if (firstId) id = firstId[1].trim();
  const baseIndentMatch = /^(\s*)-\s/.exec(lines[0]);
  const propIndent = (baseIndentMatch ? baseIndentMatch[1].length : 0) + 2;
  const idPropRe = new RegExp(`^\\s{${propIndent}}id\\s*:\\s*['"]?([^'"#\\r\\n]+?)['"]?\\s*(?:#.*)?$`);
  const namePropRe = new RegExp(`^\\s{${propIndent}}name\\s*:\\s*['"]?([^'"#\\r\\n]+?)['"]?\\s*(?:#.*)?$`);
  for (let i = 1; i < lines.length; i++) {
    if (!id) {
      const im = idPropRe.exec(lines[i]);
      if (im) id = im[1].trim();
    }
    if (!name) {
      const nm = namePropRe.exec(lines[i]);
      if (nm) name = nm[1].trim();
    }
    if (id && name) break;
  }
  return { id, name };
}

function isStaleLegacyLeaderTeamInsertItem(lines) {
  const { id, name } = extractYamlItemIdAndName(lines);
  const blockText = lines.join('\n');
  if (id && /^(?:leaderteam(?:-[A-Za-z0-9_-]+)?|dsh-leaderteam|preset-leaderteam|preset-lt-member-[A-Za-z0-9_-]+)$/i.test(id)) {
    return true;
  }
  if (id === 'tool-executor-native' && /(?:leaderteam|entry-native-executor)/i.test(`${name || ''}\n${blockText}`)) {
    return true;
  }
  if (name && /(?:leaderteam\/(?:entry-core|entry-native-executor|entry-lead|plugins\/)|^dsh-leaderteam(?:\/|$))/i.test(name)) {
    return true;
  }
  return false;
}

function isToolWebAlreadyEnabled(lines) {
  const text = lines.join('\n');
  if (/^\s+disabled\s*:\s*true\b/m.test(text)) return false;
  return /\bfetch\s*:\s*true\b/.test(text) && /\bsearchTimeoutMs\s*:\s*\d+\b/.test(text);
}

/**
 * Pure Cordis YAML patch hygiene helper for `~/.dsh/profiles/desktop/cordis.patch.yml`.
 */
export function sanitizeDesktopCordisPatchText(rawText) {
  const normalizedOriginal = String(rawText ?? '').replace(/\r\n/g, '\n');
  const lines = normalizedOriginal.split('\n');

  let removedLegacyItems = 0;
  let markersStripped = false;
  const cleanedLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === LEGACY_PATCH_BEGIN ||
      trimmed.startsWith('# >>> leaderteam') ||
      trimmed === LEGACY_PATCH_END ||
      /^# leaderteam-original-empty-array:\s*[A-Za-z0-9+/=]+\s*$/.test(trimmed)
    ) {
      markersStripped = true;
      continue;
    }
    if (/^\[\]\s*(?:#.*)?$/.test(trimmed) && !line.startsWith(' ')) {
      continue;
    }
    cleanedLines.push(line);
  }

  const headerLines = [];
  const topBlocks = [];
  let pendingComments = [];
  let currentItemLines = null;
  let seenFirstItem = false;

  const flushCurrent = () => {
    if (currentItemLines) {
      while (currentItemLines.length > 1 && currentItemLines[currentItemLines.length - 1].trim() === '') {
        currentItemLines.pop();
      }
      topBlocks.push({ comments: pendingComments, lines: currentItemLines });
      pendingComments = [];
      currentItemLines = null;
    }
  };

  for (const line of cleanedLines) {
    if (/^-\s/.test(line)) {
      flushCurrent();
      seenFirstItem = true;
      currentItemLines = [line];
    } else if (!seenFirstItem) {
      headerLines.push(line);
    } else if (/^#/.test(line)) {
      flushCurrent();
      pendingComments.push(line);
    } else if (currentItemLines) {
      currentItemLines.push(line);
    } else if (line.trim() !== '') {
      pendingComments.push(line);
    }
  }
  flushCurrent();

  const keptBlocks = [];
  let toolWebConfigured = false;

  for (const block of topBlocks) {
    const firstLine = block.lines[0] || '';

    if (/^-\s+insert\s*:\s*(?:#.*)?$/.test(firstLine)) {
      const childIndentMatch = block.lines.slice(1).map(l => /^([ \t]+)-\s/.exec(l)).find(Boolean);
      if (!childIndentMatch) {
        keptBlocks.push(block);
        continue;
      }
      const childIndentLen = childIndentMatch[1].length;
      const childStartRe = new RegExp(`^[ \\t]{${childIndentLen}}-\\s`);
      const subItems = [];
      let curSub = null;
      const insertHeaderExtras = [];
      for (let i = 1; i < block.lines.length; i++) {
        const l = block.lines[i];
        if (childStartRe.test(l)) {
          if (curSub) subItems.push(curSub);
          curSub = [l];
        } else if (curSub) {
          curSub.push(l);
        } else {
          insertHeaderExtras.push(l);
        }
      }
      if (curSub) subItems.push(curSub);

      const keptSubs = [];
      for (const sub of subItems) {
        if (isStaleLegacyLeaderTeamInsertItem(sub)) {
          removedLegacyItems++;
        } else {
          keptSubs.push(sub);
        }
      }
      if (keptSubs.length > 0) {
        keptBlocks.push({
          comments: block.comments,
          lines: [firstLine, ...insertHeaderExtras, ...keptSubs.flat()],
        });
      }
      continue;
    }

    const { id, name } = extractYamlItemIdAndName(block.lines);
    const blockText = block.lines.join('\n');

    if (id && /^(?:leaderteam(?:-[A-Za-z0-9_-]+)?|dsh-leaderteam|preset-leaderteam|preset-lt-member-[A-Za-z0-9_-]+)$/i.test(id)) {
      removedLegacyItems++;
      continue;
    }
    if (
      id === 'tool-executor-native' &&
      (/^\s+disabled\s*:\s*true\b/m.test(blockText) || /(?:leaderteam|entry-native-executor)/i.test(`${name || ''}\n${blockText}`))
    ) {
      removedLegacyItems++;
      continue;
    }

    if (id === 'tool-web') {
      toolWebConfigured = true;
      if (isToolWebAlreadyEnabled(block.lines)) {
        keptBlocks.push(block);
      } else {
        const nextToolWebLines = ['- id: tool-web'];
        if (name) nextToolWebLines.push(`  name: ${JSON.stringify(name)}`);
        nextToolWebLines.push('  config: {fetch: true, searchTimeoutMs: 60000}');
        keptBlocks.push({ comments: block.comments, lines: nextToolWebLines });
      }
      continue;
    }

    keptBlocks.push(block);
  }

  let toolWebAdded = false;
  if (!toolWebConfigured) {
    keptBlocks.push({
      comments: [],
      lines: [
        '- id: tool-web',
        '  config: {fetch: true, searchTimeoutMs: 60000}',
      ],
    });
    toolWebAdded = true;
  }

  const cleanHeader = headerLines
    .filter(l => !/^#\s*(?:LeaderTeam rows for the DeepSeek Harness Desktop profile|Placeholders:\s*__LT_ROOT_URL__)/i.test(l.trim()));
  while (cleanHeader.length > 0 && cleanHeader[cleanHeader.length - 1].trim() === '') {
    cleanHeader.pop();
  }

  const outLines = [];
  if (cleanHeader.length > 0) outLines.push(...cleanHeader);
  for (const b of keptBlocks) {
    const cleanComments = b.comments.filter(
      c => !/^#\s*(?:LeaderTeam rows for the DeepSeek Harness Desktop profile|Placeholders:\s*__LT_ROOT_URL__)/i.test(c.trim()),
    );
    if (cleanComments.length > 0) outLines.push(...cleanComments);
    outLines.push(...b.lines);
  }

  const nextText = `${outLines.join('\n').trimEnd()}\n`;
  const changed = markersStripped || removedLegacyItems > 0 || nextText !== `${normalizedOriginal.trimEnd()}\n`;

  return {
    changed,
    removedLegacyItems,
    markersStripped,
    toolWebEnsured: true,
    toolWebAdded,
    text: nextText,
  };
}

/**
 * Post-install Desktop `cordis.patch.yml` hygiene on disk (with automatic backup when modified).
 */
export function sanitizeDesktopCordisPatch({
  dshHome,
  profile = 'desktop',
  fsImpl = fs,
} = {}) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  if (!fsImpl.existsSync(profileDir)) {
    return { updated: false, patchFile: path.join(profileDir, 'cordis.patch.yml'), removedLegacyItems: 0, backupFile: null };
  }
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const existed = fsImpl.existsSync(patchFile);
  const prevRaw = existed ? fsImpl.readFileSync(patchFile, 'utf8') : '';
  const res = sanitizeDesktopCordisPatchText(prevRaw);
  if (!res.changed && existed) {
    return {
      updated: false,
      patchFile,
      removedLegacyItems: 0,
      toolWebEnsured: true,
      backupFile: null,
    };
  }

  let backupFile = null;
  if (existed && prevRaw.trim().length > 0) {
    backupFile = `${patchFile}.bak-${Date.now()}`;
    fsImpl.writeFileSync(backupFile, prevRaw, 'utf8');
  }
  const tmpFile = `${patchFile}.tmp-${process.pid}-${Date.now()}`;
  fsImpl.writeFileSync(tmpFile, res.text, 'utf8');
  fsImpl.renameSync(tmpFile, patchFile);

  return {
    updated: true,
    patchFile,
    removedLegacyItems: res.removedLegacyItems,
    toolWebEnsured: true,
    backupFile,
  };
}

function commandExists(cmd, env = process.env, platform = process.platform, fsImpl = fs) {
  const pathSep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(env?.PATH ?? '').split(pathSep).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, `${cmd}${ext}`);
      try {
        if (fsImpl.existsSync(full)) return full;
      } catch {}
    }
  }
  return null;
}

function findBundledLocalTarballs(searchDirs = [], fsImpl = fs) {
  const found = [];
  const seen = new Set();
  for (const dir of searchDirs) {
    if (!dir || !fsImpl.existsSync(dir)) continue;
    try {
      for (const name of fsImpl.readdirSync(dir)) {
        if (!/^dsh-leaderteam-.*\.tgz$/i.test(name)) continue;
        const full = path.resolve(dir, name);
        if (seen.has(full)) continue;
        seen.add(full);
        try {
          const info = inspectTgzPackage(full, fsImpl);
          found.push({
            path: full,
            fileName: name,
            sizeBytes: fsImpl.statSync(full).size,
            version: info.version,
            track: info.track,
          });
        } catch {}
      }
    } catch {}
  }
  return found;
}

/**
 * Scan the machine for all DeepSeek Harness installations (Official Desktop + CLI/Web),
 * Node/pnpm readiness, installed LeaderTeam status, and legacy V2.1 patch conflicts.
 */
export function inspectInstallerEnvironment({
  repoRoot = DEFAULT_REPO_ROOT,
  dshHome = null,
  customDshPath = null,
  extraPackageDirs = [],
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  driveLetters = null,
} = {}) {
  const resolvedHome = dshHome ? path.resolve(dshHome) : resolveDefaultDshHomePath(platform, env);
  const targets = [];
  const desktopRunningNow = isOfficialDesktopProcessRunning(platform, spawnSyncImpl);

  const desktopDirs = [];
  const normalizedCustom = customDshPath
    ? (/\.(?:exe|cmd|bat)$/i.test(customDshPath.trim()) ? path.dirname(path.resolve(customDshPath.trim())) : path.resolve(customDshPath.trim()))
    : null;
  if (normalizedCustom && fsImpl.existsSync(normalizedCustom)) {
    desktopDirs.push(normalizedCustom);
  }
  if (platform === 'win32') {
    desktopDirs.push(
      ...discoverWindowsDesktopCandidates({ env, fsImpl, spawnSyncImpl, driveLetters }),
    );
  } else {
    if (env?.DSH_DESKTOP_DIR) desktopDirs.push(path.resolve(env.DSH_DESKTOP_DIR));
    if (env?.DSH_APP_DIR) desktopDirs.push(path.resolve(env.DSH_APP_DIR));
    if (env?.LT_DSH_APP) desktopDirs.push(path.resolve(env.LT_DSH_APP));
    desktopDirs.push('/opt/DeepSeek Harness', '/opt/deepseek-harness');
  }

  const seenDesktopRealPaths = new Set();
  for (const dir of desktopDirs) {
    if (!dir || !fsImpl.existsSync(dir)) continue;
    const dedupKey = platform === 'win32' ? path.win32.normalize(dir).toLowerCase() : path.resolve(dir);
    if (seenDesktopRealPaths.has(dedupKey)) continue;

    const winCli = path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    const unixCli = path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh');
    const exeWin = path.join(dir, 'DeepSeek Harness.exe');
    const exeLinux = path.join(dir, 'deepseek-harness');
    const hasAsarFile = fsImpl.existsSync(path.join(dir, 'resources', 'app.asar'));
    const isDesktopLayout = fsImpl.existsSync(winCli) || fsImpl.existsSync(unixCli) || fsImpl.existsSync(exeWin) || fsImpl.existsSync(exeLinux) || hasAsarFile;
    if (!isDesktopLayout) continue;
    seenDesktopRealPaths.add(dedupKey);

    const compat = probeDshHostCompatibilityAt(dir, fsImpl);
    if (compat.classification === 'NOT_FOUND' && dir !== normalizedCustom) continue;

    const desktopProfileDir = path.join(resolvedHome, 'profiles', 'desktop');
    const profileInitialized = fsImpl.existsSync(path.join(desktopProfileDir, 'package.json'));
    const installedLtPkg = path.join(desktopProfileDir, 'node_modules', 'dsh-leaderteam', 'package.json');
    let installedLtVersion = null;
    if (fsImpl.existsSync(installedLtPkg)) {
      try { installedLtVersion = JSON.parse(fsImpl.readFileSync(installedLtPkg, 'utf8')).version; } catch {}
    }
    const desktopHostCliJs = path.join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    const unpackedHostCliJs = path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

    targets.push({
      id: `desktop:${dir}`,
      kind: 'official-desktop',
      label: '官方 DeepSeek Harness 桌面客户端 (Desktop)',
      profile: 'desktop',
      installDir: dir,
      cliCommand: fsImpl.existsSync(winCli) ? winCli : (fsImpl.existsSync(unixCli) ? unixCli : null),
      desktopHostCliJs: hasAsarFile ? desktopHostCliJs : (fsImpl.existsSync(unpackedHostCliJs) ? unpackedHostCliJs : null),
      clientExecutable: fsImpl.existsSync(exeWin) ? exeWin : (fsImpl.existsSync(exeLinux) ? exeLinux : null),
      dshVersion: compat.desktopVersion || compat.toolsVersion,
      toolsVersion: compat.toolsVersion,
      compatible: Boolean(compat.productionAllowed),
      verified: compat.classification === 'VERIFIED',
      compatibility: {
        status: compat.status,
        classification: compat.classification,
        productionAllowed: compat.productionAllowed,
        summary: compat.summary,
      },
      profileInitialized,
      desktopRunning: desktopRunningNow,
      installedLtVersion,
      recommended: platform === 'win32' || dir === normalizedCustom,
    });
  }

  // 2. Check Web / CLI runtime candidates
  const cliDirs = [];
  if (normalizedCustom && fsImpl.existsSync(normalizedCustom)) {
    cliDirs.push(normalizedCustom);
  }
  const homeDir = env?.USERPROFILE || env?.HOME || os.homedir();
  if (homeDir) {
    const dshRuntimeCur = path.join(homeDir, '.local', 'share', 'dsh-runtime', 'current');
    if (fsImpl.existsSync(dshRuntimeCur)) cliDirs.push(dshRuntimeCur);
  }
  const pathDsh = commandExists('dsh', env, platform, fsImpl);
  if (pathDsh) {
    try {
      const real = fsImpl.realpathSync(pathDsh);
      const norm = real.replaceAll('\\', '/');
      const idx = norm.lastIndexOf('/node_modules/');
      cliDirs.push(idx > 0 ? real.slice(0, idx) : path.dirname(path.dirname(real)));
    } catch {}
  }

  const seenCliDirs = new Set();
  for (const dir of cliDirs) {
    if (!dir || !fsImpl.existsSync(dir)) continue;
    const dedupKey = platform === 'win32' ? path.win32.normalize(dir).toLowerCase() : path.resolve(dir);
    if (seenCliDirs.has(dedupKey) || seenDesktopRealPaths.has(dedupKey)) continue;
    seenCliDirs.add(dedupKey);

    const binJs = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const directBinJs = path.join(dir, 'lib', 'bin.js');
    const resolvedBinJs = fsImpl.existsSync(binJs) ? binJs : (fsImpl.existsSync(directBinJs) ? directBinJs : null);
    if (!resolvedBinJs && !pathDsh) continue;

    const compat = probeDshHostCompatibilityAt(dir, fsImpl);
    if (compat.classification === 'NOT_FOUND') continue;

    const webProfileDir = path.join(resolvedHome, 'profiles', 'web');
    const installedLtPkg = path.join(webProfileDir, 'node_modules', 'dsh-leaderteam', 'package.json');
    let installedLtVersion = null;
    if (fsImpl.existsSync(installedLtPkg)) {
      try { installedLtVersion = JSON.parse(fsImpl.readFileSync(installedLtPkg, 'utf8')).version; } catch {}
    }

    targets.push({
      id: `web:${dir}`,
      kind: 'dsh-web-cli',
      label: 'DeepSeek Harness Web / CLI 运行环境',
      profile: 'web',
      installDir: dir,
      cliCommand: resolvedBinJs || pathDsh,
      cliUsesNode: Boolean(resolvedBinJs),
      dshVersion: compat.toolsVersion,
      toolsVersion: compat.toolsVersion,
      compatible: Boolean(compat.productionAllowed),
      verified: compat.classification === 'VERIFIED',
      compatibility: {
        status: compat.status,
        classification: compat.classification,
        productionAllowed: compat.productionAllowed,
        summary: compat.summary,
      },
      profileInitialized: fsImpl.existsSync(webProfileDir),
      desktopRunning: false,
      installedLtVersion,
      recommended: targets.length === 0,
    });
  }

  const pnpmPath = commandExists('pnpm', env, platform, fsImpl);
  const corepackPath = commandExists('corepack', env, platform, fsImpl);
  const legacyConflicts = detectLegacyProfilePatchConflicts({ dshHome: resolvedHome, fsImpl });

  const hasLocalSourceBundle =
    fsImpl.existsSync(path.join(repoRoot, 'package.json')) &&
    fsImpl.existsSync(path.join(repoRoot, 'cordis.patch.yml'));
  let localSourceVersion = null;
  if (hasLocalSourceBundle) {
    try {
      localSourceVersion = JSON.parse(fsImpl.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
    } catch {}
  }

  const bundledTarballs = findBundledLocalTarballs(
    [process.cwd(), repoRoot, path.dirname(repoRoot), ...extraPackageDirs],
    fsImpl,
  );

  return {
    platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    dshHome: resolvedHome,
    pnpmAvailable: Boolean(pnpmPath),
    pnpmPath,
    corepackAvailable: Boolean(corepackPath),
    targets,
    legacyPatchConflicts: legacyConflicts,
    localSourceBundle: hasLocalSourceBundle
      ? { available: true, path: repoRoot, version: localSourceVersion }
      : { available: false, path: null, version: null },
    bundledTarballs,
    providerPresets: QUICK_PROVIDER_PRESETS,
    tracks: Object.values(UPDATE_TRACKS),
    compatibilityMatrix: getHostCompatibilityMatrix({
      currentHostVersion: targets[0]?.toolsVersion ?? null,
    }),
  };
}

function ensurePnpmInEnv({ dshHome, env = process.env }) {
  if (commandExists('pnpm', env)) return { ok: true, env };
  const corepack = commandExists('corepack', env);
  if (!corepack) {
    return { ok: false, env, reason: '未检测到 pnpm 或 corepack' };
  }
  const shimDir = path.join(dshHome, 'leaderteam', 'installer-bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const res = spawnSync(corepack, ['enable', '--install-directory', shimDir, 'pnpm'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    env,
  });
  const sep = process.platform === 'win32' ? ';' : ':';
  const nextEnv = {
    ...env,
    PATH: `${shimDir}${sep}${env?.PATH ?? ''}`,
  };
  return {
    ok: res.status === 0 && Boolean(commandExists('pnpm', nextEnv)),
    env: nextEnv,
    reason: res.status === 0 ? null : (res.stderr || res.stdout || '').trim(),
  };
}

function invokeDshPluginAddSync(selectedTarget, installSpec, execEnv) {
  if (selectedTarget.kind === 'official-desktop' && selectedTarget.clientExecutable && selectedTarget.desktopHostCliJs) {
    return spawnSync(
      selectedTarget.clientExecutable,
      ['--expose-internals', selectedTarget.desktopHostCliJs, 'plugin', '--profile', selectedTarget.profile, 'add', installSpec],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 180000,
        env: { ...execEnv, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
  }
  const cmd = selectedTarget.cliUsesNode ? process.execPath : selectedTarget.cliCommand;
  const args = selectedTarget.cliUsesNode
    ? [selectedTarget.cliCommand, 'plugin', '--profile', selectedTarget.profile, 'add', installSpec]
    : ['plugin', '--profile', selectedTarget.profile, 'add', installSpec];
  const isCmd = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(cmd));
  if (isCmd) {
    const quotedLine = [cmd, ...args].map(a => `"${String(a).replace(/"/g, '""')}"`).join(' ');
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quotedLine}"`], {
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      shell: false,
      timeout: 180000,
      env: execEnv,
    });
  }
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 180000,
    env: execEnv,
  });
}

/**
 * Execute complete one-click installation into the selected DSH target.
 */
export async function runOneClickInstallation({
  repoRoot = DEFAULT_REPO_ROOT,
  dshHome = null,
  customDshPath = null,
  profile = null,
  targetId = null,
  sourceKind = 'auto', // 'auto' | 'local-tgz' | 'local-source' | 'download-release'
  localTgzPath = null,
  releaseTag = null,
  platform = process.platform,
  track = 'open-source',
  cleanLegacyPatches = true,
  providerId = '',
  apiKey = '',
  fetchImpl = globalThis.fetch,
  installerRunner = null,
  spawnSyncImpl = spawnSync,
  onProgress = null,
} = {}) {
  if (releaseTag) {
    assertPlatformReleaseTagCompatible(releaseTag, platform);
  }
  const reportStep = (step, message) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ step, message, at: new Date().toISOString() }); } catch {}
    }
  };

  let inferredCustomPath = customDshPath;
  if (!inferredCustomPath && typeof targetId === 'string') {
    const m = /^(?:desktop|web):(.+)$/.exec(targetId);
    if (m && fs.existsSync(m[1])) inferredCustomPath = m[1];
  }

  const envSnap = inspectInstallerEnvironment({
    repoRoot,
    dshHome,
    customDshPath: inferredCustomPath,
    platform,
    spawnSyncImpl,
  });
  const resolvedHome = envSnap.dshHome;
  const storageRoot = path.join(resolvedHome, 'leaderteam');
  fs.mkdirSync(storageRoot, { recursive: true });

  const rawSelectedTarget =
    (targetId ? envSnap.targets.find(t => t.id === targetId) : null) ??
    envSnap.targets.find(t => t.recommended) ??
    envSnap.targets[0] ??
    null;

  if (!rawSelectedTarget) {
    const err = new Error('未在本机检测到已安装的 DeepSeek Harness 客户端或 CLI。请先安装官方 DeepSeek Harness（>= 0.2.2-rc.1），或在页面输入框手动指定安装目录后点击“重新扫描”。');
    err.friendly = translateInstallErrorToPlainChinese(err);
    throw err;
  }

  const normalizedProfile = profile === 'web' || profile === 'desktop' ? profile : null;
  const selectedTarget =
    normalizedProfile === 'web' && rawSelectedTarget.kind === 'official-desktop'
      ? { ...rawSelectedTarget, profile: 'web', desktopRunning: false }
      : (normalizedProfile ? { ...rawSelectedTarget, profile: normalizedProfile } : rawSelectedTarget);

  if (!selectedTarget.compatibility.productionAllowed) {
    const err = new Error(`HOST_INCOMPATIBLE: ${selectedTarget.compatibility.summary}`);
    err.friendly = translateInstallErrorToPlainChinese(err);
    throw err;
  }

  if (selectedTarget.kind === 'official-desktop' && selectedTarget.profile === 'desktop' && selectedTarget.desktopRunning) {
    const err = new Error('EBUSY: DeepSeek Harness.exe is still running in this profile');
    err.friendly = translateInstallErrorToPlainChinese(err);
    throw err;
  }

  // 1. Clean legacy V2.1 profile patches if detected
  let cleanedPatches = [];
  if (cleanLegacyPatches && envSnap.legacyPatchConflicts.length > 0) {
    reportStep('clean-legacy', '正在自动备份并清理旧版 V2.1 配置文件补丁…');
    cleanedPatches = cleanLegacyProfilePatches({ dshHome: resolvedHome });
  }

  // 2. Ensure pnpm available for CLI profile installation
  let execEnv = { ...process.env, DSH_HOME: resolvedHome };
  if (selectedTarget.kind === 'dsh-web-cli') {
    reportStep('check-deps', '正在检查包管理环境（Node.js / pnpm）…');
    const pnpmReady = ensurePnpmInEnv({ dshHome: resolvedHome, env: execEnv });
    execEnv = pnpmReady.env;
    if (!pnpmReady.ok && typeof installerRunner !== 'function') {
      const err = new Error(`pnpm not found: ${pnpmReady.reason || 'missing pnpm'}`);
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
  }

  // 3. Resolve package spec to install
  let installSpec = null;
  let installedVersion = null;
  let installedTrack = track;
  let sha256 = null;

  if (sourceKind === 'local-tgz' || (sourceKind === 'auto' && localTgzPath)) {
    const fullTgz = path.resolve(localTgzPath);
    reportStep('verify-package', `正在校验本地安装包 ${path.basename(fullTgz)}…`);
    const info = inspectTgzPackage(fullTgz);
    const compat = checkCandidatePackageCompatibility({
      pkgInspection: info,
      currentHostVersion: selectedTarget.toolsVersion,
    });
    if (!compat.compatible) {
      const err = new Error(`HOST_INCOMPATIBLE: ${compat.reason}`);
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
    installSpec = fullTgz;
    installedVersion = info.version;
    installedTrack = info.track;
    sha256 = computeFileSha256(fullTgz);
  } else if (sourceKind === 'auto' && envSnap.bundledTarballs.length > 0) {
    const first = envSnap.bundledTarballs[0];
    reportStep('verify-package', `发现随附离线安装包 ${first.fileName}，正在校验兼容性…`);
    const info = inspectTgzPackage(first.path);
    const compat = checkCandidatePackageCompatibility({
      pkgInspection: info,
      currentHostVersion: selectedTarget.toolsVersion,
    });
    if (!compat.compatible) {
      const err = new Error(`HOST_INCOMPATIBLE: ${compat.reason}`);
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
    installSpec = first.path;
    installedVersion = info.version;
    installedTrack = info.track;
    sha256 = computeFileSha256(first.path);
  } else if (sourceKind === 'local-source' || (sourceKind === 'auto' && envSnap.localSourceBundle.available)) {
    installSpec = envSnap.localSourceBundle.path;
    installedVersion = envSnap.localSourceBundle.version;
    installedTrack = 'open-source';
  } else {
    reportStep('download', `正在从 GitHub 下载最新「${UPDATE_TRACKS[track]?.shortLabel || track}」安装包并校验 SHA-256…`);
    const relCheck = await checkForUpdates({
      pluginRoot: repoRoot,
      storageRoot,
      track,
      targetTag: releaseTag,
      platform,
      force: true,
      fetchImpl,
    });
    if (!relCheck.latestRelease?.asset?.downloadUrl) {
      const err = new Error('未在官方仓库找到可下载的 .tgz 发布包');
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
    const downloaded = await downloadAndVerifyReleaseTarball({
      storageRoot,
      downloadUrl: relCheck.latestRelease.asset.downloadUrl,
      sha256SumsUrl: relCheck.latestRelease.sha256SumsUrl,
      expectedSha256: relCheck.latestRelease.asset.sha256,
      assetName: relCheck.latestRelease.asset.name,
      fetchImpl,
    });
    const compat = checkCandidatePackageCompatibility({
      pkgInspection: downloaded.inspection,
      currentHostVersion: selectedTarget.toolsVersion,
    });
    if (!compat.compatible) {
      const err = new Error(`HOST_INCOMPATIBLE: ${compat.reason}`);
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
    installSpec = downloaded.tgzPath;
    installedVersion = downloaded.inspection.version;
    installedTrack = downloaded.inspection.track;
    sha256 = downloaded.sha256;
  }

  // 3b. Zero-state `profiles/desktop` initialization BEFORE `--profile desktop` plugin add!
  let desktopProfileInit = null;
  if (selectedTarget.profile === 'desktop') {
    desktopProfileInit = ensureDesktopProfileInitialized(resolvedHome);
  }

  // 4. Execute `dsh plugin --profile <desktop|web> add <installSpec>`
  reportStep('install', `正在向 DSH (${selectedTarget.profile} profile) 安装 LeaderTeam v${installedVersion || ''}…`);
  if (typeof installerRunner === 'function') {
    await installerRunner({
      target: selectedTarget,
      installSpec,
      dshHome: resolvedHome,
      env: execEnv,
    });
  } else {
    if (!selectedTarget.cliCommand && !(selectedTarget.clientExecutable && selectedTarget.desktopHostCliJs)) {
      const err = new Error('未找到目标 DSH 客户端内置的 dsh 命令行入口');
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
    const proc = invokeDshPluginAddSync(selectedTarget, installSpec, execEnv);
    if (proc.status !== 0) {
      const detail = `${proc.stderr || ''}\n${proc.stdout || ''}`.trim() || `exit code ${proc.status}`;
      const err = new Error(detail);
      err.friendly = translateInstallErrorToPlainChinese(detail);
      throw err;
    }
  }

  // 4b. Post-install Desktop `cordis.patch.yml` hygiene
  let desktopPatchHygiene = null;
  if (selectedTarget.profile === 'desktop') {
    reportStep('patch-hygiene', '正在检查并优化桌面端 cordis.patch.yml 配置（保留模型网关并启用联网工具 tool-web）…');
    desktopPatchHygiene = sanitizeDesktopCordisPatch({
      dshHome: resolvedHome,
      profile: 'desktop',
    });
  }

  // 5. Optional: Pre-provision starter API key & Solo-Key config so user doesn't touch CLI at all
  let starterModelConfigured = false;
  if (providerId && String(apiKey || '').trim()) {
    reportStep('configure-key', '正在保存模型 API Key 并生成初始团队配置…');
    const preset = SOLO_PROVIDER_PRESETS.find(p => p.id === providerId || p.provider === providerId) ?? SOLO_PROVIDER_PRESETS[0];
    await persistProviderApiKey({
      dshHome: resolvedHome,
      envVarName: preset.envVars[0],
      apiKey: String(apiKey).trim(),
      env: execEnv,
    });
    const baseCfgPath = path.join(repoRoot, 'config', 'leaderteam.config.json');
    if (fs.existsSync(baseCfgPath)) {
      const baseRaw = JSON.parse(fs.readFileSync(baseCfgPath, 'utf8'));
      const starterCfg = buildSoloKeyStarterConfig(baseRaw, { preset });
      const cfgDir = path.join(storageRoot, 'config');
      fs.mkdirSync(cfgDir, { recursive: true });
      const userCfgFile = path.join(cfgDir, 'leaderteam.config.json');
      if (!fs.existsSync(userCfgFile)) {
        writeFileAtomic(userCfgFile, `${JSON.stringify(starterCfg, null, 2)}\n`);
      }
      try {
        const effCfg = loadConfig(userCfgFile);
        const providerTemplates = buildSoloProviderSettingsTemplates(execEnv);
        const modelsToSync = Object.entries(effCfg.models ?? {}).map(([route, spec]) => ({
          route,
          provider: spec.provider ?? preset.provider,
          upstreamModel: spec.upstreamModel ?? route,
          efforts: spec.efforts,
          ...(spec.reasoningEfforts ? { reasoningEfforts: spec.reasoningEfforts } : {}),
          vision: spec.vision,
          contextWindow: spec.contextWindow,
          maxTokens: spec.maxTokens,
        }));
        const leaderTarget = resolveModelTarget(effCfg, effCfg.roles.leader.route, effCfg.roles.leader.effort);
        await syncUpstreamModelsToDshSettings(null, modelsToSync, preset.provider, {
          providerTemplates,
          includeCompanionCatalogModels: true,
          leaderTarget,
          selectLeaderAsHostDefault: true,
          dshHome: resolvedHome,
        });
      } catch {}
    }
    starterModelConfigured = true;
  }

  reportStep('done', '安装与健康校验全部完成！');
  return {
    ok: true,
    target: {
      id: selectedTarget.id,
      kind: selectedTarget.kind,
      label: selectedTarget.label,
      profile: selectedTarget.profile,
      installDir: selectedTarget.installDir,
      dshVersion: selectedTarget.dshVersion,
    },
    installedVersion,
    installedTrack,
    sha256,
    cleanedLegacyPatches: cleanedPatches.length,
    desktopProfileInit,
    desktopPatchHygiene,
    starterModelConfigured,
    dshHome: resolvedHome,
    nextStepHint:
      selectedTarget.kind === 'official-desktop'
        ? '点击“立即启动客户端”即可直接打开 DeepSeek Harness 桌面端并进入新手引导。'
        : '点击“立即启动 Web 控制台”即可直接在浏览器进入 LeaderTeam 工作台与新手引导。',
  };
}

/**
 * Launch Official Desktop client or `dsh web` directly without requiring user CLI commands.
 */
export async function launchInstalledClient({
  repoRoot = DEFAULT_REPO_ROOT,
  dshHome = null,
  customDshPath = null,
  targetId = null,
  webPort = 4096,
  spawner = spawn,
} = {}) {
  let inferredCustomPath = customDshPath;
  if (!inferredCustomPath && typeof targetId === 'string') {
    const m = /^(?:desktop|web):(.+)$/.exec(targetId);
    if (m && fs.existsSync(m[1])) inferredCustomPath = m[1];
  }
  const envSnap = inspectInstallerEnvironment({ repoRoot, dshHome, customDshPath: inferredCustomPath });
  const selectedTarget =
    (targetId ? envSnap.targets.find(t => t.id === targetId) : null) ??
    envSnap.targets.find(t => t.recommended) ??
    envSnap.targets[0] ??
    null;

  if (!selectedTarget) {
    throw new Error('未找到可启动的 DeepSeek Harness 客户端。');
  }

  if (selectedTarget.kind === 'official-desktop' && selectedTarget.clientExecutable) {
    const cleanLaunchEnv = { ...process.env, DSH_HOME: envSnap.dshHome };
    delete cleanLaunchEnv.ELECTRON_RUN_AS_NODE;
    const child = spawner(selectedTarget.clientExecutable, [], {
      cwd: selectedTarget.installDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: cleanLaunchEnv,
    });
    child.unref?.();
    return {
      launched: true,
      kind: 'official-desktop',
      executable: selectedTarget.clientExecutable,
      url: null,
      message: '已启动 DeepSeek Harness 桌面客户端！在新建会话中选择 LeaderTeam 预设或打开右侧面板即可开始。',
    };
  }

  const targetUrl = `http://127.0.0.1:${webPort}/lt/?onboarding=1`;
  let alreadyListening = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${webPort}/`, { method: 'GET', signal: AbortSignal.timeout(1200) });
    alreadyListening = probe.status > 0;
  } catch {}

  if (!alreadyListening && selectedTarget.cliCommand) {
    const cmd = selectedTarget.cliUsesNode ? process.execPath : selectedTarget.cliCommand;
    const args = selectedTarget.cliUsesNode
      ? [selectedTarget.cliCommand, 'web', '--port', String(webPort), '--no-open']
      : ['web', '--port', String(webPort), '--no-open'];
    const child = spawner(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSH_HOME: envSnap.dshHome },
    });
    child.unref?.();
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${webPort}/`, { method: 'GET', signal: AbortSignal.timeout(800) });
        if (res.status > 0) break;
      } catch {}
    }
  }

  return {
    launched: true,
    kind: 'dsh-web-cli',
    url: targetUrl,
    message: `已准备就绪，正在打开 LeaderTeam 控制台（${targetUrl}）…`,
  };
}
