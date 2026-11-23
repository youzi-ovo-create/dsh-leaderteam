import { assert, allow, dispatch, callsOf, memberRecords, lastToolResult } from '../lib.mjs';
export default {
  files: { 'spec.md': 'spec\n' },
  respond(c) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'leader') return [dispatch(), dispatch({ name: 'scout', profile: 'readonly', write_scope: [] }), { content: 'WAITING' }, { content: 'DONE' }][c.index - 1];
    if (c.kind === 'member') return [{ tool: 'read', args: { file_path: 'spec.md' } }, { content: 'STATUS: done' }][c.index - 1];
  },
  assert(t) {
    const l = callsOf(t, 'leader');
    assert.match(lastToolResult(l[1]), /no approved plan agreement/);
    assert.match(lastToolResult(l[2]), /"member": "scout"/);
    assert.deepEqual(memberRecords(t).filter(r => r.type === 'member').map(r => r.name), ['scout']);
    assert.equal(callsOf(t, 'discuss').length, 0);
  },
};
