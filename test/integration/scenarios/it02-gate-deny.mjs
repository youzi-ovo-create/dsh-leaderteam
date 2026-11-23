import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, gateReceipts, exists } from '../lib.mjs';
const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, { content: 'REPORTED' }];
const MEMBER = [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } }, { content: 'STATUS: blocked' }];
export default {
  files: { 'spec.md': 'spec\n' },
  respond(c) {
    if (c.kind === 'gate') return c.request.operation.tool === 'write' ? { json: { decision: 'deny', risk: 'medium', reason: 'not authorized in test' } } : allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return MEMBER[c.index - 1];
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    assert.ok(!exists(t, 'src/a.txt'), 'denied write must not execute');
    const lastTool = JSON.stringify(callsOf(t, 'member', 'impl')[2].payload.messages.at(-1));
    assert.match(lastTool, /blocked by the LeaderTeam safety gate \(model\): not authorized in test/);
    assert.ok(gateReceipts(t).some(r => r.tool === 'write' && r.decision === 'deny' && r.by === 'model'));
  },
};
