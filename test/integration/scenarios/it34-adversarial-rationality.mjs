// Integration scenario it34: End-to-End Adversarial Rationality Experiment on Real Official DSH CLI.
// Tests two critical rationality-vs-safety boundaries simultaneously:
// 1. `maxPlanAgreements = 2`: Wave 1 uses 2 plan discussions (`p1` revise -> `p2` approve) and executes `impl-w1` to `done`.
//    Wave 2 legitimately needs 2 more plan discussions (`p3` revise -> `p4` approve, total = 4 > `maxPlanAgreements = 2`!)
//    anchored to the executed `p2` chain -> admitted and executed cleanly!
// 2. `maxMemberDenials = 2`: `impl-w1` encounters 2 recoverable protocol nudges (`rule:tool-not-loaded` on deferred `write`,
//    then `rule:refs-unread` before reading `SPEC.md`) PLUS 1 genuine LLM gate denial (total 3 denials > `maxMemberDenials = 2`!)
//    -> NOT falsely bricked; completes Wave 1 cleanly!
import { assert, allow, approve, DELIVERY, dispatch, callsOf, lastToolResult, read } from '../lib.mjs';

export default {
  files: { 'SPEC.md': 'Wave 1 writes `src/wave1.txt`; Wave 2 writes `src/wave2.txt`.\n' },
  config: {
    team: {
      maxPlanAgreements: 2,
      maxDiscussionsPerTask: 4,
      maxMembersPerTeam: 4,
      maxActiveMembers: 2,
    },
    gate: {
      maxDenialsPerMember: 2,
    },
  },
  respond(c, t) {
    if (c.kind === 'gate') {
      if (c.request.operation.tool === 'write' && c.request.operation.arguments_json.includes('draft-rejected.txt')) {
        return { json: { decision: 'deny', risk: 'medium', reason: 'draft-rejected.txt is outside wave1 target' } };
      }
      return allow;
    }
    if (c.kind === 'discuss') {
      if (c.request.kind === 'delivery') return approve;
      if (c.request.topic.endsWith('v1')) {
        return {
          json: {
            stance: 'revise',
            summary: 'Clarify exact output path',
            reasons: ['Proposal should name exact output file under src/'],
            suggestions: ['Specify src/wave1.txt (or src/wave2.txt) and include SPEC.md in refs'],
            required_changes: ['Name exact target file'],
          },
        };
      }
      return approve;
    }
    if (c.kind === 'member' && c.who === 'impl-w1') {
      return [
        // 1. Calls deferred `write` before loading -> recoverable nudge #1 (`rule:tool-not-loaded` or `tool_not_found`, Load via team_tools!)
        { tool: 'team_tools', args: { action: 'list' } },
        // 2. Calls `write` while `write` is still deferred -> `rule:tool-not-loaded` nudge #1!
        { tool: 'team_tools', args: { action: 'load', names: ['write'] } },
        // 3. Calls `write` BEFORE reading `SPEC.md` -> `rule:refs-unread` nudge #2!
        { tool: 'write', args: { file_path: 'src/wave1.txt', content: 'WAVE1_OK\n' } },
        // 4. Reads `SPEC.md`
        { tool: 'read', args: { file_path: 'SPEC.md' } },
        // 5. Hits 1 genuine LLM gate denial (security strike #1 < maxMemberDenials=2)
        { tool: 'write', args: { file_path: 'src/draft-rejected.txt', content: 'NO\n' } },
        // 6. Writes clean `src/wave1.txt` -> SUCCEEDS (not bricked!)
        { tool: 'write', args: { file_path: 'src/wave1.txt', content: 'WAVE1_OK\n' } },
        { content: 'STATUS: done\nCHANGED: src/wave1.txt' },
      ][c.index - 1];
    }
    if (c.kind === 'member' && c.who === 'impl-w2') {
      return [
        { tool: 'read', args: { file_path: 'SPEC.md' } },
        { tool: 'write', args: { file_path: 'src/wave2.txt', content: 'WAVE2_OK\n' } },
        { content: 'STATUS: done\nCHANGED: src/wave2.txt' },
      ][c.index - 1];
    }
    if (c.kind === 'leader') {
      if (c.index === 1) return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Wave 1 v1', proposal: 'Wave 1 draft' } };
      if (c.index === 2) {
        t.state.p1 = JSON.parse(lastToolResult(c)).id;
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Wave 1 v2', proposal: 'Wave 1 writes src/wave1.txt', revises: t.state.p1 } };
      }
      if (c.index === 3) {
        t.state.p2 = JSON.parse(lastToolResult(c)).id;
        return dispatch({
          name: 'impl-w1',
          plan_id: t.state.p2,
          task: 'Read SPEC.md and write src/wave1.txt containing WAVE1_OK.',
          acceptance: ['src/wave1.txt contains WAVE1_OK'],
          tools: ['read', 'write'],
          defer_tools: ['write'],
          refs: ['SPEC.md'],
          write_scope: ['src/**'],
        });
      }
      if (c.index === 4) return { content: 'WAITING_WAVE_1' };
      // Wave 1 member is now DONE! Wave 2 submits plan #3 and #4 (> maxPlanAgreements=2!) anchored to executed p2!
      if (c.index === 5) {
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Wave 2 v1', proposal: 'Wave 2 draft', revises: t.state.p2 } };
      }
      if (c.index === 6) {
        t.state.p3 = JSON.parse(lastToolResult(c)).id;
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Wave 2 v2', proposal: 'Wave 2 writes src/wave2.txt', revises: t.state.p3 } };
      }
      if (c.index === 7) {
        t.state.p4 = JSON.parse(lastToolResult(c)).id;
        return dispatch({
          name: 'impl-w2',
          plan_id: t.state.p4,
          task: 'Read SPEC.md and write src/wave2.txt containing WAVE2_OK.',
          acceptance: ['src/wave2.txt contains WAVE2_OK'],
          tools: ['read', 'write'],
          refs: ['SPEC.md'],
          write_scope: ['src/**'],
        });
      }
      if (c.index === 8) return { content: 'WAITING_WAVE_2' };
      if (c.index === 9) return DELIVERY;
      return { content: 'FINAL: adversarial rationality verified' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0, `expected exit 0, stderr=${t.runs[0].stderr}`);
    assert.equal(read(t, 'src/wave1.txt'), 'WAVE1_OK\n');
    assert.equal(read(t, 'src/wave2.txt'), 'WAVE2_OK\n');
    assert.ok(t.state.p4, '4th plan agreement (> maxPlanAgreements=2) succeeded after Wave 1 execution');
  },
};
