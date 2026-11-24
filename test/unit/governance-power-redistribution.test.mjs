import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { loadConfig, validateConfig } from '../../leaderteam/core/config.mjs';
import { DEFAULT_CONFIG_FILE } from './helpers.mjs';
import {
  computeEventId,
  computeBehaviorIdentity,
  buildDisputeEvidenceSnapshot,
  resolveDisputeStrike,
} from '../../leaderteam/core/dispute-tracker.mjs';
import {
  replayGovernanceState,
  isAutonomousGovernance,
} from '../../leaderteam/core/governance-protocol.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: `virtual-gov-p2:${encodeURIComponent(specifier)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('virtual-gov-p2:')) return nextLoad(url, context);
    const spec = decodeURIComponent(url.slice('virtual-gov-p2:'.length));
    if (spec === '@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const defineTool = def => def;
          export const TOOL_ABORTED_BEFORE_DISPATCH = 'TOOL_ABORTED_BEFORE_DISPATCH';
          export class ToolsService {
            view(scope) { return scope?.__view ?? { visible: new Map(), knownNames: new Set() }; }
            resolve(agent) { const admitted = this.view(agent); return admitted; }
            definitions() { return []; }
            get() { return null; }
            executable() { return null; }
          }
        `,
      };
    }
    if (spec === '@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class ToolExecutionPipeline {
            resolveExecution() { return { execute: async (args) => ({ content: [{ type: 'text', text: 'ok' }], args }) }; }
            async dispatchToolBody(exec) {
              const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
              return await tool.execute(exec.arguments, exec);
            }
          }
        `,
      };
    }
    if (spec === '@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    }
    if (spec === '@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const boundContextSummary = s => s;
          export const createUserMessage = x => ({ ...x, role: 'user', id: 'msg-1' });
          export class BlockAssembler {
            constructor() { this._b = []; }
            push(c) { if (c.type === 'text') this._b.push(c); }
            blocks() { return this._b; }
          }
        `,
      };
    }
    return { format: 'module', shortCircuit: true, source: 'export default {};' };
  },
});

const { runtime, teamStore } = await import('../../leaderteam/host/runtime.mjs');
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');
const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { installToolSurface } = await import('../../leaderteam/host/tool-surface.mjs');
const { onSessionEvent, onAgentStatus, resolveActor } = await import('../../leaderteam/host/roles.mjs');
const { reviewStop, stopDeclaration, STOP_REVIEW_SYSTEM, STOP_REVIEW_ARBITER_SYSTEM } = await import('../../leaderteam/host/stop-review.mjs');
const { INVESTIGATOR_SYSTEM } = await import('../../leaderteam/host/investigator.mjs');
const { leaderSection } = await import('../../leaderteam/core/prompts.mjs');
const {
  resolveHumanEscalationOnUserTurn,
  awaitTeamGovernanceJobs,
  verifyActiveArbiterDirectives,
} = await import('../../leaderteam/host/governance.mjs');

function autonomousConfig(overrides = {}) {
  const raw = structuredClone(loadConfig(DEFAULT_CONFIG_FILE, { includeLocal: false }));
  delete raw.derived;
  raw.quota.allowUnknownGpt = true;
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], v);
      else a[k] = v;
    }
    return a;
  };
  return validateConfig(merge(raw, overrides));
}

function makeAutonomousEnv(t, cfg, llmGenerateFn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-gov-power-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ws = path.join(dir, 'ws');
  const storageRoot = path.join(dir, 'storage');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src', 'engine.js'), 'export const version = 1;\n', 'utf8');

  const tools = new Map();
  for (const n of ['read', 'read_image', 'glob', 'grep', 'todo_write', 'write', 'edit', 'pwsh', 'bash', 'team_tools', 'team_skills']) {
    tools.set(n, { name: n, description: n });
  }
  const presetView = { visible: tools, knownNames: new Set(tools.keys()) };
  const presets = {
    presetForSession: () => 'leaderteam',
    resolve: () => ({ scope: { __view: presetView } }),
    acquireScope: async () => ({ key: presetView, [Symbol.asyncDispose]: async () => {} }),
  };

  const spawnedChildren = new Map();
  const sentMessages = [];
  const subagents = {
    async startActivation(actOpts) {
      const childSession = {
        id: actOpts.childId,
        header: { origin: 'subagent', parentSession: actOpts.request.parent.id, cwd: ws },
        events: [{ type: 'turn/start', data: { turn: 1 } }],
        snapshotEvents() { return this.events; },
      };
      const childAgent = {
        id: actOpts.childId,
        status: 'running',
        steered: [],
        followups: [],
        cancelled: false,
        session: childSession,
        ctx: { systemPrompt: { section() {}, context() {} } },
        steer(m) {
          this.steered.push(m);
          const txt = m?.content?.[0]?.text ?? '';
          if (opts.autoCheckpointOnSteer !== false && txt.includes('Immediate Checkpoint Pause')) {
            queueMicrotask(async () => {
              // Simulate running subagent attempting one more tool call -> Gate immediately blocks with `rule:conference-checkpoint-pause`!
              const childActor = runtime().actors.get(this.id);
              if (childActor) {
                const blockedRead = await runtime().gate.decide({
                  name: 'read',
                  args: { file_path: 'src/engine.js' },
                  agent: this,
                  actor: childActor,
                });
                this.pauseGateVerdict = blockedRead;
              }
              this.session.events.push({
                type: 'assistant/message',
                data: {
                  content: [{
                    type: 'text',
                    text: [
                      'STOPPED_AT: src/engine.js:line 12 before cache eviction helper',
                      'COMPLETED_SO_FAR: wrote initial LRU map header',
                      'RESUME_PLAN: implement evictOldest() and run unit check',
                      'STATUS: paused',
                    ].join('\n'),
                  }],
                },
              });
              this.status = 'idle';
              onSessionEvent(ctx, this.session, { type: 'turn/end', seq: 2, data: { reason: { kind: 'completed' } } });
            });
          }
        },
        followup(m) {
          this.followups.push(m);
          this.status = 'running';
        },
        cancel() { this.cancelled = true; },
      };
      spawnedChildren.set(actOpts.childId, { opts: actOpts, agent: childAgent });
      runtime().hostAgents.set(actOpts.childId, childAgent);
      resolveActor(ctx, childAgent);
      if (actOpts.delivery === 'caller') {
        const hookRes = typeof opts.directExecHook === 'function'
          ? await opts.directExecHook(childAgent, actOpts)
          : null;
        const customStopReason = hookRes && !Array.isArray(hookRes) && typeof hookRes === 'object' && hookRes.stopReason
          ? hookRes.stopReason
          : { kind: 'completed' };
        const directOut = Array.isArray(hookRes)
          ? hookRes
          : (hookRes?.output ?? [{ type: 'text', text: 'Direct execution verification completed cleanly.\nSTATUS: done' }]);
        childAgent.status = 'idle';
        return {
          childId: actOpts.childId,
          messageId: 'm-direct',
          result: Promise.resolve({ output: directOut, stopReason: customStopReason }),
          dispose: async () => {},
        };
      }
      return { childId: actOpts.childId, messageId: 'm-member' };
    },
    async sendMessage(_sender, childId, content) {
      sentMessages.push({ childId, content });
      return { delivered: true };
    },
  };

  const teamId = `team-gov-${Math.random().toString(36).slice(2, 8)}`;
  const leaderSession = {
    id: teamId,
    header: { cwd: ws },
    events: [
      { type: 'user/message', time: Date.now() - 5000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '实现引擎模块并通过测试验收' }] } },
      { type: 'turn/start', data: { turn: 1 } },
    ],
    snapshotEvents() { return this.events; },
  };
  const leaderAgent = {
    id: teamId,
    status: 'running',
    steered: [],
    followups: [],
    session: leaderSession,
    model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) },
    steer(m) { this.steered.push(m); },
    followup(m) { this.followups.push(m); },
  };

  const hostAgents = new Map([[leaderAgent.id, leaderAgent]]);
  const llm = {
    async *stream(req) {
      const userText = req.messages?.[0]?.content?.map(b => b.text).join('\n') ?? '';
      const res = await llmGenerateFn({ ...req, user: userText });
      const text = res?.message?.content?.[0]?.text ?? res?.text ?? '{}';
      yield { type: 'text', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const ctx = {
    tools: {
      register: def => { tools.set(def.name, def); return () => tools.delete(def.name); },
      view: s => s?.__view ?? presetView,
      definitions: () => [...tools.values()],
    },
    effect: fn => fn(),
    get: k => (k === 'agentPresets' ? presets : k === 'agents' ? hostAgents : null),
    subagents,
    llm,
  };

  const rt = runtime();
  installToolSurface(agent => (agent?.session ? rt.gate?.actorFor(agent) : null));
  Object.assign(rt, {
    config: cfg,
    storageRoot,
    surface: 'headless',
    startupReady: { coreVersion: '1.1.0' },
    actors: new Map([[leaderAgent.id, {
      role: 'leader',
      teamId: leaderAgent.id,
      agentId: leaderAgent.id,
      name: 'leader',
      profile: 'leader',
      allowedTools: cfg.profiles.leader.tools,
      loadedTools: cfg.profiles.leader.tools,
      cwd: ws,
      agent: leaderAgent,
    }]]),
    reads: new Map(),
    readProgress: new Map(),
    stores: new Map(),
    circuitStates: new Map(),
    pendingMemberContinuations: new Map(),
    autoContinueState: new Map(),
    counters: { reviewed: 0, allowed: 0, denied: 0, errors: 0 },
    hostAgents,
    liveProcessMemberIds: new Set(),
    plugins: { scheduler: null, consensus: {}, timerArchive: null, panel: null },
    cordisCompositionMode: false,
    llm: ctx.llm,
    teamConfigViews: new Map(),
    gatePatternCache: new Map(),
    governanceJobs: new Map(),
    supervisedDigests: new Set(),
    upstreamCatalog: { providers: ['magpie'], models: [] },
    upstreamCatalogAtMs: Date.now(),
    planningDisposed: false,
  });
  rt.gate = new Gate(ctx);
  const store = teamStore(leaderAgent.id);
  store.ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);

  return { dir, ws, storageRoot, tools, ctx, rt, store, leaderAgent, spawnedChildren, sentMessages };
}

test('[§1, §2, §3.1] Shipped default config runs in autonomous execution-first mode: Leader dispatches without plan_id, and Reviewers alone or <2/3 caucus never block execution', async t => {
  const shipped = loadConfig(DEFAULT_CONFIG_FILE, { includeLocal: false });
  assert.equal(isAutonomousGovernance(shipped), true, 'shipped default config must enable autonomous governance');
  assert.ok(shipped.roles.directExec, 'shipped default config must define roles.directExec');
  assert.ok(shipped.profiles.leader.tools.includes('team_direct_exec'));
  assert.ok(shipped.profiles.leader.tools.includes('team_conference'));

  let reviewerCalls = 0;
  let caucusCalls = 0;
  let conferenceCalls = 0;
  const cfg = autonomousConfig();
  const env = makeAutonomousEnv(t, cfg, async req => {
    const sys = String(req.system ?? '');
    if (sys.includes('asynchronous supervisor')) {
      reviewerCalls++;
      if (reviewerCalls === 1) {
        return { message: { content: [{ type: 'text', text: '{"stance":"object","intervene":true,"summary":"Prefer splitting file","concerns":["Could split helper"],"suggestions":["Extract util.js"],"target_paths":["src/engine.js"]}' }] } };
      }
      if (reviewerCalls === 2) {
        return { message: { content: [{ type: 'text', text: '{"stance":"endorse","intervene":false,"summary":"Cohesive stage is fine","concerns":[],"suggestions":[],"target_paths":[]}' }] } };
      }
      return { message: { content: [{ type: 'text', text: '{"stance":"object","intervene":true,"summary":"Missing benchmark doc","concerns":["Add benchmark doc"],"suggestions":["Write bench.md"],"target_paths":["src/engine.js"]}' }] } };
    }
    if (sys.includes('Stage 2 (3-Party Internal Caucus')) {
      caucusCalls++;
      if (sys.includes('You are the Independent Arbiter')) {
        return { message: { content: [{ type: 'text', text: '{"escalate_to_conference":false,"rationale":"User never asked for bench.md; execution is compliant.","fact_findings":["engine.js matches spec"],"initial_expectation":"","questions_for_leader":[]}' }] } };
      }
      const isVoteA = caucusCalls === 2;
      return { message: { content: [{ type: 'text', text: JSON.stringify({ escalate_to_conference: isVoteA, rationale: isVoteA ? 'Still want bench' : 'Agree with Arbiter fact check', initial_expectation: '' }) }] } };
    }
    if (sys.includes('Stage 3 Formal 2-Party Conference')) {
      conferenceCalls++;
    }
    throw new Error(`unexpected LLM call: ${sys.slice(0, 80)}`);
  });

  process.env.LEADERTEAM_HEADLESS_LEADER = '1';
  await env.tools.get('team_plan').execute({
    action: 'overview',
    summary: 'Engine implementation',
    approach: 'Direct autonomous stage dispatch',
    acceptance: ['Engine exports version'],
    estimated_minutes: 5,
    future_work: ['core-engine'],
  }, { agent: env.leaderAgent });

  const planRes = await env.tools.get('team_plan').execute({
    action: 'stage',
    stage_id: 'core-engine',
    goal: 'Implement src/engine.js',
    method: 'Single cohesive stage',
    acceptance: ['version exported'],
    interfaces: ['version: number'],
    profile: 'code',
    tools: ['read', 'write', 'edit'],
    write_scope: ['src/**'],
    serial_reason: 'Single module',
    ready: true,
  }, { agent: env.leaderAgent });
  assert.equal(planRes.governance_mode, 'autonomous');
  assert.equal(planRes.execution_authorized, true);

  const dispRes = await env.tools.get('team_dispatch').execute({
    name: 'impl-engine',
    stage_id: 'core-engine',
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
  }, { agent: env.leaderAgent });
  assert.equal(dispRes.member, 'impl-engine');
  assert.equal(dispRes.governance_mode, 'autonomous');
  assert.equal(dispRes.plan_id, undefined, 'no plan_id required in autonomous governance mode');

  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);
  assert.equal(reviewerCalls, 2, 'background Stage 1 dual supervision ran asynchronously');
  assert.equal(caucusCalls, 0, '1/2 non-unanimous reviewer opinion must NOT summon Arbiter caucus');

  const govAfterStage1 = replayGovernanceState(env.store.governanceEvents(), 1);
  assert.equal(govAfterStage1.advisoryNotes.length, 1, 'non-unanimous concern recorded as non-blocking advisory note');
  assert.equal(govAfterStage1.activeConference, null);

  env.store.setMemberStatus(dispRes.child_id, 'done');
  const delivRes = await env.tools.get('team_discuss').execute({
    kind: 'delivery',
    topic: 'Deliver engine',
    proposal: 'src/engine.js complete',
  }, { agent: env.leaderAgent });
  assert.equal(caucusCalls, 3, 'unanimous Reviewer objection convened 3-party caucus (Arbiter + A + B)');
  assert.equal(conferenceCalls, 0, '1/3 caucus vote (< 2/3) must NOT convene Stage 3 formal conference or pause Leader');
  assert.equal(delivRes.status, 'settled');
  assert.equal(delivRes.outcome.decision, 'approve');
});

test('[§3.2, §6.2, §6.3] Direct Execution Model hard rules + Unified Safety Gate pattern cache (0 repeat LLM calls) + Constitutional Supremacy', async t => {
  let gateModelCalls = 0;
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ext-sdk-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(externalDir, 'sdk.txt'), 'external-sdk-v1', 'utf8');

  const cfg = autonomousConfig({
    paths: { globalRefRoots: [externalDir] },
  });

  const env = makeAutonomousEnv(t, cfg, async req => {
    const sys = String(req.system ?? '');
    if (sys.includes('safety gate')) {
      gateModelCalls++;
      return { message: { content: [{ type: 'text', text: '{"decision":"allow","risk":"low","reason":"Approved benign local dynamic check or external SDK inspection"}' }] } };
    }
    return { message: { content: [{ type: 'text', text: '{"stance":"endorse","intervene":false,"summary":"ok","concerns":[],"suggestions":[],"target_paths":[]}' }] } };
  });

  const directActor = {
    role: 'direct_exec',
    teamId: env.leaderAgent.id,
    agentId: 'direct-1',
    name: 'direct-exec-1',
    profile: 'shell',
    taskSeq: 1,
    allowedTools: ['read', 'glob', 'grep', 'write', 'edit', 'pwsh'],
    loadedTools: ['read', 'glob', 'grep', 'write', 'edit', 'pwsh'],
    writeScope: ['src/**'],
    task: 'Inspect src/engine.js, update version, and run tests',
    acceptance: ['Tests pass'],
    userTask: '实现引擎模块',
    cwd: env.ws,
  };
  const ordinaryActor = {
    role: 'member',
    teamId: env.leaderAgent.id,
    agentId: 'member-1',
    name: 'impl-ordinary',
    profile: 'shell',
    taskSeq: 1,
    allowedTools: ['read', 'glob', 'grep', 'write', 'edit', 'pwsh'],
    loadedTools: ['read', 'glob', 'grep', 'write', 'edit', 'pwsh'],
    writeScope: ['src/**'],
    task: 'Implement engine and inspect SDK',
    acceptance: ['Tests pass'],
    userTask: '实现引擎模块',
    cwd: env.ws,
  };
  env.rt.actors.set(directActor.agentId, directActor);
  env.rt.actors.set(ordinaryActor.agentId, ordinaryActor);
  const directAgent = { id: directActor.agentId, session: { id: directActor.agentId } };
  const ordinaryAgent = { id: ordinaryActor.agentId, session: { id: ordinaryActor.agentId } };

  const ordExtRead = await env.rt.gate.decide({ name: 'read', args: { file_path: path.join(externalDir, 'sdk.txt') }, agent: ordinaryAgent, actor: ordinaryActor });
  assert.equal(ordExtRead.decision, 'allow');

  const dirExtRead = await env.rt.gate.decide({ name: 'read', args: { file_path: path.join(externalDir, 'sdk.txt') }, agent: directAgent, actor: directActor });
  assert.equal(dirExtRead.decision, 'deny');
  assert.equal(dirExtRead.by, 'rule:direct-exec-sandbox-lock');

  const dirBgBypass = await env.rt.gate.decide({ name: 'pwsh', args: { command: 'powershell -Command "Get-Content src/engine.js"' }, agent: directAgent, actor: directActor });
  assert.equal(dirBgBypass.decision, 'deny');
  assert.equal(dirBgBypass.by, 'rule:direct-exec-no-indirect-bypass');
  assert.equal(gateModelCalls, 0);

  const ordInWrite = await env.rt.gate.decide({ name: 'write', args: { file_path: 'src/ordinary.js', content: 'export const a = 1;\n' }, agent: ordinaryAgent, actor: ordinaryActor });
  assert.equal(ordInWrite.decision, 'allow');
  assert.equal(ordInWrite.by, 'sandbox');

  const dirInRead = await env.rt.gate.decide({ name: 'read', args: { file_path: 'src/engine.js' }, agent: directAgent, actor: directActor });
  assert.equal(dirInRead.decision, 'allow');
  assert.equal(dirInRead.by, 'gate-rule');

  const dirEnvSecret = await env.rt.gate.decide({ name: 'read', args: { file_path: '.env.local' }, agent: directAgent, actor: directActor });
  assert.equal(dirEnvSecret.decision, 'deny');
  assert.equal(dirEnvSecret.by, 'rule:direct-exec-secret-file');

  const dirDyn1 = await env.rt.gate.decide({ name: 'pwsh', args: { command: 'node -e "eval(1763740800111)"' }, agent: directAgent, actor: directActor });
  assert.equal(dirDyn1.decision, 'allow');
  assert.equal(dirDyn1.by, 'model');
  assert.equal(gateModelCalls, 1);

  const dirDyn2 = await env.rt.gate.decide({ name: 'pwsh', args: { command: 'node -e "eval(1763740800222)"' }, agent: directAgent, actor: directActor });
  assert.equal(dirDyn2.decision, 'allow');
  assert.equal(dirDyn2.by, 'gate-cache');
  assert.equal(gateModelCalls, 1);

  env.store.appendGovernanceEvent({
    type: 'conference-concluded',
    taskSeq: 1,
    conferenceId: 'conf-supreme',
    disputeId: 'disp-supreme',
    ruling: {
      decision: 'adopt_alternative',
      rulingSummary: 'Try writing .git/config',
      deltaFromInitialExpectation: 'test',
      bindingDirectives: ['Write .git/config'],
      blockedTargets: [],
      memberResumePolicy: 'resume_all',
    },
  });
  const blockedProtected = await env.rt.gate.decide({ name: 'write', args: { file_path: '.git/config', content: 'x' }, agent: ordinaryAgent, actor: ordinaryActor });
  assert.equal(blockedProtected.decision, 'deny');
  assert.equal(blockedProtected.by, 'rule:path-protected');
});

test('[§三 & Addendum] Pre-Conference Pause Barrier waits for ALL models to write immediate handoff checkpoint BEFORE opening Stage 3, revokes team_direct_exec during conference, and enforces conferenceId generation guard', async t => {
  let supervisionRound = 0;
  const stage4Payloads = [];
  let conferenceOpenedWhenMemberStatus = null;

  const cfg = autonomousConfig({
    governance: { autoSuperviseStages: false, autoSuperviseDispatches: true },
  });
  const env = makeAutonomousEnv(t, cfg, async req => {
    const sys = String(req.system ?? '');
    const usr = String(req.user ?? '');
    if (sys.includes('asynchronous supervisor')) {
      supervisionRound++;
      if (usr.includes('stage4_conference_return_packet')) {
        stage4Payloads.push(JSON.parse(usr.split('\n').at(-1)));
        return { message: { content: [{ type: 'text', text: '{"stance":"endorse","intervene":false,"summary":"Accepted Arbiter conference ruling and evidence","concerns":[],"suggestions":[],"target_paths":[]}' }] } };
      }
      return { message: { content: [{ type: 'text', text: '{"stance":"object","intervene":true,"summary":"Expected external Redis cache instead of in-memory LRU","concerns":["No Redis adapter"],"suggestions":["Replace in-memory LRU with Redis"],"target_paths":["src/engine.js"]}' }] } };
    }
    if (sys.includes('Stage 2 (3-Party Internal Caucus')) {
      if (sys.includes('You are the Independent Arbiter')) {
        return { message: { content: [{ type: 'text', text: '{"escalate_to_conference":true,"rationale":"Need Leader to clarify memory bounds vs Redis dependency","fact_findings":["src/engine.js uses in-memory map"],"initial_expectation":"Add Redis adapter unless zero-dependency constraint applies","questions_for_leader":["Why was in-memory LRU chosen over Redis?"]}' }] } };
      }
      const isFirstVoter = supervisionRound <= 2 && !env.__votedA;
      env.__votedA = true;
      return { message: { content: [{ type: 'text', text: JSON.stringify({ escalate_to_conference: isFirstVoter, rationale: isFirstVoter ? 'Convene formal conference' : 'Defer', initial_expectation: 'Add Redis adapter' }) }] } };
    }
    if (sys.includes('opening a Stage 3 Formal 2-Party Conference')) {
      // Capture member status at the exact moment Stage 3 Conference Opening runs!
      const mem = [...env.store.members().values()][0];
      conferenceOpenedWhenMemberStatus = mem?.status ?? null;
      return { message: { content: [{ type: 'text', text: '{"opening_statement":"Reviewers expected a Redis cache; present actual project constraints.","key_questions":["Show the zero-external-dependency constraint."]}' }] } };
    }
    if (sys.includes('in a Stage 3 Formal 2-Party Conference')) {
      return { message: { content: [{ type: 'text', text: '{"status":"concluded","decision":"overturn_objection","ruling_summary":"Overturned initial Redis expectation: zero external daemons required.","delta_from_initial_expectation":"Completely overturned initial expectation to add Redis.","binding_directives":[],"blocked_targets":[],"member_resume_policy":"resume_all"}' }] } };
    }
    throw new Error(`Unexpected LLM call: ${sys}`);
  });

  process.env.LEADERTEAM_HEADLESS_LEADER = '1';
  fs.writeFileSync(path.join(env.ws, 'src', 'lru-proof.txt'), 'maxEntries=512; zero-external-deps=true\n', 'utf8');

  const disp = await env.tools.get('team_dispatch').execute({
    name: 'impl-cache',
    profile: 'code',
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
    tools: ['read', 'write', 'edit'],
    write_scope: ['src/**'],
    task: 'Implement bounded in-memory LRU in src/engine.js',
    acceptance: ['maxEntries=512 enforced'],
  }, { agent: env.leaderAgent });

  const child = env.spawnedChildren.get(disp.child_id).agent;
  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);

  // 1. Verify Pre-Conference Pause Barrier: member was ALREADY `paused` BEFORE `CONFERENCE_OPENING_SYSTEM` ran!
  assert.equal(conferenceOpenedWhenMemberStatus, 'paused', 'Stage 3 Conference opened ONLY AFTER active member finished checkpointing and paused');
  assert.equal(child.cancelled, false, 'member was stopped via firm checkpoint pause, not forced cancel');
  assert.equal(child.pauseGateVerdict?.decision, 'deny', 'Gate blocked even `read` tool immediately upon pause request');
  assert.equal(child.pauseGateVerdict?.by, 'rule:conference-checkpoint-pause');

  const govEvents = env.store.governanceEvents();
  const idxPausing = govEvents.findIndex(e => e.type === 'conference-pausing');
  const idxBarrierDone = govEvents.findIndex(e => e.type === 'conference-pause-barrier-completed');
  const idxOpened = govEvents.findIndex(e => e.type === 'conference-opened');
  assert.ok(idxPausing >= 0 && idxBarrierDone > idxPausing && idxOpened > idxBarrierDone, 'deterministic barrier event ordering');

  const govDuringConf = replayGovernanceState(govEvents, 1);
  assert.equal(govDuringConf.phase, 'formal_conference');
  const confId = govDuringConf.activeConference.conferenceId;

  // Verify structured handoff checkpoint file was saved on disk:
  const savedCp = env.store.loadMemberCheckpoint(disp.child_id, confId);
  assert.ok(savedCp, 'structured handoff checkpoint file persisted');
  assert.match(savedCp.stoppedAt, /cache eviction helper/);
  assert.match(savedCp.resumePlan, /evictOldest/);

  // 2. Verify BOTH `team_dispatch` AND `team_direct_exec` are DENIED during Stage 3 Formal Conference!
  const blockedOrdinaryDispatch = await env.rt.gate.decide({
    name: 'team_dispatch',
    args: { name: 'impl-extra', profile: 'code', model: 'codex/gpt-6.1-sol', effort: 'medium' },
    agent: env.leaderAgent,
    actor: env.rt.actors.get(env.leaderAgent.id),
  });
  assert.equal(blockedOrdinaryDispatch.decision, 'deny');
  assert.equal(blockedOrdinaryDispatch.by, 'rule:arbiter-conference-active');

  const blockedDirectGate = await env.rt.gate.decide({
    name: 'team_direct_exec',
    args: { task: 'Attempt direct_exec during conference' },
    agent: env.leaderAgent,
    actor: env.rt.actors.get(env.leaderAgent.id),
  });
  assert.equal(blockedDirectGate.decision, 'deny', 'team_direct_exec execution power MUST be revoked during Formal Conference');
  assert.equal(blockedDirectGate.by, 'rule:arbiter-conference-active');
  await assert.rejects(
    () => env.tools.get('team_direct_exec').execute({ task: 'Attempt direct_exec during conference', allow_shell: false }, { agent: env.leaderAgent }),
    /suspended during the conference/,
  );

  // 3. Conclude Conference -> paused member resumes with its saved `STOPPED_AT` / `RESUME_PLAN` checkpoint injected!
  const confRes = await env.tools.get('team_conference').execute({
    action: 'respond',
    conference_id: confId,
    explanation: 'Project requires zero external daemons; bounded 512-entry LRU satisfies spec.',
    new_evidence_files: ['src/lru-proof.txt'],
    proposed_alternative: 'Retain bounded 512-entry LRU',
  }, { agent: env.leaderAgent });

  assert.equal(confRes.status, 'concluded');
  assert.equal(confRes.decision, 'overturn_objection');
  assert.ok(confRes.resumed_members.includes(disp.child_id));
  assert.equal(env.store.getMember(disp.child_id).status, 'running');
  assert.equal(child.followups.length, 1);
  assert.match(child.followups[0].content[0].text, /STOPPED_AT:.*cache eviction helper/);
  assert.match(child.followups[0].content[0].text, /RESUME_PLAN:.*evictOldest/);

  // After conference concludes, `team_direct_exec` is immediately restored!
  const restoredDirectGate = await env.rt.gate.decide({
    name: 'team_direct_exec',
    args: { task: 'Verify src/lru-proof.txt after conference' },
    agent: env.leaderAgent,
    actor: env.rt.actors.get(env.leaderAgent.id),
  });
  assert.equal(restoredDirectGate.decision, 'allow');

  // 4. Verify `conferenceId` Generation Guard (§三): a delayed `STATUS: paused` bound to already-concluded `confId`
  //    NEVER strands the member in `paused` — it deterministically auto-recovers!
  env.store.setMemberGovernanceState(disp.child_id, 'pausing_for_conference', { conferenceId: confId });
  const gateAfterStale = await env.rt.gate.decide({
    name: 'read',
    args: { file_path: 'src/engine.js' },
    agent: child,
    actor: env.rt.actors.get(disp.child_id),
  });
  assert.equal(gateAfterStale.decision, 'allow', 'Gate.decide deterministically clears stale concluded conferenceId pause');

  env.store.setMemberGovernanceState(disp.child_id, 'pausing_for_conference', { conferenceId: confId });
  child.session.events.push({
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: 'STOPPED_AT: delayed turn\nRESUME_PLAN: finish check\nSTATUS: paused' }] },
  });
  onSessionEvent(env.ctx, child.session, { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } });
  assert.equal(env.store.getMember(disp.child_id).status, 'running', 'delayed pause for concluded conferenceId must auto-resume as running, NEVER hang in paused');
  assert.equal(child.followups.length, 2, 'auto-injected immediate continuation followup');
  assert.ok(env.store.governanceEvents().some(e => e.type === 'stale-conference-pause-recovered' && e.staleConferenceId === confId));

  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);
  assert.equal(stage4Payloads.length, 2);
});

test('[§一, §二, §5] Event–Behavior–Chain resists collateral SHA-256 resets on Strike 3, and Arbiter directives require verified completion (never cleared by mere file edits)', async t => {
  // Part A: Pure Event–Behavior–Chain & Auxiliary Evidence Invariants (§一):
  const evt1 = computeEventId({ taskSeq: 1, phaseKind: 'execution', targets: ['src/**'], reviewerTargets: ['src/auth/jwt.js'] });
  const evtRenamed = computeEventId({ taskSeq: 1, phaseKind: 'execution', targets: ['./src/**'], reviewerTargets: ['src/auth/jwt.js'] });
  const evtSibling = computeEventId({ taskSeq: 1, phaseKind: 'execution', targets: ['src/**'], reviewerTargets: ['src/billing/invoice.js'] });
  assert.equal(evt1.eventId, evtRenamed.eventId, 'same pinpointed file anchor produces identical Event ID');
  assert.notEqual(evt1.eventId, evtSibling.eventId, 'unrelated sibling module inside broad src/** stage gets distinct Event ID');

  const beh1 = computeBehaviorIdentity({
    phaseKind: 'execution',
    goal: 'Implement JWT verifier',
    method: 'Decode payload without signature verification',
    interfaces: ['verifyJwt(token)'],
    profile: 'code',
    tools: ['read', 'write', 'edit'],
  });
  const behReordered = computeBehaviorIdentity({
    phaseKind: 'execution',
    goal: 'Implement JWT verifier',
    method: 'Decode payload without signature verification',
    interfaces: ['verifyJwt(token)'],
    profile: 'code',
    tools: ['edit', 'read', 'write'],
  });
  assert.equal(beh1.behaviorId, behReordered.behaviorId, 'Behavior Identity depends on actual decision/contract, NEVER file SHA-256');

  const existing = [];
  const s1 = resolveDisputeStrike(existing, {
    taskSeq: 1,
    phaseKind: 'execution',
    targets: ['src/**'],
    reviewerTargets: ['src/auth/jwt.js'],
    behaviorIdentity: beh1,
    targetFileHashes: { 'src/auth/jwt.js': 'hash_v1' },
  });
  assert.equal(s1.strikeCount, 1);
  existing.push({
    ...s1,
    lastResolvedStrike: 1,
  });

  // Another member edits `src/auth/jwt.js` comments -> SHA-256 changes (`hash_v2_comment`), while actual behavior persists!
  // `resolveDisputeStrike` MUST NOT reset `strikeCount` to 1!
  const s2WithHashChange = resolveDisputeStrike(existing, {
    taskSeq: 1,
    phaseKind: 'execution',
    targets: ['src/**'],
    reviewerTargets: ['src/auth/jwt.js'],
    behaviorIdentity: beh1,
    targetFileHashes: { 'src/auth/jwt.js': 'hash_v2_collateral_edit' },
  });
  assert.equal(s2WithHashChange.disputeChainId, s1.disputeChainId, 'collateral SHA-256 change does NOT reset disputeChainId');
  assert.equal(s2WithHashChange.strikeCount, 2, 'collateral SHA-256 change does NOT reset strikeCount to 1');
  assert.equal(s2WithHashChange.needsContinuityVerification, true, 'routes auxiliary hash diff to Stage 2 Arbiter continuity check');
  assert.deepEqual(s2WithHashChange.evidenceSnapshot.changedFiles, ['src/auth/jwt.js']);

  // Stage 4 re-review ALWAYS stays on parent chain without even needing continuity verification, even if files changed!
  const s2Stage4 = resolveDisputeStrike(existing, {
    taskSeq: 1,
    phaseKind: 'execution',
    targets: ['src/**'],
    parentDisputeId: s1.disputeChainId,
    isStage4ReReview: true,
    targetFileHashes: { 'src/auth/jwt.js': 'hash_v3_concurrent' },
  });
  assert.equal(s2Stage4.disputeChainId, s1.disputeChainId);
  assert.equal(s2Stage4.strikeCount, 2);
  assert.equal(s2Stage4.needsContinuityVerification, false);
  existing[0].strikeCount = 2;
  existing[0].lastResolvedStrike = 2;

  // Conversely, at planning stage (file SHA-256 UNCHANGED on disk!), Leader genuinely replaces method with HMAC-SHA256 verification:
  const behFixed = computeBehaviorIdentity({
    phaseKind: 'execution',
    goal: 'Implement JWT verifier',
    method: 'Verify RS256/HS256 cryptographic signature using node:crypto timingSafeEqual',
    interfaces: ['verifyJwt(token, secret)'],
    profile: 'code',
    tools: ['read', 'write', 'edit'],
  });
  const sChangedPlan = resolveDisputeStrike(existing, {
    taskSeq: 1,
    phaseKind: 'execution',
    targets: ['src/**'],
    reviewerTargets: ['src/auth/jwt.js'],
    behaviorIdentity: behFixed,
    targetFileHashes: { 'src/auth/jwt.js': 'hash_v1' }, // Disk hash UNCHANGED!
    continuityVerdict: 'substantive_behavior_changed',
  });
  assert.notEqual(sChangedPlan.disputeChainId, s1.disputeChainId, 'substantive behavior change opens Chain #2 even when disk hash has not changed yet');
  assert.equal(sChangedPlan.eventId, s1.eventId, 'remains linked to the same underlying Event ID');
  assert.equal(sChangedPlan.strikeCount, 1);

  // Part B: Runtime Directive Verification (§二) + Collateral Hash Edit Strike-3 Escalation (§一):
  let conferenceOpenings = 0;
  let directiveVerifyCalls = 0;
  let engineFixedProperly = false;

  const cfg = autonomousConfig({ governance: { autoSuperviseStages: false, autoSuperviseDispatches: true } });
  const env = makeAutonomousEnv(t, cfg, async req => {
    const sys = String(req.system ?? '');
    if (sys.includes('verifying whether a binding corrective directive')) {
      directiveVerifyCalls++;
      if (!engineFixedProperly) {
        return { message: { content: [{ type: 'text', text: '{"satisfied":false,"verified_items":[],"missing_items":["src/engine.js still uses eval() instead of AST parser"],"reason":"Only a comment changed; eval() is still present."}' }] } };
      }
      return { message: { content: [{ type: 'text', text: '{"satisfied":true,"verified_items":["Replaced eval() with safe AST parser"],"missing_items":[],"reason":"AST parser verified in src/engine.js."}' }] } };
    }
    if (sys.includes('independently review a team leader stopping work')) {
      return { message: { content: [{ type: 'text', text: '{"action":"stop","reason":"ok","directive":""}' }] } };
    }
    if (sys.includes('asynchronous supervisor')) {
      return { message: { content: [{ type: 'text', text: '{"stance":"object","intervene":true,"summary":"src/engine.js uses unsafe eval()","concerns":["eval() security defect"],"suggestions":["Replace eval() with AST parser"],"target_paths":["src/engine.js"]}' }] } };
    }
    if (sys.includes('Stage 2 (3-Party Internal Caucus')) {
      if (sys.includes('You are the Independent Arbiter')) {
        return { message: { content: [{ type: 'text', text: '{"escalate_to_conference":true,"rationale":"eval() persists despite file edit","fact_findings":["eval() still in src/engine.js"],"initial_expectation":"Replace eval() with AST parser","questions_for_leader":["Why is eval() used?"],"dispute_continuity":"same_behavior_persists","prior_directive_satisfied":false}' }] } };
      }
      return { message: { content: [{ type: 'text', text: '{"escalate_to_conference":true,"rationale":"Convene conference","initial_expectation":"Replace eval()"}' }] } };
    }
    if (sys.includes('opening a Stage 3 Formal 2-Party Conference')) {
      conferenceOpenings++;
      return { message: { content: [{ type: 'text', text: '{"opening_statement":"Opening conference on eval()","key_questions":["Will you replace eval()?"]}' }] } };
    }
    if (sys.includes('in a Stage 3 Formal 2-Party Conference')) {
      return { message: { content: [{ type: 'text', text: '{"status":"concluded","decision":"enforce_correction","ruling_summary":"Must replace eval() with safe AST parser","delta_from_initial_expectation":"Enforced caucus expectation","binding_directives":["Replace eval() in src/engine.js with safe AST parser"],"blocked_targets":["src/engine.js"],"member_resume_policy":"resume_all"}' }] } };
    }
    throw new Error(`Unexpected LLM call: ${sys}`);
  });

  process.env.LEADERTEAM_HEADLESS_LEADER = '1';
  fs.writeFileSync(path.join(env.ws, 'src', 'engine.js'), 'export const run = x => eval(x);\n', 'utf8');

  // Strike 1 -> Conference #1 (`enforce_correction`!)
  const disp1 = await env.tools.get('team_dispatch').execute({
    name: 'impl-eval-1',
    profile: 'code',
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
    tools: ['read', 'write', 'edit'],
    write_scope: ['src/**'],
    task: 'Implement expression runner',
    acceptance: ['Runs expressions'],
  }, { agent: env.leaderAgent });
  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);
  assert.equal(conferenceOpenings, 1);

  // Conclude Conference #1 (`enforce_correction`), AND simulate collateral file change BEFORE Stage 4 finishes:
  fs.writeFileSync(path.join(env.ws, 'src', 'engine.js'), '// added comment only\nexport const run = x => eval(x);\n', 'utf8');
  await env.tools.get('team_conference').execute({
    action: 'respond',
    explanation: 'Acknowledged.',
  }, { agent: env.leaderAgent });

  // Wait for Stage 4 re-review -> Strike 2 -> Conference #2 (collateral file change did NOT reset Strike 2!)
  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);
  let gov = replayGovernanceState(env.store.governanceEvents(), 1);
  assert.equal(conferenceOpenings, 2, 'Stage 4 re-objection incremented to Strike 2 despite file SHA-256 modification');
  assert.equal(gov.activeConference?.strike, 2);

  // Conclude Conference #2 -> wait for Stage 4 -> Strike 3 Direct Human Escalation!
  // Wait: first test Directive Verification before Strike 3 by checking `activeDirectives` was NEVER cleared by the comment edit!
  assert.equal(gov.activeDirectives.length, 1, 'mere file SHA-256 modification NEVER auto-clears active Arbiter directive');

  // Complete a cosmetic `direct_exec` after Conference #2 concludes, while temporarily pausing Stage 4 reviewers?
  // Even simpler: resolve Conference #2 -> Stage 4 triggers Strike 3 Human Escalation (proving 0 3rd conference!),
  // AND test `verifyActiveArbiterDirectives` directly against an active directive with cosmetic vs real fix!
  await env.tools.get('team_conference').execute({
    action: 'respond',
    explanation: 'Still keeping eval for now.',
  }, { agent: env.leaderAgent });
  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);

  gov = replayGovernanceState(env.store.governanceEvents(), 1);
  assert.equal(conferenceOpenings, 2, 'NO 3rd conference opened on Strike 3!');
  assert.equal(gov.phase, 'human_escalation');
  assert.equal(gov.activeHumanEscalation?.strike, 3);

  // Resolve human escalation, then record an active `enforce_correction` directive and verify §二:
  await resolveHumanEscalationOnUserTurn({
    ctx: env.ctx,
    rt: env.rt,
    store: env.store,
    leaderAgent: env.leaderAgent,
    taskSeq: 1,
    userText: '请按裁断要求把 eval 改成 AST 解析器后再交付',
  });
  env.store.setMemberStatus(disp1.child_id, 'done');
  await new Promise(r => setTimeout(r, 15));
  env.store.appendGovernanceEvent({
    type: 'conference-concluded',
    taskSeq: 1,
    conferenceId: 'conf-dir-check',
    disputeId: 'chain-dir-check',
    targets: ['src/engine.js'],
    ruling: {
      decision: 'enforce_correction',
      rulingSummary: 'Must replace eval() with AST parser',
      deltaFromInitialExpectation: 'Same',
      bindingDirectives: ['Replace eval() in src/engine.js with AST parser'],
      blockedTargets: [],
      memberResumePolicy: 'resume_all',
    },
  });

  // 1) Before any post-conference execution runs -> deterministic failure with 0 Arbiter LLM calls!
  const verNoExec = await verifyActiveArbiterDirectives({
    rt: env.rt,
    store: env.store,
    actor: env.rt.actors.get(env.leaderAgent.id),
    taskSeq: 1,
  });
  assert.equal(verNoExec.allSatisfied, false);
  assert.equal(directiveVerifyCalls, 0, 'rejected deterministically with 0 LLM calls when no post-conference execution occurred');

  // 2) Run a post-conference `team_direct_exec` that only changes a comment (SHA-256 changes, `eval()` remains!) -> STILL rejected!
  await env.tools.get('team_direct_exec').execute({
    task: 'Touch comment in src/engine.js',
    write_scope: ['src/**'],
    allow_shell: false,
  }, { agent: env.leaderAgent });
  fs.writeFileSync(path.join(env.ws, 'src', 'engine.js'), '// second comment edit\nexport const run = x => eval(x);\n', 'utf8');

  const verCosmetic = await verifyActiveArbiterDirectives({
    rt: env.rt,
    store: env.store,
    actor: env.rt.actors.get(env.leaderAgent.id),
    taskSeq: 1,
  });
  assert.equal(verCosmetic.allSatisfied, false, 'cosmetic file hash change MUST NOT satisfy Arbiter directive');
  assert.equal(directiveVerifyCalls, 1);
  assert.equal(replayGovernanceState(env.store.governanceEvents(), 1).activeDirectives.length, 1);

  // 3) Genuine AST fix written & verified -> `arbiter-directive-satisfied` recorded!
  engineFixedProperly = true;
  fs.writeFileSync(path.join(env.ws, 'src', 'engine.js'), 'export const run = ast => ast.left + ast.right;\n', 'utf8');
  const verReal = await verifyActiveArbiterDirectives({
    rt: env.rt,
    store: env.store,
    actor: env.rt.actors.get(env.leaderAgent.id),
    taskSeq: 1,
  });
  assert.equal(verReal.allSatisfied, true);
  assert.equal(replayGovernanceState(env.store.governanceEvents(), 1).activeDirectives.length, 0, 'directive cleared ONLY after concrete fix verified');
});

test('[Step 4 Ledger Dedupe & Coalescing] Same stageHash deduplicates across team_plan + team_discuss + team_dispatch, and concurrent Stage 1 objections coalesce without double-counting strikes', async t => {
  let reviewerCalls = 0;
  let conferenceOpenings = 0;
  const cfg = autonomousConfig({ governance: { autoSuperviseStages: true, autoSuperviseDispatches: true } });
  const env = makeAutonomousEnv(t, cfg, async req => {
    const sys = String(req.system ?? '');
    if (sys.includes('asynchronous supervisor')) {
      reviewerCalls++;
      return { message: { content: [{ type: 'text', text: '{"stance":"object","intervene":true,"summary":"Severe defect","concerns":["Defect"],"suggestions":["Fix defect"],"target_paths":["src/engine.js"]}' }] } };
    }
    if (sys.includes('Stage 2 (3-Party Internal Caucus')) {
      return { message: { content: [{ type: 'text', text: '{"escalate_to_conference":true,"rationale":"Open conference","fact_findings":[],"initial_expectation":"Fix","questions_for_leader":["Why?"]}' }] } };
    }
    if (sys.includes('opening a Stage 3 Formal 2-Party Conference')) {
      conferenceOpenings++;
      return { message: { content: [{ type: 'text', text: '{"opening_statement":"Opening","key_questions":["Why?"]}' }] } };
    }
    return { message: { content: [{ type: 'text', text: '{}' }] } };
  });

  process.env.LEADERTEAM_HEADLESS_LEADER = '1';
  await env.tools.get('team_plan').execute({
    action: 'overview',
    summary: 'Dedupe check',
    approach: 'Single stage',
    acceptance: ['ok'],
    estimated_minutes: 2,
    future_work: ['s1'],
  }, { agent: env.leaderAgent });

  await env.tools.get('team_plan').execute({
    action: 'stage',
    stage_id: 's1',
    goal: 'Build engine',
    method: 'Draft method',
    acceptance: ['ok'],
    interfaces: ['v'],
    profile: 'code',
    tools: ['read', 'write', 'edit'],
    write_scope: ['src/**'],
    serial_reason: 'single',
    ready: true,
  }, { agent: env.leaderAgent });

  // Immediately call both `team_discuss(kind="plan", stage_id="s1")` AND `team_dispatch(stage_id="s1")` before disk changes:
  await env.tools.get('team_discuss').execute({
    kind: 'plan',
    stage_id: 's1',
    topic: 'Check s1',
  }, { agent: env.leaderAgent });

  const disp = await env.tools.get('team_dispatch').execute({
    name: 'impl-s1',
    stage_id: 's1',
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
  }, { agent: env.leaderAgent });

  // Also queue an overlapping manual supervision while Conference #1 is opening / active:
  env.store.setMemberStatus(disp.child_id, 'paused');
  fs.writeFileSync(path.join(env.ws, 'src', 'engine.js'), 'export const version = 2;\n', 'utf8');
  await env.tools.get('team_discuss').execute({
    kind: 'architecture',
    topic: 'Concurrent architecture check on src/engine.js while Strike 1 conference is still unresolved',
    proposal: 'Check engine',
    evidence_files: ['src/engine.js'],
  }, { agent: env.leaderAgent });

  await awaitTeamGovernanceJobs(env.rt, env.leaderAgent.id, 5000);

  // `team_plan` + `team_discuss(plan)` + `team_dispatch` ran ONLY 1 supervision (2 reviewer calls), plus 1 architecture supervision (2 reviewer calls) = 4 total!
  assert.equal(reviewerCalls, 4, 'unchanged stageHash across team_plan + team_discuss + team_dispatch fired only 1 Stage 1 supervision');
  assert.equal(conferenceOpenings, 1, 'concurrent Stage 1 objection coalesced into active Strike 1 conference instead of opening a 2nd parallel conference');
  const gov = replayGovernanceState(env.store.governanceEvents(), 1);
  assert.equal(gov.activeConference?.strike, 1, 'strikeCount stayed at 1 while Strike 1 conference remained open');
  assert.ok(env.store.governanceEvents().some(e => e.type === 'supervision-coalesced-into-active-dispute'));
});

test('[Stop-Review Hardening & Anti-Detour] Rehydrated shell ACL failure stops deterministically; 2nd stop escalates to Arbiter; 3rd stop hits hard cap without quota spin', async t => {
  // 1. Two-tier obstacle prompt invariants (auto-solve local obstacles vs stop cleanly on global blockers):
  assert.match(STOP_REVIEW_SYSTEM, /TWO-TIER OBSTACLE RULE/);
  assert.match(STOP_REVIEW_SYSTEM, /STRICT ANTI-DETOUR RULE.*%TEMP%/);
  assert.match(STOP_REVIEW_ARBITER_SYSTEM, /NECESSARY IN-SCOPE PROGRESS vs POINTLESS DETOURS/);
  assert.match(INVESTIGATOR_SYSTEM, /NEVER suggest copying workspaces to %TEMP%/);
  assert.match(leaderSection(autonomousConfig()), /Two-Tier Obstacle Rule/);

  // 2a. When shell is broken (Win32 5) BUT unblocked non-shell code stages (`m2-ui` in future_work) still remain,
  //     do NOT prematurely interrupt the user — allow autonomous continuation to finish M2 in-place!
  let midTaskCalls = 0;
  const cfg = autonomousConfig({ governance: { autoSuperviseStages: false, autoSuperviseDispatches: false } });
  const envMid = makeAutonomousEnv(t, cfg, async () => {
    midTaskCalls++;
    return { message: { content: [{ type: 'text', text: '{"action":"continue","reason":"m2-ui is a pure code stage and does not require shell","directive":"Implement m2-ui in-place using read/write/edit first, then report shell verification pending at the end."}' }] } };
  });
  process.env.LEADERTEAM_HEADLESS_LEADER = '1';
  await envMid.tools.get('team_plan').execute({
    action: 'overview',
    summary: 'Build reader and UI',
    approach: 'M1 then M2 then verify',
    acceptance: ['Done'],
    estimated_minutes: 30,
    future_work: ['m2-ui', 'runtime-verify'],
  }, { agent: envMid.leaderAgent });
  envMid.store.addMember({
    childId: 'shell-early',
    name: 'early-probe',
    profile: 'shell',
    taskSeq: 1,
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
    allowedTools: ['read', 'pwsh'],
    loadedTools: ['read'],
    writeScope: ['scratch/**'],
    cwd: envMid.ws,
  });
  envMid.store.setMemberTools('shell-early', ['read'], 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\\workspace)');
  envMid.store.setMemberStatus('shell-early', 'blocked');

  envMid.leaderAgent.session.events.push({ type: 'turn/start', data: { turn: 2 } });
  await envMid.tools.get('team_status').execute({
    stop_state: 'waiting_user',
    reason: 'M1 code finished; shell ACL is broken so asking before starting M2.',
    question: 'Should I proceed with M2 or wait for ACL repair?',
  }, { agent: envMid.leaderAgent });
  envMid.leaderAgent.session.events.push(
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'Pausing before M2.' }] } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  );
  envMid.leaderAgent.status = 'idle';
  onAgentStatus(envMid.ctx, { agent: envMid.leaderAgent, status: 'idle' });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(midTaskCalls, 1, 'evaluates mid-project stop so unblocked M2 code stage continues without interrupting user');
  assert.equal(envMid.leaderAgent.followups.length, 1);
  assert.match(envMid.leaderAgent.followups[0].content[0].text, /Implement m2-ui in-place/);

  // 2b. Once all non-shell code work IS complete (only global Win32 5 shell blocker remains), stop deterministically with 0 LLM calls!
  let llmCalls = 0;
  const env1 = makeAutonomousEnv(t, cfg, async () => {
    llmCalls++;
    return { message: { content: [{ type: 'text', text: '{"action":"continue","reason":"should never run","directive":"noop"}' }] } };
  });
  process.env.LEADERTEAM_HEADLESS_LEADER = '1';

  // Simulate a prior shell member whose Win32 5 failure is persisted in members.jsonl, while in-memory workspaceShellFailures was cleared by restart:
  env1.store.addMember({
    childId: 'shell-m1',
    name: 'runtime-verify',
    profile: 'shell',
    taskSeq: 1,
    model: 'codex/gpt-6.1-sol',
    effort: 'medium',
    allowedTools: ['read', 'pwsh'],
    loadedTools: ['read', 'pwsh'],
    writeScope: ['scratch/**'],
    cwd: env1.ws,
  });
  env1.store.setMemberTools('shell-m1', ['read'], 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\\workspace)');
  env1.store.setMemberStatus('shell-m1', 'blocked');
  assert.equal(env1.rt.workspaceShellFailures?.size ?? 0, 0, 'in-memory map is empty as after host restart');

  env1.leaderAgent.session.events.push({ type: 'turn/start', data: { turn: 2 } });
  await env1.tools.get('team_status').execute({
    stop_state: 'waiting_user',
    reason: 'OS sandbox initialization failed (Win32 5 ACL) and all code stages are complete.',
    question: 'Approve workspace ACL repair or run tests manually?',
  }, { agent: env1.leaderAgent });
  env1.leaderAgent.session.events.push(
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'Waiting for ACL decision.' }] } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  );
  env1.leaderAgent.status = 'idle';
  onAgentStatus(env1.ctx, { agent: env1.leaderAgent, status: 'idle' });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(llmCalls, 0, 'verified persisted shell ACL failure stops deterministically with ZERO LLM calls');
  assert.equal(env1.leaderAgent.followups.length, 0, 'leader stays cleanly stopped without detour followup');
  assert.equal(env1.store.workflowEvents().filter(e => e.type === 'stop-reviewed').at(-1)?.result?.deterministic, true);

  // 3. Non-deterministic stop disagreement: 1st check uses discussA -> 2nd escalates to Arbiter -> 3rd hits hard cap (0 LLM calls)!
  const calledSystems = [];
  const env2 = makeAutonomousEnv(t, cfg, async req => {
    calledSystems.push(String(req.system ?? ''));
    return { message: { content: [{ type: 'text', text: '{"action":"continue","reason":"More in-place work remains","directive":"Complete the next in-place step."}' }] } };
  });
  const leaderActor = env2.rt.actors.get(env2.leaderAgent.id);

  const r1 = await reviewStop(
    env2.rt,
    env2.store,
    leaderActor,
    env2.leaderAgent,
    stopDeclaration({ stop_state: 'waiting_user', reason: 'Checkpoint 1', question: 'Continue phase 1?' }, 1, 1),
    { activeMembers: 0, workspaceShellFailure: null, hitHardTerminalBlocker: false, hasDispatchableNonShellWork: true },
    'Build token ledger',
  );
  assert.equal(r1.action, 'continue');
  assert.equal(r1.escalatedToArbiter, undefined);
  assert.equal(env2.store.usageRecords().at(-1)?.role, 'discussA');
  assert.equal(env2.store.usageRecords().at(-1)?.purpose, 'stop-review');

  const r2 = await reviewStop(
    env2.rt,
    env2.store,
    leaderActor,
    env2.leaderAgent,
    stopDeclaration({ stop_state: 'waiting_user', reason: 'Checkpoint 2', question: 'Need pricing confirmation?' }, 1, 2),
    { activeMembers: 0, workspaceShellFailure: null, hitHardTerminalBlocker: false, hasDispatchableNonShellWork: true },
    'Build token ledger',
  );
  assert.equal(r2.action, 'continue');
  assert.equal(r2.escalatedToArbiter, true, '2nd stop declaration escalates to Independent Arbiter');
  assert.equal(env2.store.usageRecords().at(-1)?.role, 'arbiter');
  assert.equal(env2.store.usageRecords().at(-1)?.purpose, 'stop-review-arbiter');
  assert.equal(calledSystems.length, 2);

  const r3 = await reviewStop(
    env2.rt,
    env2.store,
    leaderActor,
    env2.leaderAgent,
    stopDeclaration({ stop_state: 'waiting_user', reason: 'Checkpoint 3', question: 'Still waiting on pricing policy?' }, 1, 3),
    { activeMembers: 0, workspaceShellFailure: null, hitHardTerminalBlocker: false, hasDispatchableNonShellWork: true },
    'Build token ledger',
  );
  assert.equal(r3.action, 'stop', '3rd stop declaration hits hard cap and yields directly to user');
  assert.equal(r3.capped, true);
  assert.equal(calledSystems.length, 2, 'zero additional LLM calls once MAX_STOP_REVIEW_CONTINUES (2) is reached');
});

test('team_direct_exec automatically falls back to roles.directExec.fallback when primary model call fails before any workspace tool runs', async t => {
  const cfg = autonomousConfig({
    roles: {
      directExec: {
        route: 'zcode/GLM-5.3-Flash',
        effort: 'low',
        timeoutMs: 60000,
        retries: 1,
        fallback: [{ route: 'zcode/GLM-5.3', effort: 'low', timeoutMs: 60000, retries: 1 }],
      },
    },
  });

  const attemptedModels = [];
  const env = makeAutonomousEnv(
    t,
    cfg,
    async () => JSON.stringify({ stance: 'endorse', intervene: false, summary: 'ok', concerns: [], suggestions: [], target_paths: [] }),
    {
      directExecHook: async (_childAgent, actOpts) => {
        const modelId = actOpts.agentOptions?.model ?? actOpts.request?.agentOptions?.model ?? 'unknown';
        attemptedModels.push(modelId);
        if (attemptedModels.length === 1) {
          return {
            output: [{ type: 'text', text: 'Upstream model unavailable (HTTP 404 model retired)' }],
            stopReason: { kind: 'error' },
          };
        }
        return {
          output: [{ type: 'text', text: 'Recovered on fallback route.\nSTATUS: done' }],
          stopReason: { kind: 'completed' },
        };
      },
    },
  );

  const res = await env.tools.get('team_direct_exec').execute(
    { task: 'Inspect src/engine.js version export', allow_shell: false },
    { agent: env.leaderAgent },
  );
  assert.equal(attemptedModels.length, 2, 'must retry on fallback route after primary model failure');
  assert.equal(res.model, 'zcode/GLM-5.3');
  assert.equal(res.stop_reason, 'completed');
  assert.match(res.degraded_role ?? '', /fallback route zcode\/GLM-5\.3/);
});
