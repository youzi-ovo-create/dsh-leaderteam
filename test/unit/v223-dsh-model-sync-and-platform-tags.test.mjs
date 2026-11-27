import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  syncUpstreamModelsToDshSettings,
  syncModelsToDshDiskProfiles,
  writeDshCredentialsYamlEntry,
} from '../../leaderteam/core/upstream-models.mjs';
import {
  probeProviderKeyConnectivity,
  applyQuickOnboardingSetup,
} from '../../leaderteam/core/onboarding.mjs';
import {
  parseReleaseTagForPlatform,
  selectReleasesForPlatform,
  assertTargetReleaseTagMatchesPlatform,
  checkForUpdates,
  performOneClickUpgrade,
} from '../../leaderteam/core/updater.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

test('P0 UX Fix: standalone onboarding & runtime/configure write .credentials.yaml (v1) + profiles/*/cordis.patch.yml (llm-pi-ai & agent-default-model) when ctx is null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v223-dsh-sync-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const desktopPatch = path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml');
    const webPatch = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(desktopPatch), { recursive: true });
    fs.mkdirSync(path.dirname(webPatch), { recursive: true });

    // Seed existing desktop patch with custom UI plugin + conflicting modelOverrides to verify preservation & conflict cleanup
    fs.writeFileSync(
      desktopPatch,
      [
        '# Existing user profile patch',
        '- id: ui-chat',
        '  name: "@deepseek-ai/dsh-client-ui-chat"',
        '  config:',
        '    transcriptView: standard',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      openai:',
        '        modelOverrides:',
        '          gpt-4.1:',
        '            maxTokens: 8192',
        '',
      ].join('\n'),
      'utf8',
    );

    // Seed existing .credentials.yaml with OAuth `records:` block to verify non-destructive `refs:` update
    const credYaml = path.join(dshHome, '.credentials.yaml');
    fs.writeFileSync(
      credYaml,
      [
        'version: 1',
        'refs: {}',
        'records:',
        '  oauth-demo:',
        '    accessToken: "keep-existing-record"',
        '',
      ].join('\n'),
      'utf8',
    );

    const handlers = createPublicContractHandlers(
      null, // standalone lt-ui / lt-installer mode (`ctx === null`)
      { config: null, configPath: null, storageRoot: null },
      {
        dshHome,
        // Mock custom OpenAI-compatible gateway returning real `/v1/models` IDs different from static preset
        fetchImpl: async url => {
          const u = String(url);
          if (u.endsWith('/v1/models')) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: 'deepseek-reasoner', context_window: 128000, max_output_tokens: 64000 },
                  { id: 'deepseek-chat', context_window: 128000, max_output_tokens: 16384 },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response('Not Found', { status: 404 });
        },
      },
    );

    const testCredentialValue = 'test-relay-credential-token-987654';
    const onbRes = await handlers.onboarding(
      new Request('http://127.0.0.1/api/lt/v1/onboarding', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'apply-quick-setup',
          providerId: 'openai',
          apiKey: testCredentialValue,
          customBaseURL: 'https://relay.example.com/v1',
          collabPresetId: 'balanced-team',
          verifyConnectivity: true,
        }),
      }),
    );
    const onbJson = await onbRes.json();
    assert.equal(onbJson.ok, true);
    // Adapted to real `/v1/models` IDs returned by the endpoint!
    assert.equal(onbJson.data.provider.reasoningRoute, 'openai/deepseek-reasoner');
    assert.equal(onbJson.data.provider.chatRoute, 'openai/deepseek-chat');
    assert.equal(onbJson.data.dshSync.diskProfilesSynced, true);
    assert.ok(!JSON.stringify(onbJson).includes(testCredentialValue), 'never leaks credential in HTTP response');

    // 1. Verify `$DSH_HOME/.credentials.yaml` has `version: 1`, `OPENAI_API_KEY` under `refs:`, and preserved `records:`
    const updatedCredYaml = fs.readFileSync(credYaml, 'utf8');
    assert.match(updatedCredYaml, /^version:\s*1/m);
    assert.match(updatedCredYaml, /refs:\n\s+OPENAI_API_KEY:\s*"test-relay-credential-token-987654"/);
    assert.match(updatedCredYaml, /records:\n\s+oauth-demo:\n\s+accessToken:\s*"keep-existing-record"/);

    // 2. Verify `$DSH_HOME/profiles/desktop/cordis.patch.yml` & `web/cordis.patch.yml`
    for (const patchPath of [desktopPatch, webPatch]) {
      const yamlText = fs.readFileSync(patchPath, 'utf8');
      assert.match(yamlText, /- id: llm-pi-ai/);
      assert.match(yamlText, /baseURL:\s*"https:\/\/relay\.example\.com\/v1"/);
      assert.match(yamlText, /api:\s*"openai-completions"/);
      assert.match(yamlText, /apiKeyEnv:\s*"OPENAI_API_KEY"/);
      assert.match(yamlText, /- id:\s*"deepseek-reasoner"/);
      assert.match(yamlText, /- id:\s*"deepseek-chat"/);
      assert.ok(!yamlText.includes('modelOverrides'), 'conflicting modelOverrides removed when models[] is populated');
      assert.match(yamlText, /- id: agent-default-model/);
      assert.match(yamlText, /provider:\s*"openai"/);
      assert.match(yamlText, /model:\s*"deepseek-reasoner"/);
    }
    assert.match(fs.readFileSync(desktopPatch, 'utf8'), /- id: ui-chat/, 'preserves existing user plugin rows');

    // 3. Also verify standalone `runtime/configure` (`ctx === null`) syncs newly added models to disk profiles!
    const cfgRes = await handlers.runtimeConfigure(
      new Request('http://127.0.0.1/api/lt/v1/runtime/configure', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'local',
          changes: {
            upsertModels: [
              {
                route: 'deepseek/deepseek-v4-pro',
                provider: 'deepseek',
                upstreamModel: 'deepseek-v4-pro',
                family: 'deepseek',
                label: 'DeepSeek V4 Pro',
                efforts: ['low', 'high', 'max'],
                defaultEffort: 'high',
                enableInPool: true,
              },
            ],
            setRoles: [{ role: 'leader', route: 'deepseek/deepseek-v4-pro', effort: 'high' }],
          },
        }),
      }),
    );
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.ok, true);
    assert.equal(cfgJson.data.dshSettingsSync.synced, true);
    assert.equal(cfgJson.data.dshSettingsSync.mode, 'disk-profiles');
    const desktopAfterCfg = fs.readFileSync(desktopPatch, 'utf8');
    assert.match(desktopAfterCfg, /deepseek:/);
    assert.match(desktopAfterCfg, /- id:\s*"deepseek-v4-pro"/);
    assert.match(desktopAfterCfg, /provider:\s*"deepseek"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P0 UX Fix: syncUpstreamModelsToDshSettings filters invalid reasoningEfforts, strips modelOverrides, and syncs agentDefaultModel', async () => {
  let savedLlmData = null;
  let savedDefaultSel = null;
  const mockCtx = {
    get(name) {
      if (name === 'settings') {
        return {
          describe: () => ({
            namespaces: [
              {
                ns: 'llm-pi-ai',
                data: {
                  providers: {
                    openai: {
                      modelOverrides: { 'gpt-4.1': { maxTokens: 4096 } },
                    },
                  },
                },
              },
            ],
          }),
          update: async (_ns, data) => {
            savedLlmData = data;
          },
        };
      }
      if (name === 'agentDefaultModel') {
        return {
          saveSelection: async sel => {
            savedDefaultSel = sel;
          },
        };
      }
      return null;
    },
  };

  const res = await syncUpstreamModelsToDshSettings(
    mockCtx,
    [
      {
        route: 'openai/custom-coder-v1',
        provider: 'openai',
        upstreamModel: 'custom-coder-v1',
        efforts: ['none', 'low', 'high', 'bogus-invalid-effort'],
        reasoningEfforts: { low: 'low', high: 'high', invalidKey: 'bad' },
      },
    ],
    'openai',
    {
      providerTemplates: {
        openai: {
          displayName: 'OpenAI',
          baseURL: 'https://api.openai.com/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
        },
      },
      defaultSelection: { provider: 'openai', model: 'custom-coder-v1', reasoningEffort: 'high' },
      syncDefaultModel: true,
    },
  );

  assert.equal(res.synced, true);
  assert.equal(res.defaultModelSynced, true);
  assert.equal('modelOverrides' in savedLlmData.providers.openai, false);
  const customModel = savedLlmData.providers.openai.models[0];
  assert.equal(customModel.id, 'custom-coder-v1');
  assert.equal(customModel.api, 'openai-completions', 'custom model on builtin openai gets explicit api');
  assert.deepEqual(customModel.reasoningEfforts, { off: 'none', low: 'low', high: 'high' });
  assert.deepEqual(savedDefaultSel, { provider: 'openai', model: 'custom-coder-v1', reasoningEffort: 'high' });
});

test('Cross-Platform Release Tag Governance: windows-vX.Y.Z vs linux-vX.Y.Z strict isolation, legacy fallback, and PLATFORM_RELEASE_TAG_MISMATCH', async () => {
  // 1. Tag parser
  assert.deepEqual(parseReleaseTagForPlatform('windows-v2.2.3'), {
    tagName: 'windows-v2.2.3',
    version: '2.2.3',
    prefix: 'windows',
    platformScope: 'win32',
  });
  assert.deepEqual(parseReleaseTagForPlatform('linux-v2.2.4'), {
    tagName: 'linux-v2.2.4',
    version: '2.2.4',
    prefix: 'linux',
    platformScope: 'linux',
  });
  assert.deepEqual(parseReleaseTagForPlatform('v2.2.0'), {
    tagName: 'v2.2.0',
    version: '2.2.0',
    prefix: null,
    platformScope: 'universal',
  });
  assert.equal(parseReleaseTagForPlatform('vps-freeze/v2.2.3-r3'), null);

  // 2. Mixed release feed where Linux is ahead (`linux-v2.2.4`) while Windows latest is `windows-v2.2.3`
  const mixedReleases = [
    {
      tag_name: 'linux-v2.2.4',
      name: 'LeaderTeam Linux v2.2.4',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-2.2.4.tgz', browser_download_url: 'https://mock.example/linux-2.2.4.tgz' }],
    },
    {
      tag_name: 'windows-v2.2.3',
      name: 'LeaderTeam Windows v2.2.3',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-2.2.3.tgz', browser_download_url: 'https://mock.example/win-2.2.3.tgz' }],
    },
    {
      tag_name: 'v2.2.0',
      name: 'Legacy Universal v2.2.0',
      prerelease: false,
      assets: [{ name: 'dsh-leaderteam-2.2.0.tgz', browser_download_url: 'https://mock.example/legacy-2.2.0.tgz' }],
    },
  ];

  const winSelected = selectReleasesForPlatform(mixedReleases, { platform: 'win32' });
  assert.deepEqual(winSelected.map(r => r.tagName), ['windows-v2.2.3']);
  assert.equal(winSelected[0].version, '2.2.3');
  assert.equal(winSelected[0].asset.downloadUrl, 'https://mock.example/win-2.2.3.tgz');

  const linuxSelected = selectReleasesForPlatform(mixedReleases, { platform: 'linux' });
  assert.deepEqual(linuxSelected.map(r => r.tagName), ['linux-v2.2.4']);
  assert.equal(linuxSelected[0].version, '2.2.4');

  // 3. Legacy fallback ONLY when zero same-platform prefixed releases exist (never picks opposite platform!)
  const onlyLinuxAndLegacy = mixedReleases.filter(r => r.tag_name !== 'windows-v2.2.3');
  const winFallback = selectReleasesForPlatform(onlyLinuxAndLegacy, { platform: 'win32' });
  assert.deepEqual(winFallback.map(r => r.tagName), ['v2.2.0']);

  const onlyLinuxNoLegacy = mixedReleases.filter(r => r.tag_name === 'linux-v2.2.4');
  assert.deepEqual(selectReleasesForPlatform(onlyLinuxNoLegacy, { platform: 'win32' }), []);

  // 4. Explicit cross-platform tag MUST throw PLATFORM_RELEASE_TAG_MISMATCH
  assert.throws(
    () => assertTargetReleaseTagMatchesPlatform('linux-v2.2.4', 'win32'),
    err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
  );
  assert.throws(
    () => assertTargetReleaseTagMatchesPlatform('windows-v2.2.3', 'linux'),
    err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
  );

  // 5. End-to-end `checkForUpdates` & `performOneClickUpgrade` on Windows when remote has `linux-v2.2.4` + `windows-v2.2.3`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v223-plat-upd-'));
  try {
    const fakePlugin = path.join(tmp, 'installed-v222');
    fs.mkdirSync(path.join(fakePlugin, 'leaderteam'), { recursive: true });
    fs.writeFileSync(
      path.join(fakePlugin, 'package.json'),
      JSON.stringify({ name: 'dsh-leaderteam', version: '2.2.2', license: 'Apache-2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    );
    fs.writeFileSync(
      path.join(fakePlugin, 'leaderteam', 'package.json'),
      JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.2', leaderteam: { distributionTrack: 'open-source' } }),
    );

    const mockFetch = async () =>
      new Response(JSON.stringify(mixedReleases), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const winCheck = await checkForUpdates({
      pluginRoot: fakePlugin,
      storageRoot: path.join(tmp, 'store'),
      platform: 'win32',
      force: true,
      fetchImpl: mockFetch,
    });
    assert.equal(winCheck.hasUpdate, true);
    assert.equal(winCheck.latestRelease.tagName, 'windows-v2.2.3');
    assert.equal(winCheck.latestRelease.version, '2.2.3');

    await assert.rejects(
      () =>
        performOneClickUpgrade({
          pluginRoot: fakePlugin,
          storageRoot: path.join(tmp, 'store'),
          platform: 'win32',
          targetVersion: 'linux-v2.2.4',
          fetchImpl: mockFetch,
        }),
      err => err.code === 'PLATFORM_RELEASE_TAG_MISMATCH',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('DSH 0.2.2-rc.1 Empirical Fact 3: openai-compatible discovery (sim-reasoner-v1/sim-flash-v2), reserved builtin ID avoidance, non-reasoning effort omission, and conditional agentDefaultModel sync', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-v223-fact3-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    const configPath = path.join(storageRoot, 'config', 'leaderteam.config.json');
    const bundledDefaultConfigPath = path.join(REPO_ROOT, 'config', 'leaderteam.config.json');

    let savedLlmData = null;
    let savedDefaultSel = null;
    const savedCreds = new Map();

    // Direct property services (`ctx.settings`, `ctx.credentials`, `ctx.agentDefaultModel`, `ctx.llm`) as in DSH 0.2.2-rc.1
    const mockCtxUnavailableDefault = {
      credentials: {
        set: async (k, v) => savedCreds.set(k, v),
      },
      settings: {
        describe: () => ({
          namespaces: [{ ns: 'llm-pi-ai', data: { providers: {} } }],
        }),
        update: async (_ns, data) => {
          savedLlmData = data;
        },
      },
      llm: {
        listModels: async () => [], // current default model has no credentials -> unavailable!
      },
      agentDefaultModel: {
        getSelection: async () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
        saveSelection: async sel => {
          savedDefaultSel = sel;
        },
      },
    };

    const simCred = 'sim-gateway-token-20261127';
    const setupRes = await applyQuickOnboardingSetup({
      ctx: mockCtxUnavailableDefault,
      storageRoot,
      dshHome,
      configPath,
      bundledDefaultConfigPath,
      providerId: 'openai-compatible',
      apiKey: simCred,
      customBaseURL: 'http://127.0.0.1:19876', // without /v1 -> probe resolves /v1/models and preserves /v1!
      verifyConnectivity: false, // auto-probes custom baseURL even without verifyConnectivity checkbox!
      fetchImpl: async url => {
        if (String(url) === 'http://127.0.0.1:19876/v1/models') {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'sim-reasoner-v1', context_window: 262144, max_output_tokens: 32768 },
                { id: 'sim-flash-v2', context_window: 131072, max_output_tokens: 16384 },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      },
      env: {},
    });

    assert.equal(setupRes.applied, true);
    assert.equal(setupRes.provider.id, 'openai-compatible');
    assert.equal(setupRes.provider.reasoningRoute, 'openai-compatible/sim-reasoner-v1');
    assert.equal(setupRes.provider.chatRoute, 'openai-compatible/sim-flash-v2');
    assert.equal(savedCreds.get('OPENAI_COMPATIBLE_API_KEY'), simCred);

    const compatProv = savedLlmData?.providers?.['openai-compatible'];
    assert.ok(compatProv, 'openai-compatible registered in llm-pi-ai');
    assert.equal(compatProv.baseURL, 'http://127.0.0.1:19876/v1', 'preserves /v1 in custom gateway baseURL');
    assert.equal(compatProv.apiKeyEnv, 'OPENAI_COMPATIBLE_API_KEY', 'keeps valid apiKeyEnv without clearApiKeyEnv');

    const reasonerEntry = compatProv.models.find(m => m.id === 'sim-reasoner-v1');
    const flashEntry = compatProv.models.find(m => m.id === 'sim-flash-v2');
    assert.ok(reasonerEntry && flashEntry);
    assert.deepEqual(reasonerEntry.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high' });
    assert.equal('reasoningEfforts' in flashEntry, false, 'non-reasoning model MUST NOT emit { off: "none" }');
    assert.equal(savedDefaultSel?.provider, 'openai-compatible');
    assert.equal(savedDefaultSel?.model, 'sim-reasoner-v1');

    // Verify reserved builtin DSH adapter IDs (`deepseek-official`, `deepseek-account`) are NEVER written to `llm-pi-ai`,
    // and existing available default model is NOT overwritten when `onlyIfNoAvailableDefault: true`
    let secondDefaultSaveCount = 0;
    const mockCtxWithAvailableDefault = {
      settings: mockCtxUnavailableDefault.settings,
      llm: {
        listModels: async prov => (prov === 'openai-compatible' ? [{ id: 'sim-reasoner-v1' }] : []),
      },
      agentDefaultModel: {
        getSelection: async () => ({ provider: 'openai-compatible', model: 'sim-reasoner-v1' }),
        saveSelection: async () => {
          secondDefaultSaveCount += 1;
        },
      },
    };

    await syncUpstreamModelsToDshSettings(
      mockCtxWithAvailableDefault,
      [
        { route: 'deepseek-official/deepseek-chat', provider: 'deepseek-official', upstreamModel: 'deepseek-chat', efforts: ['none'] },
        { route: 'deepseek-account/deepseek-chat', provider: 'deepseek-account', upstreamModel: 'deepseek-chat', efforts: ['off'] },
        { route: 'deepseek/deepseek-flash', provider: 'deepseek', upstreamModel: 'deepseek-flash', efforts: ['off'] },
      ],
      'deepseek',
      {
        providerTemplates: {
          deepseek: { displayName: 'DeepSeek', api: 'openai-completions', baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
        },
        defaultSelection: { provider: 'deepseek', model: 'deepseek-flash' },
        syncDefaultModel: true,
        onlyIfNoAvailableDefault: true,
      },
    );

    assert.equal('deepseek-official' in savedLlmData.providers, false, 'never writes reserved deepseek-official');
    assert.equal('deepseek-account' in savedLlmData.providers, false, 'never writes reserved deepseek-account');
    const dsFlash = savedLlmData.providers.deepseek.models.find(m => m.id === 'deepseek-flash');
    assert.equal('reasoningEfforts' in dsFlash, false, 'efforts:["off"] without thinking levels never emits { off: "none" }');
    assert.equal(secondDefaultSaveCount, 0, 'preserves already-available host default model');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
