import fs from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import path, { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const peers = new Set(['@deepseek-ai/dsh-session', '@deepseek-ai/schemastery']);
const selfDir = dirname(fileURLToPath(import.meta.url));
const scope = new URL('./', import.meta.url).href;

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function walkAncestors(seedPath, maxDepth = 10) {
  const out = [];
  if (!seedPath) return out;
  for (const s of [seedPath, safeRealpath(seedPath)]) {
    let cur = path.resolve(s);
    try {
      if (fs.existsSync(cur) && fs.statSync(cur).isFile()) cur = dirname(cur);
    } catch {
      cur = dirname(cur);
    }
    for (let i = 0; i < maxDepth; i++) {
      out.push(cur);
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return out;
}

function canResolvePeers(req) {
  try {
    for (const p of peers) req.resolve(p);
    return true;
  } catch {
    return false;
  }
}

function locateHostResolver() {
  const appDir = dirname(process.execPath);
  const [, entry, runtimeDir] = process.argv;
  const candidateDirs = [
    process.env.LT_DSH_MODULE_ROOT,
    process.env.DSH_MODULE_ROOT,
    join(appDir, 'resources', 'app', 'dsh'),
    join(appDir, 'resources', 'app.asar', 'dsh'),
    join(appDir, 'resources', 'app.asar'),
    ...walkAncestors(entry, 10),
    ...(runtimeDir && path.isAbsolute(runtimeDir) ? walkAncestors(runtimeDir, 6) : []),
    ...walkAncestors(selfDir, 8),
  ].filter(Boolean);

  const carrierSpecs = [
    '@deepseek-ai/dsh/package.json',
    '@deepseek-ai/dsh-base/package.json',
    '@deepseek-ai/dsh-desktop-host/package.json',
    '@deepseek-ai/dsh-headless/package.json',
    '@deepseek-ai/dsh-web/package.json',
  ];

  const seen = new Set();
  for (const dir of candidateDirs) {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);

    const pkgCandidates = [
      join(dir, 'package.json'),
      join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      join(dir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
      join(dir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'),
    ];
    for (const pkgFile of pkgCandidates) {
      if (!fs.existsSync(pkgFile)) continue;
      let req;
      try { req = createRequire(pathToFileURL(pkgFile)); } catch { continue; }
      if (canResolvePeers(req)) return req;
      for (const hop of carrierSpecs) {
        try {
          const hopPkg = req.resolve(hop);
          const hopReq = createRequire(pathToFileURL(hopPkg));
          if (canResolvePeers(hopReq)) return hopReq;
        } catch {}
      }
    }
  }
  // Fallback for mocked/legacy environments
  return createRequire(pathToFileURL(join(appDir, 'resources', 'app.asar', 'dsh', 'package.json')));
}

const host = locateHostResolver();
registerHooks({
  resolve(specifier, context, next) {
    if (peers.has(specifier) && context.parentURL?.startsWith(scope)) {
      return { url: pathToFileURL(host.resolve(specifier)).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const plugin = await import('./index.js');
export const name = plugin.name;
export const inject = plugin.inject;
export const Config = plugin.Config;
export const apply = plugin.apply;
