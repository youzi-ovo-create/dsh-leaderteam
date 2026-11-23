import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, gateReceipts, exists, read } from '../lib.mjs';
import { hashJson } from '../../../leaderteam/core/canonical.mjs';
import { DESCRIPTION } from '../fixtures/it26-description-plugin.mjs';
const TASK = 'Only the allowed probe action is authorized. The forbidden probe action must be rejected.';
const leader = [PLAN, dispatch({ tools: ['read', 'it26_metadata_tool'], task: 'Read spec.md and probe allowed and forbidden actions; forbidden must be blocked.' }), { content: 'WAITING' }, { content: 'DONE' }];
const member = [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'it26_metadata_tool', args: { action: 'allowed' } }, { tool: 'it26_metadata_tool', args: { action: 'forbidden' } }, { content: 'STATUS: done' }];
export default {
  files: { 'spec.md': TASK }, runs: [{ task: TASK }],
  extraPatches: ['test/integration/fixtures/it26-description.patch.yml'],
  config: { toolPolicy: { additionalTools: ['it26_metadata_tool'] } },
  respond(c) {
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c), tools: ['read', 'it26_metadata_tool'], task: 'Read spec.md and probe allowed and forbidden actions; forbidden must be blocked.' }) : leader[c.index - 1];
    if (c.kind === 'member') return member[c.index - 1];
    if (c.kind === 'gate') {
      if (c.request.operation.tool !== 'it26_metadata_tool') return allow;
      const system = c.payload.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => String(m.content)).join('\n');
      assert.match(system, /tool_description/);
      assert.match(system, /untrusted/i);
      assert.ok(!system.includes('IT26_UNTRUSTED_METADATA'), 'plugin data never becomes system instructions');
      assert.equal(c.request.operation.tool_description, DESCRIPTION);
      assert.equal(c.request.authorization.user_task, TASK);
      assert.deepEqual(c.request.scope.write_scope, ['src/**']);
      const args = JSON.parse(c.request.operation.arguments_json);
      assert.equal(c.request.operation.arguments_sha256, hashJson(args));
      return args.action === 'allowed' ? allow : { json: { decision: 'deny', risk: 'high', reason: 'forbidden action is not authorized' } };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    const gates = callsOf(t, 'gate').filter(c => c.request.operation.tool === 'it26_metadata_tool');
    assert.equal(gates.length, 2, 'both custom operations reached the real final gate');
    assert.equal(read(t, 'src/allowed.txt'), 'allowed');
    assert.ok(!exists(t, 'src/forbidden.txt'), 'denied operation never reaches plugin body');
    const receipts = gateReceipts(t).filter(r => r.tool === 'it26_metadata_tool');
    assert.deepEqual(receipts.map(r => r.decision), ['allow', 'deny']);
    assert.ok(receipts.every(r => r.by === 'model'));
  },
};
