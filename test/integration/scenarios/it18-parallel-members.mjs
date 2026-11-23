import fs from 'node:fs';
import path from 'node:path';
import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, gateReceipts, memberRecords, read, lastToolResult } from '../lib.mjs';
// Two writing members with different models run at the same time: each member's first model
// request is held until the other member's first request has arrived (a barrier). Sequential
// execution cannot pass the barrier and fails the scenario.
const A = planId => dispatch({ plan_id: planId, name: 'impl-a', task: 'Write src/a.txt containing A.', acceptance: ['src/a.txt contains A'], write_scope: ['src/a.txt'], model: 'zcode/GLM-5.3', effort: 'high' });
const B = planId => dispatch({ plan_id: planId, name: 'impl-b', task: 'Write src/b.txt containing B.', acceptance: ['src/b.txt contains B'], write_scope: ['src/b.txt'], model: 'codex/gpt-6.1-terra', effort: 'medium' });
const MEMBER = file => [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: `src/${file}.txt`, content: `${file.toUpperCase()}\n` } }, { content: `STATUS: done\nCHANGED: src/${file}.txt\nEVIDENCE: wrote file\nNOTES: none` }];
const waitFor = async (cond, ms) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('barrier timeout: members did not run concurrently'); await new Promise(r => setTimeout(r, 50)); } };
export default {
  files: { 'spec.md': 'spec\n' },
  timeoutSec: 120,
  extraPatches: ['test/fixtures/enable-global-tools.patch.yml'],
  async respond(c, t) {
    const s = t.state;
    s.first ??= new Set(); s.done ??= new Set();
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'member') {
      if (c.index === 1) {
        s.first.add(c.who);
        if (s.first.size === 1) s.heldWho = c.who;
        await waitFor(() => s.first.has('impl-a') && s.first.has('impl-b'), 30000);
        s.barrierPassed = true;
      }
      const step = MEMBER(c.who === 'impl-a' ? 'a' : 'b')[c.index - 1];
      if (c.index === 3) s.done.add(c.who);
      return step;
    }
    if (c.kind === 'leader') {
      if (c.index <= 5) return [PLAN, { tool: 'team_models', args: {} }, A(latestPlanId(c)), B(latestPlanId(c)), { content: 'WAITING' }][c.index - 1];
      if (s.done.size < 2) return { content: 'WAITING' };
      if (!s.deliverySent) { s.deliverySent = true; return DELIVERY; }
      return { content: 'DELIVERY: approved' };
    }
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'exit code');
    assert.match(run.final?.text ?? '', /DELIVERY: approved/);
    assert.equal(t.state.barrierPassed, true, 'both members were active at the same time');
    assert.equal(read(t, 'src/a.txt'), 'A\n'); assert.equal(read(t, 'src/b.txt'), 'B\n');
    const l = callsOf(t, 'leader');
    assert.match(lastToolResult(l[3]), /"member": "impl-a"/); assert.match(lastToolResult(l[4]), /"member": "impl-b"/);
    const a = callsOf(t, 'member', 'impl-a'), b = callsOf(t, 'member', 'impl-b');
    assert.ok(a.length >= 3 && a.every(c => c.model === 'zcode/GLM-5.3' && c.effort === 'high'), 'impl-a keeps its own model');
    assert.ok(b.length >= 3 && b.every(c => c.model === 'codex/gpt-6.1-terra' && c.effort === 'medium'), 'impl-b keeps its own model');
    const writes = gateReceipts(t).filter(r => r.tool === 'write');
    assert.deepEqual(writes.map(r => r.member).sort(), ['impl-a', 'impl-b']);
    assert.ok(writes.every(r => r.decision === 'allow' && r.by === 'model'));
    const cfgFile = JSON.parse(fs.readFileSync(path.join(t.workDir, 'leaderteam.config.json'), 'utf8'));
    assert.deepEqual(l[0].tools, [...cfgFile.profiles.leader.tools].sort(), 'leader sees exactly its profile (global working_directory masked)');
    for (const m of [a[0], b[0]]) assert.deepEqual(m.tools, [...cfgFile.profiles.code.tools].sort(), 'member sees exactly its profile');
    const members = memberRecords(t).filter(r => r.type === 'member');
    assert.deepEqual(members.map(m => m.name).sort(), ['impl-a', 'impl-b']);
  },
};
