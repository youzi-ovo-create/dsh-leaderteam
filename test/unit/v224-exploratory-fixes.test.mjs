import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: `virtual-v224:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v224:@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const defineTool = d => d; export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH";',
      };
    }
    if (url === 'virtual-v224:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class ToolExecutionPipeline { async dispatchToolBody(exec) { const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet); return await tool.execute(exec.arguments, exec); } }',
      };
    }
    if (url === 'virtual-v224:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: '{"version":"0.2.2-rc.5"}' };
    }
    if (url.startsWith('virtual-v224:')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler {} export const createUserMessage = x => x; export default {};',
      };
    }
    return nextLoad(url, context);
  },
});

import { loadConfig } from '../../leaderteam/core/config.mjs';
import { hashJson } from '../../leaderteam/core/canonical.mjs';
import {
  readSessionConfigRecord,
  mutateSessionConfig,
  markProcessActiveTurn,
} from '../../leaderteam/core/session-config.mjs';
import {
  checkForUpdates,
  performOneClickUpgrade,
  rollbackToSavedBackup,
  createPreUpgradeBackup,
} from '../../leaderteam/core/updater.mjs';
import {
  runtime,
  runtimeForTeam,
  teamStore,
  bindRuntimeConfigFile,
} from '../../leaderteam/host/runtime.mjs';
import { onAgentStatus } from '../../leaderteam/host/roles.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { buildReport } from '../../packages/lt-usage/index.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

// Child worker mode for O4 real multi-process concurrency verification
if (process.env.LT_V224_WORKER_MODE === 'session-config-writer') {
  const { storageRoot, cfgFile, sessionId, roleKey, route, barrierFile } = JSON.parse(process.env.LT_V224_WORKER_ARGS);
  const rt = runtime();
  Object.assign(rt, {
    storageRoot,
    actors: new Map(),
    stores: new Map(),
    teamConfigViews: new Map(),
    inFlightToolDispatchesByTeam: new Map(),
    inFlightShellCallsBySession: new Map(),
    simpleDispatchInFlight: new Map(),
    executionReviewJobs: new Map(),
    governanceJobs: new Map(),
    stopReviewPending: new Set(),
    directiveVerifyPending: new Set(),
    upstreamCatalog: null,
  });
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));
  const handlers = createPublicContractHandlers(null, rt, { dshHome: path.dirname(storageRoot) });
  while (!fs.existsSync(barrierFile)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  const res = await handlers.workbenchSessionConfig(
    new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'set',
        sessionId,
        patch: {
          roles: {
            [roleKey]: { route, effort: 'none' },
          },
        },
      }),
    }),
  );
  const json = await res.json();
  if (!json.ok) {
    console.error(JSON.stringify(json));
    process.exit(2);
  }
  process.exit(0);
}

function makeSandbox(t, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `lt-v224-${label}-`));
  const dshHome = path.join(tmp, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const cfgDir = path.join(storageRoot, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
  const baseCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), 'utf8'));
  baseCfg.models['dashscope/qwen-max'] = {
    provider: 'dashscope',
    upstreamModel: 'qwen-max',
    family: 'qwen',
    label: 'Qwen Max',
    efforts: ['none', 'high'],
    defaultEffort: 'high',
  };
  baseCfg.models['dashscope/qwen-plus'] = {
    provider: 'dashscope',
    upstreamModel: 'qwen-plus',
    family: 'qwen',
    label: 'Qwen Plus',
    efforts: ['none'],
    defaultEffort: 'none',
  };
  baseCfg.roles.leader = { route: 'dashscope/qwen-max', effort: 'high' };
  baseCfg.team.executionPool = ['dashscope/qwen-max', 'dashscope/qwen-plus'];
  fs.writeFileSync(cfgFile, `${JSON.stringify(baseCfg, null, 2)}\n`);

  const rt = runtime();
  const prev = { ...rt };
  Object.assign(rt, {
    config: null,
    configPath: null,
    configWatch: null,
    storageRoot,
    surface: 'desktop',
    actors: new Map(),
    hostAgents: new Map(),
    stores: new Map(),
    teamConfigViews: new Map(),
    liveProcessMemberIds: new Set(),
    liveRunningTurnSessions: new Set(),
    inFlightToolDispatchesByTeam: new Map(),
    inFlightShellCallsBySession: new Map(),
    simpleDispatchInFlight: new Map(),
    executionReviewJobs: new Map(),
    governanceJobs: new Map(),
    stopReviewPending: new Set(),
    directiveVerifyPending: new Set(),
    upstreamCatalog: null,
    lastGlobalUserConfigSaveAtMs: 0,
  });
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));

  t.after(() => {
    Object.assign(rt, prev);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return { tmp, dshHome, storageRoot, cfgFile, rt };
}

function buildSyntheticTgz(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, Math.min(100, Buffer.byteLength(entry.name)), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    header.write(`${chksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data);
    const rem = data.length % 512;
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('O1 [P1]: gateway/control port change and start automatically sync DSH host provider baseURL without manual sync-pool', async t => {
  const { rt, dshHome } = makeSandbox(t, 'o1');
  const settingsData = {
    providers: {
      magpie: {
        displayName: 'Magpie Gateway',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:36177/v1',
        headers: { Authorization: 'Bearer magpie-leaderteam' },
        models: [{ id: 'auto/orchid', input: ['text'] }],
      },
    },
  };
  const fakeCtx = {
    settings: {
      describe() {
        return [{ ns: 'llm-pi-ai', value: structuredClone(settingsData) }];
      },
      async update(ns, nextVal) {
        if (ns === 'llm-pi-ai') Object.assign(settingsData, structuredClone(nextVal));
      },
    },
    get(k) {
      if (k === 'settings') return this.settings;
      if (k === 'profileContext') return { home: dshHome };
      return null;
    },
  };

  const handlers = createPublicContractHandlers(fakeCtx, rt, { dshHome });
  const cfgRes = await (
    await handlers.gatewayControl(
      new Request('http://127.0.0.1/api/lt/v1/gateway/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'configure',
          config: { gatewayPort: 47895, webPort: 47896 },
        }),
      }),
    )
  ).json();

  assert.equal(cfgRes.ok, true);
  assert.equal(cfgRes.data.status.gatewayUrl, 'http://127.0.0.1:47895');
  assert.equal(
    settingsData.providers.magpie.baseURL,
    'http://127.0.0.1:47895/v1',
    'DSH host magpie provider baseURL updates immediately on gateway port reconfiguration',
  );
});

test('O2 [P1]: bundled packages/lt-usage preserves 232 billed tokens on failed governance reviews and stays byte-identical to lt-usage-plugin', () => {
  const pluginReportJs = fs.readFileSync(
    path.resolve(REPO_ROOT, '..', 'lt-usage-plugin', 'packages', 'core', 'src', 'report.js'),
    'utf8',
  );
  const bundledReportJs = fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'lt-usage', 'core', 'report.js'),
    'utf8',
  );
  assert.equal(bundledReportJs, pluginReportJs);

  const report = buildReport({
    home: 'synthetic',
    sessionId: 'sess-o2',
    sessions: [
      {
        id: 'sess-o2',
        header: { createdAt: 0, cwd: '/tmp' },
        rows: [
          { type: 'session', id: 'sess-o2', createdAt: 0, cwd: '/tmp' },
          {
            type: 'assistant/message',
            seq: 1,
            time: 1000,
            data: {
              message: { id: 'm1', source: { provider: 'dashscope', model: 'qwen-max' } },
              usage: { inputTokens: 21, outputTokens: 8, totalTokens: 29 },
            },
          },
        ],
      },
    ],
    governance: [
      { at: '2026-11-27T08:00:01.000Z', role: 'discussB', purpose: 'async-supervision', route: 'dashscope/qwen-plus', ok: false, attempts: 2, usage: { inputTokens: 42, outputTokens: 16, totalTokens: 58 } },
      { at: '2026-11-27T08:00:02.000Z', role: 'discussA', purpose: 'async-supervision', route: 'dashscope/qwen-max', ok: false, attempts: 2, usage: { inputTokens: 42, outputTokens: 16, totalTokens: 58 } },
      { at: '2026-11-27T08:00:03.000Z', role: 'discussB', purpose: 'async-supervision', route: 'dashscope/qwen-max', ok: false, attempts: 2, usage: { inputTokens: 42, outputTokens: 16, totalTokens: 58 } },
      { at: '2026-11-27T08:00:04.000Z', role: 'discussA', purpose: 'async-supervision', route: 'dashscope/qwen-plus', ok: false, attempts: 2, usage: { inputTokens: 42, outputTokens: 16, totalTokens: 58 } },
    ],
    members: new Map(),
    kind: 'team',
  });

  const govCalls = report.calls.filter(c => c.group === 'governance');
  assert.equal(govCalls.length, 4);
  assert.equal(govCalls.reduce((sum, c) => sum + c.totalTokens, 0), 232);
  for (const c of govCalls) {
    assert.equal(c.ok, false);
    assert.equal(c.unmetered, false);
    assert.equal(c.totalTokens, 58);
  }
});

test('O3 [P1]: delayed HTTP 200 for Session A send never wipes Session B draft and clears Session A draft', async () => {
  const webRequire = createRequire(path.join(REPO_ROOT, 'packages', 'lt-web', 'package.json'));
  const esbuild = webRequire('esbuild');
  const built = await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, 'packages', 'lt-web', 'src', 'views', 'WorkbenchView.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'transform',
    tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react' } }),
    external: ['react'],
  });
  const compiledJs = built.outputFiles[0].text;

  const states = [];
  const refs = [];
  const callbacks = [];
  const effects = [];
  let stateCursor = 0;
  let refCursor = 0;
  let cbCursor = 0;
  let effectCursor = 0;

  const mockReact = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) =>
      typeof type === 'function'
        ? type(Object.assign({}, props, { children }))
        : { type, props: props || {}, children },
    useState(init) {
      const idx = stateCursor++;
      if (states.length <= idx) states[idx] = typeof init === 'function' ? init() : init;
      const set = next => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], set];
    },
    useRef(init) {
      const idx = refCursor++;
      if (refs.length <= idx) refs[idx] = { current: init };
      return refs[idx];
    },
    useCallback(fn, deps) {
      const idx = cbCursor++;
      const prev = callbacks[idx];
      if (!prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]))) {
        callbacks[idx] = { fn, deps };
      }
      return callbacks[idx].fn;
    },
    useEffect(fn, deps) {
      const idx = effectCursor++;
      const prev = effects[idx];
      const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
      if (changed) {
        effects[idx] = { deps, fn, pending: true, cleanup: prev?.cleanup };
      }
    },
  };
  mockReact.default = mockReact;

  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiledJs)(
    id => (id === 'react' ? mockReact : webRequire(id)),
    mod,
    mod.exports,
  );
  const { WorkbenchView } = mod.exports;

  const sidA = 'session-a-send';
  const sidB = 'session-b-draft';
  let parentDrafts = {};
  let releasePromptA = null;
  const promptCalls = [];

  const okJson = data =>
    new Response(
      JSON.stringify({
        ok: true,
        contract: 'lt.public.v1',
        contractVersion: '1.1.0',
        generatedAt: new Date().toISOString(),
        data,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  const apiHandler = async (url, body) => {
    if (url.endsWith('/workbench/sessions')) {
      return okJson({
        liveHost: true,
        workspaces: [{ workspaceId: 'ws-1', path: '/tmp/ws' }],
        sessions: [
          { sessionId: sidA, title: 'Session A', cwd: '/tmp/ws', agentPreset: 'leaderteam', updatedAt: 2000, isTeam: true, executionMode: 'team', isLtSession: true, canSwitchMode: true },
          { sessionId: sidB, title: 'Session B', cwd: '/tmp/ws', agentPreset: 'leaderteam', updatedAt: 1900, isTeam: false, executionMode: 'single', isLtSession: true, canSwitchMode: true },
        ],
      });
    }
    if (url.endsWith('/workbench/transcript')) {
      return okJson({ sessionId: body.sessionId, passiveState: { running: false }, messages: [] });
    }
    if (url.endsWith('/workbench/prompt')) {
      promptCalls.push(body);
      return new Promise(resolve => {
        releasePromptA = () => resolve(okJson({ accepted: true }));
      });
    }
    return okJson({});
  };

  const bundle = {
    capabilities: {
      backendLine: 'v2.2.x-oss',
      backendVersion: '2.2.4',
      hostKind: 'dsh-web',
      frontendSwitch: { available: true, currentSurface: 'lt-native', dshFrontendUrl: '../', ltFrontendUrl: './', sharesRuntimeAndSessions: true },
      features: { liveSessionRpc: true, inSessionDualMode: true },
      supportedRoles: [],
    },
    gateway: {},
    providers: [],
    providerPresets: [],
    models: [],
    runtime: {
      modelPool: { configuredRoutes: [], executionPool: [], disabledRoutes: [] },
      roleAssignments: { leader: { route: 'dashscope/qwen-max', effort: 'high', fallback: [] } },
      scheduler: { maxActiveMembers: 4, effectiveCap: 4, activeExecutionMembers: 0, pressureBand: 'normal' },
      teams: [],
    },
    uiPreferences: { theme: 'white', customTheme: {}, usageAnalyticsEnabled: true, autoRefreshMs: 3000 },
    usageStatus: { enabled: true, healthy: true, dshHome: '/tmp', homeExists: true, cachedGatewayRecords: 0, lastSyncAt: null, lastSyncError: null },
  };

  const walk = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach(n => walk(n, pred, out));
      return out;
    }
    if (pred(node)) out.push(node);
    walk(node.children, pred, out);
    return out;
  };
  const textOf = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return textOf(node.children);
  };

  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;
  globalThis.window = { location: { pathname: '/lt/' } };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init) => apiHandler(String(url), JSON.parse(init?.body || '{}'));

  const renderNow = () => {
    stateCursor = 0;
    refCursor = 0;
    cbCursor = 0;
    effectCursor = 0;
    const vnode = WorkbenchView({
      bundle,
      onRefreshBundle: async () => {},
      onNavigateTab: () => {},
      draftsBySession: parentDrafts,
      onDraftChange: (sid, txt) => {
        const next = { ...parentDrafts };
        if (txt) next[sid] = txt;
        else delete next[sid];
        parentDrafts = next;
      },
    });
    for (const ef of effects) {
      if (ef && ef.pending) {
        ef.pending = false;
        if (typeof ef.cleanup === 'function') ef.cleanup();
        ef.cleanup = ef.fn();
      }
    }
    return vnode;
  };

  try {
    let tree = renderNow();
    await new Promise(r => setTimeout(r, 15));
    tree = renderNow();

    const findSessionBtn = (vnode, title) =>
      walk(vnode, n => n.type === 'button' && n.props?.className === 'list-item' && textOf(n).includes(title))[0];
    const findTextarea = vnode => walk(vnode, n => n.type === 'textarea')[0];
    const findForm = vnode => walk(vnode, n => n.type === 'form')[0];

    // 1. Switch to B and write draft
    findSessionBtn(tree, 'Session B').props.onClick();
    tree = renderNow();
    findTextarea(tree).props.onChange({ target: { value: 'LTTEST_DRAFT_B_KEEP' } });
    tree = renderNow();
    assert.equal(findTextarea(tree).props.value, 'LTTEST_DRAFT_B_KEEP');

    // 2. Switch back to A, type & submit while holding HTTP 200
    findSessionBtn(tree, 'Session A').props.onClick();
    tree = renderNow();
    assert.equal(findTextarea(tree).props.value, '');
    findTextarea(tree).props.onChange({ target: { value: 'LTTEST_UI_A_SENT' } });
    tree = renderNow();
    const sendPromise = findForm(tree).props.onSubmit({ preventDefault() {} });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(promptCalls.length, 1);
    assert.equal(promptCalls[0].sessionId, sidA);

    // 3. Switch to B BEFORE A's HTTP 200 arrives
    findSessionBtn(tree, 'Session B').props.onClick();
    tree = renderNow();
    assert.equal(findTextarea(tree).props.value, 'LTTEST_DRAFT_B_KEEP');

    // 4. Release A's HTTP 200 -> B's draft MUST stay intact!
    releasePromptA();
    await sendPromise;
    tree = renderNow();
    assert.equal(findTextarea(tree).props.value, 'LTTEST_DRAFT_B_KEEP');
    assert.equal(parentDrafts[sidB], 'LTTEST_DRAFT_B_KEEP');
    assert.equal(parentDrafts[sidA], undefined);

    // 5. Switch back to A -> A's already-sent draft MUST be cleared!
    findSessionBtn(tree, 'Session A').props.onClick();
    tree = renderNow();
    assert.equal(findTextarea(tree).props.value, '');
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.setInterval = prevSetInterval;
    globalThis.clearInterval = prevClearInterval;
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});

test('O4 & O8 [P1/P2]: 3 concurrent OS processes preserve all 3 roles & audits, and unknown sessionId is rejected with 0 disk writes', async t => {
  const { tmp, dshHome, storageRoot, cfgFile, rt } = makeSandbox(t, 'o4-o8');
  const handlers = createPublicContractHandlers(null, rt, { dshHome });

  // O8: Unknown non-existent sessionId rejected with HTTP 404 and zero disk writes
  const unknownSid = 'session-unknown-future-9999';
  const badRes = await handlers.workbenchSessionConfig(
    new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'set',
        sessionId: unknownSid,
        patch: { roles: { leader: { route: 'dashscope/qwen-plus', effort: 'none' } } },
      }),
    }),
  );
  assert.equal(badRes.status, 404);
  const badJson = await badRes.json();
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error.code, 'SESSION_NOT_FOUND');
  assert.equal(fs.existsSync(path.join(storageRoot, 'session-configs', `${unknownSid}.json`)), false);

  // O4: 6 rounds × 3 simultaneous child processes modifying leader, gate, and arbiter on shared profile
  const selfFile = fileURLToPath(import.meta.url);
  for (let round = 0; round < 6; round++) {
    const sid = `session-parallel-${round}`;
    teamStore(sid).ensure({ workspace: '/tmp/ws', surface: 'desktop' });
    // Materialize initial governance.json
    assert.equal(runtimeForTeam(sid).config.roles.leader.route, 'dashscope/qwen-max');

    const barrierFile = path.join(tmp, `barrier-${round}`);
    const specs = [
      { roleKey: 'leader', route: 'dashscope/qwen-plus' },
      { roleKey: 'gate', route: 'dashscope/qwen-plus' },
      { roleKey: 'arbiter', route: 'dashscope/qwen-plus' },
    ];
    const procs = specs.map(s =>
      spawn(process.execPath, [selfFile], {
        env: {
          ...process.env,
          LT_V224_WORKER_MODE: 'session-config-writer',
          LT_V224_WORKER_ARGS: JSON.stringify({
            storageRoot,
            cfgFile,
            sessionId: sid,
            roleKey: s.roleKey,
            route: s.route,
            barrierFile,
          }),
        },
        stdio: 'pipe',
      }),
    );

    await new Promise(r => setTimeout(r, 80));
    fs.writeFileSync(barrierFile, 'go\n');

    const exits = await Promise.all(
      procs.map(
        p =>
          new Promise(resolve => {
            let stderr = '';
            p.stderr.on('data', d => { stderr += d.toString(); });
            p.on('close', code => resolve({ code, stderr }));
          }),
      ),
    );
    for (const ex of exits) {
      assert.equal(ex.code, 0, ex.stderr);
    }

    const rec = readSessionConfigRecord(storageRoot, sid);
    assert.deepEqual(Object.keys(rec.activePatch.roles || {}).sort(), ['arbiter', 'gate', 'leader']);
    assert.equal(rec.audit.length, 3);
    const gov = JSON.parse(fs.readFileSync(path.join(storageRoot, 'teams', sid, 'governance.json'), 'utf8'));
    assert.equal(gov.config.roles.leader.route, 'dashscope/qwen-plus');
    assert.equal(gov.config.roles.gate.route, 'dashscope/qwen-plus');
    assert.equal(gov.config.roles.arbiter.route, 'dashscope/qwen-plus');
  }
});

test('O5, O6, O7 & Issue #3 Recheck: platform asset selection, R3 downgrade policy compat, corrupt backup fence, and cross-process CLI active-turn guard', async t => {
  const { tmp, dshHome, storageRoot, cfgFile } = makeSandbox(t, 'updater');

  const pluginRoot = path.join(tmp, 'installed-v224');
  fs.mkdirSync(path.join(pluginRoot, 'leaderteam', 'core'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'package.json'),
    JSON.stringify({
      name: 'dsh-leaderteam',
      version: '2.2.4',
      license: 'Apache-2.0',
      engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, 'leaderteam', 'package.json'),
    JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.4', leaderteam: { distributionTrack: 'open-source' } }),
  );
  fs.writeFileSync(path.join(pluginRoot, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
  fs.writeFileSync(path.join(pluginRoot, 'leaderteam', 'entry-core.mjs'), 'export const name = "leaderteam-core";\n');
  fs.writeFileSync(
    path.join(pluginRoot, 'leaderteam', 'core', 'config.mjs'),
    'export const POLICIES = ["follow", "enforce", "warn", "off"];\n',
  );
  fs.writeFileSync(path.join(pluginRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'public-api.mjs'), '// api\n');
  fs.writeFileSync(
    path.join(pluginRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'index.html'),
    '<!doctype html><title>Leader Team — 工程治理与模型工作台</title>\n',
  );

  // 1. Issue #3 Recheck: platform-tagged releases & multi-asset selection on Linux x64
  const checkPlatformTags = await checkForUpdates({
    pluginRoot,
    storageRoot,
    force: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: 'windows-v2.2.6',
            prerelease: false,
            assets: [{ name: 'dsh-leaderteam-2.2.6-win-x64.tgz', browser_download_url: 'https://mock/win.tgz' }],
          },
          {
            tag_name: 'linux-v2.2.5',
            prerelease: false,
            assets: [{ name: 'dsh-leaderteam-2.2.5-linux-x64.tgz', browser_download_url: 'https://mock/linux.tgz' }],
          },
        ]),
        { status: 200 },
      ),
  });
  assert.equal(checkPlatformTags.hasUpdate, true);
  assert.equal(checkPlatformTags.latestRelease.version, '2.2.5');
  assert.equal(checkPlatformTags.latestRelease.asset.name, 'dsh-leaderteam-2.2.5-linux-x64.tgz');

  const checkTwoAssets = await checkForUpdates({
    pluginRoot,
    storageRoot,
    force: true,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          {
            tag_name: 'v2.2.5',
            prerelease: false,
            assets: [
              { name: 'dsh-leaderteam-2.2.5-win-x64.tgz', browser_download_url: 'https://mock/win225.tgz' },
              { name: 'dsh-leaderteam-2.2.5-linux-x64.tgz', browser_download_url: 'https://mock/lin225.tgz' },
            ],
          },
        ]),
        { status: 200 },
      ),
  });
  assert.equal(checkTwoAssets.hasUpdate, true);
  assert.equal(checkTwoAssets.latestRelease.asset.name, 'dsh-leaderteam-2.2.5-linux-x64.tgz');

  // 2. O5: Downgrading to R3-like tgz (without `follow` in config.mjs) normalizes config & governance.json, and rollback restores `follow`
  const cfgOnDisk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfgOnDisk.team.leaderModelPolicy = 'follow';
  fs.writeFileSync(cfgFile, `${JSON.stringify(cfgOnDisk, null, 2)}\n`);
  fs.mkdirSync(path.join(storageRoot, 'teams', 'team-o5'), { recursive: true });
  const govCfg = structuredClone(cfgOnDisk);
  fs.writeFileSync(
    path.join(storageRoot, 'teams', 'team-o5', 'governance.json'),
    JSON.stringify({ v: 1, createdAt: new Date().toISOString(), sourceSha256: hashJson(govCfg), config: govCfg }, null, 1),
  );

  const r3LikeTgzBuf = buildSyntheticTgz([
    {
      name: 'package/package.json',
      data: JSON.stringify({
        name: 'dsh-leaderteam',
        version: '2.2.3',
        license: 'Apache-2.0',
        engines: { dsh: '>=0.2.2-alpha.2 <1.0.0' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }),
    },
    {
      name: 'package/leaderteam/package.json',
      data: JSON.stringify({ name: 'dsh-leaderteam-internal', version: '2.2.3', leaderteam: { distributionTrack: 'open-source' } }),
    },
    { name: 'package/cordis.patch.yml', data: '- name: dsh-leaderteam/core\n' },
    {
      name: 'package/leaderteam/core/config.mjs',
      data: 'export const LEGACY_POLICIES = ["enforce", "warn", "off"];\n',
    },
  ]);
  const r3TgzPath = path.join(tmp, 'r3.tgz');
  fs.writeFileSync(r3TgzPath, r3LikeTgzBuf);
  const r3Sha = crypto.createHash('sha256').update(r3LikeTgzBuf).digest('hex');

  const downgradeRes = await performOneClickUpgrade({
    pluginRoot,
    storageRoot,
    dshHome,
    localTgzPath: r3TgzPath,
    expectedSha256: r3Sha,
    currentHostVersion: '0.2.2-rc.5',
    installerHook: async () => ({ requiresRestart: true }),
  });
  assert.equal(downgradeRes.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).team.leaderModelPolicy, 'warn');
  const downgradedGov = JSON.parse(fs.readFileSync(path.join(storageRoot, 'teams', 'team-o5', 'governance.json'), 'utf8'));
  assert.equal(downgradedGov.config.team.leaderModelPolicy, 'warn');
  assert.equal(downgradedGov.sourceSha256, hashJson(downgradedGov.config));

  const restoredRes = await rollbackToSavedBackup({
    storageRoot,
    dshHome,
    backupId: downgradeRes.backupId,
    installerHook: async () => {},
  });
  assert.equal(restoredRes.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).team.leaderModelPolicy, 'follow');
  const restoredGov = JSON.parse(fs.readFileSync(path.join(storageRoot, 'teams', 'team-o5', 'governance.json'), 'utf8'));
  assert.equal(restoredGov.config.team.leaderModelPolicy, 'follow');
  assert.equal(restoredGov.sourceSha256, hashJson(restoredGov.config));

  // 3. O7: Standalone `lt-update --apply` CLI is blocked when another live PID holds an active turn, and ignores dead PIDs
  markProcessActiveTurn(storageRoot, 'session-active-turn', true);
  const cliBusy = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'bin', 'lt-update.mjs'), '--apply', '--tgz', r3TgzPath, '--sha256', r3Sha, '--dsh-home', dshHome, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(cliBusy.status, 1);
  assert.match(cliBusy.stderr, /请等待当前运行中的任务完成后再执行升级/);
  markProcessActiveTurn(storageRoot, 'session-active-turn', false);

  // Dead PID lease file is cleaned up automatically and never blocks upgrade
  fs.mkdirSync(path.join(storageRoot, 'active-turns'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'active-turns', 'dead--99999999.json'),
    JSON.stringify({ v: 1, pid: 99999999, sessionId: 'dead-sess', startedAt: Date.now() }),
  );
  const afterDeadClean = await performOneClickUpgrade({
    pluginRoot,
    storageRoot,
    dshHome,
    localTgzPath: r3TgzPath,
    expectedSha256: r3Sha,
    currentHostVersion: '0.2.2-rc.5',
    installerHook: async () => ({ requiresRestart: true }),
  });
  assert.equal(afterDeadClean.ok, true);

  // 4. O6: Removing `web-dist/index.html` from backup snapshot causes rollback to fail with CORRUPT_BACKUP_SNAPSHOT
  const intactBackup = createPreUpgradeBackup({
    storageRoot,
    pluginRoot,
    targetVersion: '2.2.5',
    targetTrack: 'open-source',
  });
  fs.rmSync(
    path.join(intactBackup.manifest.pluginSnapshotDir, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'index.html'),
    { force: true },
  );
  let hookRanOnDamaged = false;
  await assert.rejects(
    () =>
      rollbackToSavedBackup({
        storageRoot,
        dshHome,
        backupId: intactBackup.backupId,
        installerHook: async () => { hookRanOnDamaged = true; },
      }),
    err => err.code === 'CORRUPT_BACKUP_SNAPSHOT' && err.statusCode === 422,
  );
  assert.equal(hookRanOnDamaged, false);
  assert.equal(
    fs.existsSync(path.join(pluginRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'web-dist', 'index.html')),
    true,
    'Installed worktree index.html remains intact after damaged snapshot is rejected',
  );
});

test('O9 & Issue #4 Recheck [P1]: abnormal restart flushes pending config before first recovery turn, and reset / global save syncs warm & cold DSH sessions', async t => {
  const { dshHome, storageRoot, rt } = makeSandbox(t, 'o9-recheck');

  // --- Part A: O9 crash recovery on first turn (Team & Single) ---
  for (const mode of ['single', 'team']) {
    const sid = `sess-o9-${mode}`;
    fs.mkdirSync(path.join(dshHome, 'sessions', sid), { recursive: true });
    fs.writeFileSync(
      path.join(dshHome, 'sessions', sid, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(
        Buffer.from(`${JSON.stringify({ type: 'session', id: sid, createdAt: 100, cwd: '/tmp/ws', agentPreset: 'leaderteam' })}\n`),
      ),
    );
    if (mode === 'team') {
      const st = teamStore(sid);
      st.ensure({ workspace: '/tmp/ws', surface: 'desktop' });
      st.addMember({
        childId: `dead-worker-${mode}`,
        name: 'worker',
        profile: 'code',
        model: 'dashscope/qwen-max',
        effort: 'high',
        taskSeq: 1,
        ownerPid: 99999999, // Dead crashed host PID
        allowedTools: ['read'],
        writeScope: ['src/**'],
        refs: [],
        task: 'work',
        acceptance: ['ok'],
      });
      st.setMemberStatus(`dead-worker-${mode}`, 'running');
    }

    // Stage `qwen-plus` during an active turn before SIGKILL
    const staged = mutateSessionConfig({
      storageRoot,
      sessionId: sid,
      baseConfig: rt.config,
      patch: { roles: { leader: { route: 'dashscope/qwen-plus', effort: 'none' } }, syncAllRolesToLeader: true },
      action: 'merge',
      principal: { kind: 'user', source: 'lt-public-v1' },
      isBusy: true,
      busyReasons: ['leader_turn_running'],
    });
    assert.equal(staged.stagedForSafeBoundary, true);

    // Cold restart state: read-only GET still shows hasPending=true & isBusy=false
    const handlers = createPublicContractHandlers(null, rt, { dshHome });
    const getBeforeTurn = await (
      await handlers.workbenchSessionConfig(
        new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'get', sessionId: sid }),
        }),
      )
    ).json();
    assert.equal(getBeforeTurn.data.isBusy, false);
    assert.equal(getBeforeTurn.data.hasPending, true);

    // First new turn after crash starts (`onAgentStatus('running')` fires BEFORE DSH resolves turn model)
    let curSelection = { provider: 'dashscope', model: 'qwen-max', reasoningEffort: 'high' };
    const sessionEvents = [
      { type: 'session', id: sid, createdAt: 100 },
      { type: 'model/selection', seq: 1, time: 100, data: { ...curSelection } },
    ];
    const fakeAgent = {
      id: sid,
      status: 'running',
      session: {
        id: sid,
        header: { cwd: '/tmp/ws', agentPreset: 'leaderteam' },
        snapshotEvents: () => sessionEvents,
      },
      model: {
        current: () => curSelection,
        recordedSelection: () => curSelection,
        select(nextSel) {
          curSelection = { ...nextSel };
          sessionEvents.push({ type: 'model/selection', seq: sessionEvents.length, time: Date.now(), data: { ...nextSel } });
        },
      },
    };
    const fakeCtx = {
      agentPresets: { presetForSession: () => 'leaderteam' },
      get(k) {
        if (k === 'agentPresets') return this.agentPresets;
        return null;
      },
    };
    rt.hostAgents.set(sid, fakeAgent);
    onAgentStatus(fakeCtx, { agent: fakeAgent, status: 'running' });

    // FIRST recovery turn immediately routes to qwen-plus!
    assert.equal(curSelection.model, 'qwen-plus', `First recovery turn in ${mode} mode must select qwen-plus`);
    assert.equal(readSessionConfigRecord(storageRoot, sid).pendingPatch, null);
    if (mode === 'team') {
      assert.equal(runtimeForTeam(sid).config.roles.leader.route, 'dashscope/qwen-plus');
    }
    onAgentStatus(fakeCtx, { agent: fakeAgent, status: 'idle' });
  }

  // --- Part B: Issue #4 Recheck (`resetA_toGlobal` & `globalSaveWithIdleB`) ---
  const sidA = 'sess-reset-a';
  const sidB = 'sess-global-b';
  teamStore(sidA).ensure({ workspace: '/tmp/ws', surface: 'desktop' });
  teamStore(sidB).ensure({ workspace: '/tmp/ws', surface: 'desktop' });

  const makeTrackedAgent = (id, initialModel, selectionTimeMs) => {
    let cur = { provider: 'dashscope', model: initialModel };
    const evs = [
      { type: 'session', id, createdAt: 50 },
      { type: 'model/selection', seq: 1, time: selectionTimeMs, data: { ...cur } },
    ];
    return {
      id,
      status: 'idle',
      session: {
        id,
        header: { cwd: '/tmp/ws', agentPreset: 'leaderteam' },
        snapshotEvents: () => evs,
      },
      model: {
        current: () => cur,
        recordedSelection: () => cur,
        select(nextSel) {
          cur = { ...nextSel };
          evs.push({ type: 'model/selection', seq: evs.length, time: Date.now(), data: { ...nextSel } });
        },
      },
    };
  };

  const agentA = makeTrackedAgent(sidA, 'qwen-max', 100);
  const agentB = makeTrackedAgent(sidB, 'qwen-max', 100);
  rt.hostAgents.set(sidA, agentA);
  rt.hostAgents.set(sidB, agentB);
  const fakeCtx = {
    agentPresets: { presetForSession: () => 'leaderteam' },
    agents: rt.hostAgents,
    get(k) {
      if (k === 'agentPresets') return this.agentPresets;
      if (k === 'agents') return this.agents;
      if (k === 'profileContext') return { home: dshHome };
      return null;
    },
  };
  const handlers = createPublicContractHandlers(fakeCtx, rt, { dshHome });

  // Override A to qwen-plus, then reset A back to global qwen-max
  await handlers.workbenchSessionConfig(
    new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'set',
        sessionId: sidA,
        patch: { roles: { leader: { route: 'dashscope/qwen-plus', effort: 'none' } } },
      }),
    }),
  );
  assert.equal(agentA.model.current().model, 'qwen-plus');

  const resetRes = await (
    await handlers.workbenchSessionConfig(
      new Request('http://127.0.0.1/api/lt/v1/workbench/session-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'reset', sessionId: sidA }),
      }),
    )
  ).json();
  assert.equal(resetRes.ok, true);
  assert.equal(agentA.model.current().model, 'qwen-max');

  // Next turn on A keeps qwen-max and does NOT re-create a session override!
  agentA.status = 'running';
  onAgentStatus(fakeCtx, { agent: agentA, status: 'running' });
  assert.equal(agentA.model.current().model, 'qwen-max');
  assert.deepEqual(readSessionConfigRecord(storageRoot, sidA).activePatch, {});
  agentA.status = 'idle';
  onAgentStatus(fakeCtx, { agent: agentA, status: 'idle' });

  // Global save to qwen-plus updates idle B (and even a cold session C whose agent mounts later!)
  const sidColdC = 'sess-cold-c';
  teamStore(sidColdC).ensure({ workspace: '/tmp/ws', surface: 'desktop' });
  assert.equal(runtimeForTeam(sidColdC).config.roles.leader.route, 'dashscope/qwen-max');

  const globalSaveRes = await (
    await handlers.runtimeConfigure(
      new Request('http://127.0.0.1/api/lt/v1/runtime/configure', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: 'local',
          changes: { setRoles: [{ role: 'leader', route: 'dashscope/qwen-plus', effort: 'none' }] },
        }),
      }),
    )
  ).json();
  assert.equal(globalSaveRes.ok, true);
  assert.equal(agentB.model.current().model, 'qwen-plus');

  agentB.status = 'running';
  onAgentStatus(fakeCtx, { agent: agentB, status: 'running' });
  assert.equal(agentB.model.current().model, 'qwen-plus');
  assert.deepEqual(readSessionConfigRecord(storageRoot, sidB).activePatch, {});
  agentB.status = 'idle';
  onAgentStatus(fakeCtx, { agent: agentB, status: 'idle' });

  // Cold C mounts later with pre-save model/selection timestamp (t=100 < globalSaveAtMs)
  const agentColdC = makeTrackedAgent(sidColdC, 'qwen-max', 100);
  rt.hostAgents.set(sidColdC, agentColdC);
  agentColdC.status = 'running';
  onAgentStatus(fakeCtx, { agent: agentColdC, status: 'running' });
  assert.equal(agentColdC.model.current().model, 'qwen-plus');
  assert.deepEqual(readSessionConfigRecord(storageRoot, sidColdC).activePatch, {});
  agentColdC.status = 'idle';
  onAgentStatus(fakeCtx, { agent: agentColdC, status: 'idle' });
});
