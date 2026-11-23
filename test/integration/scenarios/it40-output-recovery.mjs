import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, agreementEvents, read } from '../lib.mjs';
import { replay } from '../../../leaderteam/core/agreement.mjs';
export default {
  files: { 'spec.md': 'Write src/a.txt containing A.\n' },
  respond(c) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'member') return [
      { tool:'read', args:{file_path:'spec.md'} },
      { tool:'write', args:{file_path:'src/a.txt',content:'A\n'} },
      { content:'STATUS: done' },
    ][c.index-1] ?? {content:'STATUS: done'};
    if (c.kind === 'leader') {
      if (c.index === 1) return {content:'Partial analysis before first tool.',finishReason:'length'};
      if (c.index === 2) return PLAN;
      if (c.index === 3) return dispatch({plan_id:latestPlanId(c)});
      if (c.index === 4) return {content:'WAITING_MEMBERS'};
      if (c.index === 5) return DELIVERY;
      return {content:'DELIVERY: approved'};
    }
  },
  assert(t) {
    assert.equal(t.runs.length,1,'no external continue or rerun');
    assert.equal(t.runs[0].code,0);
    assert.match(callsOf(t,'leader')[1].text,/LeaderTeam output recovery/);
    assert.equal(read(t,'src/a.txt'),'A\n');
    const created=agreementEvents(t).filter(e=>e.type==='created');
    assert.deepEqual(created.map(e=>e.kind),['plan','delivery']);
    assert.ok(created.every(e=>(e.taskSeq??1)===1),'recovery retains original task');
    const delivery=replay(agreementEvents(t).filter(e=>e.id===created[1].id).map(({v,at,...e})=>e));
    assert.equal(delivery.status,'settled');
    assert.equal(delivery.outcome.decision,'approve');
  },
};
