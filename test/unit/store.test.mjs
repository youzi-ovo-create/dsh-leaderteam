import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TeamStore, readJsonl, appendJsonl, safeId } from '../../leaderteam/core/store.mjs';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lt-store-'));
test('members fold status; agreement events filter by id', () => {
  const root = tmp(); const s = new TeamStore(root, 'session-abc');
  s.ensure({ workspace: '/w' });
  s.addMember({ childId: 'c1', name: 'impl', profile: 'code' }); s.setMemberStatus('c1', 'started');
  s.addMember({ childId: 'c2', name: 'scout', profile: 'readonly' }); s.setMemberStatus('c2', 'failed', 'boom');
  const m = s.members();
  assert.equal(m.get('c1').status, 'started'); assert.equal(m.get('c2').error, 'boom');
  s.appendAgreementEvent({ type: 'created', id: 'a1' }); s.appendAgreementEvent({ type: 'created', id: 'a2' }); s.appendAgreementEvent({ type: 'opinion', id: 'a1', round: 1 });
  assert.deepEqual(s.agreementEvents('a1').map(e => e.type), ['created', 'opinion']);
  assert.deepEqual(s.agreementIds(), ['a1', 'a2']);
  assert.ok(TeamStore.exists(root, 'session-abc')); assert.ok(!TeamStore.exists(root, 'other'));
});
test('torn last line is skipped; corrupt middle line fails closed', () => {
  const f = path.join(tmp(), 'x.jsonl');
  appendJsonl(f, { a: 1 }); fs.appendFileSync(f, '{"a":');
  assert.deepEqual(readJsonl(f), { records: [{ a: 1 }], skipped: 1 });
  fs.writeFileSync(f, '{"a":1}\nnot-json\n{"a":2}\n');
  assert.throws(() => readJsonl(f), { code: 'STORE_CORRUPT' });
  assert.deepEqual(readJsonl(path.join(tmp(), 'missing.jsonl')), { records: [], skipped: 0 });
});
test('ids are path-safe', () => {
  for (const bad of ['../x', 'a/b', '', '..', 'a\\b']) assert.throws(() => safeId(bad), { code: 'BAD_ID' }, bad);
  assert.equal(safeId('session-0b1c.x_y'), 'session-0b1c.x_y');
});
test('2026-11-11: appending after a torn last line keeps every complete record and never corrupts the file', () => {
  const f = path.join(tmp(), 'members.jsonl');
  appendJsonl(f, { n: 1 });
  fs.appendFileSync(f, '{"type":"member","chi'); // crash in the middle of a record
  appendJsonl(f, { n: 2 });
  appendJsonl(f, { n: 3 });
  assert.deepEqual(readJsonl(f), { records: [{ n: 1 }, { n: 2 }, { n: 3 }], skipped: 0 });
  assert.equal(fs.readFileSync(`${f}.torn`, 'utf8'), '{"type":"member","chi\n', 'the fragment is kept beside the file, not lost');
});
test('2026-11-11: a complete last record that only lacks its newline is kept', () => {
  const f = path.join(tmp(), 'gate.jsonl');
  fs.writeFileSync(f, '{"n":1}\n{"n":2}'); // crash between the record and its newline
  appendJsonl(f, { n: 3 });
  assert.deepEqual(readJsonl(f).records, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(fs.existsSync(`${f}.torn`), false);
  const only = path.join(tmp(), 'x.jsonl');
  fs.writeFileSync(only, '{"broken');              // nothing but a fragment
  appendJsonl(only, { n: 1 });
  assert.deepEqual(readJsonl(only), { records: [{ n: 1 }], skipped: 0 });
  appendJsonl(path.join(tmp(), 'new', 'y.jsonl'), { n: 1 }); // a missing file and directory still work
});
