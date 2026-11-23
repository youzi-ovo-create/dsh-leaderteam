import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { TeamStore } from '../../leaderteam/core/store.mjs';
import { recordOverview, recordStage, recordStageVerification, requireReadyStage, stageApproval, assertStageApproval, hydrateStageDispatch, frontierState, frontierView } from '../../leaderteam/core/frontier.mjs';
import { queueExecutionReview, disposePlanning, formatFrontierContext } from '../../leaderteam/host/planning.mjs';
import { dispatchContract } from '../../leaderteam/core/dispatch-contract.mjs';
import { hasAdmissibleFrontierWork } from '../../leaderteam/host/activation.mjs';
import { configWith } from './helpers.mjs';

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-llm') return { url: 'data:text/javascript,' + encodeURIComponent('export class BlockAssembler { constructor(){this.b=[]} push(c){if(c.type==="text")this.b.push({type:"text",text:c.text})} blocks(){return this.b} }'), shortCircuit: true };
  return nextResolve(specifier, context);
} });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-frontier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new TeamStore(root, 'team-one'); store.ensure({ workspace: root });
  recordOverview(store, 1, { summary: 'Build a modular tool', approach: 'Agree interfaces, execute independent modules, integrate', acceptance: ['Actual tests pass'], estimated_minutes: 20, future_work: ['module-a', 'module-b'] });
  return { root, store };
}
const stage = (id, more = {}) => ({ stage_id: id, goal: `Implement ${id}`, method: 'Use the agreed interface and verify actual output', acceptance: ['Contract tests pass'], interfaces: ['JSON in -> JSON out'], profile: 'code', tools: ['read', 'write'], write_scope: [`src/${id}/**`], parallel_with: [id === 'module-a' ? 'module-b' : 'module-a'], ready: true, ...more });

test('presentation order, supplementary read refs and narrower tools preserve approval, while new privileges and changed scope do not', t => {
  const {store}=fixture(t),args=stage('module-a',{tools:['read','glob','write'],refs:['contract.md','evidence.md'],write_scope:['src/a/**','test/a/**']});
  const a=recordStage(store,1,args).stage; approved(store,a,'agr-a');
  const before=fs.readFileSync(a.file,'utf8'),revision=frontierState(store,1).revision;
  const reordered=recordStage(store,1,{...args,tools:['write','read','glob'],refs:['evidence.md','contract.md'],write_scope:['test/a/**','src/a/**']});
  assert.equal(reordered.changed,false);assert.equal(reordered.stage.hash,a.hash);assert.equal(frontierState(store,1).revision,revision);assert.equal(fs.readFileSync(a.file,'utf8'),before);
  const dispatched=hydrateStageDispatch(store,1,{stage_id:a.id,plan_id:'agr-a',tools:['write','read'],refs:['additional-read-only.md']});
  assert.deepEqual(dispatched.tools,['write','read']);assert.ok(dispatched.refs.includes('contract.md'));assert.ok(dispatched.refs.includes('additional-read-only.md'));assert.equal(dispatched.stageHash,a.hash);assert.equal(stageApproval(store,1,a),'agr-a');
  assert.throws(()=>hydrateStageDispatch(store,1,{stage_id:a.id,plan_id:'agr-a',tools:['read','write','pwsh']}),/cannot override reviewed tools/);
  assert.throws(()=>hydrateStageDispatch(store,1,{stage_id:a.id,plan_id:'agr-a',tools:['write']}),/required read/);
  assert.throws(()=>hydrateStageDispatch(store,1,{stage_id:a.id,plan_id:'agr-a',write_scope:['src/**']}),/cannot override reviewed write_scope/);
  assert.throws(()=>hydrateStageDispatch(store,1,{stage_id:a.id,plan_id:'agr-a',acceptance:['A weaker check']}),/cannot override reviewed acceptance/);
});

test('output-limit history never forces stage re-splitting or blocks recovery dispatch, while changed stage contracts still require matching approval', t => {
  const {root,store}=fixture(t),a=recordStage(store,1,stage('module-a')).stage;
  approved(store,a,'agr-a');
  const cfg=configWith({team:{rollingPlanning:true}}),model=cfg.team.executionPool[0];
  store.addMember({childId:'exhausted',name:'dev-a',taskSeq:1,stageId:a.id,stageHash:a.hash,model,effort:'high'});
  store.setMemberStatus('exhausted','failed','max-tokens',{kind:'output-limit',noExecutionProgress:true,completedOperations:0});
  const cold=new TeamStore(root,'team-one'),args={name:'renamed-a',stage_id:a.id,plan_id:'agr-a',model,effort:'high'};
  assert.equal(dispatchContract(cold,cfg,1,args).stageHash,a.hash,'output-limit history does not block recovery dispatch or force stage splitting');
  assert.equal(dispatchContract(cold,cfg,1,{...args,model:`${cfg.magpie.provider}/${model}`}).model,model);
  const narrowed=recordStage(cold,1,stage('module-a',{method:'Implement only the next bounded file and verify it'})).stage;
  assert.throws(()=>dispatchContract(cold,cfg,1,args),/no matching approved/);
  approved(cold,narrowed,'agr-narrow');
  assert.equal(dispatchContract(cold,cfg,1,{...args,plan_id:'agr-narrow'}).stageHash,narrowed.hash);
});

test('recorded execution progress and unknown legacy failures do not become zero-progress claims', t => {
  const {store}=fixture(t),a=recordStage(store,1,stage('module-a')).stage;approved(store,a,'agr-a');
  const cfg=configWith({team:{rollingPlanning:true}}),model=cfg.team.executionPool[0],args={name:'retry-a',stage_id:a.id,plan_id:'agr-a',model,effort:'high'};
  store.addMember({childId:'partial',name:'partial',taskSeq:1,stageId:a.id,stageHash:a.hash,model,effort:'high'});
  store.setMemberStatus('partial','failed','max-tokens',{kind:'output-limit',noExecutionProgress:false,completedOperations:1});
  assert.doesNotThrow(()=>dispatchContract(store,cfg,1,args));
  store.addMember({childId:'legacy',name:'legacy',taskSeq:1,stageId:a.id,stageHash:a.hash,model,effort:'high'});
  store.setMemberStatus('legacy','failed','max-tokens');
  assert.doesNotThrow(()=>dispatchContract(store,cfg,1,args));
});

test('live context keeps required review changes, conditions and missing stage ids without repeating full approved proofs', t => {
  const {store}=fixture(t),a=recordStage(store,1,stage('module-a')).stage;
  const proof='repeated audit narrative '.repeat(3000);
  store.appendWorkflowEvent({type:'execution-review-result',taskSeq:1,reviewId:'review-a',stageId:a.id,result:{status:'settled',id:'agr-needs-work',outcome:{decision:'revise',requiredChanges:['preserve old output on failed scan'],changeItems:[{id:'fix-1',description:'validate path boundary'}],conditions:['Never modify source files'],reasons:[proof],serialProof:{reason:'One state owner makes this phase serial',proof:[{evidence:proof}]}}}});
  const text=formatFrontierContext(store,1),data=JSON.parse(text.split('\n')[1]),outcome=data.recent_feedback[0].result.outcome;
  assert.deepEqual(outcome.requiredChanges,['preserve old output on failed scan']);
  assert.deepEqual(outcome.conditions,['Never modify source files']);
  assert.deepEqual(outcome.changeItems,[{id:'fix-1',description:'validate path boundary'}]);
  assert.equal(outcome.serial_justification_reason,'One state owner makes this phase serial');
  assert.deepEqual(data.remaining_planning.missing_stage_ids,['module-b']);
  assert.ok(Buffer.byteLength(text)<proof.length/4);
  assert.ok(store.workflowEvents().at(-1).result.outcome.serialProof.proof[0].evidence===proof,'full audit evidence remains intact');
  const later = Date.now() + 60_000;
  t.mock.method(Date, 'now', () => later);
  assert.equal(formatFrontierContext(store, 1), text);
});

test('execution review rejects missing protocol fields before queueing and a validation failure cannot poison corrected retries', async t => {
  const {store}=fixture(t),s=recordStage(store,1,stage('module-a')).stage,rt={},agent={status:'running'};
  assert.throws(()=>queueExecutionReview(rt,store,1,agent,s,{topic:'A'},()=>{}),/explicit kind="plan"/);
  assert.equal(store.workflowEvents().filter(e=>e.type==='execution-review-queued').length,0);
  assert.throws(()=>queueExecutionReview(rt,store,1,agent,s,{kind:'plan'},()=>{}),/non-empty topic/);
  const args={kind:'plan',topic:'A'};let calls=0;
  queueExecutionReview(rt,store,1,agent,s,args,()=>{calls++;throw Error('pre-agreement validation failure');});
  await Promise.all([...rt.executionReviewJobs.values()].map(j=>j.promise));
  queueExecutionReview(rt,store,1,agent,s,args,()=>{calls++;return{status:'error',id:'agr-real',error:'review service unavailable',hint:'resume this real agreement'};});
  await Promise.all([...rt.executionReviewJobs.values()].map(j=>j.promise));
  const cached=queueExecutionReview(rt,store,1,agent,s,args,()=>{calls++;});
  assert.equal(cached.id,'agr-real');assert.equal(calls,2,'a real-agreement error is resumed explicitly instead of replaying paid reviews');
});
function agreement(store, s, id) {
  store.saveAgreementInput(id, { kind: 'plan', taskSeq: 1, stageReview: s });
  store.appendAgreementEvent({ type: 'created', id, kind: 'plan', taskSeq: 1, maxRounds: 3, maxArbiterAttempts: 2 });
  for (const member of ['A', 'B']) store.appendAgreementEvent({ type: 'opinion', id, round: 1, member, opinion: { stance: 'approve', summary: 'Ready stage', reasons: ['Within contract'], suggestions: [], requiredChanges: [] } });
}
function approved(store, s, id) { agreement(store, s, id); store.appendWorkflowEvent({ type: 'execution-review-result', taskSeq: 1, reviewId: id, stageId: s.id, stageHash: s.hash, result: { status: 'settled', id, outcome: { decision: 'approve' } } }); }

test('waiting admission preserves independent dispatch but respects full capacity and write conflicts', t => {
  const {root,store}=fixture(t),a=recordStage(store,1,stage('module-a')).stage,b=recordStage(store,1,stage('module-b')).stage;
  approved(store,a,'agr-a');approved(store,b,'agr-b');
  const cfg=configWith({team:{rollingPlanning:true,maxActiveMembers:2}}),rt={config:cfg,storageRoot:root,activationLimit:()=>2};
  store.addMember({childId:'worker-a',name:'worker-a',profile:'code',taskSeq:1,stageId:a.id,stageHash:a.hash,writeScope:a.contract.write_scope,status:'running'});
  assert.equal(hasAdmissibleFrontierWork(rt,store,cfg,1),true,'free capacity and independent approved B still require action');
  rt.activationLimit=()=>1;assert.equal(hasAdmissibleFrontierWork(rt,store,cfg,1),false,'a full pool is a genuine wait');
  rt.activationLimit=()=>2;
  const overlap=recordStage(store,1,stage('module-b',{write_scope:a.contract.write_scope})).stage;approved(store,overlap,'agr-overlap');
  assert.equal(hasAdmissibleFrontierWork(rt,store,cfg,1),false,'write conflict cannot be solved by polling');
  store.setMemberStatus('worker-a','done');assert.equal(hasAdmissibleFrontierWork(rt,store,cfg,1),true,'real completion unlocks the next approved work');
});

test('Incremental stage admission binds approvals to task, stage and immutable version; partial future planning is allowed', t => {
  const { store } = fixture(t);
  const a = recordStage(store, 1, stage('module-a')).stage;
  recordStage(store, 1, { stage_id: 'module-b', goal: 'Later output conversion', ready: false });
  assert.throws(() => requireReadyStage(store, 1, 'module-b'), /provisional/);
  assert.throws(() => hydrateStageDispatch(store, 1, { stage_id: a.id, plan_id: 'unapproved' }), /no matching approved/);
  approved(store, a, 'agr-a');
  const args = hydrateStageDispatch(store, 1, { stage_id: a.id, plan_id: 'agr-a', name: 'writer-a' });
  assert.deepEqual(args.tools, ['read', 'write']); assert.ok(args.refs.includes(a.file));
  assert.throws(() => hydrateStageDispatch(store, 1, { stage_id: a.id, plan_id: 'agr-a', tools: ['read', 'pwsh'] }), /cannot override/);
  const oldFile = fs.readFileSync(a.file, 'utf8');
  const newer = recordStage(store, 1, stage('module-a', { write_scope: ['different/**'] })).stage;
  assert.notEqual(newer.hash, a.hash);
  assert.equal(fs.readFileSync(a.file, 'utf8'), oldFile);
  assert.throws(() => assertStageApproval(store, 1, a.id, 'agr-a'), /no matching approved/);
  assert.throws(() => assertStageApproval(store, 2, a.id, 'agr-a'), /unknown/);
  const b = recordStage(store, 1, stage('module-b')).stage;
  assert.throws(() => assertStageApproval(store, 1, b.id, 'agr-a'), /no matching approved/);
  const before = frontierState(store, 1).revision;
  assert.equal(recordStage(store, 1, stage('module-b')).changed, false);
  assert.equal(frontierState(store, 1).revision, before);
});

test('Expected inputs allow planning ahead; execution requires actual completion of the reviewed dependency version', t => {
  const { store } = fixture(t);
  const a = recordStage(store, 1, stage('module-a')).stage;
  const b = recordStage(store, 1, stage('module-b', { depends_on: ['module-a'], expected_inputs: ['A returns the agreed JSON'] })).stage;
  approved(store, a, 'agr-a'); approved(store, b, 'agr-b');
  assert.equal(frontierView(store,1).stages.find(s=>s.stage_id===b.id).execution_state,'waiting_dependencies');
  assert.throws(() => assertStageApproval(store, 1, b.id, 'agr-b'), /actual completed dependency/);
  store.addMember({ childId: 'writer-a', name: 'writer-a', taskSeq: 1, stageId: a.id, stageHash: a.hash, status: 'running' });
  assert.throws(() => assertStageApproval(store, 1, b.id, 'agr-b'), /actual completed dependency/);
  store.setMemberStatus('writer-a', 'done');
  assert.equal(frontierView(store,1).stages.find(s=>s.stage_id===a.id).execution_state,'member_done');
  assert.equal(frontierView(store,1).stages.find(s=>s.stage_id===b.id).execution_state,'approved_unassigned');
  assert.equal(assertStageApproval(store, 1, b.id, 'agr-b').id, b.id);
  recordStage(store, 1, stage('module-a', { method: 'A later revision for different future use' }));
  const view=frontierView(store,1).stages.find(s=>s.stage_id===a.id);
  assert.equal(view.execution_state,'needs_review','an old completed member cannot complete the new stage version');
  assert.equal(view.members[0].current_version,false);assert.equal(view.members[0].stage_hash,a.hash);
  assert.equal(assertStageApproval(store, 1, b.id, 'agr-b').hash, b.hash, 'B still binds the completed old contract, not an unreviewed new dependency');
  assert.throws(() => recordStage(store, 1, stage('module-a', { depends_on: ['module-b'] })), /cycle/);
});

test('Verification-bound dependencies block dispatch until current test evidence passes, and invalidate it after rework', t => {
  const { root, store } = fixture(t);
  const a = recordStage(store, 1, stage('module-a')).stage;
  const verify = recordStage(store, 1, stage('run-checks', { depends_on: [a.id] })).stage;
  const b = recordStage(store, 1, stage('module-b', { depends_on: [a.id], requires_verified: [a.id] })).stage;
  approved(store, a, 'agr-a'); approved(store, b, 'agr-b'); approved(store, verify, 'agr-verify');
  store.addMember({ childId: 'writer-a', name: 'writer-a', taskSeq: 1, stageId: a.id, stageHash: a.hash });
  store.setMemberStatus('writer-a', 'done');
  const stateOf = id => frontierView(store, 1).stages.find(s => s.stage_id === id);
  const first = stateOf(a.id).verification.generation;
  const admission = () => hydrateStageDispatch(store, 1, { stage_id: b.id, plan_id: 'agr-b' });
  assert.throws(admission, /passed verification.*unverified/);
  assert.equal(assertStageApproval(store, 1, verify.id, 'agr-verify').id, verify.id);
  const file = path.join(root, 'test-output.txt');
  fs.writeFileSync(file, 'test fixture evidence');
  const record = (result, generation = first) => recordStageVerification(store, 1, {
    stage_id: a.id, stage_hash: a.hash, verification_generation: generation, verification_result: result, refs: [file],
  });
  record('failed');
  assert.throws(admission, /passed verification.*failed/);
  assert.deepEqual(stateOf(b.id).waiting_verification, [{ stage_id: a.id, status: 'failed' }]);
  record('passed');
  assert.equal(admission().stageHash, b.hash);
  store.setMemberStatus('writer-a', 'done');
  assert.equal(admission().stageHash, b.hash, 'duplicate status does not invalidate completed work');
  store.setMemberStatus('writer-a', 'running');
  assert.throws(admission, /actual completed dependency/);
  store.setMemberStatus('writer-a', 'done');
  assert.throws(admission, /passed verification.*unverified/);
  assert.throws(() => record('passed'), /stage ran again/);
  const autoBound = recordStageVerification(store, 1, { stage_id: a.id, verification_result: 'passed', refs: [file] });
  assert.equal(autoBound.generation, stateOf(a.id).verification.generation);
  assert.equal(admission().stageHash, b.hash);
  recordStage(store, 1, stage('module-a', { method: 'Change the prerequisite contract after verification' }));
  assert.throws(admission, /current dependency version/);
  assert.throws(() => recordStage(store, 1, stage('invalid', { requires_verified: [a.id] })), /subset of depends_on/);
});

test('Stage review returns immediately: B planning advances before A review completes, with no running-agent interruption', async t => {
  const { store } = fixture(t), a = recordStage(store, 1, stage('module-a')).stage;
  const held = deferred(), notices = [], rt = {}, agent = { status: 'running', followup: x => notices.push(x) };
  const args = { kind: 'plan', stage_id: a.id, topic: 'A' }; let calls = 0;
  const queued = queueExecutionReview(rt, store, 1, agent, a, args, async () => { calls++; await held.promise; agreement(store, a, 'agr-a'); return { status: 'settled', id: 'agr-a', outcome: { decision: 'approve' } }; });
  assert.equal(queued.status, 'reviewing'); assert.equal(stageApproval(store, 1, a), null);
  recordStage(store, 1, { stage_id: 'module-b', goal: 'Plan B while A waits', method: 'Continue independently', ready: false });
  assert.equal(frontierState(store, 1).stages.has('module-b'), true);
  assert.equal(frontierView(store, 1).pending_execution_reviews.length, 1);
  const duplicate = queueExecutionReview(rt, store, 1, agent, a, args, async () => { throw Error('duplicate review'); });
  assert.equal(duplicate.review_id, queued.review_id);
  const work = [...rt.executionReviewJobs.values()][0].promise;
  held.resolve(); await work;
  assert.equal(calls, 1); assert.equal(stageApproval(store, 1, a), 'agr-a'); assert.equal(notices.length, 0);
  assert.equal(queueExecutionReview(rt, store, 1, agent, a, args, () => { throw Error('completed work repeated'); }).id, 'agr-a');
});

test('Interrupted reviews recover one pending ticket; late aborted answers cannot replace the recovered result or wake another task', async t => {
  const { store } = fixture(t), a = recordStage(store, 1, stage('module-a')).stage;
  const late = deferred(), rt = {}, agent = { status: 'idle', followup() { throw Error('old task wakeup'); } }, args = { kind: 'plan', stage_id: a.id, topic: 'A' };
  const first = queueExecutionReview(rt, store, 1, agent, a, args, async () => { await late.promise; return { status: 'settled', id: 'agr-old', outcome: { decision: 'approve' } }; });
  const oldWork = [...rt.executionReviewJobs.values()][0].promise;
  disposePlanning(rt);
  const recovered = { currentPlanningTaskSeq: () => 2 };
  const second = queueExecutionReview(recovered, store, 1, agent, a, args, async () => { agreement(store, a, 'agr-new'); return { status: 'settled', id: 'agr-new', outcome: { decision: 'approve' } }; });
  assert.equal(second.review_id, first.review_id);
  await [...recovered.executionReviewJobs.values()][0].promise;
  late.resolve(); await oldWork;
  assert.equal(stageApproval(store, 1, a), 'agr-new');
  assert.equal(store.workflowEvents().filter(e => e.type === 'execution-review-result').length, 1);
});
