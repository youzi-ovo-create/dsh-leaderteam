import { loadConfig, validateConfig } from '../../leaderteam/core/config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_CONFIG_FILE = path.join(ROOT, 'config', 'leaderteam.config.json');
// Historical scenarios exercise the supported whole-plan protocol. V1.9 tests opt into rollingPlanning explicitly.
export function defaultConfig() {
  const raw = structuredClone(loadConfig(DEFAULT_CONFIG_FILE, { includeLocal: false }));
  delete raw.derived;
  raw.team.rollingPlanning = false;
  raw.governance = { ...raw.governance, mode: 'approval' };
  return validateConfig(raw);
}
/** Default config with JSON-level overrides applied (deep merge of plain objects; arrays replace). */
export function configWith(override) {
  const base = JSON.parse(JSON.stringify(defaultConfig()));
  delete base.derived;
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v); else a[k] = v; } return a; };
  return validateConfig(merge(base, override));
}
