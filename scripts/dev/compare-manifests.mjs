#!/usr/bin/env node
// Which staged files changed between two promotion manifests, and are all of them inside an allowed set?
//   node scripts/dev/compare-manifests.mjs <old manifest> <new manifest> [--allow <glob> ...]
// Exit 0 only when every added, removed or changed path matches one of the --allow globs.
// Used to show that evidence gathered on an earlier stage (e.g. real-model runs) still applies.
import fs from 'node:fs';
import { globToRegExp } from '../../leaderteam/core/paths.mjs';

const a = process.argv.slice(2);
const files = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--allow');
const allow = a.flatMap((x, i) => (a[i - 1] === '--allow' ? [x] : []));
if (files.length !== 2) { console.error('usage: <old manifest> <new manifest> [--allow <glob> ...]'); process.exit(2); }
const read = f => new Map(JSON.parse(fs.readFileSync(f, 'utf8')).files.map(x => [x.path, x]));
const [before, after] = files.map(read);
const changed = [];
for (const [p, x] of after) { const y = before.get(p); if (!y) changed.push({ path: p, change: 'added' }); else if (y.stageSha256 !== x.stageSha256 || y.liveSha256Before !== x.liveSha256Before) changed.push({ path: p, change: 'changed' }); }
for (const p of before.keys()) if (!after.has(p)) changed.push({ path: p, change: 'removed' });
const res = allow.map(g => globToRegExp(g, 'posix'));
let ok = true;
for (const c of changed.sort((x, y) => x.path.localeCompare(y.path))) { const inside = res.some(re => re.test(c.path)); ok &&= inside; console.log(`${inside ? 'ALLOWED' : 'OUTSIDE'} ${c.change} ${c.path}`); }
console.log(`\n${changed.length} path(s) differ; unchanged ${[...after.keys()].filter(p => !changed.some(c => c.path === p)).length}`);
console.log(ok ? 'MANIFEST DIFF WITHIN ALLOWED SET' : 'MANIFEST DIFF OUTSIDE ALLOWED SET');
process.exitCode = ok ? 0 : 1;
