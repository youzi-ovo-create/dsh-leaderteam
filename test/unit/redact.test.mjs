import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeArguments, redactInlineSecrets, truncate, boundJson, REDACTED } from '../../leaderteam/core/redact.mjs';
test('sensitive keys and inline secrets are redacted', () => {
  const out = sanitizeArguments({ apiKey: 'sk-1', nested: { password: 'p' }, command: 'curl -H "Authorization: Bearer abc123" --token xyz https://h', list: ['TOKEN=t1'] });
  assert.equal(out.apiKey, REDACTED); assert.equal(out.nested.password, REDACTED);
  assert.ok(!out.command.includes('abc123') && !out.command.includes('xyz'));
  assert.ok(!out.list[0].includes('t1'));
});
test('redactInlineSecrets keeps unrelated text', () => { assert.equal(redactInlineSecrets('npm test --watch'), 'npm test --watch'); });
test('truncate never splits a surrogate pair', () => { const s = 'a' + '😀'.repeat(3); const t = truncate(s, 2); assert.equal(t, 'a…'); });
test('boundJson keeps head and tail of long strings and caps total size', () => {
  const big = 'H'.repeat(5000) + 'TAILMARK';
  const { text, truncated } = boundJson({ content: big }, 2000);
  assert.ok(truncated); assert.ok(text.length <= 2000 + 30); assert.ok(text.includes('TAILMARK')); assert.ok(text.includes('chars omitted'));
  assert.deepEqual(boundJson({ a: 1 }, 2000), { text: '{"a":1}', truncated: false });
});
