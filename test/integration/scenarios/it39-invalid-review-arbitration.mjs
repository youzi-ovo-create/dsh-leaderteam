import {assert,allow,approve,lastToolResult,callsOf} from '../lib.mjs';
export default {
  config:{team:{leaderModelAsLastResort:false},roles:{discussB:{retries:1}}},
  respond(c,t){
    if(c.kind==='gate')return allow;
    if(c.kind==='discuss')return c.who==='A'?approve:{json:{stance:'reject',summary:'不同意',reasons:['反对'],required_changes:[]}};
    if(c.kind==='arbiter')return approve;
    if(c.kind==='leader'){
      if(c.index===1)return{tool:'team_discuss',args:{kind:'plan',topic:'Review actual proposal',proposal:'Implement a workspace-only parser and actually verify output before delivery.'}};
      t.state.result=JSON.parse(lastToolResult(c));return{content:'Arbiter completed independent review.'};
    }
  },
  assert(t){assert.equal(t.runs[0].code,0);assert.equal(callsOf(t,'discuss','B').length,2);assert.equal(callsOf(t,'arbiter').length,1);assert.equal(t.state.result.outcome.by,'arbiter');assert.equal(t.state.result.outcome.decision,'approve');}
};
