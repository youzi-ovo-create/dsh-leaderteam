// Static, privacy-safe host runtime capability probe.
// Executed synchronously once via fs.existsSync / process metadata (zero subprocess spawns,
// zero console popups, zero user home paths exposed) so the Leader knows standard host
// toolchains and headless browser availability at Turn 1 without blind out-of-sandbox probes.
import fs from 'node:fs';
import path from 'node:path';

const STANDARD_CLI_PROBES = Object.freeze([
  { id: 'git', bins: ['git'] },
  { id: 'npm', bins: ['npm'] },
  { id: 'pnpm', bins: ['pnpm'] },
  { id: 'yarn', bins: ['yarn'] },
  { id: 'python', bins: ['python3', 'python'] },
  { id: 'cargo', bins: ['cargo'] },
  { id: 'rustc', bins: ['rustc'] },
  { id: 'go', bins: ['go'] },
]);

const SYSTEM_BROWSER_PROBES = Object.freeze({
  win32: [
    { kind: 'chrome', paths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'], pathBins: ['chrome'] },
    { kind: 'edge', paths: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'], pathBins: ['msedge'] },
    { kind: 'chromium', paths: ['C:\\Program Files\\Chromium\\Application\\chrome.exe'], pathBins: ['chromium'] },
  ],
  linux: [
    { kind: 'chromium', paths: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'], pathBins: ['chromium', 'chromium-browser'] },
    { kind: 'chrome', paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'], pathBins: ['google-chrome', 'google-chrome-stable'] },
    { kind: 'edge', paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'], pathBins: ['microsoft-edge'] },
  ],
  darwin: [
    { kind: 'chrome', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], pathBins: ['google-chrome'] },
    { kind: 'edge', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'], pathBins: ['microsoft-edge'] },
    { kind: 'chromium', paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'], pathBins: ['chromium'] },
  ],
});

function hasBinInPathDirs(pathDirs, binNames, platform, fsImpl) {
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathDirs) {
    for (const bin of binNames) {
      for (const ext of exts) {
        try {
          if (fsImpl.existsSync(path.join(dir, `${bin}${ext}`))) return true;
        } catch {}
      }
    }
  }
  return false;
}

export function probeHostRuntimeFacts({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.version,
  env = process.env,
  fsImpl = fs,
} = {}) {
  const rawPath = String(env?.PATH ?? env?.Path ?? '');
  const sep = platform === 'win32' ? ';' : ':';
  const pathDirs = rawPath.split(sep).map(s => s.trim()).filter(Boolean).slice(0, 80);

  const pathCli = [];
  for (const item of STANDARD_CLI_PROBES) {
    if (hasBinInPathDirs(pathDirs, item.bins, platform, fsImpl)) {
      pathCli.push(item.id);
    }
  }

  const browsers = [];
  const browserDefs = SYSTEM_BROWSER_PROBES[platform] ?? SYSTEM_BROWSER_PROBES.linux;
  for (const b of browserDefs) {
    let found = b.paths.some(p => {
      try { return fsImpl.existsSync(p); } catch { return false; }
    });
    if (!found && b.pathBins?.length) {
      found = hasBinInPathDirs(pathDirs, b.pathBins, platform, fsImpl);
    }
    if (found) browsers.push(b.kind);
  }

  return Object.freeze({
    platform,
    arch,
    nodeVersion,
    pathCli: Object.freeze(pathCli),
    systemBrowsers: Object.freeze(browsers),
  });
}

let cachedFacts = null;

export function cachedHostRuntimeFacts() {
  if (!cachedFacts) cachedFacts = probeHostRuntimeFacts();
  return cachedFacts;
}

export function formatHostRuntimeFacts(facts = cachedHostRuntimeFacts()) {
  const cliList = facts.pathCli?.length ? facts.pathCli.join(',') : 'none-detected';
  const browserList = facts.systemBrowsers?.length ? facts.systemBrowsers.join(',') : 'none-in-system-dirs';
  return `Host runtime facts (verified read-only): platform=${facts.platform}/${facts.arch}, node=${facts.nodeVersion}, path_cli=[${cliList}], system_browser=[${browserList}].`;
}
