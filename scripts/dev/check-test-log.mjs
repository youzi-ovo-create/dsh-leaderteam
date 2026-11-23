#!/usr/bin/env node
// Judge a scripts/run-tests.ps1 log against the exact expected counts. Read-only.
//   node scripts/dev/check-test-log.mjs <log file> [--unit 143] [--backup 45] [--installer 64] [--merge 19] [--scenarios 27]
import fs from 'node:fs';
const a = process.argv.slice(2);
const file = a.find(x => !x.startsWith('--') && !/^\d+$/.test(x));
const n = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? Number(a[i + 1]) : d; };
if (!file) { console.error('usage: <log file> [--unit N] [--backup N] [--installer N] [--merge N] [--scenarios N]'); process.exit(2); }
const buf = fs.readFileSync(file);
const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.subarray(2).toString('utf16le') : buf.toString('utf8').replace(/^﻿/, '');
const want = { unit: n('unit', 166), backup: n('backup', 45), installer: n('installer', 64), merge: n('merge', 23), scenarios: n('scenarios', 29) };
const num = re => { const m = [...text.matchAll(re)]; return m.length ? Number(m.at(-1)[1]) : null; };
const between = (from, to) => { const i = text.indexOf(from), j = text.indexOf(to, i + 1); return i >= 0 && j > i ? text.slice(i, j) : ''; };
const backup = between('=== Starting DSH Desktop Backup Test Suite ===', '=== Starting DSH Desktop Installer Test Suite ===');
const rows = [
  ['unit tests', num(/^(?:ℹ|#) tests (\d+)/gm), want.unit], ['unit pass', num(/^(?:ℹ|#) pass (\d+)/gm), want.unit], ['unit fail', num(/^(?:ℹ|#) fail (\d+)/gm), 0],
  ['backup checks [PASS]', (backup.match(/\[PASS\]/g) ?? []).length, want.backup], ['backup [FAIL]', (backup.match(/\[FAIL\]/g) ?? []).length, 0],
  ['installer passed', num(/Total Passed: (\d+)/g), want.installer], ['installer failed', num(/Total Failed: (\d+)/g), 0],
  ['provider merge checks', num(/PASS desktop-provider-merge \((\d+) checks/g), want.merge],
  ['scenarios passed', num(/(\d+)\/\d+ scenarios passed/g), want.scenarios], ['scenarios total', num(/\d+\/(\d+) scenarios passed/g), want.scenarios],
  ['FAIL scenario lines', (text.match(/^FAIL /gm) ?? []).length, 0], ['ALL TESTS PASSED', text.includes('ALL TESTS PASSED') ? 1 : 0, 1],
];
let ok = true;
for (const [label, got, exp] of rows) { const pass = got === exp; ok &&= pass; console.log(`${pass ? 'PASS' : 'FAIL'} ${label}: ${got} (expected ${exp})`); }
console.log(ok ? '\nTEST LOG PASSED' : '\nTEST LOG FAILED');
process.exitCode = ok ? 0 : 1;
