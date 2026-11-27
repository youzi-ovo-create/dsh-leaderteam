import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicContractHandlers,
  resolveLtWebDistDir,
  serveLtWebStaticRequest,
} from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { startStandaloneLtUiServer } from '../../bin/lt-ui.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { bindRuntimeConfigFile } from '../../leaderteam/host/runtime.mjs';
import { startMockMagpieServer, validateContractBundle } from './companion-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function makePostReq(body = {}) {
  return new Request('http://127.0.0.1/api/lt/v1/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Public API v1: full bundle, theme persistence (4 themes), workbench session sharing, and shared contract validation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pub-api-'));
  const dshHome = path.join(tmpDir, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
  const cfgFile = path.join(storageRoot, 'config', 'leaderteam.config.json');
  fs.copyFileSync(path.join(repoRoot, 'config', 'leaderteam.config.json'), cfgFile);

  const srv = await startMockMagpieServer();
  try {
    const fakeRt = {
      storageRoot,
      configPath: cfgFile,
      config: loadConfig(cfgFile),
      plugins: { scheduler: { version: '2.2.0' }, consensus: { version: '2.2.0' }, timerArchive: { version: '2.2.0' }, panel: { version: '2.2.0' } },
      cordisCompositionMode: true,
      stores: new Map(),
      actors: new Map(),
    };
    bindRuntimeConfigFile(fakeRt, cfgFile, fakeRt.config);

    // Mock live DSH host `sessionController` + `webServer` to verify zero-interruption shared session & frontend switch
    const promptedLog = [];
    const fakeCtx = {
      webServer: { port: 3080 },
      sessionController: {
        async list() {
          return { items: [{ sessionId: 'sess-shared-01', title: '共享工程会话', cwd: tmpDir, agentPreset: 'leaderteam' }] };
        },
        async create(req) {
          return { sessionId: 'sess-created-02', agentPreset: req.agentPreset };
        },
        async prompt(req) {
          promptedLog.push(req);
          return { accepted: true };
        },
        cancel(req) {
          return { cancelled: true, sessionId: req.sessionId };
        },
      },
      get(key) {
        if (key === 'profileContext') return { home: dshHome };
        return this[key] ?? null;
      },
    };

    const h = createPublicContractHandlers(fakeCtx, fakeRt);

    // 1. Configure external mock Magpie + add provider via public API
    await h.gatewayControl(makePostReq({
      action: 'configure',
      config: {
        mode: 'external',
        externalGatewayUrl: srv.gatewayUrl,
        externalWebAdminUrl: srv.webUrl,
        externalWebKey: srv.webKey,
      },
    }));
    const mutRes = await (await h.providersMutate(makePostReq({
      operation: 'save-provider',
      spec: { new: true, preset: 'deepseek', key: 'sk-pubapi-secret-9876543210' },
    }))).json();
    assert.equal(mutRes.ok, true);
    assert.ok(!JSON.stringify(mutRes).includes('sk-pubapi-secret-9876543210'));

    // 2. Sync discovered Magpie models into LT pool via public API
    const syncRes = await (await h.modelsSyncPool(makePostReq({ target: 'local', enableInExecutionPool: true }))).json();
    assert.equal(syncRes.ok, true);
    assert.ok(syncRes.data.syncedCount >= 2);
    assert.ok(syncRes.data.runtime.modelPool.executionPool.includes('deepseek/deepseek-reasoner'));

    // 3. Fetch full hydrated bundle and validate against shared `lt.public.v1` validator!
    const bundleRes = await (await h.bundle(makePostReq())).json();
    assert.equal(bundleRes.ok, true);
    assert.equal(bundleRes.data.capabilities.frontendSwitch.available, true);
    assert.equal(bundleRes.data.capabilities.frontendSwitch.sharesRuntimeAndSessions, true);
    assert.equal(bundleRes.data.uiPreferences.theme, 'white'); // Default MUST be white!

    const validation = validateContractBundle({
      contract: bundleRes.contract,
      contractVersion: bundleRes.contractVersion,
      capabilities: bundleRes.data.capabilities,
      gateway: bundleRes.data.gateway,
      providers: bundleRes.data.providers,
      models: bundleRes.data.models,
      runtime: bundleRes.data.runtime,
      usageRecords: [],
    });
    assert.equal(validation.ok, true, `Contract validation errors: ${validation.errors.join('; ')}`);

    // 4. Verify all 4 themes (`white`, `dark`, `heluoxu`, `custom`) persist cleanly
    for (const theme of ['white', 'dark', 'heluoxu', 'custom']) {
      const prefRes = await (await h.uiPreferences(makePostReq({
        theme,
        customTheme: {
          canvasColor: '#F2F4F8',
          surfaceColor: '#FFFFFF',
          inkColor: '#111827',
          accentColor: '#9C5B2E',
          dangerColor: '#A3263F',
          headingFontMode: 'serif',
          cornerStyle: 'pill-cta',
          density: 'compact',
        },
      }))).json();
      assert.equal(prefRes.ok, true);
      assert.equal(prefRes.data.theme, theme);
    }

    // 5. Verify live shared DSH session workbench list & prompt
    const sessList = await (await h.workbenchSessions()).json();
    assert.equal(sessList.data.liveHost, true);
    assert.equal(sessList.data.sessions[0].sessionId, 'sess-shared-01');

    const promptRes = await (await h.workbenchPrompt(makePostReq({
      sessionId: 'sess-shared-01',
      text: '最大并发 4',
      mode: 'steer',
    }))).json();
    assert.equal(promptRes.ok, true);
    assert.equal(promptedLog.length, 1);
    assert.equal(promptedLog[0].mode, 'steer');

    // 6. Verify built `web-dist` contains all 4 CSS theme selectors and serves cleanly at `/lt/`
    const distDir = resolveLtWebDistDir();
    assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'web-dist/index.html must exist');
    const cssFiles = fs.readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.css'));
    assert.ok(cssFiles.length >= 1, 'built CSS asset must exist');
    const cssText = fs.readFileSync(path.join(distDir, 'assets', cssFiles[0]), 'utf8');
    for (const themeName of ['white', 'dark', 'heluoxu', 'custom']) {
      assert.match(cssText, new RegExp(`data-lt-theme=["']?${themeName}["']?`), `CSS must define theme ${themeName}`);
    }

    const redir = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt'));
    assert.equal(redir.status, 302);
    assert.equal(redir.headers.get('location'), '/lt/');

    const htmlRes = await serveLtWebStaticRequest(new Request('http://127.0.0.1:3080/lt/'));
    assert.equal(htmlRes.status, 200);
    const htmlBody = await htmlRes.text();
    assert.match(htmlBody, /data-lt-theme="white"/);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Standalone lt-ui server enforces loopback Host/Sec-Fetch-Site fences, token cookie login, and serves UI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ui-srv-'));
  const dshHome = path.join(tmpDir, 'dsh-home');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  const cfgDir = path.join(dshHome, 'leaderteam', 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
  fs.copyFileSync(path.join(repoRoot, 'config', 'leaderteam.config.json'), cfgFile);

  const uiSrv = await startStandaloneLtUiServer({ port: 0, dshHome, configPath: cfgFile, requireAuth: true });
  try {
    // 1. Unauthenticated index returns 401
    const unauth = await fetch(`${uiSrv.baseUrl}/`);
    assert.equal(unauth.status, 401);

    // 2. Cross-site header blocked with 403
    const crossSite = await fetch(`${uiSrv.baseUrl}/`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);

    // 3. Launch token exchanges for port-scoped HttpOnly cookie (302) with no-store & no-referrer
    const loginRes = await fetch(uiSrv.launchUrl, { redirect: 'manual' });
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.get('cache-control'), 'no-store');
    assert.equal(loginRes.headers.get('referrer-policy'), 'no-referrer');
    const setCookie = loginRes.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`^lt_workbench_sid_${uiSrv.port}=`));
    const cookiePair = setCookie.split(';')[0];

    // 4. Authenticated index and `/api/lt/v1/capabilities` succeed
    const okIndex = await fetch(`${uiSrv.baseUrl}/`, { headers: { Cookie: cookiePair } });
    assert.equal(okIndex.status, 200);

    const capsRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/capabilities`, {
      method: 'POST',
      headers: { Cookie: cookiePair, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(capsRes.status, 200);
    const caps = await capsRes.json();
    assert.equal(caps.ok, true);
    assert.equal(caps.data.hostKind, 'standalone');
    assert.equal(caps.data.frontendSwitch.available, false);
  } finally {
    await uiSrv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
