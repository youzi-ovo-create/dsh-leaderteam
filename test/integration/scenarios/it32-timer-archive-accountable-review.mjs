// Integration scenario it32: Engineering Timer + Accountable Review + Fixed External Plan Archive + Anti-Stagnation Best-Plan + Retrospective.
import fs from 'node:fs';
import path from 'node:path';
import { assert, allow, approve, DELIVERY, dispatch, callsOf, lastToolResult, read } from '../lib.mjs';

export default {
  files: { 'SPEC.md': 'Write `src/archived.txt` containing `RESCUED_OK`.\n' },
  config: {
    timer: {
      enabled: true,
      elevatedAfterMs: 40,
      stagnationAfterMs: 100,
      idleGapCapMs: 60000,
    },
    planArchive: {
      enabled: true,
      minUnapprovedPlansForFallback: 3,
      useArbiterForBestPlan: true,
    },
  },
  respond: async (c, t) => {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') {
      if (c.request.kind === 'delivery') return approve;
      t.state.timerPayloads = [...(t.state.timerPayloads ?? []), c.request.project_timer];
      // First Reviewer B call emits a lazy bare refusal -> rejected by accountable parser & retried!
      if (c.who === 'B' && !t.state.sentBareRefusal) {
        t.state.sentBareRefusal = true;
        return {
          json: {
            stance: 'revise',
            summary: '不同意',
            reasons: ['因为方案不够详细，所以我不同意'],
            suggestions: ['请重新设计方案'],
            required_changes: ['重写方案'],
          },
        };
      }
      const roundIdx = (t.state.reviseCount = (t.state.reviseCount ?? 0) + 1);
      const remaining = roundIdx <= 2 ? ['Specify exact target path', 'Specify verification step'] : ['Specify exact target path'];
      return {
        json: {
          stance: 'revise',
          summary: 'Needs small clarification',
          reasons: ['Target path details can be tightened'],
          suggestions: ['Explicitly list src/archived.txt in write_scope and verify RESCUED_OK content'],
          required_changes: remaining,
        },
      };
    }
    if (c.kind === 'arbiter') {
      // Anti-stagnation best-plan selector arbiter!
      t.state.stagnationArbiterReq = c.request;
      const chosen = c.request.candidates[0];
      return {
        json: {
          selected_plan_id: chosen.plan_id,
          rationale: 'Best candidate with fewest remaining items and full SPEC alignment.',
          execution_guardrails: ['Verify src/archived.txt contains RESCUED_OK'],
        },
      };
    }
    if (c.kind === 'member') {
      return [
        { tool: 'read', args: { file_path: 'SPEC.md' } },
        { tool: 'write', args: { file_path: 'src/archived.txt', content: 'RESCUED_OK\n' } },
        { content: 'STATUS: done\nCHANGED: src/archived.txt' },
      ][c.index - 1];
    }
    if (c.kind === 'leader') {
      if (c.index === 1) {
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Archive feature plan v1', proposal: 'Step 1: write src/archived.txt' } };
      }
      if (c.index === 2) {
        t.state.p1 = JSON.parse(lastToolResult(c)).id;
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Archive feature plan v2', proposal: 'Step 1: read SPEC.md\nStep 2: write src/archived.txt', revises: t.state.p1 } };
      }
      if (c.index === 3) {
        t.state.p2 = JSON.parse(lastToolResult(c)).id;
        await new Promise(r => setTimeout(r, 130)); // ensure real wall-clock crosses 100ms stagnationAfterMs
        return { tool: 'team_discuss', args: { kind: 'plan', topic: 'Archive feature plan v3', proposal: 'Step 1: read SPEC.md\nStep 2: write src/archived.txt with RESCUED_OK\nStep 3: verify output', revises: t.state.p2 } };
      }
      if (c.index === 4) {
        const p3Res = JSON.parse(lastToolResult(c));
        t.state.p3 = p3Res.id;
        t.state.p3Timer = p3Res.timer;
        return { tool: 'team_plan_archive', args: { action: 'select_best' } };
      }
      if (c.index === 5) {
        const sel = JSON.parse(lastToolResult(c));
        t.state.selected = sel;
        return dispatch({
          name: 'impl-archive',
          plan_id: sel.agreement_id,
          task: 'Read SPEC.md and write src/archived.txt containing RESCUED_OK.',
          acceptance: ['src/archived.txt contains RESCUED_OK'],
          refs: ['SPEC.md'],
          write_scope: ['src/**'],
        });
      }
      if (c.index === 6) return { content: 'WAITING_FOR_MEMBER' };
      if (c.index === 7) return { tool: 'team_plan_archive', args: { action: 'retrospect', plan_id: t.state.p3, notes: 'Executed smoothly via anti-stagnation fallback.' } };
      if (c.index === 8) {
        t.state.retroOut = JSON.parse(lastToolResult(c));
        return DELIVERY;
      }
      return { content: 'FINAL: timer + external plan archive + accountable review verified' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0, `expected exit 0, stderr=${t.runs[0].stderr}`);
    assert.equal(read(t, 'src/archived.txt'), 'RESCUED_OK\n');

    // 1. Engineering timer was injected into reviewer requests
    assert.ok((t.state.timerPayloads ?? []).length >= 6);
    assert.ok(t.state.timerPayloads.every(tp => tp && typeof tp.project_wall_ms === 'number' && typeof tp.directive === 'string'));

    // 2. Bare lazy refusal was rejected & retried (3 plan agreements * 2 reviewers + 1 retry + 2 delivery = 9 discuss calls)
    const discussCalls = callsOf(t, 'discuss');
    assert.equal(discussCalls.length, 9, 'bare refusal triggered automatic retry until accountable suggestions were supplied');

    // 3. Stagnation fallback triggered & arbiter selected p3
    assert.equal(t.state.p3Timer?.stagnation_fallback_eligible, true);
    assert.equal(t.state.selected?.by, 'arbiter');
    assert.equal(t.state.selected?.selected_plan_id, t.state.p3);
    assert.ok(t.state.stagnationArbiterReq?.candidates?.length >= 2);

    // 4. Fixed external archive path outside workspace + post-execution retrospective persisted
    const expectedArchiveRoot = t.config.planArchive.root;
    assert.equal(t.state.selected?.archive_root, expectedArchiveRoot);
    assert.equal(fs.existsSync(path.join(expectedArchiveRoot, 'index.jsonl')), true);
    assert.equal(fs.existsSync(path.join(t.ws, 'plan-archive')), false, 'archive never pollutes workspace');
    assert.equal(t.state.retroOut?.retrospective?.planId, t.state.p3);
    assert.equal(t.state.retroOut?.retrospective?.verdict, 'clean-execution');
  },
};
