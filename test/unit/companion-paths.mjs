// Resolves sibling/companion `lt-shared-contracts` and `lt-usage-plugin` directories across
// standard multi-repo checkouts (`../<name>`) and handback/deliverables layouts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

export function resolveCompanionDir(name) {
  const envOverride = name === 'lt-shared-contracts'
    ? process.env.LT_SHARED_CONTRACTS_DIR
    : (name === 'lt-usage-plugin' ? process.env.LT_USAGE_PLUGIN_DIR : null);
  const candidates = [
    envOverride ? path.resolve(envOverride) : null,
    path.resolve(REPO_ROOT, '..', name),
    path.resolve(REPO_ROOT, '..', '..', 'deliverables', 'v2.2.3', 'companion', name),
    path.resolve(REPO_ROOT, '..', '..', 'v2.2.3-r3', 'leaderteam-v2.2.3-r3', name),
    name === 'lt-shared-contracts' ? path.resolve(REPO_ROOT, 'test', 'fixtures', 'lt-shared-contracts') : null,
  ].filter(Boolean);
  for (const cand of candidates) {
    if (fs.existsSync(cand)) return cand;
  }
  return candidates[0];
}

export const SHARED_CONTRACTS_ROOT = resolveCompanionDir('lt-shared-contracts');
export const LT_USAGE_PLUGIN_ROOT = resolveCompanionDir('lt-usage-plugin');

const validatorMod = await import(
  pathToFileURL(path.join(SHARED_CONTRACTS_ROOT, 'tests', 'contract-validator.mjs')).href
);
const mockMagpieMod = await import(
  pathToFileURL(path.join(SHARED_CONTRACTS_ROOT, 'mocks', 'mock-magpie-server.mjs')).href
);

export const validateContractBundle = validatorMod.validateContractBundle;
export const scanNoSecretLeakage = validatorMod.scanNoSecretLeakage;
export const startMockMagpieServer = mockMagpieMod.startMockMagpieServer;
