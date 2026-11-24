#!/usr/bin/env node
// Synchronize (or check with --check) the Magpie model lists in desktop-magpie.patch.yml and
// magpie-models.patch.yml from the single source of truth in config/leaderteam.config.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { writeFileAtomic } from '../../leaderteam/core/store.mjs';
import { renderMagpieModelRows, rewriteModelsBlock } from '../../leaderteam/core/model-config-writer.mjs';

export { renderMagpieModelRows, rewriteModelsBlock };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  const checkOnly = process.argv.includes('--check');
  const cfg = loadConfig(path.join(ROOT, 'config', 'leaderteam.config.json'), { includeLocal: false });
  const rows = renderMagpieModelRows(cfg);
  const targets = [
    path.join(ROOT, 'config', 'desktop-magpie.patch.yml'),
    path.join(ROOT, 'config', 'magpie-models.patch.yml'),
  ];
  const drifted = [];
  for (const file of targets) {
    const current = fs.readFileSync(file, 'utf8');
    const next = rewriteModelsBlock(current, rows);
    if (current.replace(/\r\n/g, '\n') !== next.replace(/\r\n/g, '\n')) {
      if (checkOnly) drifted.push(path.relative(ROOT, file));
      else writeFileAtomic(file, next);
    }
  }
  if (drifted.length) {
    console.error(`Magpie patch model rows out of sync with leaderteam.config.json: ${drifted.join(', ')}`);
    process.exit(1);
  }
  console.log(checkOnly ? 'Magpie patch model rows match leaderteam.config.json' : 'Updated Magpie patch model rows');
}
