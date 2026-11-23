import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchContract} from '../../leaderteam/core/dispatch-contract.mjs';
test('missing dispatch choices are reported together before they can masquerade as absent approval',()=>{
  const cfg={team:{rollingPlanning:true}},args={name:'impl-core',stage_id:'implementation'};
  assert.throws(()=>dispatchContract(null,cfg,1,args),e=>{
    assert.match(e.message,/Missing required dispatch arguments: model, effort, plan_id/);
    assert.match(e.message,/argument error/);assert.match(e.message,/not a request to revise or re-review/);
    assert.doesNotMatch(e.message,/has no matching approved execution review/);return true;
  });
  assert.deepEqual(args,{name:'impl-core',stage_id:'implementation'},'the host never chooses a model or fills permission implicitly');
});
test('missing model and effort cannot pass on the strength of a supplied plan id',()=>{
  assert.throws(()=>dispatchContract(null,{team:{rollingPlanning:true}},1,{name:'impl-core',stage_id:'implementation',plan_id:'agr-approved'}),/Missing required dispatch arguments: model, effort\./);
});
