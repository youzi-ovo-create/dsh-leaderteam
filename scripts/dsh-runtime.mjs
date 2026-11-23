import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APP = path.join(ROOT, 'runtime', 'official-desktop', '0.2.2-rc.1');
const PATHS_CONFIG = path.join(ROOT, 'config', 'official-desktop.paths.json');
const OFFICIAL_EXE = 'DeepSeek Harness.exe';
const LEGACY_EXE = 'DSH Desktop.exe';

function defaultAppPath() {
  if (fs.existsSync(DEFAULT_APP)) return DEFAULT_APP;
  try {
    if (fs.existsSync(PATHS_CONFIG)) {
      const parsed = JSON.parse(fs.readFileSync(PATHS_CONFIG, 'utf8'));
      if (typeof parsed?.app === 'string' && parsed.app.trim() && fs.existsSync(parsed.app)) return parsed.app;
    }
  } catch {}
  const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness') : null;
  if (localPrograms && fs.existsSync(localPrograms)) return localPrograms;
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
  const cliArgs = [...(process.env.LT_DSH_EXEC_ARGS ?? '').split(' ').filter(Boolean), entry, bin];
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

function resolveOfficialRuntime(app) {
  requireFile(path.join(app, OFFICIAL_EXE), 'official-desktop', 'DeepSeek Harness.exe');
  const asarFile = path.join(app, 'resources', 'app.asar');
  const asarPackage = path.join(asarFile, 'dsh', 'package.json');
  if (!((fs.existsSync(asarFile) && fs.statSync(asarFile).isFile()) || fs.existsSync(asarPackage))) {
    throw new Error(`Unknown DSH runtime layout (official-desktop); missing resources/app.asar: ${asarFile}`);
  }
  requireFile(path.join(app, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), 'official-desktop', 'official dsh.cmd');
  const runtimeFile = path.join(app, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
  requireFile(runtimeFile, 'official-desktop', 'primary runtime metadata');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  if (runtime.desktopVersion !== '0.2.2-rc.1') throw new Error(`Unsupported official DSH desktop version: ${runtime.desktopVersion}`);
  return {
    kind: 'official-desktop',
    app,
    exe: path.join(app, OFFICIAL_EXE),
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
  if (fs.existsSync(path.join(app, OFFICIAL_EXE))) return resolveOfficialRuntime(app);
  if (fs.existsSync(path.join(app, LEGACY_EXE))) return resolveLegacyRuntime(app);
  throw new Error(`Unknown DSH runtime layout; neither official nor legacy executable found in: ${app}`);
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
      artifact.toolsVersion !== '0.2.2-rc.1' || artifact.pipelineSHA256 !== 'f6c850cefce30831c4c5f160e831856b105935331bacd1ae0823129001614bc6') {
    throw new Error('Official Desktop artifact differs from the qualified release.');
  }
  return { ...runtime, artifact };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== '--json' || (args.length !== 1 && !(args.length === 3 && args[1] === '--app' && args[2]))) {
    console.error('Usage: node scripts/dsh-runtime.mjs --json [--app <app directory>]');
    process.exit(2);
  }
  console.log(JSON.stringify(verifyOfficialArtifact(resolveDshRuntime(args[1] === '--app' ? args[2] : undefined)), null, 2));
}
