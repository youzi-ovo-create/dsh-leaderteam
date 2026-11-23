import fs from 'node:fs';
import path from 'node:path';
import { assert, approve, allow, teamDir, callsOf } from '../lib.mjs';
import { replay } from '../../../leaderteam/core/agreement.mjs';
const jsonl=f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
const tool=(tool,args)=>({tool,args});
const role=route=>({route,effort:'low',maxTokens:2400,timeoutMs:20000,retries:0,fallback:[]});
const stage=(id,packed=false)=>({action:'stage',stage_id:id,goal:packed?'Write both independent report files':'Write one atomic report file',method:'Write assigned text and inspect it',interfaces:['Standalone text file, no shared mutation'],acceptance:['Assigned file contains OK'],profile:'code',tools:['read','write'],write_scope:packed?['src/**']:[`src/${id}.txt`],parallel_with:packed?[]:[id==='main'?'buddy':'main'],serial_reason:packed?'One worker handles both reports':'',ready:true});
function state(t){const d=teamDir(t),wf=jsonl(path.join(d,'workflow.jsonl')),latest=Object.fromEntries(wf.filter(e=>e.stage).map(e=>[e.stage.id,e.stage]));const approvals=Object.fromEntries(wf.filter(e=>e.type==='execution-review-result'&&e.stageHash===latest[e.stageId]?.hash&&e.result.outcome?.decision==='approve').map(e=>[e.stageId,e.result.id]));const members=new Map();for(const e of jsonl(path.join(d,'members.jsonl')))if(e.childId)members.set(e.childId,{...members.get(e.childId),...e});return{wf,latest,approvals,members:[...members.values()]};}
export default {
  config:{team:{rollingPlanning:true},roles:{leader:{route:'zcode/GLM-5.3-Flash',effort:'low'},discussA:role('zcode/GLM-5.3'),discussB:role('zcode/GLM-5.3-Flash'),serialReviewer:role('zcode/GLM-5.3')}},
  async respond(c,t){
    if(c.kind==='gate')return allow;
    if(c.kind==='serial-review'){
      const events=jsonl(path.join(teamDir(t),'agreements.jsonl')).filter(e=>e.id===c.request.agreement_id);
      const s=replay(events);assert.equal(s.outcome,null);assert.equal(s.status,'serial-review');
      t.state.pendingWasNotApproved=true;
      return{json:{verdict:'not_proven',responsibilities:['report A','report B'],proof:[],reason:'The files are independent',feedback:['Both reviewers must reassess splitting the two independent file owners']}};
    }
    if(c.kind==='discuss'){
      if(c.request.serial_review_feedback){t.state.reassessed??=new Set();t.state.reassessed.add(c.who);return{json:{stance:'revise',summary:'Split independent owners',reasons:['The challenger identified separate outputs without a dependency'],suggestions:['Use separate src/main.txt and src/buddy.txt owners'],required_changes:['Split the independent report writers before dispatch']}};}
      return approve;
    }
    if(c.kind==='leader'){
      const p=t.state.phase??0;t.state.phase=p+1;
      if(p===0)return tool('team_plan',{action:'overview',summary:'Two independent text reports',approach:'Plan bounded outputs and independently verify',acceptance:['Both files contain OK'],estimated_minutes:2,future_work:['main','buddy']});
      if(p===1)return tool('team_plan',stage('main',true));
      if(p===2)return tool('team_discuss',{kind:'plan',stage_id:'main',topic:'Initial combined report implementation'});
      if(p===3)return tool('team_plan',stage('buddy'));
      const s=state(t);
      const rejected=s.wf.find(e=>e.type==='execution-review-result'&&e.stageId==='main'&&e.result.outcome?.decision==='revise');
      if(rejected&&!t.state.changed){t.state.changed=true;return tool('team_plan',stage('main'));}
      if(t.state.changed&&!t.state.reviewA){t.state.reviewA=true;return tool('team_discuss',{kind:'plan',stage_id:'main',topic:'Split report A'});}
      if(t.state.reviewA&&!t.state.reviewB){t.state.reviewB=true;return tool('team_discuss',{kind:'plan',stage_id:'buddy',topic:'Split report B'});}
      for(const id of ['main','buddy'])if(s.approvals[id]&&!s.members.some(m=>m.name===id))return tool('team_dispatch',{name:id,stage_id:id,plan_id:s.approvals[id],model:'zcode/GLM-5.3-Flash',effort:'low'});
      if(s.members.length===2&&s.members.every(m=>m.status==='done')){
        if(!t.state.delivery){t.state.delivery=true;return tool('team_discuss',{kind:'delivery',topic:'Both files exist',proposal:'Two disjoint writers completed and checked their actual output',evidence_files:['src/main.txt','src/buddy.txt']});}
        return{content:'DELIVERY: approved'};
      }
      if(s.members.some(m=>['running','starting','started'].includes(m.status)))return{content:'WAITING'};
      return tool('team_plan',{action:'state'});
    }
    if(c.kind==='member'){
      const s=state(t),contract=s.latest[c.who];
      if(c.index===1)return tool('read',{file_path:contract.file});
      if(c.index===2)return tool('write',{file_path:`src/${c.who}.txt`,content:'OK\n'});
      if(c.index===3)return tool('read',{file_path:`src/${c.who}.txt`});
      return{content:'STATUS: done\nEVIDENCE: actual output read'};
    }
  },
  assert(t){assert.equal(t.runs[0].code,0);assert.ok(t.state.pendingWasNotApproved);assert.deepEqual([...t.state.reassessed].sort(),['A','B']);assert.equal(callsOf(t,'serial-review').length,1);for(const id of ['main','buddy'])assert.equal(fs.readFileSync(path.join(t.ws,`src/${id}.txt`),'utf8'),'OK\n');assert.match(t.runs[0].final.text,/DELIVERY: approved/);}
};
