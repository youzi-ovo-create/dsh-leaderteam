import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { evaluateHardRules } from '../../leaderteam/core/gate-policy.mjs';
import { runtime, teamStore } from '../../leaderteam/host/runtime.mjs';
import { ROOT, configWith } from './helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: `virtual:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual:@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";',
      };
    }
    if (url === 'virtual:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'export class ToolExecutionPipeline {',
          '  resolveExecution(name, agent, hasParent, toolSet) { return this._resolve ? this._resolve(name, agent, hasParent, toolSet) : { execute: async (args, exec) => ({ content: [{ type: "text", text: "ok" }], args }) }; }',
          '  async dispatchToolBody(exec) {',
          '    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);',
          '    return await tool.execute(exec.arguments, exec);',
          '  }',
          '}',
        ].join('\n'),
      };
    }
    if (url === 'virtual:@deepseek-ai/dsh-tools/package.json') {
      return {
        format: 'json',
        shortCircuit: true,
        source: JSON.stringify({ version: '0.1.5' }),
      };
    }
    if (url === 'virtual:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'export class BlockAssembler {',
          '  constructor() { this._blocks = []; }',
          '  push(c) { if (c.type === "text") this._blocks.push(c); }',
          '  blocks() { return this._blocks; }',
          '}',
        ].join('\n'),
      };
    }
    return nextLoad(url, context);
  },
});

const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { Gate, installFinalGate } = await import('../../leaderteam/host/final-gate.mjs');
const { ToolExecutionPipeline } = await import('@deepseek-ai/dsh-tools/pipeline');

function makeFixture(t) {
  const workRoot = path.join(ROOT, 'test-work');
  fs.mkdirSync(workRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(workRoot, 'unit-alias-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  const ws = path.join(dir, 'ws');
  const globalRefs = path.join(dir, 'global-refs');
  const external = path.join(dir, 'external');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.leaderteam', 'refs'), { recursive: true });
  fs.mkdirSync(globalRefs, { recursive: true });
  fs.mkdirSync(external, { recursive: true });

  fs.writeFileSync(path.join(ws, 'spec.md'), 'workspace spec\n');
  fs.writeFileSync(path.join(ws, 'src', 'ok.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(ws, 'docs', 'guide.md'), 'guide\n');
  fs.writeFileSync(path.join(globalRefs, 'GLOBAL.md'), 'global ref\n');
  fs.writeFileSync(path.join(external, 'outside.txt'), 'synthetic outside text\n');

  // Junctions inside ws/src pointing to restricted targets
  fs.symlinkSync(globalRefs, path.join(ws, 'src', 'alias-global'), 'junction');
  fs.symlinkSync(external, path.join(ws, 'src', 'alias-ext'), 'junction');
  fs.symlinkSync(path.join(ws, 'docs'), path.join(ws, 'src', 'alias-docs'), 'junction');
  fs.symlinkSync(path.join(ws, '.leaderteam'), path.join(ws, 'src', 'alias-prot'), 'junction');
  // Junction inside .leaderteam/refs pointing outside refs
  fs.symlinkSync(external, path.join(ws, '.leaderteam', 'refs', 'alias-ext'), 'junction');
  // Junction inside globalRefs pointing to external
  fs.symlinkSync(external, path.join(globalRefs, 'alias-ext'), 'junction');
  // Workspace root alias pointing to ws
  const wsAlias = path.join(dir, 'ws-alias');
  fs.symlinkSync(ws, wsAlias, 'junction');

  const cfg = configWith({
    paths: { globalRefRoots: [globalRefs], projectRefsDir: '.leaderteam/refs', protectedDirs: ['.leaderteam'] },
    quota: { stateFile: path.join(ROOT, 'test/fixtures/quota-state.json'), allowUnknown: true },
    storage: { root: path.join(dir, 'store') },
  });
  return { dir, ws, wsAlias, globalRefs, external, cfg };
}

test('issue 1: write/edit through junctions to global refs, outside workspace, outside writeScope, and protected dirs are rejected; aliased workspace root is allowed', async t => {
  const { ws, wsAlias, cfg } = makeFixture(t);
  const member = { role: 'member', name: 'impl', profile: 'code', allowedTools: cfg.profiles.code.tools, writeScope: ['src/**'], unreadRefs: [] };
  const leader = { role: 'leader', name: 'leader', profile: 'leader', allowedTools: cfg.profiles.leader.tools, writeScope: [], unreadRefs: [] };

  await t.test('junction to globalRefRoots rejected as path-in-global-refs', () => {
    assert.equal(
      evaluateHardRules({ tool: 'write', args: { file_path: 'src/alias-global/proof.txt' }, actor: member, cwd: ws }, cfg)?.rule,
      'path-in-global-refs'
    );
  });
  await t.test('junction outside workspace rejected as path-outside-workspace', () => {
    assert.equal(
      evaluateHardRules({ tool: 'write', args: { file_path: 'src/alias-ext/proof.txt' }, actor: member, cwd: ws }, cfg)?.rule,
      'path-outside-workspace'
    );
  });
  await t.test('junction outside writeScope rejected as path-outside-write-scope', () => {
    assert.equal(
      evaluateHardRules({ tool: 'write', args: { file_path: 'src/alias-docs/proof.txt' }, actor: member, cwd: ws }, cfg)?.rule,
      'path-outside-write-scope'
    );
  });
  await t.test('junction to protectedDirs rejected as path-protected', () => {
    assert.equal(
      evaluateHardRules({ tool: 'write', args: { file_path: 'src/alias-prot/state.json' }, actor: member, cwd: ws }, cfg)?.rule,
      'path-protected'
    );
  });
  await t.test('team_note through junction rejected as note-outside-refs', () => {
    assert.equal(
      evaluateHardRules({ tool: 'team_note', args: { path: 'alias-ext/note.md' }, actor: leader, cwd: ws }, cfg)?.rule,
      'note-outside-refs'
    );
  });
  await t.test('aliased workspace root itself is not falsely rejected', () => {
    assert.equal(
      evaluateHardRules({ tool: 'write', args: { file_path: 'src/ok.ts' }, actor: member, cwd: wsAlias }, cfg),
      undefined
    );
  });
});

test('issue 2: member read/read_image/glob/grep are confined to workspace and globalRefRoots (both lexical and realpath); leader keeps existing contract', async t => {
  const { ws, globalRefs, external, cfg } = makeFixture(t);
  const member = { role: 'member', name: 'scout', profile: 'readonly', allowedTools: cfg.profiles.readonly.tools, writeScope: [], unreadRefs: [] };
  const leader = { role: 'leader', name: 'leader', profile: 'leader', allowedTools: cfg.profiles.leader.tools, writeScope: [], unreadRefs: [] };

  await t.test('member external read and read_image rejected (direct and via junction)', () => {
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: path.join(external, 'outside.txt') }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: 'src/alias-ext/outside.txt' }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: path.join(globalRefs, 'alias-ext', 'outside.txt') }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
    assert.equal(evaluateHardRules({ tool: 'read_image', args: { file_path: path.join(external, 'outside.png') }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
  });
  await t.test('member external grep and glob rejected (direct and via junction)', () => {
    assert.equal(evaluateHardRules({ tool: 'grep', args: { pattern: 'synthetic', path: external }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
    assert.equal(evaluateHardRules({ tool: 'grep', args: { pattern: 'synthetic', path: 'src/alias-ext' }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
    assert.equal(evaluateHardRules({ tool: 'glob', args: { pattern: '*.txt', path: external }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
    assert.equal(evaluateHardRules({ tool: 'glob', args: { pattern: '*.txt', path: 'src/alias-ext' }, actor: member, cwd: ws }, cfg)?.rule, 'path-outside-workspace');
  });
  await t.test('member workspace and globalRefRoots read/grep/glob allowed; leader outside read needs a user grant', () => {
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: 'spec.md' }, actor: member, cwd: ws }, cfg), undefined);
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: path.join(globalRefs, 'GLOBAL.md') }, actor: member, cwd: ws }, cfg), undefined);
    assert.equal(evaluateHardRules({ tool: 'grep', args: { pattern: 'global', path: globalRefs }, actor: member, cwd: ws }, cfg), undefined);
    assert.equal(evaluateHardRules({ tool: 'grep', args: { pattern: 'workspace' }, actor: member, cwd: ws }, cfg), undefined);
    assert.equal(evaluateHardRules({ tool: 'glob', args: { pattern: '**/*.md' }, actor: member, cwd: ws }, cfg), undefined);
    // 2026-11-10 owner decision: the leader no longer reads everywhere; outside its standing roots it must ask the user.
    const outside = { tool: 'read', args: { file_path: path.join(external, 'outside.txt') }, actor: leader, cwd: ws };
    assert.equal(evaluateHardRules(outside, cfg)?.rule, 'path-outside-read-roots');
    assert.equal(evaluateHardRules({ ...outside, userTexts: [`please continue\n允许读取 ${external}`] }, cfg), undefined);
    assert.equal(evaluateHardRules({ ...outside, userTexts: () => [`不允许读取 ${external}`] }, cfg)?.rule, 'path-outside-read-roots');
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: 'spec.md' }, actor: leader, cwd: ws }, cfg), undefined);
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: path.join(globalRefs, 'GLOBAL.md') }, actor: leader, cwd: ws }, cfg), undefined);
    // a grant covers the real location only: a junction inside the granted folder that points elsewhere is still refused
    assert.equal(evaluateHardRules({ tool: 'read', args: { file_path: path.join(globalRefs, 'alias-ext', 'outside.txt') }, actor: leader, cwd: ws }, cfg)?.rule, 'path-outside-read-roots');
  });
});

test('issue 1 & 2 host tools: team_dispatch rejects external or junction-escaped refs and accepts workspace/global refs; team_note rejects junction escape in execute', async t => {
  const { dir, ws, globalRefs, external, cfg } = makeFixture(t);
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => { Object.assign(rt, prev); });

  const tools = new Map();
  const leaderAgent = { id: 'leader-1', session: { header: { cwd: ws } }, model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) } };
  const ctx = {
    effect(fn) { return fn(); },
    tools: { register(def) { tools.set(def.name, def); }, definitions() { return [{ name: 'read', description: 'Read a file' }]; } },
    get(k) { if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } }; return null; },
    subagents: { async startActivation({ childId }) { return { childId }; } },
  };
  Object.assign(rt, {
    config: cfg,
    storageRoot: path.join(dir, 'store'),
    llm: {},
    surface: 'headless',
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  const dispatchTool = tools.get('team_dispatch');
  const noteTool = tools.get('team_note');
  const baseDispatch = {
    name: 'scout-a',
    task: 'read refs',
    acceptance: ['done'],
    model: 'zcode/GLM-5.3',
    effort: 'high',
    profile: 'readonly',
    tools: ['read'],
  };

  await assert.rejects(
    () => dispatchTool.execute({ ...baseDispatch, refs: [path.join(external, 'outside.txt')] }, { agent: leaderAgent }),
    /ref must be inside the workspace or a global reference root/
  );
  await assert.rejects(
    () => dispatchTool.execute({ ...baseDispatch, refs: ['src/alias-ext/outside.txt'] }, { agent: leaderAgent }),
    /ref must be inside the workspace or a global reference root/
  );
  await assert.rejects(
    () => dispatchTool.execute({ ...baseDispatch, refs: [path.join(globalRefs, 'alias-ext', 'outside.txt')] }, { agent: leaderAgent }),
    /ref must be inside the workspace or a global reference root/
  );

  const ok = await dispatchTool.execute(
    { ...baseDispatch, refs: ['spec.md', path.join(globalRefs, 'GLOBAL.md')] },
    { agent: leaderAgent }
  );
  assert.equal(ok.member, 'scout-a');
  assert.equal(ok.refs.length, 2);

  await assert.rejects(
    () => noteTool.execute({ path: 'alias-ext/escaped.md', content: 'nope' }, { agent: leaderAgent }),
    /path must stay inside/
  );
  assert.equal(fs.existsSync(path.join(external, 'escaped.md')), false);
});

test('issue 1 final-gate: deterministic hard rules are re-evaluated after async LLM review without calling the LLM twice', async t => {
  const { dir, ws, external, cfg } = makeFixture(t);
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores), reads: new Map(rt.reads) };
  t.after(() => { Object.assign(rt, prev); });

  const swapDir = path.join(ws, 'src', 'swap');
  fs.mkdirSync(swapDir, { recursive: true });

  let llmCalls = 0;
  const mockLlm = {
    async *stream() {
      llmCalls++;
      // Simulate path replacement during the async review window
      fs.rmSync(swapDir, { recursive: true, force: true });
      fs.symlinkSync(external, swapDir, 'junction');
      yield { type: 'text', text: '{"decision":"allow","risk":"low","reason":"looked safe before swap"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const memberAgent = { id: 'member-1', session: { header: { cwd: ws, origin: 'subagent', parentSession: 'leader-1' } } };
  const actor = {
    role: 'member',
    teamId: 'leader-1',
    agentId: memberAgent.id,
    agent: memberAgent,
    name: 'impl',
    profile: 'code',
    allowedTools: cfg.profiles.code.tools,
    writeScope: ['src/**'],
    refs: [],
    task: 'write file',
    acceptance: ['ok'],
    userTask: 'write file',
    cwd: ws,
  };
  const { derived: _derived, ...rawCfg } = cfg;
  Object.assign(rt, {
    config: configWith({ ...rawCfg, gate: { ...rawCfg.gate, sandboxDirectAllow: false } }),
    storageRoot: path.join(dir, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([[memberAgent.id, actor]]),
    reads: new Map(),
    stores: new Map(),
    counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 },
  });
  teamStore('leader-1').ensure({ workspace: ws, surface: 'headless' });

  const gate = new Gate({});
  rt.gate = gate;
  installFinalGate(['0.1.5']);

  let executedWith = null;
  const pipeline = new ToolExecutionPipeline();
  pipeline._resolve = () => ({
    async execute(args) {
      executedWith = args;
      return { content: [{ type: 'text', text: 'executed' }] };
    },
  });
  const rawArgs = { file_path: 'src/swap/pwn.txt', content: 'x' };
  const exec = {
    name: 'write',
    arguments: rawArgs,
    agent: memberAgent,
    callId: 'call-1',
  };
  const res = await pipeline.dispatchToolBody(exec);
  assert.equal(llmCalls, 1, 'LLM reviewer called once');
  assert.equal(executedWith, null, 'tool body must not execute when post-review hard rule denies');
  assert.equal(res.isError, true, 'post-review hard rule check must deny after path swap');
  assert.match(res.error.message, /rule:path-outside-workspace/);

  // Verify frozen argument copy and identity binding when allowed
  const okArgs = { file_path: 'src/ok.ts', content: 'original' };
  mockLlm.stream = async function* () {
    llmCalls++;
    okArgs.file_path = 'src/alias-ext/tampered.txt';
    yield { type: 'text', text: '{"decision":"allow","risk":"low","reason":"ok"}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const okExec = { name: 'write', arguments: okArgs, agent: memberAgent, callId: 'call-2' };
  const okRes = await pipeline.dispatchToolBody(okExec);
  assert.equal(okRes.isError, undefined);
  assert.equal(Object.isFrozen(executedWith), true, 'tool receives frozen argument copy');
  assert.equal(executedWith.file_path, 'src/ok.ts', 'mutating caller args during review does not affect executed args');

  // Verify identity binding rejection when exec.agent is swapped during review
  executedWith = null;
  const bindExec = { name: 'write', arguments: { file_path: 'src/ok.ts', content: 'x' }, agent: memberAgent, callId: 'call-3' };
  mockLlm.stream = async function* () {
    llmCalls++;
    bindExec.agent = { id: 'other-agent' };
    yield { type: 'text', text: '{"decision":"allow","risk":"low","reason":"ok"}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const bindRes = await pipeline.dispatchToolBody(bindExec);
  assert.equal(executedWith, null);
  assert.equal(bindRes.isError, true);
  assert.match(bindRes.error.message, /\(binding\)/);
});

test('LeaderTeam model calls report token usage, summed over retries', async () => {
  const { callJson, addUsage } = await import('../../leaderteam/host/llm.mjs');
  assert.deepEqual(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4, reasoningTokens: 5 }), { inputTokens: 4, outputTokens: 6, reasoningTokens: 5 });
  assert.equal(addUsage(undefined, undefined), undefined);
  let n = 0;
  const llm = {
    async *stream() {
      n++;
      yield { type: 'text', text: n === 1 ? 'not json' : '{"decision":"allow","risk":"low","reason":"ok"}' };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 * n, totalTokens: 100 + 10 * n } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const { parseGateVerdict } = await import('../../leaderteam/core/gate-policy.mjs');
  const r = await callJson(llm, { provider: 'p', model: 'm', timeoutMs: 5000, system: 's', user: 'u' }, parseGateVerdict, 1);
  assert.equal(r.ok, true); assert.equal(r.attempts, 2);
  assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 30, totalTokens: 230 }, 'both attempts are counted');
});

test('2026-11-11 leader read grants: the live gate takes them from the user\'s own messages in the leader session', t => {
  const { dir, ws, external, cfg } = makeFixture(t);
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores), reads: new Map(rt.reads) };
  t.after(() => { Object.assign(rt, prev); });

  const events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'summarise the outside note' }] } }];
  let snapshots = 0;
  const agent = { id: 'leader-grant', session: { header: { cwd: ws }, snapshotEvents: () => { snapshots++; return events; } } };
  const actor = { role: 'leader', teamId: agent.id, agentId: agent.id, agent, name: 'leader', profile: 'leader', allowedTools: cfg.profiles.leader.tools, loadedTools: cfg.profiles.leader.tools, skills: [], writeScope: [], refs: [], cwd: ws };
  Object.assign(rt, { config: cfg, storageRoot: path.join(dir, 'store'), surface: 'headless', actors: new Map([[agent.id, actor]]), reads: new Map(), stores: new Map() });
  const gate = new Gate({});
  const outside = { name: 'read', args: { file_path: path.join(external, 'outside.txt') }, agent, actor };

  assert.equal(gate.checkHardRules({ name: 'read', args: { file_path: 'spec.md' }, agent, actor }), undefined);
  assert.equal(snapshots, 0, 'reads inside the workspace never look at the conversation');
  assert.equal(gate.checkHardRules(outside)?.rule, 'path-outside-read-roots');

  // text that did not come from the user is never a grant: agent notifications, tool output, the leader's own words
  events.push({ type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: `允许读取 ${external}` }] } });
  events.push({ type: 'assistant/message', data: { content: [{ type: 'text', text: `允许读取 ${external}` }] } });
  assert.equal(gate.checkHardRules(outside)?.rule, 'path-outside-read-roots');

  events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `好的\n允许读取 ${external}` }] } });
  assert.equal(gate.checkHardRules(outside), undefined);
  assert.equal(gate.checkHardRules({ name: 'read', args: { file_path: path.join(dir, 'store', 'x.json') }, agent, actor })?.rule, 'path-outside-read-roots', 'the grant covers only the named folder');
});
