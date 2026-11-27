// Cross-platform One-Click Installer Engine for LeaderTeam (Issue #2).
// Auto-discovers Official DSH Desktop & CLI/Web installations, checks dependencies & compatibility,
// cleans legacy V2.1 patches with backup, installs `.tgz` or local package, provisions optional starter API Key,
// translates technical errors into beginner-friendly Chinese hints, and launches the client directly.
// Pure Node.js ESM, zero external dependencies, Apache-2.0.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDshHostCompatibility } from '../../bin/lt-doctor.mjs';
import { detectLegacyProfilePatchConflicts, cleanLegacyProfilePatches } from './legacy-patch-guard.mjs';
import { getHostCompatibilityMatrix } from './host-compat.mjs';
import {
  UPDATE_TRACKS,
  assertPlatformReleaseTagCompatible,
  checkForUpdates,
  downloadAndVerifyReleaseTarball,
  inspectTgzPackage,
  checkCandidatePackageCompatibility,
  computeFileSha256,
} from './updater.mjs';
import {
  QUICK_PROVIDER_PRESETS,
  persistProviderApiKey,
} from './onboarding.mjs';
import { SOLO_PROVIDER_PRESETS, buildSoloKeyStarterConfig, buildSoloProviderSettingsTemplates } from './solo-key.mjs';
import { resolveModelTarget, syncUpstreamModelsToDshSettings } from './upstream-models.mjs';
import { loadConfig } from './config.mjs';
import { writeFileAtomic } from './store.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

export function resolveDefaultDshHomePath(platform = process.platform, env = process.env) {
  if (env?.DSH_HOME && String(env.DSH_HOME).trim()) {
    return path.resolve(String(env.DSH_HOME).trim());
  }
  const home = os.homedir();
  return home ? path.join(home, '.dsh') : path.resolve('.dsh');
}

/**
 * Translate technical CLI / OS / pnpm / DSH errors into clear, non-technical Chinese guidance.
 */
export function translateInstallErrorToPlainChinese(rawErrorOrMessage) {
  const msg = String(rawErrorOrMessage instanceof Error ? rawErrorOrMessage.message : rawErrorOrMessage ?? '').trim();
  const lower = msg.toLowerCase();

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
  if (lower.includes('ebusy') || lower.includes('eperm') || lower.includes('still running in this profile') || lower.includes('lock')) {
    return {
      code: 'CLIENT_RUNNING_OR_LOCKED',
      title: 'DeepSeek Harness 正在运行或目录被占用',
      friendlyMessage: '安装桌面端插件前需要先完全退出正在运行的 DeepSeek Harness 客户端（含系统托盘图标）。',
      suggestion: '请先关闭 DeepSeek Harness 窗口并退出托盘程序，然后点击“重新安装”。',
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

function commandExists(cmd, env = process.env) {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of String(env?.PATH ?? '').split(pathSep).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, `${cmd}${ext}`);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function isOfficialDesktopProcessRunning(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
      });
      return String(res.stdout || '').toLowerCase().includes('deepseek harness.exe');
    }
  } catch {}
  return false;
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
} = {}) {
  const resolvedHome = dshHome ? path.resolve(dshHome) : resolveDefaultDshHomePath(platform, env);
  const targets = [];

  // 1. Check Official Desktop candidates
  const desktopDirs = [];
  if (customDshPath && fsImpl.existsSync(customDshPath)) {
    desktopDirs.push(path.resolve(customDshPath));
  }
  if (platform === 'win32') {
    if (env?.LOCALAPPDATA) desktopDirs.push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
    if (env?.PROGRAMFILES) desktopDirs.push(path.join(env.PROGRAMFILES, 'DeepSeek Harness'));
  } else {
    desktopDirs.push('/opt/DeepSeek Harness', '/opt/deepseek-harness');
  }

  for (const dir of [...new Set(desktopDirs)]) {
    if (!fsImpl.existsSync(dir)) continue;
    const winCli = path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    const unixCli = path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh');
    const exeWin = path.join(dir, 'DeepSeek Harness.exe');
    const exeLinux = path.join(dir, 'deepseek-harness');
    const isDesktopLayout =
      fsImpl.existsSync(winCli) ||
      fsImpl.existsSync(unixCli) ||
      fsImpl.existsSync(exeWin) ||
      fsImpl.existsSync(exeLinux) ||
      fsImpl.existsSync(path.join(dir, 'resources', 'app.asar'));
    if (!isDesktopLayout) continue;

    const compat = checkDshHostCompatibility({ checkHost: dir, platform, env, fsImpl });
    const desktopProfileDir = path.join(resolvedHome, 'profiles', 'desktop');
    const profileInitialized = fsImpl.existsSync(desktopProfileDir);
    const installedLtPkg = path.join(desktopProfileDir, 'node_modules', 'dsh-leaderteam', 'package.json');
    let installedLtVersion = null;
    if (fsImpl.existsSync(installedLtPkg)) {
      try { installedLtVersion = JSON.parse(fsImpl.readFileSync(installedLtPkg, 'utf8')).version; } catch {}
    }
    targets.push({
      id: `desktop:${dir}`,
      kind: 'official-desktop',
      label: '官方 DeepSeek Harness 桌面客户端 (Desktop)',
      profile: 'desktop',
      installDir: dir,
      cliCommand: fsImpl.existsSync(winCli) ? winCli : (fsImpl.existsSync(unixCli) ? unixCli : null),
      clientExecutable: fsImpl.existsSync(exeWin) ? exeWin : (fsImpl.existsSync(exeLinux) ? exeLinux : null),
      dshVersion: compat.desktopVersion || compat.toolsVersion,
      toolsVersion: compat.toolsVersion,
      compatibility: {
        status: compat.status,
        classification: compat.classification,
        productionAllowed: compat.productionAllowed,
        summary: compat.summary,
      },
      profileInitialized,
      desktopRunning: isOfficialDesktopProcessRunning(platform),
      installedLtVersion,
      recommended: platform === 'win32',
    });
  }

  // 2. Check Web / CLI runtime candidates
  const cliDirs = [];
  if (customDshPath && fsImpl.existsSync(customDshPath)) {
    cliDirs.push(path.resolve(customDshPath));
  }
  const homeDir = os.homedir();
  if (homeDir) {
    const dshRuntimeCur = path.join(homeDir, '.local', 'share', 'dsh-runtime', 'current');
    if (fsImpl.existsSync(dshRuntimeCur)) cliDirs.push(dshRuntimeCur);
  }
  const pathDsh = commandExists('dsh', env);
  if (pathDsh) {
    try {
      const real = fsImpl.realpathSync(pathDsh);
      const norm = real.replaceAll('\\', '/');
      const idx = norm.lastIndexOf('/node_modules/');
      cliDirs.push(idx > 0 ? real.slice(0, idx) : path.dirname(path.dirname(real)));
    } catch {}
  }

  for (const dir of [...new Set(cliDirs)]) {
    if (!fsImpl.existsSync(dir)) continue;
    const binJs = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    const directBinJs = path.join(dir, 'lib', 'bin.js');
    const resolvedBinJs = fsImpl.existsSync(binJs) ? binJs : (fsImpl.existsSync(directBinJs) ? directBinJs : null);
    const compat = checkDshHostCompatibility({ checkHost: dir, platform, env, fsImpl });
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

  const pnpmPath = commandExists('pnpm', env);
  const corepackPath = commandExists('corepack', env);
  const legacyConflicts = detectLegacyProfilePatchConflicts({ dshHome: resolvedHome, fsImpl });

  // Local source repo or bundled .tgz packages
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

/**
 * Execute complete one-click installation into the selected DSH target.
 */
export async function runOneClickInstallation({
  repoRoot = DEFAULT_REPO_ROOT,
  dshHome = null,
  customDshPath = null,
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
  const envSnap = inspectInstallerEnvironment({ repoRoot, dshHome, customDshPath: inferredCustomPath });
  const resolvedHome = envSnap.dshHome;
  const storageRoot = path.join(resolvedHome, 'leaderteam');
  fs.mkdirSync(storageRoot, { recursive: true });

  const selectedTarget =
    (targetId ? envSnap.targets.find(t => t.id === targetId) : null) ??
    envSnap.targets.find(t => t.recommended) ??
    envSnap.targets[0] ??
    null;

  if (!selectedTarget) {
    const err = new Error('未在本机检测到已安装的 DeepSeek Harness 客户端或 CLI。请先安装官方 DeepSeek Harness（>= 0.2.2-rc.1），或手动指定安装目录。');
    err.friendly = translateInstallErrorToPlainChinese(err);
    throw err;
  }

  if (!selectedTarget.compatibility.productionAllowed) {
    const err = new Error(`HOST_INCOMPATIBLE: ${selectedTarget.compatibility.summary}`);
    err.friendly = translateInstallErrorToPlainChinese(err);
    throw err;
  }

  if (selectedTarget.kind === 'official-desktop' && selectedTarget.desktopRunning) {
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
    if (!selectedTarget.cliCommand) {
      const err = new Error('未找到目标 DSH 客户端内置的 dsh 命令行入口');
      err.friendly = translateInstallErrorToPlainChinese(err);
      throw err;
    }
    const cmd = selectedTarget.cliUsesNode ? process.execPath : selectedTarget.cliCommand;
    const args = selectedTarget.cliUsesNode
      ? [selectedTarget.cliCommand, 'plugin', '--profile', selectedTarget.profile, 'add', installSpec]
      : ['plugin', '--profile', selectedTarget.profile, 'add', installSpec];
    const isCmd = process.platform === 'win32' && String(cmd).toLowerCase().endsWith('.cmd');

    const proc = spawnSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      shell: isCmd,
      timeout: 180000,
      env: execEnv,
    });
    if (proc.status !== 0) {
      const detail = `${proc.stderr || ''}\n${proc.stdout || ''}`.trim() || `exit code ${proc.status}`;
      const err = new Error(detail);
      err.friendly = translateInstallErrorToPlainChinese(detail);
      throw err;
    }
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
      dshVersion: selectedTarget.dshVersion,
    },
    installedVersion,
    installedTrack,
    sha256,
    cleanedLegacyPatches: cleanedPatches.length,
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
  targetId = null,
  webPort = 4096,
  spawner = spawn,
} = {}) {
  const envSnap = inspectInstallerEnvironment({ repoRoot, dshHome });
  const selectedTarget =
    (targetId ? envSnap.targets.find(t => t.id === targetId) : null) ??
    envSnap.targets.find(t => t.recommended) ??
    envSnap.targets[0] ??
    null;

  if (!selectedTarget) {
    throw new Error('未找到可启动的 DeepSeek Harness 客户端。');
  }

  if (selectedTarget.kind === 'official-desktop' && selectedTarget.clientExecutable) {
    const child = spawner(selectedTarget.clientExecutable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, DSH_HOME: envSnap.dshHome },
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

  // Web / CLI mode: check if port is already serving, else spawn `dsh web --port <webPort> --no-open`
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
    // Wait briefly up to 4s for server readiness
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
