import { assert, allow, PLAN, callsOf, lastToolResult, agreementEvents } from '../lib.mjs';
export default {
  respond(c) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') {
      return c.who === 'A'
        ? { json: { stance: 'approve', summary: 'ok', reasons: ['fine'], required_changes: [] } }
        : { json: { stance: 'revise', summary: 'needs tests', reasons: ['no unit tests specified for src/a.txt'], suggestions: ['Add a test assertion verifying src/a.txt equals A'], required_changes: ['add tests'] } };
    }
    if (c.kind === 'arbiter') return { json: { adopt: 'B' } };
    if (c.kind === 'leader') return [PLAN, { content: 'FINAL' }][c.index - 1];
  },
  assert(t) {
    const d = callsOf(t, 'discuss');
    assert.equal(d.filter(x => x.who === 'A').length, 3); assert.equal(d.filter(x => x.who === 'B').length, 3);
    const arb = callsOf(t, 'arbiter');
    assert.equal(arb.length, 1, 'arbiter exactly once');
    assert.equal(arb[0].model, t.config.roles.arbiter.route); assert.equal(arb[0].effort, t.config.roles.arbiter.effort);
    const r2 = d.find(x => x.who === 'A' && x.request.round === 2);
    assert.equal(r2.request.previous_round.peer.stance, 'revise'); assert.equal(r2.request.previous_round.yours.stance, 'approve');
    assert.equal(d.find(x => x.request.round === 1).request.previous_round, null);
    const out = JSON.parse(lastToolResult(callsOf(t, 'leader')[1]));
    assert.deepEqual((({change_items,conditions,...outcome})=>outcome)(out.outcome), {
      decision: 'revise',
      by: 'arbiter',
      round: 3,
      adopted: 'B',
      reasons: ['no unit tests specified for src/a.txt'],
      suggestions: ['Add a test assertion verifying src/a.txt equals A'],
      required_changes: ['add tests'],
    });
    assert.equal(out.outcome.change_items[0].problem,'add tests');
    assert.equal(agreementEvents(t).filter(e => e.type === 'ruling').length, 1);
  },
};
