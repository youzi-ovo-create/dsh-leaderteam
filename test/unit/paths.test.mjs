import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, isInside, relativeInside, globToRegExp, matchesAnyGlob, normalizeGlob } from '../../leaderteam/core/paths.mjs';
const W = 'win32', P = 'linux';
test('win32: separators, case, trailing slash, .., \\\\?\\ prefix', () => {
  assert.equal(resolvePath('d:/Proj/src/../a.txt', undefined, W), 'D:\\Proj\\a.txt');
  assert.equal(resolvePath('\\\\?\\D:\\Proj\\x\\', undefined, W), 'D:\\Proj\\x');
  assert.equal(resolvePath('src\\a.ts', 'D:\\Proj', W), 'D:\\Proj\\src\\a.ts');
  assert.equal(resolvePath('\\Windows\\x', 'D:\\Proj', W), 'D:\\Windows\\x');
  assert.equal(resolvePath('C:foo', 'D:\\Proj', W), null, 'drive-relative is rejected');
  assert.equal(resolvePath('', 'D:\\Proj', W), null);
  assert.equal(resolvePath('a\0b', 'D:\\Proj', W), null);
  assert.equal(resolvePath('rel', undefined, W), null, 'relative without cwd');
});
test('win32 containment is case-insensitive and boundary-safe', () => {
  assert.ok(isInside('D:\\PROJ\\Src', 'd:\\proj', W));
  assert.ok(isInside('D:\\proj', 'D:\\proj', W));
  assert.ok(!isInside('D:\\proj2\\a', 'D:\\proj', W));
  assert.ok(isInside('D:\\shared 参考文档\\a.md', resolvePath('D:/shared 参考文档', undefined, W), W));
});
test('posix containment and relative paths', () => {
  assert.equal(resolvePath('../x', '/w/p', P), '/w/x');
  assert.ok(!isInside('/w/px', '/w/p', P));
  assert.equal(relativeInside('/w/p', '/w/p/src/a.ts', P), 'src/a.ts');
  assert.equal(relativeInside('/w/p', '/w/p', P), '');
  assert.equal(relativeInside('/w/p', '/w/q/a', P), null);
  assert.equal(relativeInside('D:\\P', 'D:\\p\\Src\\a.ts', W), 'Src/a.ts');
});
test('globs: **, *, ?, literal dirs, case rules', () => {
  const t = (g, s, plat = P) => globToRegExp(g, plat).test(s);
  assert.ok(t('src/**', 'src/a/b.ts')); assert.ok(t('src/**', 'src'));
  assert.ok(t('**/*.md', 'README.md')); assert.ok(t('**/*.md', 'docs/a/b.md'));
  assert.ok(!t('src/*.ts', 'src/a/b.ts')); assert.ok(t('src/*.ts', 'src/b.ts'));
  assert.ok(t('src/?.ts', 'src/a.ts')); assert.ok(!t('src/?.ts', 'src/ab.ts'));
  assert.ok(t('docs', 'docs/x/y.md'), 'literal dir covers its subtree'); assert.ok(!t('docs', 'docs2/a'));
  assert.ok(t('a/**/z.txt', 'a/z.txt')); assert.ok(t('a/**/z.txt', 'a/b/c/z.txt'));
  assert.ok(t('a.b', 'a.b')); assert.ok(!t('a.b', 'aXb'), 'dots are literal');
  assert.ok(t('SRC/**', 'src/a', W)); assert.ok(!t('SRC/**', 'src/a', P));
  assert.ok(matchesAnyGlob('tests/x.py', ['src/**', 'tests/**'], P));
});
test('invalid globs are rejected', () => {
  for (const g of ['', '  ', '/abs/**', 'C:/x/**', '../x', 'a/../b', 'a//b', '.']) assert.throws(() => normalizeGlob(g), { code: 'BAD_GLOB' }, g);
  assert.equal(normalizeGlob('./src\\**'), 'src/**');
});
test('win32: trailing dots/spaces are stripped per segment; alternate data streams are invalid', () => {
  assert.equal(resolvePath('D:\\shared 参考文档.\\x.md', undefined, W), 'D:\\shared 参考文档\\x.md');
  assert.equal(resolvePath('D:\\proj\\src \\a.ts. ', undefined, W), 'D:\\proj\\src\\a.ts');
  assert.ok(isInside(resolvePath('D:\\shared 参考文档.\\x.md', undefined, W), resolvePath('D:\\shared 参考文档', undefined, W), W));
  assert.equal(resolvePath('D:\\proj\\src\\a.ts:secret', undefined, W), null);
  assert.equal(resolvePath('src\\a.ts::$DATA', 'D:\\proj', W), null);
  assert.equal(resolvePath('D:\\proj\\...\\x', undefined, W), null);
  assert.equal(resolvePath('a.ts.', '/w', P), '/w/a.ts.', 'posix keeps trailing dots');
});
