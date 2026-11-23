import fs from 'node:fs';
import path from 'node:path';
import { assert, callsOf, lastToolResult, agreementEvents, teamDir } from '../lib.mjs';
// Reviewers judge against the user's requirements: the user's request and the documents it names are
// attached automatically; a revised proposal (revises=<id>) shows the earlier required changes to both
// reviewers; an unknown revises id is refused.
const REVISE = {
  json: {
    stance: 'revise',
    summary: 'missing content specification',
    reasons: ['REQ-SPEC.md fixes exact file content A, which Plan v1 omits'],
    suggestions: ['Specify in the member task and acceptance criteria that src/a.txt contains exact string A'],
    required_changes: ['State that src/a.txt contains exactly A.'],
  },
};
const APPROVE = { json: { stance: 'approve', summary: 'meets the requirement', reasons: ['matches REQ-SPEC.md'], required_changes: [] } };
export default {
  files: { 'REQ-SPEC.md': 'Requirement: write src/a.txt containing A.\n' },
  runs: [{ task: 'Implement REQ-SPEC.md using the team.' }],
  respond(c, t) {
    const s = t.state; s.discuss ??= [];
    if (c.kind === 'discuss') {
      s.discuss.push(c.request);
      return c.request.proposal === 'Plan v1' ? REVISE : APPROVE;
    }
    if (c.kind === 'leader') {
      if (c.index === 1) return { tool: 'team_discuss', args: { kind: 'plan', topic: 'plan', proposal: 'Plan v1' } };
      if (c.index === 2) { s.first = JSON.parse(lastToolResult(c)).id; return {tool:'team_note',args:{scope:'current_plan',path:'plan.md',content:'Plan v2'}}; }
      if (c.index === 3) return { tool: 'team_discuss', args: { kind: 'plan', topic: 'plan v2', revises: s.first } };
      if (c.index === 4) return { tool: 'team_discuss', args: { kind: 'plan', topic: 'plan v3', proposal: 'Plan v3', revises: 'agr-00000000' } };
      return { content: 'DONE' };
    }
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'exit code');
    const d = t.state.discuss;
    assert.equal(d.length, 4, 'two agreements, both settled in round 1');
    for (const r of d) {
      assert.match(r.user_request, /Implement REQ-SPEC\.md using the team\./, 'reviewers see the user request');
      assert.match(r.evidence, /### file: REQ-SPEC\.md\nRequirement: write src\/a\.txt containing A\./, 'the named requirement document is attached');
    }
    const v1 = d.filter(r => r.proposal === 'Plan v1'), v2 = d.filter(r => r.proposal === 'Plan v2');
    assert.deepEqual(v1.map(r => r.previous_required_changes), [[], []]);
    assert.deepEqual(v2.map(r => r.previous_required_changes), [['State that src/a.txt contains exactly A.'], ['State that src/a.txt contains exactly A.']], 'both reviewers see the earlier required changes');
    assert.deepEqual(d.map(r => r.you_are).sort(), ['A', 'A', 'B', 'B']);
    const l = callsOf(t, 'leader');
    const first = JSON.parse(lastToolResult(l[1]));
    assert.equal(first.outcome.decision, 'revise'); assert.deepEqual(first.auto_evidence_files, ['REQ-SPEC.md']);
    const second = JSON.parse(lastToolResult(l[3]));
    assert.equal(second.outcome.decision, 'approve'); assert.equal(second.revises, t.state.first);
    assert.match(lastToolResult(l[4]), /revises: unknown agreement agr-00000000/);
    const created = agreementEvents(t).filter(e => e.type === 'created');
    assert.equal(created.length, 2); assert.equal(created[1].revises, t.state.first);
    const saved = JSON.parse(fs.readFileSync(path.join(teamDir(t), 'agreements', `${t.state.first}.input.json`), 'utf8'));
    assert.match(saved.userRequest, /REQ-SPEC\.md/); assert.deepEqual(saved.autoEvidenceFiles, ['REQ-SPEC.md']);
  },
};
