// 2026-11-11 owner decision: the leader reads the workspace, the reference roots and a configured list of extra
// read-only roots. Anything else needs a grant typed by the user: a message line that starts with "允许读取" / "allow read".
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHardRules, parseReadGrants } from '../../leaderteam/core/gate-policy.mjs';
import { defaultConfig, configWith } from './helpers.mjs';

const W = 'win32';
const c = defaultConfig();
const leader = { role: 'leader', name: 'leader', profile: 'leader', allowedTools: c.profiles.leader.tools, writeScope: [], unreadRefs: [] };
const scout = { role: 'member', name: 'scout', profile: 'readonly', allowedTools: c.profiles.readonly.tools, writeScope: [], unreadRefs: [] };
const hit = (tool, args, extra = {}, config = c, actor = leader) => evaluateHardRules({ tool, args, actor, cwd: 'D:\\proj', platform: W, ...extra }, config);
const GRANTED = 'E:\\lt-grant-fixture\\合同 2026';

test('leader reads inside the workspace and the global reference roots without asking', () => {
  const cfgWithRef = configWith({ paths: { globalRefRoots: ['E:\\shared-ref-root'] } });
  assert.equal(hit('read', { file_path: 'src/a.ts' }), undefined);
  assert.equal(hit('read', { file_path: 'D:\\proj\\docs\\x.md' }), undefined);
  assert.equal(hit('read', { file_path: 'E:\\shared-ref-root/规范.md' }, {}, cfgWithRef), undefined);
  assert.equal(hit('grep', { pattern: 'x' }), undefined);
  assert.equal(hit('glob', { pattern: '**/*.md', path: 'E:\\shared-ref-root' }, {}, cfgWithRef), undefined);
});
test('leader read outside its roots is denied with instructions to ask the user', () => {
  for (const [tool, args] of [['read', { file_path: 'C:\\Users\\someone\\.ssh\\id_rsa' }], ['read_image', { file_path: `${GRANTED}\\a.png` }], ['glob', { pattern: '*', path: 'C:\\Users' }], ['grep', { pattern: 'x', path: '..\\other' }]]) {
    const r = hit(tool, args);
    assert.equal(r?.rule, 'path-outside-read-roots', `${tool} ${JSON.stringify(args)}`);
    assert.match(r.reason, /Ask the user/);
    assert.match(r.reason, /允许读取/);
  }
  assert.equal(hit('glob', { pattern: 'C:/Users/**' })?.rule, 'pattern-outside-workspace');
  assert.equal(hit('grep', { pattern: 'x', glob: '../**' })?.rule, 'pattern-outside-workspace');
});
test('configured leaderReadRoots are standing read-only roots for the leader only', () => {
  const cfg = configWith({ paths: { leaderReadRoots: ['E:\\资料库'] } });
  assert.equal(hit('read', { file_path: 'E:\\资料库\\设计\\a.md' }, {}, cfg), undefined);
  assert.equal(hit('glob', { pattern: '**/*.md', path: 'E:\\资料库' }, {}, cfg), undefined);
  assert.equal(hit('read', { file_path: 'E:\\资料库2\\a.md' }, {}, cfg)?.rule, 'path-outside-read-roots', 'a sibling with the same prefix is not inside');
  assert.equal(hit('read', { file_path: 'E:\\资料库\\a.md' }, {}, cfg, scout)?.rule, 'path-outside-workspace', 'members do not inherit the leader roots');
  assert.deepEqual([...c.paths.leaderReadRoots], [], 'nothing is granted by default');
  assert.throws(() => configWith({ paths: { leaderReadRoots: 'E:\\x' } }), e => e.code === 'BAD_CONFIG');
});
test('a user grant line opens exactly that file or folder, for the leader, read-only', () => {
  const userTexts = ['先看看需求', `可以。\n允许读取 ${GRANTED}\n其他的不要动`];
  assert.equal(hit('read', { file_path: `${GRANTED}\\正文.pdf` }, { userTexts }), undefined);
  assert.equal(hit('grep', { pattern: '甲方', path: GRANTED }, { userTexts }), undefined);
  assert.equal(hit('read', { file_path: 'E:\\lt-grant-fixture\\别的.txt' }, { userTexts })?.rule, 'path-outside-read-roots', 'the parent of a granted folder stays closed');
  assert.equal(hit('read', { file_path: `${GRANTED}-副本\\a.txt` }, { userTexts })?.rule, 'path-outside-read-roots');
  assert.equal(hit('read', { file_path: `${GRANTED}\\正文.pdf` }, { userTexts }, c, scout)?.rule, 'path-outside-workspace', 'a grant never applies to members');
  assert.equal(hit('read', { file_path: `${GRANTED}\\..\\..\\Windows\\win.ini` }, { userTexts })?.rule, 'path-outside-read-roots', '".." cannot climb out of a grant');
});
test('only an explicit line-initial grant counts', () => {
  const p = 'E:\\lt-grant-fixture\\x';
  const denied = texts => assert.equal(hit('read', { file_path: `${p}\\a.txt` }, { userTexts: texts })?.rule, 'path-outside-read-roots', JSON.stringify(texts));
  denied([`不允许读取 ${p}`]);
  denied([`我没说过允许读取 ${p}`]);
  denied([`文件在 ${p}，你先别读`]);
  denied([`do not allow read ${p}`]);
  denied(['允许读取 E:\\']);                 // a whole drive is not a limited grant
  denied(['允许读取 lt-grant-fixture\\x']);  // relative paths are ignored
  denied(['允许读取']);
  denied(undefined);
  for (const line of [`允许读取 ${p}`, `允许读取：${p}`, `  允许读取 "${p}"`, `允许读取 \`${p}\`。`, `Allow read: ${p}`, `allow read ${p.replace(/\\/g, '/')}`])
    assert.equal(hit('read', { file_path: `${p}\\a.txt` }, { userTexts: [`前言\n${line}\n后语`] }), undefined, line);
});
test('grants are read lazily: only when a leader read leaves the standing roots', () => {
  let calls = 0;
  const userTexts = () => { calls++; return [`允许读取 ${GRANTED}`]; };
  assert.equal(hit('read', { file_path: 'src/a.ts' }, { userTexts }), undefined);
  assert.equal(hit('todo_write', { todos: [] }, { userTexts }), undefined);
  assert.equal(calls, 0);
  assert.equal(hit('read', { file_path: `${GRANTED}\\a.txt` }, { userTexts }), undefined);
  assert.equal(calls, 1);
});
test('parseReadGrants: shape, limits and platform', () => {
  assert.deepEqual(parseReadGrants(['允许读取 D:\\a\\b\nallow read "D:/c d/e"', '允许读取 C:\\'], W), ['D:\\a\\b', 'D:\\c d\\e']);
  assert.deepEqual(parseReadGrants(['允许读取 /srv/docs/spec\n允许读取 /'], 'linux'), ['/srv/docs/spec']);
  assert.deepEqual(parseReadGrants(null, W), []);
  assert.equal(parseReadGrants([Array.from({ length: 200 }, (_, i) => `允许读取 D:\\g\\${i}`).join('\n')], W).length, 64);
  assert.deepEqual(parseReadGrants([`允许读取 D:\\${'x'.repeat(2000)}`], W), [], 'overlong lines are ignored');
});
