import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyEvent, replay, nextAction, currentRound, buildMemberRequest, buildArbiterRequest, parseMemberOpinion, parseArbiterRuling } from '../../leaderteam/core/agreement.mjs';
const created = (o = {}) => ({ type: 'created', id: 'agr-1', topic: 't', kind: 'plan', proposalHash: 'h', maxRounds: 3, maxArbiterAttempts: 2, ...o });
const op = (stance, changes = [], suggestions = stance === 'approve' ? [] : ['Add explicit unit assertions for src/a.txt']) => ({
  stance,
  summary: stance,
  reasons: ['Missing explicit test coverage check'],
  suggestions,
  requiredChanges: changes,
});
const ev = (round, member, opinion) => ({ type: 'opinion', id: 'agr-1', round, member, opinion });
test('round 1 consensus settles immediately; arbiter never asked', () => {
  let s = initialState(created());
  assert.deepEqual(nextAction(s), { kind: 'members', round: 1, members: ['A', 'B'] });
  s = applyEvent(s, ev(1, 'B', op('approve')));
  assert.deepEqual(nextAction(s), { kind: 'members', round: 1, members: ['A'] });
  s = applyEvent(s, ev(1, 'A', op('approve')));
  assert.equal(s.status, 'settled');
  assert.deepEqual(
    { ...s.outcome, reasons: [...s.outcome.reasons], suggestions: [...s.outcome.suggestions], requiredChanges: [...s.outcome.requiredChanges] },
    { decision: 'approve', by: 'consensus', round: 1, reasons: ['Missing explicit test coverage check'], suggestions: [], requiredChanges: [] },
  );
  assert.equal(nextAction(s).kind, 'settled');
  assert.throws(() => applyEvent(s, { type: 'arbiter-attempt', id: 'agr-1' }), { code: 'AGREEMENT_EVENT' });
});
test('either member may approve or reject: symmetric roles', () => {
  for (const [a, b] of [['approve', 'reject'], ['reject', 'approve']]) {
    let s = initialState(created());
    s = applyEvent(applyEvent(s, ev(1, 'A', op(a))), ev(1, 'B', op(b)));
    assert.equal(s.status, 'open'); assert.equal(currentRound(s), 2);
  }
  let s = initialState(created());
  s = applyEvent(applyEvent(s, ev(1, 'A', op('reject'))), ev(1, 'B', op('reject')));
  assert.equal(s.outcome.decision, 'reject');
});
test('revise+revise merges changes (dedupe, case-insensitive)', () => {
  let s = initialState(created());
  s = applyEvent(applyEvent(s, ev(1, 'A', op('revise', ['Add tests', 'x']))), ev(1, 'B', op('revise', ['add tests', 'y'])));
  assert.deepEqual([...s.outcome.requiredChanges], ['Add tests', 'x', 'y']);
});
test('arbiter only after maxRounds unsettled rounds, exactly once, adopting a side', () => {
  let s = initialState(created());
  for (const n of [1, 2]) {
    s = applyEvent(applyEvent(s, ev(n, 'A', op('approve'))), ev(n, 'B', op('revise', ['c' + n])));
    assert.equal(nextAction(s).kind, 'members');
    assert.throws(() => applyEvent(s, { type: 'arbiter-attempt', id: 'agr-1' }), { code: 'AGREEMENT_EVENT' }, 'no early arbiter');
  }
  s = applyEvent(applyEvent(s, ev(3, 'A', op('approve'))), ev(3, 'B', op('revise', ['final change'])));
  assert.deepEqual(nextAction(s), { kind: 'arbiter' });
  assert.throws(() => applyEvent(s, ev(4, 'A', op('approve'))), { code: 'AGREEMENT_EVENT' }, 'no 4th round');
  assert.throws(() => applyEvent(s, { type: 'ruling', id: 'agr-1', ruling: { adopt: 'B' } }), { code: 'AGREEMENT_EVENT' }, 'ruling needs an attempt');
  s = applyEvent(s, { type: 'arbiter-attempt', id: 'agr-1' });
  s = applyEvent(s, { type: 'ruling', id: 'agr-1', ruling: { adopt: 'B' } });
  assert.equal(s.status, 'settled');
  assert.deepEqual(
    { ...s.outcome, reasons: [...s.outcome.reasons], suggestions: [...s.outcome.suggestions], requiredChanges: [...s.outcome.requiredChanges] },
    {
      decision: 'revise',
      by: 'arbiter',
      round: 3,
      adopted: 'B',
      reasons: ['Missing explicit test coverage check'],
      suggestions: ['Add explicit unit assertions for src/a.txt'],
      requiredChanges: ['final change'],
    },
  );
  assert.throws(() => applyEvent(s, { type: 'ruling', id: 'agr-1', ruling: { adopt: 'A' } }), { code: 'AGREEMENT_EVENT' }, 'second ruling refused');
});
test('arbiter attempts are bounded; stalled after exhaustion', () => {
  let s = initialState(created({ maxRounds: 1, maxArbiterAttempts: 2 }));
  s = applyEvent(applyEvent(s, ev(1, 'A', op('approve'))), ev(1, 'B', op('reject')));
  s = applyEvent(s, { type: 'arbiter-attempt', id: 'agr-1' }); s = applyEvent(s, { type: 'arbiter-attempt', id: 'agr-1' });
  assert.equal(nextAction(s).kind, 'stalled');
  assert.throws(() => applyEvent(s, { type: 'arbiter-attempt', id: 'agr-1' }), { code: 'AGREEMENT_EVENT' });
});
test('replay restores the exact position: resume never resets rounds', () => {
  const events = [created(), ev(1, 'A', op('approve')), ev(1, 'B', op('reject')), ev(2, 'A', op('approve'))];
  const s = replay(events);
  assert.deepEqual(nextAction(s), { kind: 'members', round: 2, members: ['B'] });
  assert.throws(() => applyEvent(s, ev(2, 'A', op('reject'))), { code: 'AGREEMENT_EVENT' }, 'duplicate answer refused');
  assert.throws(() => applyEvent(s, ev(1, 'B', op('reject'))), { code: 'AGREEMENT_EVENT' }, 'past round refused');
  assert.throws(() => replay([ev(1, 'A', op('approve'))]), { code: 'AGREEMENT_EVENT' });
});
test('member request is identical in shape for A and B and shows the previous round symmetrically', () => {
  let s = initialState(created());
  const r1a = JSON.parse(buildMemberRequest({ state: s, member: 'A', topic: 't', kind: 'plan', proposal: 'P', evidence: 'E' }).user);
  assert.equal(r1a.previous_round, null); assert.equal(r1a.round, 1);
  s = applyEvent(applyEvent(s, ev(1, 'A', op('approve'))), ev(1, 'B', op('reject')));
  const a = buildMemberRequest({ state: s, member: 'A', topic: 't', kind: 'plan', proposal: 'P', evidence: 'E' });
  const b = buildMemberRequest({ state: s, member: 'B', topic: 't', kind: 'plan', proposal: 'P', evidence: 'E' });
  assert.equal(a.system, b.system);
  const ua = JSON.parse(a.user), ub = JSON.parse(b.user);
  assert.equal(ua.previous_round.yours.stance, 'approve'); assert.equal(ua.previous_round.peer.stance, 'reject');
  assert.equal(ub.previous_round.yours.stance, 'reject'); assert.equal(ub.previous_round.peer.stance, 'approve');
  assert.deepEqual(Object.keys(ua), Object.keys(ub));
});
test('arbiter request contains all rounds; system forbids own proposal or reasons', () => {
  let s = initialState(created({ maxRounds: 1 }));
  s = applyEvent(applyEvent(s, ev(1, 'A', op('approve'))), ev(1, 'B', op('reject')));
  const r = buildArbiterRequest({ state: s, topic: 't', kind: 'plan', proposal: 'P' });
  assert.match(r.system, /Do not write your own proposal/); assert.equal(JSON.parse(r.user).rounds.length, 1);
});
test('opinion parser contract', () => {
  const parsedRevise = parseMemberOpinion('{"stance":"revise","summary":"Specify output path","reasons":["Output file path is missing from write_scope"],"suggestions":["Add src/out.json to write_scope and assert its contents"],"required_changes":["Include src/out.json in write_scope"]}');
  assert.equal(parsedRevise.ok, true);
  assert.equal(parsedRevise.opinion.requiredChanges[0], 'Include src/out.json in write_scope');
  assert.equal(parsedRevise.opinion.suggestions[0], 'Add src/out.json to write_scope and assert its contents');
  assert.equal(parseMemberOpinion('noise {"stance":"approve","summary":"s","reasons":["r"],"required_changes":[]} noise').ok, true);
  for (const bad of [
    '{}',
    '{"stance":"ok","summary":"s","reasons":["r"],"required_changes":[]}',
    '{"stance":"revise","summary":"s","reasons":["missing"],"suggestions":["Add tests"],"required_changes":[]}',
    '{"stance":"revise","summary":"s","reasons":["missing"],"required_changes":["add tests"]}',
    '{"stance":"reject","summary":"因为方案不完整所以我不同意","reasons":["因为方案不完整所以我不同意"],"suggestions":["请重新设计方案"],"required_changes":[]}',
    '{"stance":"approve","summary":"s","reasons":["r"],"required_changes":["c"]}',
    '{"stance":"approve","summary":"","reasons":["r"],"required_changes":[]}',
    '{"stance":"approve","summary":"s","reasons":[],"required_changes":[]}',
    '{"stance":"approve","summary":"s","reasons":["r"],"required_changes":[],"x":1}',
  ])
    assert.equal(parseMemberOpinion(bad).ok, false, bad);
});
test('ruling parser accepts only {"adopt":"A"|"B"}', () => {
  assert.deepEqual(parseArbiterRuling('{"adopt":"A"}'), { ok: true, ruling: { adopt: 'A' } });
  for (const bad of ['{"adopt":"C"}', '{"adopt":"A","reason":"x"}', '{}', 'A']) assert.equal(parseArbiterRuling(bad).ok, false, bad);
});
