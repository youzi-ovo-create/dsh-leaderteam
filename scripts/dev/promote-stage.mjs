#!/usr/bin/env node
// Promote a verified staged change set into the live project tree, with conflict detection, backup and rollback.
//   node scripts/dev/promote-stage.mjs --stage <stage root> --live <live root> --manifest <promotion-manifest.json> [--execute]
//   node scripts/dev/promote-stage.mjs --live <live root> --rollback <backup dir> [--execute]
// promotion-manifest.json: { files: [{ path, stageSha256, liveSha256Before | null }] } (null = new file).
// Preview (default) changes nothing. Execute refuses when any live file differs from liveSha256Before
// (someone edited it since the stage was cut) or any staged file differs from stageSha256.
// Only the listed files are touched. A running Desktop keeps its loaded code until it is restarted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const a = process.argv.slice(2);
const opt = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const execute = a.includes('--execute');
const sha = f => fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null;
const safeRel = rel => { if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`unsafe path in manifest: ${rel}`); return rel; };
const live = path.resolve(opt('live') ?? '.');
const atomicCopy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); const tmp = `${dst}.lt-tmp-${process.pid}`; fs.copyFileSync(src, tmp); fs.renameSync(tmp, dst); };

if (opt('rollback')) {
  const backup = path.resolve(opt('rollback'));
  const rec = JSON.parse(fs.readFileSync(path.join(backup, 'promotion-record.json'), 'utf8'));
  const plan = rec.files.map(f => ({ ...f, livePath: path.join(live, safeRel(f.path)), now: sha(path.join(live, f.path)) }));
  const conflicts = plan.filter(f => f.now !== f.stageSha256);
  for (const f of plan) console.log(`${f.liveSha256Before === null ? 'REMOVE ' : 'RESTORE'} ${f.path}${f.now !== f.stageSha256 ? '  (CONFLICT: changed after promotion)' : ''}`);
  if (conflicts.length) { console.error(`${conflicts.length} file(s) changed after promotion; refusing rollback`); process.exit(1); }
  if (!execute) { console.log('\npreview only: add --execute to roll back'); process.exit(0); }
  const removed = path.join(backup, 'removed-on-rollback');
  for (const f of plan) {
    if (f.liveSha256Before === null) { const dst = path.join(removed, f.path); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(f.livePath, dst); }
    else atomicCopy(path.join(backup, 'files', f.path), f.livePath);
    const after = sha(f.livePath);
    if (after !== f.liveSha256Before) { console.error(`rollback verification failed for ${f.path}`); process.exit(1); }
  }
  // Remove directories that only the promotion created and that are now empty (deepest first).
  const dirs = [...new Set(plan.filter(f => f.liveSha256Before === null).flatMap(f => { const out = []; let d = path.dirname(f.livePath); while (d.startsWith(live + path.sep)) { out.push(d); d = path.dirname(d); } return out; }))].sort((x, y) => y.length - x.length);
  for (const d of dirs) { try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* keep */ } }
  console.log(`rolled back ${plan.length} file(s); new files moved to ${removed}`);
  process.exit(0);
}

if (!opt('stage') || !opt('manifest')) { console.error('usage: --stage <dir> --live <dir> --manifest <json> [--execute]'); process.exit(2); }
const stage = path.resolve(opt('stage'));
const manifest = JSON.parse(fs.readFileSync(path.resolve(opt('manifest')), 'utf8'));
const plan = manifest.files.map(f => ({ ...f, stagePath: path.join(stage, safeRel(f.path)), livePath: path.join(live, f.path) }));
const problems = [];
for (const f of plan) {
  const st = sha(f.stagePath), lv = sha(f.livePath);
  if (st !== f.stageSha256) problems.push(`${f.path}: staged file differs from the verified stage (${st?.slice(0, 12)} != ${f.stageSha256.slice(0, 12)})`);
  if (lv !== f.liveSha256Before) problems.push(`${f.path}: live file changed since the stage was cut (${lv?.slice(0, 12) ?? 'absent'} != ${f.liveSha256Before?.slice(0, 12) ?? 'absent'})`);
  console.log(`${f.liveSha256Before === null ? 'ADD    ' : 'REPLACE'} ${f.path}`);
}
if (problems.length) { console.error(`\nrefusing: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
if (!execute) { console.log(`\npreview only: ${plan.length} file(s); add --execute to promote`); process.exit(0); }
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const backup = path.join(live, 'backups', `pre-promotion-${stamp}`);
if (fs.existsSync(backup)) { console.error(`backup directory exists: ${backup}`); process.exit(1); }
for (const f of plan) if (f.liveSha256Before !== null) { const dst = path.join(backup, 'files', f.path); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(f.livePath, dst); if (sha(dst) !== f.liveSha256Before) { console.error(`backup verification failed: ${f.path}`); process.exit(1); } }
fs.mkdirSync(backup, { recursive: true });
fs.writeFileSync(path.join(backup, 'promotion-record.json'), JSON.stringify({ promotedAt: new Date().toISOString(), stage, live, files: plan.map(({ path: p, stageSha256, liveSha256Before }) => ({ path: p, stageSha256, liveSha256Before })) }, null, 1));
for (const f of plan) { atomicCopy(f.stagePath, f.livePath); if (sha(f.livePath) !== f.stageSha256) { console.error(`promotion verification failed: ${f.path}; roll back with --rollback ${backup}`); process.exit(1); } }
console.log(`\npromoted ${plan.length} file(s); backup ${backup}\nrollback: node scripts/dev/promote-stage.mjs --live "${live}" --rollback "${backup}" --execute`);
