import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, gateReceipts, exists, read } from '../lib.mjs';

const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, { content: 'REPORTED' }];
export default {
  files: { 'spec.md': 'first\nsecond\nthird' },
  respond(c) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return [
      { tool: 'read', args: { file_path: 'spec.md', offset: 1, limit: 1 } },
      { tool: 'write', args: { file_path: 'src/early.txt', content: 'must be refused' } },
      { tool: 'read', args: { file_path: 'spec.md', offset: 3, limit: 1 } },
      { tool: 'write', args: { file_path: 'src/gap.txt', content: 'must be refused' } },
      { tool: 'read', args: { file_path: 'spec.md', offset: 2, limit: 1 } },
      { tool: 'write', args: { file_path: 'src/complete.txt', content: 'all three lines read' } },
      { content: 'STATUS: done' },
    ][c.index - 1];
  },
  assert(t) {
    const receipts = gateReceipts(t);
    assert.equal(exists(t, 'src/early.txt'), false, 'one line does not satisfy the required reference');
    assert.equal(exists(t, 'src/gap.txt'), false, 'reading the first and last lines leaves a gap');
    assert.equal(read(t, 'src/complete.txt'), 'all three lines read', 'out-of-order pages cover the complete reference');
    assert.equal(receipts.filter(r => r.by === 'rule:refs-unread').length, 2);
    assert.deepEqual(callsOf(t, 'gate').map(c => c.request.operation.tool).sort(), ['team_dispatch', 'write']);
  },
};
