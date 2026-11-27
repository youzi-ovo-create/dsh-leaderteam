import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_API_ROUTES,
  PUBLIC_READONLY_API_ROUTES,
  createPublicContractHandlers,
  encodeDshSegment,
  extractReadableMessagesFromRows,
  findDurableSessionRows,
  registerLtNativeFrontendStaticRoute,
  resolveLtWebDistDir,
  serveLtWebStaticRequest,
} from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { scanNoSecretLeakage } from '../../../lt-shared-contracts/tests/contract-validator.mjs';
import { startMockMagpieServer } from '../../../lt-shared-contracts/mocks/mock-magpie-server.mjs';
import { createPanelHandlers } from '../../leaderteam/plugins/leaderteam-panel/panel-api.mjs';
import { startStandaloneLtUiServer } from '../../bin/lt-ui.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { applyModelConfigChanges, inspectDesktopSync, inspectModelConfiguration } from '../../leaderteam/core/model-config-writer.mjs';
import { startModelConfigServer } from '../../leaderteam/core/model-config-ui.mjs';
import { bindRuntimeConfigFile } from '../../leaderteam/host/runtime.mjs';
import { PlanArchiveStore, resolvePlanArchiveRoot } from '../../leaderteam/core/plan-archive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function makeTempDir(t, suffix = 'case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-s2-ui-${suffix}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeJsonPost(body = {}, url = 'http://127.0.0.1/api/lt/v1/test') {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeFakeRuntime(tmpDir, cfgOverrides = null) {
  const dshHome = path.join(tmpDir, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const cfgDir = path.join(storageRoot, 'config');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });

  for (const name of ['leaderteam.config.json', 'desktop-magpie.patch.yml', 'magpie-models.patch.yml']) {
    fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(cfgDir, name));
  }
  const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
  if (cfgOverrides) {
    const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    Object.assign(raw, cfgOverrides);
    fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  }
  const rt = {
    storageRoot,
    configPath: cfgFile,
    config: loadConfig(cfgFile),
    plugins: {
      scheduler: { version: '2.2.2' },
      consensus: { version: '2.2.2' },
      timerArchive: { version: '2.2.2' },
      panel: { version: '2.2.2' },
    },
    cordisCompositionMode: true,
    stores: new Map(),
    actors: new Map(),
  };
  bindRuntimeConfigFile(rt, cfgFile, rt.config);
  return { dshHome, storageRoot, cfgDir, cfgFile, rt };
}

test('UI-01 & UI-05: standalone lt-ui enforces exact Host port, port-scoped cookie, strict Origin, JSON Content-Type, 2 MiB body cap, and URIError-safe cookies', async t => {
  const tmpDir = makeTempDir(t, 'ui01-05');
  const { dshHome, cfgFile } = makeFakeRuntime(tmpDir);

  const prevDshHome = process.env.DSH_HOME;
  t.after(() => {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  });

  const uiSrv = await startStandaloneLtUiServer({ port: 0, dshHome, configPath: cfgFile, requireAuth: true });
  t.after(() => uiSrv.close());

  // 1. Host port mismatch (`localhost:99999`) rejected with 403
  const wrongPortHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: uiSrv.port,
        path: '/api/lt/v1/capabilities',
        method: 'POST',
        headers: {
          Host: 'localhost:99999',
          Authorization: `Bearer ${uiSrv.token}`,
          'Content-Type': 'application/json',
        },
      },
      res => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(wrongPortHostStatus, 403);

  // 2. Token redirect sets port-scoped cookie + Cache-Control: no-store + Referrer-Policy: no-referrer
  const loginRes = await fetch(uiSrv.launchUrl, { redirect: 'manual' });
  assert.equal(loginRes.status, 302);
  assert.equal(loginRes.headers.get('cache-control'), 'no-store');
  assert.equal(loginRes.headers.get('referrer-policy'), 'no-referrer');
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const expectedCookieName = `lt_workbench_sid_${uiSrv.port}`;
  assert.ok(setCookie.startsWith(`${expectedCookieName}=`), `Expected port-scoped cookie, got: ${setCookie}`);
  const validCookiePair = setCookie.split(';')[0];

  // Cookie from another port (`lt_workbench_sid_9999`) must NOT authenticate
  const wrongPortCookieRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/capabilities`, {
    method: 'POST',
    headers: {
      Cookie: `lt_workbench_sid_9999=${validCookiePair.split('=')[1]}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(wrongPortCookieRes.status, 401);

  // 3. Malformed sibling cookie (`%E0%A4%A`) must not trigger 500 URIError DoS
  const malformedCookieRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/capabilities`, {
    method: 'POST',
    headers: {
      Cookie: `foreign_bad=%E0%A4%A; ${validCookiePair}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(malformedCookieRes.status, 200);

  // 4. Cross-port Origin, Origin: null, and Sec-Fetch-Site: same-site blocked with 403
  for (const badHeaders of [
    { Origin: 'http://127.0.0.1:9999' },
    { Origin: 'null' },
    { Origin: `https://127.0.0.1:${uiSrv.port}` },
    { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    const csrfRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/ui-preferences`, {
      method: 'POST',
      headers: {
        Cookie: validCookiePair,
        'Content-Type': 'application/json',
        ...badHeaders,
      },
      body: JSON.stringify({ theme: 'dark' }),
    });
    assert.equal(csrfRes.status, 403, `Expected 403 for headers ${JSON.stringify(badHeaders)}`);
  }

  // Exact same-port Origin succeeds
  const sameOriginRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/ui-preferences`, {
    method: 'POST',
    headers: {
      Cookie: validCookiePair,
      Origin: `http://127.0.0.1:${uiSrv.port}`,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme: 'heluoxu' }),
  });
  assert.equal(sameOriginRes.status, 200);

  // 5. POST with Content-Type: text/plain rejected with 415 (blocks <form enctype="text/plain"> CSRF)
  const textPlainRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/ui-preferences`, {
    method: 'POST',
    headers: {
      Cookie: validCookiePair,
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify({ theme: 'dark' }),
  });
  assert.equal(textPlainRes.status, 415);
  const textPlainJson = await textPlainRes.json();
  assert.equal(textPlainJson.error.code, 'UNSUPPORTED_MEDIA_TYPE');

  // Empty POST with Content-Length: 0 allowed
  const emptyPostRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/capabilities`, {
    method: 'POST',
    headers: {
      Cookie: validCookiePair,
    },
  });
  assert.equal(emptyPostRes.status, 200);

  // 6. Body > 2 MiB rejected with 413 PAYLOAD_TOO_LARGE
  const hugePayload = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 4096) });
  const tooLargeRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/ui-preferences`, {
    method: 'POST',
    headers: {
      Cookie: validCookiePair,
      'Content-Type': 'application/json',
    },
    body: hugePayload,
  });
  assert.equal(tooLargeRes.status, 413);
  const tooLargeJson = await tooLargeRes.json();
  assert.equal(tooLargeJson.error.code, 'PAYLOAD_TOO_LARGE');
});

test('UI-02: workbenchTranscript confines session paths + encodes segments, and usage/* locks down arbitrary body.home', async t => {
  const tmpDir = makeTempDir(t, 'ui02');
  const { dshHome, rt } = makeFakeRuntime(tmpDir);

  // Seed a sensitive zstd session file OUTSIDE `<dshHome>/sessions`
  const outsideDir = path.join(tmpDir, 'outside-secret');
  fs.mkdirSync(outsideDir, { recursive: true });
  const secretRows = [
    { type: 'session', id: 'outside', time: 1 },
    { type: 'user/message', seq: 1, time: 2, data: { message: { id: 'm-secret', content: [{ type: 'text', text: 'TRAVERSED_SECRET' }] } } },
  ];
  const secretZstd = zlib.zstdCompressSync(Buffer.from(secretRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
  fs.writeFileSync(path.join(outsideDir, 'session.v4.jsonl.zstd'), secretZstd);

  // Seed `<dshHome>/sessions/proj-a` + an escaping symlink + an encoded `session:1` directory (`session~003A1`) + uncompressed `.jsonl`
  const slugDir = path.join(dshHome, 'sessions', 'proj-a');
  fs.mkdirSync(slugDir, { recursive: true });
  fs.symlinkSync(outsideDir, path.join(slugDir, 'symlink-escape'), 'dir');

  assert.equal(encodeDshSegment('session:1'), 'session~003A1');
  assert.equal(encodeDshSegment('..'), '~002E~002E');
  assert.equal(encodeDshSegment('.'), '~002E');

  const encodedDir = path.join(slugDir, 'session~003A1');
  fs.mkdirSync(encodedDir, { recursive: true });
  const encodedRows = [
    { type: 'session', id: 'session:1', time: 10 },
    { type: 'user/message', seq: 1, time: 11, data: { message: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Encoded session hello' }] } } },
  ];
  fs.writeFileSync(path.join(encodedDir, 'session.v4.jsonl'), encodedRows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const fakeCtx = {
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return null;
    },
  };
  const h = createPublicContractHandlers(fakeCtx, rt);

  // Traversal via `../../outside-secret` must return 0 messages
  const travRes = await (await h.workbenchTranscript(makeJsonPost({ sessionId: '../../../outside-secret' }))).json();
  assert.equal(travRes.ok, true);
  assert.deepEqual(travRes.data.messages, []);

  // Symlink escape inside `sessions/proj-a/symlink-escape` must be blocked by realpath containment
  assert.equal(findDurableSessionRows(dshHome, 'symlink-escape'), null);
  const symRes = await (await h.workbenchTranscript(makeJsonPost({ sessionId: 'symlink-escape' }))).json();
  assert.deepEqual(symRes.data.messages, []);

  // Legitimate `session:1` resolves `session~003A1/session.v4.jsonl` cleanly
  const okTranscript = await (await h.workbenchTranscript(makeJsonPost({ sessionId: 'session:1' }))).json();
  assert.equal(okTranscript.ok, true);
  assert.equal(okTranscript.data.messages.length, 1);
  assert.equal(okTranscript.data.messages[0].text, 'Encoded session hello');

  // Foreign `body.home` on all 4 usage endpoints must return HTTP 403 FORBIDDEN_HOME
  const foreignHome = path.join(tmpDir, 'foreign-dsh-home');
  fs.mkdirSync(path.join(foreignHome, 'sessions'), { recursive: true });
  for (const fn of [h.usageStatus, h.usageOverview, h.usageSessions, h.usageReport]) {
    const rawRes = await fn(makeJsonPost({ home: foreignHome, sessionId: 'x' }));
    assert.equal(rawRes.status, 403);
    const body = await rawRes.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'FORBIDDEN_HOME');
  }

  // Omitted `body.home` and exact server `dshHome` succeed
  const statusDefault = await (await h.usageStatus(makeJsonPost({}))).json();
  assert.equal(statusDefault.ok, true);
  assert.equal(statusDefault.data.dshHome, dshHome);

  const statusSameHome = await (await h.usageStatus(makeJsonPost({ home: dshHome }))).json();
  assert.equal(statusSameHome.ok, true);
});

test('UI-03 & UI-08: DSH 0.2.2-rc.5 SessionSummary projections/filtering, live ctx.sessions & sessionController.events, and synthetic/replace filtering', async t => {
  const tmpDir = makeTempDir(t, 'ui03-08');
  const { dshHome, rt } = makeFakeRuntime(tmpDir);

  const liveSessionRows = [
    { type: 'user/message', seq: 0, time: 100, data: { message: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: 'Initial user prompt' }] } } },
    { type: 'assistant/message', seq: 1, time: 110, data: { message: { id: 'a0', source: { model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Initial assistant reply' }] } } },
    { type: 'user/message', seq: 2, time: 120, data: { message: { id: 'u-inject', source: { kind: 'inject' }, content: [{ type: 'text', text: '<system-reminder>AGENTS.md</system-reminder>' }] } } },
    { type: 'user/message', seq: 3, time: 130, data: { message: { id: 'u-retry', source: { kind: 'retry' }, content: [] } } },
    { type: 'user/message', seq: 4, time: 140, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, data: { message: { id: 'u-compact', source: { kind: 'compaction' }, content: [{ type: 'text', text: 'Compacted summary of turns 0..1' }] } } },
    { type: 'user/message', seq: 5, time: 150, data: { message: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'Follow-up human prompt' }] } } },
  ];

  const fakeCtx = {
    workspaceRegistry: {
      archivedSessionIds: new Set(['sess-archived']),
      list() {
        return [{ id: 'ws-main', path: tmpDir, title: 'Main Repo', sessionIds: ['sess-root'] }];
      },
    },
    sessions: new Map([
      ['sess-live-attached', { snapshotEvents: () => liveSessionRows }],
    ]),
    sessionController: {
      async list() {
        return {
          items: [
            {
              sessionId: 'sess-root',
              cwd: tmpDir,
              updatedAt: 5000,
              projections: { values: { title: 'Projected Root Title', agentPreset: 'leaderteam' } },
            },
            {
              sessionId: 'sess-subagent-1',
              origin: 'subagent',
              parentSessionId: 'sess-root',
              cwd: tmpDir,
              projections: { values: { title: 'Worker 1', agentPreset: 'member' } },
            },
            {
              sessionId: 'sess-blank',
              blank: true,
              cwd: tmpDir,
            },
            {
              sessionId: 'sess-archived',
              cwd: tmpDir,
              projections: { values: { title: 'Old Archived' } },
            },
          ],
        };
      },
      async events(req) {
        if (req?.address?.sessionId === 'sess-via-events') {
          return {
            events: [
              { type: 'user/message', seq: 0, time: 200, data: { message: { id: 'ue1', source: { kind: 'user' }, content: [{ type: 'text', text: 'From sessionController.events' }] } } },
            ],
          };
        }
        return { events: [] };
      },
      async state({ sessionId }) {
        return { running: sessionId === 'sess-live-attached' };
      },
      async create() {
        return { sessionId: 'sess-blank' };
      },
    },
    get(key) {
      if (key === 'profileContext') return { home: dshHome };
      return this[key] ?? null;
    },
  };

  const h = createPublicContractHandlers(fakeCtx, rt);

  const listRes = await (await h.workbenchSessions()).json();
  assert.equal(listRes.ok, true);
  assert.equal(listRes.data.sessions.length, 1);
  assert.deepEqual(listRes.data.sessions[0], {
    sessionId: 'sess-root',
    title: 'Projected Root Title',
    cwd: tmpDir,
    agentPreset: 'leaderteam',
    updatedAt: 5000,
    isTeam: false,
  });

  // Explicitly created workbench session appears in workbenchSessions even before first prompt (`blank: true`)
  const createRes = await (await h.workbenchCreate(makeJsonPost({ cwd: tmpDir, agentPreset: 'leaderteam' }))).json();
  assert.equal(createRes.ok, true);
  const listAfterCreate = await (await h.workbenchSessions()).json();
  assert.equal(listAfterCreate.data.sessions.length, 2);
  assert.ok(listAfterCreate.data.sessions.some(s => s.sessionId === 'sess-blank'));

  // Live attached session via `ctx.sessions.get` + synthetic filtering + DSH 0.2.2-rc.5 model-only compaction `replace`
  const trLive = await (await h.workbenchTranscript(makeJsonPost({ sessionId: 'sess-live-attached' }))).json();
  assert.equal(trLive.ok, true);
  assert.equal(trLive.data.passiveState.running, true);
  assert.deepEqual(
    trLive.data.messages.map(m => ({ id: m.id, role: m.role, text: m.text })),
    [
      { id: 'u0', role: 'user', text: 'Initial user prompt' },
      { id: 'a0', role: 'assistant', text: 'Initial assistant reply' },
      { id: 'u2', role: 'user', text: 'Follow-up human prompt' },
    ],
  );

  // Fallback to `sessionController.events` before disk
  const trEvents = await (await h.workbenchTranscript(makeJsonPost({ sessionId: 'sess-via-events' }))).json();
  assert.equal(trEvents.ok, true);
  assert.equal(trEvents.data.messages.length, 1);
  assert.equal(trEvents.data.messages[0].text, 'From sessionController.events');
  assert.equal(trEvents.data.passiveState.running, false);

  // Direct `extractReadableMessagesFromRows` seed skip check
  assert.deepEqual(
    extractReadableMessagesFromRows([{ type: 'user/message', surfaceOp: { op: 'seed' }, data: { text: 'seed' } }]),
    [],
  );
});

test('UI-04, CH-14 & UI-13: local->base promotion, fallback auto-upserts, live Magpie role selection, leader.maxTokens, inspectDesktopSync fallbacks, clearLocalOverrides, and model-config-ui fixes', async t => {
  const tmpDir = makeTempDir(t, 'ui04-ch14');
  const { dshHome, cfgDir, cfgFile, rt } = makeFakeRuntime(tmpDir);
  const localFile = path.join(cfgDir, 'leaderteam.local.json');

  // Seed Desktop cordis.patch.yml for inspectDesktopSync fallback check (CH-14)
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  fs.mkdirSync(profileDir, { recursive: true });
  const desktopBlock = fs.readFileSync(path.join(cfgDir, 'desktop-magpie.patch.yml'), 'utf8')
    .replace('__MAGPIE_BASEURL__', 'http://127.0.0.1:3425/v1')
    .trim();
  fs.writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    `# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)\n${desktopBlock}\n# <<< leaderteam\n`,
    'utf8',
  );

  // 1. CH-14: preserve `roles.leader.maxTokens` across `setRoles` AND flag missing fallback route in `inspectDesktopSync`
  const withMaxTok = applyModelConfigChanges(
    {
      upsertModels: [{ route: 'zcode/GLM-99-Fallback', family: 'glm', label: 'GLM 99', efforts: ['low', 'high'], defaultEffort: 'high' }],
      setRoles: [
        { role: 'leader', route: 'zcode/GLM-5.3', effort: 'high', maxTokens: 24576 },
        { role: 'gate', route: 'zcode/GLM-5.3', effort: 'low', fallback: [{ route: 'zcode/GLM-99-Fallback', effort: 'high' }] },
      ],
    },
    { configFile: cfgFile, dshHome, syncPatches: false },
  );
  assert.equal(withMaxTok.effective.roles.leader.maxTokens, 24576);
  assert.equal(withMaxTok.desktopSync.hotReloadableNow, false, 'Fallback route missing from cordis.patch.yml must mark hotReloadableNow=false');
  assert.ok(withMaxTok.desktopSync.missingActiveRoutes.includes('zcode/GLM-99-Fallback'));

  // Updating leader route/effort without specifying maxTokens MUST preserve 24576
  const afterLeaderSwitch = applyModelConfigChanges(
    { setRoles: [{ role: 'leader', route: 'zcode/GLM-5.3-Flash', effort: 'high' }] },
    { configFile: cfgFile, dshHome, syncPatches: false },
  );
  assert.equal(afterLeaderSwitch.effective.roles.leader.maxTokens, 24576);
  assert.equal(inspectDesktopSync(loadConfig(cfgFile), { dshHome }).missingActiveRoutes.includes('zcode/GLM-99-Fallback'), true);

  // 2. Mock live Magpie `/v1/models` + DSH `settings` to test un-imported Magpie model selection in role & fallback, local->base promotion, and clearLocalOverrides
  const magpieStub = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/') {
      res.end(JSON.stringify({ name: 'magpie', version: '0.1.4731', pid: process.pid, models: 2 }));
      return;
    }
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'anthropic/claude-4-sonnet', owned_by: 'anthropic', reasoning_levels: ['none', 'low', 'high'], context_window: 200000, max_output_tokens: 16384 },
          { id: 'openai/gpt-5-pro', owned_by: 'openai', reasoning_levels: ['low', 'medium', 'high'], context_window: 400000, max_output_tokens: 32768 },
        ],
      }));
      return;
    }
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
  await new Promise(resolve => magpieStub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => magpieStub.close(() => resolve())));
  const gwUrl = `http://127.0.0.1:${magpieStub.address().port}`;

  let savedSettingsData = null;
  const fakeCtx = {
    get(key) {
      if (key === 'profileContext') return { home: dshHome };
      if (key === 'settings') {
        return {
          describe() {
            return { namespaces: [{ ns: 'llm-pi-ai', data: { providers: {} } }] };
          },
          async update(_ns, data) {
            savedSettingsData = data;
          },
        };
      }
      return null;
    },
  };

  const h = createPublicContractHandlers(fakeCtx, rt);
  await h.gatewayControl(makeJsonPost({
    action: 'configure',
    config: { mode: 'external', externalGatewayUrl: gwUrl },
  }));

  // 2a. Select un-imported Magpie models directly in primary AND fallback slots (target: 'local') -> succeeds without BAD_CONFIG!
  const roleSaveLocal = await (await h.runtimeConfigure(makeJsonPost({
    target: 'local',
    changes: {
      poolSet: ['openai/gpt-5-pro'],
      setRoles: [
        {
          role: 'gate',
          route: 'zcode/GLM-5.3',
          effort: 'low',
          fallback: [{ route: 'anthropic/claude-4-sonnet', effort: 'off' }],
        },
      ],
      leaderModelPolicy: 'off',
    },
  }))).json();
  assert.equal(roleSaveLocal.ok, true, JSON.stringify(roleSaveLocal));
  assert.equal(roleSaveLocal.data.runtime.roleAssignments.gate.fallback[0].route, 'anthropic/claude-4-sonnet');
  assert.deepEqual(
    roleSaveLocal.data.runtime.configuredModelsMap['anthropic/claude-4-sonnet'].reasoningEfforts,
    { off: 'none', low: 'low', high: 'high' },
  );
  // Verify DSH settings live-sync registered dynamic Magpie baseURL + fallback model + reasoningEfforts
  assert.equal(savedSettingsData?.providers?.magpie?.baseURL, `${gwUrl}/v1`);
  assert.ok(savedSettingsData?.providers?.magpie?.models?.some(m => m.id === 'anthropic/claude-4-sonnet'));

  // 2b. Save to `base` using `openai/gpt-5-pro` (which was only in `local`) -> promotes model to `base` without BAD_CONFIG AND reports `shadowedByLocal`!
  const baseSave = await (await h.runtimeConfigure(makeJsonPost({
    target: 'base',
    changes: {
      poolSet: ['openai/gpt-5-pro', 'zcode/GLM-5.3'],
      leaderModelPolicy: 'warn',
    },
  }))).json();
  assert.equal(baseSave.ok, true, JSON.stringify(baseSave));
  assert.ok(baseSave.data.shadowedByLocal.includes('team.executionPool'));
  assert.ok(baseSave.data.shadowedByLocal.includes('team.leaderModelPolicy'));
  assert.equal(baseSave.data.runtime.localOverrides.exists, true);

  // 2c. Seed machine-local `quota` in `leaderteam.local.json`, then clearLocalOverrides -> clears local model/role/pool overrides while preserving `quota`!
  const curLocal = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  curLocal.quota = { allowUnknownGpt: true };
  fs.writeFileSync(localFile, JSON.stringify(curLocal, null, 2) + '\n', 'utf8');

  const clearRes = await (await h.runtimeConfigure(makeJsonPost({
    target: 'local',
    changes: { clearLocalOverrides: true },
  }))).json();
  assert.equal(clearRes.ok, true);
  assert.deepEqual(clearRes.data.runtime.modelPool.executionPool, ['openai/gpt-5-pro', 'zcode/GLM-5.3']);
  assert.equal(clearRes.data.runtime.leaderModelPolicy, 'warn');
  const cleanedLocal = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  assert.equal(cleanedLocal.quota.allowUnknownGpt, true);
  assert.equal(cleanedLocal.models, undefined);
  assert.equal(cleanedLocal.roles, undefined);

  // 2d. Panel API (`panel-api.mjs`) also supports un-imported Magpie models and DSH settings sync
  const panelHandlers = createPanelHandlers(fakeCtx, rt);
  const panelApply = await (await panelHandlers.apply(makeJsonPost({
    target: 'local',
    changes: {
      setRoles: [{ role: 'discussA', route: 'anthropic/claude-4-sonnet', effort: 'high' }],
    },
  }))).json();
  assert.equal(panelApply.ok, true);
  assert.equal(panelApply.value.dshSettingsSync.synced, true);

  // 3. `model-config-ui.mjs`: directExec in ROLE_META, NaN-safe numeric fields, and local `removeModels`
  applyModelConfigChanges(
    { upsertModels: [{ route: 'custom/local-ephemeral', family: 'other', label: 'Local Ephemeral', efforts: ['none'], defaultEffort: 'none', enableInPool: true }] },
    { configFile: cfgFile, target: 'local' },
  );
  const mcSrv = await startModelConfigServer({
    configFile: cfgFile,
    localFile,
    dshHome,
    backupRoot: path.join(tmpDir, 'mc-backups'),
  });
  t.after(() => mcSrv.close());

  const mcHtml = await (await fetch(mcSrv.url)).text();
  assert.match(mcHtml, /directExec:/);
  const removeLocalRes = await fetch(`${mcSrv.url}api/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-LT-Token': mcSrv.csrfToken },
    body: JSON.stringify({
      target: 'local',
      dryRun: false,
      changes: {
        removeModels: ['custom/local-ephemeral'],
        prunePool: true,
      },
    }),
  });
  assert.equal(removeLocalRes.status, 200);
  const snapAfterRemove = inspectModelConfiguration({ configFile: cfgFile, localFile });
  assert.equal(snapAfterRemove.models.some(m => m.route === 'custom/local-ephemeral'), false);
});

test('GW-04 & CT-01 alignment: providersMutate supports oauth-cancel and mutate-login', async t => {
  const tmpDir = makeTempDir(t, 'gw04-align');
  const { dshHome, rt } = makeFakeRuntime(tmpDir);

  const calls = [];
  const magpieStub = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    calls.push({ method: req.method, url: req.url, body: bodyText ? JSON.parse(bodyText) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/') {
      res.end(JSON.stringify({ name: 'magpie', version: '0.1.4731', pid: process.pid, models: 0 }));
      return;
    }
    if (req.url?.startsWith('/api/signin/') && req.url.endsWith('/cancel')) {
      res.end(JSON.stringify({ cancelled: true }));
      return;
    }
    if (req.url?.startsWith('/api/login/')) {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/providers') {
      res.end(JSON.stringify({ providers: [], presets: [] }));
      return;
    }
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise(resolve => magpieStub.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => magpieStub.close(() => resolve())));
  const stubUrl = `http://127.0.0.1:${magpieStub.address().port}`;

  const fakeCtx = { get: k => (k === 'profileContext' ? { home: dshHome } : null) };
  const h = createPublicContractHandlers(fakeCtx, rt);
  await h.gatewayControl(makeJsonPost({
    action: 'configure',
    config: { mode: 'external', externalGatewayUrl: stubUrl, externalWebAdminUrl: stubUrl, externalWebKey: 'test-web-key-1234567890' },
  }));

  // Verify `oauth-cancel` and `mutate-login` dispatch to MagpieClient methods (if already landed by sibling worker or via prototype stub)
  const mgr = (await import('../../leaderteam/gateway/index.mjs')).getOrCreateGatewayManager(rt.storageRoot);
  const sampleClient = mgr.createClient();
  const hasNativeCancel = typeof sampleClient.cancelSignIn === 'function';
  const hasNativeMutateLogin = typeof sampleClient.mutateLogin === 'function';
  const proto = Object.getPrototypeOf(sampleClient);
  if (!hasNativeCancel) {
    proto.cancelSignIn = async signInId => ({ id: signInId, state: 'cancelled' });
  }
  if (!hasNativeMutateLogin) {
    proto.mutateLogin = async (action, payload) => ({ action, ...payload });
  }
  t.after(() => {
    if (!hasNativeCancel) delete proto.cancelSignIn;
    if (!hasNativeMutateLogin) delete proto.mutateLogin;
  });

  const cancelRes = await (await h.providersMutate(makeJsonPost({
    operation: 'oauth-cancel',
    signInId: 'si-123',
  }))).json();
  assert.equal(cancelRes.ok, true);

  const loginMutRes = await (await h.providersMutate(makeJsonPost({
    operation: 'mutate-login',
    loginAction: 'switch',
    providerId: 'magpie:codex',
    user: 'alice@example.com',
  }))).json();
  assert.equal(loginMutRes.ok, true);
});

test('UI-06, UI-07 & UI-12: serveLtWebStaticRequest hardening, /lt/?token= cookie exchange, and client.js Desktop file:// guard', async t => {
  const tmpDir = makeTempDir(t, 'ui06-07-12');
  const customDist = path.join(tmpDir, 'dist');
  fs.mkdirSync(path.join(customDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(customDist, 'index.html'), '<!doctype html><html data-lt-theme="white"></html>', 'utf8');
  fs.writeFileSync(path.join(customDist, 'assets', 'app.js'), 'console.log("ok");', 'utf8');

  const outsideSecret = path.join(tmpDir, 'outside.txt');
  fs.writeFileSync(outsideSecret, 'TOP_SECRET_OUTSIDE_DIST', 'utf8');
  fs.symlinkSync(outsideSecret, path.join(customDist, 'leak.txt'));

  // 1. UI-06: malformed URI returns 400 (never 500)
  const badUri = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt/%E0%A4%A'), { distDir: customDist });
  assert.equal(badUri.status, 400);

  // 2. UI-06: double-slash `/lt//` and encoded slash `/lt/%2F` serve `index.html` (200) instead of 403
  const dblSlash = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt//'), { distDir: customDist });
  assert.equal(dblSlash.status, 200);
  const encSlash = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt/%2F'), { distDir: customDist });
  assert.equal(encSlash.status, 200);

  // 3. UI-06: symlink escaping outside `distDir` returns 403 Forbidden
  const symEscape = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt/leak.txt'), { distDir: customDist });
  assert.equal(symEscape.status, 403);

  // 4. UI-06: missing asset extension returns 404 (not SPA fallback)
  const missingJs = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt/assets/missing.js'), { distDir: customDist });
  assert.equal(missingJs.status, 404);

  // 5. UI-12: nested SPA subpath `/lt/workbench/sub?foo=1` redirects 302 to `/lt/?foo=1`
  const nestedSpa = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt/workbench/sub?foo=1'), { distDir: customDist });
  assert.equal(nestedSpa.status, 302);
  assert.equal(nestedSpa.headers.get('location'), '/lt/?foo=1');

  // 6. UI-07: `registerLtNativeFrontendStaticRoute` rewrites synthetic pathname to `'/'` for DSH `BrowserAuth.authorizeIndex`
  let registeredResource = null;
  const mockWebServer = {
    register(spec) {
      registeredResource = spec.resource;
      return () => {};
    },
  };
  const mockConnection = {
    authorizeIndex(req, res) {
      const u = new URL(req.url, 'http://127.0.0.1:3080');
      // Exact DSH `BrowserAuth.authorizeIndex` contract: ?token=... ONLY succeeds when `u.pathname === '/'`
      if (u.searchParams.has('token')) {
        if (req.method === 'GET' && u.pathname === '/' && u.searchParams.get('token') === 'valid-dsh-tok') {
          res.writeHead(303, {
            Location: './',
            'Set-Cookie': ['dsh-auth-3080=cookie-val; Path=/; HttpOnly; SameSite=Strict'],
            'Cache-Control': 'no-store',
          });
          res.end('');
          return false;
        }
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('dsh web authentication required');
        return false;
      }
      if ((req.headers.get('cookie') || '').includes('dsh-auth-3080=cookie-val')) return true;
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthorized');
      return false;
    },
  };
  registerLtNativeFrontendStaticRoute({ effect: fn => fn() }, mockWebServer, mockConnection);
  assert.equal(typeof registeredResource, 'function');

  const ltTokenVisit = await registeredResource(
    new Request('http://127.0.0.1:3080/lt/?token=valid-dsh-tok', { headers: { Host: '127.0.0.1:3080' } }),
    undefined,
  );
  assert.equal(ltTokenVisit.status, 303);
  assert.equal(ltTokenVisit.headers.get('location'), './');
  assert.match(ltTokenVisit.headers.get('set-cookie') || '', /dsh-auth-3080=cookie-val/);

  const ltAuthedVisit = await registeredResource(
    new Request('http://127.0.0.1:3080/lt/', { headers: { Host: '127.0.0.1:3080', Cookie: 'dsh-auth-3080=cookie-val' } }),
    undefined,
  );
  assert.equal(ltAuthedVisit.status, 200);

  // 7. UI-12: `leaderteam-panel/client.js` hides `./lt/` anchor on `file://` Desktop and uses `ctx.connection.fetch`
  const clientCode = fs.readFileSync(path.join(repoRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'utf8');
  let desc = null;
  const sandbox = {
    window: {
      location: { protocol: 'file:', pathname: '/C:/App/index.html' },
      __ModuleLoader__: { load(d) { desc = d; } },
    },
    fetch: async () => { throw new TypeError('Failed to fetch file://'); },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(clientCode, sandbox);

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [init, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  };
  const plugin = desc.factory(mod => (mod === 'react' ? fakeReact : null));
  let connFetchedPath = null;
  let mainRenderer = null;
  plugin.apply({
    connection: {
      async fetch(p) {
        connFetchedPath = p;
        return { ok: true, json: async () => ({ ok: true, value: {} }) };
      },
    },
    effect(fn) { fn(); return () => {}; },
    slots: {
      inject(_name, cb) { return cb(); },
      register(reg, renderFn) {
        if (reg.name === 'main') mainRenderer = renderFn;
        return () => {};
      },
    },
  });
  const vnodeTree = JSON.stringify(mainRenderer({}));
  assert.equal(vnodeTree.includes('"href":"./lt/"'), false, 'file:// Desktop view must not render broken ./lt/ anchor');
  assert.equal(connFetchedPath, null); // useEffect stubbed in sync tree check
});

test('UI-09, UI-10 & UI-11: archiveAction guards, requestWindow.windowsByProvider, and built web-dist theme/API/chart contracts', async t => {
  const tmpDir = makeTempDir(t, 'ui09-10-11');
  const { dshHome, storageRoot, cfgFile, rt } = makeFakeRuntime(tmpDir, {
    requestWindow: {
      enabled: true,
      windowMs: 5 * 3600 * 1000,
      softThrottlePct: 20,
      hardPausePct: 5,
      windowsByProvider: {
        codex: { maxRequests: 100 },
        deepseek: { maxRequests: 200 },
      },
    },
  });

  // Seed 96 codex calls within 5h (`4%` remaining <= `5%` hardPausePct -> `paused`) and 0 deepseek calls (`normal`)
  const rwFile = path.join(storageRoot, 'request-window-calls.jsonl');
  const now = Date.now();
  const rwLines = Array.from({ length: 96 }, (_, i) => JSON.stringify({ provider: 'codex', at: now - i * 1000 })).join('\n') + '\n';
  fs.writeFileSync(rwFile, rwLines, 'utf8');

  // Seed 1 archived plan (workspace is a separate sibling directory outside `dsh-home`)
  const projWs = path.join(tmpDir, 'project-ws');
  fs.mkdirSync(projWs, { recursive: true });
  const archiveRoot = resolvePlanArchiveRoot({ config: rt.config, storageRoot, workspaceRoot: projWs });
  const archive = new PlanArchiveStore(archiveRoot, { workspaceRoot: projWs });
  archive.archivePlanSubmission({
    agreementId: 'agr-sec-1',
    teamId: 'team-1',
    taskSeq: 1,
    workspace: projWs,
    topic: 'Harden loopback UI security',
    proposal: 'Step 1: validate Host and Origin',
    userRequest: 'Harden loopback UI security',
  });

  const fakeCtx = { get: k => (k === 'profileContext' ? { home: dshHome } : null) };
  const h = createPublicContractHandlers(fakeCtx, rt);

  // 1. UI-10: `requestWindows` honors `cfg.requestWindow.windowsByProvider`
  const snapRes = await (await h.runtimeSnapshot(makeJsonPost({}))).json();
  assert.equal(snapRes.ok, true);
  const codexWin = snapRes.data.requestWindows.find(w => w.provider === 'codex');
  const dsWin = snapRes.data.requestWindows.find(w => w.provider === 'deepseek');
  assert.deepEqual(codexWin, { provider: 'codex', used5h: 96, limit5h: 100, tier: 'paused' });
  assert.deepEqual(dsWin, { provider: 'deepseek', used5h: 0, limit5h: 200, tier: 'normal' });

  // 2. UI-09: `archiveAction` rejects `dryRun: false` without `confirm: true`, rejects negative `olderThanDays`, and respects `planArchive.enabled === false`
  const noConfirmRes = await (await h.archiveAction(makeJsonPost({
    action: 'clean',
    all: true,
    dryRun: false,
    confirm: false,
  }))).json();
  assert.equal(noConfirmRes.ok, false);
  assert.equal(noConfirmRes.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(archive.listPlans({ limit: 10 }).length, 1);

  const negDaysRes = await (await h.archiveAction(makeJsonPost({
    action: 'clean',
    olderThanDays: -1,
    all: false,
    dryRun: false,
    confirm: true,
  }))).json();
  assert.equal(negDaysRes.ok, false);
  assert.equal(negDaysRes.error.code, 'BAD_REQUEST');
  assert.equal(archive.listPlans({ limit: 10 }).length, 1);

  // Disable `planArchive.enabled` and verify `archiveAction` rejects mutations with `PLAN_ARCHIVE_DISABLED`
  applyModelConfigChanges({ setPlanArchive: { enabled: false } }, { configFile: cfgFile, target: 'local' });
  const disabledArchiveRes = await (await h.archiveAction(makeJsonPost({
    action: 'clean',
    all: true,
    dryRun: false,
    confirm: true,
  }))).json();
  assert.equal(disabledArchiveRes.ok, false);
  assert.equal(disabledArchiveRes.error.code, 'PLAN_ARCHIVE_DISABLED');
  assert.equal(archive.listPlans({ limit: 10 }).length, 1);

  // 3. UI-11: Verify built `web-dist/index.html` `bootLtTheme` hydration on preset (`heluoxu`) vs dark `custom` theme
  const distDir = resolveLtWebDistDir();
  const distIndexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  const scriptMatch = distIndexHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'web-dist/index.html must include inline bootLtTheme script');

  const runBootScript = storedPrefs => {
    const attrs = new Map([['data-lt-theme', 'white']]);
    const styleProps = new Map();
    const docEl = {
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: k => attrs.delete(k),
      style: {
        colorScheme: '',
        setProperty: (k, v) => styleProps.set(k, String(v)),
        removeProperty: k => styleProps.delete(k),
      },
    };
    vm.runInNewContext(scriptMatch[1], {
      localStorage: { getItem: () => JSON.stringify(storedPrefs) },
      document: { documentElement: docEl },
    });
    return { attrs, styleProps, colorScheme: docEl.style.colorScheme };
  };

  // Preset `heluoxu` must NOT have `data-lt-corners` stamped on `<html>` (preserving 999px pill CTAs)
  const heluoxuBoot = runBootScript({
    theme: 'heluoxu',
    customTheme: { cornerStyle: 'balanced', headingFontMode: 'serif', density: 'standard' },
  });
  assert.equal(heluoxuBoot.attrs.get('data-lt-theme'), 'heluoxu');
  assert.equal(heluoxuBoot.attrs.has('data-lt-corners'), false);
  assert.equal(heluoxuBoot.attrs.has('data-lt-heading'), false);
  assert.equal(heluoxuBoot.attrs.has('data-lt-density'), false);

  // Dark custom theme (`inkColor: '#F0F4F8'`, `surfaceColor: '#12151C'`) computes high-contrast `--user-fg-on-ink: #141619` and `colorScheme: 'dark'`
  const darkCustomBoot = runBootScript({
    theme: 'custom',
    customTheme: {
      canvasColor: '#0B0D12',
      surfaceColor: '#12151C',
      inkColor: '#F0F4F8',
      accentColor: '#D29A68',
      dangerColor: '#F08C9C',
      headingFontMode: 'sans',
      cornerStyle: 'pill-cta',
      density: 'compact',
    },
  });
  assert.equal(darkCustomBoot.attrs.get('data-lt-theme'), 'custom');
  assert.equal(darkCustomBoot.attrs.get('data-lt-corners'), 'pill-cta');
  assert.equal(darkCustomBoot.attrs.get('data-lt-heading'), 'sans');
  assert.equal(darkCustomBoot.attrs.get('data-lt-density'), 'compact');
  assert.equal(darkCustomBoot.styleProps.get('--user-fg-on-ink'), '#141619');
  assert.equal(darkCustomBoot.colorScheme, 'dark');

  // Verify built JS bundle contains upstream OAuth agent IDs (`"claude"`, `"gemini"`), `oauth-status`, `oauth-cancel`, `save-external`, and `revokeObjectURL`
  const jsFiles = fs.readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.js'));
  const combinedJs = jsFiles.map(f => fs.readFileSync(path.join(distDir, 'assets', f), 'utf8')).join('\n');
  assert.equal(combinedJs.includes('claude-code'), false, 'Built bundle must not use invalid claude-code OAuth agent ID');
  assert.equal(combinedJs.includes('gemini-cli'), false, 'Built bundle must not use invalid gemini-cli OAuth agent ID');
  assert.ok(combinedJs.includes('oauth-status'));
  assert.ok(combinedJs.includes('oauth-cancel'));
  assert.ok(combinedJs.includes('save-external'));
  assert.ok(combinedJs.includes('remove-external'));
  assert.ok(combinedJs.includes('clearLocalOverrides'));
  assert.ok(combinedJs.includes('revokeObjectURL'));

  // 4. UI-11 & UI-12: Direct verification of `api.ts` (`resolveApiPrefix` & `applyThemeToDom`)
  const { resolveApiPrefix, applyThemeToDom } = await import('../../packages/lt-web/src/lib/api.ts');
  const prevWindow = globalThis.window;
  const prevDoc = globalThis.document;
  const prevStorage = globalThis.localStorage;
  try {
    for (const [pathname, expectedPrefix] of [
      ['/', '/api/lt/v1'],
      ['/lt', '/api/lt/v1'],
      ['/lt/', '/api/lt/v1'],
      ['/lt/workbench/sub', '/api/lt/v1'],
      ['/subpath/lt/a/b', '/subpath/api/lt/v1'],
    ]) {
      globalThis.window = { location: { pathname } };
      assert.equal(resolveApiPrefix(), expectedPrefix, `pathname=${pathname}`);
    }

    const domAttrs = new Map();
    const domStyle = new Map();
    globalThis.localStorage = { setItem: () => {} };
    globalThis.document = {
      documentElement: {
        setAttribute: (k, v) => domAttrs.set(k, String(v)),
        removeAttribute: k => domAttrs.delete(k),
        style: {
          colorScheme: '',
          setProperty: (k, v) => domStyle.set(k, String(v)),
          removeProperty: k => domStyle.delete(k),
        },
      },
    };
    const seeds = {
      canvasColor: '#0B0D12',
      surfaceColor: '#12151C',
      inkColor: '#F0F4F8',
      accentColor: '#D29A68',
      dangerColor: '#F08C9C',
      headingFontMode: 'sans',
      cornerStyle: 'balanced',
      density: 'compact',
    };
    applyThemeToDom('custom', seeds);
    assert.equal(domAttrs.get('data-lt-corners'), 'balanced');
    assert.equal(domStyle.get('--user-fg-on-ink'), '#141619');
    assert.equal(globalThis.document.documentElement.style.colorScheme, 'dark');

    // Switching to `heluoxu` removes `data-lt-corners` so 999px pill CTAs are never clobbered
    applyThemeToDom('heluoxu', seeds);
    assert.equal(domAttrs.get('data-lt-theme'), 'heluoxu');
    assert.equal(domAttrs.has('data-lt-corners'), false);
    assert.equal(domAttrs.has('data-lt-heading'), false);
    assert.equal(domAttrs.has('data-lt-density'), false);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('Stage 4 Re-Audit Fixes (S3-UIGW-01, S3-UIGW-02, S3-UIGW-04, S3-UIGW-06): lt-ui & public-api 405 GET block on mutating routes, sanitized providersMutate operationResult, and web-dist/type parity', async t => {
  const tmpDir = makeTempDir(t, 's4-uigw');
  const { dshHome, storageRoot, cfgFile, rt } = makeFakeRuntime(tmpDir);

  const prevDshHome = process.env.DSH_HOME;
  t.after(() => {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  });

  const mockSrv = await startMockMagpieServer();
  t.after(() => mockSrv.close());

  const uiSrv = await startStandaloneLtUiServer({ port: 0, dshHome, configPath: cfgFile, requireAuth: true });
  t.after(() => uiSrv.close());

  const loginRes = await fetch(uiSrv.launchUrl, { redirect: 'manual' });
  const cookiePair = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  // 1. S3-UIGW-04: Read-only allowlist accepts GET (200) and rejects DELETE (405 Allow: GET, POST)
  for (const roPath of PUBLIC_READONLY_API_ROUTES) {
    const getRes = await fetch(`${uiSrv.baseUrl}${roPath}`, {
      method: 'GET',
      headers: { Cookie: cookiePair },
    });
    assert.equal(getRes.status, 200, `Expected 200 on read-only GET ${roPath}`);
    const getJson = await getRes.json();
    assert.equal(getJson.ok, true, `Expected ok=true on read-only GET ${roPath}, got: ${JSON.stringify(getJson)}`);
    const delRes = await fetch(`${uiSrv.baseUrl}${roPath}`, {
      method: 'DELETE',
      headers: { Cookie: cookiePair },
    });
    assert.equal(delRes.status, 405, `Expected 405 on DELETE ${roPath}`);
    assert.equal(delRes.headers.get('allow'), 'GET, POST');
  }

  // 2. S3-UIGW-04: ALL non-read-only `/api/lt/v1/*` routes reject GET with 405 Allow: POST and NEVER mutate disk!
  const allRoutes = Object.values(PUBLIC_API_ROUTES);
  const mutatingRoutes = allRoutes.filter(p => !PUBLIC_READONLY_API_ROUTES.has(p));
  assert.equal(mutatingRoutes.length, 14);

  const bundleBefore = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/bundle`, { headers: { Cookie: cookiePair } })).json();
  assert.equal(bundleBefore.data.usageStatus.enabled, true);

  for (const mutPath of mutatingRoutes) {
    const getMutRes = await fetch(`${uiSrv.baseUrl}${mutPath}`, {
      method: 'GET',
      headers: { Cookie: cookiePair },
    });
    assert.equal(getMutRes.status, 405, `Expected 405 on mutating GET ${mutPath}`);
    assert.equal(getMutRes.headers.get('allow'), 'POST');
    const errBody = await getMutRes.json();
    assert.equal(errBody.ok, false);
    assert.equal(errBody.error.code, 'METHOD_NOT_ALLOWED');
  }

  // Verify `GET /api/lt/v1/usage/toggle` did NOT disable usage analytics in `bundle` or on disk
  const bundleAfter = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/bundle`, { headers: { Cookie: cookiePair } })).json();
  assert.equal(bundleAfter.data.usageStatus.enabled, true);
  assert.equal(fs.existsSync(path.join(storageRoot, 'ui-preferences.json')), false);

  // Defense-in-depth: direct `createPublicContractHandlers` call with `method: 'GET'` also returns 405 Allow: POST
  const h = createPublicContractHandlers({ get: k => (k === 'profileContext' ? { home: dshHome } : null) }, rt);
  const directGetToggle = await h.usageToggle(new Request('http://127.0.0.1/api/lt/v1/usage/toggle', { method: 'GET' }));
  assert.equal(directGetToggle.status, 405);
  assert.equal(directGetToggle.headers.get('allow'), 'POST');

  // 3. S3-UIGW-01 & S3-UIGW-02: Mock Magpie `providersMutate` sanitizes `operationResult` (`scanNoSecretLeakage` === [])
  await h.gatewayControl(makeJsonPost({
    action: 'configure',
    config: {
      mode: 'external',
      externalGatewayUrl: mockSrv.gatewayUrl,
      externalWebAdminUrl: mockSrv.webUrl,
      externalWebKey: mockSrv.webKey,
    },
  }));
  await h.providersMutate(makeJsonPost({
    operation: 'save-provider',
    spec: { new: true, preset: 'deepseek', key: 'sk-mock-secret-alpha-123456789012' },
  }));

  const testMut = await (await h.providersMutate(makeJsonPost({
    operation: 'test-provider',
    id: 'magpie:deepseek',
  }))).json();
  assert.equal(testMut.ok, true);
  assert.deepEqual(scanNoSecretLeakage(testMut), []);
  assert.equal(testMut.data.operationResult.provider, undefined);
  assert.equal(testMut.data.operationResult.results[0].latencyMs, 19);
  assert.equal(testMut.data.operationResult.results[0].ms, 19);
  assert.equal(testMut.data.operationResult.results[0].protocol, 'chat');

  const refreshMut = await (await h.providersMutate(makeJsonPost({
    operation: 'refresh-models',
    id: 'magpie:deepseek',
  }))).json();
  assert.equal(refreshMut.ok, true);
  assert.deepEqual(scanNoSecretLeakage(refreshMut), []);
  assert.equal(refreshMut.data.operationResult.provider, undefined);
  assert.equal(refreshMut.data.operationResult.models.length, 2);

  // Sole key `off` rejected with error (`ok: false`), then adding 2nd key with `protocol`/`plan` + `remove-many` succeeds cleanly
  const soleOff = await (await h.providersMutate(makeJsonPost({
    operation: 'mutate-key',
    providerId: 'magpie:deepseek',
    credentialId: testMut.data.providers.find(p => p.providerId === 'magpie:deepseek').credentials[0].credentialId,
    keyAction: 'off',
  }))).json();
  assert.equal(soleOff.ok, false);

  const addSecond = await (await h.providersMutate(makeJsonPost({
    operation: 'mutate-key',
    providerId: 'magpie:deepseek',
    keyAction: 'add',
    name: 'Key 2',
    key: 'sk-mock-secret-bravo-987654321098',
    protocol: 'chat',
    plan: 'Enterprise',
  }))).json();
  assert.equal(addSecond.ok, true);
  assert.deepEqual(addSecond.data.operationResult, { applied: true });
  assert.deepEqual(scanNoSecretLeakage(addSecond), []);

  // 4. S3-UIGW-06: Built `web-dist` contains single-key routing `<option value="single">`, keyless loopback check, and exact `lt-public-v1.ts` parity
  const distDir = resolveLtWebDistDir();
  const jsFiles = fs.readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.js'));
  const combinedJs = jsFiles.map(f => fs.readFileSync(path.join(distDir, 'assets', f), 'utf8')).join('\n');
  assert.ok(combinedJs.includes('单凭据默认 (single)'), 'web-dist must include disabled single routing option');

  const sharedDts = fs.readFileSync(path.resolve(repoRoot, '..', 'lt-shared-contracts', 'types', 'lt-public-v1.d.ts'), 'utf8');
  const webTs = fs.readFileSync(path.join(repoRoot, 'packages', 'lt-web', 'src', 'types', 'lt-public-v1.ts'), 'utf8');
  assert.equal(webTs, sharedDts, 'lt-web lt-public-v1.ts must stay byte-for-byte synced with lt-shared-contracts');
});
