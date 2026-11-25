#!/usr/bin/env node
/**
 * `lt-magpie` — Unified CLI for Leader Team's Magpie Gateway Management
 * Supports cross-platform installation, start/stop/restart, health & upstream compatibility check,
 * rollback, provider/model inspection, and 1-click sync into LT's model pool.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getOrCreateGatewayManager,
  buildPublicProviders,
  buildPublicModelCatalog,
  buildModelUpsertsFromCatalogEntries,
} from '../leaderteam/gateway/index.mjs';
import { resolveDefaultDshHome, applyModelConfigChanges } from '../leaderteam/core/model-config-writer.mjs';
import { loadConfig } from '../leaderteam/core/config.mjs';
import { resolveOrBootstrapConfigPath } from '../leaderteam/core/solo-key.mjs';

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const opts = {};
  for (let i = cmd === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--storage-root' && argv[i + 1]) opts.storageRoot = argv[++i];
    else if (a === '--dsh-home' && argv[i + 1]) opts.dshHome = argv[++i];
    else if (a === '--config' && argv[i + 1]) opts.config = argv[++i];
    else if (a === '--binary' && argv[i + 1]) opts.binary = argv[++i];
    else if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (a === '--gateway-url' && argv[i + 1]) opts.gatewayUrl = argv[++i];
    else if (a === '--web-url' && argv[i + 1]) opts.webUrl = argv[++i];
    else if (a === '--gateway-port' && argv[i + 1]) opts.gatewayPort = Number(argv[++i]);
    else if (a === '--web-port' && argv[i + 1]) opts.webPort = Number(argv[++i]);
    else if (a === '--dynamic-ports') opts.dynamicPorts = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return { cmd, opts };
}

function resolveStorageRoot(opts) {
  if (opts.storageRoot) return path.resolve(opts.storageRoot);
  const dshHome = resolveDefaultDshHome({ dshHome: opts.dshHome }) || path.join(os.homedir(), '.dsh');
  return path.join(dshHome, 'leaderteam');
}

function printHelp() {
  console.log(`Usage: lt-magpie <command> [options]

Commands:
  status        Show gateway mode, lifecycle state, health, and version compatibility
  install       Install/import Magpie binary into LT's isolated release store (--binary <path>)
  start         Start LT-managed sandboxed Magpie gateway
  stop          Stop LT-managed Magpie gateway
  restart       Restart LT-managed Magpie gateway
  check-compat  Probe live Magpie Gateway & Web Admin API compatibility
  rollback      Roll back to previously installed Magpie binary version
  configure     Set gateway mode (--mode managed|external|disabled, --gateway-url, --web-url)
  models        List normalized public catalog models from active gateway + LT config
  sync-to-lt    Import discovered Magpie models into LeaderTeam config & executionPool

Options:
  --storage-root <dir>   LeaderTeam storage root (default: <DSH_HOME>/leaderteam)
  --dsh-home <dir>       DSH home directory
  --config <file>        Explicit leaderteam.config.json path
  --binary <file>        Local Magpie binary path for 'install'
  --dynamic-ports        Allocate free loopback ports if default ports are busy
  --json                 Emit machine-readable JSON output`);
}

export async function runLtMagpieCli(argv = process.argv.slice(2)) {
  const { cmd, opts } = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  const storageRoot = resolveStorageRoot(opts);
  const mgr = getOrCreateGatewayManager(storageRoot);

  let result;
  if (cmd === 'status' || cmd === 'health') {
    result = await mgr.getStatus();
  } else if (cmd === 'install') {
    result = await mgr.install({ sourceBinaryPath: opts.binary || null });
  } else if (cmd === 'start') {
    result = await mgr.start({ allocateDynamicPortsIfBusy: Boolean(opts.dynamicPorts) });
  } else if (cmd === 'stop') {
    result = await mgr.stop();
  } else if (cmd === 'restart') {
    result = await mgr.restart({ allocateDynamicPortsIfBusy: Boolean(opts.dynamicPorts) });
  } else if (cmd === 'check-compat') {
    result = await mgr.checkCompatibility();
  } else if (cmd === 'rollback') {
    result = await mgr.rollback();
  } else if (cmd === 'configure') {
    mgr.configure({
      mode: opts.mode,
      gatewayPort: opts.gatewayPort,
      webPort: opts.webPort,
      externalGatewayUrl: opts.gatewayUrl,
      externalWebAdminUrl: opts.webUrl,
    });
    result = await mgr.getStatus();
  } else if (cmd === 'providers') {
    const client = mgr.createClient();
    const providersPayload = client.hasWebAdminAuth() ? await client.listProviders().catch(() => null) : null;
    const accounts = !providersPayload ? await client.listGatewayAccounts().catch(() => []) : [];
    result = buildPublicProviders({
      magpieProvidersPayload: providersPayload,
      magpieAccounts: accounts,
      magpieGatewayUrl: mgr.getActiveEndpoints().gatewayUrl,
      externalGateways: mgr.listExternalGateways(),
    });
  } else if (cmd === 'models' || cmd === 'sync-to-lt') {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const dshHome = resolveDefaultDshHome({ dshHome: opts.dshHome });
    const { configPath } = resolveOrBootstrapConfigPath({
      explicitConfigPath: opts.config || null,
      dshHome,
      bundledDefaultConfigPath: path.join(repoRoot, 'config', 'leaderteam.config.json'),
    });
    const effectiveConfig = loadConfig(configPath);
    const client = mgr.createClient();
    const gwModels = await client.listGatewayModels();
    const catalog = buildPublicModelCatalog({
      magpieGatewayModels: gwModels,
      effectiveConfig,
    });
    if (cmd === 'models') {
      result = { count: catalog.length, models: catalog };
    } else {
      const magpieEntries = catalog.filter(e => e.sourceKind === 'magpie');
      const upserts = buildModelUpsertsFromCatalogEntries(magpieEntries, {
        defaultMagpieHostProvider: effectiveConfig.magpie?.provider ?? 'magpie',
        enableInExecutionPool: true,
      });
      const applied = applyModelConfigChanges(
        { upsertModels: upserts },
        { configFile: configPath, target: 'local' },
      );
      result = { syncedCount: upserts.length, targetFile: applied.targetFile, executionPool: applied.effective.executionPool };
    }
  } else {
    throw new Error(`Unknown lt-magpie command: ${cmd}`);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return 0;
}

function isMainCliModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainCliModule()) {
  runLtMagpieCli().then(
    code => process.exit(code),
    err => {
      console.error(`lt-magpie error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
