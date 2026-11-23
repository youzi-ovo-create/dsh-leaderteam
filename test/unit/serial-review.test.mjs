import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyEvent, nextAction, replay, buildMemberRequest } from '../../leaderteam/core/agreement.mjs';
import { needsSerialProof, parseSerialProof } from '../../leaderteam/core/serial-review.mjs';
import { configWith } from './helpers.mjs';
const created = { type:'created', id:'agr-serial', kind:'plan', topic:'scope', proposalHash:'hash', maxRounds:3, maxArbiterAttempts:1, serialProofRequired:true };
const op = stance => ({stance,summary:stance,reasons:['concrete reason'],requiredChanges:stance==='revise'?['Split independently implementable units']:[],suggestions:[]});
const opinion = (round,member,stance='approve') => ({type:'opinion',id:created.id,round,member,opinion:op(stance)});
const both = (s,n,a='approve',b=a) => applyEvent(applyEvent(s,opinion(n,'A',a)),opinion(n,'B',b));
const input = {kind:'plan',userRequest:'Replace one literal in one existing file',stageReview:{id:'a',contract:{goal:'Replace one literal in one existing file',write_scope:['src/a.txt'],parallel_with:[],depends_on:[]}},planningContext:{stages:[]}};
const noProof = {verdict:'not_proven',responsibilities:['reader','formatter'],proof:[],reason:'Pure formatting can be implemented independently',feedback:['Reassess reader/formatter against a fixed interface with separate file ownership']};
const yesProof = {verdict:'proven',responsibilities:['one literal replacement'],proof:[{constraint:'Indivisible edit',evidence:input.userRequest,rules_out:'The single literal edit has no other implementation responsibility'}],reason:'One atomic edit',feedback:[]};

test('tentative approval cannot authorize execution; negative proof returns to BOTH original reviewers',()=>{
  const events=[created,opinion(1,'A'),opinion(1,'B')];
  let s=replay(events); assert.equal(s.outcome,null); assert.equal(s.status,'serial-review'); assert.equal(nextAction(s).kind,'serial-review');
  events.push({type:'serial-proof',id:created.id,proof:noProof}); s=replay(events);
  assert.equal(s.outcome,null); assert.deepEqual(nextAction(s),{kind:'members',round:2,members:['A','B']});
  for(const member of ['A','B']) assert.deepEqual(JSON.parse(buildMemberRequest({state:s,member,...input}).user).serial_review_feedback.feedback,noProof.feedback);
  s=both(s,2,'revise');assert.equal(s.outcome.decision,'revise');assert.equal(s.serialReviews.length,1);
});
test('source-backed proof settles once; replay resumes the pending proof without repeating A/B',()=>{
  const s=both(initialState(created),1); const done=applyEvent(s,{type:'serial-proof',id:created.id,proof:yesProof});
  assert.equal(done.outcome.decision,'approve');assert.equal(done.outcome.serialProof.verdict,'proven');
  assert.throws(()=>applyEvent(done,{type:'serial-proof',id:created.id,proof:noProof}));
  assert.equal(nextAction(replay([created,opinion(1,'A'),opinion(1,'B')])).kind,'serial-review');
});
test('repeated unsupported approvals cannot exhaust the protocol into an executable approval',()=>{
  let s=initialState(created);
  for(let n=1;n<=3;n++){s=both(s,n);s=applyEvent(s,{type:'serial-proof',id:created.id,proof:noProof});}
  assert.equal(s.outcome.decision,'revise');assert.equal(s.outcome.by,'serial-review');assert.deepEqual(s.outcome.requiredChanges,noProof.feedback);
});
test('arbiter cannot bypass a pending serial challenge by adopting a later approval',()=>{
  let s=initialState({...created,maxRounds:2});s=both(s,1);s=applyEvent(s,{type:'serial-proof',id:created.id,proof:noProof});
  s=both(s,2,'approve','revise');s=applyEvent(s,{type:'arbiter-attempt',id:created.id});s=applyEvent(s,{type:'ruling',id:created.id,ruling:{adopt:'A'}});
  assert.equal(s.outcome,null);assert.equal(nextAction(s).kind,'serial-review');
});
test('only genuine parallel contracts skip this narrow role; names, overlapping scopes and transitive dependencies do not',()=>{
  assert.equal(needsSerialProof(input),true);
  const x=structuredClone(input);x.stageReview.contract.parallel_with=['b'];
  x.planningContext.stages=[{stage_id:'b',ready:true,depends_on:[],write_scope:['src/b.txt']}];assert.equal(needsSerialProof(x),false);
  x.planningContext.stages[0].write_scope=['src/**'];assert.equal(needsSerialProof(x),true);
  x.planningContext.stages[0].write_scope=['src/b.txt'];x.planningContext.stages[0].depends_on=['c'];x.planningContext.stages.push({stage_id:'c',depends_on:['a']});assert.equal(needsSerialProof(x),true);
  assert.equal(needsSerialProof({...input,kind:'delivery'}),false);
});
test('proof parser rejects empty grounds and empty approval; old configuration remains loadable',()=>{
  assert.equal(parseSerialProof(JSON.stringify(yesProof),input).ok,true);assert.equal(parseSerialProof(JSON.stringify(noProof),input).ok,true);
  assert.equal(parseSerialProof(JSON.stringify({...yesProof,proof:[]}),input).ok,false);
  const emptyGrounds=structuredClone(yesProof);emptyGrounds.proof[0].evidence='';assert.equal(parseSerialProof(JSON.stringify(emptyGrounds),input).ok,false);
  assert.ok(configWith({roles:{serialReviewer:{route:'zcode/GLM-5.3',effort:'low',maxTokens:2400,timeoutMs:120000,retries:0}}}).roles.serialReviewer);
});
test('supported coordination overhead can justify serial even when a split is technically possible',()=>{
  const i=structuredClone(input);i.userRequest='Update two adjacent branches of the same 12-line error handler, preserving identical message formatting';
  const p={verdict:'proven',responsibilities:['branch A','branch B'],proof:[{constraint:'Both tiny edits affect the same handler and formatting invariant; separate ownership adds integration work compared with the edits',evidence:i.userRequest,rules_out:'Parallel edits are technically possible but not proportionate here'}],reason:'One owner can make and verify both coupled edits together; this is an engineering judgment, not measured timing',feedback:[]};
  assert.equal(parseSerialProof(JSON.stringify(p),i).ok,true);
  const done=applyEvent(both(initialState(created),1),{type:'serial-proof',id:created.id,proof:p});assert.equal(done.outcome.decision,'approve');
});
