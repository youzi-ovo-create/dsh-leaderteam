import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MagpieGatewayManager,
  MagpieClient,
  evaluateMagpieVersionCompatibility,
  verifyMagpieReleaseSignature,
  probeMagpieApiCompatibility,
  buildPublicProviders,
  buildPublicModelCatalog,
  buildModelUpsertsFromCatalogEntries,
  normalizeMagpieUsageRow,
  discoverSystemMagpieBinary,
} from '../../leaderteam/gateway/index.mjs';
import { findFreeLoopbackPort } from '../../leaderteam/gateway/magpie-process.mjs';
import { applyModelConfigChanges } from '../../leaderteam/core/model-config-writer.mjs';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { buildSoloKeyStarterConfig, SOLO_PROVIDER_PRESETS } from '../../leaderteam/core/solo-key.mjs';
import { startMockMagpieServer } from './companion-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

test('Magpie version pinning, Ed25519 signature verification, and upstream compatibility evaluation', () => {
  assert.equal(evaluateMagpieVersionCompatibility('0.1.4731').status, 'pinned');
  assert.equal(evaluateMagpieVersionCompatibility('0.1.4797').compatible, true);
  assert.equal(evaluateMagpieVersionCompatibility('0.1.4820').status, 'newer-upstream-needs-probe');
  assert.equal(evaluateMagpieVersionCompatibility('0.1.1000').compatible, false);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const rawPubBase64 = spkiDer.subarray(spkiDer.length - 32).toString('base64');
  const sumsText = 'abc123  magpie-cli-linux-amd64\n';
  const msg = Buffer.from(`magpie release 0.1.4797\n${sumsText}`, 'utf8');
  const sigBase64 = crypto.sign(null, msg, privateKey).toString('base64');

  assert.equal(
    verifyMagpieReleaseSignature({
      version: 'v0.1.4797',
      sumsText,
      signatureBase64: sigBase64,
      publicKeyBase64: rawPubBase64,
    }),
    true,
  );
  assert.equal(
    verifyMagpieReleaseSignature({
      version: 'v0.1.4797',
      sumsText: sumsText + 'tampered',
      signatureBase64: sigBase64,
      publicKeyBase64: rawPubBase64,
    }),
    false,
  );
});

test('Magpie adapter & client: provider CRUD, multi-key pool, discovery, non-merging routes, role fallbacks, and zero secret leak', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-magpie-adapter-'));
  const srv = await startMockMagpieServer();
  try {
    const client = new MagpieClient({
      gatewayUrl: srv.gatewayUrl,
      webAdminUrl: srv.webUrl,
      webKey: srv.webKey,
    });

    // 1. Upstream compatibility probe succeeds against v0.1.4731 mock
    const compat = await probeMagpieApiCompatibility({
      gatewayUrl: srv.gatewayUrl,
      webAdminUrl: srv.webUrl,
      webKey: srv.webKey,
    });
    assert.equal(compat.ok, true);

    // 2. Pre-save discovery, provider save, multi-key add/weight/promote, and test
    const preList = await client.discoverProviderModels({ preset: 'deepseek', key: 'sk-alpha-secret-1234567890' });
    assert.equal(preList.models.length, 2);

    await client.saveProvider({ new: true, preset: 'deepseek', key: 'sk-alpha-secret-1234567890' });
    const afterAddKey = await client.mutateKey('add', {
      id: 'deepseek',
      name: 'Secondary Key',
      key: 'sk-bravo-secret-0987654321',
    });
    const secondaryRef = afterAddKey.providers[0].keyList.find(k => !k.active).id;
    await client.mutateKey('weight', { id: 'deepseek', ref: secondaryRef, weight: 3 });
    await client.setProviderRouting({ id: 'deepseek', route: 'round-robin', sessionAffinity: true });
    const testRes = await client.testProvider({ id: 'deepseek' });
    assert.equal(testRes.results[0].ok, true);

    // 3. Prepare LT config that ALREADY has a direct Solo-Key model `deepseek/deepseek-chat`
    const baseCfgRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'leaderteam.config.json'), 'utf8'));
    const starter = buildSoloKeyStarterConfig(baseCfgRaw, { preset: SOLO_PROVIDER_PRESETS[0] });
    starter.magpie = { provider: 'magpie' };
    starter.models['deepseek/deepseek-chat'] = {
      provider: 'deepseek',
      upstreamModel: 'deepseek-chat',
      family: 'deepseek',
      label: 'DeepSeek Chat (Direct)',
      efforts: ['none'],
      defaultEffort: 'none',
      vision: false,
    };
    const cfgDir = path.join(tmpDir, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(starter, null, 2) + '\n');
    const loadedBefore = loadConfig(cfgFile);

    // 4. Normalize providers & catalog: verify zero secret leakage and NO auto-merging of `deepseek-chat`
    const provPayload = await client.listProviders();
    const gwModels = await client.listGatewayModels();
    const pubProviders = buildPublicProviders({
      magpieProvidersPayload: provPayload,
      magpieGatewayUrl: srv.gatewayUrl,
      env: { DEEPSEEK_API_KEY: 'sk-direct-env-secret-9999999999' },
      effectiveConfig: loadedBefore,
    });
    const dsMagpieProv = pubProviders.providers.find(p => p.providerId === 'magpie:deepseek');
    assert.ok(dsMagpieProv);
    assert.equal(dsMagpieProv.status, 'ready');
    assert.equal(dsMagpieProv.keyRotation, 'round-robin');
    assert.equal(dsMagpieProv.sessionAffinity, true);
    assert.equal(dsMagpieProv.credentials.length, 2);
    assert.equal(dsMagpieProv.discoveredModelCount, 2);
    assert.equal(dsMagpieProv.enabledModelCount, 2);
    const dsPreset = pubProviders.presets.find(pr => pr.vendorId === 'deepseek');
    assert.equal(dsPreset.keyUrl, 'https://platform.deepseek.com/api_keys');

    const serializedProviders = JSON.stringify(pubProviders);
    assert.ok(!serializedProviders.includes('sk-alpha-secret'));
    assert.ok(!serializedProviders.includes('sk-bravo-secret'));
    assert.ok(!serializedProviders.includes('sk-direct-env-secret'));
    assert.ok(!serializedProviders.includes(srv.webKey));

    const catalog = buildPublicModelCatalog({
      magpieGatewayModels: gwModels,
      effectiveConfig: loadedBefore,
    });
    const dsChatModels = catalog.filter(m => m.upstreamModelId === 'deepseek-chat');
    assert.equal(dsChatModels.length, 2, 'Magpie and Direct deepseek-chat must remain distinct entries');
    assert.notEqual(dsChatModels[0].entryId, dsChatModels[1].entryId);
    assert.notEqual(dsChatModels[0].routeId, dsChatModels[1].routeId);

    // Verify `deepseek-reasoner` mapped `none` -> `off` with wireEffortMap `{"off":"none", ...}`
    const reasonerEntry = catalog.find(m => m.sourceKind === 'magpie' && m.upstreamModelId === 'deepseek-reasoner');
    assert.ok(reasonerEntry);
    assert.deepEqual(reasonerEntry.efforts.supported, ['off', 'low', 'medium', 'high']);
    assert.equal(reasonerEntry.efforts.wireEffortMap.off, 'none');

    // 5. Sync Magpie models into LT pool + assign role fallback chain
    const magpieEntries = catalog.filter(m => m.sourceKind === 'magpie');
    const upserts = buildModelUpsertsFromCatalogEntries(magpieEntries, {
      defaultMagpieHostProvider: 'magpie',
      enableInExecutionPool: true,
    });
    const applied = applyModelConfigChanges(
      {
        upsertModels: upserts,
        setRoles: [
          {
            role: 'gate',
            route: reasonerEntry.routeId,
            effort: 'off',
            fallback: [{ route: 'deepseek/deepseek-chat', effort: 'none', timeoutMs: 45000, retries: 1 }],
          },
        ],
      },
      { configFile: cfgFile, target: 'local' },
    );
    assert.equal(applied.saved, true);
    assert.equal(applied.effective.roles.gate.route, reasonerEntry.routeId);
    assert.equal(applied.effective.roles.gate.effort, 'off');
    assert.equal(applied.effective.roles.gate.fallback.length, 1);
    assert.equal(applied.effective.models[reasonerEntry.routeId].reasoningEfforts.off, 'none');

    // 6. Usage row normalization preserves unknown != 0 and separates tries
    const normRow = normalizeMagpieUsageRow({
      seq: 7,
      id: 'r_007',
      t: '2026-11-25T14:30:00Z',
      req: 'group/coding',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      in: 500,
      out: 120,
      cache_read: 300,
      reasoning: 80,
      tries: 2,
      ms: 910,
      ttft_ms: 190,
      status: 200,
      cost: 0,
    });
    assert.equal(normRow.physicalAttempts, 2);
    assert.equal(normRow.tokens.totalTokens, 920); // 500 + 300 + 0 + 120 (reasoning 80 NOT double-added!)
    assert.equal(normRow.gatewayCostUsd, null); // cost: 0 on unpriced/subscription is null, never fake 0
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Real Magpie binary lifecycle: isolated install, start, health, crash recovery, version rollback, and clean stop', async t => {
  const sysMagpie = discoverSystemMagpieBinary();
  if (!sysMagpie) {
    t.skip('No local Magpie binary installed on this host');
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-magpie-proc-'));
  const fakeUserHome = path.join(tmpDir, 'fake-user-home');
  const fakeUserDsh = path.join(fakeUserHome, '.dsh');
  fs.mkdirSync(path.join(fakeUserDsh, 'profiles', 'web'), { recursive: true });
  const sentinelPatch = path.join(fakeUserDsh, 'profiles', 'web', 'cordis.patch.yml');
  const sentinelContent = '# user patch sentinel\nproviders:\n  magpie:\n    baseUrl: http://127.0.0.1:3425/v1\n';
  fs.writeFileSync(sentinelPatch, sentinelContent);

  const gwPort = await findFreeLoopbackPort();
  let webPort = await findFreeLoopbackPort();
  while (webPort === gwPort) webPort = await findFreeLoopbackPort();
  const mgr = new MagpieGatewayManager({
    storageRoot: path.join(tmpDir, 'lt-storage'),
    defaultGatewayPort: gwPort,
    defaultWebPort: webPort,
  });

  try {
    // 1. Install verified 0.1.4731 binary
    const inst = await mgr.install({ sourceBinaryPath: sysMagpie });
    assert.equal(inst.installed, true);
    assert.ok(inst.version);

    // 2. Start on dynamic free ports with auto-recovery enabled
    const started = await mgr.start({ allocateDynamicPortsIfBusy: true });
    assert.equal(started.state, 'running');
    assert.equal(started.managementAuthenticated, true);
    assert.ok(started.health.pid > 0);
    const firstPid = started.health.pid;

    // Confirm status never leaks raw webKey
    const statusJson = JSON.stringify(started);
    const rawCreds = JSON.parse(fs.readFileSync(mgr.credentialsFile, 'utf8'));
    assert.ok(!statusJson.includes(rawCreds.managedWebKey));

    // Confirm live compatibility probe passes against verified (>= 0.1.4731) binary, or accurately flags older local host binary
    const compat = await mgr.checkCompatibility();
    if (evaluateMagpieVersionCompatibility(inst.version).compatible) {
      assert.equal(compat.ok, true);
    } else {
      assert.equal(compat.versionCompatibility.status, 'older-than-minimum');
    }

    // 3. Simulate abnormal crash (SIGKILL) and verify automatic recovery
    process.kill(firstPid, 'SIGKILL');
    const deadline = Date.now() + 7000;
    let recovered = null;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const st = await mgr.getStatus();
      if (st.state === 'running' && st.health.pid && st.health.pid !== firstPid) {
        recovered = st;
        break;
      }
    }
    assert.ok(recovered, 'MagpieGatewayManager should auto-recover after abnormal child exit');
    assert.ok(recovered.recoveryCount >= 1);

    // 4. Simulate installing a second release and rolling back while running
    await mgr.install({ sourceBinaryPath: sysMagpie, version: '0.1.4797', expectedSha256: inst.sha256 });
    const rb = await mgr.rollback();
    assert.equal(rb.rolledBackTo, inst.version);
    const afterRb = await mgr.getStatus();
    assert.equal(afterRb.state, 'running');

    // 5. Verify sentinel `~/.dsh` patch was NOT touched by Magpie's KeepDshWired
    assert.equal(fs.readFileSync(sentinelPatch, 'utf8'), sentinelContent);

    // 6. Clean stop
    const stopped = await mgr.stop();
    assert.equal(stopped.state, 'stopped');
  } finally {
    await mgr.stop().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
  }
});
