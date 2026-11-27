#!/usr/bin/env node
// One-command Desktop & Magpie onboarding installer for LeaderTeam (Windows + macOS + Linux).
// Zero external npm dependencies; isolates LeaderTeam's Magpie gateway provider (`lt-magpie`) from Magpie GUI overwrites,
// installs the dsh.bundle into the Desktop profile via Electron's embedded CLI, clears stale blank-session snapshots,
// and optionally grants Windows Sandbox workspace ACLs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTeamExecutionStarted } from '../leaderteam/host/runtime.mjs';
import { TeamStore, writeFileAtomic } from '../leaderteam/core/store.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');

function parseArgs(argv) {
  const opts = {
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    dshApp: process.env.LT_DSH_APP || null,
    profile: 'desktop',
    packageSource: REPO_ROOT,
    magpieUrl: null,
    magpieKey: 'magpie-local',
    providerId: 'lt-magpie',
    grantWorkspaces: [],
    stopDesktop: false,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--stop-desktop') opts.stopDesktop = true;
    else if (a === '--dsh-home' && argv[i + 1]) opts.dshHome = path.resolve(argv[++i]);
    else if (a === '--dsh-app' && argv[i + 1]) opts.dshApp = path.resolve(argv[++i]);
    else if (a === '--profile' && argv[i + 1]) opts.profile = argv[++i];
    else if (a === '--package' && argv[i + 1]) opts.packageSource = path.resolve(argv[++i]);
    else if (a === '--magpie-url' && argv[i + 1]) opts.magpieUrl = argv[++i];
    else if (a === '--magpie-key' && argv[i + 1]) opts.magpieKey = argv[++i];
    else if (a === '--provider-id' && argv[i + 1]) opts.providerId = argv[++i];
    else if (a === '--grant-acl' && argv[i + 1]) opts.grantWorkspaces.push(path.resolve(argv[++i]));
  }
  return opts;
}

function buildOfficialAppCandidate(appDir) {
  return {
    appDir,
    exe: path.join(appDir, 'DeepSeek Harness.exe'),
    cli: path.join(appDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    electron: true,
  };
}

export function locateDesktopCli(platform = process.platform, env = process.env, fsImpl = fs, explicitApp = null) {
  const candidates = [];
  if (explicitApp) {
    if (platform === 'win32') candidates.push(buildOfficialAppCandidate(path.resolve(explicitApp)));
    else candidates.push({
      appDir: path.resolve(explicitApp),
      exe: path.join(path.resolve(explicitApp), 'deepseek-harness'),
      cli: path.join(path.resolve(explicitApp), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
      electron: true,
    });
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(buildOfficialAppCandidate(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')));
    if (env.ProgramFiles) candidates.push(buildOfficialAppCandidate(path.join(env.ProgramFiles, 'DeepSeek Harness')));
    try {
      const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DeepSeek Harness'], {
        windowsHide: true,
        encoding: 'utf8',
      });
      for (const line of String(reg.stdout ?? '').split(/\r?\n/)) {
        const m = /^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/i.exec(line);
        if (m?.[1]) candidates.push(buildOfficialAppCandidate(m[1].replace(/^"+|"+$/g, '')));
      }
    } catch {}
  } else if (platform === 'darwin') {
    candidates.push({
      exe: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
      cli: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',
      electron: true,
    });
  }
  for (const c of candidates) {
    try {
      if (fsImpl.existsSync(c.exe)) return c;
    } catch {}
  }
  return { exe: 'dsh', cli: null, electron: false };
}

export function ensureIsolatedMagpieProviderInCredentials(credentialsFile, apiKey = 'magpie-local', fsImpl = fs) {
  let text = '';
  try {
    if (fsImpl.existsSync(credentialsFile)) text = fsImpl.readFileSync(credentialsFile, 'utf8');
  } catch {}
  const normalized = text ? text.replace(/\r\n/g, '\n') : '';
  const hasLtKey = /(?:^|\n)\s*LEADERTEAM_MAGPIE_KEY\s*:/.test(normalized);
  const hasGwKey = /(?:^|\n)\s*MAGPIE_GATEWAY_KEY\s*:/.test(normalized);
  const hasVersion1 = /(?:^|\n)version\s*:\s*1\b/.test(normalized);
  let changed = false;

  if (!normalized.trim()) {
    const out = [
      'version: 1',
      'refs:',
      `  LEADERTEAM_MAGPIE_KEY: ${JSON.stringify(apiKey)}`,
      `  MAGPIE_GATEWAY_KEY: ${JSON.stringify(apiKey)}`,
    ].join('\n') + '\n';
    fsImpl.mkdirSync(path.dirname(credentialsFile), { recursive: true });
    writeFileAtomic(credentialsFile, out);
    return { changed: true, file: credentialsFile };
  }

  let lines = normalized.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (!hasVersion1) {
    // Migrate pre-release flat YAML layout into `version: 1` + `refs:`
    lines = [
      'version: 1',
      'refs:',
      ...lines.map(l => (l.trim() ? `  ${l.trimStart()}` : l)),
    ];
    changed = true;
  }

  let refsIdx = lines.findIndex(l => /^refs\s*:\s*(?:#.*)?$/.test(l));
  if (refsIdx < 0) {
    // Handle `refs: {}` or missing `refs:` section
    const emptyRefsIdx = lines.findIndex(l => /^refs\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(l));
    if (emptyRefsIdx >= 0) {
      lines[emptyRefsIdx] = 'refs:';
      refsIdx = emptyRefsIdx;
    } else {
      lines.push('refs:');
      refsIdx = lines.length - 1;
    }
    changed = true;
  }

  const additions = [];
  if (!hasLtKey) additions.push(`  LEADERTEAM_MAGPIE_KEY: ${JSON.stringify(apiKey)}`);
  if (!hasGwKey) additions.push(`  MAGPIE_GATEWAY_KEY: ${JSON.stringify(apiKey)}`);
  if (additions.length > 0) {
    lines.splice(refsIdx + 1, 0, ...additions);
    changed = true;
  }

  if (changed) {
    fsImpl.mkdirSync(path.dirname(credentialsFile), { recursive: true });
    writeFileAtomic(credentialsFile, lines.join('\n') + '\n');
  }
  return { changed, file: credentialsFile };
}

export function pruneUnstartedBlankGovernanceSnapshots(storageRoot, fsImpl = fs) {
  const teamsDir = path.join(storageRoot, 'teams');
  if (!fsImpl.existsSync(teamsDir)) return [];
  const removed = [];
  for (const d of fsImpl.readdirSync(teamsDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const store = new TeamStore(storageRoot, d.name);
      const govFile = path.join(store.dir, 'governance.json');
      if (fsImpl.existsSync(govFile) && !isTeamExecutionStarted(store)) {
        fsImpl.unlinkSync(govFile);
        removed.push(d.name);
      }
    } catch {}
  }
  return removed;
}

export function upgradeManagedConfigWebTools(storageRoot, fsImpl = fs) {
  const cfgFile = path.join(storageRoot, 'config', 'leaderteam.config.json');
  if (!fsImpl.existsSync(cfgFile)) return false;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(cfgFile, 'utf8'));
    let changed = false;
    for (const prof of ['leader', 'readonly', 'shell']) {
      const list = raw?.profiles?.[prof]?.tools;
      if (!Array.isArray(list)) continue;
      for (const tool of ['web_search', 'web_fetch']) {
        if (!list.includes(tool)) {
          const anchor = list.indexOf('grep');
          if (anchor >= 0) list.splice(anchor + 1, 0, tool);
          else list.push(tool);
          changed = true;
        }
      }
    }
    if (changed) writeFileAtomic(cfgFile, JSON.stringify(raw, null, 2) + '\n');
    return changed;
  } catch {
    return false;
  }
}

function runDshPluginCmd(desktopCli, profile, subArgs, dshHome) {
  const env = { ...process.env, DSH_HOME: dshHome };
  if (desktopCli.electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
    return spawnSync(desktopCli.exe, ['--expose-internals', desktopCli.cli, 'plugin', '--profile', profile, ...subArgs], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
  }
  return spawnSync(desktopCli.exe, ['plugin', '--profile', profile, ...subArgs], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
}

export function runDesktopSetup(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log([
      'Usage: lt-setup-desktop [options]',
      '  --dsh-home <dir>        DSH home directory (default: ~/.dsh)',
      '  --profile <name>        Target DSH profile (default: desktop)',
      '  --package <path|tgz>    LeaderTeam bundle path or .tgz (default: current package)',
      '  --magpie-url <url>      Configure isolated lt-magpie provider (e.g. http://127.0.0.1:3425/v1)',
      '  --magpie-key <key>      API key for local Magpie gateway (default: magpie-local)',
      '  --grant-acl <dir>       Grant Windows Sandbox write ACL on a workspace directory (repeatable)',
      '  --stop-desktop          Close running DeepSeek Harness Desktop before modifying profile files',
      '  --dry-run               Report planned actions without writing files',
      '  --json                  Print JSON report',
    ].join('\n'));
    return { ok: true, help: true };
  }

  const desktopCli = locateDesktopCli(process.platform, process.env, fs, opts.dshApp);
  const storageRoot = path.join(opts.dshHome, 'leaderteam');
  const credentialsFile = path.join(opts.dshHome, '.credentials.yaml');
  const steps = [];

  if (opts.stopDesktop && process.platform === 'win32' && !opts.dryRun) {
    spawnSync('taskkill', ['/IM', 'DeepSeek Harness.exe', '/F'], { windowsHide: true, encoding: 'utf8' });
    const lockFile = process.env.APPDATA ? path.join(process.env.APPDATA, '@deepseek-ai', 'dsh-desktop', 'lockfile') : null;
    if (lockFile && fs.existsSync(lockFile)) {
      try { fs.unlinkSync(lockFile); } catch {}
    }
    steps.push({ step: 'stop-desktop', status: 'ok' });
  }

  if (opts.magpieUrl) {
    if (!opts.dryRun) {
      const credRes = ensureIsolatedMagpieProviderInCredentials(credentialsFile, opts.magpieKey);
      steps.push({ step: 'credentials-lt-magpie', status: 'ok', changed: credRes.changed });
    } else {
      steps.push({ step: 'credentials-lt-magpie', status: 'dry-run' });
    }
  }

  if (!opts.dryRun) {
    runDshPluginCmd(desktopCli, opts.profile, ['remove', 'dsh-leaderteam'], opts.dshHome);
    const addRes = runDshPluginCmd(desktopCli, opts.profile, ['add', opts.packageSource], opts.dshHome);
    if (addRes.status !== 0) {
      const err = (addRes.stderr || addRes.stdout || `exit ${addRes.status}`).trim();
      throw new Error(`dsh plugin add failed: ${err}`);
    }
    steps.push({ step: 'plugin-install', status: 'ok', target: opts.packageSource, profile: opts.profile });
    const cleared = pruneUnstartedBlankGovernanceSnapshots(storageRoot);
    const upgradedTools = upgradeManagedConfigWebTools(storageRoot);
    steps.push({ step: 'refresh-unstarted-sessions', status: 'ok', clearedBlankTeamSnapshots: cleared.length, upgradedWebTools: upgradedTools });
  } else {
    steps.push({ step: 'plugin-install', status: 'dry-run', target: opts.packageSource, profile: opts.profile, cli: desktopCli });
  }

  if (process.platform === 'win32' && opts.grantWorkspaces.length > 0) {
    for (const ws of opts.grantWorkspaces) {
      if (opts.dryRun) {
        steps.push({ step: 'grant-workspace-acl', status: 'dry-run', workspace: ws });
        continue;
      }
      fs.mkdirSync(ws, { recursive: true });
      const r1 = spawnSync('icacls', [ws, '/grant', '*S-1-15-2-1:(OI)(CI)M', '/T', '/C', '/Q'], { windowsHide: true, encoding: 'utf8' });
      const r2 = spawnSync('icacls', [ws, '/grant', '*S-1-5-12:(OI)(CI)M', '/T', '/C', '/Q'], { windowsHide: true, encoding: 'utf8' });
      steps.push({ step: 'grant-workspace-acl', status: (r1.status === 0 && r2.status === 0) ? 'ok' : 'warn', workspace: ws });
    }
  }

  const report = { ok: true, dshHome: opts.dshHome, profile: opts.profile, desktopCli, steps };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`LeaderTeam Desktop Setup (${opts.dryRun ? 'DRY-RUN' : 'APPLIED'}):`);
    for (const s of steps) console.log(`  - [${s.status.toUpperCase()}] ${s.step}${s.target ? ` (${s.target})` : ''}${s.workspace ? ` (${s.workspace})` : ''}`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDesktopSetup(process.argv.slice(2));
  } catch (err) {
    console.error(`lt-setup-desktop error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
