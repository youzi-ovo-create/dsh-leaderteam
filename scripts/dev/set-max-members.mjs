#!/usr/bin/env node
// Real-time user concurrency ceiling control for LeaderTeam execution subagents.
// Writes <storageRoot>/concurrency.json atomically; running LeaderTeam sessions apply it within <= 500ms without restart.
// Governance roles (gate, discussA, discussB, arbiter) are excluded from this ceiling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { TeamStore } from '../../leaderteam/core/store.mjs';
import {
  ACTIVE_EXECUTION_STATUSES,
  concurrencyControlPath,
  readConcurrencyControlFile,
  writeConcurrencyControlFile,
  resetAllTeamChatOverridesOnDisk,
} from '../../leaderteam/core/scheduler.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const k = args[i];
  if (k === '--status' || k === '--reset' || k === '--dry-run') {
    opts[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true;
    continue;
  }
  if (!['--max', '--home', '--storage-root', '--config'].includes(k) || !args[i + 1]) {
    throw new Error(`invalid option: ${k} (expected --max <1..200> | --status | --reset [--home <dir>] [--storage-root <dir>] [--config <file>] [--dry-run])`);
  }
  opts[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[++i];
}

const configFile = path.resolve(opts.config ?? process.env.LEADERTEAM_CONFIG ?? path.join(ROOT, 'config/leaderteam.config.json'));
const cfg = loadConfig(configFile);

function resolveStorageRoot() {
  if (opts.storageRoot) return path.resolve(opts.storageRoot);
  if (cfg.storage.root) return path.resolve(cfg.storage.root);
  if (opts.home) return path.join(path.resolve(opts.home), 'leaderteam');
  if (process.env.LT_DSH_HOME) return path.join(path.resolve(process.env.LT_DSH_HOME), 'leaderteam');
  if (process.env.DSH_HOME) return path.join(path.resolve(process.env.DSH_HOME), 'leaderteam');
  const pathsJson = path.join(ROOT, 'config/official-desktop.paths.json');
  if (fs.existsSync(pathsJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pathsJson, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof parsed?.home === 'string' && parsed.home.trim()) {
        return path.join(path.resolve(parsed.home), 'leaderteam');
      }
    } catch {}
  }
  return path.join(os.homedir(), '.dsh', 'leaderteam');
}

const storageRoot = resolveStorageRoot();
const controlFile = concurrencyControlPath(storageRoot);

let action = 'status';
if (opts.max !== undefined && opts.reset) throw new Error('specify either --max <N> or --reset, not both');
if (opts.max !== undefined) {
  const n = Number.parseInt(opts.max, 10);
  if (!Number.isInteger(n) || String(n) !== String(opts.max).trim() || n < 1 || n > 200) {
    throw new Error('--max must be an integer in [1, 200]');
  }
  action = 'set';
  if (!opts.dryRun) writeConcurrencyControlFile(storageRoot, n, 'cli');
} else if (opts.reset) {
  action = 'reset';
  if (!opts.dryRun) {
    const resetRes = writeConcurrencyControlFile(storageRoot, null, 'cli-reset');
    resetAllTeamChatOverridesOnDisk(storageRoot, resetRes.updatedAtMs);
  }
}

const currentCtrl = opts.dryRun && action === 'set'
  ? { maxActiveMembers: Number.parseInt(opts.max, 10), source: 'cli (dry-run)' }
  : (opts.dryRun && action === 'reset' ? { maxActiveMembers: null, source: 'cli-reset (dry-run)' } : readConcurrencyControlFile(storageRoot));

const effectiveUserMax = currentCtrl?.maxActiveMembers ?? cfg.team.maxActiveMembers;
const teamsDir = path.join(storageRoot, 'teams');
const activeTeams = [];
if (fs.existsSync(teamsDir)) {
  for (const id of fs.readdirSync(teamsDir)) {
    try {
      const store = new TeamStore(storageRoot, id);
      const active = [...store.members().values()].filter(m => ACTIVE_EXECUTION_STATUSES.has(m.status));
      if (active.length > 0) {
        activeTeams.push({ teamId: id, activeExecutionMembers: active.length, names: active.map(m => m.name) });
      }
    } catch {}
  }
}

console.log(JSON.stringify({
  action,
  saved: action !== 'status' && !opts.dryRun,
  storageRoot,
  controlFile,
  configuredBaseMax: cfg.team.maxActiveMembers,
  runtimeOverride: currentCtrl?.maxActiveMembers ?? null,
  effectiveUserMax,
  source: currentCtrl?.maxActiveMembers != null ? currentCtrl.source : 'config',
  activeTeams,
  note: 'Applies in real time (<= 500ms) to execution subagents only. Governance roles (gate, discussA/B, arbiter) are exempt. Lowering the cap lets running tasks finish naturally without force-killing; raising it notifies waiting leaders to scale up within device/pipeline capacity.',
}, null, 2));
