// Integration scenario it33: Detachable Cordis Plugins + Dynamic Upstream Model Discovery (`effort: 'none'`).
// 1. `leaderteam-consensus` is detached via Cordis `disabled: true` -> `team_discuss` disappears from leader tools,
//    and `team_dispatch` works cleanly without `plan_id` while `leaderteam-core` safety gate remains 100% active!
// 2. `custom_upstream/qwen-fast-v1` (non-reasoning model, never listed in leaderteam.config.json) is discovered live
//    from DSH's `ctx.llm` and dispatched with `effort: "none"`.
import { assert, allow, callsOf, lastToolResult, read } from '../lib.mjs';

export default {
  config: { team: { requirePlanAgreement:false, autoIncludeUpstreamModels:true } },
  files: { 'SPEC.md': 'Write `src/upstream.txt` containing `DYNAMIC_UPSTREAM_OK`.\n' },
  extraPatches: ['test/integration/fixtures/it33-modular-upstream.patch.yml'],
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'member') {
      return [
        { tool: 'read', args: { file_path: 'SPEC.md' } },
        { tool: 'write', args: { file_path: 'src/upstream.txt', content: 'DYNAMIC_UPSTREAM_OK\n' } },
        { content: 'STATUS: done\nCHANGED: src/upstream.txt' },
      ][c.index - 1];
    }
    if (c.kind === 'leader') {
      if (c.index === 1) {
        return { tool: 'team_models', args: {} };
      }
      if (c.index === 2) {
        t.state.modelsOut = JSON.parse(lastToolResult(c));
        // Dispatch dynamically discovered upstream non-reasoning model directly (no plan_id required when consensus is detached!)
        return {
          tool: 'team_dispatch',
          args: {
            name: 'impl-upstream',
            task: 'Read SPEC.md and write src/upstream.txt containing DYNAMIC_UPSTREAM_OK.',
            acceptance: ['src/upstream.txt contains DYNAMIC_UPSTREAM_OK'],
            model: 'custom_upstream/qwen-fast-v1',
            effort: 'none',
            profile: 'code',
            tools: ['read', 'write'],
            write_scope: ['src/**'],
            refs: ['SPEC.md'],
          },
        };
      }
      if (c.index === 3) {
        t.state.dispatchOut = JSON.parse(lastToolResult(c));
        return { content: 'WAITING_FOR_UPSTREAM_MEMBER' };
      }
      return { content: 'FINAL: modular detach + dynamic upstream model verified' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0, `expected exit 0, stderr=${t.runs[0].stderr}`);
    assert.equal(read(t, 'src/upstream.txt'), 'DYNAMIC_UPSTREAM_OK\n');

    const leaderCall = callsOf(t, 'leader')[0];
    assert.equal(leaderCall.tools.includes('team_discuss'), false, 'detached leaderteam-consensus hides team_discuss from leader');
    assert.equal(leaderCall.tools.includes('team_dispatch'), true);
    assert.equal(leaderCall.tools.includes('team_plan_archive'), true);
    assert.equal(t.state.modelsOut?.active_plugins?.consensus, false);
    assert.equal(t.state.modelsOut?.active_plugins?.timerArchive, true);

    // Dynamically discovered upstream model appears in team_models without being in static config
    const dynRow = t.state.modelsOut?.models?.find(m => m.route === 'custom_upstream/qwen-fast-v1');
    assert.ok(dynRow, 'custom_upstream/qwen-fast-v1 dynamically discovered from DSH ctx.llm');
    assert.equal(dynRow.provider, 'custom_upstream');
    assert.deepEqual(dynRow.efforts, ['none']);

    // Member executed on `qwen-fast-v1` with no reasoning_effort sent on wire, and Gate still reviewed both ops!
    const memberCalls = callsOf(t, 'member', 'impl-upstream');
    assert.ok(memberCalls.length >= 3);
    assert.equal(memberCalls[0].model, 'qwen-fast-v1');
    assert.equal(memberCalls[0].effort, undefined, 'effort="none" omits reasoning_effort cleanly');
    assert.equal(callsOf(t, 'gate').length, 2, 'leaderteam-core safety gate remained active while consensus was detached');
  },
};
