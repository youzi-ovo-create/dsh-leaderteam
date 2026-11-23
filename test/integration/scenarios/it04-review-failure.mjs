import { assert, allow, approve, PLAN, dispatch, latestPlanId, gateReceipts, exists } from '../lib.mjs';
const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, { content: 'REPORTED' }];
const MEMBER = [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } }, { content: 'STATUS: blocked' }];
export default {
  files: { 'spec.md': 'spec\n' },
  respond(c, t) {
    if (c.kind === 'gate') {
      if (c.request.operation.tool !== 'write') return allow;
      t.state.w = (t.state.w ?? 0) + 1;
      return t.state.w === 1 ? { httpStatus: 500 } : { content: 'I think this is fine.' };
    }
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return MEMBER[c.index - 1];
  },
  assert(t) {
    assert.ok(!exists(t, 'src/a.txt'), 'review failure must fail closed');
    assert.ok(t.state.w >= 2, 'the gate retried');
    assert.ok(gateReceipts(t).some(r => r.tool === 'write' && r.decision === 'deny' && r.by === 'gate-error'));
  },
};
