import { scriptedReview } from '../scripted-review.mjs';
// Generic workflow-recovery regression tests: revision-chain integrity, unsettled-agreement quota preservation,
// structured limit recovery state, provider-prefixed dispatch route normalization, and gate-error fail-closed accounting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { evaluateHardRules } from '../../leaderteam/core/gate-policy.mjs';
import { leaderSection } from '../../leaderteam/core/prompts.mjs';
import { globsOverlap } from '../../leaderteam/core/paths.mjs';
import { runtime, teamStore } from '../../leaderteam/host/runtime.mjs';
import { onAgentCreated, onAgentStatus, onSessionEvent, onToolResult, userTaskText } from '../../leaderteam/host/roles.mjs';
import { configWith } from './helpers.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-rec:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-rec:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    }
    if (url === 'virtual-rec:@deepseek-ai/dsh-tools/pipeline') {
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
    if (url === 'virtual-rec:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    }
    if (url === 'virtual-rec:@deepseek-ai/dsh-llm') {
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

test('resident member output-limit truncation auto-continues in-place without marking failed and lists only succeeded operations', t => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lt-output-recovery-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const cfg=configWith({storage:{root:tmp}}),rt=runtime(),previous={...rt};t.after(()=>Object.assign(rt,previous));
  Object.assign(rt,{config:cfg,storageRoot:tmp,actors:new Map(),stores:new Map(),memberExecutionProgress:new Map(),circuitStates:new Map(),teamConfigViews:new Map(),scheduler:null,onMemberTerminalStatus:null});
  const store=teamStore('team-output');store.ensure({workspace:tmp});
  for(const [id,operation,result]of [['read-only','read',{content:[]}],['denied-write','write',{isError:true,content:[]}],['applied-write','write',{content:[]}]]){
    const followups=[];
    const session={id,header:{cwd:tmp},snapshotEvents:()=>[]},agent={id,session,followup(m){followups.push(m);}};
    store.addMember({childId:id,name:id,taskSeq:1,model:'zcode/GLM-5.3',effort:'high',profile:'code',stageId:'parse',stageHash:'same'});
    rt.actors.set(id,{role:'member',teamId:'team-output',agentId:id,agent,cwd:tmp});
    onAgentStatus({}, {agent,status:'running'});
    onToolResult({agent,name:operation,arguments:{file_path:'example.txt'},callId:id},result);
    onSessionEvent({},session,{type:'turn/end',data:{reason:{kind:'max-tokens'}}});
    const member=store.getMember(id);
    assert.equal(member.status,'running','member stays running across single-turn max-tokens truncation');
    assert.equal(followups.length,1,'resident followup continuation enqueued synchronously');
    const promptText=followups[0].content[0].text;
    assert.match(promptText,/LeaderTeam output continuation/);
    if (id === 'denied-write') {
      assert.doesNotMatch(promptText,/write\(example\.txt\)/,'denied write is not listed as already succeeded');
    } else {
      assert.match(promptText,new RegExp(`${operation}\\(example\\.txt\\)`),'succeeded tool operation is listed so member does not repeat it');
    }
  }
});

test('native member creation and cold restore carry original requirements without widening the assignment', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-member-user-context-'));
  const runtimeState = runtime();
  const previous = { ...runtimeState };
  t.after(() => {
    Object.assign(runtimeState, previous);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  Object.assign(runtimeState, {
    config: configWith({ storage: { root: temporaryRoot } }),
    storageRoot: temporaryRoot,
    actors: new Map(), stores: new Map(), teamConfigViews: new Map(), liveProcessMemberIds: new Set(),
  });
  const store = teamStore('team-requirements');
  store.ensure({ workspace: temporaryRoot });
  const userTask = 'Build an exporter. Do not contact remote services. Preserve existing destination files when validation fails.';
  const assignment = {
    name: 'export-format', taskSeq: 1, profile: 'code', model: 'zcode/GLM-5.3', effort: 'low',
    allowedTools: ['read', 'write'], loadedTools: ['read'], writeScope: ['lib/export/**'], refs: ['docs/contracts.md'],
    task: 'Implement the assigned export format.', acceptance: ['Produce valid JSON for the agreed schema.'], cwd: temporaryRoot,
  };
  store.addMember({ ...assignment, childId: 'requirements-member', userTask });
  const createSection = childId => {
    const sections = [];
    const agent = {
      id: childId,
      session: { header: { origin: 'subagent', parentSession: store.teamId, cwd: temporaryRoot } },
      ctx: { systemPrompt: { section: section => sections.push(section) } },
    };
    onAgentCreated({}, { agent });
    return sections.find(section => section.name === 'leaderteam:role');
  };
  const initial = createSection('requirements-member');
  assert.equal(initial.interpolate, false);
  assert.ok(initial.text.includes(userTask));
  assert.ok(initial.text.includes(assignment.task));
  assert.ok(initial.text.includes(assignment.acceptance[0]));
  assert.match(initial.text, /Authorized tools: read, write\./);
  assert.match(initial.text, /Initially loaded: read\./);
  assert.ok(initial.text.includes('lib/export/**'));
  assert.ok(initial.text.includes('docs/contracts.md'));
  assert.match(initial.text, /not permission to take over unassigned work, expand your tools or write scope/);
  assert.deepEqual(runtimeState.actors.get('requirements-member').writeScope, assignment.writeScope);
  runtimeState.actors = new Map();
  runtimeState.stores = new Map();
  runtimeState.teamConfigViews = new Map();
  assert.equal(createSection('requirements-member').text, initial.text);
  teamStore(store.teamId).addMember({ ...assignment, childId: 'legacy-member', name: 'legacy-export' });
  const legacy = createSection('legacy-member');
  assert.ok(legacy.text.includes(assignment.task));
  assert.doesNotMatch(legacy.text, /## Original user requirements/);
});

test('Leader prompt forbids single-agent coding, unverified dispatch claims, and distinguishes gate-error from policy denial', () => {
  const cfg = configWith({});
  const text = leaderSection(cfg);
  assert.match(text, /Never propose or attempt single-agent \/ leader-direct code writing/);
  assert.match(text, /never tell the user that members were or are being dispatched unless team_dispatch actually succeeded/);
  assert.match(text, /gate-error/);
  assert.match(text, /plan\.md/);
});

test('Agreement revision chain, unsettled quota preservation, structured limit diagnostics, taskSeq reset, and route prefix normalization', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rec-wf-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxPlanAgreements: 2, maxDiscussionsPerTask: 4 },
    roles: {
      ...configWith({}).roles,
      discussA: { ...configWith({}).roles.discussA, retries: 0 },
      discussB: { ...configWith({}).roles.discussB, retries: 0 },
    },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const sessionEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build module alpha' }] } }];
  const leaderAgent = {
    id: 'leader-rec',
    session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };

  let mode = '502';
  let reqIndex = 0;
  const mockLlm = {
    async *stream(req) {
      reqIndex++;
      if (mode === '502') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '502 Bad Gateway' } } };
        return;
      }
      const body = mode === 'approve'
        ? '{"stance":"approve","summary":"approved","reasons":["complete"],"required_changes":[]}'
        : `{"stance":"revise","summary":"needs detail","reasons":["missing contract"],"suggestions":["Add the missing module contract before execution"],"required_changes":["change-${reqIndex}"]}`;
      yield { type: 'text', text: scriptedReview(body, req.messages?.[0]?.content?.[0]?.text ?? req.user ?? '{}', {hardRequirements:true}) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };

  const tools = new Map();
  let lastSpawnOpts = null;
  const ctx = {
    effect(fn) { return fn(); },
    tools: {
      register(def) { tools.set(def.name, def); },
        definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }, { name: 'pwsh', description: 'p' }]; },
    },
    get(k) {
      if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } };
      return null;
    },
    subagents: {
      async startActivation(opts) {
        lastSpawnOpts = opts;
        return { childId: opts.childId };
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
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  const discuss = args => tools.get('team_discuss').execute(args, { agent: leaderAgent });
  const dispatch = args => tools.get('team_dispatch').execute(args, { agent: leaderAgent });

  // 1. Transient 502 leaves agreement open (status: 'error'), consumes 0 settled quota, and blocks starting a duplicate without resume_id
  const errRes = await discuss({ kind: 'plan', topic: 'alpha plan', proposal: 'v1' });
  assert.equal(errRes.status, 'error');
  await assert.rejects(() => discuss({ kind: 'plan', topic: 'alpha plan dup', proposal: 'v1 dup' }), new RegExp(`resume_id="${errRes.id}"`));

  // 2. Resuming with resume_id settles as 'revise' (1/2 settled quota used)
  mode = 'revise';
  const rev1 = await discuss({ kind: 'plan', topic: 'alpha plan', proposal: 'v1', resume_id: errRes.id });
  assert.equal(rev1.outcome.decision, 'revise');
  assert.deepEqual(rev1.plan_quota, { settled: 1, limit: 2, remaining: 1 });
  assert.match(rev1.next_step_hint, new RegExp(`revises="${rev1.id}"`));

  // 3. Omitting revises when rev1 is unsettled 'revise' in current taskSeq is rejected without calling LLM
  const beforeOmit = reqIndex;
  await assert.rejects(() => discuss({ kind: 'plan', topic: 'alpha plan v2', proposal: 'v2' }), new RegExp(`revises is required.*${rev1.id}`));
  assert.equal(reqIndex, beforeOmit, 'no LLM calls wasted when revises omitted');

  // 4. Second revision settles as 'revise' (2/2 settled quota used -> remaining: 0)
  const rev2 = await discuss({ kind: 'plan', topic: 'alpha plan v2', proposal: 'v2', revises: rev1.id });
  assert.equal(rev2.outcome.decision, 'revise');
  assert.deepEqual(rev2.plan_quota, { settled: 2, limit: 2, remaining: 0 });
  assert.match(rev2.next_step_hint, /Plan agreement limit \(2\/2\) reached/);

  // 5. Calling a 3rd plan in taskSeq=1 throws structured diagnostic error with latest_agreement_id and remaining_required_changes
  await assert.rejects(
    () => discuss({ kind: 'plan', topic: 'alpha plan v3', proposal: 'v3', revises: rev2.id }),
    err => {
      assert.match(err.message, /plan agreement limit 2 reached/);
      assert.match(err.message, new RegExp(`latest_agreement_id=${rev2.id}`));
      assert.match(err.message, /do NOT propose leader single-agent coding/);
      return true;
    },
  );

  // 6. Advancing taskSeq via new user message resets plan quota, STILL rejects stale superseded revises=rev1.id, and approves with revises=rev2.id
  sessionEvents.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue and address remaining items' }] } });
  const beforeStale = reqIndex;
  await assert.rejects(
    () => discuss({ kind: 'plan', topic: 'alpha plan v3 stale', proposal: 'v3', revises: rev1.id }),
    new RegExp(`"${rev1.id}" was already superseded by "${rev2.id}"`),
  );
  assert.equal(reqIndex, beforeStale, 'no LLM calls wasted on stale superseded revises');

  mode = 'approve';
  const approved = await discuss({ kind: 'plan', topic: 'alpha plan v3', proposal: 'v3 complete', revises: rev2.id });
  assert.equal(approved.task_seq, 2);
  assert.equal(approved.outcome.decision, 'approve');

  // 7. team_dispatch normalizes magpie/<route> prefix cleanly
  const dispatched = await dispatch({
    name: 'impl-alpha',
    task: 'implement alpha',
    acceptance: ['alpha works'],
    model: `${cfg.magpie.provider}/zcode/GLM-5.3`,
    effort: 'high',
    profile: 'code',
    plan_id: approved.id,
    tools: ['read', 'write'],
    write_scope: ['src/**'],
  });
  assert.equal(dispatched.model, 'zcode/GLM-5.3');
  assert.equal(lastSpawnOpts.request.agentOptions.model, 'zcode/GLM-5.3');

  // 8. team_dispatch rejects mutating profile with only uncontrolled tools and rejects omitting "read" when available
  await assert.rejects(
    () => dispatch({
      name: 'impl-readonly-mistake',
      task: 'edit alpha',
      acceptance: ['alpha edited'],
      model: 'zcode/GLM-5.3',
      effort: 'high',
      profile: 'code',
      plan_id: approved.id,
      tools: ['read'],
      write_scope: ['docs/**'],
    }),
    /mutating profile.*only read-only\/uncontrolled tools/,
  );
  await assert.rejects(
    () => dispatch({
      name: 'verify-no-read-mistake',
      task: 'verify alpha',
      acceptance: ['verified'],
      model: 'zcode/GLM-5.3',
      effort: 'high',
      profile: 'shell',
      plan_id: approved.id,
      tools: ['pwsh'],
      write_scope: ['docs/**'],
    }),
    /requires including "read" in tools/,
  );

  // 9. userTaskText preserves the latest user turn intact from its beginning across multi-turn sessions
  sessionEvents.splice(0, sessionEvents.length,
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'INITIAL CHARTER: ' + 'A'.repeat(1800) }] } },
    ...Array.from({ length: 7 }, (_, i) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `Turn ${i + 2}: ` + 'B'.repeat(400) }] } })),
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'CURRENT TURN START [ITEM-1] ' + 'C'.repeat(2100) + ' [ITEM-5 END]' }] } },
  );
  const assembled3k = userTaskText(ctx, leaderAgent.id, 3000);
  assert.ok(assembled3k.length <= 3000, `expected <= 3000 chars, got ${assembled3k.length}`);
  assert.ok(assembled3k.includes('INITIAL CHARTER: '), 'preserves initial charter header');
  assert.ok(assembled3k.includes('CURRENT TURN START [ITEM-1]'), 'preserves start of current turn intact');
  assert.ok(assembled3k.includes('[ITEM-5 END]'), 'preserves end of current turn intact');
});

test('Transient gate-error remains strictly fail-closed without tripping member policy-denial circuit breaker', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rec-gate-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    gate: { sandboxDirectAllow: false, maxDenialsPerMember: 1, maxReviewsPerMember: 5, maxReviewsPerTask: 10 },
    roles: { ...configWith({}).roles, gate: { ...configWith({}).roles.gate, retries: 0 } },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores), reads: new Map(rt.reads) };
  t.after(() => Object.assign(rt, prev));

  let fail502 = true;
  const mockLlm = {
    async *stream(req) {
      if (fail502) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'EOF (502)' } } };
        return;
      }
      yield { type: 'text', text: '{"decision":"allow","risk":"low","reason":"in scope"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const agent = { id: 'm-gate', session: { header: { cwd: ws, origin: 'subagent', parentSession: 'team-gate' } } };
  const actor = { role: 'member', teamId: 'team-gate', agentId: 'm-gate', agent, name: 'dev', profile: 'code', allowedTools: cfg.profiles.code.tools, writeScope: ['src/**'], refs: [], task: 't', acceptance: ['a'], userTask: 'u', cwd: ws };
  Object.assign(rt, {
    config: cfg,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([['m-gate', actor]]),
    reads: new Map(),
    stores: new Map(),
    counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 },
  });
  teamStore('team-gate').ensure({ workspace: ws, surface: 'headless' });
  const gate = new Gate({});

  // First call hits 502 -> fails closed as gate-error with retryable message
  const g1 = await gate.decide({ name: 'write', args: { file_path: 'src/a.js', content: '1' }, agent, actor, callId: 'c1' });
  assert.equal(g1.decision, 'deny');
  assert.equal(g1.by, 'gate-error');
  assert.match(g1.reason, /failed closed without executing.*safe to retry/);

  // Even though maxDenialsPerMember === 1, retrying after 502 recovers does NOT trip member-denial-circuit-breaker!
  fail502 = false;
  const g2 = await gate.decide({ name: 'write', args: { file_path: 'src/a.js', content: '1' }, agent, actor, callId: 'c2' });
  assert.equal(g2.decision, 'allow');
});

test('Per-incident loop guards reset on real progress and auto-continuation catches invalid delivery claims and mid-workflow stops without advancing taskSeq', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rec-cont-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, '.leaderteam', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.leaderteam', 'refs', 'plan.md'), '# Full plan\n');

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxPlanAgreements: 2 },
  });
  const rt = runtime();
  const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) };
  t.after(() => Object.assign(rt, prev));

  const sessionEvents = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build app' }] } },
  ];
  const followups = [];
  const leaderAgent = {
    id: 'leader-cont',
    inbox: { nextTurn: [], nextStep: [] },
    followup(msg) {
      followups.push(msg);
      sessionEvents.push({ type: 'user/message', data: msg });
    },
    session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };

  let stance = 'revise';
  const mockLlm = {
    async *stream(req) {
      const body = stance === 'approve'
        ? '{"stance":"approve","summary":"ok","reasons":["ok"],"required_changes":[]}'
        : '{"stance":"revise","summary":"fix","reasons":["Missing implementation detail"],"suggestions":["Add the missing implementation detail to the plan"],"required_changes":["add detail"]}';
      yield { type: 'text', text: scriptedReview(body, req.messages?.[0]?.content?.[0]?.text ?? req.user ?? '{}', {hardRequirements:true}) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const tools = new Map();
  const ctx = {
    effect(fn) { return fn(); },
    tools: { register(def) { tools.set(def.name, def); }, definitions() { return []; } },
    get() { return null; },
  };
  Object.assign(rt, {
    config: cfg,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
    autoContinueState: new Map(),
  });
  teamStore(leaderAgent.id).ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);
  const discuss = args => tools.get('team_discuss').execute(args, { agent: leaderAgent });

  // 1 revise + 1 approve resets consecutive unapproved plan counter to 0!
  const r1 = await discuss({ kind: 'plan', topic: 'p1', proposal: 'v1' });
  assert.equal(r1.plan_quota.settled, 1);
  stance = 'approve';
  const p2 = await discuss({ kind: 'plan', topic: 'p2', proposal: 'v2', revises: r1.id });
  assert.equal(p2.plan_quota.settled, 0, 'approved plan resets consecutive unapproved plan counter');

  // Leader stops prematurely citing plan ID as DELIVERY: approved -> auto-continued with cordis-host-runner source (task_seq stays 1!)
  sessionEvents.push(
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `Ready for next wave.\nDELIVERY: approved (${p2.id})` }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  );
  onAgentStatus(ctx, { agent: leaderAgent, status: 'idle' });
  assert.equal(followups.length, 1);
  assert.equal(followups[0].source.kind, 'cordis-host-runner');
  assert.match(followups[0].content[0].text, /kind="plan" agreement, NOT a kind="delivery" agreement/);

  // Verify task_seq is STILL 1 despite auto-continuation user/message in session!
  const statusAfter = await tools.get('team_status').execute({}, { agent: leaderAgent });
  assert.equal(statusAfter.task_seq, 1);
});

test('Orphaned active members reconcile across host restart, overlapping concurrent write_scope and premature delivery during running members are blocked, and delivery attaches workspace_manifest', async t => {
  assert.equal(globsOverlap('src/a.txt', 'src/b.txt', 'linux'), false);
  assert.equal(globsOverlap('src/combat/**', 'src/world/**', 'linux'), false);
  assert.equal(globsOverlap('src/*.js', 'src/*.css', 'linux'), false);
  assert.equal(globsOverlap('scripts/**', 'scripts/verify.mjs', 'linux'), true);
  assert.equal(globsOverlap('src/test-*.mjs', 'src/*-e2e.mjs', 'linux'), true);

  const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wf-conc-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'app.js'), 'export const x = 1;\n');

  const cfg = configWith({
    storage: { root: path.join(tmp, 'store') },
    quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true },
    team: { maxActiveMembers: 4 },
  });
  const rt = runtime();
  const prev = {
    ...rt,
    actors: new Map(rt.actors),
    stores: new Map(rt.stores),
    hostAgents: rt.hostAgents,
    liveProcessMemberIds: rt.liveProcessMemberIds,
  };
  t.after(() => Object.assign(rt, prev));

  const sessionEvents = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Implement app' }] } }];
  const leaderAgent = {
    id: 'leader-conc',
    session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents },
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
  };
  let lastReviewerPayload = null;
  const mockLlm = {
    async *stream(req) {
      lastReviewerPayload = JSON.parse(req.messages[0].content[0].text);
      yield { type: 'text', text: '{"stance":"approve","summary":"ok","reasons":["r"],"required_changes":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const liveAgents = new Map([[leaderAgent.id, leaderAgent]]);
  const tools = new Map();
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
        liveAgents.set(childId, { id: childId, session: childSession });
        return { childId };
      },
    },
  };
  Object.assign(rt, {
    config: cfg,
    storageRoot: path.join(tmp, 'store'),
    llm: mockLlm,
    surface: 'headless',
    hostAgents: liveAgents,
    liveProcessMemberIds: new Set(),
    actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]),
    stores: new Map(),
  });
  const store = teamStore(leaderAgent.id);
  store.ensure({ workspace: ws, surface: 'headless' });
  // Simulate an orphaned "running" member from a killed previous host process
  store.addMember({ childId: 'orphan-1', name: 'old-runner', taskSeq: 1, planId: 'agr-old', profile: 'code', preset: 'lt-member-code', model: 'zcode/GLM-5.3', effort: 'high', allowedTools: ['read', 'write'], loadedTools: ['read', 'write'], skills: [], writeScope: ['src/**'], refs: [], task: 'old', acceptance: ['ok'], cwd: ws, userTask: 'Implement app', quotaAtDispatch: 'ok' });
  store.setMemberStatus('orphan-1', 'running');

  registerTeamTools(ctx);
  const discuss = args => tools.get('team_discuss').execute(args, { agent: leaderAgent });
  const dispatch = args => tools.get('team_dispatch').execute(args, { agent: leaderAgent });
  const status = () => tools.get('team_status').execute({}, { agent: leaderAgent });

  // Orphaned running member from dead prior host is reconciled to cancelled!
  const st0 = await status();
  assert.equal(st0.members.find(m => m.child_id === 'orphan-1').status, 'cancelled');

  const plan = await discuss({ kind: 'plan', topic: 'plan', proposal: 'build src' });
  const m1 = await dispatch({ name: 'impl-src', task: 'write app', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', plan_id: plan.id, tools: ['read', 'write'], write_scope: ['src/**'] });

  // Overlapping concurrent write_scope is rejected while impl-src is active
  await assert.rejects(
    () => dispatch({ name: 'impl-src-conflict', task: 'touch app', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', plan_id: plan.id, tools: ['read', 'write'], write_scope: ['src/app.js'] }),
    /overlaps active running member "impl-src"/,
  );
  // Premature delivery discussion while impl-src is still running is rejected
  await assert.rejects(
    () => discuss({ kind: 'delivery', topic: 'deliver early', proposal: 'done' }),
    /cannot start kind="delivery" agreement while team member\(s\) are still running/,
  );

  // Settle impl-src -> delivery now succeeds and auto-attaches workspace_manifest
  onSessionEvent(ctx, liveAgents.get(m1.child_id).session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } });

  // Protected-dir write_scope on member dispatch fails fast with team_note guidance
  await assert.rejects(
    () => dispatch({ name: 'impl-bad-refs', task: 'touch refs', acceptance: ['ok'], model: 'zcode/GLM-5.3', effort: 'high', profile: 'code', plan_id: plan.id, tools: ['read', 'write'], write_scope: ['.leaderteam/refs/**'] }),
    /targets protected path "\.leaderteam".*team_note/,
  );

  // team_note strips redundant leading projectRefsDir prefix instead of nesting .leaderteam/refs/.leaderteam/refs
  const noteRes = await tools.get('team_note').execute({ path: '.leaderteam/refs/report.md', content: 'ok' }, { agent: leaderAgent });
  assert.equal(noteRes.path, path.join(ws, '.leaderteam', 'refs', 'report.md'));
  assert.equal(fs.existsSync(path.join(ws, '.leaderteam', 'refs', '.leaderteam')), false);

  const deliv = await discuss({ kind: 'delivery', topic: 'deliver', proposal: 'done', evidence_files: ['src/app.js'] });
  assert.equal(deliv.outcome.decision, 'approve');
  assert.match(lastReviewerPayload.evidence, /### workspace_manifest/);
  assert.match(lastReviewerPayload.evidence, /src\/app\.js/);

  // team_status exposes member write_scope and open-agreement resume_hint
  // Also verify unsettled child agreement does NOT prematurely supersede its settled parent!
  store.appendAgreementEvent({ type: 'created', id: 'agr-open-deliv', taskSeq: 1, topic: 'open delivery', kind: 'delivery', proposalHash: 'h', maxRounds: 3, maxArbiterAttempts: 2, routes: { A: 'zcode/GLM-5.3', B: 'antigravity/gemini-4-argon', arbiter: 'zcode/GLM-5.3' }, revises: deliv.id });
  const st1 = await status();
  assert.deepEqual(st1.members.find(m => m.name === 'impl-src').write_scope, ['src/**']);
  assert.match(st1.agreements.find(a => a.id === 'agr-open-deliv').resume_hint, /resume_id="agr-open-deliv"/);
  assert.equal(st1.agreements.find(a => a.id === deliv.id).superseded_by, null);

  // DSH own-session tool-output spill files are readable, while other sessions' spill files remain blocked
  const spillTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-spill-test-'));
  const ownSeg = `session-${createHash('sha256').update('leader-conc').digest('hex').slice(0, 12)}`;
  const otherSeg = `session-${createHash('sha256').update('other-sess').digest('hex').slice(0, 12)}`;
  const ownSpillFile = path.join(spillTmp, 'dsh-spill-Ab12Cd', ownSeg, '1234-team_status.txt');
  const otherSpillFile = path.join(spillTmp, 'dsh-spill-Ab12Cd', otherSeg, '1234-team_status.txt');
  fs.mkdirSync(path.dirname(ownSpillFile), { recursive: true });
  fs.mkdirSync(path.dirname(otherSpillFile), { recursive: true });
  fs.writeFileSync(ownSpillFile, 'ok');
  fs.writeFileSync(otherSpillFile, 'secret');
  assert.equal(
    evaluateHardRules({ tool: 'read', args: { file_path: ownSpillFile }, actor: { role: 'leader', allowedTools: ['read'] }, cwd: ws, spillTmpRoot: spillTmp, ownSpillSessionSegment: ownSeg }, cfg),
    undefined,
  );
  assert.equal(
    evaluateHardRules({ tool: 'read', args: { file_path: otherSpillFile }, actor: { role: 'leader', allowedTools: ['read'] }, cwd: ws, spillTmpRoot: spillTmp, ownSpillSessionSegment: ownSeg }, cfg)?.rule,
    'path-outside-read-roots',
  );
});
