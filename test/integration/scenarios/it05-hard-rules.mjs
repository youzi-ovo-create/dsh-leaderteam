import path from 'node:path';
import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, gateReceipts, exists, read } from '../lib.mjs';
const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, { content: 'REPORTED' }];
export default {
  files: { 'spec.md': 'spec\n' },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return [
      { tool: 'write', args: { file_path: 'src/early.txt', content: 'x' } },
      { tool: 'read', args: { file_path: 'spec.md' } },
      { tool: 'write', args: { file_path: path.join(t.globalRefs, 'GLOBAL.md'), content: 'tampered' } },
      { tool: 'edit', args: { file_path: '.leaderteam/refs/INDEX.md', old_string: 'a', new_string: 'b' } },
      { tool: 'team_dispatch', args: { name: 'x2', task: 't', acceptance: ['a'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'readonly' } },
      { tool: 'write', args: { file_path: 'src/ok.txt', content: 'ok' } },
      { content: 'STATUS: done' },
    ][c.index - 1];
  },
  assert(t) {
    const r = gateReceipts(t);
    assert.ok(r.some(x => x.by === 'rule:refs-unread'), 'write before reading refs is refused');
    assert.ok(!exists(t, 'src/early.txt'));
    assert.ok(r.some(x => x.by === 'rule:path-in-global-refs'));
    assert.equal(read({ ws: t.globalRefs }, 'GLOBAL.md'), 'global reference\n', 'global refs untouched');
    assert.ok(r.some(x => x.by === 'rule:path-protected'));
    assert.equal(read(t, 'src/ok.txt'), 'ok', 'write after reading refs is allowed');
    const msg = JSON.stringify(callsOf(t, 'member', 'impl')[5].payload.messages.at(-1));
    assert.match(msg, /unknown tool|UNKNOWN_TOOL/, 'member cannot dispatch');
    assert.deepEqual(callsOf(t, 'gate').map(g => g.request.operation.tool).sort(), ['team_dispatch', 'write'], 'only the leader dispatch and the final allowed write reach the model');
  },
};
