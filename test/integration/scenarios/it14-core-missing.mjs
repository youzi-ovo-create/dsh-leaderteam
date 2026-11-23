import { assert } from '../lib.mjs';
export default {
  extraPatches: ['test/fixtures/disable-core.patch.yml'],
  timeoutSec: 60,
  respond() { return { content: 'must not reach any model without the core' }; },
  assert(t) {
    assert.notEqual(t.runs[0].code, 0, 'unavailable core must prevent startup');
    assert.equal(t.calls.length, 0, 'no model request without the required safety gate');
    assert.match(t.runs[0].stderr, /tool-executor-native|leaderteamReady/);
  },
};
