import { scriptedReview } from '../scripted-review.mjs';
// Adversarial Rationality Experiments (`合理性对抗实验`):
// Verifies that hard limits, circuit breakers, and governance rules do NOT choke legitimate, desirable
// multi-phase/converging/high-fanout engineering workflows—while still strictly blocking actual abuse,
// infinite thrashing, bare lazy refusals, and unanimously unsafe proposals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-rat:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-rat:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-rat:@deepseek-ai/dsh-tools/pipeline') {
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
    if (url === 'virtual-rat:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    }
    if (url === 'virtual-rat:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler { constructor() { this._b = []; } push(c) { if (c.type === "text") this._b.push(c); } blocks() { return this._b; } }',
      };
    }
    return nextLoad(url, context);
  },
});

const { configWith } = await import('./helpers.mjs');
const { runtime, teamStore } = await import('../../leaderteam/host/runtime.mjs');
const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { onSessionEvent } = await import('../../leaderteam/host/roles.mjs');
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');
const { parseMemberOpinion } = await import('../../leaderteam/core/agreement.mjs');
const { canonicalRouteFor, resolveModelTarget } = await import('../../leaderteam/core/upstream-models.mjs');
const { pathKey } = await import('../../leaderteam/core/paths.mjs');

function setupTeamHarness(t, cfgOverrides = {}, taskText = 'Implement multi-phase subsystem per SPEC.md.') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rationality-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'store');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'SPEC.md'), '# SPEC\nPhase 1 + Phase 2 requirements.\n');

  const cfg = configWith({
    storage: { root: storageRoot },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt:true },
    ...cfgOverrides,
  });
  const rt = runtime();
  const savedRt = {
    ...rt,
    actors: new Map(rt.actors),
    stores: new Map(rt.stores),
    reads: new Map(rt.reads),
    memberErrors: new Map(rt.memberErrors),
    plugins: { ...(rt.plugins ?? {}) },
  };
  t.after(() => Object.assign(rt, savedRt));

  const sessionEvents = [{
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: taskText }] },
  }];
  const leaderAgent = {
    id: `leader-${Math.random().toString(36).slice(2, 8)}`,
    session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };

  let respondFn = () => '{"stance":"approve","summary":"ok","reasons":["meets spec"],"required_changes":[]}';
  const mockLlm = {
    async *stream(req) {
      const body = await respondFn(req);
      yield { type: 'text', text: JSON.stringify(scriptedReview(typeof body === 'string' ? JSON.parse(body) : body, JSON.parse(req.messages?.[0]?.content?.[0]?.text ?? req.user ?? '{}'))) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const tools = new Map();
  const spawned = new Map();
  const ctx = {
    llm: mockLlm,
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
      definitions() {
        return [
          { name: 'read', description: 'read' },
          { name: 'write', description: 'write' },
          { name: 'edit', description: 'edit' },
          { name: 'pwsh', description: 'pwsh' },
        ];
      },
    },
    get(k) {
      if (k === 'agentPresets') {
        return {
          presetForSession: () => cfg.profiles.leader.preset,
          async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; },
        };
      }
      return null;
    },
    subagents: {
      async startActivation({ childId }) {
        const childSession = {
          id: childId,
          seq: 1,
          header: { cwd: ws, origin: 'subagent', parentSession: leaderAgent.id },
          snapshotEvents: () => [
            { type: 'turn/start', data: { turn: 1 } },
            { type: 'assistant/message', data: { content: [{ type: 'text', text: 'STATUS: done' }] } },
          ],
        };
        const childAgent = { id: childId, session: childSession };
        spawned.set(childId, { childAgent, childSession });
        return { childId };
      },
    },
  };

  Object.assign(rt, {
    config: cfg,
    configPath: null,
    cordisCompositionMode: false,
    storageRoot,
    llm: mockLlm,
    surface: 'headless',
    planArchiveStore: null,
    actors: new Map([[
      leaderAgent.id,
      { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools },
    ]]),
    stores: new Map(),
    reads: new Map(),
    memberErrors: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  return {
    ws,
    storageRoot,
    cfg,
    rt,
    ctx,
    leaderAgent,
    tools,
    spawned,
    setResponder(fn) { respondFn = fn; },
    callTool: (name, args = {}) => tools.get(name).execute(args, { agent: leaderAgent }),
    completeMember(childId) {
      const entry = spawned.get(childId);
      onSessionEvent(ctx, entry.childSession, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });
    },
  };
}

test('[Rationality R1] maxPlanAgreements=4 admits >4 reasonable multi-phase post-execution plan amendments while blocking unanchored spam', async t => {
  // Part A: Legitimate 6-call multi-phase engineering workflow with maxPlanAgreements = 4
  {
    const h = setupTeamHarness(t, {
      team: { maxPlanAgreements: 4, maxDiscussionsPerTask: 8, maxMembersPerTeam: 8, maxActiveMembers: 4 },
    });
    let stance = 'revise';
    h.setResponder(() => stance === 'revise'
      ? {
        stance: 'revise',
        summary: 'Specify boundary handling',
        reasons: ['Edge-case error handling is missing in proposal'],
        suggestions: ['Add explicit validation before writing output in src/phase.js'],
        required_changes: ['Add input validation step'],
      }
      : { stance: 'approve', summary: 'Approved', reasons: ['Complete and testable'], required_changes: [] });

    // Phase 1: p1 (revise) -> p2 (approve) -> dispatch impl-p1 -> finishes DONE
    const p1 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Phase 1 v1', proposal: 'Build core schema' });
    stance = 'approve';
    const p2 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Phase 1 v2', proposal: 'Build core schema + validation', revises: p1.id });
    assert.equal(p2.outcome.decision, 'approve');
    const d1 = await h.callTool('team_dispatch', {
      name: 'impl-phase1',
      task: 'Write src/p1.js',
      acceptance: ['src/p1.js exists'],
      model: 'zcode/GLM-5.3-Flash',
      effort: 'high',
      profile: 'code',
      plan_id: p2.id,
      tools: ['read', 'write'],
      write_scope: ['src/**'],
    });
    h.completeMember(d1.child_id);

    // Phase 2 (anchored to executed p2): p3 (revise) -> p4 (revise) -> p5 (CALL #5 > maxPlanAgreements=4!) -> APPROVED!
    stance = 'revise';
    const p3 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Phase 2 v1', proposal: 'Add adapter layer', revises: p2.id });
    const p4 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Phase 2 v2', proposal: 'Add adapter layer + retry', revises: p3.id });
    stance = 'approve';
    const p5 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Phase 2 v3', proposal: 'Add adapter layer + retry + tests', revises: p4.id });
    assert.equal(p5.outcome.decision, 'approve', '5th plan call succeeds legitimately because Phase 1 executed to completion');

    const d2 = await h.callTool('team_dispatch', {
      name: 'impl-phase2',
      task: 'Write src/p2.js',
      acceptance: ['src/p2.js exists'],
      model: 'zcode/GLM-5.3-Flash',
      effort: 'high',
      profile: 'code',
      plan_id: p5.id,
      tools: ['read', 'write'],
      write_scope: ['src/**'],
    });
    h.completeMember(d2.child_id);

    // Phase 3 (CALL #6): still works cleanly!
    const p6 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Phase 3', proposal: 'Final CLI wiring', revises: p5.id });
    assert.equal(p6.outcome.decision, 'approve');
  }

  // Part B: Adversarial unanchored spam (4 unanchored plans with zero execution -> 5th is strictly blocked)
  {
    const h = setupTeamHarness(t, {
      team: { maxPlanAgreements: 4, maxDiscussionsPerTask: 10 },
    });
    h.setResponder(() => ({
      stance: 'revise',
      summary: 'Still missing SPEC items',
      reasons: ['Does not cover SPEC section 2'],
      suggestions: ['Add section 2 handlers to proposal'],
      required_changes: ['Cover section 2'],
    }));
    let latestRevision;
    for (let i = 1; i <= 4; i++) {
      latestRevision=await h.callTool('team_discuss', { kind: 'plan', topic: `Unanchored ${i}`, proposal: `Spam proposal ${i}`, ...(latestRevision?{revises:latestRevision.id}:{}) });
    }
    await assert.rejects(
      () => h.callTool('team_discuss', { kind: 'plan', topic: 'Unanchored 5', proposal: 'Spam proposal 5' }),
      /plan agreement limit 4 reached/,
    );
  }
});

test('[Rationality R2] maxPlanAgreements=4 grants convergence grace to strictly shrinking required_changes (4->3->2->1) while blocking stagnant loops', async t => {
  // Part A: Constructive monotonic convergence (4 -> 3 -> 2 -> 1 -> approve on 5th call!)
  {
    const h = setupTeamHarness(t, {
      team: { maxPlanAgreements: 4, maxDiscussionsPerTask: 10 },
    });
    let remaining = [];
    h.setResponder(() => remaining.length === 0
      ? { stance: 'approve', summary: 'All items resolved', reasons: ['Converged cleanly'], required_changes: [] }
      : {
        stance: 'revise',
        summary: `${remaining.length} item(s) left`,
        reasons: [`Remaining blocking items: ${remaining.join(', ')}`],
        suggestions: remaining.map(item => `Concrete fix for ${item} in src/app.js`),
        required_changes: remaining,
      });

    remaining = ['item-1', 'item-2', 'item-3', 'item-4'];
    const p1 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v1', proposal: 'v1' });
    remaining = ['item-2', 'item-3', 'item-4'];
    const p2 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v2', proposal: 'v2', revises: p1.id });
    remaining = ['item-3', 'item-4'];
    const p3 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v3', proposal: 'v3', revises: p2.id });
    remaining = ['item-4'];
    const p4 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v4', proposal: 'v4', revises: p3.id });

    // 5th call (`revises: p4`): p4 had 1 item < p3's 2 items -> convergence grace admits p5 and approves!
    remaining = [];
    const p5 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v5', proposal: 'v5 complete', revises: p4.id });
    assert.equal(p5.outcome.decision, 'approve');
  }

  // Part B: Non-converging loop (2 -> 2 -> 3 -> 2 items) -> 5th call is blocked!
  {
    const h = setupTeamHarness(t, {
      team: { maxPlanAgreements: 4, maxDiscussionsPerTask: 10 },
    });
    let remaining = [];
    h.setResponder(() => ({
      stance: 'revise',
      summary: 'Non-converging',
      reasons: ['Still broken'],
      suggestions: ['Fix items in src/app.js'],
      required_changes: remaining,
    }));
    remaining = ['a', 'b'];
    const p1 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v1', proposal: 'v1' });
    remaining = ['a', 'b'];
    const p2 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v2', proposal: 'v2', revises: p1.id });
    remaining = ['a', 'b', 'c'];
    const p3 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v3', proposal: 'v3', revises: p2.id });
    remaining = ['a', 'b', 'c'];
    const p4 = await h.callTool('team_discuss', { kind: 'plan', topic: 'v4', proposal: 'v4', revises: p3.id });

    await assert.rejects(
      () => h.callTool('team_discuss', { kind: 'plan', topic: 'v5', proposal: 'v5', revises: p4.id }),
      /plan agreement limit 4 reached/,
    );
  }
});

test('[Rationality R3] stagnation best-plan selector rescues nitpicked projects after timeout, yet strictly refuses unanimously rejected unsafe plans', async t => {
  const prevClock = process.env.LT_TIMER_NOW_MS;
  t.after(() => {
    if (prevClock === undefined) delete process.env.LT_TIMER_NOW_MS;
    else process.env.LT_TIMER_NOW_MS = prevClock;
  });

  // Part A: 3 nitpicked `revise` plans + 25 minutes stagnation -> `select_best` picks best plan & unlocks `team_dispatch`!
  {
    let fakeNow = 1_700_100_000_000;
    process.env.LT_TIMER_NOW_MS = String(fakeNow);
    const h = setupTeamHarness(t, {
      timer: { stagnationAfterMs: 20 * 60 * 1000, elevatedAfterMs: 10 * 60 * 1000 },
      planArchive: { minUnapprovedPlansForFallback: 3, useArbiterForBestPlan: true },
    });

    let planIdx = 0;
    h.setResponder(req => {
      if (req.system.includes('anti-stagnation best-plan selection')) {
        const userText = req.messages?.[0]?.content?.[0]?.text ?? req.user;
        const parsed = JSON.parse(userText);
        const best = parsed.candidates[0];
        return {
          selected_plan_id: best.plan_id,
          rationale: 'Candidate has only 1 minor remaining item and full test coverage.',
          execution_guardrails: ['Ensure edge-case empty input assertion is included'],
        };
      }
      planIdx++;
      const reqCount = Math.max(1, 4 - Math.ceil(planIdx / 2));
      return {
        stance: 'revise',
        summary: 'Nitpick polish',
        reasons: ['Minor edge case could be documented'],
        suggestions: ['Add empty-input test case in test/mod.test.js'],
        required_changes: Array.from({ length: reqCount }, (_, k) => `minor-item-${k + 1}`),
      };
    });

    const a1 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Plan 1', proposal: 'Step 1: write src/mod.js' });
    fakeNow += 10 * 60 * 1000;
    process.env.LT_TIMER_NOW_MS = String(fakeNow);
    const a2 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Plan 2', proposal: 'Step 1: write src/mod.js\nStep 2: write tests', revises: a1.id });
    fakeNow += 15 * 60 * 1000;
    process.env.LT_TIMER_NOW_MS = String(fakeNow);
    const a3 = await h.callTool('team_discuss', { kind: 'plan', topic: 'Plan 3', proposal: 'Step 1: write src/mod.js\nStep 2: write full tests', revises: a2.id });
    assert.equal(a3.timer.stagnation_fallback_eligible, true);

    const availableLlm=h.rt.llm;h.rt.llm={async *stream(){yield {type:'finish',reason:{kind:'error',failure:{code:'AUTH',message:'scripted unavailable arbiter'}}};}};
    await assert.rejects(()=>h.callTool('team_plan_archive', {action:'select_best'}),/independent arbitration unavailable/);
    assert.equal(teamStore(h.leaderAgent.id).stagnationSelections().length,0,'no heuristic selection is persisted during an arbiter outage');
    h.rt.llm=availableLlm;
    const best = await h.callTool('team_plan_archive', { action: 'select_best' });
    assert.equal(best.by, 'arbiter');
    assert.equal(best.selected_plan_id, a3.id);

    const dispatched = await h.callTool('team_dispatch', {
      name: 'impl-rescued',
      task: 'Execute rescued plan',
      acceptance: ['tests pass'],
      model: 'zcode/GLM-5.3-Flash',
      effort: 'high',
      profile: 'code',
      plan_id: best.agreement_id,
      tools: ['read', 'write'],
      write_scope: ['src/**'],
    });
    assert.equal(dispatched.plan_id, a3.id);
  }

  // Part B: 3 unanimously `reject`-ed unsafe plans + 60 minutes stagnation -> `select_best` MUST refuse!
  {
    let fakeNow = 1_700_200_000_000;
    process.env.LT_TIMER_NOW_MS = String(fakeNow);
    const h = setupTeamHarness(t, {
      timer: { stagnationAfterMs: 20 * 60 * 1000 },
      planArchive: { minUnapprovedPlansForFallback: 3 },
    });
    h.setResponder(() => ({
      stance: 'reject',
      summary: 'Unsafe destructive proposal',
      reasons: ['Proposal deletes parent directory outside workspace'],
      suggestions: ['Write only inside workspace src/** using scoped file operations'],
      required_changes: [],
    }));
    await h.callTool('team_discuss', { kind: 'plan', topic: 'Unsafe 1', proposal: 'rm -rf ../' });
    fakeNow += 30 * 60 * 1000;
    process.env.LT_TIMER_NOW_MS = String(fakeNow);
    await h.callTool('team_discuss', { kind: 'plan', topic: 'Unsafe 2', proposal: 'rm -rf ../../' });
    fakeNow += 30 * 60 * 1000;
    process.env.LT_TIMER_NOW_MS = String(fakeNow);
    await h.callTool('team_discuss', { kind: 'plan', topic: 'Unsafe 3', proposal: 'format disk' });

    await assert.rejects(
      () => h.callTool('team_plan_archive', { action: 'select_best' }),
      /unanimously rejected/,
    );
  }
});

test('[Rationality R4 & R5] Gate exempts recoverable protocol nudges from permanent member bricking and scales clean high-fanout review budgets', async t => {
  const h = setupTeamHarness(t, {
    gate: { sandboxDirectAllow: false, maxDenialsPerMember: 3, maxReviewsPerTask: 20 },
  });
  fs.writeFileSync(path.join(h.ws, 'src', 'existing.js'), 'export const x = 1;\n');

  let gateDecision = 'deny';
  h.setResponder(() => gateDecision === 'deny'
    ? { decision: 'deny', risk: 'medium', reason: 'Command flags need narrowing' }
    : { decision: 'allow', risk: 'low', reason: 'Clean scoped write' });

  const gate = new Gate(h.ctx);
  const store = teamStore(h.leaderAgent.id);

  // Register member m1 with deferred tool `edit` and unread ref `SPEC.md` (`maxMemberDenials = 3`)
  const specAbs = path.resolve(h.ws, 'SPEC.md');
  const m1Agent = { id: 'child-m1', session: { header: { cwd: h.ws, origin: 'subagent', parentSession: h.leaderAgent.id } } };
  store.addMember({
    childId: 'child-m1',
    name: 'impl-m1',
    taskSeq: 1,
    planId: 'agr-1',
    profile: 'code',
    model: 'zcode/GLM-5.3-Flash',
    effort: 'high',
    allowedTools: ['read', 'write', 'edit'],
    loadedTools: ['read'], // `write` and `edit` deferred!
    writeScope: ['src/**'],
    refs: [specAbs],
    task: 'Edit src/existing.js',
    acceptance: ['ok'],
    cwd: h.ws,
  });

  const runGate = async (agent, name, args) => {
    const actor = gate.actorFor(agent);
    const verdict = await gate.decide({
      name,
      args,
      toolDescription: name,
      agent,
      actor,
      callId: `call-${Math.random()}`,
      signal: undefined,
    });
    return verdict.decision === 'allow' ? null : new Error(`blocked (${verdict.by}): ${verdict.reason}`);
  };

  // Nudge 1: deferred tool `edit` not loaded yet (`rule:tool-not-loaded`)
  assert.match((await runGate(m1Agent, 'edit', { file_path: 'src/existing.js' })).message, /rule:tool-not-loaded/);
  // Nudge 2: deferred tool `write` not loaded yet (`rule:tool-not-loaded`)
  assert.match((await runGate(m1Agent, 'write', { file_path: 'src/new.js', content: '1' })).message, /rule:tool-not-loaded/);
  // Load `write` and `edit`
  store.setMemberTools('child-m1', ['read', 'write', 'edit']);
  h.rt.actors.delete('child-m1');

  // Nudge 3: `SPEC.md` unread (`rule:refs-unread`)
  assert.match((await runGate(m1Agent, 'write', { file_path: 'src/new.js', content: '1' })).message, /rule:refs-unread/);
  // Mark `SPEC.md` read
  h.rt.reads.set('child-m1', new Set([pathKey(specAbs)]));

  // Plus 2 genuine LLM denials (total denials = 5 > maxMemberDenials=3, yet only 2 security strikes!)
  gateDecision = 'deny';
  assert.ok(await runGate(m1Agent, 'write', { file_path: 'src/try1.js', content: 'a' }));
  assert.ok(await runGate(m1Agent, 'write', { file_path: 'src/try2.js', content: 'b' }));

  // Next clean write STILL SUCCEEDS (not bricked by the 3 earlier recoverable workflow nudges!)
  gateDecision = 'allow';
  assert.equal(await runGate(m1Agent, 'write', { file_path: 'src/clean.js', content: 'ok' }), null);

  // Adversarial check: a 3rd genuine security denial DOES trip `rule:member-denial-circuit-breaker`!
  gateDecision = 'deny';
  assert.ok(await runGate(m1Agent, 'write', { file_path: 'src/try3.js', content: 'c' }));
  assert.ok(await runGate(m1Agent, 'write', { file_path:'src/try4.js', content:'d' }));
  assert.ok(await runGate(m1Agent, 'write', { file_path:'src/try5.js', content:'e' }));
  gateDecision = 'allow';
  assert.match((await runGate(m1Agent, 'write', { file_path: 'src/after-breaker.js', content: 'x' })).message, /rule:member-denial-circuit-breaker/);

  // Now test R5: Clean 5-member high-fanout task scales past flat `maxTaskGateReviews = 4`
  const cleanRaw=structuredClone(h.rt.config);delete cleanRaw.derived;cleanRaw.gate.maxReviewsPerTask=4;h.rt.config=configWith(cleanRaw);
  const cleanTeamId = 'leader-clean-fanout';
  h.rt.actors.set(cleanTeamId, {
    role: 'leader',
    teamId: cleanTeamId,
    agentId: cleanTeamId,
    cwd: h.ws,
    agent: { id: cleanTeamId, session: { seq: 1, header: { cwd: h.ws }, snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Parallel build' }] } }] } },
  });
  const cleanStore = teamStore(cleanTeamId);
  cleanStore.ensure({ workspace: h.ws, surface: 'headless' });
  for (let i = 1; i <= 5; i++) {
    const cid = `fanout-${i}`;
    cleanStore.addMember({
      childId: cid,
      name: `worker-${i}`,
      taskSeq: 1,
      planId: 'agr-fan',
      profile: 'code',
      model: 'zcode/GLM-5.3-Flash',
      effort: 'high',
      allowedTools: ['read', 'write'],
      loadedTools: ['read', 'write'],
      writeScope: ['src/**'],
      refs: [],
      task: `Write src/w${i}.js`,
      acceptance: ['ok'],
      cwd: h.ws,
    });
  }
  // Execute 8 clean Gate-reviewed writes across the 5 parallel workers (> base maxTaskGateReviews=4!)
  for (let i = 1; i <= 8; i++) {
    const workerIdx = ((i - 1) % 5) + 1;
    const cid = `fanout-${workerIdx}`;
    const agent = { id: cid, session: { header: { cwd: h.ws, origin: 'subagent', parentSession: cleanTeamId } } };
    const err = await runGate(agent, 'write', { file_path: `src/w${workerIdx}_${i}.js`, content: 'export default 1;\n' });
    assert.equal(err, null, `clean parallel worker review #${i} should scale smoothly without false cap`);
  }
});

test('[Rationality R6 & R7] Accountable review distinguishes concise technical fixes from bare refusals; multi-provider upstream routes never collide', () => {
  // R6-A: Concise, substantive technical disagreement passes
  const good = parseMemberOpinion(JSON.stringify({
    stance: 'revise',
    summary: 'SQL query interpolates user input directly',
    reasons: ['`SELECT * FROM users WHERE id = ${id}` enables SQL injection'],
    suggestions: ['Use parameterized placeholder `db.query("SELECT * FROM users WHERE id = ?", [id])`'],
    required_changes: ['Parameterize user lookup query'],
  }));
  assert.equal(good.ok, true);

  // R6-B: Bare refusal ("因为...所以我不同意") + cliché suggestion ("请重新设计方案") rejected
  const bare = parseMemberOpinion(JSON.stringify({
    stance: 'reject',
    summary: '不同意',
    reasons: ['因为你的架构划分不够优雅，所以我不同意'],
    suggestions: ['请重新考虑方案'],
    required_changes: [],
  }));
  assert.equal(bare.ok, false);
  assert.match(bare.error, /accountable|bare refusal|actionable/i);

  // R6-C: Copying `reasons` verbatim into `suggestions` rejected
  const echo = parseMemberOpinion(JSON.stringify({
    stance: 'revise',
    summary: 'Missing timeout',
    reasons: ['HTTP fetch call has no AbortSignal timeout configured'],
    suggestions: ['HTTP fetch call has no AbortSignal timeout configured'],
    required_changes: ['Add timeout'],
  }));
  assert.equal(echo.ok, false);

  // R7: Multi-provider route collision safety (`magpie` vs `deepseek` both offering `deepseek/deepseek-chat`)
  const existingModels = {
    'deepseek/deepseek-chat': { provider: 'magpie', upstreamModel: 'deepseek/deepseek-chat' },
  };
  const directRoute = canonicalRouteFor('deepseek', 'deepseek-chat', {
    defaultProvider: 'magpie',
    existingModels,
  });
  assert.equal(directRoute, 'deepseek@direct/deepseek-chat', 'disambiguates direct provider route without clobbering magpie route');
  const cfg = configWith({});
  const mergedCfg = {
    ...cfg,
    models: {
      ...cfg.models,
      [directRoute]: {
        provider: 'deepseek',
        upstreamModel: 'deepseek-chat',
        family: 'deepseek',
        label: 'DeepSeek Direct',
        efforts: ['none'],
        defaultEffort: 'none',
      },
    },
  };
  assert.deepEqual(resolveModelTarget(mergedCfg, directRoute, 'none'), {
    provider: 'deepseek',
    model: 'deepseek-chat',
  });
});
