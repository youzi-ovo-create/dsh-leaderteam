import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VERIFIED_CORE_VERSIONS, isWithinAdaptiveHostRange, evaluateDispatchToolBodyContract } from '../leaderteam/core/host-compat.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APP = path.join(ROOT, 'runtime', 'official-desktop', '0.2.2-rc.1');
const PATHS_CONFIG = path.join(ROOT, 'config', 'official-desktop.paths.json');
const OFFICIAL_EXE_WIN = 'DeepSeek Harness.exe';
const OFFICIAL_EXE_LINUX_CANDIDATES = ['deepseek-harness', 'DeepSeek Harness'];
const LEGACY_EXE = 'DSH Desktop.exe';
const EXTRA_VERIFIED_VERSIONS = VERIFIED_CORE_VERSIONS.filter(v => v !== '0.2.2-rc.1');

export function splitShellArgs(raw) {
  const out = [];
  const src = String(raw ?? '');
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    let tok = '';
    let hasQuote = false;
    while (i < src.length && !/\s/.test(src[i])) {
      if (src[i] === "'") {
        hasQuote = true;
        i++;
        while (i < src.length && src[i] !== "'") tok += src[i++];
        if (i < src.length) i++;
      } else if (src[i] === '"') {
        hasQuote = true;
        i++;
        while (i < src.length) {
          if (src[i] === '\\') {
            let bsCount = 0;
            while (i < src.length && src[i] === '\\') { bsCount++; i++; }
            if (i < src.length && src[i] === '"') {
              tok += '\\'.repeat(Math.floor(bsCount / 2));
              if (bsCount % 2 === 1) {
                tok += '"';
                i++;
                continue;
              }
              break;
            }
            // Preserve Windows path separators inside double quotes (`"C:\Build Tools\hook.cjs"`)
            tok += '\\'.repeat(bsCount);
            continue;
          }
          if (src[i] === '"') break;
          tok += src[i++];
        }
        if (i < src.length && src[i] === '"') i++;
      } else if (src[i] === '\\' && i + 1 < src.length) {
        if (/[\s"']/.test(src[i + 1])) {
          tok += src[i + 1];
          i += 2;
        } else if (/^[A-Za-z]:/.test(tok) || tok.startsWith('\\\\')) {
          tok += '\\';
          i++;
        } else {
          tok += src[i + 1];
          i += 2;
        }
      } else {
        tok += src[i++];
      }
    }
    if (tok || hasQuote) out.push(tok);
  }
  return out;
}

function resolveToolsPkgFromDshBin(bin, moduleRoot) {
  const direct = path.join(moduleRoot, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json');
  if (fs.existsSync(direct)) return direct;
  const dshPkg = path.join(path.dirname(path.dirname(bin)), 'package.json');
  if (fs.existsSync(dshPkg)) {
    try {
      const req = createRequire(dshPkg);
      try { return req.resolve('@deepseek-ai/dsh-tools/package.json'); } catch {}
      for (const carrier of ['@deepseek-ai/dsh-base/package.json', '@deepseek-ai/dsh-headless/package.json', '@deepseek-ai/dsh-web/package.json']) {
        try {
          const cPkg = req.resolve(carrier);
          return createRequire(cPkg).resolve('@deepseek-ai/dsh-tools/package.json');
        } catch {}
      }
    } catch {}
  }
  return null;
}

function resolveNpmCliRuntime(dir) {
  const candidates = [
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(dir, 'lib', 'bin.js'),
  ];
  const bin = candidates.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
  if (!bin) return null;
  const normalizedBin = bin.replaceAll('\\', '/');
  const marker = normalizedBin.lastIndexOf('/node_modules/');
  const moduleRoot = marker >= 0 ? bin.slice(0, marker) : path.dirname(path.dirname(bin));
  const toolsPkgFile = resolveToolsPkgFromDshBin(bin, moduleRoot);
  if (!toolsPkgFile || !fs.existsSync(toolsPkgFile)) throw new Error(`Missing @deepseek-ai/dsh-tools in npm CLI runtime: ${moduleRoot}`);
  const toolsVersion = JSON.parse(fs.readFileSync(toolsPkgFile, 'utf8')).version;
  const supported = ['0.2.2-rc.1', ...EXTRA_VERIFIED_VERSIONS];
  if (!supported.includes(toolsVersion)) {
    const pipeFile = path.join(path.dirname(toolsPkgFile), 'lib', 'pipeline.js');
    const pipeSrc = fs.existsSync(pipeFile) ? fs.readFileSync(pipeFile, 'utf8') : '';
    const adaptiveOk = isWithinAdaptiveHostRange(toolsVersion) && evaluateDispatchToolBodyContract(pipeSrc).compatible;
    if (!adaptiveOk) {
      throw new Error(`Unsupported @deepseek-ai/dsh-tools version in npm CLI runtime: ${toolsVersion}`);
    }
  }
  return {
    kind: 'npm-cli',
    app: dir,
    exe: process.execPath,
    cliArgs: [bin],
    moduleRoot,
    profile: process.env.LT_DSH_PROFILE ?? 'web',
    version: toolsVersion,
  };
}

function defaultAppPath() {
  if (fs.existsSync(DEFAULT_APP)) return DEFAULT_APP;
  try {
    if (fs.existsSync(PATHS_CONFIG)) {
      const parsed = JSON.parse(fs.readFileSync(PATHS_CONFIG, 'utf8'));
      if (typeof parsed?.app === 'string' && parsed.app.trim() && fs.existsSync(parsed.app)) return parsed.app;
    }
  } catch {}
  if (process.platform === 'win32') {
    const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : null;
    if (localPrograms && fs.existsSync(localPrograms)) return localPrograms;
  } else {
    const unixCandidates = [
      '/opt/DeepSeek Harness',
      '/opt/deepseek-harness',
      '/Applications/DeepSeek Harness.app/Contents',
      '/usr/local/lib/node_modules/@deepseek-ai/dsh',
      '/usr/lib/node_modules/@deepseek-ai/dsh',
      '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
      ...(process.env.HOME ? [path.join(process.env.HOME, '.local', 'share', 'dsh-runtime', 'current')] : []),
    ];
    for (const cand of unixCandidates) {
      if (fs.existsSync(cand)) return cand;
    }
    const pathSep = ':';
    const binDirs = [
      ...String(process.env.PATH ?? '').split(pathSep).filter(Boolean),
      ...(process.env.HOME ? [path.join(process.env.HOME, '.local', 'bin')] : []),
    ];
    for (const binDir of binDirs) {
      const dshBin = path.join(binDir, 'dsh');
      if (!fs.existsSync(dshBin)) continue;
      try {
        const real = fs.realpathSync(dshBin);
        const norm = real.replaceAll('\\', '/');
        const nmIdx = norm.lastIndexOf('/node_modules/');
        if (nmIdx > 0) return real.slice(0, nmIdx);
        return path.dirname(path.dirname(real));
      } catch {}
    }
  }
  return DEFAULT_APP;
}

function requireFile(file, layout, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Unknown DSH runtime layout (${layout}); missing ${label}: ${file}`);
  }
}

function appFromModuleRoot(moduleRoot) {
  if (path.basename(path.dirname(moduleRoot)) === 'app.asar') return path.dirname(path.dirname(path.dirname(moduleRoot)));
  if (path.basename(moduleRoot) === 'app.asar') return path.dirname(path.dirname(moduleRoot));
  return path.dirname(moduleRoot);
}

function resolveLabRuntime() {
  const exe = process.env.LT_DSH_EXEC;
  const entry = process.env.LT_DSH_ENTRY;
  const bin = process.env.LT_DSH_BIN;
  if (!exe || !entry || !bin) {
    throw new Error(`Lab DSH runtime requires LT_DSH_EXEC, LT_DSH_ENTRY, and LT_DSH_BIN (got exe=${Boolean(exe)}, entry=${Boolean(entry)}, bin=${Boolean(bin)})`);
  }
  const normalizedBin = bin.replaceAll('\\', '/');
  const marker = normalizedBin.lastIndexOf('/node_modules/');
  if (marker < 0) throw new Error('LT_DSH_BIN must point inside a DSH node_modules tree');
  const moduleRoot = bin.slice(0, marker);
  const official = normalizedBin.slice(0, marker).endsWith('/resources/app.asar/dsh');
  const cliArgs = [...splitShellArgs(process.env.LT_DSH_EXEC_ARGS ?? ''), entry, bin];
  return {
    kind: 'lab',
    app: process.env.LT_DSH_APP ?? appFromModuleRoot(moduleRoot),
    exe,
    cliArgs,
    moduleRoot,
    profile: official ? 'desktop' : process.env.LT_DSH_PROFILE ?? null,
    version: process.env.LT_DSH_VERSION ?? null,
  };
}

function findOfficialDesktopExecutable(app) {
  for (const name of [OFFICIAL_EXE_WIN, ...OFFICIAL_EXE_LINUX_CANDIDATES]) {
    const full = path.join(app, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

function resolveOfficialRuntime(app) {
  const exePath = findOfficialDesktopExecutable(app);
  if (!exePath) {
    requireFile(path.join(app, OFFICIAL_EXE_WIN), 'official-desktop', 'DeepSeek Harness executable');
  }
  const asarFile = path.join(app, 'resources', 'app.asar');
  const asarPackage = path.join(asarFile, 'dsh', 'package.json');
  if (!((fs.existsSync(asarFile) && fs.statSync(asarFile).isFile()) || fs.existsSync(asarPackage))) {
    throw new Error(`Unknown DSH runtime layout (official-desktop); missing resources/app.asar: ${asarFile}`);
  }
  const winCli = path.join(app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const unixCli = path.join(app, 'resources', 'runtime', 'cli', 'bin', 'dsh');
  if (!(fs.existsSync(winCli) && fs.statSync(winCli).isFile()) && !(fs.existsSync(unixCli) && fs.statSync(unixCli).isFile())) {
    requireFile(winCli, 'official-desktop', 'official dsh CLI');
  }
  const runtimeFile = path.join(app, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
  requireFile(runtimeFile, 'official-desktop', 'primary runtime metadata');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  if (!EXTRA_VERIFIED_VERSIONS.includes(runtime.desktopVersion) && !isWithinAdaptiveHostRange(runtime.desktopVersion)) {
    if (runtime.desktopVersion !== '0.2.2-rc.1') throw new Error(`Unsupported official DSH desktop version: ${runtime.desktopVersion}`);
  }
  return {
    kind: 'official-desktop',
    app,
    exe: exePath,
    cliArgs: ['--expose-internals', path.join(app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
    moduleRoot: path.join(app, 'resources', 'app.asar', 'dsh'),
    profile: 'desktop',
    version: runtime.desktopVersion,
  };
}

function resolveLegacyRuntime(app) {
  const exe = path.join(app, LEGACY_EXE);
  const entry = path.join(app, 'resources', 'harness-node-entry.mjs');
  requireFile(exe, 'legacy-dataelem', 'DSH Desktop.exe');
  requireFile(path.join(app, 'resources', 'app.asar'), 'legacy-dataelem', 'resources/app.asar');
  requireFile(entry, 'legacy-dataelem', 'harness-node-entry.mjs');
  return {
    kind: 'legacy-dataelem',
    app,
    exe,
    cliArgs: [entry, path.join(app, 'resources', 'app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    moduleRoot: path.join(app, 'resources', 'app.asar'),
    profile: process.env.LT_DSH_PROFILE ?? null,
    version: /^dsh-desktop-(.+)$/.exec(path.basename(app))?.[1] ?? null,
  };
}

function resolveConfiguredRuntime(app) {
  if (!fs.existsSync(app) || !fs.statSync(app).isDirectory()) throw new Error(`DSH app directory not found: ${app}`);
  if (findOfficialDesktopExecutable(app)) return resolveOfficialRuntime(app);
  if (fs.existsSync(path.join(app, LEGACY_EXE))) return resolveLegacyRuntime(app);
  const npmCli = resolveNpmCliRuntime(app);
  if (npmCli) return npmCli;
  throw new Error(`Unknown DSH runtime layout; neither official, legacy, nor npm-cli layout found in: ${app}`);
}

export function resolveDshRuntime(appDir) {
  if (appDir) return resolveConfiguredRuntime(path.resolve(appDir));
  if (process.env.LT_DSH_EXEC) return resolveLabRuntime();
  return resolveConfiguredRuntime(path.resolve(process.env.LT_DSH_APP ?? defaultAppPath()));
}

export function verifyOfficialArtifact(runtime) {
  if (runtime.kind !== 'official-desktop') return runtime;
  const result = spawnSync(runtime.exe, [path.join(ROOT, 'scripts/dev/inspect-dsh-artifact.cjs')], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.status !== 0) throw new Error('Official Desktop artifact identity cannot be verified.');
  let artifact;
  try { artifact = JSON.parse(result.stdout); } catch { throw new Error('Official Desktop artifact metadata is invalid.'); }
  if (artifact.packageName !== '@deepseek-ai/dsh-desktop' || artifact.desktopVersion !== runtime.version ||
      (!EXTRA_VERIFIED_VERSIONS.includes(artifact.toolsVersion) && !isWithinAdaptiveHostRange(artifact.toolsVersion) && artifact.toolsVersion !== '0.2.2-rc.1') ||
      (artifact.toolsVersion === '0.2.2-rc.1' && artifact.pipelineSHA256 !== 'f6c850cefce30831c4c5f160e831856b105935331bacd1ae0823129001614bc6')) {
    throw new Error('Official Desktop artifact differs from the qualified release.');
  }
  return { ...runtime, artifact };
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
  const args = process.argv.slice(2);
  if (args[0] !== '--json' || (args.length !== 1 && !(args.length === 3 && args[1] === '--app' && args[2]))) {
    console.error('Usage: node scripts/dsh-runtime.mjs --json [--app <app directory>]');
    process.exit(2);
  }
  console.log(JSON.stringify(verifyOfficialArtifact(resolveDshRuntime(args[1] === '--app' ? args[2] : undefined)), null, 2));
}
