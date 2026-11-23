// Leader read boundary (2026-11-11): outside the workspace, the reference roots and the configured read roots the
// leader must ask. A user message line that starts with "允许读取" opens exactly the named folder, read-only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, callsOf, lastToolResult } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRANTED = path.resolve(HERE, '..', 'fixtures');            // outside every scenario workspace
const GRANTED_FILE = path.join(GRANTED, 'rewrite.patch.yml');
const NOT_GRANTED = path.resolve(HERE, '..', 'lib.mjs');          // its folder was not granted

export default {
  files: { 'spec.md': 'workspace spec\n' },
  runs: [{ task: `Summarise the fixture note for me.\n允许读取 ${GRANTED}` }],
  respond(c) {
    if (c.kind === 'leader') {
      return [
        { tool: 'read', args: { file_path: NOT_GRANTED } },
        { tool: 'read', args: { file_path: GRANTED_FILE } },
        { tool: 'read', args: { file_path: 'spec.md' } },
        { content: 'DONE' },
      ][c.index - 1];
    }
  },
  assert(t) {
    const calls = callsOf(t, 'leader');
    assert.equal(calls.length, 4, 'the leader ran its three reads and finished');
    const refused = lastToolResult(calls[1]);
    assert.match(refused, /rule:path-outside-read-roots/, 'a path the user did not grant is refused by a hard rule');
    assert.match(refused, /Ask the user/, 'the refusal tells the leader to ask');
    assert.ok(!refused.includes('lastUserText'), 'nothing of the refused file is returned');
    assert.match(lastToolResult(calls[2]), /lt-test-rewrite/, 'the folder named in the user\'s grant line is readable');
    assert.match(lastToolResult(calls[3]), /workspace spec/, 'workspace reads are unaffected');
  },
};
