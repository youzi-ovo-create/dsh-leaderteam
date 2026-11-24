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

const HOST_CARRIER_PACKAGES = [
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/dsh-desktop-host/package.json',
  '@deepseek-ai/dsh-headless/package.json',
  '@deepseek-ai/dsh-web/package.json',
];

function tryAnchorFromPackageJson(pkgJson) {
  if (!pkgJson || !fs.existsSync(pkgJson)) return null;
  let req;
  try { req = createRequire(pkgJson); } catch { return null; }

  const canResolveAllPeers = resolver => {
    try {
      const toolsPkg = resolver.resolve('@deepseek-ai/dsh-tools/package.json');
      resolver.resolve('@deepseek-ai/dsh-llm');
      resolver.resolve('@deepseek-ai/dsh-tool-executor-native');
      return toolsPkg && fs.existsSync(toolsPkg) ? toolsPkg : null;
    } catch {
      return null;
    }
  };

  const directToolsPkg = canResolveAllPeers(req);
  if (directToolsPkg) {
    const nmDir = path.resolve(path.dirname(directToolsPkg), '..', '..');
    const carrierDir = path.basename(nmDir) === 'node_modules' ? path.dirname(nmDir) : path.dirname(pkgJson);
    return {
      moduleRoot: carrierDir,
      anchor: pathToFileURL(pkgJson).href,
    };
  }

  // Strict non-hoisted pnpm layout (`hoist=false`): `@deepseek-ai/dsh` depends on `@deepseek-ai/dsh-base`,
  // which in turn depends on `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, and `@deepseek-ai/dsh-tool-executor-native`.
  const queue = [pkgJson];
  const visited = new Set([pkgJson]);
  for (let depth = 0; depth < 2 && queue.length > 0; depth++) {
    const nextQueue = [];
    for (const currentPkg of queue) {
      let curReq;
      try { curReq = createRequire(currentPkg); } catch { continue; }
      for (const hopSpec of ['.@deepseek-ai/dsh/package.json'.slice(1), ...HOST_CARRIER_PACKAGES]) {
        let hopPkg;
        try { hopPkg = curReq.resolve(hopSpec); } catch { continue; }
        if (!hopPkg || visited.has(hopPkg) || !fs.existsSync(hopPkg)) continue;
        visited.add(hopPkg);
        let hopReq;
        try { hopReq = createRequire(hopPkg); } catch { continue; }
        const hopToolsPkg = canResolveAllPeers(hopReq);
        if (hopToolsPkg) {
          const nmDir = path.resolve(path.dirname(hopToolsPkg), '..', '..');
          const carrierDir = path.basename(nmDir) === 'node_modules' ? path.dirname(nmDir) : path.dirname(hopPkg);
          return {
            moduleRoot: carrierDir,
            anchor: pathToFileURL(hopPkg).href,
          };
        }
        nextQueue.push(hopPkg);
      }
    }
    queue.splice(0, queue.length, ...nextQueue);
  }
  return null;
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
  // Support npm / strict pnpm layouts where `@deepseek-ai/dsh` or `@deepseek-ai/dsh-base` resolves `@deepseek-ai/dsh-tools`
  const candidatePkgs = [
    path.join(dir, 'package.json'),
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'),
  ];
  for (const pkgJson of candidatePkgs) {
    const resolved = tryAnchorFromPackageJson(pkgJson);
    if (resolved) return resolved;
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
  const existing = globalThis[KEY];
  if (existing && existing.pluginRoot === pluginRoot && !process.env.LT_DSH_MODULE_ROOT && !process.env.DSH_MODULE_ROOT) {
    return existing;
  }
  const found = locateHostAnchor();
  if (!found) {
    throw new Error('LeaderTeam cannot locate the executing DeepSeek Harness host packages (@deepseek-ai/dsh-tools).');
  }
  const { moduleRoot, anchor } = found;
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
