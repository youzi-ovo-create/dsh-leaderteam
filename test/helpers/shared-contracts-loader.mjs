import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

export function resolveSharedContractsDir() {
  const candidates = [
    process.env.LT_SHARED_CONTRACTS_DIR ? path.resolve(process.env.LT_SHARED_CONTRACTS_DIR) : null,
    path.resolve(REPO_ROOT, '..', 'lt-shared-contracts'),
    path.resolve(REPO_ROOT, '..', '..', 'deliverables', 'v2.2.2', 'companion', 'lt-shared-contracts'),
    path.resolve(REPO_ROOT, '..', '..', 'v2.2.2-r3', 'leaderteam-v2.2.2-r3', 'lt-shared-contracts'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'tests', 'contract-validator.mjs'))) {
      return dir;
    }
  }
  return path.resolve(REPO_ROOT, '..', 'lt-shared-contracts');
}

export function resolveLtUsagePluginDir() {
  const candidates = [
    process.env.LT_USAGE_PLUGIN_DIR ? path.resolve(process.env.LT_USAGE_PLUGIN_DIR) : null,
    path.resolve(REPO_ROOT, '..', 'lt-usage-plugin'),
    path.resolve(REPO_ROOT, '..', '..', 'deliverables', 'v2.2.2', 'companion', 'lt-usage-plugin'),
    path.resolve(REPO_ROOT, '..', '..', 'v2.2.2-r3', 'leaderteam-v2.2.2-r3', 'lt-usage-plugin'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'fixtures', 'test-home'))) {
      return dir;
    }
  }
  return path.resolve(REPO_ROOT, '..', 'lt-usage-plugin');
}

export async function loadSharedContractsModules() {
  const root = resolveSharedContractsDir();
  const [validator, mockServer] = await Promise.all([
    import(pathToFileURL(path.join(root, 'tests', 'contract-validator.mjs')).href),
    import(pathToFileURL(path.join(root, 'mocks', 'mock-magpie-server.mjs')).href),
  ]);
  return {
    sharedContractsDir: root,
    validateContractBundle: validator.validateContractBundle,
    scanNoSecretLeakage: validator.scanNoSecretLeakage,
    startMockMagpieServer: mockServer.startMockMagpieServer,
  };
}
