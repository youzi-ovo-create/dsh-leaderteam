import path from 'node:path';
import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, gateReceipts, agreementEvents, read, jsonl, teamDir } from '../lib.mjs';
const LEADER = [PLAN, dispatch(), { content: 'WAITING' }, DELIVERY, { content: 'DELIVERY: approved' }];
const MEMBER = [{ tool: 'read', args: { file_path: 'spec.md' } }, { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } }, { content: 'STATUS: done\nCHANGED: src/a.txt\nEVIDENCE: wrote file\nNOTES: none' }];
export default {
  files: { 'spec.md': 'spec\n' },
  respond(c) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') return c.index === 2 ? dispatch({ plan_id: latestPlanId(c) }) : LEADER[c.index - 1];
    if (c.kind === 'member') return MEMBER[c.index - 1];
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'exit code'); assert.match(run.final?.text ?? '', /DELIVERY: approved/);
    assert.equal(read(t, 'src/a.txt'), 'A\n');
    const leader = callsOf(t, 'leader')[0], member = callsOf(t, 'member', 'impl');
    assert.equal(leader.model, t.config.roles.leader.route);
    for (const x of ['write', 'edit', 'bash', 'pwsh']) assert.ok(!leader.tools.includes(x), `leader must not have ${x}`);
    for (const x of ['team_dispatch', 'team_discuss', 'team_note', 'team_models', 'team_status', 'read']) assert.ok(leader.tools.includes(x), `leader needs ${x}`);
    assert.ok(member.length >= 3);
    assert.equal(member[0].model, 'zcode/GLM-5.3'); assert.equal(member[0].effort, 'high');
    for (const x of ['read', 'write', 'edit', 'glob', 'grep']) assert.ok(member[0].tools.includes(x), `member needs ${x}`);
    for (const x of ['team_dispatch', 'team_discuss', 'team_note', 'send_message', 'list_agents', 'interrupt_agent', 'bash', 'pwsh']) assert.ok(!member[0].tools.includes(x), `member must not have ${x}`);
    const gates = callsOf(t, 'gate');
    assert.deepEqual(gates.map(g => g.request.operation.tool).sort(), ['team_dispatch', 'write'], 'only controlled ops are reviewed');
    for (const g of gates) { assert.equal(g.model, t.config.roles.gate.route); assert.equal(g.effort, t.config.roles.gate.effort); assert.deepEqual(g.tools, [], 'gate request is tool-less'); }
    const w = gates.find(g => g.request.operation.tool === 'write');
    assert.equal(w.request.actor.name, 'impl'); assert.deepEqual(w.request.scope.write_scope, ['src/**']); assert.match(w.request.authorization.member_task, /src\/a.txt/);
    assert.ok(!JSON.stringify(w.request).includes('# LeaderTeam: you are the team leader'), 'gate gets no conversation history');
    assert.ok(gateReceipts(t).some(r => r.tool === 'write' && r.decision === 'allow' && r.by === 'model' && r.member === 'impl'));
    assert.equal(agreementEvents(t).filter(e => e.type === 'opinion').length, 4, 'two agreements settled in round 1');
    assert.equal(callsOf(t, 'arbiter').length, 0);
    assert.deepEqual(callsOf(t, 'discuss').map(c => c.model).sort(), [t.config.roles.discussA.route, t.config.roles.discussA.route, t.config.roles.discussB.route, t.config.roles.discussB.route].sort());
    const usage = jsonl(path.join(teamDir(t), 'usage.jsonl'));
    assert.deepEqual(usage.map(u => u.role).sort(), ['discussA', 'discussA', 'discussB', 'discussB', 'gate', 'gate'], 'every LeaderTeam model call is in the usage ledger');
    for (const u of usage) { assert.equal(u.ok, true); assert.equal(u.usage?.inputTokens, 10, JSON.stringify(u)); assert.equal(u.usage?.outputTokens, 5); }
    assert.deepEqual(usage.filter(u => u.role === 'gate').map(u => u.tool).sort(), ['team_dispatch', 'write']);
    assert.ok(usage.filter(u => u.role !== 'gate').every(u => /^agr-/.test(u.agreementId) && ['plan', 'delivery'].includes(u.kind)));
  },
};
