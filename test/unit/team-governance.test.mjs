import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtime, runtimeForTeam, teamStore, bindRuntimeConfigFile, syncRuntimeConfig, baseRuntime } from '../../leaderteam/host/runtime.mjs';
import { executionModelRows, validateExecutionChoice } from '../../leaderteam/core/models.mjs';
import { configWith } from './helpers.mjs';
const GLM = 'zcode/GLM-5.3', SOL = 'codex/gpt-6.1-sol';
function setup(t) {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lt-governance-'));
 const rt=runtime(), previous={...rt};
 Object.assign(rt,{config:configWith({}),configPath:null,configWatch:null,storageRoot:path.join(tmp,'store'),stores:new Map(),teamConfigViews:new Map()});
 t.after(()=>{Object.assign(rt,previous);fs.rmSync(tmp,{recursive:true,force:true});});
 teamStore('team-a').ensure({workspace:tmp,surface:'headless'});
 return {rt,tmp};
}
test('existing governance remains frozen while execution pool, effort and capacity changes are live', t=>{
 const {rt}=setup(t), a=runtimeForTeam('team-a');
 assert.equal(a.config.roles.gate.route,SOL);
 const next=configWith({roles:{gate:{route:GLM,effort:'high',fallback:[]},arbiter:{route:SOL,effort:'max'},serialReviewer:{route:GLM,effort:'high'}},models:{[GLM]:{efforts:['high'],defaultEffort:'high'}},team:{executionPool:[GLM],maxActiveMembers:1}});
 rt.config=next;
 assert.equal(a.config.roles.gate.route,SOL);
 assert.equal(a.config.roles.arbiter.route,GLM);
 assert.equal(a.config.team.maxActiveMembers,1);
 assert.deepEqual(executionModelRows(a.config,null,new Date()).map(m=>[m.route,m.efforts]),[[GLM,['high']]]);
 assert.equal(validateExecutionChoice(a.config,GLM,'max').ok,false);
 assert.equal(validateExecutionChoice(a.config,SOL,'high').ok,false);
 assert.equal(runtimeForTeam('team-b').config.roles.gate.route,GLM);
 assert.equal(rt.config,next,'team views do not replace the live defaults');
 assert.equal(baseRuntime(a),rt);
});
test('a cold view reload preserves the snapshot and rejects a corrupted governance file',t=>{
 const {rt}=setup(t);
 assert.equal(runtimeForTeam('team-a').config.roles.gate.route,SOL);
 rt.config=configWith({roles:{gate:{route:GLM,effort:'high',fallback:[]}}});
 rt.teamConfigViews=new Map();
 assert.equal(runtimeForTeam('team-a').config.roles.gate.route,SOL);
 const p=path.join(teamStore('team-a').dir,'governance.json');
 const record=JSON.parse(fs.readFileSync(p,'utf8'));record.config.roles.gate.route=GLM;fs.writeFileSync(p,JSON.stringify(record));
 rt.teamConfigViews=new Map();
 assert.throws(()=>runtimeForTeam('team-a'),/corrupt/);
});
test('hot reload through a team view updates live defaults without rebinding the watcher to the frozen view',t=>{
 const {rt,tmp}=setup(t), view=runtimeForTeam('team-a');
 const file=path.join(tmp,'configuration.json');
 const raw=structuredClone(rt.config);delete raw.derived;
 fs.writeFileSync(file,JSON.stringify(raw));
 bindRuntimeConfigFile(view,file);
 assert.equal(rt.configWatch.boundConfigRef,rt.config);
 const next=structuredClone(raw);next.roles.gate.route=GLM;next.roles.gate.fallback=[];next.team.executionPool=[GLM];
 fs.writeFileSync(file,JSON.stringify(next)+'\n');
 assert.equal(syncRuntimeConfig(view).reloaded,true);
 assert.equal(rt.config.roles.gate.route,GLM);
 assert.equal(view.config.roles.gate.route,SOL);
 assert.deepEqual(view.config.team.executionPool,[GLM]);
});
