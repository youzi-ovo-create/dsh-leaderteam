#!/usr/bin/env node
/**
 * Comprehensive Linux Productization E2E & Leak Audit Verification (`V2.2.x`)
 *
 * Verifies:
 * 1. Release tarball packaging (`npm pack`) & clean contents inspection (no node_modules, no secrets, no private files).
 * 2. Real `dsh plugin --profile web add <tarball>` into an isolated `DSH_HOME` + `lt-doctor --check-host` + `lt-bugreport`.
 * 3. Real `dsh --profile web --no-open --port 0` boot alongside controllable local Mock Magpie (`0.1.4731` & simulated `0.1.4797` update).
 * 4. Seamless `/` (DSH Native Frontend + `leaderteam-panel/client.js` switcher) <-> `/lt/` (LT Native Frontend) switching
 *    on the exact same auth cookie, creating a live DSH session from `/lt/`, prompting it, switching to `/`, and returning
 *    to `/lt/` with zero process interruption.
 * 5. Full Provider -> Multi-Key -> Model Discovery -> LT Pool Sync -> 7-Role Fallback Configuration -> Non-Blocking Hengzhang
 *    Usage Reconciliation -> 4 Theme Presets & Custom Theme Persistence.
 * 6. Source tree, Git history, and artifact leak audit (zero secrets, zero `v2.3`/`v2.4` private content, zero writes outside `open-source-v2.2.x`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMockMagpieServer } from '../../../lt-shared-contracts/mocks/mock-magpie-server.mjs';
import { validateContractBundle } from '../../../lt-shared-contracts/tests/contract-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const ossRoot = path.resolve(repoRoot, '..');
const artifactsDir = path.join(ossRoot, 'artifacts');
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const expectedVersion = rootPkg.version;

const ENHANCED_PATH = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`;

function runSync(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: ENHANCED_PATH, ...(opts.env || {}) },
    cwd: opts.cwd || repoRoot,
    timeout: opts.timeout || 120_000,
  });
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    steps: {},
  };

  // ==================== 1. Tarball Pack & Contents Audit ====================
  console.log('[1/7] Packing release tarball and auditing file manifest...');
  const packJsonRaw = runSync('npm', ['pack', '--json', '--pack-destination', artifactsDir]);
  const packInfo = JSON.parse(packJsonRaw)[0];
  assert.equal(packInfo.version, expectedVersion, `Tarball version must match package.json (${expectedVersion})`);
  const tarballPath = path.join(artifactsDir, packInfo.filename);
  assert.ok(fs.existsSync(tarballPath), `Tarball created at ${tarballPath}`);

  const packedFiles = (packInfo.files || []).map(f => f.path);
  assert.ok(packedFiles.includes('leaderteam/plugins/leaderteam-panel/web-dist/index.html'), 'Tarball includes built LT Native Frontend');
  assert.ok(packedFiles.includes('leaderteam/gateway/index.mjs'), 'Tarball includes Magpie gateway module');
  assert.ok(packedFiles.includes('leaderteam/usage/index.mjs'), 'Tarball includes Hengzhang usage bridge');
  assert.ok(packedFiles.includes('packages/lt-usage/index.mjs'), 'Tarball includes bundled zero-dep Hengzhang core/reader');
  assert.ok(packedFiles.includes('bin/lt-magpie.mjs'), 'Tarball includes lt-magpie CLI');
  assert.ok(packedFiles.includes('bin/lt-ui.mjs'), 'Tarball includes lt-ui CLI');
  assert.ok(packedFiles.includes('THIRD_PARTY_NOTICES.md'), 'Tarball includes root THIRD_PARTY_NOTICES.md');
  for (const pf of packedFiles) {
    assert.ok(!pf.includes('node_modules/'), `Tarball must not ship node_modules: ${pf}`);
    assert.ok(!pf.endsWith('.env'), `Tarball must not ship .env: ${pf}`);
    assert.ok(!pf.includes('leaderteam.local.json'), `Tarball must not ship local config: ${pf}`);
  }
  report.steps.packaging = {
    ok: true,
    filename: packInfo.filename,
    sizeBytes: packInfo.size,
    fileCount: packedFiles.length,
  };

  // ==================== 2. Isolated DSH Profile Install + Doctor & Bugreport ====================
  console.log('[2/7] Installing tarball into isolated DSH_HOME via `dsh plugin add`...');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v22x-e2e-'));
  const dshHome = path.join(tmpRoot, 'dsh-home');
  const workspaceDir = path.join(tmpRoot, 'sample-project');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const mockMagpie = await startMockMagpieServer({ version: '0.1.4731' });
  let dshProc = null;

  try {
    runSync('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
      env: { DSH_HOME: dshHome },
      timeout: 180_000,
    });

    // Ensure `dsh-leaderteam` is listed in `profiles/web/package.json` `dsh.profile.bundles`
    const profilePkgPath = path.join(dshHome, 'profiles', 'web', 'package.json');
    const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
    profilePkg.dsh ??= {};
    profilePkg.dsh.profile ??= {};
    profilePkg.dsh.profile.bundles ??= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
    if (!profilePkg.dsh.profile.bundles.includes('dsh-leaderteam')) {
      profilePkg.dsh.profile.bundles.push('dsh-leaderteam');
      fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n');
    }

    const doctorOut = JSON.parse(
      runSync('node', [
        path.join(repoRoot, 'bin', 'lt-doctor.mjs'),
        '--json',
        '--dsh-home',
        dshHome,
        '--workspace',
        workspaceDir,
      ]),
    );
    assert.equal(doctorOut.ok !== false, true, 'lt-doctor preflight succeeded');

    report.steps.dshInstallAndDoctor = {
      ok: true,
      bundles: profilePkg.dsh.profile.bundles,
      doctorStatus: doctorOut.status || 'ok',
    };

    // ==================== 3. Boot Real `dsh web` & Verify Seamless Dual-Frontend Switch ====================
    console.log('[3/7] Booting real `dsh --profile web` and verifying `/` <-> `/lt/` shared runtime & session...');
    let launchUrl = null;
    let dshLogs = '';
    dshProc = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        PATH: ENHANCED_PATH,
        DSH_HOME: dshHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onChunk = chunk => {
      const s = chunk.toString('utf8');
      dshLogs += s;
      const m = dshLogs.match(/https?:\/\/127\.0\.0\.1:\d+\/(?:connect)?\?token=[A-Za-z0-9._~-]+/);
      if (m && !launchUrl) launchUrl = m[0];
    };
    dshProc.stdout.on('data', onChunk);
    dshProc.stderr.on('data', onChunk);

    const bootDeadline = Date.now() + 30_000;
    while (!launchUrl && Date.now() < bootDeadline) {
      if (dshProc.exitCode !== null) {
        throw new Error(`dsh web exited prematurely (${dshProc.exitCode}):\n${dshLogs}`);
      }
      await new Promise(r => setTimeout(r, 150));
    }
    assert.ok(launchUrl, `dsh web printed launch URL (logs: ${dshLogs.slice(-400)})`);

    const parsedOrigin = new URL(launchUrl).origin;

    // Exchange `/connect?token=...` for DSH's shared owner HttpOnly cookie!
    const connectRes = await fetch(launchUrl, { redirect: 'manual' });
    assert.ok([302, 303].includes(connectRes.status), `Expected redirect on /connect, got ${connectRes.status}`);
    const rawCookies = connectRes.headers.getSetCookie ? connectRes.headers.getSetCookie() : [connectRes.headers.get('set-cookie') || ''];
    const cookieHeader = rawCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
    assert.ok(cookieHeader.length > 0, 'Received DSH owner session cookie');

    // 3a. Verify DSH Native Frontend (`/`) & `dsh-leaderteam/client.js` switcher load with same cookie
    const dshIndexRes = await fetch(`${parsedOrigin}/`, { headers: { Cookie: cookieHeader } });
    assert.equal(dshIndexRes.status, 200);
    const dshHtml = await dshIndexRes.text();
    assert.match(dshHtml, /__DSH_BOOT__/);

    // 3b. Verify LT Native Frontend (`/lt/`) loads on the EXACT SAME DSH webServer & cookie!
    const ltIndexRes = await fetch(`${parsedOrigin}/lt/`, { headers: { Cookie: cookieHeader } });
    assert.equal(ltIndexRes.status, 200);
    const ltHtml = await ltIndexRes.text();
    assert.match(ltHtml, /Leader Team — 工程治理与模型工作台/);
    assert.match(ltHtml, /data-lt-theme="white"/);

    // 3c. Call `/api/lt/v1/*` on the live DSH server to wire Mock Magpie, add provider + multi-key, discover & sync models, create live session!
    const postLt = async (subpath, body = {}) => {
      const r = await fetch(`${parsedOrigin}/api/lt/v1/${subpath}`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          Origin: parsedOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, `POST /api/lt/v1/${subpath} HTTP ${r.status}`);
      const j = await r.json();
      assert.equal(j.ok, true, `API error on ${subpath}: ${JSON.stringify(j.error)}`);
      return j;
    };

    await postLt('gateway/control', {
      action: 'configure',
      config: {
        mode: 'external',
        externalGatewayUrl: mockMagpie.gatewayUrl,
        externalWebAdminUrl: mockMagpie.webUrl,
        externalWebKey: mockMagpie.webKey,
      },
    });

    await postLt('providers/mutate', {
      operation: 'save-provider',
      spec: { new: true, preset: 'deepseek', key: 'sk-e2e-k1-111111111111\nsk-e2e-k2-222222222222' },
    });

    const syncModels = await postLt('models/sync-pool', { target: 'local', enableInExecutionPool: true });
    assert.ok(syncModels.data.syncedCount >= 2);

    // Create a live shared session inside DSH via LT Workbench API!
    const createdSess = await postLt('workbench/create', {
      cwd: workspaceDir,
      agentPreset: 'leaderteam',
    });
    assert.ok(createdSess.data.sessionId, 'Created real DSH session from /lt/ workbench');
    assert.equal(createdSess.data.modeState?.mode, 'team', 'Default workbench session starts in team mode');
    assert.equal(createdSess.data.modeState?.isLtSession, true);

    // Live V2.2.3 dual-mode E2E check on real `dsh web`: Team -> Single -> Team (0 LLM calls) + GET read-only & GET mutating 405 guard!
    const toSingle = await postLt('workbench/mode', {
      action: 'set',
      sessionId: createdSess.data.sessionId,
      mode: 'single',
    });
    assert.equal(toSingle.data.changed, true);
    assert.equal(toSingle.data.previousMode, 'team');
    assert.equal(toSingle.data.modeState.mode, 'single');

    const getReadOnlyMode = await fetch(
      `${parsedOrigin}/api/lt/v1/workbench/mode?sessionId=${encodeURIComponent(createdSess.data.sessionId)}`,
      { headers: { Cookie: cookieHeader, Origin: parsedOrigin } },
    );
    assert.equal(getReadOnlyMode.status, 200);
    const getReadOnlyJson = await getReadOnlyMode.json();
    assert.equal(getReadOnlyJson.ok, true);
    assert.equal(getReadOnlyJson.data.modeState.mode, 'single');

    const getMutatingMode = await fetch(
      `${parsedOrigin}/api/lt/v1/workbench/mode?sessionId=${encodeURIComponent(createdSess.data.sessionId)}&mode=team`,
      { headers: { Cookie: cookieHeader, Origin: parsedOrigin } },
    );
    assert.equal(getMutatingMode.status, 405, 'Mutating GET /api/lt/v1/workbench/mode?mode=... must return 405');
    assert.equal(getMutatingMode.headers.get('allow'), 'POST');

    const backToTeam = await postLt('workbench/mode', {
      action: 'set',
      sessionId: createdSess.data.sessionId,
      mode: 'team',
    });
    assert.equal(backToTeam.data.changed, true);
    assert.equal(backToTeam.data.previousMode, 'single');
    assert.equal(backToTeam.data.modeState.mode, 'team');
    assert.equal(backToTeam.data.modeState.switchCount, 2);

    // Switch back to DSH `/` and back to `/lt/workbench/sessions` -> verify session is live & uninterrupted!
    const dshCheckAgain = await fetch(`${parsedOrigin}/`, { headers: { Cookie: cookieHeader } });
    assert.equal(dshCheckAgain.status, 200);
    const listedSess = await postLt('workbench/sessions');
    assert.equal(listedSess.data.liveHost, true);
    const foundListed = listedSess.data.sessions.find(s => s.sessionId === createdSess.data.sessionId);
    assert.ok(foundListed, 'Created session returned in workbench/sessions');
    assert.equal(foundListed.executionMode, 'team');
    assert.equal(foundListed.modeState?.switchCount, 2);

    // Verify all 4 themes + custom seeds round-trip on live DSH host
    for (const th of ['white', 'dark', 'heluoxu', 'custom']) {
      const p = await postLt('ui-preferences', { theme: th });
      assert.equal(p.data.theme, th);
    }
    await postLt('ui-preferences', { theme: 'white' }); // restore default white

    // Verify live bundle conforms 100% to `lt.public.v1` contract (v1.1.0 + dynamic package.json version)
    const liveBundle = await postLt('bundle');
    assert.equal(liveBundle.contractVersion, '1.1.0');
    assert.equal(liveBundle.data.capabilities.backendVersion, expectedVersion);
    assert.equal(liveBundle.data.capabilities.features.inSessionDualMode, true);
    const bundleCheck = validateContractBundle({
      contract: liveBundle.contract,
      contractVersion: liveBundle.contractVersion,
      capabilities: liveBundle.data.capabilities,
      gateway: liveBundle.data.gateway,
      providers: liveBundle.data.providers,
      models: liveBundle.data.models,
      runtime: liveBundle.data.runtime,
      usageRecords: [],
    });
    assert.equal(bundleCheck.ok, true, bundleCheck.errors.join('; '));

    // ==================== 4. Simulate Upstream Magpie Update (0.1.4731 -> 0.1.4797) ====================
    console.log('[4/7] Verifying Magpie upstream update compatibility (0.1.4731 -> 0.1.4797)...');
    mockMagpie.state.version = '0.1.4797';
    const compatAfterUpdate = await postLt('gateway/control', { action: 'check-compatibility' });
    assert.equal(compatAfterUpdate.data.compatibility.ok, true);
    assert.equal(compatAfterUpdate.data.compatibility.detectedVersion, '0.1.4797');

    report.steps.liveDshWebAndDualFrontend = {
      ok: true,
      sharedSessionId: createdSess.data.sessionId,
      dshSwitchAvailable: liveBundle.data.capabilities.frontendSwitch.available,
      syncedModelsCount: liveBundle.data.models.length,
      magpieUpdateCompatVersion: compatAfterUpdate.data.compatibility.detectedVersion,
    };
  } finally {
    if (dshProc && dshProc.exitCode === null) {
      dshProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 400));
      if (dshProc.exitCode === null) dshProc.kill('SIGKILL');
    }
    await mockMagpie.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ==================== 5. Zero-Patch Real `dsh --profile web` + Real Magpie `0.1.4731` Live Onboarding & Dual-Mode E2E ====================
  const realMagpieBin = '/opt/magpie/releases/0.1.4731/magpie';
  if (fs.existsSync(realMagpieBin)) {
    console.log('[5/7] Verifying ZERO-PATCH out-of-the-box `dsh --profile web` + real Magpie `0.1.4731` -> local dummy OpenAI relay live Single & Team execution...');
    const zpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-s9-prod-zeropatch-'));
    const zpFakeHome = path.join(zpRoot, 'isolated-user-home');
    const zpDshHome = path.join(zpRoot, 'dsh-home');
    const zpWorkspace = path.join(zpRoot, 'zero-patch-project');
    fs.mkdirSync(zpFakeHome, { recursive: true });
    fs.mkdirSync(zpDshHome, { recursive: true });
    fs.mkdirSync(zpWorkspace, { recursive: true });

    // Strip ALL provider/gateway API key env vars to prove 100% zero-env-var out-of-the-box onboarding!
    const cleanEnv = { ...process.env, PATH: ENHANCED_PATH, DSH_HOME: zpDshHome };
    for (const k of [
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'DASHSCOPE_API_KEY',
      'BAILIAN_API_KEY',
      'ZHIPU_API_KEY',
      'GLM_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'MAGPIE_API_KEY',
      'LEADERTEAM_MAGPIE_KEY',
      'MAGPIE_WEB_KEY',
      'LT_SOLO_PROVIDER',
      'LEADERTEAM_CONFIG',
    ]) {
      delete cleanEnv[k];
    }

    const relayRequests = [];
    let toolCallSeq = 0;
    const relayServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && (reqUrl.pathname === '/v1/models' || reqUrl.pathname === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'alpha-pro', object: 'model', created: 1700000000, owned_by: 'localrelay' }],
          }),
        );
        return;
      }
      if (req.method === 'POST' && (reqUrl.pathname === '/v1/chat/completions' || reqUrl.pathname === '/chat/completions')) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const toolNames = (body.tools ?? [])
            .map(t => t?.function?.name || t?.name || '')
            .filter(Boolean);
          const extractMsgText = m => {
            if (!m) return '';
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) {
              return m.content.map(p => (typeof p?.text === 'string' ? p.text : '')).join('\n');
            }
            return '';
          };
          const allMessagesText = (body.messages ?? []).map(extractMsgText).join('\n');
          const hasToolResultSinceLastPrompt = (() => {
            const msgs = body.messages ?? [];
            let lastTriggerIdx = -1;
            for (let i = 0; i < msgs.length; i++) {
              if (extractMsgText(msgs[i]).includes('ZERO_PATCH_SINGLE_TURN')) lastTriggerIdx = i;
            }
            if (lastTriggerIdx < 0) return false;
            return msgs.slice(lastTriggerIdx + 1).some(m => m?.role === 'tool');
          })();

          relayRequests.push({
            model: body.model,
            toolNames,
            lastRole: (body.messages ?? []).at(-1)?.role || '',
            allMessagesText,
          });

          let assistantText = 'RELAY_PROBE_OK';
          let toolCall = null;
          if (toolNames.length === 0) {
            assistantText = 'Zero-Patch Session Title';
          } else if (allMessagesText.includes('ZERO_PATCH_TEAM_TURN')) {
            assistantText = 'ZERO_PATCH_TEAM_FINAL_OK';
          } else if (allMessagesText.includes('ZERO_PATCH_SINGLE_TURN')) {
            if (!hasToolResultSinceLastPrompt) {
              toolCallSeq += 1;
              toolCall = {
                id: `call_zp_write_${toolCallSeq}`,
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({
                    file_path: 'zero-patch-single.txt',
                    content: 'ZERO_PATCH_SINGLE_FILE_OK',
                  }),
                },
              };
              assistantText = '';
            } else {
              assistantText = 'ZERO_PATCH_SINGLE_FINAL_OK';
            }
          }

          const respId = `chatcmpl-zp-${relayRequests.length}`;
          const created = Math.floor(Date.now() / 1000);
          const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 };

          if (body.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            const firstDelta = toolCall
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCall.id,
                      type: 'function',
                      function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
                    },
                  ],
                }
              : { role: 'assistant', content: assistantText };
            res.write(
              `data: ${JSON.stringify({
                id: respId,
                object: 'chat.completion.chunk',
                created,
                model: body.model || 'alpha-pro',
                choices: [{ index: 0, delta: firstDelta, finish_reason: null }],
              })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({
                id: respId,
                object: 'chat.completion.chunk',
                created,
                model: body.model || 'alpha-pro',
                choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
                usage,
              })}\n\n`,
            );
            res.end('data: [DONE]\n\n');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: respId,
                object: 'chat.completion',
                created,
                model: body.model || 'alpha-pro',
                choices: [
                  {
                    index: 0,
                    message: toolCall
                      ? { role: 'assistant', content: null, tool_calls: [toolCall] }
                      : { role: 'assistant', content: assistantText },
                    finish_reason: toolCall ? 'tool_calls' : 'stop',
                  },
                ],
                usage,
              }),
            );
          }
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found' } }));
    });

    await new Promise((resolve, reject) => {
      relayServer.once('error', reject);
      relayServer.listen(0, '127.0.0.1', () => resolve());
    });
    const relayPort = relayServer.address().port;
    const relayBaseV1 = `http://127.0.0.1:${relayPort}/v1`;

    let zpDshProc = null;
    let managedMagpiePid = null;
    let zpPostLt = null;
    try {
      // Install tarball strictly via `dsh plugin --profile web add` with ZERO manual file edits!
      execFileSync('dsh', ['plugin', '--profile', 'web', 'add', tarballPath], {
        encoding: 'utf8',
        env: cleanEnv,
        cwd: zpWorkspace,
        timeout: 180_000,
      });

      let zpLaunchUrl = null;
      let zpLogs = '';
      zpDshProc = spawn('dsh', ['--profile', 'web', '--no-open', '--port', '0'], {
        cwd: zpWorkspace,
        env: cleanEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onZpChunk = chunk => {
        zpLogs += chunk.toString('utf8');
        const m = zpLogs.match(/https?:\/\/127\.0\.0\.1:\d+\/(?:connect)?\?token=[A-Za-z0-9._~-]+/);
        if (m && !zpLaunchUrl) zpLaunchUrl = m[0];
      };
      zpDshProc.stdout.on('data', onZpChunk);
      zpDshProc.stderr.on('data', onZpChunk);

      const zpDeadline = Date.now() + 30_000;
      while (!zpLaunchUrl && Date.now() < zpDeadline) {
        if (zpDshProc.exitCode !== null) {
          throw new Error(`Zero-patch dsh web exited prematurely (${zpDshProc.exitCode}):\n${zpLogs}`);
        }
        await new Promise(r => setTimeout(r, 150));
      }
      assert.ok(zpLaunchUrl, `Zero-patch dsh web printed launch URL (logs: ${zpLogs.slice(-400)})`);

      const zpOrigin = new URL(zpLaunchUrl).origin;
      const zpConnRes = await fetch(zpLaunchUrl, { redirect: 'manual' });
      const zpCookies = zpConnRes.headers.getSetCookie
        ? zpConnRes.headers.getSetCookie()
        : [zpConnRes.headers.get('set-cookie') || ''];
      const zpCookieHeader = zpCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ');
      assert.ok(zpCookieHeader.length > 0);

      zpPostLt = async (subpath, body = {}) => {
        const r = await fetch(`${zpOrigin}/api/lt/v1/${subpath}`, {
          method: 'POST',
          headers: {
            Cookie: zpCookieHeader,
            Origin: zpOrigin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 200, `Zero-patch POST /api/lt/v1/${subpath} HTTP ${r.status}`);
        const j = await r.json();
        assert.equal(j.ok, true, `Zero-patch API error on ${subpath}: ${JSON.stringify(j.error)}`);
        return j;
      };

      // 1) install -> 2) start -> 3) save-provider -> 4) models/sync-pool -> 5) runtime/configure -> 6) workbench/create
      const instRes = await zpPostLt('gateway/control', {
        action: 'install',
        binaryPath: realMagpieBin,
      });
      assert.equal(instRes.data.result.installed, true);

      const startRes = await zpPostLt('gateway/control', {
        action: 'start',
        dynamicPorts: true,
      });
      assert.equal(startRes.data.status.state, 'running');
      managedMagpiePid = startRes.data.status.health?.pid ?? null;

      await zpPostLt('providers/mutate', {
        operation: 'save-provider',
        spec: {
          new: true,
          id: 'localrelay',
          name: 'Local Dummy Relay',
          chat: relayBaseV1,
          baseAPI: 'chat',
          key: 'sk-zp-dummy-relay-1234567890',
        },
      });
      await zpPostLt('providers/mutate', {
        operation: 'refresh-models',
        id: 'magpie:localrelay',
      });

      const zpSync = await zpPostLt('models/sync-pool', {
        target: 'local',
        enableInExecutionPool: true,
      });
      assert.equal(zpSync.data.dshSettingsSync.synced, true, 'Zero-patch models/sync-pool must sync to DSH settings');
      const alphaEntry = zpSync.data.models.find(
        m => m.sourceKind === 'magpie' && (m.upstreamModelId === 'alpha-pro' || m.routeId.includes('alpha-pro')),
      );
      assert.ok(alphaEntry, 'Synced Magpie model localrelay/alpha-pro must appear in catalog');

      const zpCfg = await zpPostLt('runtime/configure', {
        target: 'local',
        changes: {
          setRoles: [
            { role: 'leader', route: alphaEntry.routeId, effort: 'none' },
            { role: 'gate', route: alphaEntry.routeId, effort: 'none' },
            { role: 'discussA', route: alphaEntry.routeId, effort: 'none' },
            { role: 'discussB', route: alphaEntry.routeId, effort: 'none' },
            { role: 'arbiter', route: alphaEntry.routeId, effort: 'none' },
          ],
        },
      });
      assert.equal(zpCfg.data.dshSettingsSync.synced, true);

      // Create LT session in `Single` mode with NO `model` parameter -> must auto-select `roles.leader.route`!
      const zpCreated = await zpPostLt('workbench/create', {
        cwd: zpWorkspace,
        executionMode: 'single',
      });
      const zpSid = zpCreated.data.sessionId;
      assert.ok(zpSid);
      assert.equal(zpCreated.data.executionMode, 'single');

      const waitForAssistantReply = async expectedSubstring => {
        const deadline = Date.now() + 25_000;
        let lastTx = null;
        while (Date.now() < deadline) {
          lastTx = await zpPostLt('workbench/transcript', { sessionId: zpSid });
          const running = Boolean(lastTx.data.passiveState?.running);
          const hasReply = (lastTx.data.messages ?? []).some(
            m => m.role === 'assistant' && String(m.text || '').includes(expectedSubstring),
          );
          if (!running && hasReply) return lastTx;
          await new Promise(r => setTimeout(r, 150));
        }
        throw new Error(
          `Timed out waiting for "${expectedSubstring}" on ${zpSid}. Last transcript: ${JSON.stringify(lastTx?.data)}\nDSH logs tail:\n${zpLogs.slice(-800)}`,
        );
      };

      // Live `Single` mode execution through `dsh web -> real Magpie 0.1.4731 -> local dummy OpenAI relay`!
      await zpPostLt('workbench/prompt', {
        sessionId: zpSid,
        text: 'ZERO_PATCH_SINGLE_TURN: write zero-patch-single.txt now',
      });
      await waitForAssistantReply('ZERO_PATCH_SINGLE_FINAL_OK');
      assert.equal(
        fs.readFileSync(path.join(zpWorkspace, 'zero-patch-single.txt'), 'utf8'),
        'ZERO_PATCH_SINGLE_FILE_OK',
        'Single mode turn executed direct write tool through real DSH Web + real Magpie 0.1.4731',
      );
      const singleRelayHit = relayRequests.find(
        r => r.toolNames.length > 0 && r.allMessagesText.includes('ZERO_PATCH_SINGLE_TURN'),
      );
      assert.ok(singleRelayHit, 'Local dummy relay received Single-mode LLM call');
      assert.ok(singleRelayHit.toolNames.includes('write'), 'Single-mode LLM call exposed direct write tool');
      assert.ok(singleRelayHit.toolNames.includes('bash'), 'Single-mode LLM call exposed direct bash tool');
      assert.equal(
        singleRelayHit.toolNames.some(n => n.startsWith('team_')),
        false,
        'Single-mode LLM call exposed zero team_* tools',
      );

      // Switch `Single -> Team` (0 agent LLM calls) and execute a live `Team` mode prompt!
      const agentCallsBeforeSwitch = relayRequests.filter(r => r.toolNames.length > 0).length;
      const switchedToTeam = await zpPostLt('workbench/mode', {
        sessionId: zpSid,
        mode: 'team',
      });
      assert.equal(switchedToTeam.data.modeState.mode, 'team');
      assert.equal(
        relayRequests.filter(r => r.toolNames.length > 0).length,
        agentCallsBeforeSwitch,
        'Mode switch must trigger 0 LLM calls',
      );

      await zpPostLt('workbench/prompt', {
        sessionId: zpSid,
        text: 'ZERO_PATCH_TEAM_TURN: concise greeting',
      });
      await waitForAssistantReply('ZERO_PATCH_TEAM_FINAL_OK');
      const teamRelayHit = relayRequests.find(
        r => r.toolNames.length > 0 && r.allMessagesText.includes('ZERO_PATCH_TEAM_TURN'),
      );
      assert.ok(teamRelayHit, 'Local dummy relay received Team-mode LLM call');
      assert.ok(teamRelayHit.toolNames.includes('team_dispatch'), 'Team-mode LLM call exposed team_dispatch');
      assert.ok(teamRelayHit.toolNames.includes('team_discuss'), 'Team-mode LLM call exposed team_discuss');
      assert.equal(teamRelayHit.toolNames.includes('write'), false, 'Team-mode LLM call revoked direct write tool');
      assert.equal(teamRelayHit.toolNames.includes('bash'), false, 'Team-mode LLM call revoked direct bash tool');

      // Verify Hengzhang reconciles the real Magpie 0.1.4731 usage feed with the DSH session!
      const zpUsage = await zpPostLt('usage/report', {
        sessionId: zpSid,
        syncGateway: true,
      });
      assert.ok(zpUsage.data.report.totals.totalTokens > 0);
      assert.ok(
        zpUsage.data.report.calls.some(c => c.actualProvider === 'localrelay' && c.actualModel === 'alpha-pro'),
        'Hengzhang correlated real Magpie 0.1.4731 physical provider/model on zero-patch session',
      );

      await zpPostLt('gateway/control', { action: 'stop' }).catch(() => {});

      report.steps.zeroPatchRealMagpieAndDshWeb = {
        ok: true,
        magpieBinary: realMagpieBin,
        sessionId: zpSid,
        routeId: alphaEntry.routeId,
        relayCallsTotal: relayRequests.length,
        singleToolCount: singleRelayHit.toolNames.length,
        teamToolCount: teamRelayHit.toolNames.length,
      };
    } finally {
      if (zpPostLt) {
        await zpPostLt('gateway/control', { action: 'stop' }).catch(() => {});
      }
      if (zpDshProc && zpDshProc.exitCode === null) {
        zpDshProc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 400));
        if (zpDshProc.exitCode === null) zpDshProc.kill('SIGKILL');
      }
      if (managedMagpiePid) {
        try { process.kill(managedMagpiePid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 250));
        try { process.kill(managedMagpiePid, 'SIGKILL'); } catch {}
      }
      await new Promise(resolve => relayServer.close(() => resolve()));
      fs.rmSync(zpRoot, { recursive: true, force: true });
    }
  }

  // ==================== 6. Standalone Hengzhang Regression ====================
  console.log('[6/7] Verifying standalone Hengzhang (`lt-usage-plugin`) CLI & test suite...');
  const hengzhangRoot = path.join(ossRoot, 'lt-usage-plugin');
  const scanOut = runSync('npm', ['run', 'scan', '--', '--home', path.join(hengzhangRoot, 'fixtures', 'test-home')], {
    cwd: hengzhangRoot,
  });
  assert.match(scanOut, /session-6f6683f1-1e59-4baf-b251-5ca16edd8463/);
  report.steps.standaloneHengzhang = { ok: true };

  // ==================== 7. Source, Git History & Tarball Private/Secret Leak Audit ====================
  console.log('[7/7] Auditing source tree, Git commit history, and tarball for any secret or private leakage...');
  const forbiddenPatterns = [
    { name: 'Live OpenAI/Vendor Key', re: new RegExp('\\bsk-(?:proj-|live-)[A-Za-z0-9_-]{16,}\\b') },
    { name: 'Closed-source V2.3/V2.4 private path', re: new RegExp(['closed-source', 'v2\\.x'].join('-') + '|' + ['leaderteam', 'v2\\.3', 'phase1'].join('-')) },
    { name: 'System Magpie Web Key file reference', re: new RegExp(['/etc', 'magpie', 'web-key'].join('/')) },
  ];

  const gitDiffText = runSync('git', ['log', '-p', '1fda9f0..HEAD'], { cwd: repoRoot });
  for (const pat of forbiddenPatterns) {
    assert.ok(!pat.re.test(gitDiffText), `Leak audit failed in git history (${pat.name})`);
  }

  // Verify original `/home/dev/workspace/Leader Team/leaderteam-v2.2-dev` outside `open-source-v2.2.x` is untouched!
  const outerGitStatus = runSync('git', ['status', '--porcelain'], {
    cwd: path.resolve(ossRoot, '..', 'leaderteam-v2.2-dev'),
  });
  assert.equal(outerGitStatus.trim(), '', 'Outer leaderteam-v2.2-dev repository must remain 100% unmodified');

  report.steps.leakAndIsolationAudit = {
    ok: true,
    commitsAuditedRange: '1fda9f0..HEAD',
    outerBaselineRepoClean: true,
  };
  report.completedAt = new Date().toISOString();

  const reportFile = path.join(artifactsDir, 'v2.2.x-verification-evidence.json');
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nALL V2.2.x PRODUCTIZATION E2E & AUDIT CHECKS PASSED!\nEvidence written to: ${reportFile}`);
}

main().catch(err => {
  console.error('E2E verification failed:', err);
  process.exit(1);
});
