import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { zstdFrames, shellTestRuns, workspaceManifest } from '../../scripts/dev/lib/session-rows.mjs';

// Shape copied from a real Windows member session (reports/official-real-summary.json, job/settled).
const settled = (label, detail, status = 'completed') => ({ type: 'job/settled', seq: 32, time: 1793998023971, data: { jobId: 'pwsh-1', owner: 'm1', kind: 'pwsh', label, status, cause: 'producer', producerReported: true, detail } });
const PY = "& 'C:/Users/u/AppData/Local/Programs/Python/Python312/python.exe' -m unittest discover -s textstats -v";

test('shell test runs: a completed zero-exit unittest job for the module passes; others do not', () => {
  const members = [{ childId: 'm1', name: 'impl-text' }];
  const ok = shellTestRuns([{ id: 'm1', rows: [settled(PY, 'exit code: 0')] }], members, { dir: 'textstats' });
  assert.equal(ok.ok, true); assert.equal(ok.runs[0].member, 'impl-text');
  assert.equal(shellTestRuns([{ id: 'm1', rows: [settled(PY, 'exit code: 1')] }], members, { dir: 'textstats' }).ok, false, 'non-zero exit');
  assert.equal(shellTestRuns([{ id: 'm1', rows: [settled(PY, 'exit code: 0', 'killed')] }], members, { dir: 'textstats' }).ok, false, 'not completed');
  assert.equal(shellTestRuns([{ id: 'm1', rows: [settled(PY, 'exit code: 0')] }], members, { dir: 'money' }).ok, false, 'other module');
  assert.equal(shellTestRuns([{ id: 'm1', rows: [settled(PY.replace('unittest', 'pytest'), 'exit code: 0')] }], members, { dir: 'textstats' }).ok, false, 'marker required');
  assert.equal(shellTestRuns([{ id: 'm1', rows: [settled(PY, 'exit code: 0')] }], members, { dir: 'textstats', testMarker: '--test' }).ok, false, 'custom marker');
});

test('session logs: every concatenated zstd frame is decoded in order', () => {
  const a = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s"}\n'));
  const b = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start","time":1}\n{"type":"turn/end","time":2}\n'));
  const lines = zstdFrames(Buffer.concat([a, b])).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).type);
  assert.deepEqual(lines, ['session', 'turn/start', 'turn/end']);
  assert.throws(() => zstdFrames(Buffer.from('not zstd')), /not a zstd stream/);
});

test('workspace manifest hashes every file with forward-slash relative paths', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-manifest-'));
  try {
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a', 'b', 'x.txt'), 'x'); fs.writeFileSync(path.join(d, 'y.txt'), 'y');
    const m = workspaceManifest(d);
    assert.deepEqual(Object.keys(m).sort(), ['a/b/x.txt', 'y.txt']);
    assert.equal(m['y.txt'], 'a1fce4363854ff888cff4b8e7875d600c2682390412a8cf79b37d0b11148b0fa');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
