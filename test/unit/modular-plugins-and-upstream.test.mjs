import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { configWith } from './helpers.mjs';
import {
  runtime,
  bindRuntimeConfigFile,
  isPluginActive,
  registerRuntimePlugin,
  refreshUpstreamCatalog,
  effectiveRuntimeConfig,
} from '../../leaderteam/host/runtime.mjs';
import { leaderAllowedTools } from '../../leaderteam/host/roles.mjs';
import {
  discoverRuntimeModels,
  mergeUpstreamModelsIntoConfig,
  resolveModelTarget,
  syncUpstreamModelsToDshSettings,
} from '../../leaderteam/core/upstream-models.mjs';
import { createPanelHandlers } from '../../leaderteam/plugins/leaderteam-panel/panel-api.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('detachable plugins: Cordis fiber mount/unmount and config.plugins.* soft-detach cleanly hide tools without breaking core', () => {
  const rt = runtime();
  const prev = { ...rt, plugins: { ...(rt.plugins ?? {}) } };
  try {
    rt.config = configWith({});
    rt.cordisCompositionMode = true;
    rt.plugins = { scheduler: null, consensus: null, timerArchive: null, panel: null };

    // When no optional plugin fibers are mounted in modular mode, optional tools are hidden while core leader tools remain
    assert.equal(isPluginActive(rt, 'scheduler'), false);
    assert.equal(isPluginActive(rt, 'consensus'), false);
    assert.equal(isPluginActive(rt, 'timerArchive'), false);
    const minimalTools = leaderAllowedTools(rt);
    assert.equal(minimalTools.includes('team_concurrency'), false);
    assert.equal(minimalTools.includes('team_discuss'), false);
    assert.equal(minimalTools.includes('team_plan_archive'), false);
    assert.equal(minimalTools.includes('team_dispatch'), true);
    assert.equal(minimalTools.includes('team_models'), true);
    assert.equal(minimalTools.includes('team_status'), true);

    // Mounting scheduler + timerArchive fibers activates only their tools
    const disposeSched = registerRuntimePlugin('scheduler', {}, rt);
    const disposeTimer = registerRuntimePlugin('timerArchive', {}, rt);
    assert.equal(isPluginActive(rt, 'scheduler'), true);
    assert.equal(isPluginActive(rt, 'timerArchive'), true);
    assert.equal(leaderAllowedTools(rt).includes('team_concurrency'), true);
    assert.equal(leaderAllowedTools(rt).includes('team_plan_archive'), true);
    assert.equal(leaderAllowedTools(rt).includes('team_discuss'), false);

    // Soft-detaching via config.plugins.scheduler = false overrides even a mounted fiber immediately
    rt.config = configWith({ plugins: { scheduler: false } });
    assert.equal(isPluginActive(rt, 'scheduler'), false);
    assert.equal(leaderAllowedTools(rt).includes('team_concurrency'), false);

    disposeSched();
    disposeTimer();
    assert.equal(rt.plugins.timerArchive, null);
  } finally {
    Object.assign(rt, prev);
  }
});

test('dynamic upstream DSH model discovery merges multi-provider models, supports effort="none", and syncs DSH settings', async () => {
  const baseCfg = configWith({ team: { autoIncludeUpstreamModels: true } });
  let savedNs = null;
  let savedData = null;

  const mockCtx = {
    llm: {
      listProviders() {
        return [
          { id: 'magpie', name: 'Magpie Gateway' },
          { id: 'deepseek', name: 'DeepSeek Official' },
          { id: 'ollama', name: 'Local Ollama' },
        ];
      },
      async listModels(providerId) {
        if (providerId === 'magpie') {
          return [{ id: 'zcode/GLM-5.3', name: 'GLM 5.3' }, { id: 'openrouter/qwen-3-max', name: 'Qwen 3 Max' }];
        }
        if (providerId === 'deepseek') {
          return [{ id: 'deepseek-chat', name: 'DeepSeek V3 Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek R1' }];
        }
        if (providerId === 'ollama') {
          return [{ id: 'qwen2.5-coder:32b', name: 'Local Qwen Coder' }];
        }
        return [];
      },
      async resolveModelInfo(providerId, modelId) {
        if (providerId === 'deepseek' && modelId === 'deepseek-reasoner') {
          return { name: 'DeepSeek R1', reasoning: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' } };
        }
        if (providerId === 'openrouter' || modelId === 'openrouter/qwen-3-max') {
          return { name: 'Qwen 3 Max', reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' } };
        }
        // Non-reasoning chat/local models report no reasoning efforts -> inferred as ['none']
        return { name: modelId, context: { contextWindow: 65536 } };
      },
      listConfigurableProviders() {
        return [{ settingsNs: 'llm-pi-ai' }];
      },
      async discoverModels(_ns, { provider }) {
        if (provider === 'deepseek') {
          return [{ id: 'deepseek-coder-v3', name: 'DeepSeek Coder V3' }];
        }
        return [];
      },
    },
    get(service) {
      if (service === 'settings') {
        return {
          describe() {
            return {
              namespaces: [{
                ns: 'llm-pi-ai',
                data: {
                  providers: {
                    deepseek: { api: 'openai-completions', baseURL: 'https://api.deepseek.com/v1', models: [{ id: 'deepseek-chat' }] },
                  },
                },
              }],
            };
          },
          async update(ns, data) {
            savedNs = ns;
            savedData = data;
          },
        };
      }
      return null;
    },
  };

  const cat = await discoverRuntimeModels(mockCtx, baseCfg, { probeEndpoints: true });
  assert.ok(cat.models.some(m => m.route === 'openrouter/qwen-3-max' && m.family === 'qwen'));
  const dsChat = cat.models.find(m => m.provider === 'deepseek' && m.upstreamModel === 'deepseek-chat');
  assert.ok(dsChat);
  assert.equal(dsChat.route, 'deepseek/deepseek-chat');
  assert.deepEqual(dsChat.efforts, ['none']);

  const merged = mergeUpstreamModelsIntoConfig(baseCfg, cat);
  assert.ok(merged.models['deepseek/deepseek-chat']);
  assert.ok(merged.team.executionPool.includes('deepseek/deepseek-chat'));
  assert.ok(merged.team.executionPool.includes('ollama/qwen2.5-coder:32b'));

  // Non-reasoning model target omits reasoningEffort cleanly
  const callTarget = resolveModelTarget(merged, 'deepseek/deepseek-chat', 'none');
  assert.deepEqual(callTarget, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal('reasoningEffort' in callTarget, false);

  // Sync newly discovered endpoint model into DSH settings
  const syncRes = await syncUpstreamModelsToDshSettings(mockCtx, [
    { route: 'deepseek/deepseek-coder-v3', provider: 'deepseek', upstreamModel: 'deepseek-coder-v3', efforts: ['none'] },
  ]);
  assert.equal(syncRes.synced, true);
  assert.equal(syncRes.changed, true);
  assert.equal(savedNs, 'llm-pi-ai');
  assert.ok(savedData.providers.deepseek.models.some(m => m.id === 'deepseek-coder-v3'));
});

test('in-DSH leaderteam-panel host API routes and client.js module loader work end-to-end', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-panel-api-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  const storageRoot = path.join(tmp, 'storage');
  const rawCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), 'utf8'));
  rawCfg.storage = { root: storageRoot };
  fs.writeFileSync(cfgFile, JSON.stringify(rawCfg, null, 2));

  const rt = runtime();
  const prev = { ...rt, plugins: { ...(rt.plugins ?? {}) } };
  t.after(() => Object.assign(rt, prev));

  const mockCtx = {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      resolveModelInfo: async () => ({ name: 'DeepSeek Chat' }),
    },
    get: () => null,
  };
  bindRuntimeConfigFile(rt, cfgFile, configWith({ storage: { root: storageRoot } }));
  rt.storageRoot = storageRoot;
  rt.llm = mockCtx.llm;
  rt.cordisCompositionMode = false;
  await refreshUpstreamCatalog(mockCtx, rt, { force: true });

  const handlers = createPanelHandlers(mockCtx, rt);
  const post = async (fn, body = {}) => (await fn(new Request('http://127.0.0.1/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))).json();

  const stateRes = await post(handlers.state, {});
  assert.equal(stateRes.ok, true);
  assert.ok(stateRes.value.unifiedModels.some(m => m.route === 'deepseek/deepseek-chat'));

  // Apply newly discovered upstream non-reasoning model (`deepseek/deepseek-chat`, effort='none') to leader role via panel!
  const applyRes = await post(handlers.apply, {
    target: 'local',
    changes: {
      setRoles: [{ role: 'leader', route: 'deepseek/deepseek-chat', effort: 'none' }],
      poolEnable: ['deepseek/deepseek-chat'],
    },
  });
  assert.equal(applyRes.ok, true);
  assert.equal( effectiveRuntimeConfig(rt).roles.leader.route, 'deepseek/deepseek-chat');
  assert.equal( effectiveRuntimeConfig(rt).roles.leader.effort, 'none');

  // Verify client.js registers cleanly with DSH's `window.__ModuleLoader__.load` and mounts both main & right-sidebar slots
  const clientCode = fs.readFileSync(path.join(REPO_ROOT, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'utf8');
  let loadedDescriptor = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(desc) { loadedDescriptor = desc; },
      },
    },
    fetch: async () => ({ ok: true, json: async () => stateRes }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(clientCode, sandbox);
  assert.ok(loadedDescriptor);
  assert.equal(loadedDescriptor.id, 'leaderteam-panel');

  const registeredSlots = [];
  let rightTabRegistered = false;
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => [init, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
  };
  const clientPlugin = loadedDescriptor.factory(mod => {
    if (mod === 'react') return fakeReact;
    throw new Error(`Unexpected module: ${mod}`);
  });
  clientPlugin.apply({
    effect(fn) { fn(); return () => {}; },
    slots: {
      inject(_name, cb) { return cb(); },
      register(reg) { registeredSlots.push(reg.name); return () => {}; },
    },
    inject(_deps, cb) {
      cb({
        sidebarRightTabs: { register() { rightTabRegistered = true; return () => {}; } },
        slots: {
          inject(_name, innerCb) { return innerCb(); },
          register(reg) { registeredSlots.push(reg.name); return () => {}; },
        },
      });
    },
  });
  assert.equal(rightTabRegistered, true);
  assert.ok(registeredSlots.includes('main'));
  assert.ok(registeredSlots.includes('sidebar.panellist'));
  assert.ok(registeredSlots.includes('sidebar.right.pane.tab'));
});
