import { assert, allow, PLAN, callsOf, lastToolResult } from '../lib.mjs';
const op = s => (s === 'approve'
  ? { json: { stance: 'approve', summary: 'approve', reasons: ['meets requirements'], required_changes: [] } }
  : { json: { stance: s, summary: 'scope mismatch', reasons: ['write_scope omits target file'], suggestions: ['Restrict write_scope to src/a.txt and pass spec.md in refs'], required_changes: s === 'revise' ? ['fix write_scope'] : [] } });
export default {
  config: {
    // Keep this scenario on agreement error + resume_id recovery rather than leader-model fallback.
    team: { leaderModelAsLastResort: false },
    roles: { discussA: { fallback: [] }, discussB: { fallback: [] } },
  },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') {
      const round = c.request.round;
      if (c.who === 'A' && round === 2) { t.state.a2 = (t.state.a2 ?? 0) + 1; return t.state.a2 <= 2 ? { httpStatus: 500 } : op('approve'); }
      if (round === 1) return op(c.who === 'A' ? 'approve' : 'reject');
      return op('approve');
    }
    if (c.kind === 'leader') {
      if (c.index === 1) return PLAN;
      if (c.index === 2) { const r = JSON.parse(lastToolResult(c)); t.state.firstResult = r; return { tool: 'team_discuss', args: { ...PLAN.args, resume_id: r.id } }; }
      return { content: 'FINAL' };
    }
  },
  assert(t) {
    assert.equal(t.state.firstResult.status, 'error'); assert.match(t.state.firstResult.hint, /resume_id/);
    const d = callsOf(t, 'discuss');
    assert.equal(d.filter(x => x.who === 'B' && x.request.round === 2).length, 1, 'B is not asked again for round 2');
    assert.ok(d.filter(x => x.who === 'A' && x.request.round === 2).length >= 3, 'A: failed attempts + one after resume');
    assert.equal(d.filter(x => x.request.round === 1).length, 2, 'round 1 never repeated');
    const out = JSON.parse(lastToolResult(callsOf(t, 'leader')[2]));
    assert.equal(out.outcome.decision, 'approve'); assert.equal(out.outcome.round, 2);
  },
};
