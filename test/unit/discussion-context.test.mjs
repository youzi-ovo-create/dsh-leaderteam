import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyEvent, buildMemberRequest, buildArbiterRequest, namedDocuments, MEMBER_SYSTEM, ARBITER_SYSTEM } from '../../leaderteam/core/agreement.mjs';

const created = (o = {}) => ({ type: 'created', id: 'agr-1', topic: 't', kind: 'plan', proposalHash: 'h', maxRounds: 3, maxArbiterAttempts: 2, ...o });
const op = stance => ({ stance, summary: 's', reasons: ['r'], requiredChanges: stance === 'revise' ? ['c'] : [] });
const ev = (round, member, opinion) => ({ type: 'opinion', id: 'agr-1', round, member, opinion });
const input = { topic: 't', kind: 'plan', proposal: 'P', evidence: 'E', userRequest: 'Implement SPEC.md', previousRequiredChanges: ['Add the fourth test'] };

test('reviewers receive the user request and the previous required changes, identically for A and B', () => {
  let s = initialState(created());
  s = applyEvent(applyEvent(s, ev(1, 'A', op('approve'))), ev(1, 'B', op('revise')));
  const a = JSON.parse(buildMemberRequest({ state: s, member: 'A', ...input }).user);
  const b = JSON.parse(buildMemberRequest({ state: s, member: 'B', ...input }).user);
  for (const u of [a, b]) { assert.equal(u.user_request, 'Implement SPEC.md'); assert.deepEqual(u.previous_required_changes, ['Add the fourth test']); assert.equal(u.evidence, 'E'); }
  assert.deepEqual(Object.keys(a), Object.keys(b));
  const plain = JSON.parse(buildMemberRequest({ state: initialState(created()), member: 'A', topic: 't', kind: 'plan', proposal: 'P' }).user);
  assert.equal(plain.user_request, ''); assert.deepEqual(plain.previous_required_changes, [], 'older saved inputs stay valid');
});

test('reviewer rules: judge against the requirements; required changes only for blocking defects', () => {
  assert.match(MEMBER_SYSTEM, /user_request/);
  assert.match(MEMBER_SYSTEM, /only for blocking defects/);
  assert.match(MEMBER_SYSTEM, /Do not require details the requirements leave open/);
  assert.match(MEMBER_SYSTEM, /Put optional suggestions in reasons, never in required_changes/);
  assert.match(MEMBER_SYSTEM, /previous_required_changes/);
  assert.match(MEMBER_SYSTEM, /consensus panel/); assert.match(MEMBER_SYSTEM, /independent reviewers/);
});

test('the arbiter sees the user request and still only picks A or B', () => {
  let s = initialState(created({ maxRounds: 1 }));
  s = applyEvent(applyEvent(s, ev(1, 'A', op('approve'))), ev(1, 'B', op('revise')));
  const r = buildArbiterRequest({ state: s, ...input });
  assert.equal(JSON.parse(r.user).user_request, 'Implement SPEC.md');
  assert.match(ARBITER_SYSTEM, /Do not write your own proposal, changes or reasons/);
  assert.match(ARBITER_SYSTEM, /\{"adopt":"A"\} or \{"adopt":"B"\}/);
});

test('documents named in the user request are found (relative, nested, Windows, mixed with Chinese text)', () => {
  assert.deepEqual(namedDocuments('使用 LeaderTeam 完成当前工作区 LT-E2E-SPEC.md 中的两个独立模块。完整阅读 LT-E2E-SPEC.md，'), ['LT-E2E-SPEC.md']);
  assert.deepEqual(namedDocuments('see docs/api/spec.yaml, config.toml and D:\\proj\\REQ.md.'), ['docs/api/spec.yaml', 'config.toml', 'D:\\proj\\REQ.md']);
  assert.deepEqual(namedDocuments('run main.py and read https://example.com/x.md'), []);
  assert.deepEqual(namedDocuments(''), []);
});
