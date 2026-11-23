import { scriptedReview } from '../scripted-review.mjs';
// V1.1.1 hardening (2026-11-14): bounded behaviour during safety-review outages, governance-role route chains,
// rule-only leader notes, cache-friendly gate requests, control-only user messages, and real progress for auto-continuation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { configWith } from './helpers.mjs';
import { roleRouteChain } from '../../leaderteam/core/role-routes.mjs';
import { buildGateRequest, isReadGrantOnlyMessage, isBareContinueMessage } from '../../leaderteam/core/gate-policy.mjs';
import { validateConfig } from '../../leaderteam/core/config.mjs';
import { recordOverview, recordStage } from '../../leaderteam/core/frontier.mjs';
import { resolveMemberRefs } from '../../leaderteam/core/member-refs.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: `virtual-hardening:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-hardening:@deepseek-ai/dsh-tools') return { format: 'module', shortCircuit: true, source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";' };
    if (url === 'virtual-hardening:@deepseek-ai/dsh-tools/pipeline') return { format: 'module', shortCircuit: true, source: 'export class ToolExecutionPipeline { resolveExecution(){ return { execute: async a => ({content:[{type:"text",text:"ok"}]}) }; } async dispatchToolBody(e){ return await this.resolveExecution().execute(e.arguments,e); } }' };
    if (url === 'virtual-hardening:@deepseek-ai/dsh-tools/package.json') return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.1' }) };
    if (url === 'virtual-hardening:@deepseek-ai/dsh-llm') return { format: 'module', shortCircuit: true, source: 'export class BlockAssembler { constructor(){this._b=[];} push(c){ if(c.type==="text") this._b.push(c);} blocks(){return this._b;} }' };
    return nextLoad(url, context);
  },
});
const { callJson, callRoleJson } = await import('../../leaderteam/host/llm.mjs');
const { runtime, teamStore } = await import('../../leaderteam/host/runtime.mjs');
const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const { Gate } = await import('../../leaderteam/host/final-gate.mjs');
const { onAgentStatus, currentTaskSeq } = await import('../../leaderteam/host/roles.mjs');
const { assertActivationAdmission, resumeAdmission, withMemberActivation } = await import('../../leaderteam/host/activation.mjs');
const { stopDeclaration, reviewStop } = await import('../../leaderteam/host/stop-review.mjs');

const SOL = 'codex/gpt-6.1-sol', GLM = 'zcode/GLM-5.3';
const ALLOW = '{"decision":"allow","risk":"low","reason":"ok"}', DENY = '{"decision":"deny","risk":"high","reason":"no"}';
/** Scripted model: `answer(model)` returns a text, or null for an upstream 502. Records every model called. */
function scriptedLlm(answer) {
  const calls = [];
  return { calls, async *stream(req) { calls.push(req.model); const a = answer(req.model, req); if (a === null) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'EOF (502)' } } }; return; } yield { type: 'text', text: scriptedReview(a, req.messages?.[0]?.content?.[0]?.text ?? '{}') }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
}
const noRetry = cfg => Object.fromEntries(Object.entries(cfg.roles).map(([k, r]) => [k, k === 'leader' ? r : { ...r, retries: 0, ...(r.fallback ? { fallback: r.fallback.map(f => ({ ...f, retries: 0 })) } : {}) }]));

test('bounded schema recovery supplies the actual validation error while valid denials remain terminal', async () => {
  const requests = [];
  const llm = { async *stream(req) {
    requests.push(req);
    yield { type: 'text', text: requests.length === 1 ? '{"decision":"deny"}' : '{"decision":"deny","reason":"Outside approved scope"}' };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const parse = text => { const v = JSON.parse(text); return v.reason ? { ok: true, value: v } : { ok: false, error: 'missing reason for denied operation' }; };
  const req = { provider: 'magpie', model: GLM, effort: 'low', system: 'Judge the original scope', user: '{"operation":"write"}', maxTokens: 200, timeoutMs: 2000 };
  const r = await callJson(llm, req, parse, 1);
  assert.equal(r.ok, true); assert.equal(r.value.decision, 'deny'); assert.equal(r.attempts, 2);
  assert.equal(requests[1].messages[0].content[0].text, req.user);
  assert.match(requests[1].messages[1].content[0].text, /missing reason for denied operation/);
  assert.equal(requests[1].system, req.system); assert.equal(requests[1].maxTokens, 200);
  assert.equal(r.usage.totalTokens, 30);
  const before = requests.length;
  assert.equal((await callJson(llm, req, parse, 2)).value.decision, 'deny');
  assert.equal(requests.length - before, 1, 'a valid denial is never asked again');
});

function memberSetup(t, { llm, gate = {} }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-hard-m-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  const cfg = configWith({ storage: { root: path.join(tmp, 'store') }, quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true }, gate: { sandboxDirectAllow: false, ...gate }, roles: noRetry(configWith({})) });
  const rt = runtime(); const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores), reads: new Map(rt.reads) }; t.after(() => Object.assign(rt, prev));
  const agent = { id: 'm1', session: { header: { cwd: ws, origin: 'subagent', parentSession: 'team1' } } };
  const actor = { role: 'member', teamId: 'team1', agentId: 'm1', agent, name: 'dev', profile: 'code', allowedTools: cfg.profiles.code.tools, writeScope: ['src/**'], refs: [], task: 't', acceptance: ['a'], userTask: 'u', cwd: ws };
  Object.assign(rt, { config: cfg, storageRoot: path.join(tmp, 'store'), llm, surface: 'headless', actors: new Map([['m1', actor]]), reads: new Map(), stores: new Map(), counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 }, inFlightGateReviews: new Map() });
  const store = teamStore('team1'); store.ensure({ workspace: ws, surface: 'headless' });
  let n = 0;
  const write = file => new Gate({}).decide({ name: 'write', args: { file_path: file ?? `src/f${n}.js`, content: '1' }, agent, actor, callId: `c${n++}` });
  return { cfg, rt, agent, actor, store, write, ws };
}

function leaderSetup(t, { llm, extra = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-hard-l-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(path.join(ws, '.leaderteam', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.leaderteam', 'refs', 'plan.md'), '# Full plan\n');
  const cfg = configWith({ storage: { root: path.join(tmp, 'store') }, quota: { stateFile: null, allowUnknown: true, allowUnknownGpt: true }, roles: noRetry(configWith({})), ...extra });
  const rt = runtime(); const prev = { ...rt, actors: new Map(rt.actors), stores: new Map(rt.stores) }; t.after(() => Object.assign(rt, prev));
  const sessionEvents = [{ type: 'user/message', time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build app' }] } }];
  const followups = [];
  const leaderAgent = { id: 'leader1', inbox: { nextTurn: [], nextStep: [] }, followup(m) { followups.push(m); sessionEvents.push({ type: 'user/message', data: m }); }, session: { seq: 1, header: { cwd: ws }, snapshotEvents: () => sessionEvents }, model: { current: () => ({ provider: cfg.magpie.provider, model: cfg.roles.leader.route, reasoningEffort: cfg.roles.leader.effort }) } };
  const model = llm ?? scriptedLlm(() => '{"stance":"approve","summary":"ok","reasons":["ok"],"required_changes":[]}');
  const tools = new Map();
  const ctx = { effect(fn) { return fn(); }, tools: { register(d) { tools.set(d.name, d); }, definitions() { return [{ name: 'read', description: 'r' }, { name: 'write', description: 'w' }, { name: 'edit', description: 'e' }, { name: 'glob', description: 'g' }, { name: 'grep', description: 'g' }]; } },
    get(k) { if (k === 'agentPresets') return { presetForSession: () => cfg.profiles.leader.preset, async acquireScope() { return { key: {}, async [Symbol.asyncDispose]() {} }; } }; return null; },
    subagents: { async startActivation({ childId }) { return { childId }; } } };
  Object.assign(rt, { config: cfg, storageRoot: path.join(tmp, 'store'), llm: model, surface: 'headless', hostAgents: new Map([[leaderAgent.id, leaderAgent]]), liveProcessMemberIds: new Set(), actors: new Map([[leaderAgent.id, { role: 'leader', teamId: leaderAgent.id, agentId: leaderAgent.id, agent: leaderAgent, cwd: ws, allowedTools: cfg.profiles.leader.tools }]]), stores: new Map(), autoContinueState: new Map(), counters: { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 }, inFlightGateReviews: new Map() });
  const store = teamStore(leaderAgent.id); store.ensure({ workspace: ws, surface: 'headless' });
  registerTeamTools(ctx);
  const call = (name, args) => tools.get(name).execute(args, { agent: leaderAgent });
  const userSays = (text, time) => sessionEvents.push({ type: 'user/message', ...(time === undefined ? {} : { time }), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  const endTurn = (text, kind = 'completed') => { sessionEvents.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }, { type: 'turn/end', data: { turn: 1, reason: { kind } } }); onAgentStatus(ctx, { agent: leaderAgent, status: 'idle' }); };
  return { cfg, rt, ws, ctx, store, call, userSays, endTurn, followups, leaderAgent, model };
}

test('leader output truncation before plan approval continues across single-turn limits and triggers circuit investigator at soft threshold; user interruption never resumes', async t => {
  const s = leaderSetup(t, {
    llm: scriptedLlm(() => '{"diagnosis":"Leader truncated before issuing first plan call","classification":"recoverable_loop","action":"steer_agent","recovery_directive":"Issue team_note(scope=current_plan) immediately without long preamble","recommended_adjustments":{"load_tools":[],"leader_max_parallel":null}}'),
  });
  s.endTurn('partial plan', 'interrupted');
  await new Promise(r=>setTimeout(r,0));
  assert.equal(s.followups.length,0);
  for (let i=0;i<5;i++) {
    s.endTurn('partial plan', 'max-tokens');
    await new Promise(r=>setTimeout(r,15));
  }
  assert.ok(s.followups.length >= 5, 'all 5 single-turn truncations auto-continue instead of terminating at 3');
  assert.match(JSON.stringify(s.followups[0]), /output recovery/);
  assert.ok(s.store.workflowEvents().some(e => e.type === 'circuit-investigation' && e.tier === 'soft' && e.node === 'zero_progress_truncations'), 'soft circuit-breaker investigator fires on 5th zero-progress truncation');
  assert.equal(currentTaskSeq(s.ctx,s.leaderAgent.id),1);
  assert.equal(s.store.members().size,0,'recovery cannot dispatch without approval');
});

test('rolling planning does not turn a real member wait into polling; missing members still trigger recovery', async t => {
  const s = leaderSetup(t, { extra: { team: { rollingPlanning: true } } });
  recordOverview(s.store, 1, { summary: 'Modular tool', approach: 'A then B', acceptance: ['Verified output'], estimated_minutes: 15, future_work: ['module-a','module-b'] });
  const a=recordStage(s.store, 1, { stage_id:'module-a',goal:'Implement A',method:'Use contract',acceptance:['Verified A'],interfaces:['JSON'],profile:'code',tools:['read','write'],write_scope:['src/a/**'],parallel_with:['module-b'],ready:true }).stage;
  s.store.addMember({childId:'worker-a',name:'worker-a',profile:'code',taskSeq:1,stageId:a.id,stageHash:a.hash,model:GLM,effort:'high',writeScope:['src/a/**']});
  s.store.setMemberStatus('worker-a','running');s.rt.liveProcessMemberIds.add('worker-a');
  s.store.appendWorkflowEvent({type:'stop-declared',taskSeq:1,turn:1,state:'waiting_members',reason:'Waiting for actual member'});
  s.endTurn('Waiting for A; completion will wake me.');await new Promise(r=>setTimeout(r,0));
  assert.equal(s.followups.length,0,'a provisional/missing B is not permission to repeatedly wake a genuine wait');
  assert.equal(s.model.calls.length,0,'a deterministic wait needs no paid stop review');
  s.store.setMemberStatus('worker-a','cancelled');
  s.endTurn('Waiting for A.');await new Promise(r=>setTimeout(r,0));
  assert.equal(s.followups.length,1,'a false wait with no member must still recover');
});

test('a pending current review can wait without repeatedly expanding provisional placeholders', async t => {
  const s=leaderSetup(t,{extra:{team:{rollingPlanning:true}}});
  recordOverview(s.store,1,{summary:'A modular tool',approach:'Review A while planning B',acceptance:['Actual output'],estimated_minutes:15,future_work:['module-a','module-b']});
  const a=recordStage(s.store,1,{stage_id:'module-a',goal:'Implement A',method:'Use contract',acceptance:['Verify A'],interfaces:['JSON'],profile:'code',tools:['read','write'],write_scope:['a/**'],parallel_with:['module-b'],ready:true}).stage;
  recordStage(s.store,1,{stage_id:'module-b',goal:'Later work using A',depends_on:['module-a'],ready:false});
  s.store.appendWorkflowEvent({type:'execution-review-queued',taskSeq:1,reviewId:'pending-a',stageId:a.id,stageHash:a.hash});
  await s.call('team_status',{stop_state:'waiting_reviews',reason:'A review is pending; later placeholders have no new decision to record'});
  s.store.appendWorkflowEvent({type:'stop-declared',taskSeq:1,turn:1,state:'waiting_reviews'});
  s.endTurn('Waiting for current review.');await new Promise(r=>setTimeout(r,0));
  assert.equal(s.followups.length,0);assert.equal(s.model.calls.length,0);
  s.store.appendWorkflowEvent({type:'execution-review-result',taskSeq:1,reviewId:'pending-a',stageId:a.id,stageHash:a.hash,result:{status:'error'}});
  await assert.rejects(s.call('team_status',{stop_state:'waiting_reviews'}),/pending current-version/);
});

test('route chain: primary, configured fallbacks, then the leader model; duplicates and unknown models are dropped', () => {
  const cfg = configWith({});
  const leader = { provider: cfg.magpie.provider, model: SOL, reasoningEffort: 'high' };
  assert.deepEqual(roleRouteChain(cfg, 'gate', leader).map(x => `${x.via}:${x.route}:${x.degraded}`), [`primary:${SOL}:false`, `fallback:${GLM}:true`]);
  assert.deepEqual(roleRouteChain(cfg, 'discussA', leader).map(x => `${x.via}:${x.route}:${x.degraded}`), [`primary:${GLM}:false`, `leader:${SOL}:true`]);
  assert.equal(roleRouteChain(cfg, 'discussA', { provider: cfg.magpie.provider, model: 'not/configured', reasoningEffort: 'high' }).length, 1);
  assert.equal(roleRouteChain(cfg, 'discussA', { provider: 'someone-else', model: SOL }).length, 1, 'a model of another provider is not a known stand-in');
  assert.equal(roleRouteChain(configWith({ team: { ...cfg.team, leaderModelAsLastResort: false } }), 'discussA', leader).length, 1);
  assert.equal(roleRouteChain(cfg, 'gate', null)[1].maxTokens, 2000, 'a fallback keeps its own limits');
  assert.throws(() => roleRouteChain(cfg, 'nobody'), /unknown governance role/);
});

test('route chain call: moves on only when a route is unavailable; an answer of any kind is final', async () => {
  const cfg = configWith({ roles: noRetry(configWith({})) });
  const chain = roleRouteChain(cfg, 'gate', null);
  const parse = text => { try { return { ok: true, verdict: JSON.parse(text) }; } catch { return { ok: false, error: 'bad' }; } };
  const down = scriptedLlm(m => (m === SOL ? null : ALLOW));
  const seen = [];
  const r1 = await callRoleJson(down, chain, { system: 's', user: 'u' }, parse, { onAttempt: (target, a) => seen.push(`${target.route}:${a.ok}`) });
  assert.equal(r1.ok, true); assert.equal(r1.target.route, GLM); assert.equal(r1.target.degraded, true);
  assert.deepEqual(down.calls, [SOL, GLM]); assert.deepEqual(seen, [`${SOL}:false`, `${GLM}:true`]); assert.equal(r1.attempts, 2);
  const denies = scriptedLlm(m => (m === SOL ? DENY : ALLOW));
  const r2 = await callRoleJson(denies, chain, { system: 's', user: 'u' }, parse);
  assert.equal(r2.verdict.decision, 'deny'); assert.deepEqual(denies.calls, [SOL], 'a denial is never re-asked on the next route');
  const allDown = scriptedLlm(() => null);
  const r3 = await callRoleJson(allDown, chain, { system: 's', user: 'u' }, parse);
  assert.equal(r3.ok, false); assert.equal(r3.tried.length, 2); assert.equal(r3.target.route, GLM);
  const skipSol = scriptedLlm(() => ALLOW);
  const r4 = await callRoleJson(skipSol, chain, { system: 's', user: 'u' }, parse, { skip: target => (target.route === SOL ? 'quota exhausted' : null) });
  assert.equal(r4.target.route, GLM); assert.deepEqual(skipSol.calls, [GLM]); assert.equal(r4.tried[0].skipped, 'quota exhausted');
  const none = await callRoleJson(scriptedLlm(() => ALLOW), chain, { system: 's', user: 'u' }, parse, { skip: () => 'quota exhausted' });
  assert.equal(none.ok, false); assert.equal(none.error.code, 'NO_ROUTE');
});

test('gate falls back to the next route during an outage, marks the receipt degraded, and never shops a denial around', async t => {
  const llm = scriptedLlm(m => (m === SOL ? null : ALLOW));
  const s = memberSetup(t, { llm });
  const g = await s.write();
  assert.equal(g.decision, 'allow'); assert.equal(g.by, 'model'); assert.equal(g.model, GLM); assert.equal(g.degraded, true); assert.equal(g.via, 'fallback');
  const usage = fs.readFileSync(path.join(s.rt.storageRoot, 'teams', 'team1', 'usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(usage.map(u => `${u.route}:${u.ok}:${u.degraded ?? false}`), [`${SOL}:false:false`, `${GLM}:true:true`]);
  const strict = scriptedLlm(m => (m === SOL ? DENY : ALLOW));
  const s2 = memberSetup(t, { llm: strict });
  const d = await s2.write();
  assert.equal(d.decision, 'deny'); assert.equal(d.by, 'model'); assert.equal(d.model, SOL); assert.equal(d.degraded, undefined);
  assert.deepEqual(strict.calls, [SOL]);
});

test('a safety-review outage is bounded: after N failures in a row the gate stops calling until the cooldown passes', async t => {
  const llm = scriptedLlm(() => null);
  const s = memberSetup(t, { llm, gate: { maxConsecutiveGateErrors: 3, gateErrorCooldownMs: 60000 } });
  const by = [];
  for (let i = 0; i < 12; i++) by.push((await s.write()).by);
  assert.deepEqual(by.slice(0, 3), ['gate-error', 'gate-error', 'gate-error']);
  assert.ok(by.slice(3).every(x => x === 'rule:gate-unavailable-circuit-breaker'), JSON.stringify(by));
  assert.equal(llm.calls.length, 6, 'three reviews, two routes each, then no more model calls');
  const last = s.store.gateReceipts().at(-1);
  assert.match(last.reason, /unavailable 3 times in a row/); assert.match(last.reason, /STATUS: blocked/);
  // An outage is not a policy refusal: it must not trip the denial breaker once review works again.
  const recovered = memberSetup(t, { llm: scriptedLlm(() => ALLOW), gate: { maxConsecutiveGateErrors: 3, gateErrorCooldownMs: 60000 } });
  const old = new Date(Date.now() - 120000).toISOString();
  for (let i = 0; i < 5; i++) recovered.store.appendGateReceipt({ at: old, teamId: 'team1', taskSeq: 1, agentId: 'm1', role: 'member', member: 'dev', tool: 'write', callId: `old${i}`, argsSha256: `h${i}`, decision: 'deny', by: 'gate-error', reason: 'x' });
  const probe = await recovered.write();
  assert.equal(probe.by, 'model', 'after the cooldown one new attempt reaches the model'); assert.equal(probe.decision, 'allow');
});

test('reminders to read references and review outages do not count toward the member denial breaker; real refusals still do', async t => {
  const s = memberSetup(t, { llm: scriptedLlm(() => ALLOW) });
  for (let i = 0; i < 12; i++) s.store.appendGateReceipt({ teamId: 'team1', taskSeq: 1, agentId: 'm1', role: 'member', member: 'dev', tool: 'write', callId: `r${i}`, argsSha256: `r${i}`, decision: 'deny', by: 'rule:refs-unread', reason: 'read refs first' });
  const ok = await s.write();
  assert.equal(ok.by, 'model'); assert.equal(ok.decision, 'allow');
  const s2 = memberSetup(t, { llm: scriptedLlm(() => ALLOW) });
  for (let i = 0; i < 10; i++) s2.store.appendGateReceipt({ teamId: 'team1', taskSeq: 1, agentId: 'm1', role: 'member', member: 'dev', tool: 'write', callId: `d${i}`, argsSha256: `d${i}`, decision: 'deny', by: 'model', reason: 'no' });
  assert.equal((await s2.write()).by, 'rule:member-denial-circuit-breaker');
});

test('leader notes pass on deterministic rules alone and are still audited; nothing else may be made rule-only', async t => {
  const llm = scriptedLlm(() => DENY);
  const s = leaderSetup(t, { llm });
  const actor = s.rt.actors.get('leader1');
  const g = await new Gate(s.ctx).decide({ name: 'team_note', args: { path: 'contract.md', content: '# c' }, agent: s.leaderAgent, actor, callId: 'n1' });
  assert.equal(g.decision, 'allow'); assert.equal(g.by, 'rule-only'); assert.deepEqual(llm.calls, []);
  assert.equal(s.store.gateReceipts().at(-1).by, 'rule-only');
  const raw = JSON.parse(fs.readFileSync(new URL('../../config/leaderteam.config.json', import.meta.url), 'utf8'));
  for (const tool of ['pwsh', 'write', 'edit', 'team_dispatch']) {
    assert.throws(() => validateConfig({ ...raw, gate: { ...raw.gate, ruleOnlyTools: ['team_note', tool] } }), /must stay model-reviewed/, tool);
  }
  assert.throws(() => validateConfig({ ...raw, roles: { ...raw.roles, gate: { ...raw.roles.gate, fallback: [{ route: raw.roles.gate.route, effort: 'high' }] } } }), /repeats the primary route/);
  assert.throws(() => validateConfig({ ...raw, roles: { ...raw.roles, gate: { ...raw.roles.gate, fallback: [{ route: 'no/such', effort: 'high' }] } } }), /not in models/);
  assert.doesNotThrow(() => validateConfig(raw));
});

test('gate request puts the unchanging context first and the operation last', () => {
  const cfg = configWith({});
  const actor = { role: 'member', name: 'dev', profile: 'code', writeScope: ['src/**'], task: 'implement the engine', acceptance: ['works'] };
  const a = buildGateRequest({ tool: 'edit', args: { file_path: 'src/a.js', old_string: 'x', new_string: 'y' }, actor, cwd: 'D:\\ws', userTask: 'U'.repeat(4000), platform: 'win32' }, cfg).user;
  const b = buildGateRequest({ tool: 'write', args: { file_path: 'src/b.js', content: 'completely different' }, actor, cwd: 'D:\\ws', userTask: 'U'.repeat(4000), platform: 'win32' }, cfg).user;
  assert.deepEqual(Object.keys(JSON.parse(a)), ['authorization', 'scope', 'actor', 'operation']);
  let common = 0; while (common < a.length && a[common] === b[common]) common++;
  assert.ok(common > 4000, `two reviews for one member share a ${common}-character prefix`);
  assert.ok(a.indexOf('"operation"') > a.indexOf('"member_task"'));
});

test('control-only user messages do not start a new task; "continue" starts one only after an approved delivery', async t => {
  assert.equal(isReadGrantOnlyMessage('允许读取 E:\\资料\\参考\nallow read D:\\refs'), true);
  assert.equal(isReadGrantOnlyMessage('允许读取 E:\\资料\\参考\n顺便把登录页也改了'), false);
  assert.equal(isReadGrantOnlyMessage(''), false);
  for (const yes of ['继续', '继续。', '请继续', 'continue', 'Go on!', '接着做']) assert.equal(isBareContinueMessage(yes), true, yes);
  for (const no of ['继续，另外把配色改成蓝色', '继续吗', 'continue with the new API', '']) assert.equal(isBareContinueMessage(no), false, no);

  const s = leaderSetup(t);
  const plan = await s.call('team_discuss', { kind: 'plan', topic: 'p', proposal: 'full plan v1' });
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 1);
  s.userSays('允许读取 E:\\资料\\参考', 2000);
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 1, 'a grant-only reply keeps the task and its approved plan');
  s.userSays('继续', 3000);
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 1, 'a bare continue resumes the open task');
  assert.equal((await s.call('team_status', {})).task_seq, 1);
  // Fabricate an approved delivery for task 1 by replaying the approved plan's own events as kind "delivery".
  const recs = s.store.agreementRecords().filter(r => r.id === plan.id);
  for (const { v, at, ...ev } of recs) s.store.appendAgreementEvent({ ...ev, id: 'agr-delivery1', ...(ev.type === 'created' ? { kind: 'delivery' } : {}) });
  const approvedAt = Math.max(...s.store.agreementRecords().filter(r => r.id === 'agr-delivery1').map(r => Date.parse(r.at)));
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 1, 'messages sent before the approval are not re-read as new tasks');
  s.userSays('继续', approvedAt + 1000);
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 2, 'after an approved delivery, continue means new work');
  s.userSays('继续');
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 3, 'without a message time the conservative reading applies');
  s.userSays('把登录页也做了', approvedAt + 3000);
  assert.equal(currentTaskSeq(s.ctx, 'leader1'), 4, 'ordinary messages always start a task');
});

test('auto-continuation: an allowed note is not progress, so a stalled leader is nudged three times and no more', async t => {
  const s = leaderSetup(t);
  await s.call('team_discuss', { kind: 'plan', topic: 'p', proposal: 'full plan v1' });
  for (let i = 0; i < 20; i++) {
    s.store.appendGateReceipt({ teamId: 'leader1', taskSeq: 1, agentId: 'leader1', role: 'leader', member: null, tool: 'team_note', callId: `n${i}`, argsSha256: `h${i}`, decision: 'allow', by: 'rule-only', reason: 'ok' });
    s.endTurn('已更新计划文档，稍后继续。');
  }
  assert.equal(s.followups.length, 3);
});

test('a reviewer whose route is down is replaced by the leader model in a separate call, and the result says so', async t => {
  const approve = '{"stance":"approve","summary":"ok","reasons":["ok"],"required_changes":[]}';
  const llm = scriptedLlm(m => (m === GLM ? null : approve));
  const s = leaderSetup(t, { llm });
  const plan = await s.call('team_discuss', { kind: 'plan', topic: 'p', proposal: 'full plan v1' });
  assert.equal(plan.status, 'settled'); assert.equal((plan.outcome ?? plan).decision, 'approve');
  assert.equal(plan.degraded_roles.length, 1); assert.match(plan.degraded_roles[0], /discussA ran on the leader's model/);
  const usage = fs.readFileSync(path.join(s.rt.storageRoot, 'teams', 'leader1', 'usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const a = usage.filter(u => u.role === 'discussA');
  assert.deepEqual(a.map(u => `${u.route}:${u.ok}:${u.via ?? 'primary'}`), [`${GLM}:false:primary`, `${SOL}:true:leader`]);
});

test('team_discuss treats a parsed reviewer refusal or arbiter ruling as final, and marks configured arbiter fallback degraded', async t => {
  const baseRoles = configWith({}).roles;
  const roles = noRetry({
    roles: {
      ...baseRoles,
      discussA: { ...baseRoles.discussA, fallback: [{ route: SOL, effort: 'high' }] },
      arbiter: { ...baseRoles.arbiter, fallback: [{ route: SOL, effort: 'max', maxTokens: 16000, timeoutMs: 600000 }] },
    },
  });
  const reject = '{"stance":"reject","summary":"blocked","reasons":["missing auth"],"suggestions":["Obtain the required authorization before dispatch"],"required_changes":[]}';
  const approve = '{"stance":"approve","summary":"ok","reasons":["ok"],"required_changes":[]}';
  const revise = '{"stance":"revise","summary":"needs tests","reasons":["missing test"],"suggestions":["Add the missing regression test for output validation"],"required_changes":["add test"]}';

  const llm1 = scriptedLlm((_m, req) => {
    if (req.system.includes('independent arbiter')) return '{"adopt":"A"}';
    return JSON.parse(req.messages[0].content[0].text).you_are === 'A' ? reject : approve;
  });
  const s1 = leaderSetup(t, { llm: llm1, extra: { roles } });
  const r1 = await s1.call('team_discuss', { kind: 'plan', topic: 'p1', proposal: 'full plan v1' });
  assert.equal(r1.status, 'settled');
  assert.deepEqual((({reasons,suggestions,conditions,change_items,...outcome})=>outcome)(r1.outcome), { decision: 'reject', by: 'arbiter', round: 3, adopted: 'A', required_changes: [] });
  assert.equal(r1.degraded_roles, undefined);
  assert.equal(llm1.calls.filter(m => m === GLM).length, 4, '3 rounds of discussA + 1 primary arbiter');
  assert.equal(llm1.calls.filter(m => m === SOL).length, 3, '3 rounds of discussB only; neither refusal nor ruling re-asked');

  let arbiterCalls = 0;
  const llm2 = scriptedLlm((m, req) => {
    if (req.system.includes('independent arbiter')) {
      arbiterCalls++;
      return m === GLM ? null : '{"adopt":"B"}';
    }
    return JSON.parse(req.messages[0].content[0].text).you_are === 'A' ? approve : revise;
  });
  const s2 = leaderSetup(t, { llm: llm2, extra: { roles } });
  const r2 = await s2.call('team_discuss', { kind: 'plan', topic: 'p2', proposal: 'full plan v2' });
  assert.equal(r2.status, 'settled');
  assert.deepEqual((({reasons,suggestions,conditions,change_items,...outcome})=>outcome)(r2.outcome), { decision: 'revise', by: 'arbiter', round: 3, adopted: 'B', required_changes: ['add test'] });
  assert.equal(r2.degraded_roles?.length, 1);
  assert.match(r2.degraded_roles[0], /^arbiter ran on a fallback route codex\/gpt-6\.1-sol /);
  assert.equal(arbiterCalls, 2, 'primary failed, configured fallback answered once, duplicate leader route dropped');
  const usage2 = fs.readFileSync(path.join(s2.rt.storageRoot, 'teams', 'leader1', 'usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(
    usage2.filter(u => u.role === 'arbiter').map(u => `${u.route}:${u.ok}:${u.degraded ?? false}:${u.via ?? 'primary'}`),
    [`${GLM}:false:false:primary`, `${SOL}:true:true:fallback`],
  );
});

test('dispatch and resume share capacity and overlapping-write admission', t => {
  const s = leaderSetup(t);
  s.store.addMember({ childId: 'active', name: 'active', profile: 'code', taskSeq: 1, writeScope: ['src/ui/**'] });
  s.store.addMember({ childId: 'old', name: 'old', profile: 'code', taskSeq: 1, writeScope: ['src/**'] });
  s.store.setMemberStatus('old', 'done');
  assert.throws(() => assertActivationAdmission(s.store, s.cfg, { name: 'new', taskSeq: 1, writeScope: ['src/**'] }), /overlaps/);
  assert.throws(() => resumeAdmission(s.store, s.cfg, 'old', 1), /overlaps/);
  const one = { ...s.cfg, team: { ...s.cfg.team, maxActiveMembers: 1 } };
  assert.throws(() => assertActivationAdmission(s.store, one, { name: 'new', taskSeq: 1, writeScope: ['other/**'] }), /active member limit/);
});

test('a pending resume reserves its slot synchronously and a failed native activation releases it', async t => {
  const s = leaderSetup(t);
  const cfg = { ...s.cfg, team: { ...s.cfg.team, requirePlanAgreement: false, maxActiveMembers: 1 } };
  for (const childId of ['a', 'b']) { s.store.addMember({ childId, name: `dev-${childId}`, model: GLM, effort: 'high', profile: 'code', taskSeq: 1, writeScope: [`${childId}/**`] }); s.store.setMemberStatus(childId, 'done'); }
  let release;
  s.rt.memberExecutionProgress = new Map([['a', new Set(['prior-write'])]]);
  const pending = withMemberActivation(s.rt, s.store, cfg, 'a', 1, () => new Promise(resolve => { release = resolve; }));
  assert.equal(s.store.getMember('a').status, 'starting');
  assert.equal(s.rt.memberExecutionProgress.get('a').size, 0, 'new activation cannot inherit old successful writes');
  await assert.rejects(withMemberActivation(s.rt, s.store, cfg, 'b', 1, () => ({})), /active member limit/);
  release({ isError: true }); await pending;
  assert.equal(s.store.getMember('a').status, 'done');
  assert.deepEqual([...s.rt.memberExecutionProgress.get('a')], ['prior-write'], 'failed activation restores previous tracking');
  await assert.rejects(withMemberActivation(s.rt, s.store, cfg, 'b', 1, () => { throw new Error('native failed'); }), /native failed/);
  assert.equal(s.store.getMember('b').status, 'done');
  assert.equal(s.rt.memberExecutionProgress.has('b'), false);
});

test('invalid stage refs and tool grants are rejected before any execution review or model call', async t => {
  const s = leaderSetup(t, { extra: { team: { rollingPlanning: true } } });
  recordOverview(s.store, 1, { summary: 'Build a modular tool', approach: 'Implement then verify', acceptance: ['Tests pass'], estimated_minutes: 15, future_work: ['module-a'] });
  const base = { action: 'stage', stage_id: 'module-a', goal: 'Implement module', method: 'Use existing contract', acceptance: ['Tests pass'], interfaces: ['JSON input/output'], profile: 'code', tools: ['read', 'write'], write_scope: ['src/**'], parallel_with: ['module-b'], ready: true };
  for (const refs of [['lib/**'], ['missing.md'], ['.leaderteam']]) {
    recordStage(s.store, 1, { ...base, refs });
    await assert.rejects(s.call('team_discuss', { kind: 'plan', stage_id: 'module-a', topic: 'Implementation' }), /ref .*glob|ref does not exist|ref is not a file/);
  }
  for (const tools of [['read'], ['read', 'pwsh']]) {
    recordStage(s.store, 1, { ...base, tools, refs: [] });
    await assert.rejects(s.call('team_discuss', { kind: 'plan', stage_id: 'module-a', topic: 'Implementation' }), /read-only tools|deployment policy/);
  }
  assert.equal(s.model.calls.length, 0);
  assert.equal(s.store.agreementIds().length, 0);
  assert.equal(s.store.workflowEvents().filter(e => e.type === 'execution-review-queued').length, 0);
});

test('expected upstream reference files can be planned but remain mandatory at actual dispatch', t => {
  const s=leaderSetup(t),file='generated/interface.json';
  assert.deepEqual(resolveMemberRefs(s.cfg,s.ws,[file],process.platform,{futureWriteScopes:['generated/**']}),[path.join(s.ws,file)]);
  assert.throws(()=>resolveMemberRefs(s.cfg,s.ws,[file]),/ref does not exist/,'dispatch never receives the planning-only exception');
  assert.throws(()=>resolveMemberRefs(s.cfg,s.ws,['unrelated/missing.json'],process.platform,{futureWriteScopes:['generated/**']}),/ref does not exist/);
  assert.throws(()=>resolveMemberRefs(s.cfg,s.ws,['../external.json'],process.platform,{futureWriteScopes:['**']}),/inside the workspace/);
  assert.throws(()=>resolveMemberRefs(s.cfg,s.ws,['generated/**'],process.platform,{futureWriteScopes:['generated/**']}),/not a glob/);
  assert.equal(fs.existsSync(path.join(s.ws,file)),false,'planning does not fabricate an output file');
});

test('a stalled stage review can be superseded without resetting its cap or dropping inherited requirements', async t => {
  const requests = [], llm = scriptedLlm((_model, req) => { requests.push(JSON.parse(req.messages[0].content[0].text)); return '{"stance":"approve","summary":"Meets the reviewed stage","reasons":["Original constraints preserved"],"required_changes":[]}'; });
  const s = leaderSetup(t, { llm, extra: { team: { rollingPlanning: true } } });
  recordOverview(s.store, 1, { summary: 'A modular tool', approach: 'Implement and check', acceptance: ['Check actual output'], estimated_minutes: 15, future_work: ['module-a'] });
  const a = recordStage(s.store, 1, { stage_id: 'module-a', goal: 'Implement module', method: 'Use contract', acceptance: ['Original constraints preserved'], interfaces: ['JSON in/out'], profile: 'code', tools: ['read','write'], write_scope: ['src/**'], parallel_with: ['module-b'], ready: true }).stage;
  recordStage(s.store, 1, { stage_id: 'module-b', goal: 'Independent module', method: 'Use the same interface', acceptance: ['Contract output verified'], interfaces: ['JSON in/out'], profile: 'code', tools: ['read','write'], write_scope: ['other/**'], parallel_with: ['module-a'], ready: true });
  const item = { id: '0123456789abcdef', problem: 'Preserve the original user constraint', evidence: 'Original task', suggestion: 'Verify actual output', hard_blocker: true, category: 'user_requirement' };
  const old = 'agr-stalled';
  s.store.saveAgreementInput(old, { kind: 'plan', taskSeq: 1, stageReview: a, previousChangeItems: [item], previousRequiredChanges: [item.problem] });
  s.store.appendAgreementEvent({ type: 'created', id: old, kind: 'plan', taskSeq: 1, maxRounds: 1, maxArbiterAttempts: 1 });
  for (const member of ['A','B']) s.store.appendAgreementEvent({ type: 'opinion', id: old, round: 1, member, opinion: { stance: 'revise', summary: 'Invalid format', reasons: ['Missing reconciliation'], requiredChanges: [], invalid: true } });
  s.store.appendAgreementEvent({ type: 'arbiter-attempt', id: old });
  s.store.appendWorkflowEvent({ type: 'execution-review-queued', taskSeq: 1, reviewId: 'ticket-old', stageId: a.id, stageHash: a.hash, resumeId: null, revises: null });
  s.store.appendWorkflowEvent({ type: 'execution-review-result', taskSeq: 1, reviewId: 'ticket-old', stageId: a.id, stageHash: a.hash, result: { status: 'error', id: old, error: 'arbiter attempts exhausted' } });
  const result = await s.call('team_discuss', { kind: 'plan', stage_id: a.id, topic: 'Review unchanged bounded assignment after format recovery' });
  assert.equal(result.status, 'reviewing'); assert.notEqual(result.review_id, 'ticket-old');
  await Promise.all([...s.rt.executionReviewJobs.values()].map(j => j.promise));
  const queued = s.store.workflowEvents().findLast(e => e.type === 'execution-review-queued');
  assert.equal(queued.revises, old);
  assert.ok(requests.length >= 2); for (const req of requests) assert.ok(req.previous_change_items.some(i => i.id === item.id), 'the original blocker must still be reconciled');
  assert.equal(s.store.agreementEvents(old).filter(e => e.type === 'arbiter-attempt').length, 1, 'old exhausted budget is not reset');
  const done = s.store.workflowEvents().findLast(e => e.type === 'execution-review-result');
  assert.equal(done.result.outcome.decision, 'approve'); assert.notEqual(done.result.id, old);
});

test('resume needs current plan approval and durably rebinds an old member before it executes', async t => {
  const s = leaderSetup(t);
  const plan1 = await s.call('team_discuss', { kind: 'plan', topic: 'first', proposal: 'full plan' });
  s.store.addMember({ childId: 'old', name: 'dev-old', model: GLM, effort: 'high', taskSeq: 1, planId: plan1.id, profile: 'code', writeScope: ['src/**'] });
  s.store.setMemberStatus('old', 'done');
  assert.throws(() => resumeAdmission(s.store, s.cfg, 'old', 2), /no approved plan/);
  s.userSays('Implement a second task');
  const plan2 = await s.call('team_discuss', { kind: 'plan', topic: 'second', proposal: 'full second plan' });
  assert.equal(resumeAdmission(s.store, s.cfg, 'old', 2).planId, plan2.id);
  await withMemberActivation(s.rt, s.store, s.cfg, 'old', 2, () => { s.store.setMemberStatus('old', 'running'); return {}; });
  assert.equal(s.store.getMember('old').taskSeq, 2);
  assert.equal(s.store.getMember('old').planId, plan2.id);
});

test('a user-only stop is reviewed once per declaration and an outage accepts the stop', async t => {
  assert.throws(() => stopDeclaration({ stop_state: 'waiting_user' }, 1, 1), /actual question/);
  const llm = scriptedLlm(() => '{"action":"stop","reason":"only the user can authorize this","directive":""}');
  const s = leaderSetup(t, { llm });
  const decl = stopDeclaration({ stop_state: 'waiting_user', question: 'May we access the external directory?' }, 1, 1);
  const actor = s.rt.actors.get(s.leaderAgent.id);
  assert.equal((await reviewStop(s.rt, s.store, actor, s.leaderAgent, decl, {}, 'task')).action, 'stop');
  assert.equal((await reviewStop(s.rt, s.store, actor, s.leaderAgent, decl, {}, 'task')).action, 'stop');
  assert.equal(llm.calls.length, 1);
  s.rt.llm = scriptedLlm(() => null);
  const r = await reviewStop(s.rt, s.store, actor, s.leaderAgent, { ...decl, turn: 2 }, {}, 'task');
  assert.equal(r.action, 'stop'); assert.equal(r.unavailable, true);
});

test('retired execution models cannot be reactivated through send_message', t => {
  const s = leaderSetup(t);
  const cfg = { ...s.cfg, team: { ...s.cfg.team, executionPool: [GLM], requirePlanAgreement: false } };
  s.store.addMember({ childId: 'old-sol', name: 'old-sol', model: SOL, effort: 'high', profile: 'code', taskSeq: 1, writeScope: ['src/**'] });
  s.store.setMemberStatus('old-sol', 'done');
  assert.throws(() => resumeAdmission(s.store, cfg, 'old-sol', 1), /retired or unsupported model/);
});

test('an ordinary checkpoint declared as waiting_user is continued after an independent stop review', async t => {
  const llm = scriptedLlm((_m, req) => req.system.startsWith('You independently review') ? '{"action":"continue","reason":"already authorized","directive":"Dispatch the implementation member under the approved plan."}' : '{"stance":"approve","summary":"ok","reasons":[],"required_changes":[]}');
  const s = leaderSetup(t, { llm });
  await s.call('team_discuss', { kind: 'plan', topic: 'p', proposal: 'full plan' });
  const evs = s.leaderAgent.session.snapshotEvents();
  evs.push({ type: 'turn/start', data: { turn: 2 } });
  await s.call('team_status', { stop_state: 'waiting_user', question: 'Should I start the already approved implementation?' });
  evs.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DELIVERY: not approved: 允许读取 an irrelevant outside path before continuing?' }] } } }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  onAgentStatus(s.ctx, { agent: s.leaderAgent, status: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.followups.length, 1);
  assert.match(s.followups[0].content[0].text, /Dispatch the implementation member/);
  assert.equal(s.store.usageRecords().filter(u => u.purpose === 'stop-review').length, 1);
});

test('team_plan emits zero-LLM anti-hoarding hints and team_status short-circuits in-turn polling without 40KB dumps', async t => {
  const s = leaderSetup(t, { extra: { team: { rollingPlanning: true } } });
  const evs = s.leaderAgent.session.snapshotEvents();
  evs.push({ type: 'turn/start', data: { turn: 3 } });
  await s.call('team_plan', { action: 'overview', summary: 'Tool', approach: 'A and B', acceptance: ['Pass'], estimated_minutes: 5, future_work: ['mod-a', 'mod-b'] });
  const rStage = await s.call('team_plan', { action: 'stage', stage_id: 'mod-a', goal: 'Write A', method: 'Write file', acceptance: ['Exists'], interfaces: ['None'], profile: 'code', tools: ['read', 'write'], write_scope: ['src/a.js'], parallel_with: ['mod-b'], ready: true });
  assert.match(rStage.next_step_hint, /await execution review.*mod-a/);
  assert.equal(s.model.calls.length, 0, 'team_plan triggers zero background LLM calls');
  s.store.addMember({ childId: 'w-a', name: 'w-a', profile: 'code', taskSeq: 1, stageId: 'mod-a', stageHash: rStage.stage.hash, model: GLM, effort: 'high', writeScope: ['src/a.js'] });
  s.store.setMemberStatus('w-a', 'running');
  s.rt.liveProcessMemberIds.add('w-a');
  const stop1 = await s.call('team_status', { stop_state: 'waiting_members' });
  assert.equal(stop1.stop_declaration.duplicate_in_turn, false);
  assert.equal(stop1.agreements, undefined, 'stop declaration returns compact receipt');
  const stop2 = await s.call('team_status', { stop_state: 'waiting_members' });
  assert.equal(stop2.stop_declaration.duplicate_in_turn, true);
  assert.equal(s.store.workflowEvents().filter(e => e.type === 'stop-declared' && e.turn === 3).length, 1);
  const full1 = await s.call('team_status', {});
  assert.equal(Array.isArray(full1.members), true);
  const poll2 = await s.call('team_status', {});
  assert.equal(poll2.unchanged_in_turn, true);
  assert.equal(poll2.members, undefined);
  s.store.setMemberStatus('w-a', 'done');
  const afterChange = await s.call('team_status', {});
  assert.equal(afterChange.unchanged_in_turn, undefined);
  assert.equal(afterChange.members[0].status, 'done');
});
