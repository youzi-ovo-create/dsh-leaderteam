import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLeaderModel } from '../../leaderteam/core/models.mjs';
import { maskedGlobalTools } from '../../leaderteam/host/roles.mjs';
import { configWith, defaultConfig } from './helpers.mjs';

const SOL = { provider: 'magpie', model: 'codex/gpt-6.1-sol', reasoningEffort: 'high' };

test('leader model policy defaults to enforce and is validated', () => {
  assert.equal(defaultConfig().team.leaderModelPolicy, 'enforce');
  assert.equal(configWith({ team: { leaderModelPolicy: 'warn' } }).team.leaderModelPolicy, 'warn');
  assert.throws(() => configWith({ team: { leaderModelPolicy: 'strict' } }), /team\.leaderModelPolicy must be "enforce", "warn" or "off"/);
});

test('enforce: exact route+effort passes; wrong route, wrong effort or unknown effort blocks', () => {
  const cfg = defaultConfig();
  const ok = checkLeaderModel(cfg, SOL);
  assert.equal(ok.status, 'match'); assert.equal(ok.blocked, false); assert.equal(ok.message, undefined);
  const effort = checkLeaderModel(cfg, { ...SOL, reasoningEffort: 'medium' });
  assert.equal(effort.status, 'mismatch'); assert.equal(effort.blocked, true, 'effort mismatch is enforced');
  assert.match(effort.message, /leader reasoning effort is medium; configured high/);
  const noEffort = checkLeaderModel(cfg, { provider: 'magpie', model: 'codex/gpt-6.1-sol' });
  assert.equal(noEffort.status, 'unknown'); assert.equal(noEffort.blocked, true, 'unknown effort fails closed');
  assert.match(noEffort.message, /Auto\/unknown/);
  const other = checkLeaderModel(cfg, { provider: 'magpie', model: 'zcode/GLM-5.3', reasoningEffort: 'high' });
  assert.equal(other.status, 'mismatch'); assert.equal(other.blocked, true);
  assert.match(other.message, /runs magpie\/zcode\/GLM-5\.3, but the configured leader is magpie\/codex\/gpt-6\.1-sol \(high\)/);
  const provider = checkLeaderModel(cfg, { provider: 'deepseek', model: 'codex/gpt-6.1-sol' });
  assert.equal(provider.blocked, true, 'provider is part of the route');
  for (const sel of [undefined, null, {}, { provider: 'magpie' }]) {
    const u = checkLeaderModel(cfg, sel);
    assert.equal(u.status, 'unknown'); assert.equal(u.blocked, true, 'unknown selection fails closed under enforce');
  }
});

test('warn reports route and effort mismatches without blocking; off skips; roles.leader stays configurable', () => {
  const warn = configWith({ team: { leaderModelPolicy: 'warn' } });
  const w = checkLeaderModel(warn, { provider: 'magpie', model: 'zcode/GLM-5.3' });
  assert.equal(w.status, 'mismatch'); assert.equal(w.blocked, false); assert.ok(w.message);
  const wEffort = checkLeaderModel(warn, { ...SOL, reasoningEffort: 'low' });
  assert.equal(wEffort.blocked, false, 'warn never blocks an effort mismatch'); assert.ok(wEffort.message);
  assert.equal(checkLeaderModel(warn, undefined).blocked, false);
  const off = configWith({ team: { leaderModelPolicy: 'off' } });
  assert.deepEqual([checkLeaderModel(off, undefined).status, checkLeaderModel(off, undefined).blocked], ['unchecked', false]);
  const glm = configWith({ roles: { leader: { route: 'zcode/GLM-5.3', effort: 'high' } } });
  assert.equal(checkLeaderModel(glm, { provider: 'magpie', model: 'zcode/GLM-5.3', reasoningEffort: 'high' }).status, 'match');
  assert.equal(checkLeaderModel(glm, SOL).blocked, true);
});

test('team agents see exactly their profile: every other global tool is masked', () => {
  const cfg = defaultConfig();
  const globals = ['read', 'glob', 'grep', 'working_directory', 'load_workspace_dependencies', 'team_dispatch', 'team_models', 'read'];
  assert.deepEqual(maskedGlobalTools(globals, cfg.profiles.code.tools), ['load_workspace_dependencies', 'team_dispatch', 'team_models', 'working_directory']);
  assert.deepEqual(maskedGlobalTools(globals, cfg.profiles.leader.tools), ['load_workspace_dependencies', 'working_directory']);
  assert.deepEqual(maskedGlobalTools(['x'], undefined), ['x']);
  for (const t of cfg.profiles.shell.tools) assert.ok(!maskedGlobalTools([t], cfg.profiles.shell.tools).includes(t), `${t} stays visible`);
});
