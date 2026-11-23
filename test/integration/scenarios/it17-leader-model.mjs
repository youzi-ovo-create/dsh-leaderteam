import { assert, callsOf, lastToolResult, memberRecords } from '../lib.mjs';
// The session runs a model other than roles.leader (agent default overridden): with the default
// team.leaderModelPolicy "enforce" every team tool refuses with a precise instruction, before any
// gate, discussion or member work.
export default {
  files: { 'spec.md': 'spec\n' },
  extraPatches: ['test/fixtures/leader-model-mismatch.patch.yml'],
  respond(c) {
    if (c.kind === 'leader') return [{ tool: 'team_models', args: {} }, { tool: 'team_status', args: {} }, { content: 'BLOCKED: leader model' }][c.index - 1];
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'exit code');
    const l = callsOf(t, 'leader');
    assert.equal(l[0].model, 'zcode/GLM-5.3', 'the session really runs the overriding model');
    for (const i of [1, 2]) {
      const r = lastToolResult(l[i]);
      assert.match(r, /leader model check failed/, `team tool ${i} refused`);
      assert.match(r, /magpie\/zcode\/GLM-5\.3/);
      assert.match(r, /configured leader is magpie\/codex\/gpt-6\.1-sol \(high\)/);
      assert.match(r, /roles\.leader/);
    }
    assert.equal(callsOf(t, 'gate').length, 0, 'no gate calls');
    assert.equal(callsOf(t, 'discuss').length, 0, 'no discussion calls');
    assert.equal(memberRecords(t).length, 0, 'no members');
  },
};
