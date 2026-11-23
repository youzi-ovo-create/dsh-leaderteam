import fs from 'node:fs';
import path from 'node:path';
import {
  assert,
  callsOf,
  gateReceipts,
  governanceEvents,
  jsonl,
  lastToolResult,
  memberRecords,
  read,
  teamDir,
} from '../lib.mjs';
import { replayGovernanceState } from '../../../leaderteam/core/governance-protocol.mjs';

const role = (route, effort = 'max') => ({ route, effort, maxTokens: 4000, timeoutMs: 30000, retries: 0, fallback: [] });
const tool = (name, args) => ({ tool: name, args });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(pred, timeoutMs = 4500, stepMs = 35) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = pred();
    if (val) return val;
    await sleep(stepMs);
  }
  return pred();
}

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
    gate: { sandboxDirectAllow: true, enablePatternCache: true },
    governance: {
      mode: 'autonomous',
      caucusQuorumNumerator: 2,
      caucusQuorumDenominator: 3,
      maxInternalArbitrationRounds: 2,
      maxConferenceDialogueTurns: 2,
      autoSuperviseStages: false,
      autoSuperviseDispatches: true,
      directExecMaxSteps: 16,
      pauseBarrierTimeoutMs: 5000,
    },
    quota: { allowUnknown: true, allowUnknownGpt: true },
    roles: {
      leader: { route: 'zcode/GLM-5.3-Flash', effort: 'max' },
      gate: role('codex/gpt-6.1-sol', 'high'),
      discussA: role('zcode/GLM-5.3', 'max'),
      discussB: role('codex/gpt-6.1-sol', 'high'),
      arbiter: role('zcode/GLM-5.3', 'max'),
      serialReviewer: role('zcode/GLM-5.3-Flash', 'max'),
      directExec: role('zcode/GLM-5.3-Flash', 'max'),
    },
  },
  files: {
    'spec.md': 'Implement pure-JS src/calc.js and src/summary.js with zero external dependencies.\n',
    '.env': 'SECRET_API_TOKEN=do-not-read\n',
  },
  runs: [
    { task: '请按 spec.md 完成 src/calc.js 与 src/summary.js。' },
    { task: '采用领队纯 JS 方案直接完成交付，无需外部组件。', resume: true },
  ],
  async respond(c, t) {
    if (!t.state.init) {
      t.state.init = true;
      t.state.stage4Packets = [];
      t.state.caucusVoterToggle = 0;
      t.state.memberStatusAtConfOpen = [];
      t.state.memberResumePrompts = [];
      t.state.calcWrittenPromise = new Promise(r => { t.state.calcWrittenResolve = r; });
    }

    if (c.kind === 'gate') {
      return { json: { decision: 'deny', risk: 'high', reason: 'unexpected cross-boundary model call' } };
    }

    if (c.kind === 'supervision') {
      if (!c.request?.stage4_conference_return_packet) {
        await Promise.race([t.state.calcWrittenPromise, sleep(2500)]);
      } else {
        // Simulate collateral workspace SHA-256 modification BEFORE Stage 4 supervision finishes!
        // Under §一, collateral file hash edits MUST NEVER reset the dispute chain or prevent Strike 3 escalation!
        fs.writeFileSync(
          path.join(t.ws, 'src/calc.js'),
          `// collateral timestamp comment ${Date.now()}\nexport const add = (a, b) => a + b;\n`,
          'utf8',
        );
        t.state.stage4Packets.push(c.request.stage4_conference_return_packet);
      }
      return {
        json: {
          stance: 'object',
          intervene: true,
          summary: 'Prefer external math library over pure JS',
          concerns: ['Custom add function instead of external library'],
          suggestions: ['Switch to external library'],
          target_paths: ['src/calc.js'],
        },
      };
    }

    if (c.kind === 'caucus-arbiter') {
      return {
        json: {
          escalate_to_conference: true,
          rationale: 'Convene formal 2-party conference with Leader to verify zero-dependency spec',
          fact_findings: ['src/calc.js exists on disk'],
          initial_expectation: 'Use external library unless spec mandates zero dependencies',
          questions_for_leader: ['Does spec.md mandate zero external dependencies?'],
          dispute_continuity: 'same_behavior_persists',
          prior_directive_satisfied: true,
        },
      };
    }

    if (c.kind === 'caucus-reviewer') {
      // 1 YES + 1 NO + Arbiter YES = 2/3 majority!
      const voteYes = (t.state.caucusVoterToggle++ % 2) === 0;
      return {
        json: {
          escalate_to_conference: voteYes,
          rationale: voteYes ? 'Support formal conference' : 'Defer to Arbiter',
          initial_expectation: 'Use external library',
        },
      };
    }

    if (c.kind === 'conference-opening') {
      // Verify Pre-Conference Pause Barrier: record member status at the exact moment Stage 3 Conference opens!
      const mems = jsonl(path.join(teamDir(t), 'members.jsonl'));
      const latestStatus = mems.filter(m => m.type === 'member-status').at(-1)?.status ?? 'unknown';
      t.state.memberStatusAtConfOpen.push(latestStatus);
      return {
        json: {
          opening_statement: 'Reviewers petitioned over pure-JS calc.js. Present your workspace evidence or alternative.',
          key_questions: ['Confirm spec.md constraint and verification status.'],
        },
      };
    }

    if (c.kind === 'conference-deliberation') {
      if (c.index === 1) {
        return {
          json: {
            status: 'concluded',
            decision: 'adopt_alternative',
            ruling_summary: 'Adopted pure-JS implementation with summary verification; overturned external-library expectation.',
            delta_from_initial_expectation: 'Modified initial caucus expectation: rejected external library in favor of pure JS + summary.js.',
            binding_directives: ['Keep pure-JS calc.js and summary.js aligned'],
            blocked_targets: [],
            member_resume_policy: 'resume_all',
          },
        };
      }
      return {
        json: {
          status: 'concluded',
          decision: 'overturn_objection',
          ruling_summary: 'Overturned 2nd objection: pure-JS implementation strictly matches spec.md.',
          delta_from_initial_expectation: 'Completely overturned initial expectation.',
          binding_directives: [],
          blocked_targets: [],
          member_resume_policy: 'resume_all',
        },
      };
    }

    if (c.kind === 'directive-verification') {
      return {
        json: {
          satisfied: true,
          verified_items: ['Keep pure-JS calc.js and summary.js aligned'],
          missing_items: [],
          reason: 'Both pure-JS files verified on disk.',
        },
      };
    }

    if (c.kind === 'member') {
      if (c.index === 1) return tool('read', { file_path: 'spec.md' });
      if (c.index === 2) return tool('read', { file_path: t.state.stageFile });
      if (c.index === 3) {
        return tool('write', { file_path: 'src/calc.js', content: 'export const add = (a, b) => a + b;\n' });
      }
      if (c.index === 4) {
        t.state.calcWrittenResolve?.();
        // Wait until Pre-Conference Pause Barrier enters `conference-pausing`!
        await waitUntil(() => {
          const dir = teamDir(t);
          const gov = replayGovernanceState(jsonl(path.join(dir, 'governance.jsonl')), 1);
          return Boolean(gov.pausingConference);
        }, 3500);
        // Attempt one more tool call (`read`) AFTER `conference-pausing` -> MUST be blocked by `rule:conference-checkpoint-pause`!
        return tool('read', { file_path: 'spec.md' });
      }
      if (c.index === 5) {
        t.state.memberPauseGateDenied = lastToolResult(c);
        return {
          content: [
            'STOPPED_AT: src/calc.js after exporting add(a, b)',
            'COMPLETED_SO_FAR: read spec.md and wrote src/calc.js',
            'RESUME_PLAN: verify pure-JS export and report STATUS: done',
            'STATUS: paused',
          ].join('\n'),
        };
      }
      // After Conference #1 concludes, `impl-calc` is resumed with its saved checkpoint injected!
      t.state.memberResumePrompts.push(JSON.stringify(c.payload.messages.slice(-2)));
      const curGov = replayGovernanceState(jsonl(path.join(teamDir(t), 'governance.jsonl')), 1);
      if (curGov.pausingConference || curGov.activeConference || curGov.activeHumanEscalation) {
        return {
          content: [
            'STOPPED_AT: awaiting second conference conclusion',
            'COMPLETED_SO_FAR: src/calc.js preserved',
            'RESUME_PLAN: finalize status after governance settles',
            'STATUS: paused',
          ].join('\n'),
        };
      }
      return { content: 'Resumed from checkpoint after formal conference; src/calc.js complete.\nCHANGED: src/calc.js\nEVIDENCE: verified\nSTATUS: done' };
    }

    if (c.kind === 'direct_exec') {
      // Step 1: Attempt out-of-Sandbox read (globalRefs) -> MUST be hard-denied by `rule:direct-exec-sandbox-lock`!
      if (c.index === 1) {
        return tool('read', { file_path: path.join(t.globalRefs, 'GLOBAL.md') });
      }
      // Step 2: Attempt `.env` secret read inside workspace -> MUST be denied by Safety Gate `rule:direct-exec-secret-file`!
      if (c.index === 2) {
        t.state.directOutSandboxErr = lastToolResult(c);
        return tool('read', { file_path: '.env' });
      }
      // Step 3: Legitimate in-Sandbox read -> MUST pass Safety Gate via `by: "gate-rule"` (0 LLM calls)!
      if (c.index === 3) {
        t.state.directSecretErr = lastToolResult(c);
        return tool('read', { file_path: 'src/calc.js' });
      }
      // Step 4: Legitimate in-Sandbox write within write_scope -> MUST pass Safety Gate via `by: "gate-rule"`!
      if (c.index === 4) {
        return tool('write', { file_path: 'src/summary.js', content: 'export const summary = "add(2,3)=5";\n' });
      }
      return { content: 'Verified src/calc.js and wrote src/summary.js inside Sandbox.\nSTATUS: done' };
    }

    if (c.kind === 'leader') {
      // Run 2 (after User replies to Strike 3 Human Escalation):
      if (t.runs.length === 1) {
        t.state.run2Step = (t.state.run2Step ?? 0) + 1;
        if (t.state.run2Step === 1) {
          // Now that human escalation is resolved and no conference is open, run `team_direct_exec` inside Sandbox!
          return tool('team_direct_exec', {
            task: 'Inspect src/calc.js and write src/summary.js inside Sandbox',
            write_scope: ['src/summary.js'],
            allow_shell: false,
          });
        }
        if (t.state.run2Step === 2) {
          t.state.directExecResult = JSON.parse(lastToolResult(c));
          return tool('team_status', {
            stop_state: 'delivered',
            reason: 'User resolved Strike-3 governance dispute; src/calc.js and src/summary.js verified.',
          });
        }
        return { content: 'DELIVERY: completed\n已根据您的裁决完成纯 JS 方案交付（src/calc.js 与 src/summary.js）。' };
      }

      // Run 1:
      t.state.run1Step = (t.state.run1Step ?? 0) + 1;
      const step = t.state.run1Step;
      if (step === 1) {
        return tool('team_plan', {
          action: 'overview',
          summary: 'Pure-JS calculator and summary',
          approach: 'Autonomous stage dispatch + direct_exec local verification',
          acceptance: ['src/calc.js and src/summary.js match spec.md'],
          estimated_minutes: 3,
          future_work: ['calc-core'],
        });
      }
      if (step === 2) {
        return tool('team_plan', {
          action: 'stage',
          stage_id: 'calc-core',
          goal: 'Implement src/calc.js',
          method: 'Pure JS export add(a, b)',
          interfaces: ['add(a, b) -> number'],
          acceptance: ['Exports add'],
          profile: 'code',
          tools: ['read', 'write', 'edit'],
          write_scope: ['src/calc.js'],
          refs: ['spec.md'],
          serial_reason: 'Single module',
          ready: true,
        });
      }
      if (step === 3) {
        t.state.stageFile = JSON.parse(lastToolResult(c)).stage.file;
        // Autonomous dispatch WITHOUT `plan_id` or `team_discuss`!
        return tool('team_dispatch', {
          name: 'impl-calc',
          stage_id: 'calc-core',
          model: 'zcode/GLM-5.3-Flash',
          effort: 'max',
        });
      }
      if (step === 4) {
        // Wait for Pre-Conference Pause Barrier to pause `impl-calc` AND Stage 3 Conference #1 to open!
        await waitUntil(() => {
          const dir = teamDir(t);
          const gov = replayGovernanceState(jsonl(path.join(dir, 'governance.jsonl')), 1);
          return Boolean(gov.activeConference);
        }, 4500);
        // Attempt ordinary `team_dispatch` during active Stage 3 Conference -> MUST be blocked!
        return tool('team_dispatch', {
          name: 'impl-blocked-in-conf',
          profile: 'code',
          model: 'zcode/GLM-5.3-Flash',
          effort: 'max',
          tools: ['read', 'write'],
          write_scope: ['src/other.js'],
          task: 'Should be blocked while conference is open',
          acceptance: ['N/A'],
        });
      }
      if (step === 5) {
        t.state.blockedDispatchInConfResult = lastToolResult(c);
        // Attempt `team_direct_exec` DURING Stage 3 Conference -> MUST ALSO BE BLOCKED (`rule:arbiter-conference-active`)!
        return tool('team_direct_exec', {
          task: 'Should be blocked during active formal conference',
          write_scope: ['src/summary.js'],
          allow_shell: false,
        });
      }
      if (step === 6) {
        t.state.blockedDirectExecInConfResult = lastToolResult(c);
        // Respond in Conference #1 (`Arbiter + Leader` ONLY):
        return tool('team_conference', {
          action: 'respond',
          explanation: 'spec.md explicitly requires zero external dependencies; read-only inspection confirms pure JS.',
          new_evidence_files: ['spec.md', 'src/calc.js'],
          proposed_alternative: 'Keep pure-JS calc.js plus summary.js',
        });
      }
      if (step === 7) {
        t.state.conf1Result = JSON.parse(lastToolResult(c));
        // Wait for Stage 4 #1 re-review (with collateral file hash edit!) -> Strike 2 Caucus -> Conference #2 opening!
        await waitUntil(() => {
          const dir = teamDir(t);
          const gov = replayGovernanceState(jsonl(path.join(dir, 'governance.jsonl')), 1);
          return gov.activeConference?.strike === 2;
        }, 4500);
        return tool('team_conference', {
          action: 'respond',
          explanation: 'Second conference confirmation: pure-JS implementation satisfies spec.md.',
          new_evidence_files: ['src/calc.js'],
        });
      }
      if (step === 8) {
        // Wait for Stage 4 #2 re-review (with collateral file hash edit!) -> Strike 3 Direct Human Escalation!
        await waitUntil(() => {
          const dir = teamDir(t);
          const gov = replayGovernanceState(jsonl(path.join(dir, 'governance.jsonl')), 1);
          return Boolean(gov.activeHumanEscalation);
        }, 4500);
        return tool('team_status', {
          stop_state: 'waiting_user',
          reason: 'Dispute reached 3rd unanimous objection and escalated to User decision (§5).',
          question: '双评审三次坚持引入外部库，两轮独立裁断均支持纯 JS 方案，请确认是否按纯 JS 方案交付？',
        });
      }
      return { content: '争议已触发第三次升级，现提交人工最终裁决：请确认是否采用纯 JS 方案完成交付。' };
    }

    return { content: 'OK' };
  },

  async assert(t) {
    assert.equal(t.runs.length, 2, 'completed both Run 1 (Strike 3 escalation) and Run 2 (User resolution + delivery)');
    assert.equal(t.runs[0].code, 0, `Run 1 exited cleanly: ${t.runs[0].stderr}`);
    assert.equal(t.runs[1].code, 0, `Run 2 exited cleanly: ${t.runs[1].stderr}`);

    // 1. Both target files exist on disk:
    assert.match(read(t, 'src/calc.js'), /export const add/);
    assert.match(read(t, 'src/summary.js'), /add\(2,3\)=5/);

    // 2. Zero Safety Gate LLM calls across the entire multi-member + direct_exec + 2-run workflow!
    assert.equal(callsOf(t, 'gate').length, 0, 'Safety Gate handled all Sandbox, direct_exec, and hard-rule checks deterministically with 0 LLM calls');

    // 3. Verify Pre-Conference Pause Barrier & Firm Handoff Checkpointing:
    assert.equal(t.state.memberStatusAtConfOpen[0], 'paused', 'Stage 3 Conference #1 opened ONLY AFTER running member wrote checkpoint and paused');
    assert.match(t.state.memberPauseGateDenied ?? '', /conference-checkpoint-pause/, 'running member tool call immediately stopped by rule:conference-checkpoint-pause');
    assert.ok(t.state.memberResumePrompts.some(p => /STOPPED_AT: src\/calc\.js/.test(p)), 'resumed member received its exact saved STOPPED_AT checkpoint');
    assert.ok(t.state.memberResumePrompts.some(p => /RESUME_PLAN: verify pure-JS export/.test(p)), 'resumed member received its exact saved RESUME_PLAN checkpoint');

    const cpDir = path.join(teamDir(t), 'checkpoints');
    assert.ok(fs.existsSync(cpDir) && fs.readdirSync(cpDir).some(f => f.endsWith('.json')), 'structured checkpoint JSON written under team checkpoints/');

    // 4. Verify BOTH `team_dispatch` AND `team_direct_exec` are blocked during Stage 3 Formal Conference, then restored after resolution!
    const receipts = gateReceipts(t);
    assert.ok(receipts.some(r => r.role === 'leader' && r.tool === 'team_dispatch' && r.by === 'rule:arbiter-conference-active' && r.decision === 'deny'), 'ordinary team_dispatch blocked during Stage 3 Formal Conference');
    assert.ok(receipts.some(r => r.role === 'leader' && r.tool === 'team_direct_exec' && r.by === 'rule:arbiter-conference-active' && r.decision === 'deny'), 'team_direct_exec ALSO blocked during Stage 3 Formal Conference');
    assert.match(t.state.blockedDispatchInConfResult, /arbiter-conference-active/);
    assert.match(t.state.blockedDirectExecInConfResult, /arbiter-conference-active/);

    // 5. Verify `direct_exec` two unconditional hard rules once restored in Run 2 (§3.2 & §6.2):
    assert.match(t.state.directOutSandboxErr, /direct-exec-sandbox-lock/, 'Hard Rule 1: direct_exec denied leaving Sandbox even for globalRefRoots');
    assert.match(t.state.directSecretErr, /direct-exec-secret-file/, 'Hard Rule 2: direct_exec denied reading .env by Safety Gate');
    assert.equal(t.state.directExecResult.stop_reason, 'completed');
    assert.ok(t.state.directExecResult.safety_gate.total_checked >= 4);
    assert.equal(t.state.directExecResult.safety_gate.model_calls, 0);

    // 6. Verify Event–Behavior–Chain resisted collateral file SHA-256 edits across Stage 4 #1 and #2 -> Strike 3 Human Escalation!
    assert.equal(t.state.stage4Packets.length, 4, '2 conferences x 2 reviewers = 4 Stage 4 re-review deliveries');
    assert.equal(callsOf(t, 'caucus-arbiter').length, 2, 'exactly 2 internal caucuses (Strike 1 & Strike 2); Strike 3 skipped Arbiter caucus');
    assert.equal(callsOf(t, 'conference-opening').length, 2, 'exactly 2 formal conferences; collateral SHA-256 edits did NOT reset Strike 3');

    const govLog = governanceEvents(t);
    const idxPausing = govLog.findIndex(e => e.type === 'conference-pausing');
    const idxBarrier = govLog.findIndex(e => e.type === 'conference-pause-barrier-completed');
    const idxOpen = govLog.findIndex(e => e.type === 'conference-opened');
    assert.ok(idxPausing >= 0 && idxBarrier > idxPausing && idxOpen > idxBarrier, 'governance ledger proves barrier completed strictly before conference-opened');

    const strikeEvents = govLog.filter(e => e.type === 'dispute-strike-recorded');
    assert.equal(strikeEvents.length, 3, 'recorded Strike 1, Strike 2, and Strike 3 on the same disputeChainId');
    assert.equal(new Set(strikeEvents.map(e => e.disputeChainId)).size, 1, 'all 3 strikes linked to identical disputeChainId despite collateral SHA-256 changes');
    assert.equal(new Set(strikeEvents.map(e => e.eventId)).size, 1, 'all 3 strikes linked to identical eventId');
    assert.ok(govLog.some(e => e.type === 'human-escalation-opened' && e.strike === 3), 'Strike 3 recorded human-escalation-opened');
    assert.ok(govLog.some(e => e.type === 'human-escalation-resolved'), 'Run 2 User message automatically resolved human escalation');
    assert.match(t.runs[1].final?.text ?? '', /DELIVERY:\s*completed/);
  },
};
