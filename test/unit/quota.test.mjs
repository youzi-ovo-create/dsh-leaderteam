import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readQuotaStateFile, parseQuotaState, routeQuota, routeUsage } from '../../leaderteam/core/quota.mjs';
import { executionModelRows, validateExecutionChoice, quotaGate } from '../../leaderteam/core/models.mjs';
import { ROOT, defaultConfig, configWith } from './helpers.mjs';
const GEMINI_QUOTA_SPEC = { family: 'gemini', label: 'Quota fixture', efforts: ['high'], defaultEffort: 'high' };
const NOW = new Date('2026-11-06T20:43:00+08:00');
const state = () => readQuotaStateFile(path.join(ROOT, 'test/fixtures/quota-state.json')).state;
test('reads the existing quota tool format', () => {
  const r = readQuotaStateFile(path.join(ROOT, 'test/fixtures/quota-state.json'));
  assert.ok(r.ok); assert.equal(r.state.accounts.length, 5); assert.equal(r.state.accounts[4].windows[0].remainingPct, null);
  assert.equal(readQuotaStateFile(path.join(ROOT, 'nope.json')).ok, false);
  assert.deepEqual(parseQuotaState(null).accounts, []);
});
test('best account = max over accounts of min window; thresholds', () => {
  const c = defaultConfig();
  const sol = routeQuota(state(), 'codex/gpt-6.1-sol', c.models['codex/gpt-6.1-sol'], c.quota, NOW);
  assert.equal(sol.status, 'ok'); assert.equal(sol.bestRemainingPct, 39); assert.equal(sol.bestAccount, 'codex-b');
  const glm = routeQuota(state(), 'zcode/GLM-5.3', c.models['zcode/GLM-5.3'], c.quota, NOW);
  assert.equal(glm.status, 'low'); assert.equal(glm.bestRemainingPct, 10); assert.ok(glm.nextResetAt.startsWith('2026-11-07T17:22'));
  const argon = routeQuota(state(), 'antigravity/gemini-4-argon', GEMINI_QUOTA_SPEC, c.quota, NOW);
  assert.equal(argon.status, 'exhausted');
});
test('stale or missing snapshots are unknown', () => {
  const c = defaultConfig();
  const later = new Date(NOW.getTime() + 3600e3);
  assert.equal(routeQuota(state(), 'codex/gpt-6.1-sol', c.models['codex/gpt-6.1-sol'], c.quota, later).status, 'unknown');
  assert.equal(routeQuota(null, 'codex/gpt-6.1-sol', {}, c.quota, NOW).status, 'unknown');
  assert.equal(routeQuota(state(), 'other/x', {}, c.quota, NOW).status, 'unknown');
});
test('quotaWindows narrows the considered windows', () => {
  const c = configWith({ models: { 'antigravity/gemini-4-argon': { ...GEMINI_QUOTA_SPEC, quotaWindows: ['Gemini · 5 hours'] } } });
  assert.equal(routeQuota(state(), 'antigravity/gemini-4-argon', c.models['antigravity/gemini-4-argon'], c.quota, NOW).status, 'ok');
});
test('usage samples and execution rows', () => {
  assert.equal(routeUsage(state(), 'codex/gpt-6.1-sol').byEffort.high.p50Tokens, 307343);
  const rows = executionModelRows(defaultConfig(), state(), NOW);
  assert.deepEqual(rows.map(row => row.route), defaultConfig().team.executionPool); assert.ok(rows.every(r => r.quota && r.efforts.length));
});
test('choice validation and quota gate never substitute', () => {
  const c = defaultConfig();
  assert.deepEqual(validateExecutionChoice(c, 'zcode/GLM-5.3', 'max'), { ok: true });
  assert.match(validateExecutionChoice(c, 'zcode/GLM-5.3', 'medium').error, /not supported/);
  assert.match(validateExecutionChoice(c, 'x/y', 'low').error, /not in the execution pool/);
  const g = quotaGate(configWith({ models: { 'antigravity/gemini-4-argon': GEMINI_QUOTA_SPEC } }), state(), 'antigravity/gemini-4-argon', NOW);
  assert.equal(g.allowed, false); assert.match(g.error, /exhausted/);
  assert.equal(quotaGate(c, null, 'zcode/GLM-5.3', NOW).allowed, true, 'non-GPT unknown allowed by default');
  assert.equal(quotaGate(c, null, 'codex/gpt-6.1-sol', NOW).allowed, false, 'GPT unknown refused by default to protect Codex reserve');
  assert.equal(quotaGate(configWith({ quota: { allowUnknownGpt: true } }), null, 'codex/gpt-6.1-sol', NOW).allowed, true, 'GPT unknown allowed only when explicitly opted in');
  assert.equal(quotaGate(configWith({ quota: { allowUnknown: false } }), null, 'zcode/GLM-5.3', NOW).allowed, false);
});
