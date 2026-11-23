#!/usr/bin/env node
// External model catalog, member execution pool, and role configuration writer + loopback visual UI.
// Usage examples:
//   node scripts/configure-models.mjs --status
//   node scripts/configure-models.mjs --pool-disable-family gpt
//   node scripts/configure-models.mjs --upsert-model zcode/GLM-5.3-Flash --family glm --label "GLM-5.3 Flash" --efforts low,high,max --default-effort high --enable-in-pool
//   node scripts/configure-models.mjs --upsert-model zcode/GLM-5.3-Flash --efforts low,high --default-effort high
//   node scripts/configure-models.mjs --set-role gate=codex/gpt-6.1-sol:high
//   node scripts/configure-models.mjs --serve --open
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectModelConfiguration,
  applyModelConfigChanges,
  resolveDefaultDshHome,
  ROLE_KEYS,
} from '../leaderteam/core/model-config-writer.mjs';
import { startModelConfigServer, runDesktopSync } from '../leaderteam/core/model-config-ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function splitCsv(val) {
  return String(val ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(raw, flag) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isInteger(n) || String(n) !== String(raw ?? '').trim()) {
    throw new Error(`${flag} requires an integer, got "${raw}"`);
  }
  return n;
}

function printHelp() {
  console.log([
    'LeaderTeam External Model & Member Configuration Writer',
    '',
    'Inspect & Visual Panel:',
    '  node scripts/configure-models.mjs [--status]',
    '  node scripts/configure-models.mjs --serve [--port <0..65535>] [--open]',
    '',
    'Member Candidate Pool (team.executionPool):',
    '  --pool-set <r1,r2,...>            Replace member execution pool',
    '  --pool-enable <r1,r2,...>         Add model route(s) to member execution pool',
    '  --pool-disable <r1,r2,...>        Remove model route(s) from member execution pool',
    '  --pool-enable-family <f1,f2,...>  Enable all catalog models in family (gpt|glm|gemini|deepseek|claude|qwen|other)',
    '  --pool-disable-family <f1,f2,...> Disable all catalog models in family (e.g. --pool-disable-family gpt)',
    '',
    'Model Catalog & Member Efforts (models.<route>):',
    '  --upsert-model <provider/model>   Add a new model or update an existing model',
    '    [--family <family>] [--label <name>] [--efforts <low,medium,high>] [--default-effort <eff>]',
    '    [--strengths <text>] [--quota-windows <w1,w2> | --clear-quota-windows]',
    '    [--enable-in-pool | --disable-in-pool]',
    '  --remove-model <r1,r2,...> [--prune-pool]',
    '',
    'Governance & Leader Roles (roles.*):',
    '  --set-role <role>=<provider/model>[:<effort>]   (repeatable; role = leader|gate|discussA|discussB|arbiter)',
    '  --role <role> --model <provider/model> [--effort <eff>] [--max-tokens <N>] [--timeout-ms <N>] [--retries <N>]',
    '  --leader-policy <enforce|warn|off>',
    '',
    'Target, Validation & Desktop Sync:',
    '  --local                           Write overrides to config/leaderteam.local.json instead of leaderteam.config.json',
    '  --clear-local-all | --clear-local-pool | --clear-local-role <roles> | --clear-local-model <routes>',
    '  --dry-run                         Validate and preview changes with zero disk writes',
    '  --backup | --backup-dir <dir>     Save timestamped backup before writing',
    '  --sync-desktop                    Run scripts/install-desktop.ps1 to register new models in Desktop (DSH must be quit)',
    '  --config <file> [--local-file <file>] [--dsh-home <dir>] [--profile <name>]',
  ].join('\n'));
}

export function parseCliArgs(argv) {
  const opts = {
    status: false,
    help: false,
    serve: false,
    open: false,
    port: 0,
    local: false,
    dryRun: false,
    backup: false,
    backupDir: null,
    syncPatches: true,
    syncDesktop: false,
    configFile: null,
    localFile: null,
    dshHome: null,
    profile: 'desktop',
  };
  const changes = {
    upsertModels: [],
    removeModels: [],
    prunePool: false,
    poolSet: undefined,
    poolEnable: [],
    poolDisable: [],
    poolEnableFamilies: [],
    poolDisableFamilies: [],
    setRoles: [],
    leaderModelPolicy: undefined,
    clearLocal: null,
  };

  let currentModel = null;
  let singleRole = null;

  const needVal = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`missing value for ${flag}`);
    return argv[i + 1];
  };
  const ensureClearLocal = () => {
    opts.local = true;
    changes.clearLocal ??= { all: false, pool: false, leaderModelPolicy: false, roles: [], models: [] };
    return changes.clearLocal;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--status' || a === '--list') { opts.status = true; continue; }
    if (a === '--serve') { opts.serve = true; continue; }
    if (a === '--open') { opts.open = true; continue; }
    if (a === '--port') {
      opts.port = parsePositiveInt(needVal(i, a), a);
      if (opts.port < 0 || opts.port > 65535) throw new Error('--port must be in [0, 65535]');
      i++;
      continue;
    }
    if (a === '--local') { opts.local = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--backup') { opts.backup = true; continue; }
    if (a === '--backup-dir') { opts.backupDir = needVal(i, a); i++; continue; }
    if (a === '--no-sync-patches') { opts.syncPatches = false; continue; }
    if (a === '--sync-desktop') { opts.syncDesktop = true; continue; }
    if (a === '--config') { opts.configFile = needVal(i, a); i++; continue; }
    if (a === '--local-file') { opts.localFile = needVal(i, a); i++; continue; }
    if (a === '--dsh-home') { opts.dshHome = needVal(i, a); i++; continue; }
    if (a === '--profile') { opts.profile = needVal(i, a); i++; continue; }

    // Pool flags
    if (a === '--pool-set') { changes.poolSet = splitCsv(needVal(i, a)); i++; continue; }
    if (a === '--pool-enable') { changes.poolEnable.push(...splitCsv(needVal(i, a))); i++; continue; }
    if (a === '--pool-disable') { changes.poolDisable.push(...splitCsv(needVal(i, a))); i++; continue; }
    if (a === '--pool-enable-family') { changes.poolEnableFamilies.push(...splitCsv(needVal(i, a))); i++; continue; }
    if (a === '--pool-disable-family') { changes.poolDisableFamilies.push(...splitCsv(needVal(i, a))); i++; continue; }

    // Model catalog flags
    if (a === '--upsert-model' || a === '--update-model') {
      currentModel = { route: needVal(i, a).trim() };
      changes.upsertModels.push(currentModel);
      i++;
      continue;
    }
    if (a === '--family') {
      if (!currentModel) throw new Error('--family must follow --upsert-model <route>');
      currentModel.family = needVal(i, a).trim();
      i++;
      continue;
    }
    if (a === '--label') {
      if (!currentModel) throw new Error('--label must follow --upsert-model <route>');
      currentModel.label = needVal(i, a);
      i++;
      continue;
    }
    if (a === '--efforts') {
      if (!currentModel) throw new Error('--efforts must follow --upsert-model <route>');
      currentModel.efforts = splitCsv(needVal(i, a));
      i++;
      continue;
    }
    if (a === '--default-effort') {
      if (!currentModel) throw new Error('--default-effort must follow --upsert-model <route>');
      currentModel.defaultEffort = needVal(i, a).trim();
      i++;
      continue;
    }
    if (a === '--strengths') {
      if (!currentModel) throw new Error('--strengths must follow --upsert-model <route>');
      currentModel.strengths = needVal(i, a);
      i++;
      continue;
    }
    if (a === '--context-window') {
      if (!currentModel) throw new Error('--context-window must follow --upsert-model <route>');
      currentModel.contextWindow = parsePositiveInt(needVal(i, a), a);
      i++;
      continue;
    }
    if (a === '--model-max-tokens') {
      if (!currentModel) throw new Error('--model-max-tokens must follow --upsert-model <route>');
      currentModel.maxTokens = parsePositiveInt(needVal(i, a), a);
      i++;
      continue;
    }
    if (a === '--quota-windows') {
      if (!currentModel) throw new Error('--quota-windows must follow --upsert-model <route>');
      currentModel.quotaWindows = splitCsv(needVal(i, a));
      i++;
      continue;
    }
    if (a === '--clear-quota-windows') {
      if (!currentModel) throw new Error('--clear-quota-windows must follow --upsert-model <route>');
      currentModel.clearQuotaWindows = true;
      continue;
    }
    if (a === '--enable-in-pool') {
      if (!currentModel) throw new Error('--enable-in-pool must follow --upsert-model <route>');
      currentModel.enableInPool = true;
      continue;
    }
    if (a === '--disable-in-pool') {
      if (!currentModel) throw new Error('--disable-in-pool must follow --upsert-model <route>');
      currentModel.disableInPool = true;
      continue;
    }
    if (a === '--remove-model') {
      changes.removeModels.push(...splitCsv(needVal(i, a)));
      i++;
      continue;
    }
    if (a === '--prune-pool') { changes.prunePool = true; continue; }

    // Role flags
    if (a === '--set-role') {
      const spec = needVal(i, a).trim();
      const eq = spec.indexOf('=');
      if (eq <= 0) throw new Error(`--set-role expects <role>=<provider/model>[:<effort>], got "${spec}"`);
      const role = spec.slice(0, eq).trim();
      const rest = spec.slice(eq + 1).trim();
      if (!ROLE_KEYS.includes(role)) throw new Error(`unknown role "${role}" (expected ${ROLE_KEYS.join(', ')})`);
      const colon = rest.lastIndexOf(':');
      const route = colon > 0 ? rest.slice(0, colon).trim() : rest;
      const effort = colon > 0 ? rest.slice(colon + 1).trim() : undefined;
      changes.setRoles.push({ role, route, ...(effort ? { effort } : {}) });
      i++;
      continue;
    }
    if (a === '--role') {
      singleRole = { role: needVal(i, a).trim() };
      changes.setRoles.push(singleRole);
      i++;
      continue;
    }
    if (a === '--model') {
      if (!singleRole) throw new Error('--model must follow --role <role>');
      singleRole.route = needVal(i, a).trim();
      i++;
      continue;
    }
    if (a === '--effort') {
      if (!singleRole) throw new Error('--effort must follow --role <role>');
      singleRole.effort = needVal(i, a).trim();
      i++;
      continue;
    }
    if (a === '--max-tokens') {
      if (!singleRole) throw new Error('--max-tokens must follow --role <role>');
      singleRole.maxTokens = parsePositiveInt(needVal(i, a), a);
      i++;
      continue;
    }
    if (a === '--timeout-ms') {
      if (!singleRole) throw new Error('--timeout-ms must follow --role <role>');
      singleRole.timeoutMs = parsePositiveInt(needVal(i, a), a);
      i++;
      continue;
    }
    if (a === '--retries') {
      if (!singleRole) throw new Error('--retries must follow --role <role>');
      singleRole.retries = parsePositiveInt(needVal(i, a), a);
      i++;
      continue;
    }
    if (a === '--leader-policy') {
      changes.leaderModelPolicy = needVal(i, a).trim();
      i++;
      continue;
    }

    // Clear local override flags
    if (a === '--clear-local-all') { ensureClearLocal().all = true; continue; }
    if (a === '--clear-local-pool') { ensureClearLocal().pool = true; continue; }
    if (a === '--clear-local-leader-policy') { ensureClearLocal().leaderModelPolicy = true; continue; }
    if (a === '--clear-local-role') { ensureClearLocal().roles.push(...splitCsv(needVal(i, a))); i++; continue; }
    if (a === '--clear-local-model') { ensureClearLocal().models.push(...splitCsv(needVal(i, a))); i++; continue; }

    throw new Error(`unknown option: ${a} (pass --help for usage)`);
  }

  const hasMutations = Boolean(
    changes.upsertModels.length > 0 ||
    changes.removeModels.length > 0 ||
    changes.poolSet !== undefined ||
    changes.poolEnable.length > 0 ||
    changes.poolDisable.length > 0 ||
    changes.poolEnableFamilies.length > 0 ||
    changes.poolDisableFamilies.length > 0 ||
    changes.setRoles.length > 0 ||
    changes.leaderModelPolicy !== undefined ||
    changes.clearLocal !== null,
  );

  return { opts, changes, hasMutations };
}

function openBrowserUrl(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) return;
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function main() {
  const { opts, changes, hasMutations } = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const configFile = path.resolve(opts.configFile ?? process.env.LEADERTEAM_CONFIG ?? path.join(ROOT, 'config', 'leaderteam.config.json'));
  const commonOpts = {
    configFile,
    localFile: opts.localFile,
    dshHome: opts.dshHome,
    profile: opts.profile,
    projectRoot: ROOT,
  };

  if (opts.serve) {
    const srv = await startModelConfigServer({
      ...commonOpts,
      port: opts.port,
      backupRoot: opts.backupDir ?? path.join(ROOT, 'backups', 'model-config'),
    });
    console.log(JSON.stringify({
      mode: 'serve',
      url: srv.url,
      configFile,
      note: 'Loopback visual model configurator is running (127.0.0.1 only). Press Ctrl+C to stop.',
    }, null, 2));
    if (opts.open) openBrowserUrl(srv.url);
    const shutdown = async () => {
      await srv.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  let applyResult = null;
  if (hasMutations) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const backupDir = opts.backupDir
      ? path.resolve(opts.backupDir)
      : (opts.backup ? path.join(ROOT, 'backups', 'model-config', `cli-${stamp}`) : null);
    applyResult = applyModelConfigChanges(changes, {
      ...commonOpts,
      target: opts.local ? 'local' : 'base',
      dryRun: opts.dryRun,
      syncPatches: opts.syncPatches,
      backupDir,
    });
  }

  let desktopSyncAction = null;
  if (opts.syncDesktop) {
    const dshHome = resolveDefaultDshHome(commonOpts);
    desktopSyncAction = runDesktopSync({
      projectRoot: ROOT,
      dshHome,
      profile: opts.profile,
      dryRun: opts.dryRun,
    });
    if (!desktopSyncAction.ok) {
      throw new Error(`Desktop sync failed: ${desktopSyncAction.stderr || desktopSyncAction.stdout}`);
    }
  }

  if (applyResult) {
    const finalSnap = opts.syncDesktop && !opts.dryRun
      ? inspectModelConfiguration(commonOpts)
      : null;
    console.log(JSON.stringify({
      action: 'apply',
      target: applyResult.target,
      targetFile: applyResult.targetFile,
      dryRun: applyResult.dryRun,
      changed: applyResult.changed,
      saved: applyResult.saved,
      backupPath: applyResult.backupPath,
      patchesUpdated: applyResult.patchesUpdated,
      shadowedByLocal: applyResult.shadowedByLocal,
      warnings: applyResult.warnings,
      effective: applyResult.effective,
      desktopSync: finalSnap ? finalSnap.desktopSync : applyResult.desktopSync,
      ...(desktopSyncAction ? { desktopSyncAction } : {}),
    }, null, 2));
    return;
  }

  const snap = inspectModelConfiguration(commonOpts);
  console.log(JSON.stringify({
    action: opts.syncDesktop ? 'sync-desktop' : 'status',
    ...snap,
    ...(desktopSyncAction ? { desktopSyncAction } : {}),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
