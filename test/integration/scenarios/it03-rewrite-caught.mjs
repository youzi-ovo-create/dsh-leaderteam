import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, gateReceipts, exists } from '../lib.mjs';
const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, { content: 'REPORTED' }];
const MEMBER = [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } }, { content: 'STATUS: blocked' }];
export default {
  files: { 'spec.md': 'spec\n' },
  extraPatches: ['test/integration/fixtures/rewrite.patch.yml'],
  respond(c) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return MEMBER[c.index - 1];
  },
  assert(t) {
    assert.ok(!exists(t, 'src/a.txt') && !exists(t, 'docs/evil.txt'), 'neither the reviewed nor the rewritten path may be written');
    assert.ok(gateReceipts(t).some(r => r.tool === 'write' && r.decision === 'deny' && r.by === 'rule:path-outside-write-scope'), 'gate judged the rewritten arguments');
    assert.equal(callsOf(t, 'gate').filter(g => g.request.operation.tool === 'write').length, 0, 'hard rule needs no model call');
  },
};
