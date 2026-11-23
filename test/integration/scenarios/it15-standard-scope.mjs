import fs from 'node:fs';
import path from 'node:path';
import { assert, read, callsOf } from '../lib.mjs';
export default {
  teamLeader: false,
  extraPatches: ['test/fixtures/standard-write.patch.yml'],
  respond(c) {
    if (c.kind !== 'other') return { content: 'unexpected team or review request' };
    return c.index === 1
      ? { tool: 'write', args: { file_path: 'ordinary.txt', content: 'ordinary workspace edit\n' } }
      : { content: 'ORDINARY_DONE' };
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    assert.match(t.runs[0].final?.text ?? '', /ORDINARY_DONE/);
    assert.equal(read(t, 'ordinary.txt'), 'ordinary workspace edit\n');
    assert.equal(callsOf(t, 'gate').length, 0, 'ordinary operations do not invoke the team GPT gate');
    const teams = path.join(t.store, 'teams');
    assert.ok(!fs.existsSync(teams) || fs.readdirSync(teams).length === 0, 'ordinary session does not become a team');
  },
};
