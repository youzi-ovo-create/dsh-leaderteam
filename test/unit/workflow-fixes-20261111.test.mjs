import { scriptedReview } from '../scripted-review.mjs';
// 2026-11-11 workflow, lifecycle, budget/circuit-breaker, schema, Unicode & quota tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { loadConfig, loadRawConfig } from '../../leaderteam/core/config.mjs';
import { namedDocuments, buildMemberRequest, initialState } from '../../leaderteam/core/agreement.mjs';
import { discoverSkills, loadSkill } from '../../leaderteam/core/skills.mjs';
import { routeQuota } from '../../leaderteam/core/quota.mjs';
import { GATE_SYSTEM } from '../../leaderteam/core/gate-policy.mjs';
import { runtime, teamStore } from '../../leaderteam/host/runtime.mjs';
import { ROOT, defaultConfig, configWith } from './helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-wf:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-wf:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-wf:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'export class ToolExecutionPipeline {',
          '  resolveExecution() { return { execute: async (args) => ({ content: [{ type: "text", text: "ok" }], args }) }; }',
          '  async dispatchToolBody(exec) {',
          '    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);',
          '    return await tool.execute(exec.arguments, exec);',
          '  }',
          '}',
        ].join('\n'),
      };
    }
    if (url === 'virtual-wf:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    }
    if (url === 'virtual-wf:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === "text") this._b.push(c); } blocks() { return this._b; } }',
      };
    }
    return nextLoad(url, context);
  },
});

const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');
const { onAgentStatus, onAgentError, onSessionEvent, onAgentDisposed, userMessageTexts } = await import('../../leaderteam/host/roles.mjs');

test('M7: strict config schema rejects typos, dangerous uncontrolled tools, and accepts expanded model families + local override', t => {
  assert.throws(() => configWith({ gate: { uncontroledTools: ['read'] } }), /unknown config property "gate\.uncontroledTools"/);
  assert.throws(() => configWith({ team: { leaderModelPolcy: 'warn' } }), /unknown config property "team\.leaderModelPolcy"/);
  assert.throws(() => configWith({ extraTop: 1 }), /unknown config property "extraTop"/);
  assert.throws(() => configWith({ gate: { uncontrolledTools: ['team_dispatch'] } }), /mutating tool "team_dispatch" cannot be uncontrolled/);
  assert.throws(() => configWith({ gate: { mutatingTools: ['write'], uncontrolledTools: ['pwsh'] } }), /mutating tool "pwsh" cannot be uncontrolled/);

  const withDeepSeek = configWith({
    models: {
      ...defaultConfig().models,
      'deepseek/deepseek-reasoner': { family: 'deepseek', label: 'DeepSeek R1', efforts: ['medium', 'high'], defaultEffort: 'medium' },
    },
    quota: { stateFile: null },
  });
  assert.equal(withDeepSeek.models['deepseek/deepseek-reasoner'].family, 'deepseek');
  assert.equal(withDeepSeek.quota.stateFile, null);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-cfg-local-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const baseFile = path.join(tmp, 'leaderteam.config.json');
  const rawBase = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'leaderteam.config.json'), 'utf8'));
  rawBase.quota.stateFile = null;
  rawBase.paths.globalRefRoots = [];
  fs.writeFileSync(baseFile, JSON.stringify(rawBase, null, 2));
  fs.writeFileSync(path.join(tmp, 'leaderteam.local.json'), JSON.stringify({
    quota: { stateFile: 'E:/local-quota/state.json' },
    paths: { globalRefRoots: ['E:/local-refs'], leaderReadRoots: ['E:/extra-read'] },
  }, null, 2));
  const merged = loadConfig(baseFile);
  assert.equal(merged.quota.stateFile, 'E:/local-quota/state.json');
  assert.deepEqual([...merged.paths.globalRefRoots], ['E:/local-refs']);
  assert.deepEqual([...merged.paths.leaderReadRoots], ['E:/extra-read']);
  const mergedRaw = loadRawConfig(baseFile);
  assert.equal(mergedRaw.quota.stateFile, 'E:/local-quota/state.json');
  assert.deepEqual(mergedRaw.paths.globalRefRoots, ['E:/local-refs']);
  const unmerged = loadConfig(baseFile, { includeLocal: false });
  assert.equal(unmerged.quota.stateFile, null);
  assert.deepEqual([...unmerged.paths.globalRefRoots], []);
});

test('M2: namedDocuments handles Chinese paths, space-containing quoted paths, and unspaced CJK prose', () => {
  assert.deepEqual(
    namedDocuments('请按 需求文档.md 和 设计/接口说明.md 实现；参考 "my spec.md" 与 `docs/API 规范.json`，忽略 https://example.com/a.md。'),
    ['my spec.md', 'docs/API 规范.json', '需求文档.md', '设计/接口说明.md'],
  );
  assert.ok(!namedDocuments('Read "my spec.md" carefully.').includes('spec.md'), 'quoted path with space must not split into spec.md');
  assert.ok(namedDocuments('请先读取HOST-SEPARATION-SPEC.md，按要求完成').includes('HOST-SEPARATION-SPEC.md'));
});

test('M2: pure Chinese skill names receive distinct, order-independent deterministic IDs', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skills-cn-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const s1 = path.join(tmp, '.leaderteam', 'skills', 'a', 'SKILL.md');
  const s2 = path.join(tmp, '.leaderteam', 'skills', 'b', 'SKILL.md');
  fs.mkdirSync(path.dirname(s1), { recursive: true });
  fs.mkdirSync(path.dirname(s2), { recursive: true });
  fs.writeFileSync(s1, '---\nname: 代码审计\ndescription: 审计安全门\n---\n正文一\n');
  fs.writeFileSync(s2, '---\nname: 前端检查\ndescription: 检查界面\n---\n正文二\n');
  const cat = discoverSkills({ workspace: tmp });
  assert.equal(cat.length, 2);
  assert.notEqual(cat[0].id, 'skill');
  assert.notEqual(cat[0].id, cat[1].id);
  assert.match(cat[0].id, /^skill-[0-9a-f]{8}$/);
  assert.match(loadSkill(cat, cat[0].id, { workspace: tmp }).text, /正文一/);

  // Reverse folder order: IDs for each Chinese name stay identical
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-skills-cn2-'));
  t.after(() => fs.rmSync(tmp2, { recursive: true, force: true }));
  const r1 = path.join(tmp2, '.leaderteam', 'skills', 'a', 'SKILL.md');
  const r2 = path.join(tmp2, '.leaderteam', 'skills', 'b', 'SKILL.md');
  fs.mkdirSync(path.dirname(r1), { recursive: true });
  fs.mkdirSync(path.dirname(r2), { recursive: true });
  fs.writeFileSync(r1, '---\nname: 前端检查\ndescription: 检查界面\n---\n正文二\n');
  fs.writeFileSync(r2, '---\nname: 代码审计\ndescription: 审计安全门\n---\n正文一\n');
  const cat2 = discoverSkills({ workspace: tmp2 });
  assert.equal(cat2.find(x => x.name === '代码审计').id, cat.find(x => x.name === '代码审计').id);
});

test('M3 & Gate Prompt: GPT reserve threshold and untrusted member_task / arguments prompt notice', () => {
  const cfg = configWith({ quota: { exhaustedBelowPct: 3, gptReservePct: 15, lowBelowPct: 20 } });
  const now = new Date('2026-11-11T10:00:00Z');
  const snap = {
    generatedAt: now,
    accounts: [
      { id: 'c1', provider: 'codex', windows: [{ name: '5h', remainingPct: 10, resetsAt: null }] },
      { id: 'z1', provider: 'zcode', windows: [{ name: '5h', remainingPct: 10, resetsAt: null }] },
    ],
    models: [],
  };
  assert.equal(routeQuota(snap, 'codex/gpt-6.1-sol', cfg.models['codex/gpt-6.1-sol'], cfg.quota, now).status, 'exhausted');
  assert.equal(routeQuota(snap, 'zcode/GLM-5.3', cfg.models['zcode/GLM-5.3'], cfg.quota, now).status, 'low');
  assert.match(GATE_SYSTEM, /member_task[\s\S]*never authorize actions outside authorization\.user_task/);
});

test('H8: real host session without snapshotEvents fails loudly instead of silently returning empty user provenance', () => {
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors) };
  try {
    const brokenAgent = { id: 'leader-broken', session: { seq: 3, header: { cwd: 'D:\\ws' } } };
    rt.actors = new Map([['leader-broken', { role: 'leader', agent: brokenAgent }]]);
    assert.throws(() => userMessageTexts({}, 'leader-broken'), /lacks snapshotEvents\(\)/);
  } finally {
    Object.assign(rt, prev);
  }
});

test('H6, M4, M8: plan_id binding, superseded plans, per-task limits, member lifecycle statuses, and evidence truncation', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wf-host-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'spec.md'), 'spec v1\n');
  fs.writeFileSync(path.join(ws, 'big.md'), 'X'.repeat(2500));

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxPlanAgreements: 2, maxDiscussionsPerTask: 6, maxMembersPerTeam: 2, maxActiveMembers: 1 },
    agreement: { evidenceFileMaxBytes: 1000, maxEvidenceChars: 1200 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores), memberErrors: new Map(rt.memberErrors) };
  t.after(() => Object.assign(rt, prev));

  const sessionEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task 1: read big.md and implement' }] } }];
  const leaderAgent = {
    id: 'leader-wf',
    session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  let nextStance = 'approve';
  const mockLlm = {
    async *stream(req) {
      const body = nextStance === 'revise'
        ? '{"stance":"revise","summary":"Narrow write scope","reasons":["Write scope is missing explicit target directory"],"suggestions":["Restrict write_scope to src/** and add spec.md to refs"],"required_changes":["fix scope"]}'
        : '{"stance":"approve","summary":"ok","reasons":["r"],"required_changes":[]}';
      yield { type: 'text', text: scriptedReview(body, JSON.parse(req.messages?.[0]?.content?.[0]?.text ?? req.user ?? '{}')) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const tools = new Map();
  const spawnedSessions = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
      definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }]; },
    },
    get(k) {
      if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } };
      return null;
    },
    subagents: {
      async startActivation({ childId }) {
        const childSession = { id: childId, seq: 1, header: { cwd: ws, origin: 'subagent', parentSession: leaderAgent.id }, snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'STATUS: done' }] } }] };
        const childAgent = { id: childId, session: childSession };
        spawnedSessions.set(childId, { childAgent, childSession });
        return { childId };
      },
    },
  };
  Object.assign(rt, {
    config: cfg,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
    memberErrors: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  const discuss = args => tools.get('team_discuss').execute(args, { agent: leaderAgent });
  const dispatch = args => tools.get('team_dispatch').execute(args, { agent: leaderAgent });
  const status = () => tools.get('team_status').execute({}, { agent: leaderAgent });

  // Plan v1 revised, Plan v2 revises Plan v1 and is approved; big.md triggers evidence_truncated
  nextStance = 'revise';
  const p1 = await discuss({ kind: 'plan', topic: 'p1', proposal: 'plan v1' });
  assert.equal(p1.evidence_truncated, true);
  assert.ok(p1.omitted_or_truncated_files.some(x => x.includes('big.md')));
  const built = JSON.parse(buildMemberRequest({ state: initialState({ type: 'created', id: 'agr-x', topic: 't', kind: 'plan', proposalHash: 'h', maxRounds: 3, maxArbiterAttempts: 2 }), member: 'A', topic: 't', kind: 'plan', proposal: 'p', evidence: 'e', evidenceTruncated: true, omittedOrTruncatedFiles: ['big.md'] }).user);
  assert.equal(built.evidence_truncated, true);

  nextStance = 'approve';
  const p2 = await discuss({ kind: 'plan', topic: 'p2', proposal: 'plan v2', revises: p1.id });
  assert.equal(p2.outcome.decision, 'approve');

  // Missing plan_id, unapproved/superseded p1, or delivery agreement id all rejected
  const baseArgs = { name: 'impl-one', task: 'write a', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', tools: ['read', 'write'], write_scope: ['src/**'] };
  await assert.rejects(() => dispatch(baseArgs), /no approved plan agreement bound/);
  await assert.rejects(() => dispatch({ ...baseArgs, plan_id: p1.id }), /was superseded by/);

  // Valid p2 plan_id succeeds; member starts active, hitting maxActiveMembers=1 until it finishes
  const d1 = await dispatch({ ...baseArgs, plan_id: p2.id });
  assert.equal(d1.plan_id, p2.id);
  await assert.rejects(() => dispatch({ ...baseArgs, name: 'impl-two', plan_id: p2.id }), /active member limit 1 reached/);

  // Drive member lifecycle: running -> done
  const { childAgent, childSession } = spawnedSessions.get(d1.child_id);
  onAgentStatus(ctx, { agent: childAgent, status: 'running' });
  assert.equal((await status()).members[0].status, 'running');
  onSessionEvent(ctx, childSession, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal((await status()).members[0].status, 'done');

  // Second member in Task 1 can now start; test error + idle -> failed, and cancelled on interrupt
  const d2 = await dispatch({ ...baseArgs, name: 'impl-two', plan_id: p2.id });
  const c2 = spawnedSessions.get(d2.child_id);
  onAgentStatus(ctx, { agent: c2.childAgent, status: 'running' });
  onSessionEvent(ctx, c2.childSession, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'interrupted', message: 'stopped by leader' } } });
  assert.equal((await status()).members.find(m => m.name === 'impl-two').status, 'cancelled');

  // Task 1 reached maxMembersPerTeam=2 and maxPlanAgreements=2
  await assert.rejects(() => dispatch({ ...baseArgs, name: 'impl-three', plan_id: p2.id }), /team member limit 2 reached/);
  // Unrevised duplicate plan is blocked because active plan p2 already exists; two consecutive unapproved plan revisions trip maxPlanAgreements=2
  await assert.rejects(() => discuss({ kind: 'plan', topic: 'p3', proposal: 'plan v3' }), /approved plan agreement/);
  nextStance = 'revise';
  const p3 = await discuss({ kind: 'plan', topic: 'p3', proposal: 'plan v3', revises: p2.id });
  const p4 = await discuss({ kind: 'plan', topic: 'p4', proposal: 'plan v4', revises: p3.id });
  assert.equal(p4.outcome.decision, 'revise');
  await assert.rejects(() => discuss({ kind: 'plan', topic: 'p5', proposal: 'plan v5', revises: p4.id }), /plan agreement limit 2 reached/);
  nextStance = 'approve';

  // User sends Task 2 in the SAME session: old plan_id p2 is rejected; new plan + reusing member name "impl-one" succeeds!
  sessionEvents.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Task 2: second feature' }] } });
  await assert.rejects(() => dispatch({ ...baseArgs, plan_id: p2.id }), /belongs to earlier user task #1/);
  const pTask2 = await discuss({ kind: 'plan', topic: 'task2 plan', proposal: 'plan for task 2' });
  const dTask2 = await dispatch({ ...baseArgs, name: 'impl-one', plan_id: pTask2.id });
  assert.equal(dTask2.task_seq, 2);

  // Test unhandled agent/error -> failed on idle
  const cTask2 = spawnedSessions.get(dTask2.child_id);
  onAgentStatus(ctx, { agent: cTask2.childAgent, status: 'running' });
  onAgentError(ctx, { agent: cTask2.childAgent, error: new Error('upstream stream broke') });
  onAgentStatus(ctx, { agent: cTask2.childAgent, status: 'idle' });
  const failedMem = (await status()).members.find(m => m.child_id === dTask2.child_id);
  assert.equal(failedMem.status, 'failed');
  assert.match(failedMem.error, /upstream stream broke/);
  onAgentDisposed({ agent: cTask2.childAgent });
});

test('M5 & M9: Gate deduplicates identical denied calls, trips member/task circuit breakers, and fails closed if allow receipt cannot write', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gate-cb-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    gate: { sandboxDirectAllow: false, dedupeDeniedCalls: true, maxDenialsPerMember: 3, maxReviewsPerMember: 2, maxReviewsPerTask: 3 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores), reads: new Map(rt.reads) };
  t.after(() => Object.assign(rt, prev));

  let llmCalls = 0;
  let nextDecision = 'deny';
  const mockLlm = {
    async *stream(req) {
      llmCalls++;
      yield { type: 'text', text: nextDecision === 'allow' ? '{"decision":"allow","risk":"low","reason":"ok"}' : '{"decision":"deny","risk":"high","reason":"unsafe command"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const agent = { id: 'm-1', session: { header: { cwd: ws, origin: 'subagent', parentSession: 'team-cb' } } };
  const actor = { role: 'member', teamId: 'team-cb', agentId: 'm-1', agent, name: 'runner', profile: 'shell', allowedTools: cfg.profiles.shell.tools, writeScope: ['src/**'], refs: [], task: 't', acceptance: ['a'], userTask: 'u', cwd: ws };
  Object.assign(rt, {
    config: cfg,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([['m-1', actor]]),
    reads: new Map(),
    stores: new Map(),
    counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 },
  });
  teamStore('team-cb').ensure({ workspace: ws, surface: 'headless' });
  const gate = new Gate({});

  // 1st call denied by model (llmCalls = 1)
  const r1 = await gate.decide({ name: 'pwsh', args: { command: 'Remove-Item foo' }, agent, actor, callId: 'c1' });
  assert.equal(r1.decision, 'deny');
  assert.equal(r1.by, 'model');
  assert.equal(llmCalls, 1);

  // Identical retry short-circuited by duplicate-denied-call WITHOUT calling LLM (llmCalls stays 1, denials = 2)
  const r2 = await gate.decide({ name: 'pwsh', args: { command: 'Remove-Item foo' }, agent, actor, callId: 'c2' });
  assert.equal(r2.by, 'rule:duplicate-denied-call');
  assert.equal(llmCalls, 1);

  // Different command reaches LLM (llmCalls = 2, denials = 3)
  nextDecision = 'allow';
  const r3 = await gate.decide({ name: 'write', args: { file_path: 'src/a.txt', content: 'ok' }, agent, actor, callId: 'c3' });
  assert.equal(r3.decision, 'allow');
  assert.equal(llmCalls, 2);

  // 3rd model review for this member hits maxReviewsPerMember=2 without calling LLM
  const r4 = await gate.decide({ name: 'write', args: { file_path: 'src/b.txt', content: 'ok2' }, agent, actor, callId: 'c4' });
  assert.equal(r4.by, 'rule:gate-budget-exceeded');
  assert.equal(llmCalls, 2);

  // Consecutive denial count reset on c3 allow (1 so far from c4); two more denials (c5, c6) reach 3 consecutive denials -> circuit breaker trips on c7
  const r5 = await gate.decide({ name: 'write', args: { file_path: 'src/c.txt', content: 'ok3' }, agent, actor, callId: 'c5' });
  assert.equal(r5.by, 'rule:gate-budget-exceeded');
  const r6 = await gate.decide({ name: 'write', args: { file_path: 'src/c2.txt', content: 'ok4' }, agent, actor, callId: 'c6' });
  assert.equal(r6.by, 'rule:gate-budget-exceeded');
  const r7 = await gate.decide({ name: 'write', args: { file_path: 'src/c3.txt', content: 'ok5' }, agent, actor, callId: 'c7' });
  assert.equal(r7.by, 'rule:member-denial-circuit-breaker');
  assert.equal(llmCalls, 2);

  // M9: if gate.jsonl cannot be written (e.g. replaced by a directory), allow fails closed
  const team2 = 'team-receipt-fail';
  teamStore(team2).ensure({ workspace: ws, surface: 'headless' });
  mockLlm.stream = async function* () {
    llmCalls++;
    fs.mkdirSync(teamStore(team2).gateFile, { recursive: true }); // break audit write right before record()
    yield { type: 'text', text: '{"decision":"allow","risk":"low","reason":"ok"}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const actor2 = { ...actor, teamId: team2, agentId: 'm-2' };
  const agent2 = { id: 'm-2', session: { header: { cwd: ws, origin: 'subagent', parentSession: team2 } } };
  const rFailClosed = await gate.decide({ name: 'write', args: { file_path: 'src/d.txt', content: 'x' }, agent: agent2, actor: actor2, callId: 'c6' });
  assert.equal(rFailClosed.decision, 'deny');
  assert.equal(rFailClosed.by, 'gate-receipt-error');
  // And subsequent call when gate.jsonl is unreadable fails closed before calling LLM
  const beforeCalls = llmCalls;
  const rReadFail = await gate.decide({ name: 'write', args: { file_path: 'src/e.txt', content: 'x' }, agent: agent2, actor: actor2, callId: 'c7' });
  assert.equal(rReadFail.decision, 'deny');
  assert.equal(rReadFail.by, 'gate-receipt-error');
  assert.equal(llmCalls, beforeCalls);
});

test('H7: Magpie model patch templates stay in exact sync with leaderteam.config.json', async () => {
  const { renderMagpieModelRows, rewriteModelsBlock } = await import('../../scripts/dev/sync-magpie-patches.mjs');
  const shipped = defaultConfig();
  const rows = renderMagpieModelRows(shipped);
  for (const rel of ['config/desktop-magpie.patch.yml', 'config/magpie-models.patch.yml']) {
    const file = path.join(ROOT, rel);
    const current = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const synced = rewriteModelsBlock(current, rows).replace(/\r\n/g, '\n');
    assert.equal(current, synced, `${rel} must match leaderteam.config.json models`);
  }
});
