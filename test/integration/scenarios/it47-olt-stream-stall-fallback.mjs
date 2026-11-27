import fs from 'node:fs';
import path from 'node:path';
import {
  assert,
  callsOf,
  exists,
  jsonl,
  lastToolResult,
  memberRecords,
  read,
  teamDir,
} from '../lib.mjs';

const role = (route, effort = 'high') => ({
  route,
  effort,
  maxTokens: 4000,
  timeoutMs: 30000,
  retries: 0,
  fallback: [],
});

export default {
  config: {
    circuitBreaker: {
      firstOutputTimeoutMs: 450,
    },
    team: {
      rollingPlanning: true,
      executionPool: ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash'],
      executionFallbacks: {
        'zcode/GLM-5.3': ['zcode/GLM-5.3-Flash'],
      },
    },
    gate: { sandboxDirectAllow: true, enablePatternCache: true },
    governance: {
      mode: 'autonomous',
      autoSuperviseStages: false,
      autoSuperviseDispatches: false,
    },
    quota: { allowUnknown: true, allowUnknownGpt: true },
    roles: {
      leader: { route: 'codex/gpt-6.1-sol', effort: 'high' },
      gate: role('codex/gpt-6.1-sol', 'high'),
      discussA: role('zcode/GLM-5.3', 'high'),
      discussB: role('codex/gpt-6.1-sol', 'high'),
      arbiter: role('zcode/GLM-5.3', 'high'),
      serialReviewer: role('zcode/GLM-5.3-Flash', 'high'),
      directExec: {
        route: 'zcode/GLM-5.3',
        effort: 'high',
        maxTokens: 4000,
        timeoutMs: 30000,
        retries: 0,
        fallback: [{ route: 'zcode/GLM-5.3-Flash', effort: 'high' }],
      },
    },
  },
  files: {
    'spec.md': 'Write src/fallback-ok.txt containing OLT_STREAM_FALLBACK_VERIFIED.\n',
  },
  runs: [
    { task: 'Implement src/fallback-ok.txt according to spec.md.' },
  ],
  async respond(c, t) {
    if (c.kind === 'gate') {
      return { json: { decision: 'allow', risk: 'low', reason: 'authorized workspace write' } };
    }
    if (c.kind === 'supervision') {
      return { json: { verdict: 'no_objection', summary: 'ok', concerns: [] } };
    }

    if (c.kind === 'member') {
      // Primary route (`zcode/GLM-5.3`) hangs at 0 SSE payload bytes after HTTP 200 headers!
      if (c.model === 'zcode/GLM-5.3' || c.model === 'GLM-5.3') {
        return { hangStream: true, sendHeaders: true, hangMs: 15000 };
      }
      // Fallback route (`zcode/GLM-5.3-Flash`) completes the task cleanly!
      const sysText = (c.payload?.messages ?? [])
        .filter(m => m.role === 'system' || m.role === 'developer')
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      const refMatches = [...sysText.matchAll(/Required references BEFORE changing anything:\n([\s\S]*?)\nRead every line/g)];
      const refLines = (refMatches[0]?.[1] ?? '')
        .split('\n')
        .map(l => l.replace(/^- /, '').trim())
        .filter(l => l && l !== '(none)');
      const fbStep = t.calls.filter(x => x.kind === 'member' && x.model.includes('GLM-5.3-Flash')).length + 1;
      if (fbStep <= refLines.length) {
        return { tool: 'read', args: { file_path: refLines[fbStep - 1] } };
      }
      if (fbStep === refLines.length + 1) {
        return {
          tool: 'write',
          args: {
            file_path: path.join(t.ws, 'src/fallback-ok.txt'),
            content: 'OLT_STREAM_FALLBACK_VERIFIED\n',
          },
        };
      }
      return {
        content: 'STATUS: done\nCHANGED: src/fallback-ok.txt\nEVIDENCE: wrote src/fallback-ok.txt\nNOTES: recovered via executionFallbacks',
      };
    }

    if (c.kind === 'leader') {
      if (c.index === 1) {
        return {
          tools: [
            {
              tool: 'team_plan',
              args: {
                action: 'overview',
                summary: 'Write src/fallback-ok.txt',
                approach: 'Single code stage with executionFallbacks protection',
                acceptance: ['src/fallback-ok.txt contains OLT_STREAM_FALLBACK_VERIFIED'],
                estimated_minutes: 2,
                future_work: [],
              },
            },
            {
              tool: 'team_plan',
              args: {
                action: 'stage',
                stage_id: 's-impl',
                goal: 'Create src/fallback-ok.txt from spec.md',
                method: 'Read spec.md and write src/fallback-ok.txt',
                acceptance: ['src/fallback-ok.txt contains OLT_STREAM_FALLBACK_VERIFIED'],
                interfaces: ['src/fallback-ok.txt'],
                profile: 'code',
                tools: ['read', 'write'],
                write_scope: ['src/**'],
                refs: ['spec.md'],
                depends_on: [],
                expected_inputs: [],
                serial_reason: 'single bounded file',
                ready: true,
              },
            },
          ],
        };
      }
      if (c.index === 2) {
        return {
          tool: 'team_dispatch',
          args: {
            name: 'impl',
            stage_id: 's-impl',
            model: 'zcode/GLM-5.3',
            effort: 'high',
          },
        };
      }
      const prevToolRes = lastToolResult(c);
      if (!exists(t, 'src/fallback-ok.txt')) {
        if (prevToolRes.includes('"stop_declaration"')) {
          return { content: 'Waiting for member impl to complete.' };
        }
        return {
          tool: 'team_status',
          args: {
            stop_state: 'waiting_members',
            reason: 'Waiting for impl or its fallback replacement to finish src/fallback-ok.txt',
          },
        };
      }
      if (prevToolRes.includes('"delivered"') || c.text.includes('OLT_STREAM_FALLBACK_VERIFIED')) {
        return { content: 'DELIVERY: completed\nsrc/fallback-ok.txt verified.' };
      }
      return {
        tools: [
          { tool: 'read', args: { file_path: path.join(t.ws, 'src/fallback-ok.txt') } },
          { tool: 'team_status', args: { stop_state: 'delivered', reason: 'Fallback member completed src/fallback-ok.txt' } },
        ],
      };
    }

    return { content: 'OK' };
  },
  async assert(t) {
    assert.equal(t.runs[0].code, 0, t.runs[0].stderr);
    assert.equal(exists(t, 'src/fallback-ok.txt'), true);
    assert.equal(read(t, 'src/fallback-ok.txt').trim(), 'OLT_STREAM_FALLBACK_VERIFIED');

    const memCalls = callsOf(t, 'member');
    assert.ok(memCalls.some(c => c.model.includes('GLM-5.3') && !c.model.includes('Flash')), 'primary route zcode/GLM-5.3 was attempted');
    assert.ok(memCalls.some(c => c.model.includes('GLM-5.3-Flash')), 'fallback route zcode/GLM-5.3-Flash ran automatically');

    const wf = jsonl(path.join(teamDir(t), 'workflow.jsonl'));
    const fbEv = wf.find(e => e.type === 'member-execution-fallback');
    assert.ok(fbEv, 'workflow.jsonl recorded member-execution-fallback');
    assert.equal(fbEv.trigger, 'stream-first-output-timeout');
    assert.equal(fbEv.fromModel, 'zcode/GLM-5.3');
    assert.equal(fbEv.toModel, 'zcode/GLM-5.3-Flash');

    const memRecs = memberRecords(t);
    assert.ok(memRecs.some(r => r.status === 'failed' && String(r.error || '').includes('STREAM_FIRST_OUTPUT_TIMEOUT')));
    assert.ok(memRecs.some(r => r.status === 'done'));
  },
};
