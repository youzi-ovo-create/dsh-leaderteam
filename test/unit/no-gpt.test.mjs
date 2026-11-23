import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gptRoutes, gptRoles, withoutGptPool } from '../../scripts/dev/lib/no-gpt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/leaderteam.config.json'), 'utf8'));

test('real-model test tools find GPT roles and drop GPT models from the execution pool', () => {
  assert.ok(gptRoutes(shipped).length > 0, 'the catalog has GPT models');
  const withGate = { ...shipped, roles: Object.fromEntries(Object.entries(shipped.roles).map(([role, spec]) => [role, { ...spec, route: role === 'gate' ? gptRoutes(shipped)[0] : 'zcode/GLM-5.3' }])) };
  assert.deepEqual(gptRoles(withGate).map(r => r.role), ['gate']);
  const cfg = withoutGptPool(shipped);
  assert.ok(cfg.team.executionPool.length > 0);
  assert.ok(cfg.team.executionPool.every(r => shipped.models[r].family !== 'gpt'));
  assert.deepEqual(shipped.team.executionPool.filter(r => shipped.models[r].family !== 'gpt'), cfg.team.executionPool, 'order kept, nothing else removed');
  assert.notEqual(cfg.team, shipped.team, 'the shipped config object is not modified');
  assert.throws(() => withoutGptPool({ ...shipped, team: { ...shipped.team, executionPool: gptRoutes(shipped) } }), /no non-GPT model/);
});
