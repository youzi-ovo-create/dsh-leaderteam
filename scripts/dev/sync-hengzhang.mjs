#!/usr/bin/env node
/**
 * Syncs pure zero-dependency ESM modules from `lt-usage-plugin` (`@lt-usage/core` & `@lt-usage/reader`)
 * into `packages/lt-usage/` with relative ESM imports so `dsh-leaderteam` remains 100% self-contained
 * with zero external runtime npm dependencies across `pnpm` virtual stores and tarballs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const defaultSourceRoot = path.resolve(repoRoot, '..', 'lt-usage-plugin');
const srcRoot = process.argv[2] ? path.resolve(process.argv[2]) : defaultSourceRoot;
const destRoot = path.join(repoRoot, 'packages', 'lt-usage');

if (!fs.existsSync(path.join(srcRoot, 'packages', 'core', 'src', 'index.js'))) {
  console.error(`Cannot find lt-usage-plugin source at ${srcRoot}`);
  process.exit(1);
}

fs.rmSync(destRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(destRoot, 'core'), { recursive: true });
fs.mkdirSync(path.join(destRoot, 'reader'), { recursive: true });

for (const entry of fs.readdirSync(path.join(srcRoot, 'packages', 'core', 'src'))) {
  if (!entry.endsWith('.js')) continue;
  const content = fs.readFileSync(path.join(srcRoot, 'packages', 'core', 'src', entry), 'utf8');
  fs.writeFileSync(path.join(destRoot, 'core', entry), content);
}

for (const entry of fs.readdirSync(path.join(srcRoot, 'packages', 'reader', 'src'))) {
  if (!entry.endsWith('.js')) continue;
  // Skip standalone HTTP server (`server.js`); LT mounts via `leaderteam/usage/hengzhang-bridge.mjs`
  if (entry === 'server.js') continue;
  let content = fs.readFileSync(path.join(srcRoot, 'packages', 'reader', 'src', entry), 'utf8');
  content = content.replace(/from\s+['"]@lt-usage\/core['"]/g, "from '../core/index.js'");
  fs.writeFileSync(path.join(destRoot, 'reader', entry), content);
}

fs.writeFileSync(
  path.join(destRoot, 'index.mjs'),
  `export * from './core/index.js';\nexport * from './reader/service.js';\nexport * from './reader/decode.js';\n`,
);

fs.writeFileSync(
  path.join(destRoot, 'NOTICE.md'),
  `# Bundled Module: Hengzhang (\`lt-usage-plugin\`)\n\n` +
  `Synchronized from \`lt-usage-plugin\` (\`@lt-usage/core\` & \`@lt-usage/reader\`), licensed under Apache-2.0.\n` +
  `Standalone development, CLI (\`scan\`/\`report\`/\`serve\`), and Web SPA remain in \`lt-usage-plugin\`.\n`,
);

console.log(`Synced Hengzhang core & reader into ${destRoot}`);
