import { assert, allow, approve, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, lastToolResult, memberRecords, read } from '../lib.mjs';
import fs from 'node:fs';

export default {
  files: { 'spec.md': 'spec\n' },
  extraPatches: ['test/integration/fixtures/it21-fake-tool.patch.yml'],
  config: {
    toolPolicy: {
      additionalTools: ['it21_fake_mcp_tool'],
    },
  },
  runs: [{ task: 'first run' }, { task: 'second run: continue', resume: true }],
  beforeRun(_t, { cfgFile, index }) {
    if (index !== 1) return;
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg.profiles.code.tools.push('it21_fake_mcp_tool');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') return approve;
    if (c.kind === 'leader') {
      t.state.l = (t.state.l ?? 0) + 1;
      if (t.runs.length === 0) {
        if (t.state.l === 1) return PLAN;
        if (t.state.l === 2) return dispatch({ plan_id: latestPlanId(c), tools: ['read', 'write'], defer_tools: ['write'], write_scope: ['src/**'], refs: ['spec.md'] });
        if (t.state.l === 3) return { content: 'WAITING' };
        return { content: 'RUN1_DONE' };
      }
      t.state.l2 = (t.state.l2 ?? 0) + 1;
      if (t.state.l2 === 1) return PLAN;
      if (t.state.l2 === 2) {
        const child = memberRecords(t).find(r => r.type === 'member').childId;
        return { tool: 'send_message', args: { agent_id: child, message: 'Also write src/b.txt containing B.' } };
      }
      if (t.state.l2 === 3) return { content: 'WAITING2' };
      if (t.state.l2 === 4) return DELIVERY;
      return { content: 'DELIVERY: approved' };
    }
    if (c.kind === 'member') {
      t.state.m = (t.state.m ?? 0) + 1;
      const idx = t.state.m;
      if (idx === 1) {
        assert.ok(!c.tools.includes('write'), 'first request must not include deferred write');
        assert.ok(!c.tools.includes('edit'), 'first request must not include unselected edit');
        assert.ok(!c.tools.includes('it21_fake_mcp_tool'), 'first request must not include unselected fake tool');
        assert.ok(c.tools.includes('read'), 'read must be present');
        assert.ok(c.tools.includes('team_tools'), 'team_tools must be present');
        assert.ok(c.tools.includes('team_skills'), 'team_skills must be present');
        const payloadStr = JSON.stringify(c.payload);
        assert.ok(!payloadStr.includes('IT21_FAKE_MCP_TOOL_DESC'), 'fake tool description absent from first request');
        assert.ok(!payloadStr.includes('IT21_FAKE_PARAM_DESC'), 'fake tool parameter absent from first request');
        return { tool: 'team_tools', args: { action: 'load', names: ['edit'] } };
      }
      if (idx === 2) {
        assert.match(lastToolResult(c), /tool is not authorized for this task: edit/);
        return { tool: 'team_tools', args: { action: 'load', names: ['it21_fake_mcp_tool'] } };
      }
      if (idx === 3) {
        assert.match(lastToolResult(c), /tool is not authorized for this task: it21_fake_mcp_tool/);
        return { tool: 'read', args: { file_path: 'spec.md' } };
      }
      if (idx === 4) {
        return { tool: 'team_tools', args: { action: 'load', names: ['write'] } };
      }
      if (idx === 5) {
        assert.match(lastToolResult(c), /"loaded":\s*\[\s*"write"\s*\]/);
        assert.ok(c.tools.includes('write'), 'next request includes write');
        assert.ok(!c.tools.includes('edit'), 'next request does not include edit');
        assert.ok(!c.tools.includes('it21_fake_mcp_tool'), 'next request does not include fake tool');
        const payloadStr = JSON.stringify(c.payload);
        assert.ok(!payloadStr.includes('IT21_FAKE_MCP_TOOL_DESC'), 'fake tool description remains absent');
        return { tool: 'write', args: { file_path: 'src/a.txt', content: 'A\n' } };
      }
      if (idx === 6) {
        return { content: 'STATUS: done\nCHANGED: src/a.txt\nEVIDENCE: wrote file\nNOTES: none' };
      }
      if (idx === 7) {
        assert.ok(c.tools.includes('write'), 'resumed member retains loaded write');
        assert.ok(!c.tools.includes('edit'), 'resumed member does not include ungranted edit');
        assert.ok(!c.tools.includes('it21_fake_mcp_tool'), 'resumed member does not include fake tool');
        const payloadStr = JSON.stringify(c.payload);
        assert.ok(!payloadStr.includes('IT21_FAKE_MCP_TOOL_DESC'), 'fake tool description absent on resume');
        return { tool: 'read', args: { file_path: 'spec.md' } };
      }
      if (idx === 8) {
        assert.ok(c.tools.includes('write'), 'resumed member still has write');
        return { tool: 'write', args: { file_path: 'src/b.txt', content: 'B\n' } };
      }
      if (idx === 9) {
        return { content: 'STATUS: done\nCHANGED: src/b.txt\nEVIDENCE: wrote b\nNOTES: none' };
      }
    }
  },
  assert(t) {
    assert.equal(t.runs.length, 2, 'must run 2 steps');
    assert.equal(t.runs[0].code, 0, 'run 1 exit code');
    assert.equal(t.runs[1].code, 0, 'run 2 exit code');
    assert.equal(read(t, 'src/a.txt'), 'A\n');
    assert.equal(read(t, 'src/b.txt'), 'B\n');
    const mCalls = callsOf(t, 'member', 'impl');
    assert.ok(mCalls.length >= 9, `expected at least 9 member calls, got ${mCalls.length}`);
    const recs = memberRecords(t).filter(r => r.type === 'member');
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0].allowedTools.sort(), ['read', 'team_skills', 'team_tools', 'write'].sort());
    const toolUpdates = memberRecords(t).filter(r => r.type === 'member-tools');
    assert.ok(toolUpdates.length >= 1, 'member loaded tools recorded in store');
    assert.ok(toolUpdates.at(-1).loadedTools.includes('write'));
  },
};
