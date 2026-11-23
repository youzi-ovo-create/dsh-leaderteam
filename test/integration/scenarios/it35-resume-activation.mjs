import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, gateReceipts, lastToolResult, memberRecords, read } from '../lib.mjs';
export default {
  files: { 'spec.md': 'spec\n' },
  async respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'member') {
      if (c.who === 'impl-b' && c.index === 1) await new Promise(resolve => setTimeout(resolve, 1800));
      const dest = c.who === 'impl-a' ? 'src/a.txt' : 'src/ui/b.txt';
      return [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: dest, content: c.who === 'impl-a' ? 'A\n' : 'B\n' } }, { content: 'STATUS: done' }][c.index - 1] ?? { content: 'STATUS: done' };
    }
    if (c.kind === 'leader') {
      if (c.index === 1) return PLAN;
      if (c.index === 2) return dispatch({ name: 'impl-a', plan_id: latestPlanId(c), write_scope: ['src/**'] });
      if (c.index === 3) return { content: 'WAITING_A' };
      if (c.index === 4) return dispatch({ name: 'impl-b', plan_id: latestPlanId(c), write_scope: ['src/ui/**'] });
      if (c.index === 5) return { tool: 'send_message', args: { agent_id: memberRecords(t).find(m => m.type === 'member' && m.name === 'impl-a').childId, message: 'Revise src/a.txt.' } };
      if (c.index === 6) { t.state.resumeResult = lastToolResult(c); return { content: 'WAITING_B' }; }
      if (!t.state.delivery) { t.state.delivery = true; return DELIVERY; }
      return { content: 'DELIVERY: approved' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    assert.match(t.state.resumeResult, /member-activation.*overlaps/s);
    assert.ok(gateReceipts(t).some(r => r.tool === 'send_message' && r.decision === 'deny' && r.by === 'rule:member-activation'));
    assert.equal(callsOf(t, 'member', 'impl-a').length, 3, 'the blocked resume never reactivated A');
    assert.equal(read(t, 'src/a.txt'), 'A\n');
    assert.equal(read(t, 'src/ui/b.txt'), 'B\n');
  },
};
