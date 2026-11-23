import {assert,allow,dispatch,callsOf,toolResults} from '../lib.mjs';
export default {
  config:{plugins:{consensus:false,timerArchive:false,scheduler:false}},
  files:{'spec.md':'Write src/result.txt only after required approval.\n'},
  respond(c){
    if(c.kind==='gate')return allow;
    if(c.kind==='leader')return c.index===1?dispatch({name:'blocked-writer',write_scope:['src/**']}):{content:'Required review is unavailable; blocked without creating a writing member.'};
    return {content:'UNEXPECTED_MEMBER'};
  },
  assert(t){assert.equal(t.runs[0].code,0);assert.equal(callsOf(t,'member').length,0);assert.ok(toolResults(t.runs[0]).some(r=>/required plan review is unavailable/.test(JSON.stringify(r))));}
};
