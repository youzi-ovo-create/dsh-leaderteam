// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';

import {
  DEFAULT_SHELL_TOOLS,
  HOST_SHELL_CHANNEL_BROKEN_BY,
  HOST_SHELL_CHANNEL_BROKEN_RULE,
  HOST_SHELL_CHANNEL_UNAVAILABLE_REASON,
  WIN_STATUS_DLL_INIT_FAILED_INT32,
  WIN_STATUS_DLL_INIT_FAILED_UINT32,
  ShellChannelCircuitBreaker,
  isHostShellInitFailureResult,
  isShellInitFailureExitCode,
  ensureShellCircuitBreaker,
  recordShellToolResultForTeam,
  checkShellCircuitBreakerForTeam,
  resetShellCircuitBreakerForTeam,
} from '../../leaderteam/core/shell-circuit-breaker.mjs';
import { TeamStore } from '../../leaderteam/core/store.mjs';
import { runtime, runtimeForTeam } from '../../leaderteam/host/runtime.mjs';
import { ROOT, configWith } from './helpers.mjs';

const HOST_IMPORTS_KEY = Symbol.for('leaderteam.hostImports.v1');
globalThis[HOST_IMPORTS_KEY] = Object.freeze({
  moduleRoot: path.join(ROOT, 'leaderteam'),
  pluginRoot: path.join(ROOT, 'leaderteam'),
  anchor: import.meta.url,
  hook: null,
});

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools/package.json') {
      return {
        url: `data:application/json,${encodeURIComponent(JSON.stringify({ version: '0.2.2-rc.1' }))}`,
        format: 'json',
        shortCircuit: true,
      };
    }
    const stubs = {
      '@deepseek-ai/dsh-tools': [
        'export const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";',
        'export const defineTool = def => def;',
        'export class ToolsService {',
        '  view() { return { visible: new Map() }; }',
        '  resolve(agent) { this.view(agent); const admitted = true; return admitted; }',
        '  definitions() { return []; }',
        '  get() { return undefined; }',
        '  executable() { return undefined; }',
        '}',
      ].join('\n'),
      '@deepseek-ai/dsh-tools/pipeline': [
        'export class ToolExecutionPipeline {',
        '  constructor(ctx, source = {}) { this.ctx = ctx; this.source = source; }',
        '  resolveExecution(name, agent, nested, toolSet) { return this.source.get?.(name, agent, nested, toolSet); }',
        '  async dispatchToolBody(exec) {',
        '    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);',
        '    return await tool.execute(exec.arguments, exec);',
        '  }',
        '}',
      ].join('\n'),
      '@deepseek-ai/dsh-llm': [
        'export class BlockAssembler {}',
        'export const createUserMessage = m => ({ ...m, role: "user", id: "stub-msg" });',
      ].join('\n'),
    };
    if (Object.hasOwn(stubs, specifier)) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { Gate, installFinalGate } = await import('../../leaderteam/host/final-gate.mjs');
const { ToolExecutionPipeline } = await import('@deepseek-ai/dsh-tools/pipeline');
const { onToolResult, onSessionEvent } = await import('../../leaderteam/host/roles.mjs');
const entryCore = await import('../../leaderteam/entry-core.mjs');
hooks.deregister();

test('isHostShellInitFailureResult detects 0xC0000142, 3221225794, -1073741502, and STATUS_DLL_INIT_FAILED across DSH pwsh/bash shapes', () => {
  assert.equal(WIN_STATUS_DLL_INIT_FAILED_UINT32, 3221225794);
  assert.equal(WIN_STATUS_DLL_INIT_FAILED_INT32, -1073741502);
  assert.equal(isShellInitFailureExitCode(3221225794), true);
  assert.equal(isShellInitFailureExitCode(-1073741502), true);
  assert.equal(isShellInitFailureExitCode(1), false);
  assert.equal(isShellInitFailureExitCode(0), false);
  assert.equal(isShellInitFailureExitCode(-1), false);

  const dshForegroundUint32 = {
    isError: false,
    value: {
      kind: 'foreground',
      cwd: 'C:\\ws',
      exitCode: 3221225794,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false, enforcement: 'partial' },
    },
    content: [{ type: 'text', text: '(no output)\n[exit code: 3221225794]' }],
    meta: { cwd: 'C:\\ws' },
  };
  assert.equal(isHostShellInitFailureResult('pwsh', dshForegroundUint32), true);
  assert.equal(isHostShellInitFailureResult('bash', dshForegroundUint32), true);

  assert.equal(
    isHostShellInitFailureResult('pwsh', {
      isError: false,
      content: [{ type: 'text', text: '(no output)\n[exit code: 3221225794]' }],
    }),
    true,
  );
  assert.equal(
    isHostShellInitFailureResult('pwsh', {
      isError: false,
      content: [{ type: 'text', text: '(no output)\n[exit code: -1073741502]' }],
    }),
    true,
  );

  assert.equal(isHostShellInitFailureResult('pwsh', { meta: { exitCode: -1073741502 }, content: [] }), true);
  assert.equal(isHostShellInitFailureResult('bash', { exitCode: 3221225794 }), true);
  assert.equal(isHostShellInitFailureResult('pwsh', new Error('Process failed to initialize: 0xc0000142')), true);
  assert.equal(isHostShellInitFailureResult('pwsh', { isError: true, content: [{ type: 'text', text: 'Error: 0xC0000142 during startup' }] }), true);
  assert.equal(isHostShellInitFailureResult('bash', { isError: true, error: { message: 'child died with STATUS_DLL_INIT_FAILED' } }), true);
  assert.equal(isHostShellInitFailureResult('pwsh', 'Application Error: STATUS_DLL_INIT_FAILED'), true);

  const failingUnitTestResult = {
    isError: false,
    value: {
      kind: 'foreground',
      cwd: 'C:\\ws',
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120000,
      stdout: { text: '✖ should add numbers (2.1ms)\nℹ fail 1', truncated: false },
      stderr: { text: 'AssertionError [ERR_ASSERTION]: 1 !== 2', truncated: false },
    },
    content: [{ type: 'text', text: '✖ should add numbers (2.1ms)\nℹ fail 1\n[stderr]\nAssertionError [ERR_ASSERTION]: 1 !== 2\n[exit code: 1]' }],
  };
  assert.equal(isHostShellInitFailureResult('pwsh', failingUnitTestResult), false);
  assert.equal(isHostShellInitFailureResult('bash', failingUnitTestResult), false);
  assert.equal(isHostShellInitFailureResult('pwsh', '(no output)\n[exit code: 1]'), false);
  assert.equal(isHostShellInitFailureResult('pwsh', '(no output)\n[exit code: 2]'), false);
  assert.equal(isHostShellInitFailureResult('pwsh', '(no output)\n[exit code: 127]'), false);

  const passingTestSuitePrintingTokens = {
    isError: false,
    value: {
      kind: 'foreground',
      cwd: 'C:\\ws',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120000,
      stdout: { text: '✔ Detection of 0xC0000142, 3221225794, -1073741502, STATUS_DLL_INIT_FAILED', truncated: false },
      stderr: { text: '', truncated: false },
    },
    content: [{ type: 'text', text: '✔ Detection of 0xC0000142, 3221225794, -1073741502, STATUS_DLL_INIT_FAILED' }],
  };
  assert.equal(isHostShellInitFailureResult('pwsh', passingTestSuitePrintingTokens), false);
  assert.equal(isHostShellInitFailureResult('read', { content: [{ type: 'text', text: '0xC0000142 STATUS_DLL_INIT_FAILED' }] }), false);
  assert.equal(isHostShellInitFailureResult('write', { exitCode: 3221225794 }, DEFAULT_SHELL_TOOLS), false);
});

test('Gate + roles + entry-core: 2-strike trip per teamId, 0ms deterministic block across member/direct_exec/investigator/leader, team isolation, and user-turn reset', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-win-shell-cb-'));
  const cfgPath = path.join(tmp, 'leaderteam.config.json');
  const storeRoot = path.join(tmp, 'store');
  const wsA = path.join(tmp, 'ws-a');
  const wsB = path.join(tmp, 'ws-b');
  fs.mkdirSync(wsA, { recursive: true });
  fs.mkdirSync(wsB, { recursive: true });

  const cfg = configWith({
    storage: { root: storeRoot },
    team: { requirePlanAgreement: false, rollingPlanning: false },
    gate: { sandboxDirectAllow: true },
    plugins: { scheduler: false, consensus: false, timerArchive: false, panel: false },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
  });
  const rawCfg = JSON.parse(JSON.stringify(cfg));
  delete rawCfg.derived;
  fs.writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2), 'utf8');

  const rt = runtime();
  const prior = { ...rt };
  t.after(() => {
    try { rt.configWatch?.close?.(); } catch {}
    for (const k of Object.keys(rt)) delete rt[k];
    Object.assign(rt, prior);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let modelReviewCalls = 0;
  const eventsByTeam = new Map([
    ['team-a', []],
    ['team-b', []],
  ]);

  const makeLeaderAgent = (teamId, cwd) => ({
    id: teamId,
    session: {
      id: teamId,
      header: { id: teamId, cwd },
      snapshotEvents: () => eventsByTeam.get(teamId) ?? [],
    },
    ctx: {
      systemPrompt: {
        section: () => () => {},
        context: () => () => {},
      },
    },
    model: {
      recordedSelection: () => ({ provider: 'magpie', model: cfg.roles.leader.route }),
      current: () => ({ provider: 'magpie', model: cfg.roles.leader.route }),
      select: () => {},
    },
  });

  const ctx = {
    llm: {
      providers: () => [],
      chat: async () => {
        modelReviewCalls++;
        throw new Error('Gate model review should NEVER be invoked during 0ms shell circuit-breaker block');
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    agents: new Map(),
    tools: { register() { return () => {}; } },
    on() { return () => {}; },
    effect() { return () => {}; },
    provide() {},
    get(key) {
      if (key === 'agents') return this.agents;
      return null;
    },
  };

  entryCore.apply(ctx, { configPath: cfgPath, surface: 'headless', modular: true });
  assert.ok(rt.gate instanceof Gate);

  const storeA = new TeamStore(storeRoot, 'team-a');
  storeA.ensure({ workspace: wsA, surface: 'headless' });
  const storeB = new TeamStore(storeRoot, 'team-b');
  storeB.ensure({ workspace: wsB, surface: 'headless' });

  const leaderAgentA = makeLeaderAgent('team-a', wsA);
  const leaderAgentB = makeLeaderAgent('team-b', wsB);
  ctx.agents.set('team-a', leaderAgentA);
  ctx.agents.set('team-b', leaderAgentB);

  const makeActor = (id, role, teamId, cwd) => {
    const agent = {
      id,
      session: { id, header: { id, origin: role === 'leader' ? 'user' : 'subagent', parentSession: teamId, cwd }, snapshotEvents: () => [] },
      ctx: { systemPrompt: { section: () => () => {}, context: () => () => {} } },
    };
    const shellAllowed = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'bash'];
    const actor = {
      role,
      teamId,
      agentId: id,
      name: id,
      profile: role === 'leader' ? 'leader' : 'shell',
      allowedTools: role === 'leader' ? [...cfg.profiles.leader.tools] : shellAllowed,
      loadedTools: role === 'leader' ? [...cfg.profiles.leader.tools] : shellAllowed,
      writeScope: ['**'],
      refs: [],
      unreadRefs: [],
      task: 'Run verification',
      acceptance: ['Tests pass'],
      cwd,
      agent,
    };
    rt.actors.set(id, actor);
    return { actor, agent };
  };

  rt.actors.set('team-a', {
    role: 'leader',
    teamId: 'team-a',
    agentId: 'team-a',
    name: 'leader',
    profile: 'leader',
    allowedTools: [...cfg.profiles.leader.tools],
    loadedTools: [...cfg.profiles.leader.tools],
    writeScope: [],
    refs: [],
    cwd: wsA,
    agent: leaderAgentA,
  });
  rt.actors.set('team-b', {
    role: 'leader',
    teamId: 'team-b',
    agentId: 'team-b',
    name: 'leader',
    profile: 'leader',
    allowedTools: [...cfg.profiles.leader.tools],
    loadedTools: [...cfg.profiles.leader.tools],
    writeScope: [],
    refs: [],
    cwd: wsB,
    agent: leaderAgentB,
  });

  const memberA = makeActor('member-a1', 'member', 'team-a', wsA);
  const directExecA = makeActor('direct-a1', 'direct_exec', 'team-a', wsA);
  const investigatorA = makeActor('inv-a1', 'investigator', 'team-a', wsA);
  const memberB = makeActor('member-b1', 'member', 'team-b', wsB);

  for (let i = 0; i < 6; i++) {
    onToolResult(
      { name: 'pwsh', callId: `unit-fail-${i}`, arguments: { description: 'run test', command: 'node --test' }, agent: memberA.agent },
      { isError: false, value: { exitCode: 1, stdout: { text: 'FAIL' }, stderr: { text: '' } }, content: [{ type: 'text', text: 'FAIL\n[exit code: 1]' }] },
    );
  }
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), false);

  const dllFailResult1 = {
    isError: false,
    value: { exitCode: 3221225794, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } },
    content: [{ type: 'text', text: '(no output)\n[exit code: 3221225794]' }],
  };
  onToolResult(
    { name: 'pwsh', callId: 'init-fail-1', arguments: { description: 'probe 1', command: 'node -v' }, agent: memberA.agent },
    dllFailResult1,
  );
  recordShellToolResultForTeam(rt, 'team-a', 'pwsh', dllFailResult1, { callId: 'init-fail-1', actorRole: 'member' });
  assert.equal(ensureShellCircuitBreaker(rt).getTeamState('team-a').failures, 1);
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), false);

  const secondAllow = await rt.gate.decide({
    name: 'pwsh',
    args: { description: 'probe 2', command: 'node --version' },
    toolDescription: 'Execute PowerShell',
    agent: memberA.agent,
    actor: memberA.actor,
    callId: 'init-fail-2',
  });
  assert.equal(secondAllow.decision, 'allow');

  onToolResult(
    { name: 'pwsh', callId: 'init-fail-2', arguments: { description: 'probe 2', command: 'node --version' }, agent: directExecA.agent },
    {
      isError: false,
      content: [{ type: 'text', text: '(no output)\n[exit code: -1073741502]' }],
    },
  );
  assert.equal(ensureShellCircuitBreaker(rt).getTeamState('team-a').failures, 2);
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), true);
  assert.equal(
    checkShellCircuitBreakerForTeam(runtimeForTeam('team-a'), 'team-a', 'pwsh')?.rule,
    HOST_SHELL_CHANNEL_BROKEN_RULE,
  );

  for (const [label, entry, shTool] of [
    ['member pwsh', memberA, 'pwsh'],
    ['member bash', memberA, 'bash'],
    ['direct_exec pwsh', directExecA, 'pwsh'],
    ['investigator pwsh', investigatorA, 'pwsh'],
    ['leader pwsh', { actor: rt.actors.get('team-a'), agent: leaderAgentA }, 'pwsh'],
  ]) {
    const t0 = performance.now();
    const verdict = await rt.gate.decide({
      name: shTool,
      args: { description: 'blocked retry', command: 'node --version' },
      toolDescription: 'Execute shell',
      agent: entry.agent,
      actor: entry.actor,
      callId: `blocked-${label}`,
    });
    const elapsedMs = performance.now() - t0;
    assert.equal(verdict.decision, 'deny', `${label} must be denied`);
    assert.equal(verdict.by, HOST_SHELL_CHANNEL_BROKEN_BY, `${label} must report exact rule`);
    assert.equal(verdict.reason, HOST_SHELL_CHANNEL_UNAVAILABLE_REASON, `${label} must report exact diagnostic reason`);
    assert.ok(elapsedMs < 2000, `${label} must be synchronous/0ms deterministic (took ${elapsedMs.toFixed(2)}ms)`);
  }
  assert.equal(modelReviewCalls, 0, 'zero LLM safety-gate calls allowed when shell breaker is tripped');

  const staticWriteVerdict = await rt.gate.decide({
    name: 'write',
    args: { file_path: 'notes.txt', content: 'static deliverable' },
    toolDescription: 'Write file',
    agent: memberA.agent,
    actor: memberA.actor,
    callId: 'static-write-1',
  });
  assert.equal(staticWriteVerdict.decision, 'allow');

  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-b'), false);
  const teamBVerdict = await rt.gate.decide({
    name: 'pwsh',
    args: { description: 'team B shell', command: 'node --version' },
    toolDescription: 'Execute PowerShell',
    agent: memberB.agent,
    actor: memberB.actor,
    callId: 'team-b-pwsh-1',
  });
  assert.equal(teamBVerdict.decision, 'allow');

  eventsByTeam.get('team-a').push({
    type: 'user/message',
    time: Date.now(),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `允许读取 ${wsB}` }] },
  });
  onSessionEvent(ctx, leaderAgentA.session, eventsByTeam.get('team-a').at(-1));
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), true);

  eventsByTeam.get('team-a').push({
    type: 'user/message',
    time: Date.now() + 10,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'I switched to interactive desktop, please re-run tests.' }] },
  });
  onSessionEvent(ctx, leaderAgentA.session, eventsByTeam.get('team-a').at(-1));
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), false);
  assert.equal(ensureShellCircuitBreaker(rt).getTeamState('team-a').failures, 0);

  const postResetVerdict = await rt.gate.decide({
    name: 'pwsh',
    args: { description: 'post-reset shell', command: 'node --version' },
    toolDescription: 'Execute PowerShell',
    agent: memberA.agent,
    actor: memberA.actor,
    callId: 'post-reset-pwsh-1',
  });
  assert.equal(postResetVerdict.decision, 'allow');

  installFinalGate(['0.2.2-rc.1']);
  let toolBodyExecutions = 0;
  const pipeline = new ToolExecutionPipeline(ctx, {
    get: name => ({
      name,
      description: 'Execute PowerShell',
      async execute() {
        toolBodyExecutions++;
        return {
          isError: false,
          value: { exitCode: 3221225794, stdout: { text: '' }, stderr: { text: '' } },
          content: [{ type: 'text', text: '(no output)\n[exit code: 3221225794]' }],
        };
      },
    }),
  });

  await pipeline.dispatchToolBody({
    name: 'pwsh',
    arguments: { description: 'p1', command: 'node -v' },
    agent: memberA.agent,
    callId: 'pipe-1',
  });
  await pipeline.dispatchToolBody({
    name: 'pwsh',
    arguments: { description: 'p2', command: 'node -v' },
    agent: directExecA.agent,
    callId: 'pipe-2',
  });
  assert.equal(toolBodyExecutions, 2);
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), true);

  const thirdPipeRes = await pipeline.dispatchToolBody({
    name: 'pwsh',
    arguments: { description: 'p3', command: 'node -v' },
    agent: memberA.agent,
    callId: 'pipe-3',
  });
  assert.equal(toolBodyExecutions, 2, '3rd call must be blocked before tool.execute');
  assert.equal(thirdPipeRes.isError, true);
  assert.match(thirdPipeRes.error.message, /rule:host-shell-channel-broken/);
  assert.ok(thirdPipeRes.error.message.includes(HOST_SHELL_CHANNEL_UNAVAILABLE_REASON));

  assert.equal(resetShellCircuitBreakerForTeam(rt, 'team-a'), true);
  assert.equal(ensureShellCircuitBreaker(rt).isTripped('team-a'), false);
});

test('ShellChannelCircuitBreaker standalone class: threshold, deduplication, and reset semantics', () => {
  const cb = new ShellChannelCircuitBreaker();
  assert.equal(cb.checkGate('t1', 'pwsh'), undefined);

  const r1 = cb.recordResult('t1', 'pwsh', '0xC0000142', { callId: 'c1', actorRole: 'member' });
  assert.equal(r1.matched, true);
  assert.equal(r1.failures, 1);
  assert.equal(r1.tripped, false);
  assert.equal(cb.checkGate('t1', 'pwsh'), undefined);

  const rNonMatch = cb.recordResult('t1', 'pwsh', '(no output)\n[exit code: 1]', { callId: 'c-ok-fail' });
  assert.equal(rNonMatch.matched, false);
  assert.equal(rNonMatch.failures, 1);
  assert.equal(rNonMatch.tripped, false);

  const r2 = cb.recordResult('t1', 'bash', 'STATUS_DLL_INIT_FAILED', { callId: 'c2', actorRole: 'direct_exec' });
  assert.equal(r2.matched, true);
  assert.equal(r2.failures, 2);
  assert.equal(r2.tripped, true);
  assert.equal(r2.newlyTripped, true);

  assert.deepEqual(cb.decide('t1', 'pwsh'), {
    decision: 'deny',
    by: HOST_SHELL_CHANNEL_BROKEN_BY,
    reason: HOST_SHELL_CHANNEL_UNAVAILABLE_REASON,
  });
  assert.equal(cb.decide('t1', 'read'), null);
  assert.equal(cb.decide('t2', 'pwsh'), null);

  cb.resetAll();
  assert.equal(cb.isTripped('t1'), false);
});
