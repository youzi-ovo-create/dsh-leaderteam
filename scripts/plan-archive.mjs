#!/usr/bin/env node
// Operator CLI for inspecting, retrospecting, and safely cleaning LeaderTeam's fixed external plan archive.
// Usage:
//   node scripts/plan-archive.mjs --status [--json]
//   node scripts/plan-archive.mjs --list [--category <cat>] [--state <state>] [--workspace <dir>] [--limit 30] [--json]
//   node scripts/plan-archive.mjs --show <planId> [--json]
//   node scripts/plan-archive.mjs --retrospect <planId> [--notes "..."] [--json]
//   node scripts/plan-archive.mjs --clean [--workspace <dir> | --project <key> | --category <cat> | --older-than-days <N> | --all] [--dry-run | --confirm] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../leaderteam/core/config.mjs';
import { resolvePlanArchiveRoot, PlanArchiveStore } from '../leaderteam/core/plan-archive.mjs';
import { TeamStore } from '../leaderteam/core/store.mjs';
import { resolveDefaultDshHome } from '../leaderteam/core/model-config-writer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const out = { json: false, dryRun: true, confirm: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--status') out.cmd = 'status';
    else if (a === '--list') out.cmd = 'list';
    else if (a === '--show') { out.cmd = 'show'; out.planId = argv[++i]; }
    else if (a === '--retrospect') { out.cmd = 'retrospect'; out.planId = argv[++i]; }
    else if (a === '--clean') out.cmd = 'clean';
    else if (a === '--confirm') { out.confirm = true; out.dryRun = false; }
    else if (a === '--dry-run') { out.dryRun = true; out.confirm = false; }
    else if (a === '--all') out.all = true;
    else if (a === '--config') out.configFile = argv[++i];
    else if (a === '--storage-root') out.storageRoot = argv[++i];
    else if (a === '--archive-root') out.archiveRoot = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--project') out.projectKey = argv[++i];
    else if (a === '--category') out.category = argv[++i];
    else if (a === '--state') out.lifecycleState = argv[++i];
    else if (a === '--older-than-days' || a.startsWith('--older-than-days=')) {
      const rawDays = a.startsWith('--older-than-days=') ? a.slice('--older-than-days='.length) : argv[++i];
      const trimmedDays = typeof rawDays === 'string' ? rawDays.trim() : '';
      out.olderThanDays = (trimmedDays !== '' && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmedDays))
        ? Number(trimmedDays)
        : Number.NaN;
    }
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--help' || a === '-h') out.cmd = 'help';
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

function resolveStorageRoot(cfg, opts) {
  if (opts.storageRoot) return path.resolve(opts.storageRoot);
  if (cfg.storage?.root) return path.resolve(cfg.storage.root);
  const home = resolveDefaultDshHome({ projectRoot: ROOT });
  if (home) return path.join(home, 'leaderteam');
  if (os.homedir()) return path.join(os.homedir(), '.dsh', 'leaderteam');
  return path.join(os.tmpdir(), 'leaderteam-storage');
}

function emit(opts, value) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    return;
  }
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
}

function resolveArchiveCliConfigFile(opts) {
  if (opts.configFile) return path.resolve(opts.configFile);
  if (process.env.LEADERTEAM_CONFIG?.trim()) return path.resolve(process.env.LEADERTEAM_CONFIG.trim());

  const explicitHome = process.env.LT_DSH_HOME?.trim() || process.env.DSH_HOME?.trim() || null;
  if (explicitHome) {
    const managed = path.join(path.resolve(explicitHome), 'leaderteam', 'config', 'leaderteam.config.json');
    if (fs.existsSync(managed)) return managed;
  }

  const isInstalledPackage = ROOT.replaceAll('\\', '/').includes('/node_modules/')
    || !fs.existsSync(path.join(ROOT, 'test'));
  if (isInstalledPackage) {
    const home = resolveDefaultDshHome({ projectRoot: ROOT });
    if (home) {
      const managed = path.join(home, 'leaderteam', 'config', 'leaderteam.config.json');
      if (fs.existsSync(managed)) return managed;
    }
  }
  return path.join(ROOT, 'config', 'leaderteam.config.json');
}

export function runPlanArchiveCli(argv = process.argv.slice(2), { writeStdout = true } = {}) {
  const opts = parseArgs(argv);
  if (!opts.cmd || opts.cmd === 'help') {
    const helpMsg = 'Usage: node scripts/plan-archive.mjs (--status | --list | --show <id> | --retrospect <id> | --clean) [options]';
    if (writeStdout) console.log(helpMsg);
    return { help: true, message: helpMsg };
  }
  const configFile = resolveArchiveCliConfigFile(opts);
  const cfg = loadConfig(configFile);
  const storageRoot = resolveStorageRoot(cfg, opts);
  const archiveRoot = opts.archiveRoot
    ? path.resolve(opts.archiveRoot)
    : resolvePlanArchiveRoot({ config: cfg, storageRoot, workspaceRoot: opts.workspace ?? null });
  const store = new PlanArchiveStore(archiveRoot, { workspaceRoot: opts.workspace ?? null });

  if (opts.cmd === 'status') {
    const stats = store.getStats();
    if (writeStdout) {
      if (opts.json) emit(opts, stats);
      else {
        console.log(`Archive Root (fixed external): ${stats.root}`);
        console.log(`Total Plans: ${stats.totalPlans} | Projects: ${stats.projectCount}`);
        console.log(`By Category: ${JSON.stringify(stats.byCategory)}`);
        console.log(`By Lifecycle: ${JSON.stringify(stats.byLifecycleState)}`);
      }
    }
    return stats;
  } else if (opts.cmd === 'list') {
    const plans = store.listPlans({
      workspace: opts.workspace ?? null,
      projectKey: opts.projectKey ?? null,
      category: opts.category ?? null,
      lifecycleState: opts.lifecycleState ?? null,
      limit: Number.isInteger(opts.limit) ? opts.limit : 50,
    });
    const out = { root: store.root, count: plans.length, plans };
    if (writeStdout) {
      if (opts.json) emit(opts, out);
      else {
        console.log(`Archive Root: ${store.root} (${plans.length} plan(s))`);
        for (const p of plans) {
          console.log(`- ${p.planId} [${p.category}] (${p.lifecycleState}) ${p.topic} | project=${p.projectLabel || p.projectKey}`);
        }
      }
    }
    return out;
  } else if (opts.cmd === 'show') {
    if (!opts.planId) throw new Error('--show requires <planId>');
    const plan = store.resolvePlan(opts.planId);
    if (!plan) throw new Error(`Archived plan not found: ${opts.planId}`);
    if (writeStdout) emit(opts, plan);
    return plan;
  } else if (opts.cmd === 'retrospect') {
    if (!opts.planId) throw new Error('--retrospect requires <planId>');
    const plan = store.resolvePlan(opts.planId);
    if (!plan) throw new Error(`Archived plan not found: ${opts.planId}`);
    const teamStoreInstance = (plan.teamId && fs.existsSync(storageRoot) && TeamStore.exists(storageRoot, plan.teamId))
      ? new TeamStore(storageRoot, plan.teamId)
      : null;
    const retro = store.createRetrospective(plan.planId, {
      teamStoreInstance,
      notes: opts.notes ?? '',
    });
    if (writeStdout) emit(opts, retro);
    return retro;
  } else if (opts.cmd === 'clean') {
    const res = store.cleanPlans({
      workspace: opts.workspace ?? null,
      projectKey: opts.projectKey ?? null,
      category: opts.category ?? null,
      olderThanDays: opts.olderThanDays !== undefined ? opts.olderThanDays : null,
      all: opts.all,
      dryRun: opts.dryRun,
      confirm: opts.confirm,
    });
    if (writeStdout) emit(opts, res);
    return res;
  }
  return null;
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
  try {
    runPlanArchiveCli(process.argv.slice(2), { writeStdout: true });
    process.exit(0);
  } catch (e) {
    const codeTag = typeof e?.code === 'string' ? `[${e.code}] ` : '';
    console.error(`ERROR: ${codeTag}${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
