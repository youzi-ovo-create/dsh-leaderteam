import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, lastToolResult } from '../lib.mjs';
// A complete scripted team run with two parallel writing members, then scripts/dev/check-team-acceptance.mjs
// must pass it from persisted records alone (session logs, team store, files, an independent test re-run),
// and must fail the same run when the final claim, the task text or the workspace is false. The shell-job
// check (C11) is unit-tested on recorded Windows job rows; shell sandboxes need ACL-prepared folders.
import crypto from 'node:crypto';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TEST = mod => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './${mod}.mjs';\ntest('value is 1', () => assert.equal(value(), 1));\ntest('value is a number', () => assert.equal(typeof value(), 'number'));\n`;
const MEMBER = mod => [
  { tool: 'read', args: { file_path: 'spec.md' } },
  { tool: 'write', args: { file_path: `${mod}/${mod}.mjs`, content: 'export const value = () => 1;\n' } },
  { tool: 'write', args: { file_path: `${mod}/${mod}.test.mjs`, content: TEST(mod) } },
  { content: `STATUS: done\nCHANGED: ${mod}/\nEVIDENCE: tests ran\nNOTES: none` },
];
const member = (name, mod, model, effort, plan_id) => dispatch({ plan_id, name, task: `Implement ${mod}/ with tests.`, acceptance: [`${mod} tests pass`], profile: 'code', write_scope: [`${mod}/**`], model, effort });
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('barrier timeout'); await new Promise(r => setTimeout(r, 50)); } };
const ACCEPTANCE = {
  minWritingMembers: 2, requireParallel: true, requireShellTestRun: false, allowedChanges: ['alpha/**', 'beta/**', '.leaderteam/**'],
  modules: ['alpha', 'beta'].map(m => ({ dir: m, files: [`${m}/${m}.mjs`, `${m}/${m}.test.mjs`], testArgs: ['--test', `${m}/${m}.test.mjs`], expectTests: 2, testMarker: '--test', countRegex: 'tests (\\d+)', okRegex: 'fail 0' })),
};
export default {
  files: { 'spec.md': 'spec\n' },
  timeoutSec: 150,
  async respond(c, t) {
    const s = t.state; s.first ??= new Set(); s.done ??= new Set();
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'member') {
      if (c.index === 1) { s.first.add(c.who); await waitFor(() => s.first.size === 2, 30000); }
      const steps = MEMBER(c.who === 'impl-alpha' ? 'alpha' : 'beta');
      if (c.index === steps.length) s.done.add(c.who);
      return steps[c.index - 1];
    }
    if (c.kind === 'leader') {
      if (c.index <= 5) return [PLAN, { tool: 'team_models', args: {} }, member('impl-alpha', 'alpha', 'zcode/GLM-5.3', 'high', latestPlanId(c)), member('impl-beta', 'beta', 'codex/gpt-6.1-terra', 'medium', latestPlanId(c)), { content: 'WAITING' }][c.index - 1];
      if (s.done.size < 2) return { content: 'WAITING' };
      if (!s.deliverySent) { s.deliverySent = true; return DELIVERY; }
      const id = JSON.parse(lastToolResult(c)).id;
      return { content: `DELIVERY: approved (${id})\nBoth modules pass.` };
    }
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'exit code');
    const pre = path.join(t.workDir, 'pre-manifest.json');
    fs.writeFileSync(pre, JSON.stringify({ files: { 'spec.md': crypto.createHash('sha256').update('spec\n').digest('hex') } }));
    const accFile = path.join(t.workDir, 'acceptance.json'); fs.writeFileSync(accFile, JSON.stringify(ACCEPTANCE));
    const finalFile = path.join(t.workDir, 'final.txt'); fs.writeFileSync(finalFile, run.final?.text ?? '');
    const taskFile = path.join(t.workDir, 'task.txt'); fs.writeFileSync(taskFile, 'Run the LeaderTeam scripted scenario.');
    const check = (extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/dev/check-team-acceptance.mjs'), '--home', t.home, '--workspace', t.ws, '--storage', t.store,
      '--leader-session', run.sessionId, '--exit-code', String(run.code), '--final-file', extra.final ?? finalFile, '--acceptance', accFile, '--task-file', extra.task ?? taskFile,
      '--config', path.join(t.workDir, 'leaderteam.config.json'), '--python', process.execPath, '--pre-manifest', extra.pre ?? pre, '--out', path.join(t.workDir, extra.out ?? 'acceptance-report.json')], { encoding: 'utf8' });
    const good = check();
    assert.equal(good.status, 0, `checker must pass a correct run:\n${good.stdout}${good.stderr}`);
    const report = JSON.parse(fs.readFileSync(path.join(t.workDir, 'acceptance-report.json'), 'utf8'));
    assert.equal(report.checks.length, 13); assert.ok(report.checks.every(c => c.pass));
    assert.ok(report.checks.find(c => c.id === 'C09').detail.overlap, 'overlap measured from session logs');
    const fakeFinal = path.join(t.workDir, 'final-fake.txt'); fs.writeFileSync(fakeFinal, 'DELIVERY: approved (agr-00000000)');
    const bad = check({ final: fakeFinal, out: 'fake-report.json' });
    assert.equal(bad.status, 1, 'a claimed agreement that does not exist must fail');
    assert.match(bad.stdout, /FAIL C02/);
    const namedTask = path.join(t.workDir, 'task-named.txt'); fs.writeFileSync(namedTask, 'Use zcode/GLM-5.3 for alpha.');
    const named = check({ task: namedTask, out: 'named-report.json' });
    assert.equal(named.status, 1); assert.match(named.stdout, /FAIL C07/);
    const tamperedPre = path.join(t.workDir, 'pre-tampered.json');
    fs.writeFileSync(tamperedPre, JSON.stringify({ files: { 'spec.md': '0'.repeat(64) } }));
    const tampered = check({ pre: tamperedPre, out: 'tampered-report.json' });
    assert.equal(tampered.status, 1, 'a changed file outside the allowed paths must fail'); assert.match(tampered.stdout, /FAIL C13/);
    assert.equal(callsOf(t, 'member', 'impl-alpha').at(-1).model, 'zcode/GLM-5.3');
  },
};
