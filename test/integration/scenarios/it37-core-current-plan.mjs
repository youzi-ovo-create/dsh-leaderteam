import fs from 'node:fs';
import {assert,allow,approve,DELIVERY,dispatch,lastToolResult,read,callsOf} from '../lib.mjs';
const plan='Complete architecture: one file src/result.txt, implementation then verification and reviewed delivery. No abbreviated phases.';
export default {
  config:{plugins:{timerArchive:false,scheduler:false}},
  files:{'spec.md':'Write src/result.txt containing CORE_PLAN_OK.\n'},
  respond(c,t){
    if(c.kind==='gate')return allow;
    if(c.kind==='discuss')return approve;
    if(c.kind==='leader'){
      if(c.index===1)return{tool:'team_note',args:{scope:'current_plan',path:'plan.md',content:plan}};
      if(c.index===2){t.state.path=JSON.parse(lastToolResult(c)).path;return{tool:'team_discuss',args:{kind:'plan',topic:'core plan',proposal:'IGNORED PLACEHOLDER'}};}
      if(c.index===3){t.state.plan=JSON.parse(lastToolResult(c)).id;return dispatch({name:'core-plan-member',plan_id:t.state.plan,task:'Read the external current plan and spec.md; write src/result.txt containing CORE_PLAN_OK.',write_scope:['src/result.txt'],refs:['spec.md',t.state.path]});}
      if(c.index===4)return{content:'WAITING'};
      if(c.index===5)return DELIVERY;
      return{content:'DELIVERY: approved'};
    }
    if(c.kind==='member')return[{tool:'read',args:{file_path:'spec.md'}},{tool:'read',args:{file_path:t.state.path}},{tool:'write',args:{file_path:'src/result.txt',content:'CORE_PLAN_OK\n'}},{content:'STATUS: done'}][c.index-1];
  },
  assert(t){assert.equal(t.runs[0].code,0);assert.equal(read(t,'src/result.txt'),'CORE_PLAN_OK\n');assert.equal(fs.readFileSync(t.state.path,'utf8'),plan);assert.equal(callsOf(t,'discuss')[0].request.proposal,plan);assert.equal(fs.existsSync(t.ws+'/.leaderteam/refs/plan.md'),false);assert.match(t.runs[0].final.text,/DELIVERY: approved/);}
};
