import fs from 'node:fs';
import { assert, allow, dispatch, callsOf, lastToolResult, memberRecords } from '../lib.mjs';
export default {
  files: { 'spec.md': 'spec\n' },
  config: { quota: { allowUnknown: false } },
  quotaPatch(q) { for (const a of q.accounts) if (a.provider === 'codex') for (const w of a.windows) w.remaining = 1; },
  respond(c, t) {
    if (c.kind === 'gate') return allow;
    if (c.kind === 'leader') {
      if (c.index === 4) {
        const quota = JSON.parse(fs.readFileSync(t.config.quota.stateFile, 'utf8'));
        quota.generated_at = '2000-01-01T00:00:00.000Z';
        fs.writeFileSync(t.config.quota.stateFile, JSON.stringify(quota));
        return dispatch({ name: 'scout-expired', profile: 'readonly', write_scope: [], model: 'zcode/GLM-5.3-Flash', effort: 'low' });
      }
      return [{ tool: 'team_models', args: {} }, dispatch({ name: 'scout', profile: 'readonly', write_scope: [], model: 'codex/gpt-6.1-terra', effort: 'medium' }), dispatch({ name: 'scout2', profile: 'readonly', write_scope: [], model: 'zcode/GLM-5.3-Flash', effort: 'low' }), null, { content: 'WAITING' }, { content: 'DONE' }][c.index - 1];
    }
    if (c.kind === 'member') return [{ tool: 'read', args: { file_path: 'spec.md' } }, { content: 'STATUS: done' }][c.index - 1];
  },
  assert(t) {
    const l = callsOf(t, 'leader');
    const models = JSON.parse(lastToolResult(l[1]));
    assert.equal(models.models.find(m => m.route === 'codex/gpt-6.1-terra').quota, 'exhausted');
    assert.equal(models.models.find(m => m.route === 'zcode/GLM-5.3').quota, 'ok');
    assert.match(lastToolResult(l[2]), /quota is exhausted/);
    assert.match(lastToolResult(l[3]), /"member": "scout2"/);
    assert.match(lastToolResult(l[4]), /quota snapshot is \d+s old/);
    assert.equal(callsOf(t, 'gate').filter(call => call.request.operation.tool === 'team_dispatch').length, 1);
    assert.deepEqual(memberRecords(t).filter(record => record.name).map(record => record.name), ['scout2']);
    const m = callsOf(t, 'member', 'scout2');
    assert.ok(m.length > 0 && m.every(c => c.model === 'zcode/GLM-5.3-Flash' && c.effort === 'low'), 'no silent substitution');
  },
};
