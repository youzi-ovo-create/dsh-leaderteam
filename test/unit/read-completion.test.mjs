import test from 'node:test';
import assert from 'node:assert/strict';
import { onAgentDisposed, onToolResult } from '../../leaderteam/host/roles.mjs';
import { runtime } from '../../leaderteam/host/runtime.mjs';
import { pathKey, resolvePath } from '../../leaderteam/core/paths.mjs';

// These cases use Windows paths, as on the production host; they are skipped elsewhere.
const wtest = (name, fn) => test(name, { skip: process.platform !== 'win32' && 'uses Windows paths' }, fn);
const CWD = 'D:\\leaderteam-read-test';
const FILE = resolvePath('spec.md', CWD, 'win32');

function member(id = 'member-1') {
  const actor = { id, role: 'member', cwd: CWD, refs: [FILE] };
  actor.agent = actor;
  return actor;
}

function readResult({ path = FILE, offset = 1, lines = [], totalLines = 0, includePath = true } = {}) {
  return { isError: false, meta: { ...(includePath ? { path } : {}), offset, lines, totalLines } };
}

function read(memberActor, args, result) {
  onToolResult({ name: 'read', agent: memberActor, arguments: args }, result);
}

function assertUnread(memberActor) {
  assert.equal(Boolean(runtime().reads.get(memberActor.id)?.has(pathKey(FILE, 'win32'))), false);
}

function assertRead(memberActor) {
  assert.equal(runtime().reads.get(memberActor.id)?.has(pathKey(FILE, 'win32')), true);
}

wtest('a successful partial read does not mark a reference complete', () => {
  const actor = member('partial');
  runtime().actors.set(actor.id, actor);
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 1,
    lines: [{ number: 1, text: 'first' }],
    totalLines: 3,
  }));
  assertUnread(actor);
});

wtest('invalid or untrusted read metadata does not mark a reference complete', () => {
  const cases = [
    { meta: undefined },
    readResult({ includePath: false, offset: 1, lines: [{ number: 1, text: 'only' }], totalLines: 1 }),
    readResult({ path: resolvePath('other.md', CWD, 'win32'), offset: 1, lines: [{ number: 1, text: 'only' }], totalLines: 1 }),
    readResult({ offset: 1, lines: [{ number: 3, text: 'third' }], totalLines: 3 }),
    readResult({ offset: 1, lines: [{ number: 1, text: 'a' }, { number: 3, text: 'c' }], totalLines: 3 }),
    readResult({ offset: 1, lines: [{ number: 1, text: 'a' }, { number: 1, text: 'a' }], totalLines: 2 }),
    readResult({ offset: 0, lines: [{ number: 1, text: 'only' }], totalLines: 1 }),
    readResult({ offset: 1, lines: [{ number: 0, text: 'bad' }], totalLines: 1 }),
    readResult({ offset: 1, lines: [{ number: 1.5, text: 'bad' }], totalLines: 2 }),
  ];
  for (const [index, result] of cases.entries()) {
    const actor = member(`invalid-${index}`);
    runtime().actors.set(actor.id, actor);
    read(actor, { file_path: 'spec.md' }, result);
    assertUnread(actor);
  }
});

wtest('empty files and complete windows are marked read', () => {
  const empty = member('empty');
  runtime().actors.set(empty.id, empty);
  read(empty, { file_path: 'spec.md' }, readResult({ offset: 1, lines: [], totalLines: 0 }));
  assertRead(empty);

  const complete = member('complete');
  runtime().actors.set(complete.id, complete);
  read(complete, { file_path: 'spec.md' }, readResult({
    offset: 1,
    lines: [{ number: 1, text: 'first' }, { number: 2, text: 'second' }, { number: 3, text: 'third' }],
    totalLines: 3,
  }));
  assertRead(complete);
});

wtest('disjoint pages accumulate until every line is covered', () => {
  const actor = member('pages');
  runtime().actors.set(actor.id, actor);
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 1,
    lines: [{ number: 1, text: 'first' }],
    totalLines: 3,
  }));
  assertUnread(actor);
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 2,
    lines: [{ number: 2, text: 'second' }, { number: 3, text: 'third' }],
    totalLines: 3,
  }));
  assertRead(actor);
});

wtest('overlapping reads merge and errors never register progress', () => {
  const actor = member('overlap');
  runtime().actors.set(actor.id, actor);
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 1,
    lines: [{ number: 1, text: 'first' }, { number: 2, text: 'second' }],
    totalLines: 4,
  }));
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 1,
    lines: [{ number: 1, text: 'first' }],
    totalLines: 4,
  }));
  assertUnread(actor);
  read(actor, { file_path: 'spec.md' }, { isError: true, meta: readResult().meta });
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 2,
    lines: [{ number: 2, text: 'second' }, { number: 3, text: 'third' }, { number: 4, text: 'fourth' }],
    totalLines: 4,
  }));
  assertRead(actor);
});

wtest('disposing an agent removes its read completion progress', () => {
  const actor = member('dispose');
  runtime().actors.set(actor.id, actor);
  read(actor, { file_path: 'spec.md' }, readResult({
    offset: 1,
    lines: [{ number: 1, text: 'first' }],
    totalLines: 3,
  }));
  onAgentDisposed({ agent: actor });
  assert.equal(runtime().reads.has(actor.id), false);
  assert.equal(runtime().readProgress?.has(actor.id), false);
});
