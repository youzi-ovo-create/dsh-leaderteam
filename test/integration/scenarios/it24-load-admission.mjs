import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, exists, read } from '../lib.mjs';
export default {
  files: { 'spec.md': 'write A after loading write\n' },
  extraPatches: ['test/integration/fixtures/it24-probe.patch.yml'],
  config: { toolPolicy: { additionalTools: ['it24_load_probe'] } },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return [PLAN, dispatch({ plan_id: latestPlanId(c), tools: ['read', 'write', 'it24_load_probe'], defer_tools: ['write'] }), { content: 'WAITING' }, { content: 'DONE' }][c.index - 1];
    if (c.kind === 'member') {
      if (c.index === 1) return { tool: 'read', args: { file_path: 'spec.md' } };
      if (c.index === 2) {
        assert.ok(!c.tools.includes('write'));
        return { tools: [{ tool: 'it24_load_probe', args: {} }, { tool: 'write', args: { file_path: 'src/early.txt', content: 'MUST NOT EXECUTE' } }] };
      }
      if (c.index === 3) {
        assert.ok(c.tools.includes('write'), 'loaded schema enters the next step');
        assert.equal(exists(t, 'src/early.txt'), false, 'same-step load cannot expand the admitted execution set');
        return { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } };
      }
      return { content: 'STATUS: done' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    assert.equal(exists(t, 'src/early.txt'), false);
    assert.equal(read(t, 'src/a.txt'), 'A\n');
    const memberHistory = callsOf(t, 'member').at(-1).text;
    assert.match(memberHistory, /stepFrozen.{0,20}true/, 'the probe awaited load then confirmed the original official step stayed frozen');
    assert.match(memberHistory, /UNKNOWN_TOOL|unknown tool|not found/i, 'early invocation failed as an unavailable tool');
    assert.equal(callsOf(t, 'gate').filter(c => c.request.operation.tool === 'write').length, 1, 'only the next-step admitted write reaches the gate');
  },
};
