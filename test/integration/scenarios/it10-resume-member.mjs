import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, memberRecords, read } from '../lib.mjs';
export default {
  files: { 'spec.md': 'spec\n' },
  runs: [{ task: 'first run' }, { task: 'second run: continue', resume: true }],
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') {
      t.state.l = (t.state.l ?? 0) + 1;
      if (t.runs.length === 0) return [PLAN, dispatch({ plan_id: latestPlanId(c), write_scope: ['src/**'] }), { content: 'WAITING' }, { content: 'RUN1' }][Math.min(t.state.l, 4) - 1];
      t.state.l2 = (t.state.l2 ?? 0) + 1;
      if (t.state.l2 === 1) return PLAN;
      if (t.state.l2 === 2) { const child = memberRecords(t).find(r => r.type === 'member').childId; return { tool: 'send_message', args: { agent_id: child, message: 'Also write src/b.txt containing B.' } }; }
      if (t.state.l2 === 3) return { content: 'WAITING2' };
      return { content: 'RUN2' };
    }
    if (c.kind === 'member') {
      t.state.m = (t.state.m ?? 0) + 1;
      return [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } }, { content: 'STATUS: done' },
              { tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/b.txt', content: 'B\n' } }, { content: 'STATUS: done' }][t.state.m - 1];
    }
  },
  assert(t) {
    assert.equal(t.runs.length, 2); assert.equal(t.runs[1].code, 0);
    assert.equal(read(t, 'src/a.txt'), 'A\n'); assert.equal(read(t, 'src/b.txt'), 'B\n');
    const resumed = callsOf(t, 'member', 'impl').slice(3);
    assert.ok(resumed.length >= 2, 'member resumed in run 2');
    for (const c of resumed) { assert.ok(c.tools.includes('write'), 'profile restored after resume'); assert.ok(!c.tools.includes('team_dispatch')); assert.equal(c.model, 'zcode/GLM-5.3'); }
  },
};
