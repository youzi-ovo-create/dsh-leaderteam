import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

globalThis[Symbol.for('leaderteam.hostImports.v1')] = {
  pluginRoot: path.join(ROOT, 'leaderteam'),
  moduleRoot: ROOT,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-v222:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v222:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.5' }) };
    }
    if (url === 'virtual-v222:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class ToolExecutionPipeline {
            resolveExecution(name, agent, hasParent, toolSet) { return null; }
            async dispatchToolBody(exec) {
              const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
              return await tool.execute(exec.arguments, exec);
            }
          }
        `,
      };
    }
    if (url === 'virtual-v222:@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const TOOL_ABORTED_BEFORE_DISPATCH = 'aborted';
          export function defineTool(def) { return def; }
          export class ToolsService {
            view() { return []; }
            resolve(agent) { const admitted = this.view(agent); return admitted; }
            definitions() { return []; }
            get() { return null; }
            executable() { return null; }
          }
        `,
      };
    }
    if (url === 'virtual-v222:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class BlockAssembler {}
          export function createUserMessage(t) { return { text: t }; }
          export function createToolResultMessage(r) { return r; }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { loadConfig, validateConfig } = await import('../../leaderteam/core/config.mjs');
const { configWith, defaultConfig } = await import('./helpers.mjs');
const {
  evaluateHardRules,
  classifySandboxBoundary,
  evaluateDirectExecSafetyGate,
  findProtectedWriteScopeOverlap,
  scanPosixShell,
  redactionHidesCode,
} = await import('../../leaderteam/core/gate-policy.mjs');
const { redactInlineSecrets, inlineSecretMatches, sanitizeArguments, REDACTED } = await import('../../leaderteam/core/redact.mjs');
const { parseQuotaState, routeQuota5hWindow } = await import('../../leaderteam/core/quota.mjs');
const { normalizeReview } = await import('../../leaderteam/core/review-policy.mjs');
const { PlanArchiveStore } = await import('../../leaderteam/core/plan-archive.mjs');
const {
  createInitialTimerState,
  normalizeTimerState,
  recordTimerPlanSettled,
} = await import('../../leaderteam/core/timer.mjs');
const { generateRedactedBugReport, redactDiagnosticText } = await import('../../bin/lt-bugreport.mjs');
const { runtime, bindRuntimeConfigFile, teamStore, requestWindowCallsPath } = await import('../../leaderteam/host/runtime.mjs');
const { onSessionEvent } = await import('../../leaderteam/host/roles.mjs');
const {
  summarizeTeamUsage,
  teamObservability,
  MAX_CACHED_SESSIONS,
  _observabilityCacheSizeForTest,
} = await import('../../leaderteam/host/observability.mjs');
const { resumeAdmission } = await import('../../leaderteam/host/activation.mjs');
const { registerTeamTools } = await import('../../leaderteam/host/team-tools.mjs');
const entryLead = await import('../../leaderteam/entry-lead.mjs');
const entryCore = await import('../../leaderteam/entry-core.mjs');
const { zstdFrames } = await import('../../scripts/dev/lib/session-rows.mjs');
const { parseCliArgs: parseConfigureCliArgs } = await import('../../scripts/configure-models.mjs');
const { parseHeadlessCliArgs } = await import('../../scripts/headless-run.mjs');
const { runPlanArchiveCli } = await import('../../scripts/plan-archive.mjs');
const { loadBoundedWorkspaceExcerpts, respondInFormalConference } = await import('../../leaderteam/host/governance.mjs');

function makeTempDir(t, suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-s2-core-${suffix}`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('ISS-000: core and web manifests match the root package version', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const corePkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'leaderteam', 'package.json'), 'utf8'));
  const webPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'lt-web', 'package.json'), 'utf8'));
  assert.equal(corePkg.version, rootPkg.version);
  assert.equal(webPkg.version, rootPkg.version);
});

test('CH-01 (P0): pipe-to-interpreter, herestrings (<<<), and process substitutions cannot bypass safety gate or direct_exec lock', () => {
  const cfg = loadConfig(path.join(ROOT, 'config', 'leaderteam.config.json'), { includeLocal: false });
  const ws = '/tmp/lt-s2-core-ws';
  const member = {
    role: 'member',
    name: 'worker',
    profile: 'shell',
    allowedTools: ['read', 'write', 'edit', 'bash'],
    loadedTools: ['read', 'write', 'edit', 'bash'],
    writeScope: ['src/**'],
    unreadRefs: [],
  };
  const direct = { ...member, role: 'direct_exec' };

  const pipeAndHerestringEscapes = [
    'printf "%s\\n" "cd /tmp && pwd" | bash',
    'echo "cd /tmp && ls" | sh',
    'echo "import os; print(os.listdir(\'/tmp\'))" | python3',
    'echo "console.log(process.cwd())" | node',
    'echo "print(1)" | env /usr/bin/python3',
    'node <<< "console.log(process.cwd())"',
    'python3 <<< "import os; print(os.getcwd())"',
    'bash <<< "cd /tmp && pwd"',
    'diff <(cat src/a.js) <(cat src/b.js)',
    'bash <(echo "pwd")',
  ];

  for (const command of pipeAndHerestringEscapes) {
    const sb = classifySandboxBoundary({ tool: 'bash', args: { command }, actor: member, cwd: ws, platform: 'linux' }, cfg);
    assert.equal(sb.confined, false, `must not classify as confined sandbox command: ${command}`);

    const dg = evaluateDirectExecSafetyGate({ tool: 'bash', args: { command }, actor: direct, cwd: ws, platform: 'linux' }, cfg);
    assert.equal(dg.decision, 'deny', `direct_exec safety gate must deny: ${command}`);

    const dh = evaluateHardRules({ tool: 'bash', args: { command }, actor: direct, cwd: ws, platform: 'linux' }, cfg);
    assert.ok(dh, `direct_exec hard rules must reject: ${command}`);
  }

  // Deterministic hard-rule blocks when echo/printf pipe or herestring feeds an escape into bash/sh
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'printf "%s\\n" "cd /tmp && pwd" | bash' }, actor: member, cwd: ws, platform: 'linux' }, cfg)?.rule,
    'path-outside-workspace',
  );
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'bash <<< "cd /tmp && pwd"' }, actor: member, cwd: ws, platform: 'linux' }, cfg)?.rule,
    'path-outside-workspace',
  );

  // Legitimate workspace commands (including text filter pipes) remain confined & allowed
  for (const okCommand of [
    'npm test',
    'git status | head -n 5',
    '/usr/bin/python3 -m unittest discover -s src',
    'node src/index.mjs',
  ]) {
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: okCommand }, actor: member, cwd: ws, platform: 'linux' }, cfg), undefined);
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: okCommand }, actor: member, cwd: ws, platform: 'linux' }, cfg).confined, true, okCommand);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: okCommand }, actor: direct, cwd: ws, platform: 'linux' }, cfg).decision, 'allow', okCommand);
  }
});

test('CH-02 (P0): POSIX attached short-option paths (-C/path, -o/path, -f/path, -I/path, -C../out) are enforced without misparsing -O2 or -n10', () => {
  const cfg = loadConfig(path.join(ROOT, 'config', 'leaderteam.config.json'), { includeLocal: false });
  const ws = '/tmp/lt-s2-core-ws';
  const member = {
    role: 'member',
    name: 'worker',
    profile: 'shell',
    allowedTools: ['bash'],
    loadedTools: ['bash'],
    writeScope: ['src/**'],
    unreadRefs: [],
  };
  const direct = { ...member, role: 'direct_exec' };

  for (const cmd of [
    'tar -C/tmp/lt-s2-core-out -xf archive.tar',
    'git -C/etc status',
    'gcc -o/tmp/out.bin src/main.c',
    'grep -f/etc/hosts root src',
    'gcc -I/usr/include src/main.c -o src/main.o',
    'make -C../outside',
    'tar -C~/outside -xf archive.tar',
    'tar -xzf/tmp/archive.tar',
    'git -C/nonexistent-external-dir status',
  ]) {
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: cmd }, actor: member, cwd: ws, platform: 'linux' }, cfg).confined, false, `attached option must not be confined: ${cmd}`);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: cmd }, actor: direct, cwd: ws, platform: 'linux' }, cfg).decision, 'deny', `direct_exec must deny attached option: ${cmd}`);
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: cmd }, actor: direct, cwd: ws, platform: 'linux' }, cfg)?.rule, 'direct-exec-sandbox-lock', cmd);
  }

  // Hard rules also catch attached `-t/tmp` on `ln`, `env -C/tmp`, and substitutions with `-C/etc`
  assert.ok(evaluateHardRules({ tool: 'bash', args: { command: 'ln -s -t/tmp src/a.js' }, actor: member, cwd: ws, platform: 'linux' }, cfg));
  assert.ok(evaluateHardRules({ tool: 'bash', args: { command: 'env -C/tmp pwd' }, actor: member, cwd: ws, platform: 'linux' }, cfg));
  assert.ok(evaluateHardRules({ tool: 'bash', args: { command: 'echo $(git -C/etc rev-parse HEAD)' }, actor: member, cwd: ws, platform: 'linux' }, cfg));

  // Non-path flags (-O2, -n10, -j4, -Wall, -osrc/out.bin inside workspace) stay confined!
  for (const safeCmd of [
    'gcc -O2 -Wall src/main.c -osrc/out.bin',
    'head -n10 src/main.c',
    'make -j4 test',
    "sed -i.bak 's/foo/bar/' src/main.c",
  ]) {
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: safeCmd }, actor: member, cwd: ws, platform: 'linux' }, cfg), undefined, safeCmd);
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: safeCmd }, actor: member, cwd: ws, platform: 'linux' }, cfg).confined, true, safeCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: safeCmd }, actor: direct, cwd: ws, platform: 'linux' }, cfg).decision, 'allow', safeCmd);
  }
});

test('CH-03 (P0): blocks glob-prefixed write_scope (.git*, *.md), shell wildcards (.gi?), custom protectedDirs, and outside-writeScope shell mutations', async t => {
  const customCfg = configWith({
    paths: {
      protectedDirs: ['.leaderteam', '.git', '.agents', 'AGENTS.md', '.github'],
    },
  });
  const ws = makeTempDir(t, 'ch03-ws-');
  const posixWs = ws.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
  fs.mkdirSync(path.join(ws, 'mod_a'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'mod_b'), { recursive: true });

  // 1. Glob-prefixed `write_scope` overlap detection in `gate-policy.mjs` & `host/team-tools.mjs`
  for (const badGlob of ['.git/**', '.git*', '.gi?/**', '*.md', '**/*.md', 'AGENT*.md', '.github*', '.*']) {
    assert.ok(findProtectedWriteScopeOverlap(badGlob, customCfg.paths.protectedDirs, 'linux'), `must flag protected overlap: ${badGlob}`);
    const hr = evaluateHardRules({
      tool: 'team_direct_exec',
      args: { task: 'modify files', write_scope: [badGlob] },
      actor: { role: 'leader', allowedTools: ['team_direct_exec'] },
      cwd: posixWs,
      platform: 'linux',
    }, customCfg);
    assert.equal(hr?.rule, 'path-protected', `evaluateHardRules must block write_scope ${badGlob}`);
  }
  for (const okGlob of ['src/**', 'mod_a/**', '*.js', '**/*.ts']) {
    assert.equal(findProtectedWriteScopeOverlap(okGlob, customCfg.paths.protectedDirs, 'linux'), null, `legitimate glob allowed: ${okGlob}`);
  }

  // Verify `team-tools.mjs` (`team_direct_exec` & `team_dispatch`) also rejects `.git*` and `*.md`
  const storeRoot = makeTempDir(t, 'ch03-store-');
  const rt = runtime();
  const prevRt = { config: rt.config, storageRoot: rt.storageRoot, llm: rt.llm };
  t.after(() => {
    rt.config = prevRt.config;
    rt.storageRoot = prevRt.storageRoot;
    rt.llm = prevRt.llm;
    rt.actors.delete('leader-ch03');
  });
  const autoCfg = configWith({
    storage: { root: storeRoot },
    governance: { mode: 'autonomous' },
    team: { leaderModelPolicy: 'off' },
    paths: { protectedDirs: ['.leaderteam', '.git', '.agents', 'AGENTS.md', '.github'] },
  });
  rt.config = autoCfg;
  rt.storageRoot = storeRoot;
  rt.llm = {};
  const st = teamStore('leader-ch03');
  st.ensure({ workspace: ws, surface: 'headless' });
  const leaderAgent = { id: 'leader-ch03', session: { id: 'leader-ch03', header: { cwd: ws }, snapshotEvents: () => [] } };
  rt.actors.set('leader-ch03', { role: 'leader', teamId: 'leader-ch03', cwd: ws, agent: leaderAgent });
  const registeredTools = new Map();
  registerTeamTools({
    tools: { register: def => registeredTools.set(def.name, def) },
    effect: fn => fn(),
    get: () => null,
  });
  await assert.rejects(
    () => registeredTools.get('team_direct_exec').execute({ task: 'touch git', write_scope: ['.git*'] }, { agent: leaderAgent }),
    /targets protected path "\.git"/,
  );
  await assert.rejects(
    () => registeredTools.get('team_direct_exec').execute({ task: 'touch md', write_scope: ['*.md'] }, { agent: leaderAgent }),
    /targets protected path "AGENTS\.md"/,
  );
  await assert.rejects(
    () => registeredTools.get('team_dispatch').execute({
      name: 'w-bad',
      task: 'touch md',
      acceptance: ['ok'],
      model: 'zcode/GLM-5.3',
      effort: 'high',
      profile: 'code',
      tools: ['read', 'write'],
      write_scope: ['.git*'],
    }, { agent: leaderAgent }),
    /targets protected path "\.git"/,
  );

  // 2. Shell wildcards (`.gi?`), custom `protectedDirs` (`.github`), and outside-`writeScope` redirections/mutations
  const memberA = {
    role: 'member',
    name: 'worker-a',
    profile: 'shell',
    allowedTools: ['bash'],
    loadedTools: ['bash'],
    writeScope: ['mod_a/**'],
    unreadRefs: [],
  };
  const directA = { ...memberA, role: 'direct_exec' };

  for (const protCmd of [
    'cp mod_a/a.js .gi?/hooks/sample',
    'cp mod_a/a.js .github/workflows/ci.yml',
    'cp mod_a/a.js AGENT?.md',
  ]) {
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: protCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg).confined, false, protCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: protCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg).decision, 'deny', protCmd);
  }
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'echo x > .gi?/hooks/pre-commit' }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg)?.rule,
    'path-protected',
  );
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'echo x > .github/workflows/ci.yml' }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg)?.rule,
    'path-protected',
  );

  // Redirection outside `actor.writeScope` -> `path-outside-write-scope` in `evaluateHardRules`!
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'echo changed > mod_b/b.js' }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg)?.rule,
    'path-outside-write-scope',
  );
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'echo appended >> mod_b/b.js' }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg)?.rule,
    'path-outside-write-scope',
  );
  assert.equal(
    evaluateHardRules({ tool: 'bash', args: { command: 'echo ok > mod_a/a.js' }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg),
    undefined,
  );

  // Mutating shell commands (`cp`, `mv`, `tee`, `sed -i`, `install`, `patch`) outside vs inside `writeScope`
  for (const outMutCmd of [
    'cp mod_a/a.js mod_b/b.js',
    'mv mod_a/a.js mod_b/b.js',
    'echo x | tee mod_b/b.js',
    "sed -i 's/a/b/' mod_b/b.js",
    'install mod_a/a.js mod_b/b.js',
    'patch mod_b/b.js mod_a/fix.patch',
    'patch -p1 < mod_a/fix.patch',
  ]) {
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: outMutCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg).confined, false, outMutCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: outMutCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg).decision, 'deny', outMutCmd);
  }

  for (const inMutCmd of [
    'cp mod_a/a.js mod_a/copy.js',
    'mv mod_a/copy.js mod_a/renamed.js',
    'echo x | tee mod_a/log.txt',
    "sed -i 's/a/b/' mod_a/a.js",
    'install mod_a/a.js mod_a/bin.js',
    'patch mod_a/a.js mod_a/fix.patch',
  ]) {
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: inMutCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg).confined, true, inMutCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: inMutCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg).decision, 'allow', inMutCmd);
  }
});

test('CH-04 (P1): redacts JSON secrets, quoted Bearer headers, standalone tokens, and unquoted /etc & /run paths without over-redacting author/maxAuthorizationChars', () => {
  const jsonPayload = '{"apiKey":"custom-gw-key-9876","password":"MyUnitTestPass!2026"}';
  const redactedJson = redactInlineSecrets(jsonPayload);
  assert.equal(redactedJson.includes('custom-gw-key-9876'), false);
  assert.equal(redactedJson.includes('MyUnitTestPass!2026'), false);
  assert.equal(redactedJson, `{"apiKey":"${REDACTED}","password":"${REDACTED}"}`);

  const quotedBearer = 'Authorization="Bearer custom-bearer-tok-9876"';
  const redactedQuotedBearer = redactInlineSecrets(quotedBearer);
  assert.equal(redactedQuotedBearer.includes('custom-bearer-tok-9876'), false);
  assert.equal(redactedQuotedBearer, `Authorization="Bearer ${REDACTED}"`);

  const standaloneTokens = 'Bearer standalone-tok-12345 sk-proj-abcdef123456 ghp_1234567890abcdef eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const redactedStandalone = redactInlineSecrets(standaloneTokens);
  for (const secret of ['standalone-tok-12345', 'sk-proj-abcdef123456', 'ghp_1234567890abcdef', 'eyJzdWIiOiIxMjM0NTYifQ']) {
    assert.equal(redactedStandalone.includes(secret), false, `expected "${secret}" to be redacted`);
  }

  // `author` and `maxAuthorizationChars` are preserved while `auth`, `authorization`, `apiKey` are redacted
  const sanitized = sanitizeArguments({
    author: 'Ada Lovelace',
    maxAuthorizationChars: 4000,
    maxTokens: 16384,
    auth: 'Bearer secret-xyz',
    authorization: 'Basic YWRtaW46cGFzcw==',
    apiKey: 'sk-secret-999',
  });
  assert.equal(sanitized.author, 'Ada Lovelace');
  assert.equal(sanitized.maxAuthorizationChars, 4000);
  assert.equal(sanitized.maxTokens, 16384);
  assert.equal(sanitized.auth, REDACTED);
  assert.equal(sanitized.authorization, REDACTED);
  assert.equal(sanitized.apiKey, REDACTED);

  // `lt-bugreport` `redactDiagnosticText` scrubs JSON secrets AND unquoted `/etc/...` + `/run/...`
  const diag = redactDiagnosticText(
    'Config parse error: {"apiKey":"custom-gw-key-9876","password":"MyUnitTestPass!2026"} while reading /etc/corp-gateway/auth.conf and /run/secrets/gw_token',
    { username: 'devuser', hostname: 'devbox' },
  );
  for (const leak of ['custom-gw-key-9876', 'MyUnitTestPass!2026', '/etc/corp-gateway', 'auth.conf', '/run/secrets', 'gw_token']) {
    assert.equal(diag.includes(leak), false, `redactDiagnosticText leaked "${leak}": ${diag}`);
  }
});

test('CH-05 (P1): lt-bugreport folds native session.v4.jsonl.zstd 4-bucket usage (including encodeSegment & compaction/summary) and merges leaderteam.local.json', t => {
  const dshHome = makeTempDir(t, 'ch05-home-');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const teamId = 'team:01'; // tests `safeId` in teams/ and `encodeSegment` (`team~003A01`) in sessions/
  const teamDir = path.join(storageRoot, 'teams', 'team_01');
  fs.mkdirSync(teamDir, { recursive: true });

  // Config + local override (`governance.mode: "approval"`, `powerMonitor.enabled: false`)
  const cfgDir = path.join(storageRoot, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', 'leaderteam.config.json'), path.join(cfgDir, 'leaderteam.config.json'));
  fs.writeFileSync(
    path.join(cfgDir, 'leaderteam.local.json'),
    JSON.stringify({ governance: { mode: 'approval' }, powerMonitor: { enabled: false } }, null, 2),
    'utf8',
  );

  fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify({ v: 1, teamId, createdAt: '2026-11-25T12:00:00Z' }), 'utf8');
  fs.writeFileSync(
    path.join(teamDir, 'members.jsonl'),
    [
      JSON.stringify({ v: 1, type: 'member', childId: 'mem-1', name: 'worker-1', status: 'done' }),
      JSON.stringify({ v: 1, type: 'member', childId: 'dir-1', name: 'direct-exec-1', actorRole: 'direct_exec', status: 'done' }),
    ].join('\n') + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(teamDir, 'usage.jsonl'),
    JSON.stringify({ role: 'gate', usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, totalTokens: 120 } }) + '\n',
    'utf8',
  );

  const writeSessionZstd = (bucket, dirSeg, rows) => {
    const dir = path.join(dshHome, 'sessions', bucket, dirSeg);
    fs.mkdirSync(dir, { recursive: true });
    const frames = rows.map(r => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  };

  // Leader encoded dir `team~003A01`: 1 assistant/message (duplicated stream row must dedupe!) + 1 compaction/summary + 1 seed row (ignored)
  const secretPrompt = 'PROPRIETARY_LEADER_PROMPT_DO_NOT_LEAK_7788';
  writeSessionZstd('ws-bucket', 'team~003A01', [
    { type: 'assistant/message', surfaceOp: 'seed', data: { message: { id: 'seed-1', content: secretPrompt }, usage: { inputTokens: 99999, outputTokens: 1, totalTokens: 100000 } } },
    { type: 'assistant/message', seq: 1, data: { message: { id: 'msg-L1', content: secretPrompt }, usage: { inputTokens: 2000, cacheReadTokens: 5000, cacheWriteTokens: 500, outputTokens: 300, totalTokens: 7800 } } },
    { type: 'assistant/message', seq: 2, data: { message: { id: 'msg-L1', content: secretPrompt }, usage: { inputTokens: 2000, cacheReadTokens: 5000, cacheWriteTokens: 500, outputTokens: 300, totalTokens: 7800 } } },
    { type: 'compaction/summary', seq: 3, data: { compactionId: 'comp-L1', summary: secretPrompt, model: 'zcode/GLM-5.3-Flash', usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200, totalTokens: 1200 } } },
    { type: 'compaction/summary', seq: 4, data: { compactionId: 'comp-L1', summary: secretPrompt, model: 'zcode/GLM-5.3-Flash', usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200, totalTokens: 1200 } } },
  ]);
  writeSessionZstd('ws-bucket', 'mem-1', [
    { type: 'assistant/message', seq: 1, data: { message: { id: 'msg-M1', content: secretPrompt }, usage: { inputTokens: 5000, cacheReadTokens: 10000, cacheWriteTokens: 2000, outputTokens: 500, totalTokens: 17500 } } },
  ]);
  writeSessionZstd('ws-bucket', 'dir-1', [
    { type: 'assistant/message', seq: 1, data: { message: { id: 'msg-D1', content: secretPrompt }, usage: { inputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 50, totalTokens: 550 } } },
  ]);

  const report = generateRedactedBugReport({ dshHome, storageRoot, hostname: 'host-x', username: 'user-x' });
  assert.equal(report.config.governanceMode, 'approval');
  assert.equal(report.config.powerMonitorEnabled, false);
  assert.deepEqual(report.metrics.usageByRole.leader, {
    calls: 2,
    inputTokens: 3000,
    cacheReadTokens: 5000,
    cacheWriteTokens: 500,
    outputTokens: 500,
    totalTokens: 9000,
  });
  assert.deepEqual(report.metrics.usageByRole.member, {
    calls: 1,
    inputTokens: 5000,
    cacheReadTokens: 10000,
    cacheWriteTokens: 2000,
    outputTokens: 500,
    totalTokens: 17500,
  });
  assert.deepEqual(report.metrics.usageByRole.directExec, {
    calls: 1,
    inputTokens: 400,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    outputTokens: 50,
    totalTokens: 550,
  });
  assert.equal(report.metrics.usageTotal.totalTokens, 9000 + 17500 + 550 + 120);
  assert.equal(JSON.stringify(report).includes(secretPrompt), false);
});

test('CH-06 & CH-07 (P1): roles.mjs & observability.mjs handle DSH 0.2.2-rc.5 assistant/message.source and compaction/summary accurately', t => {
  const tmp = makeTempDir(t, 'ch06-07-');
  const storageRoot = path.join(tmp, 'leaderteam');
  const cfg = configWith({
    storage: { root: storageRoot },
    models: {
      'deepseek/deepseek-v4-pro': {
        family: 'deepseek',
        label: 'DeepSeek V4 Pro',
        provider: 'deepseek',
        upstreamModel: 'deepseek-v4-pro',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    },
  });

  const rt = runtime();
  const prev = { config: rt.config, storageRoot: rt.storageRoot };
  t.after(() => {
    rt.config = prev.config;
    rt.storageRoot = prev.storageRoot;
    rt.actors.delete('team-ch06');
    rt.actors.delete('sub-ch06');
  });
  rt.config = cfg;
  rt.storageRoot = storageRoot;

  const st = teamStore('team-ch06');
  st.ensure({ workspace: tmp, surface: 'headless' });
  st.addMember({
    childId: 'sub-ch06',
    name: 'worker',
    profile: 'code',
    model: 'zcode/GLM-5.3',
    effort: 'high',
    status: 'running',
  });

  const leaderSession = {
    id: 'team-ch06',
    snapshotEvents: () => [
      {
        type: 'assistant/message',
        seq: 1,
        data: {
          message: { id: 'm-lead-1', source: { provider: 'magpie', model: 'codex/gpt-6.1-terra' } },
          usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200, totalTokens: 1200 },
        },
      },
      {
        type: 'compaction/summary',
        seq: 2,
        data: {
          compactionId: 'c-lead-1',
          provider: 'magpie',
          model: 'zcode/GLM-5.3-Flash',
          usage: { inputTokens: 8000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, totalTokens: 8500 },
        },
      },
    ],
  };
  const subSession = {
    id: 'sub-ch06',
    header: { origin: 'subagent', parentSession: 'team-ch06' },
    snapshotEvents: () => [],
  };

  rt.actors.set('team-ch06', {
    role: 'leader',
    teamId: 'team-ch06',
    agent: { id: 'team-ch06', session: leaderSession, model: { current: () => ({ provider: 'magpie', model: 'codex/gpt-6.1-terra' }) } },
  });
  rt.actors.set('sub-ch06', {
    role: 'member',
    teamId: 'team-ch06',
    agentId: 'sub-ch06',
    agent: { id: 'sub-ch06', session: subSession },
  });

  // 1. Subagent emits DSH 0.2.2-rc.5 `assistant/message` with `data.message.source` overriding configured `zcode/GLM-5.3`
  onSessionEvent({}, subSession, {
    type: 'assistant/message',
    time: 1700000001000,
    data: {
      message: { id: 'sub-msg-1', role: 'assistant', source: { provider: 'deepseek', model: 'deepseek-v4-pro' } },
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
  });
  // 2. Leader emits `compaction/summary` with top-level `data.provider` / `data.model`
  onSessionEvent({}, leaderSession, {
    type: 'compaction/summary',
    time: 1700000002000,
    data: {
      compactionId: 'c-lead-1',
      provider: 'magpie',
      model: 'zcode/GLM-5.3-Flash',
      usage: { inputTokens: 8000, outputTokens: 500, totalTokens: 8500 },
    },
  });

  const rwRecords = fs.readFileSync(requestWindowCallsPath(storageRoot), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rwRecords.length, 2);
  assert.equal(rwRecords[0].role, 'member');
  assert.equal(rwRecords[0].route, 'deepseek/deepseek-v4-pro');
  assert.equal(rwRecords[0].provider, 'deepseek');
  assert.equal(rwRecords[1].role, 'leader');
  assert.equal(rwRecords[1].route, 'zcode/GLM-5.3-Flash');
  assert.equal(rwRecords[1].provider, 'zcode');

  // 3. `teamObservability` & `summarizeTeamUsage` attribute compaction tokens to `zcode/GLM-5.3-Flash` (never `"unknown"`)
  const obs = teamObservability({}, rt, 'team-ch06');
  const leaderRoleObs = obs.roles.find(r => r.role === 'leader');
  assert.deepEqual(leaderRoleObs.actualRoutes, ['codex/gpt-6.1-terra', 'zcode/GLM-5.3-Flash']);
  assert.equal(leaderRoleObs.calls, 2);
  assert.equal(leaderRoleObs.tokens.totalTokens, 9700);
  assert.equal(obs.usage.byModel['codex/gpt-6.1-terra'].totalTokens, 1200);
  assert.equal(obs.usage.byModel['zcode/GLM-5.3-Flash'].totalTokens, 8500);
  assert.equal(obs.usage.byModel.unknown, undefined);
});

test('CH-08 (P1): routeQuota5hWindow matches vendor-prefixed 5h windows ("Claude & GPT · 5 hours") while rejecting 15h / 25h / 1.5h / 7d', () => {
  const cfg = defaultConfig();
  const now = new Date('2026-11-25T18:00:00Z');
  const state = parseQuotaState({
    schema_version: 1,
    generated_at: '2026-11-25T17:59:30Z',
    accounts: [
      {
        id: 'codex-acct-1',
        provider: 'codex',
        windows: [
          { name: 'Claude & GPT · 7 days', remaining: 85, resetsAt: '2026-11-30T00:00:00Z' },
          { name: 'Claude & GPT · 5 hours', remaining: 0, resetsAt: '2026-11-25T21:00:00Z' },
        ],
      },
      {
        id: 'other-acct',
        provider: 'zcode',
        windows: [
          { name: 'Rolling 15 hours', remaining: 0 },
          { name: 'Burst 25h', remaining: 0 },
          { name: 'Short 1.5 hours', remaining: 0 },
        ],
      },
    ],
  });

  const gpt5h = routeQuota5hWindow(state, 'codex/gpt-6.1-terra', cfg.models['codex/gpt-6.1-terra'], cfg.quota, now);
  assert.equal(gpt5h.status, 'exhausted');
  assert.equal(gpt5h.bestRemainingPct, 0);
  assert.equal(gpt5h.bestAccount, 'codex-acct-1');

  const non5h = routeQuota5hWindow(state, 'zcode/GLM-5.3', { family: 'glm' }, cfg.quota, now);
  assert.equal(non5h.status, 'unknown');
  assert.match(non5h.reason, /no 5-hour quota window/);
});

test('CH-09 (P1): normalizeReview preserves explicit terminal stance="reject" on revisions when prior items are resolved', () => {
  const previousItems = [
    { id: 'c1', problem: 'Minor naming typo', evidence: 'line 4', suggestion: 'Rename var', hard_blocker: false, category: 'ordinary' },
  ];
  const rejectedRevision = normalizeReview({
    stance: 'reject',
    summary: 'Fundamentally unsafe architecture',
    reasons: ['Introduces unauthenticated RCE endpoint'],
    suggestions: ['Abort this approach'],
    changeItems: [],
    resolutions: [{ id: 'c1', status: 'resolved', evidence: 'Renamed variable' }],
  }, { previousItems });
  assert.equal(rejectedRevision.stance, 'reject');

  const resolvedRevise = normalizeReview({
    stance: 'revise',
    summary: 'Prior issue fixed, only minor polish note',
    reasons: ['Looks clean'],
    suggestions: ['Add JSDoc'],
    changeItems: [{ id: 'c2', problem: 'Add JSDoc', evidence: 'fn foo', suggestion: 'Document foo', hard_blocker: false, category: 'ordinary' }],
    resolutions: [{ id: 'c1', status: 'resolved', evidence: 'Renamed variable' }],
  }, { previousItems });
  assert.equal(resolvedRevise.stance, 'approve');
});

test('CH-10 (P1): PlanArchiveStore.clean rejects negative/non-numeric olderThanDays and confirm:false on destructive runs', t => {
  const archiveRoot = makeTempDir(t, 'ch10-archive-');
  const archive = new PlanArchiveStore(archiveRoot);
  archive.savePlan({
    v: 1,
    planId: 'plan-keep-1',
    agreementId: 'plan-keep-1',
    projectKey: 'proj-1',
    workspace: '/tmp/proj',
    teamId: 'team-1',
    taskSeq: 1,
    category: 'feature',
    lifecycleState: 'open',
    topic: 'Important plan',
    proposal: 'Step 1',
    createdAt: new Date(1700000000000).toISOString(),
    createdAtMs: 1700000000000,
    updatedAt: new Date(1700000000000).toISOString(),
    execution: { members: [], deliveryAgreements: [], retrospectiveIds: [] },
  }, { appendIndex: true });

  for (const badDays of [-1, -0.5, Number.NaN, '30', {}]) {
    assert.throws(
      () => archive.clean({ olderThanDays: badDays, all: false, dryRun: false, nowMs: 1700500000000 }),
      err => err?.code === 'PLAN_ARCHIVE_CLEAN',
      `expected PLAN_ARCHIVE_CLEAN error for olderThanDays=${String(badDays)}`,
    );
  }
  assert.throws(
    () => archive.clean({ all: true, dryRun: false, confirm: false }),
    err => err?.code === 'PLAN_ARCHIVE_CLEAN' && err.message === 'Destructive plan archive clean requires confirm: true',
  );
  assert.equal(archive.listPlans().length, 1, 'archived plan must remain intact');
});

test('CH-11 (P1): entry-lead.mjs reassigns rt.subagents to remaining active session when a newer session disposes', () => {
  const rt = runtime();
  const prevSubagents = rt.subagents;
  const refsSym = Symbol.for('leaderteam.subagentsRefs.v1');
  const prevRefs = rt[refsSym];
  try {
    rt[refsSym] = undefined;
    rt.subagents = null;

    const makeScopeCtx = id => {
      const cleanups = [];
      const subagents = { id, waitForChildren: async () => false };
      return {
        subagents,
        tools: { register() {} },
        effect(fn) {
          const cleanup = fn();
          if (typeof cleanup === 'function') cleanups.push(cleanup);
        },
        dispose() {
          for (const c of cleanups.splice(0)) c();
        },
      };
    };

    const ctxA = makeScopeCtx('subagents-A');
    const ctxB = makeScopeCtx('subagents-B');
    entryLead.apply(ctxA);
    assert.equal(rt.subagents, ctxA.subagents);
    entryLead.apply(ctxB);
    assert.equal(rt.subagents, ctxB.subagents);

    // Disposing newer Session B while Session A remains active must fall back to Session A's subagents!
    ctxB.dispose();
    assert.equal(rt.subagents, ctxA.subagents);

    ctxA.dispose();
    assert.equal(rt.subagents, null);
  } finally {
    rt.subagents = prevSubagents;
    rt[refsSym] = prevRefs;
  }
});

test('CH-12 (P2): normalizeTimerState preserves settledPlanIds across disk round-trips without inflating unapprovedPlanAttempts', () => {
  let state = createInitialTimerState({ teamId: 'team-t1', taskSeq: 1, nowMs: 1000 });
  assert.deepEqual(state.tasks['1'].settledPlanIds, []);

  state = recordTimerPlanSettled(state, { taskSeq: 1, planId: 'plan-101', decision: 'revise', nowMs: 2000 });
  assert.equal(state.tasks['1'].unapprovedPlanAttempts, 1);
  assert.deepEqual(state.tasks['1'].settledPlanIds, ['plan-101']);

  const reloaded = normalizeTimerState(JSON.parse(JSON.stringify(state)), { nowMs: 3000 });
  assert.deepEqual(reloaded.tasks['1'].settledPlanIds, ['plan-101']);

  const afterRevisit = recordTimerPlanSettled(reloaded, { taskSeq: 1, planId: 'plan-101', decision: 'revise', nowMs: 4000 });
  assert.equal(afterRevisit.tasks['1'].unapprovedPlanAttempts, 1, 'revisiting settled plan must not double-increment');
});

test('CH-13 (P2): validateConfig rejects impossible caucus quorums and inverted soft/hard/battery thresholds', () => {
  assert.throws(
    () => configWith({ governance: { caucusQuorumNumerator: 4, caucusQuorumDenominator: 3 } }),
    err => err?.code === 'BAD_CONFIG' && /caucusQuorumNumerator must be <= governance\.caucusQuorumDenominator/.test(err.message),
  );
  assert.throws(
    () => configWith({ powerMonitor: { lowBatteryPct: 35 } }), // default resetBatteryPct is 25
    err => err?.code === 'BAD_CONFIG' && /resetBatteryPct must be greater than powerMonitor\.lowBatteryPct/.test(err.message),
  );
  assert.throws(
    () => configWith({ requestWindow: { softThrottlePct: 20, hardPausePct: 40 } }),
    err => err?.code === 'BAD_CONFIG' && /hardPausePct must be <= requestWindow\.softThrottlePct/.test(err.message),
  );
  assert.throws(
    () => configWith({ circuitBreaker: { repeatedFailureSoft: 8, repeatedFailureHard: 3 } }),
    err => err?.code === 'BAD_CONFIG' && /repeatedFailureSoft must be <= circuitBreaker\.repeatedFailureHard/.test(err.message),
  );
});

test('CH-15 (P2): observability bounds session cache (MAX_CACHED_SESSIONS = 32) and decodes single/multi-frame zstd logs cleanly', t => {
  const f1 = zlib.zstdCompressSync(Buffer.from('{"type":"session","seq":0}\n', 'utf8'));
  const f2 = zlib.zstdCompressSync(Buffer.from('{"type":"assistant/message","seq":1,"data":{"message":{"id":"m1","source":{"model":"zcode/GLM-5.3"}},"usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15}}}\n', 'utf8'));
  const multiFrame = Buffer.concat([f1, f2]);

  // `session-rows.mjs` single-pass zstdFrames + fallback on truncated frame
  const decodedAll = zstdFrames(multiFrame).toString('utf8').trim().split('\n');
  assert.equal(decodedAll.length, 2);

  // Truncated trailing bytes fallback recovery in observability durableRows + LRU cap <= 32
  const home = makeTempDir(t, 'ch15-home-');
  const storageRoot = path.join(home, 'leaderteam');
  const cfg = configWith({ storage: { root: storageRoot } });
  const rt = runtime();
  const prev = { config: rt.config, storageRoot: rt.storageRoot };
  t.after(() => {
    rt.config = prev.config;
    rt.storageRoot = prev.storageRoot;
  });
  rt.config = cfg;
  rt.storageRoot = storageRoot;

  assert.equal(MAX_CACHED_SESSIONS, 32);
  for (let i = 0; i < 40; i++) {
    const tid = `team-lru-${i}`;
    const st = new (teamStore(tid).constructor)(storageRoot, tid);
    st.ensure({ workspace: home, surface: 'headless' });
    const sessDir = path.join(home, 'sessions', 'bucket', tid);
    fs.mkdirSync(sessDir, { recursive: true });
    // Append an incomplete zstd header + partial bytes on `i === 0` to exercise frame fallback
    const payload = i === 0
      ? Buffer.concat([multiFrame, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])])
      : multiFrame;
    fs.writeFileSync(path.join(sessDir, 'session.v4.jsonl.zstd'), payload);
    const obs = teamObservability({}, rt, tid);
    assert.equal(obs.usage.groups.leader.tokens.totalTokens, 15);
  }
  assert.ok(_observabilityCacheSizeForTest() <= MAX_CACHED_SESSIONS, `cache size ${_observabilityCacheSizeForTest()} must be <= ${MAX_CACHED_SESSIONS}`);
});

test('CH-16 (P2): entry-core delayed settings sync race, activation agent="..." hint, configure-models colon tags, and headless-run argv loop', async t => {
  // 1. `activation.mjs`: error hint recommends `agent="..."` (never `agent_id="..."`)
  const membersMap = new Map([
    ['uuid-m1', { childId: 'uuid-m1', name: 'worker', hostAgentName: 'worker-t1', status: 'done' }],
  ]);
  const fakeStore = {
    getMember: id => membersMap.get(id) ?? null,
    members: () => membersMap,
  };
  assert.throws(
    () => resumeAdmission(fakeStore, defaultConfig(), 'worker', 1),
    err => /pass agent="worker-t1"/.test(err.message) && !err.message.includes('agent_id='),
  );

  // 2. `configure-models.mjs`: colon-tagged upstream model routes (`ollama/qwen3:32b`) and help roles
  const parsedNoEffort = parseConfigureCliArgs(['--set-role', 'gate=ollama/qwen3:32b']);
  assert.deepEqual(parsedNoEffort.changes.setRoles, [{ role: 'gate', route: 'ollama/qwen3:32b' }]);

  const parsedWithEffort = parseConfigureCliArgs(['--set-role', 'directExec=ollama/qwen3:32b:high']);
  assert.deepEqual(parsedWithEffort.changes.setRoles, [{ role: 'directExec', route: 'ollama/qwen3:32b', effort: 'high' }]);

  const helpSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-models.mjs'), 'utf8');
  assert.ok(helpSrc.includes('ROLE_KEYS.join'), 'configure-models help lists all ROLE_KEYS dynamically');

  // 3. `headless-run.mjs`: `--task "--version check"` does not corrupt flag parsing
  const hlArgs = parseHeadlessCliArgs(['--workspace', '/tmp/ws', '--task', '--version check', '--session', 'sess-1']);
  assert.deepEqual(hlArgs, {
    workspace: '/tmp/ws',
    task: '--version check',
    session: 'sess-1',
  });

  // 4. `entry-core.mjs`: delayed `settings` registration AFTER microtask + catalog probe still syncs enriched model capacities!
  const tmpHome = makeTempDir(t, 'ch16-core-');
  const cfgPath = path.join(tmpHome, 'leaderteam.config.json');
  const rawCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'leaderteam.config.json'), 'utf8'));
  rawCfg.magpie = { provider: 'deepseek' };
  rawCfg.models = {
    'deepseek/deepseek-v4-pro': {
      family: 'deepseek',
      label: 'DeepSeek V4 Pro',
      provider: 'deepseek',
      upstreamModel: 'deepseek-v4-pro',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    },
  };
  rawCfg.team.executionPool = ['deepseek/deepseek-v4-pro'];
  for (const r of Object.keys(rawCfg.roles)) {
    rawCfg.roles[r] = r === 'leader'
      ? { route: 'deepseek/deepseek-v4-pro', effort: 'high' }
      : { route: 'deepseek/deepseek-v4-pro', effort: 'low', timeoutMs: 30000, retries: 0 };
  }
  rawCfg.plugins = { scheduler: false, consensus: false, timerArchive: false, panel: false };
  fs.writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2));

  let lateInjectCb = null;
  let llmNamespaceData = {
    providers: {
      deepseek: {
        baseURL: 'http://127.0.0.1:19999/v1',
        apiKey: 'test-local-key',
        models: [],
      },
    },
  };
  const cleanups = [];
  const fakeSettings = {
    describe: () => ({ namespaces: [{ ns: 'llm-pi-ai', data: llmNamespaceData }] }),
    update: async (_ns, next) => { llmNamespaceData = next; },
  };
  const fakeCtx = {
    tools: { register() {} },
    llm: {
      listProviders: () => ['deepseek'],
      listModels: async () => [],
      listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai' }],
      discoverModels: async (_pid, provCfg) => (
        provCfg?.baseURL ? [{ id: 'deepseek-v4-pro', contextWindow: 262144, maxTokens: 65536 }] : []
      ),
    },
    agents: null,
    logger: { info() {}, warn() {} },
    get(serviceName) {
      if (serviceName === 'profileContext') return { home: tmpHome };
      if (serviceName === 'settings') return lateSettingsReady ? fakeSettings : null;
      return null;
    },
    on() {},
    provide() {},
    effect(fn) {
      const c = fn();
      if (typeof c === 'function') cleanups.push(c);
    },
    inject(deps, cb) {
      if (deps.includes('settings')) lateInjectCb = cb;
    },
  };
  let lateSettingsReady = false;
  const rt = runtime();
  const prevSnap = { ...rt };
  t.after(() => {
    for (const c of cleanups.splice(0)) c();
    Object.assign(rt, prevSnap);
  });

  rt.upstreamCatalog = null;
  entryCore.apply(fakeCtx, { configPath: cfgPath, surface: 'headless', modular: true });

  // Wait for initial microtask + `/v1/models` probe to finish BEFORE `settings` registers!
  for (let wait = 0; wait < 40 && !rt.upstreamCatalog; wait++) {
    await new Promise(r => setTimeout(r, 15));
  }
  assert.ok(rt.upstreamCatalog, 'upstreamCatalog populated before settings registered');
  assert.equal(llmNamespaceData.providers.deepseek.models.length, 0, 'settings was not registered yet');

  // Now `settings` registers late -> `ctx.inject(['settings'])` fires and syncs enriched capacities!
  lateSettingsReady = true;
  assert.equal(typeof lateInjectCb, 'function');
  lateInjectCb({ get: name => (name === 'settings' ? fakeSettings : fakeCtx.get(name)) });
  await rt.initialSettingsSyncPromise;

  const syncedModel = llmNamespaceData.providers.deepseek.models.find(m => m.id === 'deepseek-v4-pro');
  assert.ok(syncedModel, 'late settings registration synced configured model');
  assert.equal(syncedModel.contextWindow, 262144, 'late settings sync preserved enriched contextWindow');
  assert.equal(syncedModel.maxTokens, 65536, 'late settings sync preserved enriched maxTokens');
});

test('S3-SYS-01 (P0): subshell/compound-group pipe RHS, env -S/--split-string, and *awk dynamic execution cannot bypass safety gate or direct_exec', () => {
  const cfg = loadConfig(path.join(ROOT, 'config', 'leaderteam.config.json'), { includeLocal: false });
  const ws = '/tmp/lt-s4-sys-ws';
  const member = {
    role: 'member',
    name: 'worker',
    profile: 'shell',
    allowedTools: ['read', 'write', 'edit', 'bash'],
    loadedTools: ['read', 'write', 'edit', 'bash'],
    writeScope: ['mod_a/**'],
    unreadRefs: [],
  };
  const direct = { ...member, role: 'direct_exec' };

  const escapes = [
    'printf "%s\\n" "cd /tmp && pwd" | (bash -s)',
    '(printf "%s\\n" "cd /tmp && pwd") | (bash -s)',
    'printf "%s\\n" "import os; print(os.listdir(\'/tmp\'))" | (python3 -u)',
    'printf "%s\\n" "cd /tmp && pwd" | { bash -s; }',
    'echo "cd /tmp && pwd" | if true; then bash -s; fi',
    'env -S "cat /etc/hostname"',
    'env --split-string="cat /etc/hostname"',
    'env -S "python3 -u" <<< "import os; print(os.listdir(\'/tmp\'))"',
    'env -iS "bash -s" <<< "cd /tmp && pwd"',
    'awk \'BEGIN{system("cat /etc/hostname")}\'',
    'gawk \'BEGIN{system("cd /tmp && pwd")}\'',
    'echo "cat /etc/hostname" | awk \'{system($0)}\'',
    'mawk \'BEGIN{"id" | getline u; print u}\'',
    'nawk \'{print "pwn" > "/tmp/x"}\' mod_a/a.js',
    'awk -f mod_a/evil.awk mod_a/a.js',
  ];

  for (const command of escapes) {
    const sb = classifySandboxBoundary({ tool: 'bash', args: { command }, actor: member, cwd: ws, platform: 'linux' }, cfg);
    assert.equal(sb.confined, false, `S3-SYS-01 must not classify as confined: ${command}`);

    const dg = evaluateDirectExecSafetyGate({ tool: 'bash', args: { command }, actor: direct, cwd: ws, platform: 'linux' }, cfg);
    assert.equal(dg.decision, 'deny', `S3-SYS-01 direct_exec gate must deny: ${command}`);

    const dh = evaluateHardRules({ tool: 'bash', args: { command }, actor: direct, cwd: ws, platform: 'linux' }, cfg);
    assert.ok(dh, `S3-SYS-01 direct_exec hard rules must block: ${command}`);
  }

  // Deterministic hard-rule blocks on literal pipe/herestring/awk escapes even for ordinary `member`
  for (const hardMemberCmd of [
    'printf "%s\\n" "cd /tmp && pwd" | (bash -s)',
    'printf "%s\\n" "cd /tmp && pwd" | { bash -s; }',
    'env -iS "bash -s" <<< "cd /tmp && pwd"',
    'gawk \'BEGIN{system("cd /tmp && pwd")}\'',
    'nawk \'{print "pwn" > "/tmp/x"}\' mod_a/a.js',
  ]) {
    assert.equal(
      evaluateHardRules({ tool: 'bash', args: { command: hardMemberCmd }, actor: member, cwd: ws, platform: 'linux' }, cfg)?.rule,
      'path-outside-workspace',
      hardMemberCmd,
    );
  }

  // Legitimate workspace subshells and benign awk filters remain confined & allowed
  for (const okCmd of [
    '(npm test && node mod_a/index.mjs)',
    "awk '/ERROR/ {print $0}' mod_a/a.js",
    'git status | (head -n 5)',
  ]) {
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: okCmd }, actor: member, cwd: ws, platform: 'linux' }, cfg), undefined, okCmd);
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: okCmd }, actor: member, cwd: ws, platform: 'linux' }, cfg).confined, true, okCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: okCmd }, actor: direct, cwd: ws, platform: 'linux' }, cfg).decision, 'allow', okCmd);
  }
});

test('S3-SYS-02 (P0): dotted key.sub=/path options, unquoted bash brace expansion, and clustered short flags on custom mounts are enforced', () => {
  const cfg = loadConfig(path.join(ROOT, 'config', 'leaderteam.config.json'), { includeLocal: false });
  const ws = '/tmp/lt-s4-sys-ws';
  const member = {
    role: 'member',
    name: 'worker',
    profile: 'shell',
    allowedTools: ['bash'],
    loadedTools: ['bash'],
    writeScope: ['mod_a/**'],
    unreadRefs: [],
  };
  const direct = { ...member, role: 'direct_exec' };

  const mockFs = {
    existsSync: p => p === '/data2' || p === '/data2/archive.tar' || String(p).startsWith(ws),
    lstatSync: p => {
      if (p === '/data2' || p === '/data2/archive.tar' || String(p).startsWith(ws)) {
        return { isSymbolicLink: () => false, isDirectory: () => p === '/data2' || p === ws, isFile: () => p === '/data2/archive.tar' };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    statSync: p => {
      if (p === '/data2' || String(p).startsWith(ws)) return { isDirectory: () => p === '/data2' || p === ws };
      if (p === '/data2/archive.tar') return { isDirectory: () => false };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    realpathSync: p => p,
  };

  // Verify scanPosixShell marks unquoted brace expansions accurately
  assert.equal(scanPosixShell('cat {/,}etc/hostname').tokens[1].hasBraceExpansion, true);
  assert.equal(scanPosixShell('cat {1..5}.txt').tokens[1].hasBraceExpansion, true);
  assert.equal(scanPosixShell("echo '{\"a\":1,\"b\":2}'").tokens[1].hasBraceExpansion, false);
  assert.equal(scanPosixShell('git diff HEAD@{1}..HEAD@{0}').tokens[2].hasBraceExpansion, false);

  for (const cmd of [
    'git -c core.hooksPath=/tmp/evil status',
    'git -c include.path=/etc/passwd status',
    'java -Dapp.config=/etc/passwd Main',
    'node mod_a/run.js --output.dir=/tmp/out',
    'gcc -Wl,-rpath,/tmp/evil mod_a/main.c -o mod_a/main',
    'cat {/,}etc/hostname',
    "cat {'/',}etc/hostname",
    'cat mod_a/file{1..3}.js',
    'tar -tf/data2/archive.tar',
  ]) {
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: cmd }, actor: member, cwd: ws, platform: 'linux', fs: mockFs }, cfg).confined, false, cmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: cmd }, actor: direct, cwd: ws, platform: 'linux', fs: mockFs }, cfg).decision, 'deny', cmd);
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: cmd }, actor: direct, cwd: ws, platform: 'linux', fs: mockFs }, cfg)?.rule, 'direct-exec-sandbox-lock', cmd);
  }

  // Quoted JSON, git reflog ranges, and in-workspace dotted properties remain confined without false positives
  for (const safeCmd of [
    "node mod_a/cli.js --payload='{\"a\":1,\"b\":2}'",
    'git diff HEAD@{1}..HEAD@{0}',
    'java -Dapp.config=mod_a/app.properties Main',
  ]) {
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: safeCmd }, actor: member, cwd: ws, platform: 'linux', fs: mockFs }, cfg), undefined, safeCmd);
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: safeCmd }, actor: member, cwd: ws, platform: 'linux', fs: mockFs }, cfg).confined, true, safeCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: safeCmd }, actor: direct, cwd: ws, platform: 'linux', fs: mockFs }, cfg).decision, 'allow', safeCmd);
  }
});

test('S3-SYS-03 (P0): brace-expansion targets, dd/rsync/touch/mkdir/truncate/tar/unzip/*awk -i inplace, sed -Ei.bak, and compound prefixes enforce write_scope while preserving /dev/null', t => {
  const customCfg = configWith({
    paths: {
      protectedDirs: ['.leaderteam', '.git', '.agents', 'AGENTS.md', '.github'],
    },
  });
  const ws = makeTempDir(t, 's3-sys03-ws-');
  const posixWs = ws.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
  fs.mkdirSync(path.join(ws, 'mod_a'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'mod_b'), { recursive: true });

  const memberA = {
    role: 'member',
    name: 'worker-a',
    profile: 'shell',
    allowedTools: ['bash'],
    loadedTools: ['bash'],
    writeScope: ['mod_a/**'],
    unreadRefs: [],
  };
  const directA = { ...memberA, role: 'direct_exec' };

  // 1. Brace expansion in tee / redirection is blocked deterministically in evaluateHardRules, classifySandboxBoundary, and direct_exec
  for (const braceWriteCmd of [
    'tee mod_a/{../.g,x}it/hooks/pre-commit < mod_a/a.js',
    'echo pwn > mod_a/{../mod_b/b.js,ok.js}',
  ]) {
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: braceWriteCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg)?.rule, 'shell-dynamic-target', braceWriteCmd);
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: braceWriteCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg).confined, false, braceWriteCmd);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: braceWriteCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg).decision, 'deny', braceWriteCmd);
  }

  // 2. Out-of-scope mutating commands (`dd`, `rsync`, `touch`, `mkdir`, `truncate`, `tar`, `unzip`, `gawk -i inplace`, `sed -Ei.bak`, `{ cp ...; }`, `if ... then ... fi`)
  for (const outCmd of [
    'dd if=mod_a/a.js of=mod_b/b.js',
    'dd if=mod_a/a.js --output=mod_b/b.js',
    'rsync -a mod_a/a.js mod_b/b.js',
    'touch mod_b/new.js',
    'mkdir -p mod_b/sub',
    'truncate -s 0 mod_b/b.js',
    'tar -xf mod_a/a.tar',
    'tar -xf mod_a/a.tar -C mod_b',
    'tar -czf mod_b/out.tar.gz mod_a',
    'unzip mod_a/a.zip',
    'unzip -q mod_a/a.zip -d mod_b',
    "gawk -i inplace '{gsub(/a/, \"b\"); print}' mod_b/b.js",
    'sed -Ei.bak "s/2/9/" mod_b/b.js',
    '{ cp mod_a/a.js mod_b/b.js; }',
    'if true; then cp mod_a/a.js mod_b/b.js; fi',
  ]) {
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: outCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg).confined, false, `must block out-of-scope mutation: ${outCmd}`);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: outCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg).decision, 'deny', `direct_exec must deny out-of-scope mutation: ${outCmd}`);
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: outCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg)?.rule, 'direct-exec-sandbox-lock', outCmd);
  }

  // 3. In-scope counterparts AND `/dev/null` redirections remain confined & allowed
  for (const inCmd of [
    'dd if=mod_a/a.js of=mod_a/copy.js',
    'dd if=mod_a/a.js of=/dev/null',
    'rsync -a mod_a/a.js mod_a/copy.js',
    'touch mod_a/new.js',
    'mkdir -p mod_a/sub',
    'truncate -s 0 mod_a/a.js',
    'tar -xf mod_a/a.tar -C mod_a',
    'tar -tf mod_b/a.tar',
    'unzip -q mod_a/a.zip -d mod_a/out',
    'unzip -l mod_b/a.zip',
    "gawk -i inplace '{gsub(/a/, \"b\"); print}' mod_a/a.js",
    'sed -Ei.bak "s/2/9/" mod_a/a.js',
    '{ cp mod_a/a.js mod_a/copy.js; }',
    'npm test 2>/dev/null',
    'npm test >/dev/null 2>&1',
    'npm test &>/dev/null',
  ]) {
    assert.equal(evaluateHardRules({ tool: 'bash', args: { command: inCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg), undefined, inCmd);
    assert.equal(classifySandboxBoundary({ tool: 'bash', args: { command: inCmd }, actor: memberA, cwd: posixWs, platform: 'linux' }, customCfg).confined, true, `in-scope command must remain confined: ${inCmd}`);
    assert.equal(evaluateDirectExecSafetyGate({ tool: 'bash', args: { command: inCmd }, actor: directA, cwd: posixWs, platform: 'linux' }, customCfg).decision, 'allow', `direct_exec must allow in-scope command: ${inCmd}`);
  }
});

test('S3-SYS-04 (P1): escaped JSON quotes, CLI secret flags in lt-bugreport, and URL userinfo credentials in redact.mjs are scrubbed cleanly', () => {
  const escapedJsonCmd = 'curl -X POST http://127.0.0.1:8080/auth -d "{\\"apiKey\\":\\"custom-gw-key-9876\\",\\"password\\":\\"MyUnitTestPass!2026\\"}"';

  const coreRedacted = redactInlineSecrets(escapedJsonCmd);
  assert.equal(coreRedacted.includes('custom-gw-key-9876'), false, coreRedacted);
  assert.equal(coreRedacted.includes('MyUnitTestPass!2026'), false, coreRedacted);
  assert.ok(coreRedacted.includes('\\"apiKey\\":\\"[REDACTED]\\"'), `expected escaped quotes preserved: ${coreRedacted}`);

  const bugRedacted = redactDiagnosticText(escapedJsonCmd, { username: 'devuser', hostname: 'devbox' });
  assert.equal(bugRedacted.includes('custom-gw-key-9876'), false, bugRedacted);
  assert.equal(bugRedacted.includes('MyUnitTestPass!2026'), false, bugRedacted);

  const multiSecretDiag = redactDiagnosticText(
    'apiKey=secA1234 token="secB5678" --password "secC9012" --api-key \\"secE7890\\" Authorization: "Bearer secD3456"',
    { username: 'devuser', hostname: 'devbox' },
  );
  for (const s of ['secA1234', 'secB5678', 'secC9012', 'secE7890', 'secD3456']) {
    assert.equal(multiSecretDiag.includes(s), false, `redactDiagnosticText leaked ${s}: ${multiSecretDiag}`);
  }

  // URL userinfo password redaction + inlineSecretMatches + redactionHidesCode + port/@scope non-regression
  const gitCloneUrl = 'git clone https://oauth-user:SuperSecretGitPass99@git.internal.corp/org/repo.git';
  assert.equal(
    redactInlineSecrets(gitCloneUrl),
    `git clone https://oauth-user:${REDACTED}@git.internal.corp/org/repo.git`,
  );
  const matches = inlineSecretMatches(gitCloneUrl);
  assert.deepEqual(matches, [
    { form: 'url_userinfo', separator: ':', quoted: false, value: 'SuperSecretGitPass99' },
  ]);
  assert.equal(redactionHidesCode(gitCloneUrl, { tool: 'bash' }), false);
  assert.equal(redactionHidesCode('git clone https://oauth-user:$(whoami)@git.internal.corp/org/repo.git', { tool: 'bash' }), true);

  // Port + scoped package path without userinfo AND JSON object values (`"authorization":{...}`) MUST NOT be mangled
  const scopedPkgUrl = 'http://127.0.0.1:8080/pkg/@deepseek-ai/dsh';
  assert.equal(redactInlineSecrets(scopedPkgUrl), scopedPkgUrl);
  const jsonObjAuth = '},"scope":{"write_scope":["**"]},"authorization":{"user_task":"everything approved"}';
  assert.equal(redactInlineSecrets(jsonObjAuth), jsonObjAuth);
});

test('S3-SYS-05 (P1): scripts/plan-archive.mjs rejects malformed/blank/negative --older-than-days with PLAN_ARCHIVE_CLEAN instead of wiping plans', t => {
  const tmp = makeTempDir(t, 's3-sys05-pa-');
  const archiveRoot = path.join(tmp, 'archive');
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });

  const archive = new PlanArchiveStore(archiveRoot, { workspaceRoot: ws });
  archive.archivePlanSubmission({
    agreementId: 'fresh-plan-today',
    teamId: 'team-pa-1',
    taskSeq: 1,
    workspace: ws,
    topic: 'Fresh plan created just now',
    proposal: 'Step 1: keep safe',
    userRequest: 'Keep fresh plans intact',
    nowMs: Date.now(),
  });

  for (const badAge of ['30d', 'abc', '', '   ', '-5']) {
    assert.throws(
      () => runPlanArchiveCli([
        '--clean',
        '--archive-root', archiveRoot,
        '--workspace', ws,
        '--older-than-days', badAge,
        '--confirm',
        '--json',
      ], { writeStdout: false }),
      err => err?.code === 'PLAN_ARCHIVE_CLEAN',
      `expected PLAN_ARCHIVE_CLEAN for --older-than-days "${badAge}"`,
    );
  }

  // Also verify subprocess CLI exits non-zero and prints [PLAN_ARCHIVE_CLEAN]
  const cliScript = path.join(ROOT, 'scripts', 'plan-archive.mjs');
  assert.throws(
    () => execFileSync(process.execPath, [
      cliScript,
      '--clean',
      '--archive-root', archiveRoot,
      '--workspace', ws,
      '--older-than-days', '30d',
      '--confirm',
      '--json',
    ], { encoding: 'utf8', stdio: 'pipe' }),
    err => err.status === 1 && String(err.stderr).includes('PLAN_ARCHIVE_CLEAN'),
  );

  assert.equal(archive.listPlans().length, 1, 'fresh plan must remain completely untouched');
});

test('S3-SYS-06 (P1): lt-bugreport blocks sessionId path traversal & symlink escape, caps session file size <= 64MiB, and falls back to session.v4.jsonl', t => {
  const probeRoot = makeTempDir(t, 's3-sys06-');
  const dshHome = path.join(probeRoot, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const teamDir = path.join(storageRoot, 'teams', 'team-s06');
  const outsideSessDir = path.join(probeRoot, 'outside-secret-sess');
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(outsideSessDir, { recursive: true });

  // External session outside dshHome with 77,778 tokens that MUST NOT be read via traversal or symlink
  fs.writeFileSync(
    path.join(outsideSessDir, 'session.v4.jsonl.zstd'),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      data: { message: { id: 'ext-1' }, usage: { inputTokens: 77777, outputTokens: 1, totalTokens: 77778 } },
    }) + '\n', 'utf8')),
  );

  // Symlinked session directory & symlinked file inside dshHome/sessions pointing outside
  const sessionsDir = path.join(dshHome, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'sym-file-sess'), { recursive: true });
  fs.symlinkSync(outsideSessDir, path.join(sessionsDir, 'sym-dir-sess'), process.platform === 'win32' ? 'junction' : 'dir');
  const symFileTarget = path.join(outsideSessDir, 'session.v4.jsonl.zstd');
  const symFileDest = path.join(sessionsDir, 'sym-file-sess', 'session.v4.jsonl.zstd');
  let simulatedWinFileSymlink = false;
  try {
    fs.symlinkSync(symFileTarget, symFileDest);
  } catch (err) {
    if (err?.code !== 'EPERM') throw err;
    fs.copyFileSync(symFileTarget, symFileDest);
    simulatedWinFileSymlink = true;
  }

  // Valid uncompressed `session.v4.jsonl` fallback inside `dshHome/sessions` (`330` totalTokens)
  const jsonlFallbackDir = path.join(sessionsDir, 'plain-jsonl-mem');
  fs.mkdirSync(jsonlFallbackDir, { recursive: true });
  fs.writeFileSync(
    path.join(jsonlFallbackDir, 'session.v4.jsonl'),
    JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      data: { message: { id: 'ok-jsonl-1' }, usage: { inputTokens: 300, outputTokens: 30, totalTokens: 330 } },
    }) + '\n',
    'utf8',
  );

  // Oversized session file (> 64 MiB mocked via fs wrapper) that must be skipped without reading
  const hugeSessDir = path.join(sessionsDir, 'huge-mem');
  const hugeSessFile = path.join(hugeSessDir, 'session.v4.jsonl.zstd');
  fs.mkdirSync(hugeSessDir, { recursive: true });
  fs.writeFileSync(
    hugeSessFile,
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      data: { message: { id: 'huge-1' }, usage: { inputTokens: 88888, outputTokens: 1, totalTokens: 88889 } },
    }) + '\n', 'utf8')),
  );

  fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify({ v: 1, teamId: 'team-s06', createdAt: '2026-11-25T19:00:00Z' }), 'utf8');
  fs.writeFileSync(
    path.join(teamDir, 'members.jsonl'),
    [
      JSON.stringify({ v: 1, type: 'member', childId: '../outside-secret-sess', name: 'trav-1', status: 'done' }),
      JSON.stringify({ v: 1, type: 'member', childId: '../../outside-secret-sess', name: 'trav-2', status: 'done' }),
      JSON.stringify({ v: 1, type: 'member', childId: 'sym-dir-sess', name: 'sym-dir', status: 'done' }),
      JSON.stringify({ v: 1, type: 'member', childId: 'sym-file-sess', name: 'sym-file', status: 'done' }),
      JSON.stringify({ v: 1, type: 'member', childId: 'huge-mem', name: 'huge', status: 'done' }),
      JSON.stringify({ v: 1, type: 'member', childId: 'plain-jsonl-mem', name: 'ok-jsonl', status: 'done' }),
    ].join('\n') + '\n',
    'utf8',
  );

  let readHugeAttempted = false;
  const wrappedFs = {
    ...fs,
    lstatSync(p, ...rest) {
      const st = fs.lstatSync(p, ...rest);
      const resolvedP = path.resolve(String(p));
      if (simulatedWinFileSymlink && resolvedP === symFileDest) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          isSymbolicLink: () => true,
        });
      }
      if (resolvedP === hugeSessFile) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 65 * 1024 * 1024 });
      }
      return st;
    },
    realpathSync(p, ...rest) {
      if (simulatedWinFileSymlink && path.resolve(String(p)) === symFileDest) {
        return symFileTarget;
      }
      return fs.realpathSync(p, ...rest);
    },
    readFileSync(p, ...rest) {
      if (path.resolve(String(p)) === hugeSessFile) readHugeAttempted = true;
      return fs.readFileSync(p, ...rest);
    },
  };

  const report = generateRedactedBugReport({
    dshHome,
    storageRoot,
    fsImpl: wrappedFs,
    hostname: 'host-s06',
    username: 'user-s06',
  });
  assert.equal(readHugeAttempted, false, 'oversized >64MiB session log must be skipped before readFileSync');
  assert.deepEqual(report.metrics.usageByRole.member, {
    calls: 1,
    inputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 30,
    totalTokens: 330,
  });
  assert.equal(report.metrics.usageTotal.totalTokens, 330);
});

test('S3-SYS-07 (P1): governance loadBoundedWorkspaceExcerpts & respondInFormalConference block symlinks, secret/protected files, unbounded reads, and inline secrets', async t => {
  const baseDir = makeTempDir(t, 's3-sys07-');
  const ws = path.join(baseDir, 'ws');
  const outside = path.join(baseDir, 'outside');
  const storageRoot = path.join(baseDir, 'storage');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const externalSecret = 'TOP_SECRET_EXTERNAL_DATA_998877';
  fs.writeFileSync(path.join(outside, 'host-secret.txt'), `${externalSecret}\n`, 'utf8');
  try {
    fs.symlinkSync(path.join(outside, 'host-secret.txt'), path.join(ws, 'src', 'ext-link.txt'));
  } catch (err) {
    if (err?.code !== 'EPERM') throw err;
    fs.symlinkSync(outside, path.join(ws, 'src', 'ext-link.txt'), 'junction');
  }
  fs.symlinkSync(outside, path.join(ws, 'src', 'ext-dir'), process.platform === 'win32' ? 'junction' : 'dir');

  fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=env_file_secret_112233\n', 'utf8');
  fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Protected instructions\n', 'utf8');
  fs.writeFileSync(
    path.join(ws, 'src', 'valid.js'),
    `const apiKey = "inline-secret-val-556677";\nexport const ok = true;\n${'x'.repeat(40000)}\n`,
    'utf8',
  );

  const excerpts = loadBoundedWorkspaceExcerpts(ws, [
    'src/ext-link.txt',
    'src/ext-dir/host-secret.txt',
    '.env',
    '.git/config',
    'AGENTS.md',
    'src/valid.js',
  ], 24000, ['.leaderteam', '.git', '.agents', 'AGENTS.md']);

  assert.equal(excerpts.length, 1, 'only legitimate non-symlink, non-secret, non-protected file loaded');
  assert.equal(excerpts[0].file, 'src/valid.js');
  assert.equal(excerpts[0].content.includes(externalSecret), false);
  assert.equal(excerpts[0].content.includes('inline-secret-val-556677'), false);
  assert.ok(excerpts[0].content.includes(REDACTED));
  assert.ok(excerpts[0].content.length <= 8001);

  // Verify `respondInFormalConference` never persists symlinked external files into `governance.jsonl`
  const cfg = configWith({
    storage: { root: storageRoot },
    governance: { mode: 'autonomous' },
  });
  const rt = runtime();
  const prev = { config: rt.config, storageRoot: rt.storageRoot, llm: rt.llm };
  t.after(() => {
    rt.config = prev.config;
    rt.storageRoot = prev.storageRoot;
    rt.llm = prev.llm;
  });
  rt.config = cfg;
  rt.storageRoot = storageRoot;
  rt.llm = null; // callGovernanceRole returns unavailable cleanly after conference-turn is appended

  const st = new (teamStore('team-s07').constructor)(storageRoot, 'team-s07');
  st.ensure({ workspace: ws, surface: 'headless' });
  st.appendGovernanceEvent({
    type: 'conference-opened',
    taskSeq: 1,
    conferenceId: 'conf-s07',
    disputeId: 'disp-s07',
    strike: 1,
    targets: ['src/valid.js'],
    initialExpectation: 'Verify implementation',
    opening: { summary: 'Open' },
  });

  await respondInFormalConference({
    ctx: {},
    rt,
    store: st,
    actor: { teamId: 'team-s07', cwd: ws },
    leaderAgent: null,
    leaderModel: 'zcode/GLM-5.3',
    taskSeq: 1,
    conferenceId: 'conf-s07',
    explanation: 'Providing workspace evidence',
    newEvidenceFiles: ['src/ext-link.txt', '.env', 'src/valid.js'],
    userTask: 'Verify fix',
  });

  const govRaw = fs.readFileSync(path.join(st.dir, 'governance.jsonl'), 'utf8');
  assert.equal(govRaw.includes(externalSecret), false, 'external symlink content must never enter governance.jsonl');
  assert.equal(govRaw.includes('env_file_secret_112233'), false);
  assert.equal(govRaw.includes('inline-secret-val-556677'), false);
});

test('S3-SYS-08 (P2): observability upgrades streaming partial assistant/message rows on finalized usage and aggregates directExec in roles', t => {
  // 1. Streaming partial `assistant/message` without `usage` upgraded by finalized row with same `message.id`
  const streamingSummary = summarizeTeamUsage([
    {
      id: 'team-stream-1',
      name: 'leader',
      group: 'leader',
      available: true,
      rows: [
        {
          type: 'assistant/message',
          seq: 1,
          data: { message: { id: 'msg-stream-1', source: { model: 'zcode/GLM-5.3' } } },
        },
        {
          type: 'assistant/message',
          seq: 2,
          data: {
            message: { id: 'msg-stream-1', source: { model: 'zcode/GLM-5.3' } },
            usage: { inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 50, totalTokens: 1250 },
          },
        },
        {
          // Duplicate finalized row must NOT double-count
          type: 'assistant/message',
          seq: 3,
          data: {
            message: { id: 'msg-stream-1', source: { model: 'zcode/GLM-5.3' } },
            usage: { inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 0, outputTokens: 50, totalTokens: 1250 },
          },
        },
      ],
    },
  ], []);

  assert.equal(streamingSummary.groups.leader.receiptCount, 1);
  assert.equal(streamingSummary.groups.leader.missingUsage, 0);
  assert.equal(streamingSummary.groups.leader.tokens.totalTokens, 1250);
  assert.equal(streamingSummary.complete, true);

  // 2. `teamObservability` upgrades leader streaming rows AND populates `roles` entry for `directExec`
  const home = makeTempDir(t, 's3-sys08-home-');
  const storageRoot = path.join(home, 'leaderteam');
  const cfg = configWith({ storage: { root: storageRoot } });
  const rt = runtime();
  const prev = { config: rt.config, storageRoot: rt.storageRoot };
  t.after(() => {
    rt.config = prev.config;
    rt.storageRoot = prev.storageRoot;
  });
  rt.config = cfg;
  rt.storageRoot = storageRoot;

  const teamId = 'team-s08';
  const st = new (teamStore(teamId).constructor)(storageRoot, teamId);
  st.ensure({ workspace: home, surface: 'headless' });
  st.addMember({
    childId: 'dir-exec-1',
    name: 'direct-runner',
    actorRole: 'direct_exec',
    profile: 'code',
    model: 'zcode/GLM-5.3-Flash',
    effort: 'low',
    status: 'done',
  });
  st.addMember({
    childId: 'mem-exec-1',
    name: 'worker-1',
    actorRole: 'member',
    profile: 'code',
    model: 'zcode/GLM-5.3',
    effort: 'high',
    status: 'done',
  });

  const writeNativeZstd = (sid, rows) => {
    const dir = path.join(home, 'sessions', sid);
    fs.mkdirSync(dir, { recursive: true });
    const payload = Buffer.concat(rows.map(r => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))));
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), payload);
  };

  writeNativeZstd(teamId, [
    { type: 'request/header', seq: 0, data: { header: { config: { model: 'zcode/GLM-5.3' } } } },
    { type: 'assistant/message', seq: 1, data: { message: { id: 'lead-m1', source: { provider: 'magpie', model: 'zcode/GLM-5.3' } } } },
    { type: 'assistant/message', seq: 2, data: { message: { id: 'lead-m1', source: { provider: 'magpie', model: 'zcode/GLM-5.3' } }, usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 } } },
  ]);
  writeNativeZstd('dir-exec-1', [
    { type: 'request/header', seq: 0, data: { header: { config: { model: 'zcode/GLM-5.3-Flash' } } } },
    { type: 'assistant/message', seq: 1, data: { message: { id: 'de-m1', source: { provider: 'magpie', model: 'zcode/GLM-5.3-Flash' } } } },
    { type: 'assistant/message', seq: 2, data: { message: { id: 'de-m1', source: { provider: 'magpie', model: 'zcode/GLM-5.3-Flash' } }, usage: { inputTokens: 60, outputTokens: 15, totalTokens: 75 } } },
  ]);
  writeNativeZstd('mem-exec-1', [
    { type: 'assistant/message', seq: 1, data: { message: { id: 'mem-m1', source: { provider: 'magpie', model: 'zcode/GLM-5.3' } }, usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 } } },
  ]);

  const obs = teamObservability({ get: k => (k === 'profileContext' ? { home } : null) }, rt, teamId);
  const leaderRole = obs.roles.find(r => r.role === 'leader');
  const directExecRole = obs.roles.find(r => r.role === 'directExec');

  assert.equal(leaderRole.calls, 1);
  assert.equal(leaderRole.missingUsage, 0);
  assert.equal(leaderRole.tokens.totalTokens, 500);

  assert.ok(directExecRole, 'directExec role entry exists');
  assert.equal(directExecRole.calls, 1);
  assert.equal(directExecRole.called, true);
  assert.deepEqual(directExecRole.actualRoutes, ['zcode/GLM-5.3-Flash']);
  assert.deepEqual(directExecRole.requestRoutes, ['zcode/GLM-5.3-Flash']);
  assert.equal(directExecRole.missingUsage, 0);
  assert.equal(directExecRole.tokens.totalTokens, 75);

  // Total usage counts leader (500) + directExec (75) + member (250) = 825 once without double counting
  assert.equal(obs.usage.total.totalTokens, 825);
  assert.equal(obs.usage.complete, true);
});
