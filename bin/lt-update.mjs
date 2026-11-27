#!/usr/bin/env node
/**
 * `lt-update` — Update Checker, One-Click Upgrader & Rollback CLI for LeaderTeam (Issue #3).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkForUpdates,
  performOneClickUpgrade,
  rollbackToSavedBackup,
  listSavedBackups,
  readInstalledVersionInfo,
} from '../leaderteam/core/updater.mjs';
import { checkDshHostCompatibility } from './lt-doctor.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(THIS_DIR, '..');

function parseArgs(argv) {
  const opts = {
    action: 'check', // 'check' | 'apply' | 'rollback' | 'backups'
    track: null,
    confirmTrackSwitch: null,
    tgz: null,
    tag: null,
    sha256: null,
    backupId: null,
    dshHome: null,
    profile: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.action = 'check';
    else if (a === '--apply' || a === '--upgrade') opts.action = 'apply';
    else if (a === '--rollback') opts.action = 'rollback';
    else if (a === '--backups') opts.action = 'backups';
    else if (a === '--track' && argv[i + 1]) opts.track = argv[++i];
    else if (a === '--confirm-track-switch' && argv[i + 1]) opts.confirmTrackSwitch = argv[++i];
    else if (a === '--tgz' && argv[i + 1]) opts.tgz = argv[++i];
    else if (a === '--tag' && argv[i + 1]) opts.tag = argv[++i];
    else if (a === '--sha256' && argv[i + 1]) opts.sha256 = argv[++i];
    else if (a === '--backup-id' && argv[i + 1]) opts.backupId = argv[++i];
    else if (a === '--dsh-home' && argv[i + 1]) opts.dshHome = argv[++i];
    else if (a === '--profile' && argv[i + 1]) opts.profile = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log([
    'Usage: lt-update [options]',
    '',
    'Actions:',
    '  --check                          Check current track for new releases (default)',
    '  --apply                          Download, verify SHA-256, check host compat, backup & upgrade',
    '  --rollback                       Roll back to the most recent (or --backup-id) snapshot',
    '  --backups                        List saved local rollback snapshots',
    '',
    'Options:',
    '  --tgz <file>                     Upgrade from a local .tgz bundle instead of GitHub Release',
    '  --sha256 <hex>                   Expected SHA-256 digest for verification',
    '  --track <open-source|closed-free> Explicit release track',
    '  --confirm-track-switch <token>   Explicit confirmation token when switching tracks',
    '  --profile <web|desktop>          Target DSH profile (default: web)',
    '  --dsh-home <dir>                 Override DSH_HOME directory',
    '  --json                           Output machine-readable JSON',
    '  -h, --help                       Show this help message',
  ].join('\n'));
}

function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === fileURLToPath(metaUrl);
  }
}

if (isMain(import.meta.url)) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const storageRoot = path.join(dshHome, 'leaderteam');
    const hostCheck = checkDshHostCompatibility();

    if (opts.action === 'backups') {
      const backups = listSavedBackups(storageRoot);
      if (opts.json) console.log(JSON.stringify({ ok: true, backups }, null, 2));
      else if (backups.length === 0) console.log('暂无本地升级备份快照。');
      else {
        for (const b of backups) {
          console.log(`- ${b.backupId}: v${b.fromVersion} (${b.fromTrack}) -> v${b.toVersion} @ ${b.createdAt}`);
        }
      }
      process.exit(0);
    }

    if (opts.action === 'check') {
      const res = await checkForUpdates({
        pluginRoot: PLUGIN_ROOT,
        storageRoot,
        track: opts.track,
        targetTag: opts.tag,
        force: true,
        currentHostVersion: hostCheck.toolsVersion,
      });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...res }, null, 2));
      else {
        console.log(`当前版本：v${res.installedVersion} [${res.installedTrackInfo.label}]`);
        if (res.hasUpdate && res.latestRelease) {
          console.log(`发现新版本：v${res.latestRelease.version} (${res.latestRelease.publishedAt || ''})`);
          console.log(`更新说明：\n${res.latestRelease.body || '（无详细说明）'}`);
        } else {
          console.log('当前已是该发行分支最新版本。');
        }
      }
      process.exit(0);
    }

    if (opts.action === 'apply') {
      const res = await performOneClickUpgrade({
        pluginRoot: PLUGIN_ROOT,
        storageRoot,
        dshHome,
        profile: opts.profile,
        localTgzPath: opts.tgz,
        releaseTag: opts.tag,
        expectedSha256: opts.sha256,
        targetTrack: opts.track,
        confirmTrackSwitch: opts.confirmTrackSwitch,
        currentHostVersion: hostCheck.toolsVersion,
      });
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else console.log(res.message || `✔ 已升级至 v${res.toVersion}`);
      process.exit(0);
    }

    if (opts.action === 'rollback') {
      const res = await rollbackToSavedBackup({
        storageRoot,
        dshHome,
        backupId: opts.backupId,
        profile: opts.profile,
      });
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else console.log(res.message || `✔ 已回滚至 v${res.restoredVersion}`);
      process.exit(0);
    }
  })().catch(err => {
    console.error(`lt-update error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
