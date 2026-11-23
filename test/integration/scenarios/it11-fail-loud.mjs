import { assert } from '../lib.mjs';
export default {
  config: { roles: { gate: { route: 'nope/missing' } } },
  timeoutSec: 60,
  respond() { return { content: 'should never be called' }; },
  assert(t) {
    assert.notEqual(t.runs[0].code, 0, 'invalid config must stop DSH');
    assert.equal(t.calls.length, 0, 'no model request before the gate is available');
    assert.match(t.runs[0].stderr, /invalid leaderteam config/);
  },
};
