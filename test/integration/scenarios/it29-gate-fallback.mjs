// During a safety-review outage on the configured route, the gate answers on the next route of its chain: every
// operation is still reviewed (never waved through), and the receipts and the usage ledger say which route ran.
import path from 'node:path';
import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, gateReceipts, read, jsonl, teamDir } from '../lib.mjs';
const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, DELIVERY, { content: 'DELIVERY: approved' }];
const MEMBER = [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } }, { content: 'STATUS: done\nCHANGED: src/a.txt\nEVIDENCE: wrote file\nNOTES: none' }];
export default {
  files: { 'spec.md': 'spec\n' },
  config: { roles: { gate: { retries: 0 } } },
  respond(c, t) {
    if (c.kind === 'gate') return c.model === t.config.roles.gate.route ? { httpStatus: 500 } : allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return MEMBER[c.index - 1];
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0, 'exit code');
    assert.equal(read(t, 'src/a.txt'), 'A\n', 'the write ran after the fallback route allowed it');
    const primary = t.config.roles.gate.route, fallback = t.config.roles.gate.fallback[0].route;
    assert.notEqual(primary, fallback);
    const gates = callsOf(t, 'gate');
    assert.ok(gates.some(g => g.model === primary), 'the configured route was tried first');
    assert.ok(gates.some(g => g.model === fallback), 'the fallback route answered');
    const receipts = gateReceipts(t);
    const reviewed = receipts.filter(r => r.by === 'model');
    assert.deepEqual(reviewed.map(r => r.tool).sort(), ['team_dispatch', 'write'], 'both controlled operations were reviewed by a model');
    for (const r of reviewed) {
      assert.equal(r.decision, 'allow'); assert.equal(r.model, fallback); assert.equal(r.degraded, true); assert.equal(r.via, 'fallback');
    }
    assert.ok(!receipts.some(r => r.by === 'gate-error'), 'an outage of one route is not a review failure');
    const usage = jsonl(path.join(teamDir(t), 'usage.jsonl')).filter(u => u.role === 'gate');
    assert.ok(usage.some(u => u.route === primary && u.ok === false), 'the failed attempt is in the ledger');
    assert.ok(usage.some(u => u.route === fallback && u.ok === true && u.degraded === true && u.via === 'fallback'), 'the degraded answer is marked in the ledger');
  },
};
