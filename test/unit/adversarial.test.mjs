import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, isInside, globToRegExp, normalizeGlob } from '../../leaderteam/core/paths.mjs';
import { evaluateHardRules, parseGateVerdict } from '../../leaderteam/core/gate-policy.mjs';
import { sanitizeArguments } from '../../leaderteam/core/redact.mjs';
import { configWith } from './helpers.mjs';

const W = 'win32';
const config = configWith({ paths: { globalRefRoots: ['D:/shared 参考文档'] } });
const member = { role: 'member', name: 'adversarial', profile: 'code', allowedTools: config.profiles.code.tools, writeScope: ['**'], unreadRefs: [] };

test('T06-01 traversal escapes workspace', () => {
  assert.equal(isInside(resolvePath('D:\\proj\\src\\..\\..\\Windows\\x', undefined, W), resolvePath('D:\\proj', undefined, W), W), false);
});
test('T06-02 UNC and extended UNC are outside workspace', () => {
  for (const raw of ['\\\\server\\share\\x', '\\\\?\\UNC\\server\\share\\x'])
    assert.equal(isInside(resolvePath(raw, undefined, W), resolvePath('D:\\proj', undefined, W), W), false, raw);
});
test('T06-03 Win32 trailing dot and space alias global refs', () => {
  for (const raw of ['D:\\shared 参考文档.\\x.md', 'D:\\shared 参考文档 \\x.md'])
    assert.equal(isInside(resolvePath(raw, undefined, W), resolvePath('D:\\shared 参考文档', undefined, W), W), true, raw);
});
test('T06-04 alternate data stream path is invalid', () => {
  assert.equal(resolvePath('D:\\proj\\src\\a.ts:secret', undefined, W), null);
});
test('T06-05 hard rules reject Win32 aliases and alternate data streams', () => {
  const rule = file_path => evaluateHardRules({ tool: 'write', args: { file_path }, actor: member, cwd: 'D:\\', platform: W }, config)?.rule;
  assert.equal(rule('D:\\shared 参考文档.\\x.md'), 'path-in-global-refs');
  assert.equal(rule('D:\\shared 参考文档 \\x.md'), 'path-in-global-refs');
  assert.equal(rule('D:\\proj\\src\\a.ts:secret'), 'path-invalid');
});
test('T06-06 strict verdict rejects homoglyph, multiple objects and blank reason', () => {
  for (const raw of ['{"decision":"аllow","risk":"low","reason":"x"}', '{"decision":"allow","risk":"low","reason":"x"} {"decision":"deny"}', '{"decision":"allow","risk":"low","reason":"   "}'])
    assert.equal(parseGateVerdict(raw).ok, false, raw);
});
test('T06-07 inline URL password is redacted', () => {
  assert.ok(!JSON.stringify(sanitizeArguments({ command: 'curl "https://h/x?password=abc&q=1"' })).includes('abc'));
});
test('T06-08 glob case and segment matching follow platform', () => {
  assert.equal(globToRegExp('src/**', W).test('SRC/A.TS'), true);
  assert.equal(globToRegExp('src/*', 'linux').test('src/a/b'), false);
});
test('T06-09 traversal glob rejected with BAD_GLOB', () => {
  assert.throws(() => normalizeGlob('src/../../x'), { code: 'BAD_GLOB' });
});
