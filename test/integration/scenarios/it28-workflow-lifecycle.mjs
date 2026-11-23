// Multi-task workflow & lifecycle on real DSH:
// 1. Chinese requirement doc (需求说明.md) auto-attached to plan reviewers.
// 2. Superseded plan_id and missing plan_id refused at dispatch; valid plan_id bound.
// 3. Duplicate denied call short-circuited without a second gate model request.
// 4. Member status advances to "done" when its turn completes.
// 5. On a second user task in the same session, Task 1's plan_id is rejected, per-task plan/member
//    limits reset cleanly, and member name "impl" can be reused once finished.
import { assert, allow, approve, DELIVERY, dispatch, callsOf, lastToolResult, gateReceipts, memberRecords, read } from '../lib.mjs';

export default {
  files: { '需求说明.md': '第一阶段写入 src/one.txt，第二阶段写入 src/two.txt。\n' },
  config: {
    team: { maxPlanAgreements: 2, maxMembersPerTeam: 1, maxActiveMembers: 1 },
  },
  runs: [
    { task: '请按 需求说明.md 完成第一阶段写入 src/one.txt。' },
    { task: '现在继续第二阶段：写入 src/two.txt。', resume: true },
  ],
  respond(c, t) {
    if (c.kind === 'gate') {
      if (c.request.operation.tool === 'write' && c.request.operation.arguments_json.includes('bad.txt')) {
        return { json: { decision: 'deny', risk: 'high', reason: 'bad.txt is rejected in test' } };
      }
      return allow;
    }
    if (c.kind === 'discuss') {
      t.state.discussPayloads = [...(t.state.discussPayloads ?? []), c.request];
      return approve;
    }
    if (c.kind === 'leader') {
      if (t.runs.length === 0) {
        t.state.l1 = (t.state.l1 ?? 0) + 1;
        const step = t.state.l1;
        if (step === 1) return { tool: 'team_discuss', args: { kind: 'plan', topic: 'plan v1', proposal: 'Initial plan v1' } };
        if (step === 2) {
          t.state.p1 = JSON.parse(lastToolResult(c)).id;
          return { tool: 'team_discuss', args: { kind: 'plan', topic: 'plan v2', proposal: 'Revised plan v2', revises: t.state.p1 } };
        }
        if (step === 3) {
          t.state.p2 = JSON.parse(lastToolResult(c)).id;
          // Missing plan_id must be rejected
          return dispatch({ refs: ['需求说明.md'], write_scope: ['src/**'] });
        }
        if (step === 4) {
          assert.match(lastToolResult(c), /no approved plan agreement bound/);
          // Superseded p1 must be rejected
          return dispatch({ plan_id: t.state.p1, refs: ['需求说明.md'], write_scope: ['src/**'] });
        }
        if (step === 5) {
          assert.match(lastToolResult(c), /was superseded by/);
          // Valid p2 succeeds
          return dispatch({ plan_id: t.state.p2, refs: ['需求说明.md'], write_scope: ['src/**'] });
        }
        if (step === 6) return { content: 'WAITING_TASK1' };
        if (step === 7) return { tool: 'team_status', args: {} };
        if (step === 8) {
          t.state.status1 = JSON.parse(lastToolResult(c));
          return DELIVERY;
        }
        if(step>=9)return{content:'DELIVERY: approved'};
      }
      t.state.l2 = (t.state.l2 ?? 0) + 1;
      const step2 = t.state.l2;
      if (step2 === 1) {
        // Reusing Task 1's plan_id in Task 2 must be rejected!
        return dispatch({ plan_id: t.state.p2, refs: ['需求说明.md'], write_scope: ['src/**'] });
      }
      if (step2 === 2) {
        assert.match(lastToolResult(c), /belongs to earlier user task #1/);
        // Fresh plan for Task 2 works even though Task 1 already used maxPlanAgreements=2!
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'task 2 plan', proposal: 'Write src/two.txt' } };
      }
      if (step2 === 3) {
        t.state.pTask2 = JSON.parse(lastToolResult(c)).id;
        // Reusing member name "impl" works in Task 2 even with maxMembersPerTeam=1!
        return dispatch({ plan_id: t.state.pTask2, refs: ['需求说明.md'], write_scope: ['src/**'] });
      }
      if (step2 === 4) return { content: 'WAITING_TASK2' };
      if (step2 === 5) return { tool: 'team_status', args: {} };
      if (step2 === 6) {
        t.state.status2 = JSON.parse(lastToolResult(c));
        return DELIVERY;
      }
      return { content: 'DELIVERY: approved' };
    }
    if (c.kind === 'member') {
      if (t.runs.length === 0) {
        t.state.m1 = (t.state.m1 ?? 0) + 1;
        const m = t.state.m1;
        if (m === 1) return { tool: 'read', args: { file_path: '需求说明.md' } };
        if (m === 2) return { tool: 'write', args: { file_path: 'src/bad.txt', content: 'NO' } };
        if (m === 3) {
          assert.match(lastToolResult(c), /blocked by the LeaderTeam safety gate \(model\)/);
          // Exact same denied call retried -> must hit duplicate-denied-call without calling gate model!
          return { tool: 'write', args: { file_path: 'src/bad.txt', content: 'NO' } };
        }
        if (m === 4) {
          assert.match(lastToolResult(c), /rule:duplicate-denied-call/);
          return { tool: 'write', args: { file_path: 'src/one.txt', content: 'ONE\n' } };
        }
        return { content: 'STATUS: done\nCHANGED: src/one.txt\nEVIDENCE: ok\nNOTES: none' };
      }
      t.state.m2 = (t.state.m2 ?? 0) + 1;
      const m = t.state.m2;
      if (m === 1) return { tool: 'read', args: { file_path: '需求说明.md' } };
      if (m === 2) return { tool: 'write', args: { file_path: 'src/two.txt', content: 'TWO\n' } };
      return { content: 'STATUS: done\nCHANGED: src/two.txt\nEVIDENCE: ok\nNOTES: none' };
    }
  },
  assert(t) {
    assert.equal(t.runs.length, 2);
    assert.equal(t.runs[0].code, 0);
    assert.equal(t.runs[1].code, 0);
    assert.equal(read(t, 'src/one.txt'), 'ONE\n');
    assert.equal(read(t, 'src/two.txt'), 'TWO\n');

    // Chinese requirement document was auto-attached to plan reviewers
    assert.ok(t.state.discussPayloads[0].evidence.includes('### file: 需求说明.md'));

    // Duplicate denied write only hit the gate model ONCE
    const badModelGates = callsOf(t, 'gate').filter(g => g.request.operation.tool === 'write' && g.request.operation.arguments_json.includes('bad.txt'));
    assert.equal(badModelGates.length, 1, 'identical denied call did not invoke the gate LLM a second time');
    assert.ok(gateReceipts(t).some(r => r.by === 'rule:duplicate-denied-call'));

    // Member lifecycle transitioned to "done" in both tasks
    assert.equal(t.state.status1.task_seq, 1);
    assert.equal(t.state.status1.members.length, 1);
    assert.equal(t.state.status1.members[0].status, 'done');
    assert.equal(t.state.status1.members[0].plan_id, t.state.p2);

    assert.equal(t.state.status2.task_seq, 2);
    assert.equal(t.state.status2.members.length, 2);
    assert.ok(t.state.status2.members.every(m => m.name === 'impl' && m.status === 'done'));
    assert.ok(memberRecords(t).some(r => r.type === 'member-status' && r.status === 'running'));
    assert.ok(memberRecords(t).some(r => r.type === 'member-status' && r.status === 'done'));
  },
};
