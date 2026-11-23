import fs from 'node:fs';
import path from 'node:path';
import { assert, allow, approve, lastToolResult, read, teamDir, callsOf } from '../lib.mjs';

const role = route => ({ route, effort: 'high', maxTokens: 3000, timeoutMs: 20000, retries: 0, fallback: [] });
const cfg = { team: { rollingPlanning: true }, quota: { allowUnknown: true }, roles: { leader: { route: 'zcode/GLM-5.3-Flash', effort: 'high' }, gate: role('zcode/GLM-5.3-Flash'), discussA: role('zcode/GLM-5.3'), discussB: role('zcode/GLM-5.3-Flash'), arbiter: role('zcode/GLM-5.3') } };
const tool = (tool, args) => ({ tool, args });
const stage = (id, fields = {}) => ({ action: 'stage', stage_id: id, goal: `Implement ${id}`, method: 'Write the specified file and check its content', acceptance: [`src/${id}.txt matches its contract`], interfaces: ['A standalone text file; no shared mutable state'], profile: 'code', tools: ['read', 'write'], write_scope: [`src/${id}.txt`], parallel_with: [id === 'module-a' ? 'module-b' : 'module-a'], ready: true, ...fields });
const jsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
function state(t) {
  const dir = teamDir(t), events = jsonl(path.join(dir, 'workflow.jsonl')), members = new Map();
  for (const e of jsonl(path.join(dir, 'members.jsonl'))) if (e.childId) members.set(e.childId, { ...members.get(e.childId), ...e });
  const latest = Object.fromEntries(events.filter(e => e.type === 'plan-increment' && e.stage).map(e => [e.stage.id, e.stage.hash]));
  const approvals = Object.fromEntries(events.filter(e => e.type === 'execution-review-result' && e.stageHash === latest[e.stageId] && e.result?.outcome?.decision === 'approve').map(e => [e.stageId, e.result.id]));
  return { events, members: [...members.values()], approvals };
}

export default {
  config: cfg,
  files: { 'spec.md': 'Produce independent src/module-a.txt and src/module-b.txt, then inspect both.\n' },
  async respond(c, t) {
    if (!t.state.started) {
      t.state.started = true; t.state.phase = 0; t.state.files = {};
      t.state.bRecorded = new Promise(r => { t.state.releaseAReview = r; });
      t.state.cRecorded = new Promise(r => { t.state.releaseAMember = r; });
    }
    if (c.kind === 'gate') {
      if (c.request.operation.tool === 'team_dispatch') {
        const resolved = JSON.parse(c.request.operation.arguments_json);
        assert.ok(resolved.task && resolved.tools?.includes('read') && Array.isArray(resolved.write_scope), 'safety gate sees resolved assignment, not just opaque stage ids');
        t.state.resolvedGateCalls = (t.state.resolvedGateCalls ?? 0) + 1;
      }
      return allow;
    }
    if (c.kind === 'serial-review') return { json: { verdict: 'proven', responsibilities: [c.request.execution_stage.contract.goal], proof: [{ constraint: 'One atomic file assignment or one read-only verification step; other files already have separate owners', evidence: c.request.execution_stage.contract.goal, rules_out: 'No distinct implementation unit remains within this bounded single-file or read-only step' }], reason: 'Independent modules are already separate contracts', feedback: [] } };
    if (c.kind === 'discuss') {
      if (c.request.execution_stage?.id === 'module-a') {
        await Promise.race([t.state.bRecorded, new Promise((_, reject) => setTimeout(() => reject(Error('B planning did not advance while A review was pending')), 5000))]);
        t.state.aReviewReturnedAt = Date.now();
      }
      return approve;
    }
    if (c.kind === 'leader') {
      const p = t.state.phase++;
      if (p === 0) return tool('team_plan', { action: 'overview', summary: 'Two independent files and verification', approach: 'Review A while planning B; execute independently then verify', acceptance: ['Both files are present and inspected'], estimated_minutes: 2, future_work: ['module-a', 'module-b', 'verify-files'] });
      if (p === 1) return tool('team_plan', stage('module-a'));
      if (p === 2) { t.state.files['module-a'] = JSON.parse(lastToolResult(c)).stage.file; return tool('team_discuss', { kind: 'plan', stage_id: 'module-a', topic: 'A execution' }); }
      if (p === 3) {
        const r = JSON.parse(lastToolResult(c)); assert.equal(r.status, 'reviewing');
        t.state.aTicketAt = Date.now(); return tool('team_plan', stage('module-b'));
      }
      if (p === 4) {
        t.state.files['module-b'] = JSON.parse(lastToolResult(c)).stage.file;
        t.state.bRecordedAt = Date.now(); t.state.releaseAReview();
        return tool('team_discuss', { kind: 'plan', stage_id: 'module-b', topic: 'B execution' });
      }
      const s = state(t);
      if (s.approvals['module-a'] && !t.state.aAmended) {
        t.state.aAmended = true; t.state.oldApproval = s.approvals['module-a'];
        return tool('team_plan', stage('module-a', { method: 'Use the reviewed revised interface and verify output' }));
      }
      if (t.state.aAmended && !t.state.aReReviewed) {
        t.state.aReReviewed = true; t.state.files['module-a'] = JSON.parse(lastToolResult(c)).stage.file;
        return tool('team_discuss', { kind: 'plan', stage_id: 'module-a', topic: 'Updated A execution' }); // host carries the correct revision lineage
      }
      if (!s.members.some(m => m.name === 'writer-a') && s.approvals['module-a']) return tool('team_dispatch', { name: 'writer-a', stage_id: 'module-a', plan_id: s.approvals['module-a'], model: 'zcode/GLM-5.3-Flash', effort: 'high' });
      if (!t.state.cStarted && s.members.some(m => m.name === 'writer-a')) {
        t.state.cStarted = true; t.state.cPlanningAt = Date.now();
        return tool('team_plan', { action: 'stage', stage_id: 'verify-files', goal: 'Inspect both resulting files after execution', method: 'Read both files', ready: false });
      }
      if (t.state.cStarted && !t.state.cWritten) {
        t.state.cWritten = true; t.state.releaseAMember();
      }
      if (!s.members.some(m => m.name === 'writer-b') && s.approvals['module-b']) return tool('team_dispatch', { name: 'writer-b', stage_id: 'module-b', plan_id: s.approvals['module-b'], model: 'zcode/GLM-5.3-Flash', effort: 'high' });
      if (s.members.filter(m => m.name.startsWith('writer-')).length === 2 && s.members.filter(m => m.name.startsWith('writer-')).every(m => m.status === 'done')) {
        if (!t.state.verificationReady) { t.state.verificationReady = true; return tool('team_plan', stage('verify-files', { profile: 'readonly', tools: ['read'], write_scope: [], acceptance: ['Both file contents checked'], depends_on: ['module-a', 'module-b'], parallel_with: [], serial_reason: 'Verification requires actual files from A and B' })); }
        if (!t.state.verificationReview) { t.state.verificationReview = true; t.state.files['verify-files'] = JSON.parse(lastToolResult(c)).stage.file; return tool('team_discuss', { kind: 'plan', stage_id: 'verify-files', topic: 'Inspect real outputs' }); }
        if (s.approvals['verify-files'] && !s.members.some(m => m.name === 'verifier')) return tool('team_dispatch', { name: 'verifier', stage_id: 'verify-files', plan_id: s.approvals['verify-files'], model: 'zcode/GLM-5.3-Flash', effort: 'high' });
      }
      if (s.members.some(m => m.name === 'verifier' && m.status === 'done')) {
        if (!t.state.delivery) { t.state.delivery = true; return tool('team_discuss', { kind: 'delivery', topic: 'Actual files checked', proposal: 'A and B written, independent verification completed.', evidence_files: ['src/module-a.txt', 'src/module-b.txt'] }); }
        return { content: 'DELIVERY: approved' };
      }
      if (s.members.some(m => ['running', 'starting', 'started'].includes(m.status))) return { content: 'WAITING' };
      return tool('team_plan', { action: 'state' });
    }
    if (c.kind === 'member') {
      const id = c.who === 'writer-a' ? 'module-a' : c.who === 'writer-b' ? 'module-b' : 'verify-files';
      if (c.index === 1) return tool('read', { file_path: t.state.files[id] });
      if (id === 'verify-files') {
        if (c.index === 2) return tool('read', { file_path: 'src/module-a.txt' });
        if (c.index === 3) return tool('read', { file_path: 'src/module-b.txt' });
        return { content: 'STATUS: done\nEVIDENCE: both actual file contents inspected' };
      }
      if (c.index === 2) return tool('write', { file_path: `src/${id}.txt`, content: `${id.toUpperCase()}\n` });
      if (id === 'module-a') await Promise.race([t.state.cRecorded, new Promise((_, reject) => setTimeout(() => reject(Error('Leader did not plan C while A executed')), 5000))]);
      return { content: 'STATUS: done' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    assert.equal(read(t, 'src/module-a.txt'), 'MODULE-A\n'); assert.equal(read(t, 'src/module-b.txt'), 'MODULE-B\n');
    assert.ok(t.state.bRecordedAt <= t.state.aReviewReturnedAt, 'B was recorded before A execution review returned');
    assert.ok(t.state.cPlanningAt, 'C planning occurred while implementation was in progress');
    const s = state(t); assert.equal(s.members.length, 3); assert.ok(s.members.every(m => m.status === 'done'));
    assert.equal(callsOf(t, 'planning').length, 0, 'background planning LLM reviewers are pruned');
    assert.equal(callsOf(t, 'discuss').filter(c => c.request.execution_stage?.id === 'verify-files').length, 2);
    assert.equal(t.state.resolvedGateCalls, 3);
    const aInputs = fs.readdirSync(path.join(teamDir(t), 'agreements')).filter(f => f.endsWith('.input.json')).map(f => JSON.parse(fs.readFileSync(path.join(teamDir(t), 'agreements', f), 'utf8'))).filter(i => i.stageReview?.id === 'module-a');
    assert.ok(aInputs.some(i => i.revises === t.state.oldApproval), 'new stage version automatically carries its prior stage approval');
    assert.match(t.runs[0].final.text, /DELIVERY: approved/);
  },
};
