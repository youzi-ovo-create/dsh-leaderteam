import path from 'node:path';
import { assert, allow, PLAN, callsOf, lastToolResult, agreementEvents, jsonl, teamDir } from '../lib.mjs';

export default {
  config: {
    // This scenario checks that the configured gate role drives the review model, using a leader note as the reviewed
    // operation; leader notes are rule-only by default, so model review of them is switched back on here.
    gate: { ruleOnlyTools: [] },
    roles: {
      leader: {
        route: 'zcode/GLM-5.3',
        effort: 'high',
      },
      gate: {
        route: 'codex/gpt-6.1-sol',
        effort: 'high',
        maxTokens: 2000,
        timeoutMs: 60000,
        retries: 1,
      },
      discussA: {
        route: 'zcode/GLM-5.3-Flash',
        effort: 'low',
        maxTokens: 8000,
        timeoutMs: 300000,
        retries: 1,
      },
      discussB: {
        route: 'codex/gpt-6.1-terra',
        effort: 'high',
        maxTokens: 8000,
        timeoutMs: 300000,
        retries: 1,
      },
      arbiter: {
        route: 'antigravity/claude-opus-5-5',
        effort: 'high',
        maxTokens: 16000,
        timeoutMs: 600000,
        retries: 1,
      },
    },
  },
  respond(c) {
    if (c.kind === 'gate') {
      return allow;
    }
    if (c.kind === 'discuss') {
      return c.who === 'A'
        ? { json: { stance: 'approve', summary: 'ok', reasons: ['fine'], required_changes: [] } }
        : { json: { stance: 'revise', summary: 'needs tests', reasons: ['no test verification step'], suggestions: ['Include an explicit verification read/assertion step for src/a.txt'], required_changes: ['add tests'] } };
    }
    if (c.kind === 'arbiter') {
      return { json: { adopt: 'A' } };
    }
    if (c.kind === 'leader') {
      if (c.index === 1) return PLAN;
      if (c.index === 2) return { tool: 'team_note', args: { path: 'INDEX.md', content: '# Plan Notes\n' } };
      return { content: 'FINAL: all roles verified' };
    }
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(run.code, 0, 'exit code');

    // 1. Leader role: GLM-5.3 / high (driven by leader config)
    const leaders = callsOf(t, 'leader');
    assert.ok(leaders.length >= 2, 'at least 2 leader calls');
    for (const l of leaders) {
      assert.equal(l.model, 'zcode/GLM-5.3', 'leader route drove runner model');
      assert.equal(l.effort, 'high', 'leader effort drove runner effort');
    }

    // 2. Gate role: gpt-6.1-sol / high
    const gates = callsOf(t, 'gate');
    assert.equal(gates.length, 1, 'team_note triggered gate review');
    assert.equal(gates[0].model, 'codex/gpt-6.1-sol');
    assert.equal(gates[0].effort, 'high');

    // 3. Discussion role A: GLM-5.3-Flash / low
    const dA = callsOf(t, 'discuss', 'A');
    assert.equal(dA.length, 3, 'discuss A ran 3 rounds');
    for (const c of dA) {
      assert.equal(c.model, 'zcode/GLM-5.3-Flash');
      assert.equal(c.effort, 'low');
    }

    // 4. Discussion role B: gpt-6.1-terra / high
    const dB = callsOf(t, 'discuss', 'B');
    assert.equal(dB.length, 3, 'discuss B ran 3 rounds');
    for (const c of dB) {
      assert.equal(c.model, 'codex/gpt-6.1-terra');
      assert.equal(c.effort, 'high');
    }

    // 5. Arbiter role: claude-opus-5-5 / high (cross-family arbitration: GLM vs GPT arbitrated by Claude)
    const arbs = callsOf(t, 'arbiter');
    assert.equal(arbs.length, 1, 'arbiter ruled once');
    assert.equal(arbs[0].model, 'antigravity/claude-opus-5-5');
    assert.equal(arbs[0].effort, 'high');

    // Agreement events record the configured cross-family routes
    const agrs = agreementEvents(t);
    const created = agrs.find(e => e.type === 'created');
    assert.deepEqual(created.routes, {
      A: 'zcode/GLM-5.3-Flash',
      B: 'codex/gpt-6.1-terra',
      arbiter: 'antigravity/claude-opus-5-5',
      serialReviewer: 'zcode/GLM-5.3',
    });
    assert.equal(agrs.filter(e => e.type === 'ruling').length, 1, 'ruling event recorded');

    // Usage ledger records exact route and effort for all roles
    const usage = jsonl(path.join(teamDir(t), 'usage.jsonl'));
    const uGate = usage.filter(u => u.role === 'gate');
    assert.equal(uGate.length, 1);
    assert.equal(uGate[0].route, 'codex/gpt-6.1-sol');
    assert.equal(uGate[0].effort, 'high');

    const uDA = usage.filter(u => u.role === 'discussA');
    assert.equal(uDA.length, 3);
    assert.ok(uDA.every(u => u.route === 'zcode/GLM-5.3-Flash' && u.effort === 'low'));

    const uDB = usage.filter(u => u.role === 'discussB');
    assert.equal(uDB.length, 3);
    assert.ok(uDB.every(u => u.route === 'codex/gpt-6.1-terra' && u.effort === 'high'));

    const uArb = usage.filter(u => u.role === 'arbiter');
    assert.equal(uArb.length, 1);
    assert.equal(uArb[0].route, 'antigravity/claude-opus-5-5');
    assert.equal(uArb[0].effort, 'high');
  },
};
