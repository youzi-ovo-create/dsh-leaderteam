import { assert, allow, approve, PLAN, dispatch, latestPlanId, callsOf, lastToolResult, memberRecords } from '../lib.mjs';
const SH = process.platform === 'win32' ? 'pwsh' : 'bash';
const SH_CMD = process.platform === 'win32' ? 'Get-Location' : 'pwd';
export default {
  files: { 'spec.md': 'test\n' },
  runs: [{ task: 'Exercise a sandbox initialization failure.' }, { task: 'Resume the same blocked member after restart.', resume: true }],
  extraPatches: ['test/integration/fixtures/it25-sandbox-failure.patch.yml'],
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') {
      if (!t.runs.length) return [PLAN, dispatch({ plan_id: latestPlanId(c), profile: 'shell', tools: ['read', SH] }), { content: 'WAITING' }, dispatch({ plan_id: latestPlanId(c), name: 'retry', profile: 'shell', tools: ['read', SH] }), { content: 'BLOCKED: workspace sandbox' }][c.index - 1];
      t.state.resumedLeader = (t.state.resumedLeader ?? 0) + 1;
      // A resumed shell-profile member must have a current-task plan even when it only reports its durable fault.
      return [PLAN, { tool: 'send_message', args: { agent_id: memberRecords(t).find(r => r.type === 'member').childId, message: 'Report the existing sandbox fault without running commands.' } }, { content: 'WAITING' }, { content: 'BLOCKED: existing fault preserved' }][t.state.resumedLeader - 1];
    }
    if (c.kind === 'member') {
      if (c.index === 1) return { tool: 'read', args: { file_path: 'spec.md' } };
      if (c.index === 2) return { tool: SH, args: { description: 'Check working directory', command: SH_CMD } };
      if (c.index === 3) {
        assert.ok(!c.tools.includes(SH), 'failed startup removes shell schema');
        return { tool: 'team_tools', args: { action: 'load', names: [SH] } };
      }
      if (c.index === 4) { assert.match(lastToolResult(c), /shell retries are disabled/); return { content: 'STATUS: blocked' }; }
      if (c.index === 5) { assert.ok(!c.tools.includes(SH), 'cold recovery keeps shell hidden'); return { tool: 'team_tools', args: { action: 'load', names: [SH] } }; }
      if (c.index === 6) { assert.match(lastToolResult(c), /shell retries are disabled/); return { content: 'STATUS: blocked' }; }
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0);
    assert.equal(t.runs[1].code, 0);
    assert.equal(callsOf(t, 'member').length, 6);
    const records = memberRecords(t);
    assert.equal(records.filter(r => r.type === 'member').length, 1, 'no new shell member for an unrepaired workspace');
    assert.ok(records.some(r => r.shellFailure && !r.loadedTools.includes(SH)), 'fault and reduced tools persisted');
    const leader = callsOf(t, 'leader');
    assert.match(lastToolResult(leader.find(c => c.index === 5)), /stop shell dispatches/);
  },
};
