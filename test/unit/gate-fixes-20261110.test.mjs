// 2026-11-10 gate fixes: shell arguments reviewed in full, redaction never hides code,
// member search patterns stay relative, instruction-bearing paths are protected, gate.scope is "team" only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHardRules, buildGateRequest, patternEscapes, redactionHidesCode, GATE_SYSTEM } from '../../leaderteam/core/gate-policy.mjs';
import { inlineSecretMatches } from '../../leaderteam/core/redact.mjs';
import { defaultConfig, configWith } from './helpers.mjs';

const W = 'win32';
const c = defaultConfig();
const shell = { role: 'member', name: 'runner', profile: 'shell', allowedTools: c.profiles.shell.tools, writeScope: ['src/**'], unreadRefs: [], task: 'run the tests', acceptance: ['tests pass'] };
const coder = { role: 'member', name: 'coder', profile: 'code', allowedTools: c.profiles.code.tools, writeScope: ['**'], unreadRefs: [] };
const scout = { role: 'member', name: 'scout', profile: 'readonly', allowedTools: c.profiles.readonly.tools, writeScope: [], unreadRefs: [] };
const leader = { role: 'leader', name: 'leader', profile: 'leader', allowedTools: c.profiles.leader.tools, writeScope: [], unreadRefs: [] };
const rule = (tool, args, actor, config = c) => evaluateHardRules({ tool, args, actor, cwd: 'D:\\proj', platform: W }, config)?.rule;
const reviewed = (tool, args, actor) => JSON.parse(buildGateRequest({ tool, args, actor, cwd: 'D:\\proj', userTask: 'do it', platform: W }, c).user).operation;

test('F1: a shell command too long to review in full is denied before any model call', () => {
  const hidden = 'echo ' + 'a'.repeat(5000) + '; Remove-Item -Recurse -Force C:\\Users\\victim\\Documents; echo ' + 'b'.repeat(8000);
  assert.ok(hidden.length > c.gate.maxArgChars);
  assert.equal(rule('pwsh', { command: hidden, description: 'run tests' }, shell), 'shell-arguments-too-long');
  assert.equal(rule('bash', { command: hidden, description: 'run tests' }, shell), 'shell-arguments-too-long');
});
test('F1: a shell command that passes the size rule reaches the reviewer whole, middle included', () => {
  const command = 'echo ' + 'a'.repeat(5000) + '; Write-Output MIDDLE-MARKER; echo ' + 'b'.repeat(2000);
  assert.ok(command.length > c.gate.maxArgChars / 2, 'longer than the former per-string limit');
  assert.equal(rule('pwsh', { command, description: 'run tests' }, shell), undefined);
  const op = reviewed('pwsh', { command, description: 'run tests' }, shell);
  assert.equal(op.arguments_truncated, false);
  assert.ok(op.arguments_json.includes('MIDDLE-MARKER'));
});
test('F1: file content is not subject to the shell size rule; the reviewer is told how to treat truncation', () => {
  assert.equal(rule('write', { file_path: 'src/big.txt', content: 'x'.repeat(50000) }, coder), undefined);
  assert.equal(reviewed('write', { file_path: 'src/big.txt', content: 'x'.repeat(50000) }, coder).arguments_truncated, true);
  assert.match(GATE_SYSTEM, /arguments_truncated is true/);
  assert.match(GATE_SYSTEM, /DENY when a redacted value is itself run/);
});

const HIDES_CODE = [
  '$token=iex(gc(x.txt))',                       // PowerShell: expression after "="
  '$password=calc',                              // PowerShell: a bare word after "=" is a command
  '@{password=whoami}',                          // PowerShell hashtable value is a statement
  '$env:API_KEY=$(Get-Content k.txt)',
  'token=$(rm -rf src) ./run.sh',                // bash command substitution
  'secret=`id` ./run.sh',
  'python -c "token = f(); print(token)"',
  'mytool --password $(cat pw.txt)',
  'docker run -e POSTGRES_PASSWORD=dev postgres', // unquoted after "=": not provably inert
  'mytool --password=hunter2',
  'curl "https://example.com/cb?token=abc123"',
  'gh auth login --with-token < token.txt',       // the hidden text would be the redirection operator
];
const INERT = [
  ["docker run -e POSTGRES_PASSWORD='dev-pw-1' postgres", 'dev-pw-1'],
  ['$env:API_KEY="abc123"; npm test', 'abc123'],
  ['curl -H "Authorization: Bearer abc123" https://example.com/api', 'abc123'],
  ['mytool --password hunter2 --verbose', 'hunter2'],
  ['gh api --token $env:GH_TOKEN /user', '$env:GH_TOKEN'],
  ["mytool --password='hunter2'", 'hunter2'],
  ['ssh-tool --private-key C:\\keys\\id_ed25519 host', 'id_ed25519'],
];
test('F2: a shell argument whose redaction would hide executable text is denied', () => {
  for (const command of HIDES_CODE) {
    assert.equal(redactionHidesCode(command), true, command);
    assert.equal(rule('pwsh', { command, description: 'x' }, shell), 'shell-redaction-hides-code', command);
  }
  assert.equal(rule('pwsh', { command: 'npm test', description: 'set $token=calc first' }, shell), 'shell-redaction-hides-code', 'every string argument is checked');
});
test('F2: inert secret literals and simple variable references stay allowed and stay redacted for the reviewer', () => {
  for (const [command, secret] of INERT) {
    assert.equal(redactionHidesCode(command), false, command);
    assert.equal(rule('pwsh', { command, description: 'x' }, shell), undefined, command);
    const op = reviewed('pwsh', { command, description: 'x' }, shell);
    assert.ok(!op.arguments_json.includes(secret), `secret hidden from reviewer: ${command}`);
    assert.ok(op.arguments_json.includes('[REDACTED]'), command);
  }
  for (const command of ['npm test', 'git status', 'python -m pytest tests/test_tokens.py -k "max_tokens"', 'node build.mjs --tokenizer bert'])
    assert.equal(rule('pwsh', { command, description: 'x' }, shell), undefined, command);
});
test('F2: the deny reason never repeats the hidden value', () => {
  const hit = evaluateHardRules({ tool: 'pwsh', args: { command: '$token=Invoke-SecretThing', description: 'x' }, actor: shell, cwd: 'D:\\proj', platform: W }, c);
  assert.equal(hit.rule, 'shell-redaction-hides-code');
  assert.ok(!hit.reason.includes('Invoke-SecretThing'));
  assert.deepEqual(inlineSecretMatches('a --token x b password="y"'), [{ form: 'assign', separator: '=', quoted: true, value: 'y' }, { form: 'flag', separator: ' ', quoted: false, value: 'x' }]);
});

test('F4: member search patterns must be relative (no absolute path, no "..", also inside alternatives)', () => {
  for (const pattern of ['C:/Users/**/*.pem', 'c:\\Users\\*', '/etc/**', '\\\\server\\share\\*', '~/.ssh/*', '../../**/.env', 'src/../../x', '..', '{..,src}/**', '{src,/etc}/**', '{src,D:/x}/**', '@(..)/x', '@(src|..)/x'])
    assert.equal(rule('glob', { pattern }, scout), 'pattern-outside-workspace', pattern);
  assert.equal(rule('grep', { pattern: 'password', glob: '../../**' }, scout), 'pattern-outside-workspace');
  assert.equal(rule('grep', { pattern: 'password', include: '..\\secrets\\*' }, scout), 'pattern-outside-workspace');
  assert.equal(rule('glob', { pattern: ['a'] }, scout), 'pattern-invalid');
  assert.equal(patternEscapes('src/**/*.{js,ts}'), false);
});
test('F4: ordinary patterns, regex text and the existing path rule are unchanged', () => {
  for (const pattern of ['**/*.md', 'src/**/*.{js,ts}', 'a..b/*.txt', '.../x', 'docs/..hidden/*', '*.c'])
    assert.equal(rule('glob', { pattern }, scout), undefined, pattern);
  assert.equal(rule('grep', { pattern: '\\.\\./|C:/Users|~/', path: 'src' }, scout), undefined, 'grep "pattern" is a regular expression, not a file pattern');
  assert.equal(rule('grep', { pattern: 'x', glob: '*.{js,ts}' }, scout), undefined);
  assert.equal(rule('glob', { pattern: '**/*', path: 'C:/Users' }, scout), 'path-outside-workspace');
  assert.equal(rule('glob', { pattern: '../**' }, leader), 'pattern-outside-workspace', 'the leader is bound by the same pattern rule');
});

test('F5: version control data, agent skills and the root instruction file are protected by default', () => {
  assert.deepEqual([...c.paths.protectedDirs], ['.leaderteam', '.git', '.agents', 'AGENTS.md']);
  for (const file_path of ['.git/hooks/pre-commit', '.git\\config', '.agents/skills/evil/SKILL.md', 'AGENTS.md', 'agents.md', '.leaderteam/refs/INDEX.md'])
    for (const tool of ['write', 'edit']) assert.equal(rule(tool, { file_path }, coder), 'path-protected', `${tool} ${file_path}`);
  for (const file_path of ['src/a.txt', '.gitignore', 'docs/AGENTS-notes.md', '.github/workflows/ci.yml'])
    assert.equal(rule('write', { file_path }, coder), undefined, file_path);
});

test('M6: gate.scope "all" is rejected at load time; "team" is the only mode', () => {
  assert.equal(c.gate.scope, 'team');
  assert.throws(() => configWith({ gate: { scope: 'all' } }), e => e.code === 'BAD_CONFIG' && /"all" is not supported/.test(e.message));
  assert.throws(() => configWith({ gate: { scope: 'everything' } }), e => e.code === 'BAD_CONFIG' && /gate\.scope must be "team"/.test(e.message));
});
