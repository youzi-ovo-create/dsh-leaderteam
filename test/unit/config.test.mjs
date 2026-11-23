import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../../leaderteam/core/config.mjs';
import { defaultConfig, configWith } from './helpers.mjs';
test('shipped default config is valid and frozen; derived fields computed', () => {
  const c = defaultConfig();
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.roles));
  assert.deepEqual([...c.derived.memberProfiles], ['readonly', 'code', 'shell']);
  for (const t of ['team_dispatch', 'team_discuss', 'team_note', 'send_message', 'list_agents', 'interrupt_agent', 'team_models', 'team_status']) assert.ok(c.derived.leaderOnlyTools.includes(t), t);
  assert.ok(!c.derived.leaderOnlyTools.includes('read'));
  for (const role of Object.values(c.roles)) assert.ok(c.models[role.route].efforts.includes(role.effort), 'every shipped role uses a configured model and a supported effort');
});
test('every role route and effort is independently configurable', () => {
  const cfg = configWith({
    roles: {
      leader: { route: 'zcode/GLM-5.3', effort: 'high' },
      gate: { route: 'codex/gpt-6.1-terra', effort: 'xhigh' },
      discussA: { route: 'codex/gpt-6.1-sol', effort: 'low' },
      discussB: { route: 'codex/gpt-6.1-sol', effort: 'high' },
      arbiter: { route: 'antigravity/claude-opus-5-5', effort: 'high' },
    },
  });
  assert.equal(cfg.roles.leader.route, 'zcode/GLM-5.3'); assert.equal(cfg.roles.leader.effort, 'high');
  assert.equal(cfg.roles.gate.route, 'codex/gpt-6.1-terra'); assert.equal(cfg.roles.gate.effort, 'xhigh');
  assert.equal(cfg.roles.arbiter.effort, 'high');
  assert.equal(cfg.roles.discussA.route, 'codex/gpt-6.1-sol');
  assert.equal(cfg.roles.discussB.route, 'codex/gpt-6.1-sol');
  assert.notEqual(cfg.roles.discussA.effort, cfg.roles.discussB.effort, 'same route, independent effort per role');
  assert.equal(configWith({ roles: { arbiter: { route: 'zcode/GLM-5.3', effort: 'max' } } }).roles.arbiter.route, 'zcode/GLM-5.3');
});
test('route and effort choices are validated per role; policy and pool stay strict', () => {
  assert.throws(() => configWith({ roles: { gate: { route: 'nope/x' } } }), /roles.gate.route "nope\/x" is not in models/);
  assert.throws(() => configWith({ roles: { discussB: { route: 'antigravity/claude-opus-5-5', effort: 'max' } } }), /roles\.discussB\.effort "max" is not supported/);
  assert.throws(() => configWith({ roles: { leader: { route: 'zcode/GLM-5.3', effort: 'medium' } } }), /roles\.leader\.effort "medium" is not supported/);
  assert.throws(() => configWith({ team: { executionPool: ['x/y'] } }), /executionPool: "x\/y" is not in models/);
  assert.throws(() => configWith({ gate: { uncontrolledTools: ['write'] } }), /mutating tool "write" cannot be uncontrolled/);
  assert.throws(() => configWith({ quota: { exhaustedBelowPct: 50, lowBelowPct: 10 } }), /exhaustedBelowPct must be <=/);
  assert.throws(() => configWith({ toolPolicy: { additionalTools: ['x', 'x'] } }), /contains duplicates/);
  assert.equal(configWith({ toolPolicy: { additionalTools: ['extra_indexer'] } }).toolPolicy.additionalTools[0], 'extra_indexer');
});
test('collects all problems in one error', () => {
  try { validateConfig({ schemaVersion: 2 }); assert.fail('should throw'); } catch (e) { assert.equal(e.code, 'BAD_CONFIG'); assert.ok(e.details.problems.length > 5); }
});
