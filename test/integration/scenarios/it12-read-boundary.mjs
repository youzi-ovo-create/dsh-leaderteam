import fs from 'node:fs';
import path from 'node:path';
import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, gateReceipts, exists, read, lastToolResult } from '../lib.mjs';

export default {
  files: { 'spec.md': 'workspace spec\n' },
  respond(c, t) {
    if (!t.state.setupDone) {
      t.state.setupDone = true;
      t.state.extDir = path.join(t.workDir, 'external-dir');
      fs.mkdirSync(t.state.extDir, { recursive: true });
      t.state.extFile = path.join(t.state.extDir, 'outside.txt');
      fs.writeFileSync(t.state.extFile, 'synthetic external content\n');
      fs.mkdirSync(path.join(t.ws, 'src'), { recursive: true });
      fs.symlinkSync(t.globalRefs, path.join(t.ws, 'src', 'alias-global'), 'junction');
      fs.symlinkSync(t.state.extDir, path.join(t.ws, 'src', 'alias-ext'), 'junction');
    }
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') {
      return [
        PLAN,
        dispatch({ plan_id: latestPlanId(c), name: 'bad-ref', refs: [t.state.extFile] }),
        dispatch({ plan_id: latestPlanId(c), refs: ['spec.md', path.join(t.globalRefs, 'GLOBAL.md')] }),
        { content: 'WAITING' },
        { content: 'REPORTED' },
      ][c.index - 1];
    }
    if (c.kind === 'member') {
      return [
        { tool: 'read', args: { file_path: t.state.extFile } },
        { tool: 'grep', args: { pattern: 'synthetic', path: 'src/alias-ext' } },
        { tool: 'read', args: { file_path: 'spec.md' } },
        { tool: 'read', args: { file_path: path.join(t.globalRefs, 'GLOBAL.md') } },
        { tool: 'write', args: { file_path: 'src/alias-global/proof.txt', content: 'tampered' } },
        { tool: 'write', args: { file_path: 'src/ok.txt', content: 'ok' } },
        { content: 'STATUS: done' },
      ][c.index - 1];
    }
  },
  assert(t) {
    const leaderCalls = callsOf(t, 'leader');
    assert.match(lastToolResult(leaderCalls[2]), /ref must be inside the workspace or a global reference root/, 'external ref rejected at dispatch');
    assert.match(lastToolResult(leaderCalls[3]), /"member": "impl"/, 'valid workspace + global refs accepted at dispatch');

    const memberCalls = callsOf(t, 'member', 'impl');
    assert.match(lastToolResult(memberCalls[1]), /rule:path-outside-workspace/, 'member direct external read denied');
    assert.ok(!lastToolResult(memberCalls[1]).includes('synthetic external content'));
    assert.match(lastToolResult(memberCalls[2]), /rule:path-outside-workspace/, 'member grep via external junction denied');
    assert.match(lastToolResult(memberCalls[3]), /workspace spec/, 'member workspace ref read allowed');
    assert.match(lastToolResult(memberCalls[4]), /global reference/, 'member global ref read allowed');
    assert.match(lastToolResult(memberCalls[5]), /rule:path-in-global-refs/, 'member write through junction into global refs denied');

    assert.equal(fs.existsSync(path.join(t.globalRefs, 'proof.txt')), false, 'global refs untouched');
    assert.equal(read(t, 'src/ok.txt'), 'ok', 'valid write after reading both refs succeeded');

    const receipts = gateReceipts(t);
    assert.ok(receipts.some(r => r.tool === 'read' && r.decision === 'deny' && r.by === 'rule:path-outside-workspace'));
    assert.ok(receipts.some(r => r.tool === 'grep' && r.decision === 'deny' && r.by === 'rule:path-outside-workspace'));
    assert.ok(receipts.some(r => r.tool === 'write' && r.decision === 'deny' && r.by === 'rule:path-in-global-refs'));
  },
};
