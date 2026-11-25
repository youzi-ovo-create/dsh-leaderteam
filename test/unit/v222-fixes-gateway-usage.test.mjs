import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MagpieGatewayManager,
  MagpieClient,
  getOrCreateGatewayManager,
  buildPublicProviders,
  buildPublicModelCatalog,
  normalizeMagpieUsageRow,
  sanitizeMaskedPreview,
  discoverSystemMagpieBinary,
} from '../../leaderteam/gateway/index.mjs';
import {
  HengzhangUsageBridge,
  getOrCreateHengzhangBridge,
  toPublicLogicalUsageRecords,
} from '../../leaderteam/usage/index.mjs';
import { defaultPricing, buildReport } from '../../packages/lt-usage/index.mjs';
import { startMockMagpieServer } from '../../../lt-shared-contracts/mocks/mock-magpie-server.mjs';
import { validateContractBundle, scanNoSecretLeakage } from '../../../lt-shared-contracts/tests/contract-validator.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { bindRuntimeConfigFile } from '../../leaderteam/host/runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const ltMagpieCliPath = path.join(repoRoot, 'bin', 'lt-magpie.mjs');

function computeSha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mkStage2Sandbox(suffix) {
  return fs.mkdtempSync(path.join('/tmp', `lt-s2-gw-${suffix}-`));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function startLocalDummyUpstreamRelay() {
  let port = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      const payload = JSON.stringify({
        object: 'list',
        data: [
          { id: 'alpha-model', object: 'model', created: 0, owned_by: 'localrelay' },
          { id: 'beta-model', object: 'model', created: 0, owned_by: 'localrelay' },
        ],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
      return;
    }
    if (req.method === 'POST' && u.pathname === '/v1/chat/completions') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const payload = JSON.stringify({
          id: `chatcmpl-loopback-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'alpha-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'LOOPBACK_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(r => server.close(() => r())),
  };
}

function writeZstdSession(sessionDir, rows) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const frames = rows.map(r => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8')));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

test('CT-01 & CT-02 & GW-07 & GW-08: sanitizeMaskedPreview, external key clearing, accounts fallback, magpie:group + host-settings backfill, and singleton option refresh', async () => {
  const tmpDir = mkStage2Sandbox('ct-unit');
  try {
    // 1. CT-02: sanitizeMaskedPreview blocks <16-char raw keys and secrets containing '...' while preserving Unicode '…' & '****'
    assert.equal(sanitizeMaskedPreview('sk-1234567890ab'), 'sk-****90ab');
    assert.equal(sanitizeMaskedPreview('sk-short'), '****');
    assert.equal(sanitizeMaskedPreview('sk-live...realSecretKey987654321'), 'sk-****4321');
    assert.equal(sanitizeMaskedPreview('sk-l…1111'), 'sk-l…1111');
    assert.equal(sanitizeMaskedPreview('sk-****d4e5'), 'sk-****d4e5');
    assert.equal(sanitizeMaskedPreview('oauth:Pro', 'oauth'), 'oauth:Pro');

    // 2. CT-02: saveExternalGateway supports clearing stored secret (`clearKey: true`)
    const storageRoot = path.join(tmpDir, 'storage');
    const mgr = new MagpieGatewayManager({ storageRoot });
    let extList = mgr.saveExternalGateway({
      id: 'corp-gw',
      displayName: 'Corp GW',
      endpointUrl: 'http://127.0.0.1:18080/v1',
      apiKey: 'sk-corp-secret-abcdef123456',
    });
    assert.equal(extList[0].hasKey, true);
    assert.ok(!extList[0].maskedPreview.includes('abcdef123456'));

    extList = mgr.saveExternalGateway({
      id: 'corp-gw',
      displayName: 'Corp GW',
      endpointUrl: 'http://127.0.0.1:18080/v1',
      clearKey: true,
    });
    assert.equal(extList[0].hasKey, false);
    assert.equal(extList[0].maskedPreview, '');
    const rawCreds = JSON.parse(fs.readFileSync(mgr.credentialsFile, 'utf8'));
    assert.equal(rawCreds.externalGatewayKeys['corp-gw'], undefined);

    // 3. GW-07 & CT-01: `/v1/magpie/accounts` `kind: "account"` OAuth classification + `magpie:group` & `dshDiscoveredModels` referential integrity
    const gwModels = [
      { id: 'codex/gpt-5.2', owned_by: 'codex', reasoning_levels: ['low', 'high'] },
      { id: 'group/coding-pool', owned_by: 'group', reasoning_levels: ['medium', 'high'] },
    ];
    const dshDiscoveredModels = [
      { route: 'ollama-local/qwen3:8b', provider: 'ollama-local', upstreamModel: 'qwen3:8b', efforts: ['none'] },
    ];
    const { providers } = buildPublicProviders({
      magpieAccountsPayload: {
        object: 'list',
        data: [
          {
            provider: 'codex',
            providerName: 'Codex',
            id: 'alice',
            kind: 'account',
            label: 'alice@example.com',
            plan: 'Team',
            on: true,
            models: ['codex/gpt-5.2'],
          },
        ],
      },
      magpieGatewayUrl: 'http://127.0.0.1:13425',
      magpieGatewayModels: gwModels,
      dshDiscoveredModels,
      externalGateways: extList,
    });
    const codexProv = providers.find(p => p.providerId === 'magpie:codex');
    assert.ok(codexProv);
    assert.equal(codexProv.credentials[0].kind, 'oauth');
    assert.equal(codexProv.credentials[0].accountPlan, 'Team');
    assert.match(codexProv.credentials[0].credentialId, /^oauth:codex:alice$/);

    assert.ok(providers.some(p => p.providerId === 'magpie:group'), 'magpie:group must be backfilled');
    assert.ok(providers.some(p => p.providerId === 'direct:ollama-local'), 'host-settings provider must be backfilled');

    const models = buildPublicModelCatalog({
      magpieGatewayModels: gwModels,
      dshDiscoveredModels,
    });
    const baseSnap = JSON.parse(
      fs.readFileSync(path.resolve(repoRoot, '..', 'lt-shared-contracts', 'mocks', 'mock-v2.2-oss-snapshot.json'), 'utf8'),
    );
    const liveEnvelope = {
      ok: true,
      contract: 'lt.public.v1',
      contractVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      data: {
        capabilities: baseSnap.capabilities,
        gateway: await mgr.getStatus(),
        providers,
        providerPresets: [],
        models,
        runtime: baseSnap.runtime,
        uiPreferences: { theme: 'white', autoRefreshMs: 5000 },
        usageStatus: { enabled: true, healthy: true },
      },
    };
    const valid = validateContractBundle(liveEnvelope);
    assert.equal(valid.ok, true, `Envelope validation failed: ${valid.errors.join('; ')}`);

    // 4. GW-08: MANAGER_CACHE & BRIDGE_CACHE refresh mutable collaborator options on cache hit
    const customFetch = async () => new Response('{}', { status: 200 });
    const cachedMgr1 = getOrCreateGatewayManager(storageRoot, { defaultGatewayPort: 14001 });
    const cachedMgr2 = getOrCreateGatewayManager(storageRoot, { fetchImpl: customFetch, defaultGatewayPort: 14002 });
    assert.equal(cachedMgr1, cachedMgr2);
    assert.equal(cachedMgr2.fetchImpl, customFetch);
    assert.equal(cachedMgr2.defaultGatewayPort, 14002);

    const newDshHome = path.join(tmpDir, 'updated-dsh-home');
    const cachedBridge1 = getOrCreateHengzhangBridge(storageRoot, { dshHome: path.join(tmpDir, 'old-home') });
    const cachedBridge2 = getOrCreateHengzhangBridge(storageRoot, { dshHome: newDshHome, fetchImpl: customFetch });
    assert.equal(cachedBridge1, cachedBridge2);
    assert.equal(cachedBridge2.resolveDshHome(), newDshHome);
    assert.throws(
      () => cachedBridge2.resolveSafeDshHome('/etc', { allowExternalOverride: false }),
      err => err?.code === 'FORBIDDEN_HOME',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('HZ-01 & HZ-03 & GW-04 (Mock): feed 410 cursor_reset recovery, in-place upserts, deleted tombstones, non-gateway filtering, priced $0, OAuth passthrough & mutateLogin', async () => {
  const tmpDir = mkStage2Sandbox('hz-mock');
  const srv = await startMockMagpieServer({
    initialUsageRows: [
      {
        id: 'r_keep_1',
        responseId: 'chatcmpl-keep-1',
        t: new Date(2000).toISOString(),
        req: 'deepseek/deepseek-reasoner',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        in: 100,
        out: 40,
        reasoning: 15,
        tries: 1,
        ms: 150,
        status: 200,
        priced: true,
        cost: 0, // Free-tier priced $0 (`HZ-01`)
      },
      {
        id: 'r_handed_on',
        t: new Date(2010).toISOString(),
        req: 'group/pool',
        provider: 'openai',
        model: 'gpt-5.2',
        in: 0,
        out: 0,
        status: 429,
        handed_on: true,
      },
      {
        id: 'r_session_log',
        t: new Date(2020).toISOString(),
        req: 'codex/gpt-5.2',
        provider: 'codex',
        model: 'gpt-5.2',
        in: 50,
        out: 10,
        origin: 'session',
        source: 'log',
      },
      {
        id: 'r_to_delete',
        t: new Date(2030).toISOString(),
        req: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        model: 'deepseek-chat',
        in: 50,
        out: 10,
        status: 200,
      },
    ],
  });

  try {
    // 1. Direct row normalization checks (`HZ-01`)
    assert.equal(normalizeMagpieUsageRow({ id: 'x1', handed_on: true, in: 10, out: 5 }), null);
    assert.equal(normalizeMagpieUsageRow({ id: 'x2', origin: 'session', in: 10, out: 5 }), null);
    assert.equal(normalizeMagpieUsageRow({ id: 'x3', rejected: true, in: 10, out: 5 }), null);
    const freeTierNorm = normalizeMagpieUsageRow({ id: 'x4', priced: true, cost: 0, in: 10, out: 5 });
    assert.equal(freeTierNorm.gatewayCostUsd, 0);

    const storageRoot = path.join(tmpDir, 'storage');
    const dshHome = path.join(tmpDir, 'dsh-home');
    const mgr = new MagpieGatewayManager({ storageRoot });
    mgr.configure({
      mode: 'external',
      externalGatewayUrl: srv.gatewayUrl,
      externalWebAdminUrl: srv.webUrl,
      externalWebKey: srv.webKey,
    });
    const bridge = new HengzhangUsageBridge({ storageRoot, dshHome, gatewayManager: mgr });

    // 2. Initial sync filters out handed_on & origin="session", keeps r_keep_1 & r_to_delete
    const sync1 = await bridge.triggerBackgroundMagpieSync();
    assert.equal(sync1.synced, true);
    assert.equal(sync1.totalCached, 2);
    assert.equal(bridge.gatewayRecordMap.get('r_keep_1').gatewayCostUsd, 0);

    // 3. Upsert `r_keep_1` with tries=3 and delete `r_to_delete` tombstone
    srv.upsertUsageRow({
      id: 'r_keep_1',
      responseId: 'chatcmpl-keep-1',
      t: new Date(2000).toISOString(),
      req: 'deepseek/deepseek-reasoner',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      in: 100,
      out: 40,
      reasoning: 15,
      tries: 3,
      ms: 290,
      status: 200,
    });
    srv.deleteUsageRow('r_to_delete');

    const sync2 = await bridge.triggerBackgroundMagpieSync();
    assert.equal(sync2.synced, true);
    assert.equal(bridge.gatewayRecords.length, 1);
    assert.equal(bridge.gatewayRecords[0].gatewayRecordId, 'r_keep_1');
    assert.equal(bridge.gatewayRecords[0].physicalAttempts, 3);

    // 4. Simulate Magpie `usage-feed.jsonl` rotation -> 410 cursor_reset -> bridge auto-recovers!
    srv.resetUsageFeed([
      {
        id: 'r_after_reset',
        responseId: 'chatcmpl-after-reset',
        t: new Date(3000).toISOString(),
        req: 'deepseek/deepseek-chat',
        provider: 'deepseek',
        model: 'deepseek-chat',
        in: 200,
        out: 60,
        reasoning: 20,
        tries: 2,
        ms: 180,
        status: 200,
      },
    ]);
    const sync3 = await bridge.triggerBackgroundMagpieSync();
    assert.equal(sync3.synced, true);
    assert.equal(bridge.gatewayRecords.length, 1);
    assert.equal(bridge.gatewayRecords[0].gatewayRecordId, 'r_after_reset');

    // 5. HZ-03: Direct Solo-Key call with `responseId` stays `sourceKind: "direct"`, custom pricing emits `priceSource: "custom"`, reasoningTokens preserved
    writeZstdSession(path.join(dshHome, 'sessions', 's1'), [
      { type: 'session', version: 4, id: 's1', createdAt: 1000, cwd: '/tmp/w' },
      {
        type: 'assistant/message',
        time: 2500,
        seq: 1,
        data: {
          message: {
            id: 'm-direct-1',
            source: {
              kind: 'model',
              provider: 'deepseek',
              model: 'deepseek/custom-direct-model',
              replayState: { response: { responseId: 'chatcmpl-direct-solo-99' } },
            },
          },
          usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200, reasoningTokens: 80, totalTokens: 1200 },
        },
      },
      {
        type: 'assistant/message',
        time: 3000,
        seq: 2,
        data: {
          message: {
            id: 'm-gw-1',
            source: {
              kind: 'model',
              provider: 'magpie',
              model: 'deepseek/deepseek-chat',
              replayState: { response: { responseId: 'chatcmpl-after-reset' } },
            },
          },
          usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60, totalTokens: 260 },
        },
      },
    ]);
    bridge.savePricing({
      usdToCny: 7.0,
      routes: {
        ...defaultPricing.routes,
        'deepseek/custom-direct-model': {
          currency: 'CNY',
          peak: { inputPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 0, outputPerM: 8 },
          offPeak: null,
          peakRule: null,
        },
      },
    });
    const repRes = await bridge.getSessionReport({ sessionId: 's1', syncGateway: false });
    const directPub = repRes.publicRecords.find(r => r.requestedRoute === 'deepseek/custom-direct-model');
    const gwPub = repRes.publicRecords.find(r => r.requestedRoute === 'deepseek/deepseek-chat');
    assert.equal(directPub.sourceKind, 'direct');
    assert.equal(directPub.cost.priceSource, 'custom');
    assert.equal(directPub.tokens.reasoningTokens, 80);
    assert.equal(gwPub.sourceKind, 'magpie');
    assert.equal(gwPub.tokens.reasoningTokens, 20);

    // 6. GW-04 (Mock): OAuth `claude-code` normalization, auto account-discovery unlock, callback, and mutateLogin
    const client = mgr.createClient();
    const signIn = await client.startSignIn({ agent: 'claude-code', linkOnly: true });
    assert.equal(signIn.agent, 'claude');
    assert.equal(signIn.state, 'waiting');
    assert.equal(signIn.status, 'waiting');
    assert.ok(signIn.url.startsWith('https://'));
    assert.equal(signIn.authUrl, signIn.url);

    const doneState = await client.submitSignInCallback(signIn.id, 'http://127.0.0.1:1455/callback?code=ok');
    assert.equal(doneState.state, 'done');
    assert.equal(doneState.status, 'done');

    const afterOff = await client.mutateLogin('off', { id: 'magpie:claude', user: 'user-claude@example.invalid' });
    const claudeProv = buildPublicProviders({ magpieProvidersPayload: afterOff }).providers.find(p => p.providerId === 'magpie:claude');
    assert.ok(claudeProv);
    assert.equal(claudeProv.credentials[0].enabled, false);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Live Magpie 0.1.4731 binary verification: GW-01..06 & HZ-01 (providerJSON CRUD, routing/affinity Go types, settings merge, sandboxed OAuth, feed 410 reset, CLI start/restart/stop & races)', async t => {
  const sysMagpie = discoverSystemMagpieBinary();
  if (!sysMagpie) {
    t.skip('No local Magpie binary installed on this host');
    return;
  }

  const tmpDir = mkStage2Sandbox('live-magpie');
  const relay = await startLocalDummyUpstreamRelay();
  const storageRoot = path.join(tmpDir, 'lt-storage');
  const cliStorageRoot = path.join(tmpDir, 'cli-storage');
  const mgr = new MagpieGatewayManager({ storageRoot });
  let foreignHelper = null;

  try {
    await mgr.install({ sourceBinaryPath: sysMagpie });
    const started = await mgr.start({ allocateDynamicPortsIfBusy: true });
    assert.equal(started.state, 'running');
    const client = mgr.createClient();

    // 1. GW-06: `updateSettings(patch)` preserves `noAutoUpdate: true` & `noStats: true` on real Magpie `settingsapi.Apply`
    await client.updateSettings({ lang: 'zh', proxy: 'http://127.0.0.1:9' });
    const afterSettings = await client.getSettings();
    assert.equal(afterSettings.lang, 'zh');
    assert.equal(afterSettings.noAutoUpdate, true);
    assert.equal(afterSettings.noStats, true);

    // 2. GW-01 & GW-02: Real Magpie `/api/provider/save`, multi-key `keyList`, `off`, `exposed`, `routing` & `*string` `affinity`
    await client.saveProvider({
      new: true,
      id: 'localrelay',
      name: 'Local Loopback Relay',
      chat: relay.baseUrl,
      key: 'sk-localrelay-alpha-111111111111,sk-localrelay-bravo-222222222222',
      models: ['alpha-model'],
    });

    // Set routing='round-robin' -> wire 'rotate' and sessionAffinity=false -> wire 'off' (no HTTP 400!)
    await client.setProviderRouting({ id: 'localrelay', route: 'round-robin', sessionAffinity: false });
    const rawProvPayload = await client.listProviders();
    const rawRelay = rawProvPayload.providers.find(p => p.id === 'localrelay');
    assert.ok(rawRelay);
    assert.equal(rawRelay.routing, 'rotate');
    assert.equal(rawRelay.affinity, 'off');

    const adapted = buildPublicProviders({
      magpieProvidersPayload: rawProvPayload,
      magpieGatewayUrl: mgr.getActiveEndpoints().gatewayUrl,
    });
    const pubRelay = adapted.providers.find(p => p.providerId === 'magpie:localrelay');
    assert.ok(pubRelay);
    assert.equal(pubRelay.status, 'ready');
    assert.equal(pubRelay.keyRotation, 'round-robin');
    assert.equal(pubRelay.sessionAffinity, false);
    assert.equal(pubRelay.credentials.length, 2);
    assert.equal(pubRelay.discoveredModelCount, 2);
    assert.equal(pubRelay.enabledModelCount, 1);
    assert.ok(adapted.presets.some(pr => Boolean(pr.keyUrl)), 'Real Magpie presets keysUrl mapped to keyUrl');

    // Toggle provider off -> real `p.off === true` -> adapted status === 'disabled'
    await client.toggleProvider('localrelay', false);
    const afterOff = buildPublicProviders({
      magpieProvidersPayload: await client.listProviders(),
      magpieGatewayUrl: mgr.getActiveEndpoints().gatewayUrl,
    }).providers.find(p => p.providerId === 'magpie:localrelay');
    assert.equal(afterOff.status, 'disabled');
    assert.equal(afterOff.enabledModelCount, 0);
    await client.toggleProvider('localrelay', true);

    // 3. HZ-01 (Live): Loopback chat completion -> feed sync -> rotate `usage-feed.jsonl` -> 410 auto-reset!
    // Clear global blackhole proxy temporarily so loopback localrelay works cleanly, then restore for OAuth
    await client.updateSettings({ proxy: '' });
    const ep = mgr.getActiveEndpoints();
    const chatRes = await fetch(`${ep.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer magpie-leaderteam',
        'Content-Type': 'application/json',
        'X-Magpie-Session': 'sess-live-01',
      },
      body: JSON.stringify({
        model: 'localrelay/alpha-model',
        messages: [{ role: 'user', content: 'loopback ping' }],
      }),
    });
    assert.equal(chatRes.status, 200);
    await chatRes.text();

    const bridge = new HengzhangUsageBridge({
      storageRoot,
      dshHome: path.join(tmpDir, 'dsh-home'),
      gatewayManager: mgr,
    });
    let liveSync1 = await bridge.triggerBackgroundMagpieSync();
    for (let wait = 0; wait < 25 && (liveSync1.totalCached ?? 0) < 1; wait++) {
      await new Promise(r => setTimeout(r, 25));
      liveSync1 = await bridge.triggerBackgroundMagpieSync();
    }
    assert.equal(liveSync1.synced, true);
    assert.ok(liveSync1.totalCached >= 1);
    assert.notEqual(bridge.nextCursor, 'start');

    // Locate and remove `usage-feed.jsonl` inside sandbox to trigger real Go `410 cursor_reset`
    const findFeedFiles = dir => {
      const found = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) found.push(...findFeedFiles(full));
        else if (ent.name.includes('usage-feed')) found.push(full);
      }
      return found;
    };
    for (const f of findFeedFiles(mgr.runtimeSandboxDir)) {
      fs.rmSync(f, { force: true });
    }
    // Emit a new loopback call so a fresh `usage-feed.jsonl` with a new feed header is created
    const chatRes2 = await fetch(`${ep.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer magpie-leaderteam',
        'Content-Type': 'application/json',
        'X-Magpie-Session': 'sess-live-02',
      },
      body: JSON.stringify({
        model: 'localrelay/alpha-model',
        messages: [{ role: 'user', content: 'loopback ping 2' }],
      }),
    });
    assert.equal(chatRes2.status, 200);
    await chatRes2.text();

    let liveSync2 = await bridge.triggerBackgroundMagpieSync();
    for (let wait = 0; wait < 25 && !bridge.gatewayRecords.some(r => r.sessionId === 'sess-live-02'); wait++) {
      await new Promise(r => setTimeout(r, 25));
      liveSync2 = await bridge.triggerBackgroundMagpieSync();
    }
    assert.equal(liveSync2.synced, true, `Expected 410 auto-recovery, got: ${JSON.stringify(liveSync2)}`);
    assert.equal(bridge.lastSyncError, null);
    assert.ok(bridge.gatewayRecords.some(r => r.sessionId === 'sess-live-02'));

    // 4. GW-04 (Live): Sandboxed OAuth sign-in auto-unlocks discovery inside `sandboxHome` & normalizes `gemini-cli`
    await client.updateSettings({ proxy: 'http://127.0.0.1:9' });
    const codexSignIn = await client.startSignIn({ agent: 'codex', linkOnly: true });
    assert.equal(codexSignIn.agent, 'codex');
    assert.equal(codexSignIn.state, 'waiting');
    assert.equal(codexSignIn.status, 'waiting');
    assert.ok(codexSignIn.url.includes('oauth'));
    assert.equal(codexSignIn.authUrl, codexSignIn.url);
    await client.cancelSignIn(codexSignIn.id);

    const geminiSignIn = await client.startSignIn({ agent: 'gemini-cli', linkOnly: true });
    assert.equal(geminiSignIn.agent, 'gemini');
    assert.equal(geminiSignIn.state, 'waiting');
    await client.cancelSignIn(geminiSignIn.id);

    // `configure({ allowLocalAccountDiscovery })` updates existing `settings.json`
    mgr.configure({ allowLocalAccountDiscovery: false });
    const sandboxSettings = JSON.parse(
      fs.readFileSync(path.join(mgr.runtimeSandboxDir, 'config', 'magpie', 'settings.json'), 'utf8'),
    );
    assert.equal(sandboxSettings.noAccountDiscovery, true);

    // 5. GW-05 (Live): `configure({ mode: 'disabled' })` terminates running managed child
    const runningPidBeforeDisable = (await mgr.getStatus()).health.pid;
    assert.ok(isPidAlive(runningPidBeforeDisable));
    mgr.configure({ mode: 'disabled' });
    const disableDeadline = Date.now() + 3000;
    while (Date.now() < disableDeadline && isPidAlive(runningPidBeforeDisable)) {
      await new Promise(r => setTimeout(r, 40));
    }
    assert.equal(isPidAlive(runningPidBeforeDisable), false, 'Child must exit when mode is switched to disabled');

    // 6. GW-05 (Live): `stop()` during in-flight `start()` race never spawns a lingering orphan
    const raceMgr = new MagpieGatewayManager({ storageRoot: path.join(tmpDir, 'race-storage') });
    const startP = raceMgr.start({ allocateDynamicPortsIfBusy: true }).catch(e => e);
    const stopRes = await raceMgr.stop();
    await startP;
    assert.equal(stopRes.state, 'stopped');
    assert.equal(raceMgr.child, null);
    assert.equal(fs.existsSync(raceMgr.pidFile), false);

    // 7. GW-03 (Live CLI): Separate `lt-magpie start` -> `restart` -> `stop` invocations + foreign PID protection
    const runCliJson = args => {
      const out = execFileSync(process.execPath, [ltMagpieCliPath, ...args, '--storage-root', cliStorageRoot, '--json'], {
        encoding: 'utf8',
        timeout: 20000,
      });
      return JSON.parse(out);
    };

    const cliStarted = runCliJson(['start', '--dynamic-ports']);
    assert.equal(cliStarted.state, 'running');
    const cliPid1 = cliStarted.health.pid;
    assert.ok(cliPid1 > 1 && isPidAlive(cliPid1), 'Daemonized CLI Magpie must stay alive after CLI exits');

    // Restart WITHOUT --dynamic-ports must cleanly stop cliPid1 and reuse the configured ports
    const cliRestarted = runCliJson(['restart']);
    assert.equal(cliRestarted.state, 'running');
    const cliPid2 = cliRestarted.health.pid;
    assert.notEqual(cliPid2, cliPid1);
    assert.equal(isPidAlive(cliPid1), false, 'Previous daemonized Magpie PID must be terminated on restart');
    assert.equal(isPidAlive(cliPid2), true);

    const cliStopped = runCliJson(['stop']);
    assert.equal(cliStopped.state, 'stopped');
    assert.equal(isPidAlive(cliPid2), false, 'CLI stop must terminate daemonized Magpie');

    // Foreign PID safety: plant a foreign helper PID in `managed-pid.json` and confirm `stop()` NEVER kills it
    foreignHelper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' });
    const cliMgr = new MagpieGatewayManager({ storageRoot: cliStorageRoot });
    fs.mkdirSync(cliMgr.runtimeSandboxDir, { recursive: true });
    fs.writeFileSync(
      cliMgr.pidFile,
      JSON.stringify({
        pid: foreignHelper.pid,
        binaryPath: process.execPath, // outside releasesDir!
        gatewayPort: 19999,
        webPort: 19998,
      }),
    );
    await cliMgr.stop();
    assert.equal(isPidAlive(foreignHelper.pid), true, 'Foreign process outside releasesDir must NEVER be signaled');

    // 8. GW-03 (Live CLI): Cross-process `lt-magpie rollback` restarts daemonized process cleanly
    const cliRbStart = runCliJson(['start', '--dynamic-ports']);
    const rbPidBefore = cliRbStart.health.pid;
    assert.ok(isPidAlive(rbPidBefore));
    const cliInst2 = await cliMgr.install({
      sourceBinaryPath: sysMagpie,
      version: '0.1.4797',
      expectedSha256: computeSha256File(sysMagpie),
    });
    assert.equal(cliInst2.version, '0.1.4797');
    const cliRbRes = runCliJson(['rollback']);
    assert.equal(cliRbRes.rolledBackTo, '0.1.4731');
    const cliStatusAfterRb = runCliJson(['status']);
    assert.equal(cliStatusAfterRb.state, 'running');
    assert.notEqual(cliStatusAfterRb.health.pid, rbPidBefore);
    assert.equal(isPidAlive(rbPidBefore), false);
    runCliJson(['stop']);

    // 9. CT-02 & CT-01: Stderr `&k=` / raw `managedWebKey` scrubbing & JSON Schema `$defs` completeness
    const creds = JSON.parse(fs.readFileSync(mgr.credentialsFile, 'utf8'));
    mgr.lastError = {
      code: 'TEST_LEAK',
      message: `failed at http://127.0.0.1:13430/?foo=1&k=${creds.managedWebKey} raw=${creds.managedWebKey}`,
      at: new Date().toISOString(),
    };
    const scrubbedStatus = await mgr.getStatus();
    assert.ok(!JSON.stringify(scrubbedStatus).includes(creds.managedWebKey));
    assert.match(scrubbedStatus.lastError.message, /&k=\[REDACTED\]/);

    const schemaJson = JSON.parse(
      fs.readFileSync(path.resolve(repoRoot, '..', 'lt-shared-contracts', 'schemas', 'lt-public-v1.schema.json'), 'utf8'),
    );
    assert.ok(Array.isArray(schemaJson.oneOf) && schemaJson.oneOf.length === 2);
    for (const defName of ['Capabilities', 'Gateway', 'ProviderDescriptor', 'ModelCatalogEntry', 'RuntimeSnapshot', 'LogicalUsageRecord', 'FlatBundleSnapshot', 'LiveBundleEnvelope']) {
      assert.ok(schemaJson.$defs?.[defName], `Schema missing $defs.${defName}`);
    }
  } finally {
    if (foreignHelper) {
      try { foreignHelper.kill('SIGKILL'); } catch {}
    }
    await mgr.stop().catch(() => {});
    const cliCleanupMgr = new MagpieGatewayManager({ storageRoot: cliStorageRoot });
    await cliCleanupMgr.stop().catch(() => {});
    await relay.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Stage 4 Re-Audit Fixes (S3-UIGW-01, S3-UIGW-02, S3-UIGW-03, S3-UIGW-06): live Magpie 0.1.4731 test-provider latency + scanNoSecretLeakage on providersMutate + mutate-key protocol/plan/refs + REPORT_CACHE in-place upsert invalidation + sync configure/start _stoppingPids drain', async t => {
  const sysMagpie = discoverSystemMagpieBinary();
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'lt-s4-uigw-gw-'));
  const relay = await startLocalDummyUpstreamRelay();
  const mockSrv = await startMockMagpieServer({
    initialUsageRows: [
      {
        id: 'r_cache_upsert_1',
        responseId: 'chatcmpl-cache-upsert-1',
        t: new Date(5000).toISOString(),
        session: 'sess-cache-1',
        req: 'group/flagship',
        provider: 'openai',
        model: 'gpt-5.2',
        in: 200,
        out: 50,
        tries: 1,
        ms: 110,
        status: 200,
        priced: true,
        cost: 0.01,
      },
    ],
  });
  let liveMgr = null;

  try {
    // Part A: S3-UIGW-03 — HengzhangUsageBridge + synced packages/lt-usage REPORT_CACHE invalidates on in-place feed upserts
    const dshHome = path.join(tmpDir, 'dsh-home');
    const mockStorage = path.join(dshHome, 'leaderteam');
    writeZstdSession(path.join(dshHome, 'sessions', 'proj', 'sess-cache-1'), [
      { type: 'session', version: 4, id: 'sess-cache-1', createdAt: 4900, cwd: '/tmp/proj' },
      {
        type: 'assistant/message',
        time: 5000,
        seq: 1,
        data: {
          message: {
            id: 'm-cache-1',
            source: {
              kind: 'model',
              provider: 'magpie',
              model: 'group/flagship',
              replayState: { response: { responseId: 'chatcmpl-cache-upsert-1' } },
            },
          },
          usage: { inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, totalTokens: 250 },
        },
      },
    ]);

    const mockGwMgr = new MagpieGatewayManager({ storageRoot: mockStorage });
    mockGwMgr.configure({
      mode: 'external',
      externalGatewayUrl: mockSrv.gatewayUrl,
      externalWebAdminUrl: mockSrv.webUrl,
      externalWebKey: mockSrv.webKey,
    });
    const bridge = new HengzhangUsageBridge({ storageRoot: mockStorage, dshHome, gatewayManager: mockGwMgr });

    const repBefore = await bridge.getSessionReport({ sessionId: 'sess-cache-1', syncGateway: true });
    const ovBefore = await bridge.getOverview({ syncGateway: false });
    assert.equal(repBefore.report.calls[0].actualProvider, 'openai');
    assert.equal(repBefore.report.calls[0].physicalAttempts, 1);
    assert.equal(repBefore.report.calls[0].latencyMs, 110);
    assert.equal(repBefore.publicRecords[0].cost.actualUsd, null);
    assert.equal(ovBefore.overview.totals.costActualCny, null);

    // Emit updated row for SAME `id: "r_cache_upsert_1"` at newer `seq` (length=1 & tail gatewayRecordId unchanged!)
    mockSrv.upsertUsageRow({
      id: 'r_cache_upsert_1',
      responseId: 'chatcmpl-cache-upsert-1',
      t: new Date(5000).toISOString(),
      session: 'sess-cache-1',
      req: 'group/flagship',
      provider: 'codex',
      model: 'gpt-6.2-sol',
      in: 200,
      out: 50,
      tries: 4,
      ms: 920,
      status: 200,
      priced: true,
      cost: 0.05,
    });

    const repAfter = await bridge.getSessionReport({ sessionId: 'sess-cache-1', syncGateway: true });
    const ovAfter = await bridge.getOverview({ syncGateway: false });
    assert.equal(repAfter.report.calls[0].actualProvider, 'codex', 'REPORT_CACHE must invalidate on in-place seq/provider/latency upsert');
    assert.equal(repAfter.report.calls[0].physicalAttempts, 4);
    assert.equal(repAfter.report.calls[0].latencyMs, 920);
    assert.ok(repAfter.publicRecords[0].cost.actualUsd > 0);
    assert.ok(ovAfter.overview.totals.costActualCny?.total > 0, 'Overview REPORT_CACHE must also invalidate on in-place upsert');

    if (!sysMagpie) {
      return;
    }

    // Part B: Live Magpie 0.1.4731 S3-UIGW-01 + S3-UIGW-02 + S3-UIGW-06 verification
    const liveStorage = path.join(tmpDir, 'live-storage');
    const cfgDir = path.join(liveStorage, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
    fs.copyFileSync(path.join(repoRoot, 'config', 'leaderteam.config.json'), cfgFile);

    liveMgr = getOrCreateGatewayManager(liveStorage);
    await liveMgr.install({ sourceBinaryPath: sysMagpie });
    const started1 = await liveMgr.start({ allocateDynamicPortsIfBusy: true });
    assert.equal(started1.state, 'running');
    const fixedGwPort = Number(new URL(started1.gatewayUrl).port);
    const oldWebPort = Number(new URL(started1.webAdminUrl).port);

    // S3-UIGW-06: Synchronous `configure({ webPort })` keeping `gatewayPort` fixed + immediate `start({ allocateDynamicPortsIfBusy: false })`
    const freeWebServer = http.createServer();
    await new Promise(r => freeWebServer.listen(0, '127.0.0.1', r));
    const newWebPort = freeWebServer.address().port;
    await new Promise(r => freeWebServer.close(r));
    assert.notEqual(newWebPort, oldWebPort);

    liveMgr.configure({ webPort: newWebPort });
    const started2 = await liveMgr.start({ allocateDynamicPortsIfBusy: false });
    assert.equal(started2.state, 'running');
    assert.equal(Number(new URL(started2.gatewayUrl).port), fixedGwPort);
    assert.equal(Number(new URL(started2.webAdminUrl).port), newWebPort);

    // Wire `public-api.mjs` handlers against the running live Magpie 0.1.4731 instance
    const rt = {
      storageRoot: liveStorage,
      configPath: cfgFile,
      config: loadConfig(cfgFile),
      plugins: {},
      cordisCompositionMode: true,
      stores: new Map(),
      actors: new Map(),
    };
    bindRuntimeConfigFile(rt, cfgFile, rt.config);
    const h = createPublicContractHandlers({ get: k => (k === 'profileContext' ? { home: dshHome } : null) }, rt);
    const postJson = body =>
      new Request('http://127.0.0.1/api/lt/v1/providers/mutate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Save loopback dummy relay provider
    const saveEnv = await (await h.providersMutate(postJson({
      operation: 'save-provider',
      spec: {
        new: true,
        id: 's4relay',
        name: 'Stage 4 Relay',
        chat: relay.baseUrl,
        key: 'sk-s4-live-primary-111111111111',
      },
    }))).json();
    assert.equal(saveEnv.ok, true);
    assert.deepEqual(scanNoSecretLeakage(saveEnv), []);

    // S3-UIGW-02: Add 2nd key forwarding `protocol` & `plan`, verify via raw Magpie `/api/providers`, then remove-many with `key:<id>` ref
    const addKeyEnv = await (await h.providersMutate(postJson({
      operation: 'mutate-key',
      providerId: 'magpie:s4relay',
      keyAction: 'add',
      name: 'Chat Scoped Key',
      key: 'sk-s4-live-second-222222222222',
      protocol: 'chat',
      plan: 'Pro',
    }))).json();
    assert.equal(addKeyEnv.ok, true);
    assert.deepEqual(addKeyEnv.data.operationResult, { applied: true });
    assert.deepEqual(scanNoSecretLeakage(addKeyEnv), []);

    const rawLiveProvs = await liveMgr.createClient().listProviders();
    const rawS4 = rawLiveProvs.providers.find(p => p.id === 's4relay');
    assert.equal(rawS4.keyList.length, 2);
    assert.equal(rawS4.keyList[1].protocol, 'chat');
    const secondCredId = addKeyEnv.data.providers.find(p => p.providerId === 'magpie:s4relay').credentials[1].credentialId;

    const removeManyEnv = await (await h.providersMutate(postJson({
      operation: 'mutate-key',
      providerId: 'magpie:s4relay',
      keyAction: 'remove-many',
      refs: [secondCredId],
    }))).json();
    assert.equal(removeManyEnv.ok, true, JSON.stringify(removeManyEnv));
    assert.equal(removeManyEnv.data.providers.find(p => p.providerId === 'magpie:s4relay').credentials.length, 1);
    assert.deepEqual(scanNoSecretLeakage(removeManyEnv), []);

    // S3-UIGW-01 & S3-UIGW-02: Live `test-provider`, `discover-models`, `refresh-models`, and `oauth-start`/`oauth-status`/`oauth-cancel`
    const testEnv = await (await h.providersMutate(postJson({
      operation: 'test-provider',
      id: 'magpie:s4relay',
    }))).json();
    assert.equal(testEnv.ok, true, JSON.stringify(testEnv));
    assert.deepEqual(scanNoSecretLeakage(testEnv), []);
    assert.equal(testEnv.data.operationResult.provider, undefined, 'Raw providerJSON must never leak in operationResult');
    const firstTest = testEnv.data.operationResult.results[0];
    assert.equal(firstTest.ok, true);
    assert.equal(firstTest.status, 200);
    assert.equal(firstTest.protocol, 'chat');
    assert.equal(typeof firstTest.latencyMs, 'number');
    assert.equal(typeof firstTest.ms, 'number');
    assert.equal(Number.isNaN(firstTest.latencyMs), false);

    const discEnv = await (await h.providersMutate(postJson({
      operation: 'discover-models',
      probe: { chat: relay.baseUrl, key: 'sk-s4-live-primary-111111111111' },
    }))).json();
    assert.equal(discEnv.ok, true);
    assert.equal(discEnv.data.operationResult.models.length, 2);
    assert.deepEqual(scanNoSecretLeakage(discEnv), []);

    const refreshEnv = await (await h.providersMutate(postJson({
      operation: 'refresh-models',
      id: 'magpie:s4relay',
    }))).json();
    assert.equal(refreshEnv.ok, true);
    assert.equal(refreshEnv.data.operationResult.provider, undefined);
    assert.equal(refreshEnv.data.operationResult.models.length, 2);
    assert.deepEqual(scanNoSecretLeakage(refreshEnv), []);

    await liveMgr.createClient().updateSettings({ proxy: 'http://127.0.0.1:9' });
    const oauthStartEnv = await (await h.providersMutate(postJson({
      operation: 'oauth-start',
      agent: 'codex',
    }))).json();
    assert.equal(oauthStartEnv.ok, true);
    assert.deepEqual(scanNoSecretLeakage(oauthStartEnv), []);
    assert.ok(oauthStartEnv.data.operationResult.id);
    assert.ok(oauthStartEnv.data.operationResult.authUrl.includes('oauth'));

    const oauthCancelEnv = await (await h.providersMutate(postJson({
      operation: 'oauth-cancel',
      signInId: oauthStartEnv.data.operationResult.id,
    }))).json();
    assert.equal(oauthCancelEnv.ok, true);
    assert.deepEqual(scanNoSecretLeakage(oauthCancelEnv), []);
  } finally {
    if (liveMgr) await liveMgr.stop().catch(() => {});
    await mockSrv.close().catch(() => {});
    await relay.close().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
