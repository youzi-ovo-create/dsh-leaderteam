import { assert } from '../lib.mjs';
export default {
  extraPatches: ['test/fixtures/broken-executor.patch.yml'],
  timeoutSec: 60,
  respond() { return { content: 'must not reach a model with an unbound executor' }; },
  assert(t) {
    assert.notEqual(t.runs[0].code, 0, 'unbound required executor must prevent startup');
    assert.equal(t.calls.length, 0, 'no model request before execution readiness');
    assert.match(t.runs[0].stderr, /tool-executor-native|leaderteamReady/);
  },
};
