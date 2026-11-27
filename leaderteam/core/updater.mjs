// Dual-Track Auto-Update Checker, SHA-256 Verifier, Pre-Upgrade DSH Host Compatibility Gate,
// One-Click Upgrader, and Atomic Backup/Rollback Engine for LeaderTeam.
// Pure Node.js ESM, zero external dependencies, Apache-2.0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './store.mjs';
import {
  parseDshSemver,
  compareDshSemver,
  satisfiesDshRange,
  evaluateHostCompatibility,
  VERIFIED_CORE_VERSIONS,
  SUPPORTED_DSH_ENGINE_RANGE,
} from './host-compat.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(THIS_DIR, '..', '..');

export const UPDATE_TRACKS = Object.freeze({
  'open-source': Object.freeze({
    id: 'open-source',
    label: '开源维护版 (Apache-2.0)',
    shortLabel: '开源版',
    license: 'Apache-2.0',
    repo: 'youzi-ovo-create/dsh-leaderteam',
    releasesApiUrl: 'https://api.github.com/repos/youzi-ovo-create/dsh-leaderteam/releases',
    releasesHtmlUrl: 'https://github.com/youzi-ovo-create/dsh-leaderteam/releases',
    description: '纯 Node.js ESM 开源源码与标准安装包发行分支（Apache-2.0 协议）。',
  }),
  'closed-free': Object.freeze({
    id: 'closed-free',
    label: '闭源免费公开发行版',
    shortLabel: '闭源免费版',
    license: 'Closed-Source Free Distribution',
    repo: 'youzi-ovo-create/dsh-leaderteam-releases',
    releasesApiUrl: 'https://api.github.com/repos/youzi-ovo-create/dsh-leaderteam-releases/releases',
    releasesHtmlUrl: 'https://github.com/youzi-ovo-create/dsh-leaderteam-releases/releases',
    description: '包含预编译 Rust 原生模型映射核心与增强特性的免费公开发行分支。',
  }),
});

export const DEFAULT_CHECK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_TARBALL_BYTES = 80 * 1024 * 1024; // 80 MiB safety ceiling

export function requiredTrackSwitchToken(targetTrack) {
  return `CONFIRM_SWITCH_TO_${String(targetTrack || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function detectInstalledTrack(pluginRoot = DEFAULT_PLUGIN_ROOT, fsImpl = fs) {
  try {
    const internalPkgPath = path.join(pluginRoot, 'leaderteam', 'package.json');
    if (fsImpl.existsSync(internalPkgPath)) {
      const internalPkg = JSON.parse(fsImpl.readFileSync(internalPkgPath, 'utf8'));
      const declared = internalPkg?.leaderteam?.distributionTrack;
      if (declared === 'closed-free' || declared === 'open-source') {
        return declared;
      }
    }
  } catch {}
  try {
    const nativeDir = path.join(pluginRoot, 'leaderteam', 'native');
    if (fsImpl.existsSync(nativeDir)) {
      const files = fsImpl.readdirSync(nativeDir);
      if (files.some(f => f.endsWith('.node'))) {
        return 'closed-free';
      }
    }
    const privateUi = path.join(pluginRoot, 'leaderteam', 'ui', 'private');
    if (fsImpl.existsSync(privateUi)) {
      return 'closed-free';
    }
  } catch {}
  return 'open-source';
}

export function readInstalledVersionInfo(pluginRoot = DEFAULT_PLUGIN_ROOT, fsImpl = fs) {
  let version = '0.0.0';
  let name = 'dsh-leaderteam';
  let enginesDsh = SUPPORTED_DSH_ENGINE_RANGE;
  try {
    const rootPkg = JSON.parse(fsImpl.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
    if (typeof rootPkg.version === 'string') version = rootPkg.version.trim();
    if (typeof rootPkg.name === 'string') name = rootPkg.name.trim();
    if (typeof rootPkg.engines?.dsh === 'string') enginesDsh = rootPkg.engines.dsh.trim();
  } catch {}
  const track = detectInstalledTrack(pluginRoot, fsImpl);
  return {
    name,
    version,
    track,
    trackInfo: UPDATE_TRACKS[track] ?? UPDATE_TRACKS['open-source'],
    enginesDsh,
    pluginRoot,
  };
}

export function validateTrackSwitch({ currentTrack, targetTrack, confirmTrackSwitch = null }) {
  const cur = UPDATE_TRACKS[currentTrack] ? currentTrack : 'open-source';
  const tgt = targetTrack ? (UPDATE_TRACKS[targetTrack] ? targetTrack : null) : cur;
  if (!tgt) {
    const err = new Error(`未知的发行分支：${targetTrack}`);
    err.code = 'INVALID_UPDATE_TRACK';
    err.statusCode = 400;
    throw err;
  }
  if (cur !== tgt) {
    const expected = requiredTrackSwitchToken(tgt);
    if (confirmTrackSwitch !== expected) {
      const err = new Error(
        `当前安装为「${UPDATE_TRACKS[cur].label}」，目标为「${UPDATE_TRACKS[tgt].label}」。为避免未经确认自动切换发行分支，请先显式确认切换操作（需携带确认令牌 ${expected}）。`,
      );
      err.code = 'TRACK_SWITCH_CONFIRMATION_REQUIRED';
      err.statusCode = 409;
      err.details = {
        currentTrack: cur,
        targetTrack: tgt,
        requiredConfirmationToken: expected,
      };
      throw err;
    }
  }
  return tgt;
}

export function parseSha256SumsText(text, targetAssetName = null) {
  const map = new Map();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    const hash = m[1].toLowerCase();
    const fname = path.posix.basename(m[2].trim().replaceAll('\\', '/'));
    map.set(fname, hash);
  }
  if (targetAssetName) {
    return map.get(path.posix.basename(targetAssetName)) ?? null;
  }
  return map;
}

export function computeFileSha256(filePath, fsImpl = fs) {
  const buf = fsImpl.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Pure Node.js POSIX tar + gzip inspector (reads `package/package.json`, `package/leaderteam/package.json`,
 * and file list from `.tgz` in memory without invoking external `tar`).
 */
export function inspectTgzPackage(tgzFileOrBuffer, fsImpl = fs) {
  const compressed = Buffer.isBuffer(tgzFileOrBuffer) ? tgzFileOrBuffer : fsImpl.readFileSync(tgzFileOrBuffer);
  if (compressed.length > MAX_TARBALL_BYTES) {
    const err = new Error(`安装包体积超出安全上限（${compressed.length} > ${MAX_TARBALL_BYTES} bytes）`);
    err.code = 'PACKAGE_TOO_LARGE';
    throw err;
  }
  let tarBuf;
  try {
    tarBuf = zlib.gunzipSync(compressed, { maxOutputLength: MAX_TARBALL_BYTES * 3 });
  } catch (e) {
    const err = new Error(`安装包 Gzip 解压失败，文件可能已损坏：${e.message}`);
    err.code = 'INVALID_TARBALL';
    throw err;
  }

  const files = [];
  const extractedTexts = new Map();
  const wantedTextPaths = new Set(['package/package.json', 'package/leaderteam/package.json', 'package/cordis.patch.yml']);
  let offset = 0;
  let paxPathOverride = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Two zero blocks mark end of archive
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    if (!Number.isFinite(size) || size < 0) break;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuf.length) break;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // PAX extended header
      const paxText = tarBuf.subarray(dataStart, dataEnd).toString('utf8');
      for (const line of paxText.split('\n')) {
        const m = /^\d+\s+path=(.+)$/.exec(line);
        if (m && typeFlag === 'x') paxPathOverride = m[1];
      }
    } else if (typeFlag === 'L') {
      paxPathOverride = tarBuf.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '');
    } else {
      const fullName = (paxPathOverride || (prefix ? `${prefix}/${rawName}` : rawName)).replace(/^\.\//, '');
      paxPathOverride = null;
      if (typeFlag === '0' || typeFlag === '\0') {
        files.push(fullName);
        if (wantedTextPaths.has(fullName) && size <= 2 * 1024 * 1024) {
          extractedTexts.set(fullName, tarBuf.subarray(dataStart, dataEnd).toString('utf8'));
        }
      }
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  const rootPkgRaw = extractedTexts.get('package/package.json');
  if (!rootPkgRaw) {
    const err = new Error('安装包内缺少标准 package/package.json 清单');
    err.code = 'INVALID_BUNDLE_MANIFEST';
    throw err;
  }
  let rootPkg;
  try {
    rootPkg = JSON.parse(rootPkgRaw);
  } catch {
    const err = new Error('安装包 package/package.json JSON 格式无效');
    err.code = 'INVALID_BUNDLE_MANIFEST';
    throw err;
  }
  if (rootPkg.name !== 'dsh-leaderteam' || !rootPkg.dsh?.bundle) {
    const err = new Error(`安装包不是有效的 dsh-leaderteam 插件包（name=${rootPkg.name}）`);
    err.code = 'NOT_LEADERTEAM_BUNDLE';
    throw err;
  }

  let internalPkg = null;
  const internalRaw = extractedTexts.get('package/leaderteam/package.json');
  if (internalRaw) {
    try { internalPkg = JSON.parse(internalRaw); } catch {}
  }

  const nativeFiles = files.filter(f => f.startsWith('package/leaderteam/native/') && f.endsWith('.node'));
  const declaredTrack = internalPkg?.leaderteam?.distributionTrack;
  const inferredTrack =
    declaredTrack === 'closed-free' || declaredTrack === 'open-source'
      ? declaredTrack
      : (nativeFiles.length > 0 || files.some(f => f.startsWith('package/leaderteam/ui/private/')))
        ? 'closed-free'
        : 'open-source';

  return {
    name: rootPkg.name,
    version: String(rootPkg.version || '').trim(),
    license: rootPkg.license || null,
    track: inferredTrack,
    enginesDsh: rootPkg.engines?.dsh ?? null,
    supportedCoreVersions: Array.isArray(internalPkg?.leaderteam?.supportedCoreVersions)
      ? internalPkg.leaderteam.supportedCoreVersions
      : null,
    supportedCoreRange: internalPkg?.leaderteam?.supportedCoreRange ?? rootPkg.engines?.dsh ?? null,
    compatibilityPolicy: internalPkg?.leaderteam?.compatibilityPolicy ?? null,
    hasCordisPatch: Boolean(extractedTexts.get('package/cordis.patch.yml')),
    nativeFiles: nativeFiles.map(f => path.posix.basename(f)),
    fileCount: files.length,
  };
}

/**
 * Verify whether a candidate `.tgz` manifest is compatible with the currently running DSH host & platform.
 */
export function checkCandidatePackageCompatibility({
  pkgInspection,
  currentHostVersion,
  currentPipelineSource = null,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!pkgInspection || pkgInspection.name !== 'dsh-leaderteam') {
    return {
      compatible: false,
      code: 'INVALID_PACKAGE',
      reason: '目标安装包不是合法的 dsh-leaderteam 插件包。',
    };
  }

  // 1. Check platform binary availability if package is closed-free with native modules
  if (pkgInspection.track === 'closed-free' && pkgInspection.nativeFiles.length > 0 && platform !== 'darwin') {
    const platformSpecific = `mapper.${platform}-${arch}.node`;
    const hasPlatformNode =
      pkgInspection.nativeFiles.includes(platformSpecific) ||
      pkgInspection.nativeFiles.includes('mapper.node');
    if (!hasPlatformNode) {
      return {
        compatible: false,
        code: 'UNSUPPORTED_PLATFORM_BINARY',
        reason: `目标闭源安装包未包含当前系统架构（${platform}-${arch}）所需的原生模块（包含：${pkgInspection.nativeFiles.join(', ')}）。`,
      };
    }
  }

  // 2. Check DSH host version compatibility against target package's `engines.dsh`
  if (currentHostVersion) {
    if (pkgInspection.enginesDsh && !satisfiesDshRange(currentHostVersion, pkgInspection.enginesDsh)) {
      return {
        compatible: false,
        code: 'HOST_INCOMPATIBLE_WITH_UPDATE',
        reason: `当前 DSH 宿主版本（${currentHostVersion}）不满足新版本安装包要求（engines.dsh: "${pkgInspection.enginesDsh}"）。请先升级 DSH 客户端或使用匹配的 LT 版本。`,
        requiredDshRange: pkgInspection.enginesDsh,
        currentHostVersion,
      };
    }
    if (currentPipelineSource) {
      const targetPolicy = pkgInspection.compatibilityPolicy
        ?? (pkgInspection.supportedCoreRange && pkgInspection.supportedCoreRange.includes('>=') ? 'adaptive' : 'strict-verified');
      const hostEval = evaluateHostCompatibility({
        toolsVersion: currentHostVersion,
        pipelineSource: currentPipelineSource,
        supportedVersions: pkgInspection.supportedCoreVersions ?? VERIFIED_CORE_VERSIONS,
        supportedRange: pkgInspection.supportedCoreRange ?? pkgInspection.enginesDsh ?? SUPPORTED_DSH_ENGINE_RANGE,
        policy: targetPolicy,
      });
      if (!hostEval.productionAllowed) {
        return {
          compatible: false,
          code: 'HOST_INCOMPATIBLE_WITH_UPDATE',
          reason: `新版本安全门预检未通过当前 DSH 宿主（${currentHostVersion}）：${hostEval.summary}`,
          classification: hostEval.classification,
          currentHostVersion,
        };
      }
    }
  }

  return {
    compatible: true,
    code: 'OK',
    reason: '目标安装包通过 DSH 宿主兼容性与平台二进制校验。',
  };
}

function resolveUpdaterDir(storageRoot) {
  return path.join(storageRoot, 'updater');
}

export function readUpdaterState(storageRoot, fsImpl = fs) {
  const defaults = {
    phase: 'idle', // 'idle' | 'checking' | 'downloading' | 'verifying' | 'backing_up' | 'applying' | 'succeeded' | 'rolled_back' | 'failed'
    autoCheckEnabled: true,
    lastCheckedAt: null,
    lastError: null,
    activeUpgrade: null,
    lastCompletedUpgrade: null,
    availableUpdate: null,
  };
  if (!storageRoot) return defaults;
  const stateFile = path.join(resolveUpdaterDir(storageRoot), 'state.json');
  if (!fsImpl.existsSync(stateFile)) return defaults;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
    return { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return defaults;
  }
}

export function writeUpdaterState(storageRoot, patch = {}) {
  if (!storageRoot) return patch;
  const dir = resolveUpdaterDir(storageRoot);
  fs.mkdirSync(dir, { recursive: true });
  const prev = readUpdaterState(storageRoot);
  const next = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function listSavedBackups(storageRoot, fsImpl = fs) {
  if (!storageRoot) return [];
  const backupsRoot = path.join(resolveUpdaterDir(storageRoot), 'backups');
  if (!fsImpl.existsSync(backupsRoot)) return [];
  const out = [];
  try {
    for (const entry of fsImpl.readdirSync(backupsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestFile = path.join(backupsRoot, entry.name, 'manifest.json');
      if (!fsImpl.existsSync(manifestFile)) continue;
      try {
        const m = JSON.parse(fsImpl.readFileSync(manifestFile, 'utf8'));
        out.push({
          backupId: entry.name,
          backupDir: path.join(backupsRoot, entry.name),
          ...m,
        });
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function parseReleaseTagInfo(rawTag, { allowBareVersion = false } = {}) {
  if (typeof rawTag !== 'string') return null;
  const trimmed = rawTag.trim();
  if (!trimmed) return null;
  const re = allowBareVersion
    ? /^(?:(windows|linux)-)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i
    : /^(?:(windows|linux)-)?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i;
  const m = re.exec(trimmed);
  if (!m) return null;
  const platformPrefix = m[1] ? m[1].toLowerCase() : null;
  const versionPart = m[2];
  if (!parseDshSemver(versionPart)) return null;
  const targetPlatform =
    platformPrefix === 'windows'
      ? 'win32'
      : platformPrefix === 'linux'
        ? 'linux'
        : null;
  return {
    rawTag: trimmed,
    canonicalTag: platformPrefix ? `${platformPrefix}-v${versionPart}` : `v${versionPart}`,
    platformPrefix,
    targetPlatform,
    version: versionPart,
  };
}

export function extractReleaseTagFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
  try {
    const u = new URL(rawUrl.trim());
    const m = /\/releases\/download\/([^/?#]+)\//i.exec(u.pathname);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    const m = /\/releases\/download\/([^/?#\s]+)\//i.exec(rawUrl);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  }
}

export function assertPlatformReleaseTagCompatible(rawTag, currentPlatform = process.platform) {
  if (rawTag === null || rawTag === undefined || String(rawTag).trim() === '') return null;
  const trimmed = String(rawTag).trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('windows-') && currentPlatform !== 'win32') {
    const err = new Error(
      `跨平台 Release 标签不匹配（PLATFORM_RELEASE_TAG_MISMATCH）：当前运行平台为 "${currentPlatform}"，拒绝使用 Windows 专属标签 "${trimmed}"。`,
    );
    err.code = 'PLATFORM_RELEASE_TAG_MISMATCH';
    err.statusCode = 409;
    err.details = { currentPlatform, requestedTag: trimmed, tagPlatformPrefix: 'windows', tagTargetPlatform: 'win32' };
    throw err;
  }
  if (lower.startsWith('linux-') && currentPlatform !== 'linux') {
    const err = new Error(
      `跨平台 Release 标签不匹配（PLATFORM_RELEASE_TAG_MISMATCH）：当前运行平台为 "${currentPlatform}"，拒绝使用 Linux 专属标签 "${trimmed}"。`,
    );
    err.code = 'PLATFORM_RELEASE_TAG_MISMATCH';
    err.statusCode = 409;
    err.details = { currentPlatform, requestedTag: trimmed, tagPlatformPrefix: 'linux', tagTargetPlatform: 'linux' };
    throw err;
  }
  const info = parseReleaseTagInfo(trimmed, { allowBareVersion: true });
  if (info?.targetPlatform && info.targetPlatform !== currentPlatform) {
    const err = new Error(
      `跨平台 Release 标签不匹配（PLATFORM_RELEASE_TAG_MISMATCH）：当前运行平台为 "${currentPlatform}"，拒绝使用目标平台 "${info.targetPlatform}" 的标签 "${trimmed}"。`,
    );
    err.code = 'PLATFORM_RELEASE_TAG_MISMATCH';
    err.statusCode = 409;
    err.details = {
      currentPlatform,
      requestedTag: trimmed,
      tagPlatformPrefix: info.platformPrefix,
      tagTargetPlatform: info.targetPlatform,
    };
    throw err;
  }
  return info;
}

export function filterReleasesForPlatform(releases = [], currentPlatform = process.platform) {
  const list = (Array.isArray(releases) ? releases : [])
    .filter(r => r && !r.draft)
    .map(r => {
      if ('platformPrefix' in r && typeof r.version === 'string') {
        return { item: r, platformPrefix: r.platformPrefix ?? null, version: r.version };
      }
      const rawTag = String(r.tagName ?? r.tag_name ?? '').trim();
      const parsed = parseReleaseTagInfo(rawTag, { allowBareVersion: false });
      if (!parsed) return null;
      return { item: r, platformPrefix: parsed.platformPrefix, version: parsed.version };
    })
    .filter(Boolean);
  let pool;
  if (currentPlatform === 'win32') {
    const nonLinux = list.filter(r => r.platformPrefix !== 'linux');
    const winPrefixed = nonLinux.filter(r => r.platformPrefix === 'windows');
    const legacyUnprefixed = nonLinux.filter(r => !r.platformPrefix);
    pool = winPrefixed.length > 0 ? winPrefixed : legacyUnprefixed;
  } else if (currentPlatform === 'linux') {
    const nonWindows = list.filter(r => r.platformPrefix !== 'windows');
    const linuxPrefixed = nonWindows.filter(r => r.platformPrefix === 'linux');
    const legacyUnprefixed = nonWindows.filter(r => !r.platformPrefix);
    pool = linuxPrefixed.length > 0 ? linuxPrefixed : legacyUnprefixed;
  } else {
    pool = list.filter(r => !r.platformPrefix);
  }
  return [...pool]
    .sort((a, b) => compareDshSemver(b.version, a.version) ?? 0)
    .map(w => w.item);
}

function normalizeReleaseEntry(rel, track) {
  if (!rel || typeof rel !== 'object' || rel.draft) return null;
  const rawTag = String(rel.tag_name ?? '').trim();
  const parsedTag = parseReleaseTagInfo(rawTag, { allowBareVersion: false });
  if (!parsedTag) return null;
  const cleanVersion = parsedTag.version;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const tgzAsset =
    assets.find(a => typeof a?.name === 'string' && /^dsh-leaderteam-.*\.tgz$/i.test(a.name)) ??
    assets.find(a => typeof a?.name === 'string' && a.name.endsWith('.tgz')) ??
    null;
  const sumsAsset =
    assets.find(a => typeof a?.name === 'string' && /^SHA256SUMS/i.test(a.name)) ??
    null;

  let assetDigestSha256 = null;
  if (typeof tgzAsset?.digest === 'string' && tgzAsset.digest.startsWith('sha256:')) {
    const hex = tgzAsset.digest.slice('sha256:'.length).trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex)) assetDigestSha256 = hex;
  }

  return {
    track,
    tagName: rawTag,
    platformPrefix: parsedTag.platformPrefix,
    targetPlatform: parsedTag.targetPlatform,
    version: cleanVersion,
    name: String(rel.name || rawTag),
    prerelease: Boolean(rel.prerelease),
    publishedAt: rel.published_at || rel.created_at || null,
    htmlUrl: rel.html_url || UPDATE_TRACKS[track]?.releasesHtmlUrl || null,
    body: String(rel.body ?? ''),
    asset: tgzAsset
      ? {
          name: tgzAsset.name,
          size: Number(tgzAsset.size) || null,
          downloadUrl: tgzAsset.browser_download_url,
          sha256: assetDigestSha256,
        }
      : null,
    sha256SumsUrl: sumsAsset?.browser_download_url ?? null,
  };
}

/**
 * Check GitHub Releases (or custom mirror) for updates on the specified distribution track.
 * Never blindly queries `/releases/latest`: filters `/releases` by runtime platform
 * (`windows-vX.Y.Z` vs `linux-vX.Y.Z`, with backward-compatible fallback to legacy `vX.Y.Z`
 * ONLY when no same-platform prefixed release exists, and NEVER matching the opposite OS).
 */
export async function checkForUpdates({
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  storageRoot = null,
  track = null,
  targetTag = null,
  releaseTag = null,
  platform = process.platform,
  includePrerelease = false,
  force = false,
  currentHostVersion = null,
  apiUrlOverride = null,
  fetchImpl = globalThis.fetch,
  cacheTtlMs = DEFAULT_CHECK_CACHE_TTL_MS,
} = {}) {
  const effectiveTag = targetTag ?? releaseTag ?? null;
  const explicitTagInfo = effectiveTag ? assertPlatformReleaseTagCompatible(effectiveTag, platform) : null;
  const installed = readInstalledVersionInfo(pluginRoot);
  const queryTrack = track && UPDATE_TRACKS[track] ? track : installed.track;
  const trackMeta = UPDATE_TRACKS[queryTrack];
  const isCrossTrackPreview = queryTrack !== installed.track;

  const cacheFile = storageRoot && !effectiveTag
    ? path.join(resolveUpdaterDir(storageRoot), `check-cache-${queryTrack}-${platform}.json`)
    : null;

  if (!force && !apiUrlOverride && !effectiveTag && cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const age = Date.now() - Date.parse(cached.checkedAt || '');
      if (
        Number.isFinite(age) &&
        age >= 0 &&
        age < cacheTtlMs &&
        cached.installedVersion === installed.version &&
        cached.platform === platform
      ) {
        return { ...cached, fromCache: true };
      }
    } catch {}
  }

  const sanitizedOverride = typeof apiUrlOverride === 'string' && apiUrlOverride.trim()
    ? apiUrlOverride.trim().replace(/\/releases\/latest(?:\?.*)?$/i, '/releases?per_page=30')
    : null;
  const targetUrl = sanitizedOverride || `${trackMeta.releasesApiUrl}?per_page=30`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  timer.unref?.();

  let rawList;
  try {
    const res = await fetchImpl(targetUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `LeaderTeam-Updater/${installed.version}`,
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`查询发行仓库失败（HTTP ${res.status}）`);
    }
    const parsed = await res.json();
    rawList = Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    clearTimeout(timer);
  }

  const normalizedAll = rawList
    .map(r => normalizeReleaseEntry(r, queryTrack))
    .filter(r => r !== null && (includePrerelease || !r.prerelease || Boolean(effectiveTag)));

  let releases;
  if (effectiveTag) {
    const cleanRequested = String(effectiveTag).trim();
    const prefPrefix = platform === 'win32' ? 'windows' : (platform === 'linux' ? 'linux' : null);
    const nonCrossPlatform = normalizedAll.filter(r => !r.targetPlatform || r.targetPlatform === platform);
    if (explicitTagInfo?.platformPrefix) {
      releases = nonCrossPlatform.filter(r => r.tagName.toLowerCase() === explicitTagInfo.canonicalTag.toLowerCase());
    } else if (explicitTagInfo) {
      const preferredTag = prefPrefix ? `${prefPrefix}-v${explicitTagInfo.version}`.toLowerCase() : null;
      const legacyTag = `v${explicitTagInfo.version}`.toLowerCase();
      const exactRaw = nonCrossPlatform.filter(r => r.tagName.toLowerCase() === cleanRequested.toLowerCase());
      const prefMatches = preferredTag ? nonCrossPlatform.filter(r => r.tagName.toLowerCase() === preferredTag) : [];
      const legacyMatches = nonCrossPlatform.filter(r => r.tagName.toLowerCase() === legacyTag);
      releases = prefMatches.length > 0 ? prefMatches : (exactRaw.length > 0 ? exactRaw : legacyMatches);
    } else {
      releases = [];
    }
  } else {
    releases = filterReleasesForPlatform(normalizedAll, platform);
  }

  const latest = releases.find(r => r.asset?.downloadUrl) ?? releases[0] ?? null;
  const hasUpdate = latest
    ? (isCrossTrackPreview ? latest.version !== installed.version || queryTrack !== installed.track : compareDshSemver(latest.version, installed.version) > 0)
    : false;

  const checkedAt = new Date().toISOString();
  const result = {
    checkedAt,
    fromCache: false,
    platform,
    installedVersion: installed.version,
    installedTrack: installed.track,
    installedTrackInfo: installed.trackInfo,
    queriedTrack: queryTrack,
    queriedTrackInfo: trackMeta,
    isCrossTrack: isCrossTrackPreview,
    crossTrackConfirmationToken: isCrossTrackPreview ? requiredTrackSwitchToken(queryTrack) : null,
    currentHostVersion,
    hasUpdate,
    latestRelease: latest,
    recentReleases: releases.slice(0, 5),
  };

  if (cacheFile && !apiUrlOverride && !effectiveTag) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileAtomic(cacheFile, `${JSON.stringify(result, null, 2)}\n`);
    } catch {}
  }
  if (storageRoot && !isCrossTrackPreview && !effectiveTag) {
    writeUpdaterState(storageRoot, {
      lastCheckedAt: checkedAt,
      lastError: null,
      availableUpdate: hasUpdate ? latest : null,
    });
  }

  return result;
}

export function isRuntimeIdleForUpgrade(rt) {
  if (!rt) return { idle: true, reasons: [] };
  const reasons = [];
  if (rt.liveProcessMemberIds instanceof Set && rt.liveProcessMemberIds.size > 0) {
    reasons.push(`当前有 ${rt.liveProcessMemberIds.size} 个团队执行成员正在运行`);
  }
  if (rt.inFlightShellCallsBySession instanceof Map && rt.inFlightShellCallsBySession.size > 0) {
    reasons.push('当前有正在执行的受控终端工具调用');
  }
  if (rt.actors instanceof Map) {
    for (const actor of rt.actors.values()) {
      const status = typeof actor?.agent?.status === 'function' ? actor.agent.status() : actor?.agent?.status;
      if (status === 'running' || status === 'busy' || status === 'streaming') {
        reasons.push(`会话 ${actor.teamId || ''} 主代理正在执行回合`);
        break;
      }
    }
  }
  return { idle: reasons.length === 0, reasons };
}

function copyDirRecursiveSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

export function createPreUpgradeBackup({
  storageRoot,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  profileDir = null,
  targetVersion,
  targetTrack,
}) {
  const installed = readInstalledVersionInfo(pluginRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `${stamp}-v${installed.version}-${installed.track}`;
  const backupDir = path.join(resolveUpdaterDir(storageRoot), 'backups', backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  // 1. Copy installed plugin package directory (without node_modules/.git) for 100% offline rollback
  const pkgSnapshotDir = path.join(backupDir, 'plugin-package');
  copyDirRecursiveSync(pluginRoot, pkgSnapshotDir);

  // 2. Snapshot user configs (note: upgrade never overwrites these, but snapshot protects rollback)
  const configDir = path.join(storageRoot, 'config');
  const configBackupDir = path.join(backupDir, 'config-snapshot');
  if (fs.existsSync(configDir)) {
    copyDirRecursiveSync(configDir, configBackupDir);
  }
  for (const extraFile of ['ui-preferences.json', 'onboarding.json']) {
    const f = path.join(storageRoot, extraFile);
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(backupDir, extraFile));
    }
  }

  // 3. Snapshot profile manifest & lockfile if profileDir is known
  const profileSnapshotDir = path.join(backupDir, 'profile-files');
  if (profileDir && fs.existsSync(profileDir)) {
    fs.mkdirSync(profileSnapshotDir, { recursive: true });
    for (const pf of ['package.json', 'pnpm-lock.yaml']) {
      const full = path.join(profileDir, pf);
      if (fs.existsSync(full)) fs.copyFileSync(full, path.join(profileSnapshotDir, pf));
    }
  }

  const manifest = {
    backupId,
    createdAt: new Date().toISOString(),
    fromVersion: installed.version,
    fromTrack: installed.track,
    toVersion: targetVersion,
    toTrack: targetTrack,
    profileDir: profileDir || null,
    pluginSnapshotDir: pkgSnapshotDir,
  };
  writeFileAtomic(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { backupId, backupDir, manifest };
}

export async function downloadAndVerifyReleaseTarball({
  storageRoot,
  downloadUrl,
  sha256SumsUrl = null,
  expectedSha256 = null,
  assetName = null,
  fetchImpl = globalThis.fetch,
}) {
  const stagingRoot = path.join(resolveUpdaterDir(storageRoot), 'staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const cleanName = path.posix.basename(String(assetName || new URL(downloadUrl).pathname || 'dsh-leaderteam-update.tgz'));
  if (!cleanName.endsWith('.tgz')) {
    const err = new Error(`仅支持标准 .tgz 插件包安装：${cleanName}`);
    err.code = 'UNSUPPORTED_ASSET_TYPE';
    throw err;
  }
  const destFile = path.join(stagingRoot, `${Date.now()}-${cleanName}`);

  let resolvedExpectedSha = expectedSha256 ? String(expectedSha256).trim().toLowerCase() : null;
  if (!resolvedExpectedSha && sha256SumsUrl) {
    const sumsRes = await fetchImpl(sha256SumsUrl, { method: 'GET' });
    if (sumsRes.ok) {
      const sumsTxt = await sumsRes.text();
      resolvedExpectedSha = parseSha256SumsText(sumsTxt, cleanName);
    }
  }

  const pkgRes = await fetchImpl(downloadUrl, { method: 'GET' });
  if (!pkgRes.ok) {
    const err = new Error(`下载更新包失败（HTTP ${pkgRes.status}）`);
    err.code = 'DOWNLOAD_FAILED';
    throw err;
  }
  const arrayBuf = await pkgRes.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > MAX_TARBALL_BYTES) {
    const err = new Error(`下载文件超过安全大小限制（${buf.length} bytes）`);
    err.code = 'PACKAGE_TOO_LARGE';
    throw err;
  }
  fs.writeFileSync(destFile, buf);

  const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
  if (resolvedExpectedSha && actualSha !== resolvedExpectedSha) {
    try { fs.rmSync(destFile, { force: true }); } catch {}
    const err = new Error(
      `安装包 SHA-256 校验不一致（期望 ${resolvedExpectedSha.slice(0, 12)}...，实际 ${actualSha.slice(0, 12)}...），已中止安装并清理临时文件。`,
    );
    err.code = 'SHA256_MISMATCH';
    throw err;
  }

  let inspection;
  try {
    inspection = inspectTgzPackage(buf);
  } catch (e) {
    try { fs.rmSync(destFile, { force: true }); } catch {}
    throw e;
  }

  return {
    tgzPath: destFile,
    sha256: actualSha,
    sha256Verified: Boolean(resolvedExpectedSha),
    sizeBytes: buf.length,
    inspection,
  };
}

export function resolveDshCliCommand({
  dshHome = null,
  profile = 'web',
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  driveLetters = null,
} = {}) {
  // 1. Official Windows Desktop bundled CLI (works for BOTH `desktop` and `web` profiles when global `dsh` is not in PATH,
  // including custom install paths such as `D:\Apps\DeepSeek-Harness` and `LT_DSH_APP` / `DSH_DESKTOP_DIR` / `DSH_APP_DIR`)
  if (platform === 'win32') {
    const winDesktopDirs = [];
    const pushDir = raw => {
      if (!raw || typeof raw !== 'string') return;
      const trimmed = raw.trim().replace(/^"+|"+$/g, '');
      if (!trimmed) return;
      const dir = /\.(?:exe|cmd|bat)$/i.test(trimmed) ? path.dirname(trimmed) : trimmed;
      if (!winDesktopDirs.includes(dir)) winDesktopDirs.push(dir);
    };
    for (const k of ['LT_DSH_APP', 'DSH_DESKTOP_DIR', 'DSH_APP_DIR']) {
      if (env?.[k]) pushDir(env[k]);
    }
    if (env?.LOCALAPPDATA) {
      pushDir(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
      pushDir(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek-Harness'));
    }
    const pf = env?.PROGRAMFILES || env?.ProgramFiles;
    if (pf) {
      pushDir(path.join(pf, 'DeepSeek Harness'));
      pushDir(path.join(pf, 'DeepSeek-Harness'));
    }
    if (env?.['ProgramFiles(x86)']) {
      pushDir(path.join(env['ProgramFiles(x86)'], 'DeepSeek Harness'));
      pushDir(path.join(env['ProgramFiles(x86)'], 'DeepSeek-Harness'));
    }
    const letters = Array.isArray(driveLetters)
      ? driveLetters.map(l => String(l).replace(/:.*$/, '').toUpperCase())
      : Array.from({ length: 24 }, (_, idx) => String.fromCharCode(67 + idx));
    const subpaths = [
      ['Apps', 'DeepSeek-Harness'],
      ['Apps', 'DeepSeek Harness'],
      ['Program Files', 'DeepSeek Harness'],
      ['Program Files', 'DeepSeek-Harness'],
      ['DeepSeek-Harness'],
      ['DeepSeek Harness'],
      ['Programs', 'DeepSeek-Harness'],
      ['Programs', 'DeepSeek Harness'],
    ];
    for (const letter of letters) {
      const root = `${letter}:\\`;
      let rootOk = false;
      try { rootOk = fsImpl.existsSync(root); } catch { rootOk = false; }
      if (!rootOk) continue;
      for (const segs of subpaths) {
        pushDir(path.win32.join(root, ...segs));
      }
    }

    let fallbackCmd = null;
    for (const dir of winDesktopDirs) {
      let dirOk = false;
      try { dirOk = fsImpl.existsSync(dir); } catch { dirOk = false; }
      if (!dirOk) continue;
      const exePath = path.join(dir, 'DeepSeek Harness.exe');
      const asarPath = path.join(dir, 'resources', 'app.asar');
      const asarCliJs = path.join(asarPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
      const unpackedCliJs = path.join(dir, 'resources', 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
      if (fsImpl.existsSync(exePath) && (fsImpl.existsSync(asarPath) || fsImpl.existsSync(unpackedCliJs))) {
        return {
          cmd: exePath,
          prefixArgs: ['--expose-internals', fsImpl.existsSync(asarPath) ? asarCliJs : unpackedCliJs],
          shell: false,
          extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
        };
      }
      const winCli = path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
      if (!fallbackCmd && fsImpl.existsSync(winCli)) {
        fallbackCmd = { cmd: winCli, prefixArgs: [], shell: true, extraEnv: {} };
      }
    }
    if (profile === 'desktop' && fallbackCmd) {
      return fallbackCmd;
    }
    // Check PATH `dsh` before falling back to `dsh.cmd` for `web` profile
    const pathSepWin = ';';
    for (const dir of String(env?.PATH ?? '').split(pathSepWin).filter(Boolean)) {
      for (const ext of ['.cmd', '.exe', '']) {
        const cand = path.join(dir, `dsh${ext}`);
        if (fsImpl.existsSync(cand)) {
          return { cmd: cand, prefixArgs: [], shell: ext === '.cmd', extraEnv: {} };
        }
      }
    }
    if (fallbackCmd) return fallbackCmd;
  }
  // 2. Linux `~/.local/share/dsh-runtime/current/node_modules/@deepseek-ai/dsh/lib/bin.js`
  const homeDir = env?.USERPROFILE || env?.HOME || os.homedir();
  if (homeDir) {
    const localRuntimeBin = path.join(homeDir, '.local', 'share', 'dsh-runtime', 'current', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fsImpl.existsSync(localRuntimeBin)) {
      return { cmd: process.execPath, prefixArgs: [localRuntimeBin], shell: false, extraEnv: {} };
    }
  }
  // 3. `dsh` in PATH
  const pathSep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of String(env?.PATH ?? '').split(pathSep).filter(Boolean)) {
    for (const ext of exts) {
      const cand = path.join(dir, `dsh${ext}`);
      if (fsImpl.existsSync(cand)) {
        return { cmd: cand, prefixArgs: [], shell: platform === 'win32' && ext === '.cmd', extraEnv: {} };
      }
    }
  }
  return null;
}

function ensureDesktopProfileInitializedForCli(dshHome, profile, fsImpl = fs) {
  if (!dshHome || profile !== 'desktop') return;
  const desktopDir = path.join(dshHome, 'profiles', 'desktop');
  const pkgFile = path.join(desktopDir, 'package.json');
  const patchFile = path.join(desktopDir, 'cordis.patch.yml');
  fsImpl.mkdirSync(desktopDir, { recursive: true });
  if (!fsImpl.existsSync(pkgFile)) {
    writeFileAtomic(
      pkgFile,
      `${JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      })}\n`,
    );
  }
  if (!fsImpl.existsSync(patchFile)) {
    writeFileAtomic(patchFile, '[]\n');
  }
}

function restoreConfigSnapshotIfMissing(backupDir, storageRoot) {
  const snapCfgDir = path.join(backupDir, 'config-snapshot');
  const liveCfgDir = path.join(storageRoot, 'config');
  if (fs.existsSync(snapCfgDir)) {
    fs.mkdirSync(liveCfgDir, { recursive: true });
    for (const f of fs.readdirSync(snapCfgDir)) {
      const target = path.join(liveCfgDir, f);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(snapCfgDir, f), target);
      }
    }
  }
}

/**
 * Execute a verified one-click upgrade with automatic rollback on failure.
 * Supports:
 * - Live DSH `ctx.root.get('pluginManager')` (both HMR hot-reload and non-HMR restart-pending)
 * - Standalone CLI (`dsh plugin --profile <web|desktop> add <tgzPath>`)
 * - Custom `installerHook` for deterministic isolated E2E & rollback testing.
 */
export async function performOneClickUpgrade({
  ctx = null,
  rt = null,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  storageRoot,
  dshHome = null,
  profile = null,
  localTgzPath = null,
  downloadUrl = null,
  releaseTag = null,
  platform = process.platform,
  sha256SumsUrl = null,
  expectedSha256 = null,
  targetTrack = null,
  confirmTrackSwitch = null,
  currentHostVersion = null,
  currentPipelineSource = null,
  fetchImpl = globalThis.fetch,
  installerHook = null,
  allowBusy = false,
} = {}) {
  if (!storageRoot) throw new Error('storageRoot is required for performOneClickUpgrade');
  if (releaseTag) {
    assertPlatformReleaseTagCompatible(releaseTag, platform);
  }
  if (downloadUrl) {
    const urlTag = extractReleaseTagFromUrl(downloadUrl);
    if (urlTag) assertPlatformReleaseTagCompatible(urlTag, platform);
  }

  if (!allowBusy) {
    const idleCheck = isRuntimeIdleForUpgrade(rt);
    if (!idleCheck.idle) {
      const err = new Error(`为保证会话与团队记录完整性，请等待当前运行中的任务完成后再执行升级：${idleCheck.reasons.join('；')}`);
      err.code = 'UPGRADE_BUSY';
      err.statusCode = 409;
      err.details = { reasons: idleCheck.reasons };
      throw err;
    }
  }

  const installed = readInstalledVersionInfo(pluginRoot);
  const resolvedTargetTrack = validateTrackSwitch({
    currentTrack: installed.track,
    targetTrack: targetTrack ?? installed.track,
    confirmTrackSwitch,
  });

  writeUpdaterState(storageRoot, {
    phase: 'downloading',
    lastError: null,
  });

  let staged;
  try {
    if (localTgzPath) {
      const resolvedLocal = path.resolve(localTgzPath);
      if (!fs.existsSync(resolvedLocal)) {
        const err = new Error(`找不到本地安装包：${resolvedLocal}`);
        err.code = 'FILE_NOT_FOUND';
        throw err;
      }
      const actualSha = computeFileSha256(resolvedLocal);
      if (expectedSha256 && actualSha !== String(expectedSha256).trim().toLowerCase()) {
        const err = new Error('本地安装包 SHA-256 校验失败，已中止升级。');
        err.code = 'SHA256_MISMATCH';
        throw err;
      }
      staged = {
        tgzPath: resolvedLocal,
        sha256: actualSha,
        sha256Verified: Boolean(expectedSha256),
        sizeBytes: fs.statSync(resolvedLocal).size,
        inspection: inspectTgzPackage(resolvedLocal),
        cleanupOnFinish: false,
      };
    } else if (downloadUrl) {
      staged = {
        ...(await downloadAndVerifyReleaseTarball({
          storageRoot,
          downloadUrl,
          sha256SumsUrl,
          expectedSha256,
          fetchImpl,
        })),
        cleanupOnFinish: true,
      };
    } else {
      const checkRes = await checkForUpdates({
        pluginRoot,
        storageRoot,
        track: resolvedTargetTrack,
        targetTag: releaseTag,
        platform,
        force: true,
        currentHostVersion,
        fetchImpl,
      });
      if (!checkRes.latestRelease?.asset?.downloadUrl) {
        const err = new Error('当前分支暂无可下载的标准 .tgz 安装包。');
        err.code = 'NO_RELEASE_ASSET';
        throw err;
      }
      staged = {
        ...(await downloadAndVerifyReleaseTarball({
          storageRoot,
          downloadUrl: checkRes.latestRelease.asset.downloadUrl,
          sha256SumsUrl: checkRes.latestRelease.sha256SumsUrl,
          expectedSha256: expectedSha256 || checkRes.latestRelease.asset.sha256,
          assetName: checkRes.latestRelease.asset.name,
          fetchImpl,
        })),
        cleanupOnFinish: true,
      };
    }

    writeUpdaterState(storageRoot, { phase: 'verifying' });

    // Enforce track match on the actual inspected tarball too!
    validateTrackSwitch({
      currentTrack: installed.track,
      targetTrack: staged.inspection.track,
      confirmTrackSwitch,
    });

    // Enforce pre-upgrade DSH host compatibility gate
    const compat = checkCandidatePackageCompatibility({
      pkgInspection: staged.inspection,
      currentHostVersion,
      currentPipelineSource,
    });
    if (!compat.compatible) {
      const err = new Error(compat.reason);
      err.code = compat.code || 'HOST_INCOMPATIBLE_WITH_UPDATE';
      err.statusCode = 409;
      err.details = compat;
      throw err;
    }

    const rootCtx = ctx?.root ?? ctx;
    const pluginManager = typeof rootCtx?.get === 'function' ? rootCtx.get('pluginManager') : null;
    const hasHmr = Boolean(typeof rootCtx?.get === 'function' && rootCtx.get('hmr'));
    const profileCtx = typeof rootCtx?.get === 'function' ? rootCtx.get('profileContext') : null;
    const effectiveProfile = profile || profileCtx?.profile || (process.platform === 'win32' ? 'web' : 'web');
    const profileDir =
      profileCtx?.dir ??
      (dshHome ? path.join(dshHome, 'profiles', effectiveProfile) : null);

    writeUpdaterState(storageRoot, { phase: 'backing_up' });
    const backup = createPreUpgradeBackup({
      storageRoot,
      pluginRoot,
      profileDir,
      targetVersion: staged.inspection.version,
      targetTrack: staged.inspection.track,
    });

    writeUpdaterState(storageRoot, {
      phase: 'applying',
      activeUpgrade: {
        fromVersion: installed.version,
        toVersion: staged.inspection.version,
        track: staged.inspection.track,
        backupId: backup.backupId,
        startedAt: new Date().toISOString(),
      },
    });

    const runRollback = async failureReason => {
      let rollbackOk = false;
      let rollbackError = null;
      try {
        if (typeof installerHook === 'function') {
          await installerHook({
            mode: 'rollback',
            spec: backup.manifest.pluginSnapshotDir,
            backupDir: backup.backupDir,
            profile: effectiveProfile,
            dshHome,
          });
          rollbackOk = true;
        } else if (pluginManager && typeof pluginManager.installBundle === 'function') {
          if (hasHmr && typeof pluginManager.removeBundle === 'function') {
            await pluginManager.removeBundle('dsh-leaderteam').catch(() => null);
          }
          const rbRes = await pluginManager.installBundle(backup.manifest.pluginSnapshotDir, { enabled: true });
          rollbackOk = rbRes?.application !== 'failed' && rbRes?.application !== 'cancelled';
          if (!rollbackOk) rollbackError = rbRes?.error?.diagnostic || 'pluginManager rollback failed';
        } else {
          const dshCli = resolveDshCliCommand({ dshHome, profile: effectiveProfile });
          if (dshCli) {
            const proc = spawnSync(
              dshCli.cmd,
              [...dshCli.prefixArgs, 'plugin', '--profile', effectiveProfile, 'add', backup.manifest.pluginSnapshotDir],
              {
                encoding: 'utf8',
                windowsHide: true,
                shell: dshCli.shell,
                timeout: 120000,
                env: { ...process.env, ...(dshHome ? { DSH_HOME: dshHome } : {}), ...(dshCli.extraEnv ?? {}) },
              },
            );
            rollbackOk = proc.status === 0;
            if (!rollbackOk) rollbackError = (proc.stderr || proc.stdout || '').trim();
          }
        }
        restoreConfigSnapshotIfMissing(backup.backupDir, storageRoot);
      } catch (rbErr) {
        rollbackError = rbErr.message;
      }

      writeUpdaterState(storageRoot, {
        phase: rollbackOk ? 'rolled_back' : 'failed',
        activeUpgrade: null,
        lastError: failureReason,
        lastCompletedUpgrade: {
          ok: false,
          rolledBack: rollbackOk,
          rollbackError,
          fromVersion: installed.version,
          toVersion: staged.inspection.version,
          backupId: backup.backupId,
          finishedAt: new Date().toISOString(),
          error: failureReason,
        },
      });
      return { rollbackOk, rollbackError };
    };

    // Case 1: Custom hook (used by isolated unit/integration tests)
    if (typeof installerHook === 'function') {
      try {
        const hookRes = await installerHook({
          mode: 'install',
          spec: staged.tgzPath,
          inspection: staged.inspection,
          backupDir: backup.backupDir,
          profile: effectiveProfile,
          dshHome,
        });
        restoreConfigSnapshotIfMissing(backup.backupDir, storageRoot);
        const completed = {
          ok: true,
          mode: 'hook',
          requiresRestart: Boolean(hookRes?.requiresRestart),
          fromVersion: installed.version,
          toVersion: staged.inspection.version,
          track: staged.inspection.track,
          sha256: staged.sha256,
          backupId: backup.backupId,
          preserved: {
            modelConfig: fs.existsSync(path.join(storageRoot, 'config')),
            teamsLedger: true,
            sessionHistory: true,
          },
          finishedAt: new Date().toISOString(),
        };
        writeUpdaterState(storageRoot, {
          phase: 'succeeded',
          activeUpgrade: null,
          availableUpdate: null,
          lastError: null,
          lastCompletedUpgrade: completed,
        });
        return completed;
      } catch (installErr) {
        const rb = await runRollback(installErr.message || String(installErr));
        const err = new Error(
          rb.rollbackOk
            ? `升级安装失败，已自动回滚至 v${installed.version}（原因：${installErr.message}）`
            : `升级安装失败且自动回滚异常：${installErr.message}（回滚错误：${rb.rollbackError}）`,
        );
        err.code = rb.rollbackOk ? 'UPGRADE_FAILED_ROLLED_BACK' : 'UPGRADE_AND_ROLLBACK_FAILED';
        err.details = { backupId: backup.backupId, rolledBack: rb.rollbackOk };
        throw err;
      }
    }

    // Case 2: Live in-host DSH `pluginManager` WITH HMR (schedule root-context swap so HTTP response flushes cleanly first!)
    if (pluginManager && typeof pluginManager.installBundle === 'function' && hasHmr && typeof pluginManager.removeBundle === 'function') {
      const scheduledTgz = staged.tgzPath;
      setTimeout(() => {
        (async () => {
          try {
            const rmRes = await pluginManager.removeBundle('dsh-leaderteam');
            if (rmRes?.application === 'failed' || rmRes?.application === 'cancelled') {
              throw new Error(rmRes?.error?.diagnostic || '卸载旧版插件层失败');
            }
            const addRes = await pluginManager.installBundle(scheduledTgz, { enabled: true });
            if (addRes?.application === 'failed' || addRes?.application === 'cancelled') {
              throw new Error(addRes?.error?.diagnostic || '安装新版插件包失败');
            }
            restoreConfigSnapshotIfMissing(backup.backupDir, storageRoot);
            writeUpdaterState(storageRoot, {
              phase: 'succeeded',
              activeUpgrade: null,
              availableUpdate: null,
              lastError: null,
              lastCompletedUpgrade: {
                ok: true,
                mode: 'hmr-live',
                requiresRestart: false,
                fromVersion: installed.version,
                toVersion: staged.inspection.version,
                track: staged.inspection.track,
                sha256: staged.sha256,
                backupId: backup.backupId,
                finishedAt: new Date().toISOString(),
              },
            });
          } catch (liveErr) {
            await runRollback(liveErr.message || String(liveErr));
          }
        })().catch(() => {});
      }, 120);

      return {
        ok: true,
        asyncApplying: true,
        mode: 'hmr-live',
        requiresRestart: false,
        fromVersion: installed.version,
        toVersion: staged.inspection.version,
        track: staged.inspection.track,
        sha256: staged.sha256,
        backupId: backup.backupId,
        message: `正在后台热替换升级至 v${staged.inspection.version}（约 3~8 秒自动生效，无需命令行或重启）…`,
      };
    }

    // Case 3: Live in-host DSH `pluginManager` WITHOUT HMR (e.g. Official Desktop)
    if (pluginManager && typeof pluginManager.installBundle === 'function') {
      try {
        const addRes = await pluginManager.installBundle(staged.tgzPath, { enabled: true });
        if (addRes?.application === 'failed' || addRes?.application === 'cancelled') {
          throw new Error(addRes?.error?.diagnostic || '宿主插件管理器安装返回失败');
        }
        restoreConfigSnapshotIfMissing(backup.backupDir, storageRoot);
        const completed = {
          ok: true,
          mode: 'plugin-manager-restart',
          requiresRestart: true,
          fromVersion: installed.version,
          toVersion: staged.inspection.version,
          track: staged.inspection.track,
          sha256: staged.sha256,
          backupId: backup.backupId,
          finishedAt: new Date().toISOString(),
          message: `已完成 v${staged.inspection.version} 安装，重启 DeepSeek Harness 客户端后生效（全部配置与历史会话已保留）。`,
        };
        writeUpdaterState(storageRoot, {
          phase: 'succeeded',
          activeUpgrade: null,
          availableUpdate: null,
          lastError: null,
          lastCompletedUpgrade: completed,
        });
        return completed;
      } catch (pmErr) {
        const rb = await runRollback(pmErr.message || String(pmErr));
        const err = new Error(
          rb.rollbackOk
            ? `升级失败，已自动回滚至 v${installed.version}：${pmErr.message}`
            : `升级失败：${pmErr.message}`,
        );
        err.code = rb.rollbackOk ? 'UPGRADE_FAILED_ROLLED_BACK' : 'UPGRADE_FAILED';
        throw err;
      }
    }

    // Case 4: Standalone / CLI upgrade via `dsh plugin --profile <profile> add <tgz>`
    const dshCli = resolveDshCliCommand({ dshHome, profile: effectiveProfile });
    if (!dshCli) {
      const err = new Error('未检测到本机 dsh CLI 可执行程序，无法在独立模式下自动执行插件替换。');
      err.code = 'DSH_CLI_NOT_FOUND';
      writeUpdaterState(storageRoot, { phase: 'failed', activeUpgrade: null, lastError: err.message });
      throw err;
    }
    ensureDesktopProfileInitializedForCli(dshHome, effectiveProfile);

    const proc = spawnSync(
      dshCli.cmd,
      [...dshCli.prefixArgs, 'plugin', '--profile', effectiveProfile, 'add', staged.tgzPath],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: dshCli.shell,
        timeout: 180000,
        env: { ...process.env, ...(dshHome ? { DSH_HOME: dshHome } : {}) },
      },
    );
    if (proc.status !== 0) {
      const cliErrMsg = (proc.stderr || proc.stdout || `exit code ${proc.status}`).trim();
      const rb = await runRollback(cliErrMsg);
      const err = new Error(
        rb.rollbackOk
          ? `升级命令执行失败，已自动回滚至 v${installed.version}：${cliErrMsg}`
          : `升级命令执行失败：${cliErrMsg}`,
      );
      err.code = rb.rollbackOk ? 'UPGRADE_FAILED_ROLLED_BACK' : 'UPGRADE_FAILED';
      throw err;
    }

    restoreConfigSnapshotIfMissing(backup.backupDir, storageRoot);
    const completed = {
      ok: true,
      mode: 'dsh-cli',
      requiresRestart: true,
      fromVersion: installed.version,
      toVersion: staged.inspection.version,
      track: staged.inspection.track,
      sha256: staged.sha256,
      backupId: backup.backupId,
      finishedAt: new Date().toISOString(),
      message: `已成功安装 v${staged.inspection.version}（模型配置、历史会话与团队账本已完整保留）。`,
    };
    writeUpdaterState(storageRoot, {
      phase: 'succeeded',
      activeUpgrade: null,
      availableUpdate: null,
      lastError: null,
      lastCompletedUpgrade: completed,
    });
    return completed;
  } catch (outerErr) {
    const curState = readUpdaterState(storageRoot);
    if (curState.phase === 'downloading' || curState.phase === 'verifying' || curState.phase === 'backing_up') {
      writeUpdaterState(storageRoot, {
        phase: 'failed',
        activeUpgrade: null,
        lastError: outerErr.message || String(outerErr),
      });
    }
    throw outerErr;
  }
}

/**
 * Explicitly roll back to a saved pre-upgrade backup snapshot.
 */
export async function rollbackToSavedBackup({
  ctx = null,
  rt = null,
  storageRoot,
  dshHome = null,
  backupId = null,
  profile = null,
  installerHook = null,
} = {}) {
  if (!storageRoot) throw new Error('storageRoot is required for rollback');
  const idleCheck = isRuntimeIdleForUpgrade(rt);
  if (!idleCheck.idle) {
    const err = new Error(`请等待当前任务空闲后再执行版本回滚：${idleCheck.reasons.join('；')}`);
    err.code = 'ROLLBACK_BUSY';
    err.statusCode = 409;
    throw err;
  }

  const backups = listSavedBackups(storageRoot);
  const chosen = backupId ? backups.find(b => b.backupId === backupId) : backups[0];
  if (!chosen || !chosen.pluginSnapshotDir || !fs.existsSync(chosen.pluginSnapshotDir)) {
    const err = new Error('未找到可用的本地历史版本备份快照。');
    err.code = 'BACKUP_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const rootCtx = ctx?.root ?? ctx;
  const pluginManager = typeof rootCtx?.get === 'function' ? rootCtx.get('pluginManager') : null;
  const hasHmr = Boolean(typeof rootCtx?.get === 'function' && rootCtx.get('hmr'));
  const profileCtx = typeof rootCtx?.get === 'function' ? rootCtx.get('profileContext') : null;
  const effectiveProfile = profile || profileCtx?.profile || 'web';

  if (typeof installerHook === 'function') {
    await installerHook({
      mode: 'rollback',
      spec: chosen.pluginSnapshotDir,
      backupDir: chosen.backupDir,
      profile: effectiveProfile,
      dshHome,
    });
  } else if (pluginManager && typeof pluginManager.installBundle === 'function') {
    if (hasHmr && typeof pluginManager.removeBundle === 'function') {
      setTimeout(() => {
        (async () => {
          await pluginManager.removeBundle('dsh-leaderteam').catch(() => null);
          await pluginManager.installBundle(chosen.pluginSnapshotDir, { enabled: true });
          restoreConfigSnapshotIfMissing(chosen.backupDir, storageRoot);
          writeUpdaterState(storageRoot, {
            phase: 'rolled_back',
            activeUpgrade: null,
            lastError: null,
          });
        })().catch(() => {});
      }, 120);
      return {
        ok: true,
        asyncApplying: true,
        restoredVersion: chosen.fromVersion,
        restoredTrack: chosen.fromTrack,
        backupId: chosen.backupId,
        message: `正在后台热回滚至 v${chosen.fromVersion}…`,
      };
    }
    const res = await pluginManager.installBundle(chosen.pluginSnapshotDir, { enabled: true });
    if (res?.application === 'failed' || res?.application === 'cancelled') {
      throw new Error(res?.error?.diagnostic || '宿主插件管理器回滚失败');
    }
  } else {
    const dshCli = resolveDshCliCommand({ dshHome, profile: effectiveProfile });
    if (!dshCli) {
      const err = new Error('未找到本机 dsh CLI，无法执行离线回滚。');
      err.code = 'DSH_CLI_NOT_FOUND';
      throw err;
    }
    const proc = spawnSync(
      dshCli.cmd,
      [...dshCli.prefixArgs, 'plugin', '--profile', effectiveProfile, 'add', chosen.pluginSnapshotDir],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: dshCli.shell,
        timeout: 180000,
        env: { ...process.env, ...(dshHome ? { DSH_HOME: dshHome } : {}) },
      },
    );
    if (proc.status !== 0) {
      throw new Error(`回滚命令执行失败：${(proc.stderr || proc.stdout || '').trim()}`);
    }
  }

  restoreConfigSnapshotIfMissing(chosen.backupDir, storageRoot);
  writeUpdaterState(storageRoot, {
    phase: 'rolled_back',
    activeUpgrade: null,
    lastError: null,
  });
  return {
    ok: true,
    restoredVersion: chosen.fromVersion,
    restoredTrack: chosen.fromTrack,
    backupId: chosen.backupId,
    requiresRestart: !hasHmr,
    message: `已成功回滚至 v${chosen.fromVersion}。`,
  };
}
