// Bind this plugin's peer imports to the exact packages loaded by its executing DSH host.
// Supports both Official DSH Desktop (Electron app.asar on Windows/macOS) and cross-platform
// `@deepseek-ai/dsh` CLI / `dsh web` / `dsh headless` / `dsh.bundle` installations on Linux, WSL2, macOS, and Windows.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KEY = Symbol.for('leaderteam.hostImports.v1');
const PEERS = new Set([
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tools/pipeline',
  '@deepseek-ai/dsh-tools/package.json',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tool-executor-native',
]);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginURL = pathToFileURL(pluginRoot + path.sep).href;
const foldUrl = u => (process.platform === 'win32' ? u.toLowerCase() : u);

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function walkAncestors(startFileOrDir, maxDepth = 10) {
  const out = [];
  if (!startFileOrDir || typeof startFileOrDir !== 'string') return out;
  for (const seed of [startFileOrDir, safeRealpath(startFileOrDir)]) {
    let cur = path.resolve(seed);
    try {
      if (fs.existsSync(cur) && fs.statSync(cur).isFile()) cur = path.dirname(cur);
    } catch {
      cur = path.dirname(cur);
    }
    for (let i = 0; i < maxDepth; i++) {
      out.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return out;
}

function resolveAnchorFromCandidate(dir) {
  if (!dir || typeof dir !== 'string') return null;
  const directPkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json');
  if (fs.existsSync(directPkg)) {
    const anchorPkg = path.join(dir, 'package.json');
    return {
      moduleRoot: dir,
      anchor: pathToFileURL(fs.existsSync(anchorPkg) ? anchorPkg : directPkg).href,
    };
  }
  // Support npm / pnpm layouts where `@deepseek-ai/dsh` resolves `@deepseek-ai/dsh-tools` as a dependency or sibling
  const candidatePkgs = [
    path.join(dir, 'package.json'),
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ];
  for (const pkgJson of candidatePkgs) {
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const req = createRequire(pkgJson);
      const toolsPkg = req.resolve('@deepseek-ai/dsh-tools/package.json');
      if (toolsPkg && fs.existsSync(toolsPkg)) {
        // Walk two levels up from `.../@deepseek-ai/dsh-tools/package.json` to reach the `node_modules` carrier
        const nmDir = path.resolve(path.dirname(toolsPkg), '..', '..');
        const carrierDir = path.basename(nmDir) === 'node_modules' ? path.dirname(nmDir) : path.dirname(pkgJson);
        return {
          moduleRoot: carrierDir,
          anchor: pathToFileURL(pkgJson).href,
        };
      }
    } catch {}
  }
  return null;
}

export function locateHostAnchor(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const app = path.dirname(execPath);
  const [, entry, runtimeDir] = argv;

  const candidates = [];
  if (env.LT_DSH_MODULE_ROOT) candidates.push(env.LT_DSH_MODULE_ROOT);
  if (env.DSH_MODULE_ROOT) candidates.push(env.DSH_MODULE_ROOT);

  const desktopHost = entry && runtimeDir && path.isAbsolute(runtimeDir)
    && path.relative(path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'), entry) === '';
  if (desktopHost) {
    candidates.push(runtimeDir);
  }

  candidates.push(
    path.join(app, 'resources', 'app', 'dsh'),
    path.join(app, 'resources', 'app.asar', 'dsh'),
    path.join(app, 'resources', 'app.asar'),
  );

  // Cross-platform CLI / `dsh web` / `dsh headless` / `dsh.bundle` install tree (Linux, WSL2, macOS, Windows npm/pnpm)
  if (entry) {
    candidates.push(...walkAncestors(entry, 10));
  }
  if (runtimeDir && path.isAbsolute(runtimeDir)) {
    candidates.push(...walkAncestors(runtimeDir, 6));
  }
  // Also walk ancestors of pluginRoot itself (when installed inside `<profile>/node_modules/dsh-leaderteam`)
  candidates.push(...walkAncestors(options.pluginRoot ?? pluginRoot, 8));

  const seen = new Set();
  for (const cand of candidates) {
    if (!cand) continue;
    const key = process.platform === 'win32' ? cand.toLowerCase() : cand;
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = resolveAnchorFromCandidate(cand);
    if (hit) return hit;
  }
  return null;
}

export function bindHostImports() {
  const found = locateHostAnchor();
  if (!found) {
    throw new Error('LeaderTeam cannot locate the executing DeepSeek Harness host packages (@deepseek-ai/dsh-tools).');
  }
  const { moduleRoot, anchor } = found;
  const existing = globalThis[KEY];
  if (existing) {
    if (existing.moduleRoot !== moduleRoot || existing.pluginRoot !== pluginRoot) {
      throw new Error('Conflicting LeaderTeam host binding.');
    }
    return existing;
  }
  const normalizedPrefix = foldUrl(pluginURL);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (PEERS.has(specifier) && context.parentURL && foldUrl(context.parentURL).startsWith(normalizedPrefix)) {
        return nextResolve(specifier, { ...context, parentURL: anchor });
      }
      return nextResolve(specifier, context);
    },
  });
  const binding = Object.freeze({ moduleRoot, pluginRoot, anchor, hook });
  globalThis[KEY] = binding;
  return binding;
}
