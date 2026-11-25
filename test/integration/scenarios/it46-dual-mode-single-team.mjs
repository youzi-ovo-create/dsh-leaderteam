import fs from 'node:fs';
import path from 'node:path';
import {
  assert,
  allow,
  approve,
  PLAN,
  DELIVERY,
  dispatch,
  latestPlanId,
  callsOf,
  gateReceipts,
  memberRecords,
  lastToolResult,
  read,
  exists,
} from '../lib.mjs';
import { loadConfig } from '../../../leaderteam/core/config.mjs';
import { SessionModeStore } from '../../../leaderteam/core/session-mode.mjs';
import { runtime, bindRuntimeConfigFile } from '../../../leaderteam/host/runtime.mjs';
import {
  inspectSessionModeState,
  switchSessionExecutionMode,
} from '../../../leaderteam/host/mode-controller.mjs';

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash';

export default {
  platforms: ['linux', 'darwin'],
  config: {
    gate: { sandboxDirectAllow: true, enablePatternCache: true },
  },
  files: {
    'spec.md': 'Create src/greeting.js exporting greet(), support Single-mode direct updates, and add src/turn4.txt in Team mode.\n',
    'AGENTS.md': '# Protected workspace rules\n',
  },
  runs: [
    { task: 'Turn 1 (Team): Dispatch member impl-t1 to create src/greeting.js exporting greet() returning "v1".' },
    { task: 'Turn 2 (Single Q&A): Without calling any tools, which file did Turn 1 create?', resume: true },
    { task: 'Turn 3 (Single Direct): Read src/greeting.js, update it to return "v2", and run node check via bash.', resume: true },
    { task: 'continue', resume: true },
  ],
  beforeRun(t, { cfgFile, index }) {
    const rt = runtime();
    rt.storageRoot = t.store;
    rt.surface = 'headless';
    bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile, { includeLocal: false }));
    t.state.runCallOffsets ??= [];
    t.state.runCallOffsets[index] = t.calls.length;

    if (index === 1) {
      const sid = t.runs[0]?.sessionId;
      assert.ok(sid, 'Turn 1 must yield a durable sessionId');
      const callsBefore = t.calls.length;
      const snapBefore = inspectSessionModeState(null, rt, sid);
      assert.equal(snapBefore.mode, 'team');
      assert.equal(snapBefore.canSwitch, true);
      const sw = switchSessionExecutionMode(null, rt, sid, 'single', { source: 'it46-before-turn2' });
      assert.equal(sw.changed, true);
      assert.equal(sw.previousMode, 'team');
      assert.equal(sw.modeState.mode, 'single');
      assert.equal(sw.modeState.switchCount, 1);
      assert.equal(t.calls.length, callsBefore, 'switching Team -> Single must make 0 LLM calls');
    }

    if (index === 3) {
      const sid = t.runs[0]?.sessionId;
      const callsBefore = t.calls.length;
      const sw = switchSessionExecutionMode(null, rt, sid, 'team', { source: 'it46-before-turn4' });
      assert.equal(sw.changed, true);
      assert.equal(sw.previousMode, 'single');
      assert.equal(sw.modeState.mode, 'team');
      assert.equal(sw.modeState.switchCount, 2);
      assert.equal(t.calls.length, callsBefore, 'switching Single -> Team must make 0 LLM calls');
    }
  },
  respond(c, t) {
    const runIdx = t.runs.length;
    t.state.leaderStepInRun ??= [0, 0, 0, 0];
    t.state.memberStepByWho ??= {};

    if (c.kind === 'gate') {
      t.state.gateRequests ??= [];
      t.state.gateRequests.push(c.request);
      return allow;
    }
    if (c.kind === 'discuss') return approve;

    if (c.kind === 'member') {
      const step = (t.state.memberStepByWho[c.who] ?? 0) + 1;
      t.state.memberStepByWho[c.who] = step;
      if (c.who === 'impl-t1') {
        if (step === 1) return { tool: 'read', args: { file_path: 'spec.md' } };
        if (step === 2) {
          return {
            tool: 'write',
            args: { file_path: 'src/greeting.js', content: 'export const greet = () => "v1";\n' },
          };
        }
        return { content: 'STATUS: done\nCHANGED: src/greeting.js\nEVIDENCE: wrote v1\nNOTES: none' };
      }
      if (c.who === 'impl-t4') {
        if (step === 1) return { tool: 'read', args: { file_path: 'spec.md' } };
        if (step === 2) {
          return {
            tool: 'write',
            args: { file_path: 'src/turn4.txt', content: 'TURN4_TEAM_OK\n' },
          };
        }
        return { content: 'STATUS: done\nCHANGED: src/turn4.txt\nEVIDENCE: wrote turn4.txt\nNOTES: none' };
      }
    }

    if (c.kind === 'leader') {
      const step = ++t.state.leaderStepInRun[runIdx];

      // Turn 1: Team Mode
      if (runIdx === 0) {
        t.state.turn1Tools = c.tools;
        if (step === 1) return PLAN;
        if (step === 2) {
          return dispatch({
            name: 'impl-t1',
            plan_id: latestPlanId(c),
            task: 'Create src/greeting.js exporting greet() returning "v1".',
            acceptance: ['src/greeting.js exports greet()'],
            write_scope: ['src/**'],
            refs: ['spec.md'],
          });
        }
        if (step === 3) return { content: 'WAITING' };
        if (step === 4) return DELIVERY;
        if (step === 5) return { tool: 'team_status', args: { stop_state: 'delivered', reason: 'Turn 1 delivered' } };
        return { content: 'DELIVERY: approved' };
      }

      // Turn 2: Single Mode Q&A from session context (0 tools, 0 team hooks)
      if (runIdx === 1) {
        t.state.turn2Tools = c.tools;
        t.state.turn2PromptText = c.text;
        return { content: 'Turn 1 created src/greeting.js exporting greet().' };
      }

      // Turn 3: Single Mode direct read + edit + bash + blocked outside/protected writes under FinalGate
      if (runIdx === 2) {
        t.state.turn3Tools = c.tools;
        if (step === 1) {
          return { tool: 'write', args: { file_path: '../outside-escape.txt', content: 'escape' } };
        }
        if (step === 2) {
          t.state.turn3OutsideErr = lastToolResult(c);
          return { tool: 'write', args: { file_path: 'AGENTS.md', content: 'tampered' } };
        }
        if (step === 3) {
          t.state.turn3ProtectedErr = lastToolResult(c);
          return { tool: 'read', args: { file_path: 'src/greeting.js' } };
        }
        if (step === 4) {
          t.state.turn3ReadOut = lastToolResult(c);
          return {
            tool: 'edit',
            args: { file_path: 'src/greeting.js', old_string: '"v1"', new_string: '"v2"' },
          };
        }
        if (step === 5) {
          return {
            tool: SHELL_TOOL,
            args: {
              description: 'Verify updated greeting v2',
              command: 'rm -f src/tmp-check.txt && node --input-type=module -e "import { greet } from \'./src/greeting.js\'; console.log(\'SINGLE_BASH_OK:\' + greet());"',
            },
          };
        }
        t.state.turn3BashOut = lastToolResult(c);
        return { content: 'Updated src/greeting.js to v2 and verified SINGLE_BASH_OK:v2 directly in Single Mode.' };
      }

      // Turn 4: Back in Team Mode on fresh taskSeq (write/bash revoked on leader; fresh dispatch succeeds without reviving impl-t1)
      if (runIdx === 3) {
        t.state.turn4Tools = c.tools;
        if (step === 1) {
          // Attempt direct write in Team mode -> must be rejected because write is revoked from leader!
          return { tool: 'write', args: { file_path: 'src/revoked.txt', content: 'should-fail' } };
        }
        if (step === 2) {
          t.state.turn4RevokedWriteErr = lastToolResult(c);
          return {
            tool: 'team_discuss',
            args: { kind: 'plan', topic: 'turn4-plan', proposal: 'Member impl-t4 writes src/turn4.txt.' },
          };
        }
        if (step === 3) {
          return dispatch({
            name: 'impl-t4',
            plan_id: latestPlanId(c),
            task: 'Write src/turn4.txt containing TURN4_TEAM_OK.',
            acceptance: ['src/turn4.txt contains TURN4_TEAM_OK'],
            write_scope: ['src/**'],
            refs: ['spec.md'],
          });
        }
        if (step === 4) return { content: 'WAITING' };
        if (step === 5) {
          return {
            tool: 'team_discuss',
            args: { kind: 'delivery', topic: 'turn4-delivery', proposal: 'src/turn4.txt written and verified.' },
          };
        }
        if (step === 6) return { tool: 'team_status', args: { stop_state: 'delivered', reason: 'Turn 4 delivered' } };
        return { content: 'DELIVERY: approved' };
      }
    }
  },
  assert(t) {
    assert.equal(t.runs.length, 4, 'all 4 runs executed');
    for (let i = 0; i < 4; i++) {
      assert.equal(t.runs[i].code, 0, `run ${i + 1} exit code must be 0`);
    }
    const sid = t.runs[0].sessionId;
    for (let i = 1; i < 4; i++) {
      assert.equal(t.runs[i].sessionId, sid, `run ${i + 1} must share the exact same sessionId`);
    }

    // Turn 1 assertions (Team mode)
    for (const directTool of ['write', 'edit', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill']) {
      assert.ok(!t.state.turn1Tools.includes(directTool), `Turn 1 Team leader must not expose ${directTool}`);
    }
    assert.ok(t.state.turn1Tools.includes('team_dispatch'));
    assert.match(t.runs[0].final?.text ?? '', /DELIVERY: approved/);

    // Turn 2 assertions (Single mode Q&A: 1 LLM call, 0 tools, 0 team continuation hooks)
    for (const directTool of ['read', 'write', 'edit', SHELL_TOOL, 'job_list', 'job_output', 'job_kill']) {
      assert.ok(t.state.turn2Tools.includes(directTool), `Turn 2 Single leader must expose ${directTool}`);
    }
    for (const teamTool of ['team_dispatch', 'team_discuss', 'team_note', 'team_status', 'send_message', 'interrupt_agent', 'list_agents']) {
      assert.ok(!t.state.turn2Tools.includes(teamTool), `Turn 2 Single leader must hide ${teamTool}`);
    }
    assert.match(t.state.turn2PromptText, /# LeaderTeam Single Mode: direct execution/);
    assert.ok(!t.state.turn2PromptText.includes('# LeaderTeam: you are the team leader'));
    const turn2Calls = t.calls.slice(t.state.runCallOffsets[1], t.state.runCallOffsets[2]);
    assert.equal(turn2Calls.length, 1, 'Turn 2 Single Q&A must complete in 1 LLM call with 0 stop-review or continuation calls');
    assert.match(t.runs[1].final?.text ?? '', /src\/greeting\.js/);

    // Turn 3 assertions (Single mode direct tools under FinalGate)
    assert.match(t.state.turn3OutsideErr ?? '', /rule:path-outside-workspace/, 'outside-workspace write blocked by FinalGate');
    assert.match(t.state.turn3ProtectedErr ?? '', /rule:path-protected/, 'AGENTS.md protected write blocked by FinalGate');
    assert.equal(fs.readFileSync(path.join(t.ws, 'AGENTS.md'), 'utf8'), '# Protected workspace rules\n');
    assert.match(t.state.turn3ReadOut ?? '', /export const greet = \(\) => "v1"/);
    assert.equal(read(t, 'src/greeting.js'), 'export const greet = () => "v2";\n');
    assert.match(t.state.turn3BashOut ?? '', /SINGLE_BASH_OK:v2/);
    assert.ok(
      (t.state.gateRequests ?? []).some(
        req => req.operation?.tool === SHELL_TOOL
          && Array.isArray(req.scope?.write_scope)
          && req.scope.write_scope.some(s => s.includes('Single Mode: leader direct workspace write access')),
      ),
      'cross-boundary bash in Single mode must declare Single Mode write_scope to gate reviewer',
    );

    // Turn 4 assertions (Team mode restored: write/bash revoked, fresh taskSeq, impl-t1 never revived)
    for (const revokedTool of ['write', 'edit', 'bash', 'pwsh', 'job_list', 'job_output', 'job_kill']) {
      assert.ok(!t.state.turn4Tools.includes(revokedTool), `Turn 4 Team leader must revoke ${revokedTool}`);
    }
    assert.equal(exists(t, 'src/revoked.txt'), false, 'revoked write in Turn 4 must never touch disk');
    assert.match(t.state.turn4RevokedWriteErr ?? '', /unknown tool|UNKNOWN_TOOL|tool-not-in-profile/i);
    assert.equal(read(t, 'src/turn4.txt'), 'TURN4_TEAM_OK\n');
    assert.match(t.runs[3].final?.text ?? '', /DELIVERY: approved/);

    const members = memberRecords(t).filter(r => r.type === 'member');
    const m1 = members.find(m => m.name === 'impl-t1');
    const m4 = members.find(m => m.name === 'impl-t4');
    assert.ok(m1 && m4, 'both impl-t1 and impl-t4 recorded');
    assert.equal(m1.taskSeq, 1);
    assert.ok(m4.taskSeq > m1.taskSeq, `Turn 4 after Single -> Team switch must run on fresh taskSeq (${m4.taskSeq} > ${m1.taskSeq})`);
    assert.equal(callsOf(t, 'member', 'impl-t1').length, 3, 'Turn 1 finished member impl-t1 must NEVER be revived in Turn 4');

    const receipts = gateReceipts(t);
    assert.ok(receipts.some(r => r.role === 'leader' && r.tool === 'edit' && r.decision === 'allow' && r.by === 'sandbox'));
    assert.ok(receipts.some(r => r.role === 'leader' && r.tool === 'write' && r.decision === 'deny' && r.by === 'rule:path-outside-workspace'));
    assert.ok(receipts.some(r => r.role === 'leader' && r.tool === 'write' && r.decision === 'deny' && r.by === 'rule:path-protected'));

    const modeStore = new SessionModeStore(t.store);
    const history = modeStore.history(sid);
    assert.equal(history.length, 2);
    assert.equal(history[0].fromMode, 'team');
    assert.equal(history[0].toMode, 'single');
    assert.equal(history[1].fromMode, 'single');
    assert.equal(history[1].toMode, 'team');
  },
};
