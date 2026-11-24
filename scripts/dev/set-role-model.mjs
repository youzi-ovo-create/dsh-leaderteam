#!/usr/bin/env node
// Edit only the local role configuration, never model routes or account credentials.
// Validates both standalone leaderteam.config.json and merged leaderteam.local.json overrides.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectModelConfiguration, applyModelConfigChanges, ROLE_KEYS } from '../../leaderteam/core/model-config-writer.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--dry-run') { options.dryRun = true; continue; }
  if (key === '--local') { options.local = true; continue; }
  if (!['--config', '--role', '--model', '--effort'].includes(key) || !args[i + 1]) throw new Error(`invalid option: ${key}`);
  options[key.slice(2)] = args[++i];
}
const file = path.resolve(options.config ?? fileURLToPath(new URL('../../config/leaderteam.config.json', import.meta.url)));
if (options.role || options.model || options.effort) {
  if (!ROLE_KEYS.includes(options.role) || !options.model || !options.effort) {
    throw new Error('update requires --role leader|gate|discussA|discussB|arbiter --model <configured route> --effort <supported effort>');
  }
  const res = applyModelConfigChanges(
    { setRoles: [{ role: options.role, route: options.model, effort: options.effort, requireExplicitEffort: true }] },
    { configFile: file, target: options.local ? 'local' : 'base', dryRun: Boolean(options.dryRun) },
  );
  console.log(JSON.stringify({
    config: res.targetFile,
    target: res.target,
    saved: Boolean(res.saved),
    roles: options.local ? res.effective.roles : res.writtenConfig.roles,
    effectiveRoles: res.effective.roles,
    ...(res.shadowedByLocal.length ? { shadowedByLocal: res.shadowedByLocal, warnings: res.warnings } : {}),
    apply: 'Running LeaderTeam sessions hot-reload gate/discuss/arbiter/leader-policy automatically. Existing sessions retain their own top-level selected model in DSH UI.',
  }, null, 2));
} else {
  const snap = inspectModelConfiguration({ configFile: file });
  console.log(JSON.stringify({
    config: file,
    saved: false,
    roles: snap.baseRoles,
    effectiveRoles: snap.roles,
    hasLocalOverride: snap.hasLocalFile,
    apply: 'Running LeaderTeam sessions hot-reload gate/discuss/arbiter/leader-policy automatically. Existing sessions retain their own top-level selected model in DSH UI.',
  }, null, 2));
}
