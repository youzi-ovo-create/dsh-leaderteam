// Integration scenario it31: external model config writer + live hot-reload inside a running Official DSH session.
// Verifies that running scripts/configure-models.mjs mid-session updates member executionPool, model efforts,
// while governance stays frozen for the running team and is adopted by the next team.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assert, allow, PLAN, DELIVERY, dispatch, latestPlanId, callsOf, lastToolResult, read, jsonl } from '../lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WRITER_CLI = path.join(ROOT, 'scripts', 'configure-models.mjs');

export default {
  runs: [{ task: 'Exercise live execution model updates while preserving current governance.' }, { task: 'Create a fresh team and verify the updated governance defaults.' }],
  files: { 'spec.md': '# Live Model Reload Spec\nWrite `src/reloaded.txt` containing `HOT_RELOAD_OK`.\n' },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'discuss') {
      return { json: { stance: 'approve', summary: 'ok', reasons: ['meets spec'], required_changes: [] } };
    }
    if (c.kind === 'member') {
      return [
        { tool: 'read', args: { file_path: 'spec.md' } },
        { tool: 'write', args: { file_path: c.who === 'impl-fresh' ? 'src/fresh.txt' : 'src/reloaded.txt', content: 'HOT_RELOAD_OK' } },
        { content: 'STATUS: done\nSUMMARY: wrote src/reloaded.txt' },
      ][c.index - 1];
    }
    if (c.kind === 'leader') {
      if (t.runs.length) {
        t.state.freshIndex = (t.state.freshIndex ?? 0) + 1;
        if (t.state.freshIndex === 1) return { tool: 'team_models', args: {} };
        if (t.state.freshIndex === 2) { t.state.freshModels = JSON.parse(lastToolResult(c)); return PLAN; }
        if (t.state.freshIndex === 3) return dispatch({ name: 'impl-fresh', plan_id: latestPlanId(c), model: 'zcode/GLM-5.3-Flash', effort: 'high', write_scope: ['src/**'] });
        if (t.state.freshIndex === 4) return { content: 'WAITING' };
        if (t.state.freshIndex === 5) return DELIVERY;
        return { content: 'DELIVERY: approved' };
      }
      if (c.index === 1) {
        return { tool: 'team_models', args: {} };
      }
      if (c.index === 2) {
        // Invoke external writer mid-session while DSH process is running:
        // 1) Exclude all GPT models from member executionPool
        // 2) Narrow zcode/GLM-5.3-Flash efforts from [low, high, max] to [low, high]
        // 3) Change future-team safety gate defaults from Sol high to GLM high.
        const cfgPath = path.join(t.workDir, 'leaderteam.config.json');
        const cliRes = spawnSync(process.execPath, [
          WRITER_CLI,
          '--config', cfgPath,
          '--no-sync-patches',
          '--pool-disable-family', 'gpt',
          '--upsert-model', 'zcode/GLM-5.3-Flash',
          '--efforts', 'low,high',
          '--default-effort', 'high',
          '--set-role', 'gate=zcode/GLM-5.3:high',
        ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
        if (cliRes.status !== 0) {
          throw new Error(`configure-models.mjs failed: ${cliRes.stderr || cliRes.stdout}`);
        }
        t.state.writerOut = JSON.parse(cliRes.stdout);
        return { tool: 'team_models', args: {} };
      }
      if (c.index === 3) return PLAN;
      if (c.index === 4) {
        t.state.planId = latestPlanId(c);
        // Attempt dispatch with disabled GPT model -> must be rejected immediately by hot-reloaded pool
        return dispatch({
          plan_id: t.state.planId,
          name: 'blocked-gpt',
          model: 'codex/gpt-6.1-sol',
          effort: 'medium',
          write_scope: ['src/**'],
        });
      }
      if (c.index === 5) {
        // Attempt dispatch with narrowed-out effort 'max' on GLM-5.3-Flash -> must be rejected immediately
        return dispatch({
          plan_id: t.state.planId,
          name: 'blocked-effort',
          model: 'zcode/GLM-5.3-Flash',
          effort: 'max',
          write_scope: ['src/**'],
        });
      }
      if (c.index === 6) {
        // Valid dispatch uses the live execution pool and this team's original frozen safety gate.
        return dispatch({
          plan_id: t.state.planId,
          name: 'impl-hot-reload',
          model: 'zcode/GLM-5.3-Flash',
          effort: 'high',
          write_scope: ['src/**'],
        });
      }
      if (c.index === 7) return { content: 'WAITING_FOR_MEMBER' };
      if (c.index === 8) return DELIVERY;
      return { content: 'FINAL: live model config reload verified' };
    }
  },
  assert(t) {
    const run = t.runs[0];
    assert.equal(t.runs.length, 2);
    assert.equal(t.runs[1].code, 0);
    assert.equal(run.code, 0, 'exit code 0');
    assert.equal(t.state.writerOut?.saved, true, 'external writer saved config mid-session');
    assert.equal(read(t, 'src/reloaded.txt'), 'HOT_RELOAD_OK');

    const l = callsOf(t, 'leader');
    const modelsBefore = JSON.parse(lastToolResult(l[1]));
    const modelsAfter = JSON.parse(lastToolResult(l[2]));
    // Before external edit: five execution models, with the configured Sol safety gate.
    assert.equal(modelsBefore.models.length, 5);
    assert.ok(modelsBefore.models.some(m => m.family === 'gpt'));
    assert.equal(modelsBefore.fixed_roles.gate.route, 'codex/gpt-6.1-sol');
    assert.equal(modelsBefore.fixed_roles.gate.effort, 'high');

    // Pool and effort changes are live; governance remains frozen until a new team.
    assert.equal(modelsAfter.models.length, 2);
    assert.ok(modelsAfter.models.every(m => m.family !== 'gpt'));
    const flashRow = modelsAfter.models.find(m => m.route === 'zcode/GLM-5.3-Flash');
    assert.deepEqual(flashRow.efforts, ['low', 'high']);
    assert.equal(modelsAfter.fixed_roles.gate.route, 'codex/gpt-6.1-sol');
    assert.equal(modelsAfter.fixed_roles.gate.effort, 'high');
    assert.equal(t.state.freshModels.fixed_roles.gate.route, 'zcode/GLM-5.3');

    // Rejected dispatches were caught by deterministic dispatch-model-invalid rule without spending gate LLM calls!
    assert.match(lastToolResult(l[4]), /not in the execution pool/);
    assert.match(lastToolResult(l[5]), /effort "max" is not supported by zcode\/GLM-5\.3-Flash/);
    assert.match(lastToolResult(l[6]), /"member": "impl-hot-reload"/);
    const firstDir = path.join(t.store, 'teams', t.runs[0].sessionId);
    const secondDir = path.join(t.store, 'teams', t.runs[1].sessionId);
    const receipts = jsonl(path.join(firstDir, 'gate.jsonl'));
    assert.equal(receipts.filter(r => r.by === 'rule:dispatch-model-invalid').length, 2);

    const gates = callsOf(t, 'gate');
    assert.equal(gates.length, 4, 'each team reviews dispatch and member write');
    assert.equal(gates.filter(g => g.model === 'codex/gpt-6.1-sol' && g.effort === 'high').length, 2);
    assert.equal(gates.filter(g => g.model === 'zcode/GLM-5.3' && g.effort === 'high').length, 2);

    const usage = jsonl(path.join(firstDir, 'usage.jsonl')).filter(u => u.role === 'gate');
    assert.equal(usage.length, 2);
    assert.ok(usage.every(u => u.route === 'codex/gpt-6.1-sol' && u.effort === 'high'));
    const nextUsage = jsonl(path.join(secondDir, 'usage.jsonl')).filter(u => u.role === 'gate');
    assert.equal(nextUsage.length, 2);
    assert.ok(nextUsage.every(u => u.route === 'zcode/GLM-5.3' && u.effort === 'high'));
    assert.equal(read(t, 'src/fresh.txt'), 'HOT_RELOAD_OK');
  },
};
