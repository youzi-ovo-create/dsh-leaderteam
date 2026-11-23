import {assert,allow,approve,lastToolResult,callsOf} from '../lib.mjs';
export default {
  respond(c,t){
    if(c.kind==='gate')return allow;
    if(c.kind==='discuss')return c.request.kind==='plan'?approve:{json:{stance:'revise',summary:'Browser evidence missing',reasons:['The required browser cannot start in this environment'],suggestions:['Ask the workspace owner to restore the browser sandbox'],required_changes:['Run actual browser verification'],change_items:[{id:'browser',problem:'Run actual browser verification',evidence:'Browser process failed before page load',suggestion:'Ask the workspace owner to restore browser startup',hard_blocker:true,category:'user_requirement'}]}};
    if(c.kind==='leader'){
      if(c.index===1)return{tool:'team_discuss',args:{kind:'plan',topic:'Verify browser',proposal:'Verify the user-required browser behavior and disclose any environment failure.'}};
      if(c.index===2)return{tool:'team_discuss',args:{kind:'delivery',topic:'Environment blocked',proposal:'Browser cannot start; actual verification is incomplete.',environment_blocked:true,blocker_reason:'Browser process failed at launch; permissions repair is outside the team scope.'}};
      if(c.index===3){t.state.first=JSON.parse(lastToolResult(c)).id;return{tool:'team_discuss',args:{kind:'delivery',topic:'Same environment blocker',proposal:'Still blocked; no fabricated browser evidence.',revises:t.state.first,environment_blocked:true,blocker_reason:'The same browser startup problem needs owner assistance.'}};}
      t.state.result=JSON.parse(lastToolResult(c));return{content:'请选择带披露交付、协助环境修复或停止。'};
    }
  },
  assert(t){assert.equal(t.runs[0].code,0);assert.equal(t.state.result.status,'waiting_user');assert.deepEqual(t.state.result.escalation.options,['disclosed_delivery','user_assistance','stop']);assert.equal(callsOf(t,'discuss').length,6);assert.equal(t.state.result.outcome.decision,'revise');}
};
