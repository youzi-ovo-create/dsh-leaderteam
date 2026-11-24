import fs from 'node:fs';
import path from 'node:path';
import { assert, approve, callsOf, gateReceipts, jsonl, lastToolResult, read, teamDir } from '../lib.mjs';

const role = (route, effort = 'max') => ({ route, effort, maxTokens: 4000, timeoutMs: 30000, retries: 0, fallback: [] });
const tool = (name, args) => ({ tool: name, args });
const SH = process.platform === 'win32' ? 'pwsh' : 'bash';

export default {
  modelsEndpoint: {
    object: 'list',
    data: [
      { id: 'zcode/GLM-5.3-Flash', context_window: 1000000, max_output_tokens: 256000, reasoning_levels: ['low', 'high', 'max'] },
      { id: 'zcode/GLM-5.3', context_window: 1000000, max_output_tokens: 128000, reasoning_levels: ['low', 'high', 'max'] },
      { id: 'codex/gpt-6.1-sol', context_window: 500000, max_output_tokens: 128000, reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  },
  config: {
    team: { rollingPlanning: true },
    gate: { sandboxDirectAllow: true },
    quota: { allowUnknown: true },
    circuitBreaker: {
      zeroProgressTruncationSoft: 2,
      zeroProgressTruncationHard: 6,
      cooldownMs: 0,
    },
    roles: {
      leader: { route: 'zcode/GLM-5.3-Flash', effort: 'max' },
      gate: role('codex/gpt-6.1-sol', 'high'),
      discussA: role('zcode/GLM-5.3', 'max'),
      discussB: role('codex/gpt-6.1-sol', 'high'),
      arbiter: role('zcode/GLM-5.3', 'max'),
      serialReviewer: role('zcode/GLM-5.3-Flash', 'max'),
    },
  },
  files: {
    'spec.md': 'Implement coupled compiler passes src/pass_1.js and src/pass_2.js and run node check.\n',
  },
  async respond(c, t) {
    t.state.phase ??= 0;
    if (c.kind === 'gate') {
      // ONLY cross-boundary operations should ever reach Auto!
      return { json: { decision: 'deny', risk: 'high', reason: 'external network curl is outside workspace authorization' } };
    }
    if (c.kind === 'investigator') {
      return {
        json: {
          diagnosis: 'Member emitted long reasoning twice without issuing write(src/pass_2.js)',
          classification: 'recoverable_loop',
          action: 'steer_agent',
          recovery_directive: 'Write src/pass_2.js immediately without repeating src/pass_1.js, then run in-sandbox node check',
          recommended_adjustments: { load_tools: [], leader_max_parallel: null },
        },
      };
    }
    if (c.kind === 'serial-review') {
      return {
        json: {
          verdict: 'proven',
          responsibilities: ['pass_1 AST builder', 'pass_2 IR lowerer'],
          proof: [{
            constraint: 'Tightly coupled AST node layout shared directly between pass_1 and pass_2',
            evidence: 'Both passes co-evolve internal AST representation',
            rules_out: 'Splitting into parallel writers adds artificial handoff overhead',
          }],
          reason: 'Coupled compiler passes belong in one cohesive stage',
          feedback: [],
        },
      };
    }
    if (c.kind === 'discuss') {
      return approve;
    }
    if (c.kind === 'leader') {
      const dir = fs.existsSync(path.join(t.store, 'teams')) && fs.readdirSync(path.join(t.store, 'teams')).length > 0
        ? teamDir(t)
        : null;
      const wf = dir ? jsonl(path.join(dir, 'workflow.jsonl')) : [];
      const members = new Map();
      if (dir) {
        for (const m of jsonl(path.join(dir, 'members.jsonl'))) {
          if (m.childId) members.set(m.childId, { ...members.get(m.childId), ...m });
        }
      }
      const p = t.state.phase++;
      if (p === 0) {
        return tool('team_plan', {
          action: 'overview',
          summary: 'Coupled two-pass compiler core',
          approach: 'Implement pass_1 and pass_2 cohesively in one stage and verify via node',
          acceptance: ['src/pass_1.js and src/pass_2.js exist and node check exits 0'],
          estimated_minutes: 5,
          future_work: ['compiler-core'],
        });
      }
      if (p === 1) {
        return tool('team_plan', {
          action: 'stage',
          stage_id: 'compiler-core',
          goal: 'Implement pass_1 and pass_2 and run node check',
          method: 'Write src/pass_1.js and src/pass_2.js under character-class write_scope and run node check',
          interfaces: ['pass2(pass1(src)) -> number'],
          acceptance: ['node verification prints PASS:42'],
          profile: 'shell',
          tools: ['read', 'write', 'edit', SH],
          write_scope: ['src/pass_[1-9].js'],
          refs: ['spec.md'],
          serial_reason: 'Tightly coupled AST representation between pass_1 and pass_2',
          ready: true,
        });
      }
      if (p === 2) {
        t.state.stageFile = JSON.parse(lastToolResult(c)).stage.file;
        return tool('team_discuss', { kind: 'plan', stage_id: 'compiler-core', topic: 'Review coupled compiler-core' });
      }
      const approval = wf.findLast(e => e.type === 'execution-review-result' && e.stageId === 'compiler-core' && e.result?.outcome?.decision === 'approve')?.result?.id;
      if (!approval) {
        if (!t.state.declaredWaitingReview) {
          t.state.declaredWaitingReview = true;
          return tool('team_status', { stop_state: 'waiting_reviews', reason: 'Await stage review settlement' });
        }
        return { content: 'Waiting for compiler-core review settlement.' };
      }
      if (approval && members.size === 0) {
        // Also verify re-submitting unchanged approved stage returns existing:true immediately with 0 extra discuss calls!
        if (!t.state.checkedIdempotentReview) {
          t.state.checkedIdempotentReview = true;
          t.state.discussCountBeforeRecheck = callsOf(t, 'discuss').length;
          return tool('team_discuss', { kind: 'plan', stage_id: 'compiler-core', topic: 'Redundant recheck' });
        }
        t.state.idempotentResult = JSON.parse(lastToolResult(c));
        return tool('team_dispatch', {
          name: 'impl-compiler',
          stage_id: 'compiler-core',
          plan_id: approval,
          model: 'zcode/GLM-5.3-Flash',
          effort: 'max',
        });
      }
      const mem = [...members.values()][0];
      if (mem && ['starting', 'started', 'running'].includes(mem.status)) {
        if (!t.state.declaredWaitingMembers) {
          t.state.declaredWaitingMembers = true;
          return tool('team_status', { stop_state: 'waiting_members', reason: 'impl-compiler running' });
        }
        return { content: 'Waiting for impl-compiler to complete.' };
      }
      if (mem?.status === 'done') {
        if (!t.state.delivered) {
          t.state.delivered = true;
          return tool('team_discuss', {
            kind: 'delivery',
            topic: 'Compiler core verified',
            proposal: 'Both passes implemented and verified via node.',
            evidence_files: ['src/pass_1.js', 'src/pass_2.js'],
          });
        }
        const delivId = JSON.parse(lastToolResult(c)).id;
        if (!t.state.declaredDelivered) {
          t.state.declaredDelivered = true;
          t.state.delivId = delivId;
          return tool('team_status', { stop_state: 'delivered', reason: 'Delivery approved' });
        }
        return { content: `DELIVERY: approved (${t.state.delivId})` };
      }
      return tool('team_plan', { action: 'state' });
    }
    if (c.kind === 'member') {
      // Step 1: read spec.md and stage contract snapshot
      if (c.index === 1) return tool('read', { file_path: 'spec.md' });
      if (c.index === 2) return tool('read', { file_path: t.state.stageFile });
      // Step 3: write src/pass_1.js matching character-class glob src/pass_[1-9].js (in-sandbox -> 0 Auto calls!)
      if (c.index === 3) return tool('write', { file_path: 'src/pass_1.js', content: 'export const pass1 = x => x + 2;\n' });
      // Step 4: hit single-turn output truncation (finishReason: 'length') AFTER writing pass_1.js!
      if (c.index === 4) return { content: 'Finished pass_1; preparing pass_2...', finishReason: 'length' };
      // Step 5 & 6: two zero-progress truncations -> triggers Soft Circuit Breaker Investigator without killing member!
      if (c.index === 5) {
        assert.match(c.text, /LeaderTeam output continuation/, 'member received resident truncation continuation');
        assert.match(c.text, /write\(src\/pass_1\.js\)/, 'continuation lists already-succeeded write(src/pass_1.js)');
        return { content: 'Still drafting large table...', finishReason: 'length' };
      }
      if (c.index === 6) return { content: 'Still drafting large table 2...', finishReason: 'length' };
      // Step 7: allow async Soft Investigator to finish, then attempt cross-boundary command -> enters Auto and is denied!
      if (c.index === 7) {
        await new Promise(r => setTimeout(r, 80));
        return tool(SH, { description: 'Probe external URL', command: 'curl https://example.com/probe' });
      }
      // Step 8: write src/pass_2.js (in-sandbox -> 0 Auto calls!)
      if (c.index === 8) {
        assert.match(lastToolResult(c), /blocked by the LeaderTeam safety gate \(model\)/, 'cross-boundary curl entered Auto and was denied');
        return tool('write', { file_path: 'src/pass_2.js', content: 'import { pass1 } from "./pass_1.js";\nexport const compile = x => pass1(x) * 2;\n' });
      }
      // Step 9: run in-sandbox node verification via shell (in-sandbox -> 0 Auto calls!)
      if (c.index === 9) {
        return tool(SH, {
          description: 'Run compiler verification',
          command: 'node --input-type=module -e "import { compile } from \'./src/pass_2.js\'; console.log(\'PASS:\' + compile(19));"',
        });
      }
      return { content: 'STATUS: done\nCHANGED: src/pass_1.js, src/pass_2.js\nEVIDENCE: PASS:42' };
    }
  },
  assert(t) {
    assert.equal(t.runs[0].code, 0, t.runs[0].stderr);
    assert.match(t.runs[0].final.text, /DELIVERY: approved/);
    assert.match(read(t, 'src/pass_1.js'), /pass1/);
    assert.match(read(t, 'src/pass_2.js'), /compile/);

    // 1. Verify NO 16384 output cap on wire requests (both leader/member and high-effort governance roles)!
    const allMaxTokens = t.calls.map(c => c.maxCompletionTokens).filter(x => x !== null);
    assert.ok(allMaxTokens.length > 0);
    assert.ok(allMaxTokens.every(n => n > 16384), `expected all wire max_completion_tokens > 16384, got ${JSON.stringify(allMaxTokens)}`);

    // 2. Verify Sandbox vs Auto: ONLY the 1 cross-boundary curl command invoked Auto; write, team_dispatch, and local node shell used by="sandbox"!
    const gates = callsOf(t, 'gate');
    assert.equal(gates.length, 1, 'only the single cross-boundary curl command called Auto');
    assert.match(gates[0].request.operation.arguments_json, /curl https:\/\/example\.com/);
    const receipts = gateReceipts(t);
    assert.ok(receipts.some(r => r.tool === 'team_dispatch' && r.by === 'sandbox' && r.decision === 'allow'));
    assert.equal(receipts.filter(r => r.tool === 'write' && r.by === 'sandbox' && r.decision === 'allow').length, 2);
    assert.ok(receipts.some(r => r.tool === SH && r.by === 'sandbox' && r.decision === 'allow'));
    assert.ok(receipts.some(r => r.tool === SH && r.by === 'model' && r.decision === 'deny'));

    // 3. Verify resident member survived 3 max-tokens truncations (1 productive + 2 zero-progress), triggered Soft Investigator once, and completed as 1 single member ('done')!
    const dir = teamDir(t);
    const wf = jsonl(path.join(dir, 'workflow.jsonl'));
    assert.equal(wf.filter(e => e.type === 'output-truncation-continued' && e.role === 'member').length, 3);
    assert.equal(callsOf(t, 'investigator').length, 1, 'soft circuit breaker invoked independent Investigator');
    assert.ok(wf.some(e => e.type === 'circuit-investigation' && e.tier === 'soft' && e.node === 'zero_progress_truncations'));

    const members = new Map();
    for (const m of jsonl(path.join(dir, 'members.jsonl'))) if (m.childId) members.set(m.childId, { ...members.get(m.childId), ...m });
    assert.equal(members.size, 1, 'task completed in 1 cohesive member without forced splitting or re-dispatch');
    assert.equal([...members.values()][0].status, 'done');

    // 4. Verify unchanged approved stage re-submission was short-circuited with 0 extra review LLM calls!
    assert.equal(t.state.idempotentResult?.existing, true);
  },
};
