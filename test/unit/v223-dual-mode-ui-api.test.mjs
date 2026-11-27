import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_VERSION,
  PUBLIC_API_ROUTES,
  PUBLIC_READONLY_API_ROUTES,
  createPublicContractHandlers,
  registerPublicContractRoutes,
  resolveLtWebDistDir,
} from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import {
  PANEL_ROUTES,
  createPanelHandlers,
  registerPanelRoutes,
} from '../../leaderteam/plugins/leaderteam-panel/panel-api.mjs';
import { startStandaloneLtUiServer } from '../../bin/lt-ui.mjs';
import { registerHooks } from 'node:module';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { TeamStore, appendJsonl } from '../../leaderteam/core/store.mjs';
import { runtime, bindRuntimeConfigFile } from '../../leaderteam/host/runtime.mjs';
import { SHARED_CONTRACTS_ROOT, validateContractBundle } from './companion-paths.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-v223-ui:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v223-ui:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class BlockAssembler { push() {} blocks() { return []; } }
          export function createUserMessage(x) { return x; }
          export function createToolResultMessage(x) { return x; }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { resolveActor } = await import('../../leaderteam/host/roles.mjs');

function withTestRuntime(targetRt, fn) {
  const globalRt = runtime();
  const saved = { ...globalRt };
  Object.assign(globalRt, targetRt);
  const restore = () => {
    for (const k of Object.keys(globalRt)) {
      if (!(k in saved)) delete globalRt[k];
    }
    Object.assign(globalRt, saved);
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const contractsRoot = SHARED_CONTRACTS_ROOT;

function makeTempSandbox(t, label = 'case') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-s5-ui-${label}-`));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeJsonPost(body = {}, url = 'http://127.0.0.1/api/lt/v1/workbench/mode') {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createIsolatedRuntime(tmpDir) {
  const dshHome = path.join(tmpDir, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const cfgDir = path.join(storageRoot, 'config');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  for (const name of ['leaderteam.config.json', 'desktop-magpie.patch.yml', 'magpie-models.patch.yml']) {
    fs.copyFileSync(path.join(repoRoot, 'config', name), path.join(cfgDir, name));
  }
  const cfgFile = path.join(cfgDir, 'leaderteam.config.json');
  const cfg = loadConfig(cfgFile);
  const rt = {
    surface: 'desktop',
    cordisCompositionMode: true,
    storageRoot,
    configPath: cfgFile,
    config: cfg,
    plugins: {
      scheduler: { version: '2.2.3' },
      consensus: { version: '2.2.3' },
      timerArchive: { version: '2.2.3' },
      panel: { version: '2.2.3' },
    },
    stores: new Map(),
    actors: new Map(),
    teamRuntimes: new Map(),
    executionReviewJobs: new Map(),
    governanceJobs: new Map(),
    stopReviewPending: new Set(),
    directiveVerifyPending: new Set(),
    inFlightGateReviews: new Map(),
    inFlightShellCallsBySession: new Map(),
  };
  bindRuntimeConfigFile(rt, cfgFile, cfg);
  return { dshHome, storageRoot, cfgFile, rt };
}

test('V2.2.3 Contracts (1.1.0): bundle capabilities.features.inSessionDualMode, 1.0.0/1.0.1 backward compat, and 0-byte type diff', async t => {
  const tmpDir = makeTempSandbox(t, 'contracts');
  const { dshHome, rt } = createIsolatedRuntime(tmpDir);

  assert.equal(CONTRACT_VERSION, '1.1.0');
  assert.ok(PUBLIC_READONLY_API_ROUTES.has(PUBLIC_API_ROUTES.WORKBENCH_MODE));

  // Byte-for-byte parity between lt-shared-contracts and lt-web
  const sharedDts = fs.readFileSync(path.join(contractsRoot, 'types', 'lt-public-v1.d.ts'), 'utf8');
  const webTs = fs.readFileSync(path.join(repoRoot, 'packages', 'lt-web', 'src', 'types', 'lt-public-v1.ts'), 'utf8');
  assert.equal(webTs, sharedDts);

  // Live bundle emits 1.1.0 + backendVersion 2.2.3 + inSessionDualMode: true and passes validator
  const fakeCtx = {
    webServer: { port: 3080 },
    sessionController: { async list() { return { items: [] }; } },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };
  const h = createPublicContractHandlers(fakeCtx, rt);
  const bundleEnvelope = await (await h.bundle(makeJsonPost({}, 'http://127.0.0.1/api/lt/v1/bundle'))).json();
  assert.equal(bundleEnvelope.ok, true);
  assert.equal(bundleEnvelope.contractVersion, '1.1.0');
  assert.equal(bundleEnvelope.data.capabilities.backendVersion, '2.2.3');
  assert.equal(bundleEnvelope.data.capabilities.features.inSessionDualMode, true);
  const liveCheck = validateContractBundle(bundleEnvelope);
  assert.equal(liveCheck.ok, true, liveCheck.errors.join('; '));

  // Mock snapshots: v2.2 OSS (1.1.0) and v2.4 compat (1.0.0 without inSessionDualMode) both pass
  const mockV22 = JSON.parse(fs.readFileSync(path.join(contractsRoot, 'mocks', 'mock-v2.2-oss-snapshot.json'), 'utf8'));
  const mockV24 = JSON.parse(fs.readFileSync(path.join(contractsRoot, 'mocks', 'mock-v2.4-compat-snapshot.json'), 'utf8'));
  assert.equal(mockV22.contractVersion, '1.1.0');
  assert.equal(mockV22.capabilities.backendVersion, '2.2.3');
  assert.equal(mockV22.capabilities.features.inSessionDualMode, true);
  assert.equal(validateContractBundle(mockV22).ok, true);

  assert.equal(mockV24.contractVersion, '1.0.0');
  assert.equal(mockV24.capabilities.features.inSessionDualMode, undefined);
  assert.equal(validateContractBundle(mockV24).ok, true);
  assert.equal(validateContractBundle({ ...structuredClone(mockV24), contractVersion: '1.0.1' }).ok, true);

  // 1.1.0 without inSessionDualMode fails validation
  const invalid110 = { ...structuredClone(mockV24), contractVersion: '1.1.0' };
  const invalidRes = validateContractBundle(invalid110);
  assert.equal(invalidRes.ok, false);
  assert.match(invalidRes.errors.join('\n'), /inSessionDualMode/);
});

test('V2.2.3 Workbench Create, Sessions, Transcript & Mode Switch: default team vs initial single (0 TeamStore overhead), Team->Single->Team (0 LLM calls), cold reload & reconnect consistency', async t => {
  const tmpDir = makeTempSandbox(t, 'lifecycle');
  const { dshHome, storageRoot, rt } = createIsolatedRuntime(tmpDir);
  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  let llmCallCount = 0;
  const hostSessions = new Map();
  const hostAgents = new Map();
  const createdRequests = [];

  const fakeCtx = {
    llm: {
      async chat() {
        llmCallCount += 1;
        throw new Error('Unexpected LLM call during mode creation/switch');
      },
    },
    sessions: hostSessions,
    agents: hostAgents,
    agentPresets: {
      defaultId: 'default',
      async resolve(id) {
        if (id === 'leaderteam' || id === 'default') return { id };
        throw new Error(`Unknown preset: ${id}`);
      },
      presetForSession(sess) {
        return sess?.header?.agentPreset ?? null;
      },
    },
    sessionController: {
      async create(req) {
        createdRequests.push(req);
        const sid = req.sessionId || `session-auto-${createdRequests.length}`;
        const preset = req.agentPreset || 'default';
        const sessionObj = {
          id: sid,
          header: { id: sid, cwd: req.cwd || workspaceDir, agentPreset: preset },
          snapshotEvents: () => [
            { type: 'session', id: sid, cwd: req.cwd || workspaceDir, agentPreset: preset, time: 1000 },
            { type: 'user/message', seq: 1, time: 1010, data: { message: { id: `u-${sid}`, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } } },
          ],
        };
        const promptSections = new Map();
        const agentObj = {
          id: sid,
          status: 'idle',
          inbox: { nextTurn: [], nextStep: [] },
          session: sessionObj,
          ctx: {
            systemPrompt: {
              section(spec) {
                promptSections.set(spec.name, spec.text);
                return () => promptSections.delete(spec.name);
              },
              context(spec) {
                promptSections.set(spec.name, spec.text);
                return () => promptSections.delete(spec.name);
              },
            },
          },
          _promptSections: promptSections,
        };
        hostSessions.set(sid, sessionObj);
        hostAgents.set(sid, agentObj);
        // Simulate real DSH agent creation hook (`resolveActor`) firing inside `sessionController.create`
        withTestRuntime(rt, () => resolveActor(fakeCtx, agentObj));
        return { sessionId: sid, agentPreset: preset };
      },
      async list() {
        return {
          items: [...hostSessions.values()].map((s, idx) => ({
            sessionId: s.id,
            cwd: s.header.cwd,
            updatedAt: 2000 + idx,
            running: hostAgents.get(s.id)?.status === 'running',
            blank: false,
            projections: { values: { title: `Session ${s.id}`, agentPreset: s.header.agentPreset } },
          })),
        };
      },
      async state({ sessionId }) {
        const ag = hostAgents.get(sessionId);
        return { running: ag?.status === 'running', active: Boolean(ag) };
      },
    },
    get(key) {
      if (key === 'profileContext') return { home: dshHome };
      return this[key] ?? null;
    },
  };

  await withTestRuntime(rt, async () => {
    const h = createPublicContractHandlers(fakeCtx, rt);

    // 1. Invalid executionMode on workbench/create rejected with 400 BAD_EXECUTION_MODE (0 sessions created)
    const badCreateRes = await h.workbenchCreate(makeJsonPost({ cwd: workspaceDir, executionMode: 'auto' }));
    assert.equal(badCreateRes.status, 400);
    const badCreateJson = await badCreateRes.json();
    assert.equal(badCreateJson.ok, false);
    assert.equal(badCreateJson.error.code, 'BAD_EXECUTION_MODE');
    assert.equal(createdRequests.length, 0);

    // 2. Default workbench/create -> binds 'leaderteam' preset and starts in 'team' mode
    const teamCreate = await (await h.workbenchCreate(makeJsonPost({ cwd: workspaceDir }))).json();
    assert.equal(teamCreate.ok, true);
    assert.equal(teamCreate.data.agentPreset, 'leaderteam');
    assert.equal(teamCreate.data.executionMode, 'team');
    assert.equal(teamCreate.data.modeState.mode, 'team');
    assert.equal(teamCreate.data.modeState.isLtSession, true);
    assert.equal(teamCreate.data.modeState.canSwitch, true);
    assert.equal(TeamStore.exists(storageRoot, teamCreate.data.sessionId), true);

    // 3. Initial Single mode workbench/create -> binds 'leaderteam', persists 'single', and creates ZERO TeamStore files!
    const singleCreate = await (await h.workbenchCreate(makeJsonPost({
      cwd: workspaceDir,
      executionMode: 'single',
    }))).json();
    assert.equal(singleCreate.ok, true);
    const singleSid = singleCreate.data.sessionId;
    assert.equal(singleCreate.data.agentPreset, 'leaderteam');
    assert.equal(singleCreate.data.executionMode, 'single');
    assert.equal(singleCreate.data.modeState.mode, 'single');
    assert.equal(singleCreate.data.modeState.switchCount, 0);
    assert.equal(TeamStore.exists(storageRoot, singleSid), false, 'Pure Single session must not create TeamStore directory');

    // 4. Native non-LT DSH session -> isLtSession === false
    await fakeCtx.sessionController.create({ sessionId: 'sess-native-dsh', cwd: workspaceDir, agentPreset: 'default' });

    // 5. Read-only GET/POST on unpersisted session performs 0 disk writes to session-modes
    const modesDir = path.join(storageRoot, 'session-modes');
    const filesBeforeRead = fs.readdirSync(modesDir).sort();
    const unpersistedGet = await (await h.workbenchMode(
      new Request('http://127.0.0.1/api/lt/v1/workbench/mode?sessionId=sess-unpersisted-lt', { method: 'GET' }),
    )).json();
    assert.equal(unpersistedGet.ok, true);
    assert.equal(unpersistedGet.data.modeState.mode, 'team');
    assert.equal(unpersistedGet.data.modeState.updatedAt, null);
    assert.deepEqual(fs.readdirSync(modesDir).sort(), filesBeforeRead, 'GET workbench/mode must perform 0 disk writes');

    // 6. Team -> Single -> Team live hot-swap on `teamCreate.data.sessionId` (0 LLM calls)
    const teamSid = teamCreate.data.sessionId;
    const sw1 = await (await h.workbenchMode(makeJsonPost({
      action: 'set',
      sessionId: teamSid,
      mode: 'single',
    }))).json();
    assert.equal(sw1.ok, true);
    assert.equal(sw1.data.changed, true);
    assert.equal(sw1.data.previousMode, 'team');
    assert.equal(sw1.data.modeState.mode, 'single');
    assert.equal(sw1.data.modeState.switchCount, 1);
    assert.equal(rt.actors.get(teamSid).executionMode, 'single');
    assert.ok(rt.actors.get(teamSid).allowedTools.includes('write'));
    assert.equal(rt.actors.get(teamSid).allowedTools.some(n => n.startsWith('team_')), false);

    // workbench/sessions & workbench/transcript reflect new mode immediately on reconnect
    const sessList = await (await h.workbenchSessions()).json();
    const byId = new Map(sessList.data.sessions.map(s => [s.sessionId, s]));
    assert.equal(byId.get(teamSid).executionMode, 'single');
    assert.equal(byId.get(teamSid).isLtSession, true);
    assert.equal(byId.get(singleSid).executionMode, 'single');
    assert.equal(byId.get('sess-native-dsh').isLtSession, false);
    assert.equal(byId.get('sess-native-dsh').canSwitchMode, false);

    const transcriptSingle = await (await h.workbenchTranscript(makeJsonPost({ sessionId: teamSid }))).json();
    assert.equal(transcriptSingle.ok, true);
    assert.equal(transcriptSingle.data.modeState.mode, 'single');
    assert.equal(transcriptSingle.data.modeState.switchCount, 1);

    const sw2 = await (await h.workbenchMode(makeJsonPost({
      sessionId: teamSid,
      mode: 'team',
    }))).json();
    assert.equal(sw2.ok, true);
    assert.equal(sw2.data.changed, true);
    assert.equal(sw2.data.previousMode, 'single');
    assert.equal(sw2.data.modeState.mode, 'team');
    assert.equal(sw2.data.modeState.switchCount, 2);
    assert.equal(rt.actors.get(teamSid).executionMode, 'team');
    assert.equal(rt.actors.get(teamSid).allowedTools.includes('write'), false);
    assert.ok(rt.actors.get(teamSid).allowedTools.includes('team_dispatch'));
    assert.equal(llmCallCount, 0, 'All mode creates and switches must execute 0 LLM calls');

    // 7. Cold reload persistence: brand-new runtime reading disk preserves exact mode & switchCount
    const coldRt = {
      ...createIsolatedRuntime(tmpDir).rt,
    };
    await withTestRuntime(coldRt, async () => {
      const coldHandlers = createPublicContractHandlers(
        { get: k => (k === 'profileContext' ? { home: dshHome } : null) },
        coldRt,
      );
      const coldTeamMode = await (await coldHandlers.workbenchMode(makeJsonPost({
        action: 'get',
        sessionId: teamSid,
      }))).json();
      assert.equal(coldTeamMode.data.modeState.mode, 'team');
      assert.equal(coldTeamMode.data.modeState.switchCount, 2);

      const coldSingleMode = await (await coldHandlers.workbenchMode(makeJsonPost({
        action: 'get',
        sessionId: singleSid,
      }))).json();
      assert.equal(coldSingleMode.data.modeState.mode, 'single');
      assert.equal(coldSingleMode.data.modeState.switchCount, 0);
    });
  });
});

test('V2.2.3 Error & Guard Semantics: 409 MODE_SWITCH_BUSY (active turn / active member / open conference), 400 MODE_NOT_LT_SESSION / BAD_SESSION_ID, and 405 mutating GET', async t => {
  const tmpDir = makeTempSandbox(t, 'guards');
  const { dshHome, storageRoot, cfgFile, rt } = createIsolatedRuntime(tmpDir);

  let passiveRunningFlag = false;
  const fakeCtx = {
    sessionController: {
      async list() {
        return {
          items: [
            { sessionId: 'sess-lt-guard', cwd: tmpDir, updatedAt: 1000, projections: { values: { agentPreset: 'leaderteam' } } },
            { sessionId: 'sess-dsh-coder', cwd: tmpDir, updatedAt: 1001, projections: { values: { agentPreset: 'coder' } } },
          ],
        };
      },
      async state({ sessionId }) {
        return { running: sessionId === 'sess-lt-guard' && passiveRunningFlag };
      },
    },
    get(key) {
      if (key === 'profileContext') return { home: dshHome };
      return this[key] ?? null;
    },
  };

  await withTestRuntime(rt, async () => {
    const h = createPublicContractHandlers(fakeCtx, rt);

    // 1a. Active turn -> 409 MODE_SWITCH_BUSY with error.details.modeState
    passiveRunningFlag = true;
    const busyTurnRes = await h.workbenchMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-lt-guard',
      mode: 'single',
    }));
    assert.equal(busyTurnRes.status, 409);
    const busyTurnJson = await busyTurnRes.json();
    assert.equal(busyTurnJson.ok, false);
    assert.equal(busyTurnJson.error.code, 'MODE_SWITCH_BUSY');
    assert.equal(busyTurnJson.error.retriable, true);
    assert.equal(busyTurnJson.error.details.modeState.activeTurn, true);
    assert.equal(busyTurnJson.error.details.modeState.canSwitch, false);
    assert.equal(busyTurnJson.error.details.modeState.mode, 'team');
    passiveRunningFlag = false;

    // 1b. Active team member -> 409 MODE_SWITCH_BUSY
    const store = new TeamStore(storageRoot, 'sess-lt-guard');
    store.ensure({ workspace: tmpDir, surface: 'desktop' });
    rt.hostAgents = new Map([['child-running-1', { id: 'child-running-1', status: 'running' }]]);
    store.addMember({
      childId: 'child-running-1',
      name: 'impl-worker',
      profile: 'code',
      taskSeq: 1,
    });
    store.setMemberStatus('child-running-1', 'running');
    const busyMemberRes = await h.workbenchMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-lt-guard',
      mode: 'single',
    }));
    assert.equal(busyMemberRes.status, 409);
    const busyMemberJson = await busyMemberRes.json();
    assert.equal(busyMemberJson.error.code, 'MODE_SWITCH_BUSY');
    assert.equal(busyMemberJson.error.details.modeState.activeMembersCount, 1);
    assert.match(busyMemberJson.error.message, /team member/i);

    // Mark member finished -> now seed an open formal governance conference -> 409 MODE_SWITCH_BUSY
    store.setMemberStatus('child-running-1', 'done');
    rt.hostAgents.clear();
    store.appendGovernanceEvent({
      type: 'conference-opened',
      conferenceId: 'conf-stage5-1',
      disputeId: 'disp-1',
      taskSeq: 1,
      stageId: 's1',
      strike: 2,
    });
    const busyConfRes = await h.workbenchMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-lt-guard',
      mode: 'single',
    }));
    assert.equal(busyConfRes.status, 409);
    const busyConfJson = await busyConfRes.json();
    assert.equal(busyConfJson.error.code, 'MODE_SWITCH_BUSY');
    assert.equal(busyConfJson.error.details.modeState.activeConferenceId, 'conf-stage5-1');

    // Conclude conference -> idle switch now succeeds cleanly!
    store.appendGovernanceEvent({
      type: 'conference-concluded',
      conferenceId: 'conf-stage5-1',
      disputeId: 'disp-1',
      taskSeq: 1,
      ruling: { decision: 'overturn_objection', summary: 'Resolved' },
    });
    const okSwitchRes = await h.workbenchMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-lt-guard',
      mode: 'single',
    }));
    assert.equal(okSwitchRes.status, 200);
    const okSwitchJson = await okSwitchRes.json();
    assert.equal(okSwitchJson.ok, true);
    assert.equal(okSwitchJson.data.modeState.mode, 'single');

    // 2. Non-LT session -> 400 MODE_NOT_LT_SESSION with error.details.modeState
    const nonLtRes = await h.workbenchMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-dsh-coder',
      mode: 'single',
    }));
    assert.equal(nonLtRes.status, 400);
    const nonLtJson = await nonLtRes.json();
    assert.equal(nonLtJson.ok, false);
    assert.equal(nonLtJson.error.code, 'MODE_NOT_LT_SESSION');
    assert.equal(nonLtJson.error.details.modeState.isLtSession, false);

    // Bad sessionId & bad mode -> 400
    const badSidRes = await h.workbenchMode(makeJsonPost({ action: 'get', sessionId: '   ' }));
    assert.equal(badSidRes.status, 400);
    assert.equal((await badSidRes.json()).error.code, 'BAD_SESSION_ID');

    const badModeRes = await h.workbenchMode(makeJsonPost({ action: 'set', sessionId: 'sess-lt-guard', mode: 'turbo' }));
    assert.equal(badModeRes.status, 400);
    assert.equal((await badModeRes.json()).error.code, 'BAD_EXECUTION_MODE');

    // 3. Register route check: registerPublicContractRoutes mounts WORKBENCH_MODE with ['GET', 'POST']
    const registered = new Map();
    registerPublicContractRoutes(
      { effect: fn => fn() },
      { fetch: { register(spec) { registered.set(spec.path, spec); return () => {}; } } },
      fakeCtx,
      rt,
    );
    assert.ok(registered.has(PUBLIC_API_ROUTES.WORKBENCH_MODE));
    assert.deepEqual(registered.get(PUBLIC_API_ROUTES.WORKBENCH_MODE).methods, ['GET', 'POST']);

    // 3b. Strict Cordis Proxy `ctx` (throws on direct `ctx.sessions` / `ctx.agents` access without `ctx.get`) succeeds cleanly
    const cordisProxyCtx = new Proxy(
      {
        get(key) {
          return fakeCtx.get(key);
        },
      },
      {
        get(target, prop, receiver) {
          if (prop === 'get' || typeof prop === 'symbol' || prop === 'then') {
            return Reflect.get(target, prop, receiver);
          }
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        },
      },
    );
    const proxyHandlers = createPublicContractHandlers(cordisProxyCtx, rt);
    const proxyGetRes = await (await proxyHandlers.workbenchMode(makeJsonPost({
      action: 'get',
      sessionId: 'sess-lt-guard',
    }))).json();
    assert.equal(proxyGetRes.ok, true);
    assert.equal(proxyGetRes.data.modeState.mode, 'single');
  });

  // 4. Standalone `bin/lt-ui.mjs`: GET ?sessionId=... succeeds (200), mutating GET ?mode=single & ?action=set rejected with 405 Allow: POST!
  const prevDshHome = process.env.DSH_HOME;
  t.after(() => {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  });

  const uiSrv = await startStandaloneLtUiServer({ port: 0, dshHome, configPath: cfgFile, requireAuth: true });
  t.after(() => uiSrv.close());

  const loginRes = await fetch(uiSrv.launchUrl, { redirect: 'manual' });
  const cookiePair = (loginRes.headers.get('set-cookie') || '').split(';')[0];

  const getRo = await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode?sessionId=sess-lt-guard`, {
    method: 'GET',
    headers: { Cookie: cookiePair },
  });
  assert.equal(getRo.status, 200);
  const getRoJson = await getRo.json();
  assert.equal(getRoJson.ok, true);
  assert.equal(getRoJson.data.modeState.mode, 'single');

  for (const qs of ['?mode=team', '?sessionId=sess-lt-guard&mode=team', '?sessionId=sess-lt-guard&action=set']) {
    const mutGet = await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode${qs}`, {
      method: 'GET',
      headers: { Cookie: cookiePair },
    });
    assert.equal(mutGet.status, 405, `Expected 405 for GET ${qs}`);
    assert.equal(mutGet.headers.get('allow'), 'POST');
    const mutGetJson = await mutGet.json();
    assert.equal(mutGetJson.ok, false);
    assert.equal(mutGetJson.error.code, 'METHOD_NOT_ALLOWED');
  }

  // Confirm mode was NOT mutated by any rejected GET
  const afterGetCheck = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode?sessionId=sess-lt-guard`, {
    headers: { Cookie: cookiePair },
  })).json();
  assert.equal(afterGetCheck.data.modeState.mode, 'single');
});

test('V2.2.3 DSH Panel (`panel-api.mjs` & `client.js`) + LT Native Frontend (`api.ts` & `web-dist`) dual-mode integration', async t => {
  const tmpDir = makeTempSandbox(t, 'panel-ui');
  const { dshHome, rt } = createIsolatedRuntime(tmpDir);

  let running = false;
  const fakeCtx = {
    sessionController: {
      async list() {
        return {
          items: [
            { sessionId: 'sess-panel-lt', title: 'Panel LT Session', cwd: tmpDir, updatedAt: 3000, projections: { values: { agentPreset: 'leaderteam' } } },
          ],
        };
      },
      async state() {
        return { running };
      },
    },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };

  await withTestRuntime(rt, async () => {
    const panelRegistered = [];
    registerPanelRoutes(
      { effect: fn => fn() },
      { fetch: { register(spec) { panelRegistered.push(spec.path); return () => {}; } } },
      fakeCtx,
      rt,
    );
    assert.ok(panelRegistered.includes(PANEL_ROUTES.SESSION_MODE));

    const ph = createPanelHandlers(fakeCtx, rt);

    // list
    const listRes = await (await ph.sessionMode(makeJsonPost({ action: 'list' }))).json();
    assert.equal(listRes.ok, true);
    assert.equal(listRes.value.sessions.length, 1);
    assert.equal(listRes.value.sessions[0].executionMode, 'team');

    // set -> single
    const setSingle = await (await ph.sessionMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-panel-lt',
      mode: 'single',
    }))).json();
    assert.equal(setSingle.ok, true);
    assert.equal(setSingle.value.changed, true);
    assert.equal(setSingle.value.modeState.mode, 'single');

    // get -> single
    const getSingle = await (await ph.sessionMode(makeJsonPost({
      action: 'get',
      sessionId: 'sess-panel-lt',
    }))).json();
    assert.equal(getSingle.ok, true);
    assert.equal(getSingle.value.modeState.mode, 'single');

    // busy -> 409 MODE_SWITCH_BUSY
    running = true;
    const rawBusy = await ph.sessionMode(makeJsonPost({
      action: 'set',
      sessionId: 'sess-panel-lt',
      mode: 'team',
    }));
    assert.equal(rawBusy.status, 409);
    const busyBody = await rawBusy.json();
    assert.equal(busyBody.ok, false);
    assert.equal(busyBody.error.code, 'MODE_SWITCH_BUSY');
    assert.equal(busyBody.error.details.modeState.mode, 'single');
    running = false;
  });

  // Verify `leaderteam-panel/client.js` renders "会话内执行模式 (Single / Team)" and surfaces structured 409 error reason
  const clientCode = fs.readFileSync(path.join(repoRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'utf8');
  let desc = null;
  const sandbox = {
    window: {
      location: { protocol: 'http:', pathname: '/' },
      __ModuleLoader__: { load(d) { desc = d; } },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, value: {} }) }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(clientCode, sandbox);

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: init => {
      if (Array.isArray(init) && init.length === 0) {
        return [[{
          sessionId: 'sess-panel-lt',
          title: 'Panel LT Session',
          executionMode: 'single',
          isLtSession: true,
          canSwitchMode: true,
          modeState: { sessionId: 'sess-panel-lt', mode: 'single', isLtSession: true, canSwitch: true, busyReason: null },
        }], () => {}];
      }
      return [init, () => {}];
    },
    useEffect: () => {},
    useCallback: fn => fn,
  };
  const panelPlugin = desc.factory(mod => (mod === 'react' ? fakeReact : null));
  const renderedTree = JSON.stringify(panelPlugin.ConsoleView({}));
  assert.ok(renderedTree.includes('会话内执行模式 (Single / Team)'));
  assert.ok(renderedTree.includes('切换为 Team'));

  // Verify `lt-web/src/lib/api.ts` preserves `LtApiError` (`code`, `status`, `details.modeState`) on 409 responses
  const { LtApiError, switchWorkbenchSessionMode } = await import('../../packages/lt-web/src/lib/api.ts');
  const prevFetch = globalThis.fetch;
  const prevWin = globalThis.window;
  try {
    globalThis.window = { location: { pathname: '/lt/' } };
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: false,
          contract: 'lt.public.v1',
          contractVersion: '1.1.0',
          generatedAt: new Date().toISOString(),
          error: {
            code: 'MODE_SWITCH_BUSY',
            message: 'Leader session is currently executing',
            retriable: true,
            details: {
              modeState: {
                sessionId: 'sess-busy-ui',
                mode: 'team',
                defaultMode: 'team',
                isLtSession: true,
                canSwitch: false,
                busyReason: 'Leader session is currently executing',
                activeTurn: true,
                activeMembersCount: 0,
                pendingReviewsCount: 0,
                activeConferenceId: null,
                updatedAt: null,
                switchCount: 0,
              },
            },
          },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      );

    await assert.rejects(
      () => switchWorkbenchSessionMode('sess-busy-ui', 'single'),
      err => {
        assert.ok(err instanceof LtApiError);
        assert.equal(err.code, 'MODE_SWITCH_BUSY');
        assert.equal(err.status, 409);
        assert.equal(err.details?.modeState?.mode, 'team');
        assert.equal(err.details?.modeState?.canSwitch, false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = prevFetch;
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }

  // Verify compiled `web-dist` ships dual-mode UI labels & CSS classes
  const distDir = resolveLtWebDistDir();
  const jsFiles = fs.readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.js'));
  const cssFiles = fs.readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.css'));
  const combinedJs = jsFiles.map(f => fs.readFileSync(path.join(distDir, 'assets', f), 'utf8')).join('\n');
  const combinedCss = cssFiles.map(f => fs.readFileSync(path.join(distDir, 'assets', f), 'utf8')).join('\n');

  assert.ok(combinedJs.includes('Team 团队协作'));
  assert.ok(combinedJs.includes('Single 单代理直执'));
  assert.ok(combinedJs.includes('DSH 原生'));
  assert.ok(combinedJs.includes('当前为 DSH 原生预设会话（Single/Team 仅作用于 LT 会话）'));
  assert.ok(combinedJs.includes('workbench/mode'));
  assert.ok(combinedCss.includes('.lt-mode-segment'));
  assert.ok(combinedCss.includes('.lt-mode-badge'));
});

test('Stage 7 Regressions (V223-UI-01, UI-02, UI-03, UI-04, UI-07, RT-07): cold event unwrapping, Single-mode gate usage accounting, Magpie apiKeyEnv template, blank Single session restart survival, and 0-orphan non-LT create guard', async t => {
  const zlib = await import('node:zlib');
  const { syncActiveModelsToDshHost } = await import('../../leaderteam/plugins/leaderteam-panel/public-api.mjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-s7-ui-api-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const { dshHome, storageRoot, rt } = createIsolatedRuntime(tmpDir);
  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const writeDurableSessionZst = (sid, rows) => {
    const dir = path.join(dshHome, 'sessions', sid);
    fs.mkdirSync(dir, { recursive: true });
    const compressed = Buffer.concat(rows.map(r => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`))));
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), compressed);
  };

  // --- V223-UI-01: Cold-resumed session wraps wire events as `{ type: 'event', event }` in `sessionController.events()` ---
  const coldTranscriptSid = 'session-97cb6003-3a77-41e4-82e2-a054ad2d0aff';
  writeDurableSessionZst(coldTranscriptSid, [
    { type: 'session', version: 4, id: coldTranscriptSid, cwd: workspaceDir, agentPreset: 'leaderteam', createdAt: 1000 },
  ]);

  // --- V223-UI-02: Pure Single-mode session with FinalGate `roles.gate` usage.jsonl & gate.jsonl (no team.json / members.jsonl) ---
  const pureSingleSid = 'session-39c8a7e3-3b77-46aa-9a2b-65deb18ce677';
  writeDurableSessionZst(pureSingleSid, [
    { type: 'session', version: 4, id: pureSingleSid, cwd: workspaceDir, agentPreset: 'leaderteam', createdAt: 2000 },
    {
      type: 'assistant/message',
      seq: 1,
      time: 2100,
      data: {
        message: { id: 'm-single-main', source: { kind: 'model', provider: 'magpie', model: 'codex/gpt-6.1-sol' }, content: [{ type: 'text', text: 'Done' }] },
        usage: { inputTokens: 300, cacheReadTokens: 100, outputTokens: 35, totalTokens: 435 },
      },
    },
  ]);
  const pureSingleTeamDir = path.join(storageRoot, 'teams', pureSingleSid);
  fs.mkdirSync(pureSingleTeamDir, { recursive: true });
  const gateIso = new Date(2250).toISOString();
  appendJsonl(path.join(pureSingleTeamDir, 'usage.jsonl'), {
    at: gateIso,
    role: 'gate',
    route: 'codex/gpt-6.1-sol',
    ok: true,
    attempts: 1,
    tool: 'bash',
    member: 'leader',
    usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 25, totalTokens: 145 },
  });
  appendJsonl(path.join(pureSingleTeamDir, 'gate.jsonl'), {
    at: gateIso,
    decision: 'allow',
    by: 'model',
    tool: 'bash',
  });
  assert.equal(TeamStore.exists(storageRoot, pureSingleSid), false, 'Pure Single session must have no team.json / members.jsonl');

  let hostCreateCalls = 0;
  const hostSessionsList = [];

  const fakeCtx = {
    agentPresets: {
      defaultId: 'standard',
      async resolve(id) {
        if (id === 'leaderteam' || id === 'standard') return { id };
        throw new Error(`Unknown preset: ${id}`);
      },
    },
    sessionController: {
      async create(req) {
        hostCreateCalls += 1;
        const sid = req.sessionId || `session-s7-${hostCreateCalls}`;
        const preset = req.agentPreset || 'standard';
        writeDurableSessionZst(sid, [
          { type: 'session', version: 4, id: sid, cwd: req.cwd || workspaceDir, agentPreset: preset, createdAt: 3000 + hostCreateCalls },
        ]);
        hostSessionsList.push({
          sessionId: sid,
          cwd: req.cwd || workspaceDir,
          updatedAt: 3000 + hostCreateCalls,
          running: false,
          blank: true,
          // Simulate cold DSH list item with unpopulated projections
          projections: { values: {} },
        });
        return { sessionId: sid, agentPreset: preset };
      },
      async list() {
        return { items: hostSessionsList };
      },
      async events({ address, sessionId }) {
        const sid = address?.sessionId ?? sessionId;
        if (sid === coldTranscriptSid) {
          return {
            records: [
              { type: 'session', version: 4, id: coldTranscriptSid, cwd: workspaceDir, agentPreset: 'leaderteam' },
              {
                type: 'event',
                seq: 1,
                surfaceOp: 'seed',
                event: {
                  type: 'user/message',
                  time: 1005,
                  data: { message: { id: 'seed-ignored', source: { kind: 'user' }, content: [{ type: 'text', text: 'SEED_ONLY' }] } },
                },
              },
              {
                type: 'event',
                seq: 2,
                event: {
                  type: 'user/message',
                  time: 1010,
                  data: { message: { id: 'u-cold-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Create src/single-direct.mjs' }] } },
                },
              },
              {
                type: 'event',
                seq: 3,
                event: {
                  type: 'assistant/message',
                  time: 1020,
                  data: {
                    message: {
                      id: 'a-cold-1',
                      source: { model: 'codex/gpt-6.1-sol' },
                      content: [
                        { type: 'thinking', thinking: 'Direct write in Single mode' },
                        { type: 'tool_use', id: 'tc-1', name: 'write' },
                        { type: 'text', text: 'SINGLE_MODE_TURN1_COMPLETE' },
                      ],
                    },
                    usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
                  },
                },
              },
            ],
          };
        }
        return { records: [] };
      },
      async state() {
        return { running: false };
      },
    },
    settings: {
      updatedCalls: [],
      async describe() {
        // Real DSH 0.2.2-rc.5 returns an Array of `{ ns, value }` descriptors, plus support legacy `{ namespaces }`
        return [{ ns: 'llm-pi-ai', value: { providers: {} } }];
      },
      async update(req) {
        this.updatedCalls.push(req);
      },
    },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };

  await withTestRuntime(rt, async () => {
    const h = createPublicContractHandlers(fakeCtx, rt);

    // 1. V223-UI-01: Cold session transcript unwraps `{ type: 'event', event }` and skips seed envelopes
    const coldTx = await (await h.workbenchTranscript(makeJsonPost({ sessionId: coldTranscriptSid }))).json();
    assert.equal(coldTx.ok, true);
    assert.equal(coldTx.data.modeState.isLtSession, true);
    assert.equal(coldTx.data.messages.length, 2, 'Cold-resumed transcript must unwrap controller event envelopes');
    assert.equal(coldTx.data.messages[0].role, 'user');
    assert.equal(coldTx.data.messages[0].text, 'Create src/single-direct.mjs');
    assert.equal(coldTx.data.messages[1].role, 'assistant');
    assert.equal(coldTx.data.messages[1].text, 'SINGLE_MODE_TURN1_COMPLETE');
    assert.equal(coldTx.data.messages[1].toolCalls[0].name, 'write');

    // 2. V223-UI-02: Hengzhang `/api/lt/v1/usage/{overview,sessions,report}` counts 100% of pure Single-mode `roles.gate` tokens & costs
    const usageOv = await (await h.usageOverview(makeJsonPost({ syncGateway: false }))).json();
    assert.equal(usageOv.ok, true);
    const singleOvRow = usageOv.data.overview.sessions.find(s => s.sessionId === pureSingleSid);
    assert.ok(singleOvRow);
    assert.equal(singleOvRow.kind, 'session');
    assert.equal(singleOvRow.callsTotal, 2);
    assert.equal(singleOvRow.totalTokens, 580);
    assert.ok(singleOvRow.costActualCny > 0);

    const usageSess = await (await h.usageSessions(makeJsonPost({ syncGateway: false }))).json();
    assert.equal(usageSess.ok, true);
    const singleSessRow = usageSess.data.sessions.find(s => s.id === pureSingleSid);
    assert.ok(singleSessRow);
    assert.equal(singleSessRow.kind, 'session');
    assert.equal(singleSessRow.callsTotal, 2);
    assert.equal(singleSessRow.totalTokens, 580);
    assert.equal(singleSessRow.memberCount, 0);

    const usageRep = await (await h.usageReport(makeJsonPost({ sessionId: pureSingleSid, syncGateway: false }))).json();
    assert.equal(usageRep.ok, true);
    assert.equal(usageRep.data.report.meta.kind, 'session');
    assert.equal(usageRep.data.report.team, undefined);
    assert.equal(usageRep.data.report.totals.callsTotal, 2);
    assert.equal(usageRep.data.report.totals.totalTokens, 580);
    const pubGate = usageRep.data.publicRecords.find(r => r.sourceKind === 'lt-governance');
    assert.ok(pubGate, 'Public usage records must include Single-mode safety gate record');
    assert.equal(pubGate.attribution.role, 'gate');
    assert.equal(pubGate.attribution.teamId, null);
    assert.equal(pubGate.tokens.totalTokens, 145);

    // 3. V223-UI-03 + S8-E2E-01c: Loopback Magpie provider template uses `headers.Authorization` and omits `apiKeyEnv` (zero env vars required!)
    let capturedNs = null;
    let capturedProviders = null;
    const templateProbeCtx = {
      settings: {
        describe() {
          return [{
            ns: 'llm-pi-ai',
            value: {
              providers: {
                // Seed a stale port + stale apiKeyEnv to verify S8-E2E-01c/1d reconciliation
                magpie: {
                  displayName: 'Magpie Gateway',
                  api: 'openai-completions',
                  apiKeyEnv: 'MAGPIE_API_KEY',
                  baseURL: 'http://127.0.0.1:19999/v1',
                  models: [],
                },
              },
            },
          }];
        },
        async update(ns, nextData) {
          capturedNs = ns;
          capturedProviders = nextData?.providers ?? null;
        },
      },
      get(k) {
        return this[k] ?? null;
      },
    };
    const syncRes = await syncActiveModelsToDshHost(
      templateProbeCtx,
      rt,
      rt.config,
      [],
      { gatewayUrl: 'http://127.0.0.1:23190' },
      [{ route: 'codex/gpt-6.1-sol', provider: 'magpie', upstreamModel: 'codex/gpt-6.1-sol', efforts: ['low', 'medium', 'high'] }],
    );
    assert.equal(syncRes.synced, true);
    assert.equal(capturedNs, 'llm-pi-ai');
    assert.ok(capturedProviders?.magpie);
    assert.equal('apiKeyEnv' in capturedProviders.magpie, false, 'Loopback Magpie with Authorization header must omit apiKeyEnv');
    assert.equal(capturedProviders.magpie.headers?.Authorization, 'Bearer magpie-leaderteam');
    assert.equal(capturedProviders.magpie.api, 'openai-completions');
    assert.equal(capturedProviders.magpie.baseURL, 'http://127.0.0.1:23190/v1');

    // 4. V223-UI-07: `workbench/create` with non-LT `agentPreset` + `executionMode` rejects BEFORE `sessionController.create` (0 orphans!)
    const createCountBefore = hostCreateCalls;
    const nonLtWithSingle = await h.workbenchCreate(makeJsonPost({
      cwd: workspaceDir,
      agentPreset: 'standard',
      executionMode: 'single',
    }));
    assert.equal(nonLtWithSingle.status, 400);
    const nonLtSingleJson = await nonLtWithSingle.json();
    assert.equal(nonLtSingleJson.ok, false);
    assert.equal(nonLtSingleJson.error.code, 'MODE_NOT_LT_SESSION');
    assert.equal(nonLtSingleJson.error.details.modeState.isLtSession, false);
    assert.equal(hostCreateCalls, createCountBefore, 'Non-LT preset + executionMode must NOT create an orphan DSH session');

    const nonLtWithTeam = await h.workbenchCreate(makeJsonPost({
      cwd: workspaceDir,
      agentPreset: 'standard',
      executionMode: 'team',
    }));
    assert.equal(nonLtWithTeam.status, 400);
    assert.equal((await nonLtWithTeam.json()).error.code, 'MODE_NOT_LT_SESSION');
    assert.equal(hostCreateCalls, createCountBefore, 'Non-LT preset + team executionMode must NOT create an orphan DSH session');

    // Creating a blank Single-mode LT session succeeds cleanly
    const blankSingle = await (await h.workbenchCreate(makeJsonPost({
      cwd: workspaceDir,
      executionMode: 'single',
    }))).json();
    assert.equal(blankSingle.ok, true);
    const blankSingleSid = blankSingle.data.sessionId;
    assert.equal(hostCreateCalls, createCountBefore + 1);

    // Also add an unpersisted blank native DSH session (`blank: true`, no LT artifacts) -> should remain hidden
    hostSessionsList.push({
      sessionId: 'session-blank-native-ephemeral',
      cwd: workspaceDir,
      updatedAt: 3999,
      running: false,
      blank: true,
      projections: { values: {} },
    });
    writeDurableSessionZst('session-blank-native-ephemeral', [
      { type: 'session', version: 4, id: 'session-blank-native-ephemeral', cwd: workspaceDir, agentPreset: 'standard', createdAt: 3999 },
    ]);

    // 5. V223-UI-04: Simulate `dsh --profile web` restart (`coldRt` with empty `workbenchCreatedSessionIds` and unpopulated `projections`)
    const coldRt = createIsolatedRuntime(tmpDir).rt;
    assert.equal(coldRt.workbenchCreatedSessionIds, undefined);
    await withTestRuntime(coldRt, async () => {
      const coldH = createPublicContractHandlers(fakeCtx, coldRt);
      const coldSessions = await (await coldH.workbenchSessions()).json();
      assert.equal(coldSessions.ok, true);
      const foundBlankSingle = coldSessions.data.sessions.find(s => s.sessionId === blankSingleSid);
      assert.ok(foundBlankSingle, 'Blank persisted Single-mode session must survive dsh restart in /workbench/sessions');
      assert.equal(foundBlankSingle.executionMode, 'single');
      assert.equal(foundBlankSingle.isLtSession, true);
      assert.equal(foundBlankSingle.agentPreset, 'leaderteam', 'Must recover agentPreset from durable .zstd session rows');
      assert.equal(
        coldSessions.data.sessions.some(s => s.sessionId === 'session-blank-native-ephemeral'),
        false,
        'Unpersisted blank non-LT session must remain filtered out',
      );

      // V223-RT-07 (`safeInspectSessionItemMode`): actual error message surfaced instead of hardcoded "Invalid session identifier"
      const modesDir = path.join(storageRoot, 'session-modes');
      fs.mkdirSync(modesDir, { recursive: true });
      const outsideDummy = path.join(tmpDir, 'outside-mode.json');
      fs.writeFileSync(outsideDummy, '{}');
      const symlinkSid = 'session-escape-probe';
      const probePath = path.join(modesDir, `${symlinkSid}.json`);
      try {
        fs.symlinkSync(outsideDummy, probePath);
      } catch (err) {
        if (err?.code !== 'EPERM') throw err;
        const outsideEscapeDir = path.join(tmpDir, 'outside-mode-dir');
        fs.mkdirSync(outsideEscapeDir, { recursive: true });
        fs.symlinkSync(outsideEscapeDir, probePath, 'junction');
      }
      hostSessionsList.push({
        sessionId: symlinkSid,
        cwd: workspaceDir,
        updatedAt: 4100,
        running: false,
        blank: false,
        projections: { values: { agentPreset: 'leaderteam' } },
      });
      const withEscape = await (await coldH.workbenchSessions()).json();
      const escRow = withEscape.data.sessions.find(s => s.sessionId === symlinkSid);
      assert.ok(escRow);
      assert.equal(escRow.canSwitchMode, false);
      assert.notEqual(escRow.modeBusyReason, 'Invalid session identifier');
      assert.match(escRow.modeBusyReason, /symlink|outside|escape/i);
      try { fs.unlinkSync(probePath); } catch { try { fs.rmdirSync(probePath); } catch {} }
    });
  });
});

test('Stage 7 Frontend Regressions (V223-UI-05, UI-06, UI-08): WorkbenchView HUD isolation, async loadTranscript/handleSwitchMode race guards, client.js concurrent switchingMap, dark custom WCAG AA tokens & 1.0.0 capability gating', async () => {
  const { createRequire } = await import('node:module');
  const webRequire = createRequire(path.join(repoRoot, 'packages', 'lt-web', 'package.json'));
  const esbuild = webRequire('esbuild');
  const { applyThemeToDom, computeContrastRatio } = await import('../../packages/lt-web/src/lib/api.ts');

  // 1. V223-UI-08 (Theme): Dark `custom` theme (`surfLum < 0.25`) sets WCAG AA semantic tokens & cleans up when leaving custom/dark
  const prevDoc = globalThis.document;
  const prevStorage = globalThis.localStorage;
  try {
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

    const darkSeeds = {
      canvasColor: '#0F1115',
      surfaceColor: '#1A1E26',
      inkColor: '#ECEFF4',
      accentColor: '#D29A68',
      dangerColor: '#A3263F', // low-contrast light-mode crimson seed -> must auto-upgrade to `#DF7A72` on dark surface
      headingFontMode: 'serif',
      cornerStyle: 'balanced',
      density: 'standard',
    };
    applyThemeToDom('custom', darkSeeds);
    assert.equal(globalThis.document.documentElement.style.colorScheme, 'dark');
    assert.ok(domStyle.get('--lt-fg-primary'));
    assert.ok(domStyle.get('--lt-info'));
    assert.ok(domStyle.get('--lt-info-bg'));
    assert.ok(domStyle.get('--lt-success'));
    assert.ok(domStyle.get('--lt-warning'));
    assert.ok(domStyle.get('--lt-danger'));
    assert.ok(domStyle.get('--lt-danger-bg'));

    // Heluo deriveCustom WCAG AA/AAA guard-rails on dark custom theme (`#1A1E26` surface, low-contrast `#A3263F` danger seed auto-lifted >= 4.5:1)
    assert.ok(computeContrastRatio(domStyle.get('--lt-fg-primary'), '#1A1E26') >= 12, 'Primary ink on dark surface must pass 12:1');
    assert.ok(computeContrastRatio(domStyle.get('--lt-fg-secondary'), '#1A1E26') >= 7, 'Secondary ink on dark surface must pass 7:1');
    assert.ok(computeContrastRatio(domStyle.get('--lt-fg-muted'), '#0F1115') >= 4.5, 'Muted ink on dark canvas must pass 4.5:1');
    assert.ok(computeContrastRatio(domStyle.get('--lt-info'), '#1A1E26') >= 4.5, 'Info/accent text on dark surface must pass 4.5:1');
    assert.ok(computeContrastRatio(domStyle.get('--lt-success'), domStyle.get('--lt-success-bg')) >= 4.5, 'Success text on derived dark success-bg must pass 4.5:1');
    assert.ok(computeContrastRatio(domStyle.get('--lt-warning'), domStyle.get('--lt-warning-bg')) >= 4.5, 'Warning text on derived dark warning-bg must pass 4.5:1');
    assert.ok(computeContrastRatio(domStyle.get('--lt-danger'), domStyle.get('--lt-danger-bg')) >= 4.5, 'Auto-lifted danger text on derived dark danger-bg must pass 4.5:1');
    assert.notEqual(domStyle.get('--lt-danger'), '#A3263F', 'Low-contrast crimson seed must be auto-lifted on dark surface');

    // Switching to light custom (`#FFFFFF`) derives light colorScheme and preserves WCAG AA guard-rails
    applyThemeToDom('custom', { ...darkSeeds, surfaceColor: '#FFFFFF', canvasColor: '#F2F3F5', inkColor: '#141619' });
    assert.equal(globalThis.document.documentElement.style.colorScheme, 'light');
    assert.ok(computeContrastRatio(domStyle.get('--lt-fg-primary'), '#FFFFFF') >= 12);
    assert.ok(computeContrastRatio(domStyle.get('--lt-danger'), domStyle.get('--lt-danger-bg')) >= 4.5);

    // Re-apply dark custom, then switch to `'white'` -> removes all inline custom overrides
    applyThemeToDom('custom', darkSeeds);
    assert.ok(domStyle.has('--lt-info'));
    applyThemeToDom('white', darkSeeds);
    for (const k of ['--lt-info', '--lt-info-bg', '--lt-success', '--lt-warning', '--lt-danger', '--lt-seal', '--lt-bg-surface', '--lt-fg-primary']) {
      assert.equal(domStyle.has(k), false, `Preset theme must remove inline ${k}`);
    }
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }

  // Verify built `web-dist/index.html` `bootLtTheme` also applies dark custom WCAG AA overrides synchronously
  const distIndexHtml = fs.readFileSync(path.join(resolveLtWebDistDir(), 'index.html'), 'utf8');
  const bootScript = distIndexHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  const bootStyle = new Map();
  vm.runInNewContext(bootScript, {
    localStorage: {
      getItem: () => JSON.stringify({
        theme: 'custom',
        customTheme: {
          canvasColor: '#0F1115',
          surfaceColor: '#1A1E26',
          inkColor: '#ECEFF4',
          accentColor: '#D29A68',
          dangerColor: '#A3263F',
        },
      }),
    },
    document: {
      documentElement: {
        setAttribute: () => {},
        removeAttribute: () => {},
        style: {
          colorScheme: '',
          setProperty: (k, v) => bootStyle.set(k, String(v)),
          removeProperty: k => bootStyle.delete(k),
        },
      },
    },
  });
  assert.ok(computeContrastRatio(bootStyle.get('--lt-info'), '#1A1E26') >= 4.5);
  assert.ok(computeContrastRatio(bootStyle.get('--lt-success'), bootStyle.get('--lt-success-bg')) >= 4.5);
  assert.ok(computeContrastRatio(bootStyle.get('--lt-danger'), bootStyle.get('--lt-danger-bg')) >= 4.5);

  // 2. V223-UI-06 (`leaderteam-panel/client.js`): Concurrent row switches keep in-flight rows & refresh button locked
  {
    const clientCode = fs.readFileSync(path.join(repoRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'utf8');
    let panelDesc = null;
    const pendingSwitchResolvers = new Map();
    const sandbox = {
      window: {
        location: { protocol: 'http:', pathname: '/' },
        __ModuleLoader__: { load(d) { panelDesc = d; } },
      },
      fetch: async (_route, init) => {
        const body = JSON.parse(init?.body || '{}');
        if (body.action === 'set') {
          return new Promise(resolve => {
            pendingSwitchResolvers.set(body.sessionId, mode =>
              resolve({
                ok: true,
                status: 200,
                json: async () => ({
                  ok: true,
                  value: {
                    changed: true,
                    modeState: { sessionId: body.sessionId, mode, isLtSession: true, canSwitch: true, busyReason: null },
                  },
                }),
              }),
            );
          });
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) };
      },
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(clientCode, sandbox);

    const states = [];
    let hookIdx = 0;
    const statefulReact = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = hookIdx++;
        if (states.length <= idx) {
          states[idx] = Array.isArray(init) && init.length === 0
            ? [
                { sessionId: 'panel-s1', title: 'Row 1', executionMode: 'team', isLtSession: true, canSwitchMode: true, modeState: { sessionId: 'panel-s1', mode: 'team', isLtSession: true, canSwitch: true } },
                { sessionId: 'panel-s2', title: 'Row 2', executionMode: 'team', isLtSession: true, canSwitchMode: true, modeState: { sessionId: 'panel-s2', mode: 'team', isLtSession: true, canSwitch: true } },
              ]
            : init;
        }
        const setter = next => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next;
        };
        return [states[idx], setter];
      },
      useEffect: () => {},
      useCallback: fn => fn,
    };
    const renderPanel = () => {
      hookIdx = 0;
      return panelPlugin.ConsoleView({});
    };
    const findButtons = (node, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) {
        node.forEach(c => findButtons(c, out));
        return out;
      }
      if (node.type === 'button') out.push(node);
      findButtons(node.children, out);
      return out;
    };
    const textOf = node => {
      if (node === null || node === undefined || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(textOf).join('');
      return textOf(node.children);
    };

    const panelPlugin = panelDesc.factory(m => (m === 'react' ? statefulReact : null));
    let tree = renderPanel();
    let btns = findButtons(tree);
    const rowBtnsInitial = btns.filter(b => textOf(b).includes('切换为 Single'));
    assert.equal(rowBtnsInitial.length, 2);

    // Trigger s1 switch (in-flight)
    const p1 = rowBtnsInitial[0].props.onClick();
    tree = renderPanel();
    btns = findButtons(tree);
    assert.equal(btns.find(b => textOf(b) === '刷新会话模式').props.disabled, true);
    assert.equal(btns.filter(b => textOf(b) === '切换中…').length, 1);

    // Trigger s2 switch concurrently while s1 is still in-flight -> BOTH must stay locked!
    const s2Btn = btns.find(b => textOf(b) === '切换为 Single');
    const p2 = s2Btn.props.onClick();
    tree = renderPanel();
    btns = findButtons(tree);
    assert.equal(btns.filter(b => textOf(b) === '切换中…').length, 2, 'Both s1 and s2 buttons must stay locked concurrently');

    // Finish s2 first -> s1 and "刷新会话模式" MUST remain locked!
    pendingSwitchResolvers.get('panel-s2')('single');
    await p2;
    tree = renderPanel();
    btns = findButtons(tree);
    assert.equal(btns.filter(b => textOf(b) === '切换中…').length, 1, 's1 must remain locked after s2 completes');
    assert.equal(btns.find(b => textOf(b) === '刷新会话模式').props.disabled, true, 'Refresh button must remain locked while s1 is in flight');

    // Finish s1 -> all unlocked
    pendingSwitchResolvers.get('panel-s1')('single');
    await p1;
    tree = renderPanel();
    btns = findButtons(tree);
    assert.equal(btns.filter(b => textOf(b) === '切换中…').length, 0);
    assert.equal(btns.find(b => textOf(b) === '刷新会话模式').props.disabled, false);
  }

  // 3. Compile `WorkbenchView.tsx` in-memory via `esbuild` and verify V223-UI-05, V223-UI-06 & V223-UI-08 behaviorally
  const built = await esbuild.build({
    entryPoints: [path.join(repoRoot, 'packages', 'lt-web', 'src', 'views', 'WorkbenchView.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'transform',
    tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react' } }),
    external: ['react'],
  });
  const compiledWorkbenchJs = built.outputFiles[0].text;

  function createWorkbenchHarness(initialBundle, apiHandler) {
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
    const fn = new Function('require', 'module', 'exports', compiledWorkbenchJs);
    fn(id => (id === 'react' ? mockReact : webRequire(id)), mod, mod.exports);
    const { WorkbenchView } = mod.exports;

    let currentBundle = initialBundle;
    const render = () => {
      stateCursor = 0;
      refCursor = 0;
      cbCursor = 0;
      effectCursor = 0;
      const prevWin = globalThis.window;
      const prevFetch = globalThis.fetch;
      const prevSetInterval = globalThis.setInterval;
      const prevClearInterval = globalThis.clearInterval;
      globalThis.window = { location: { pathname: '/lt/' } };
      globalThis.setInterval = () => 999;
      globalThis.clearInterval = () => {};
      globalThis.fetch = async (url, init) => apiHandler(String(url), JSON.parse(init?.body || '{}'));
      try {
        const vnode = WorkbenchView({
          bundle: currentBundle,
          onRefreshBundle: async () => {},
          onNavigateTab: () => {},
        });
        for (const ef of effects) {
          if (ef && ef.pending) {
            ef.pending = false;
            if (typeof ef.cleanup === 'function') ef.cleanup();
            ef.cleanup = ef.fn();
          }
        }
        return vnode;
      } finally {
        globalThis.fetch = prevFetch;
        globalThis.setInterval = prevSetInterval;
        globalThis.clearInterval = prevClearInterval;
        if (prevWin === undefined) delete globalThis.window;
        else globalThis.window = prevWin;
      }
    };

    const runWithMockFetch = async work => {
      const prevWin = globalThis.window;
      const prevFetch = globalThis.fetch;
      globalThis.window = { location: { pathname: '/lt/' } };
      globalThis.fetch = async (url, init) => apiHandler(String(url), JSON.parse(init?.body || '{}'));
      try {
        return await work();
      } finally {
        globalThis.fetch = prevFetch;
        if (prevWin === undefined) delete globalThis.window;
        else globalThis.window = prevWin;
      }
    };

    return { render, runWithMockFetch, setBundle: b => { currentBundle = b; } };
  }

  const walkNodes = (node, pred, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      node.forEach(n => walkNodes(n, pred, out));
      return out;
    }
    if (pred(node)) out.push(node);
    walkNodes(node.children, pred, out);
    return out;
  };
  const renderText = node => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(renderText).join('');
    return renderText(node.children);
  };
  const okJson = data => new Response(JSON.stringify({
    ok: true,
    contract: 'lt.public.v1',
    contractVersion: '1.1.0',
    generatedAt: new Date().toISOString(),
    data,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const baseBundle = {
    capabilities: {
      backendLine: 'v2.2.x-oss',
      backendVersion: '2.2.3',
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
      roleAssignments: { leader: { route: 'codex/gpt-6.1-sol', effort: 'medium', fallback: [] } },
      scheduler: { maxActiveMembers: 4, effectiveCap: 4, activeExecutionMembers: 1, pressureBand: 'normal' },
      teams: [
        {
          teamId: 'sess-busy-A',
          sessionId: 'sess-busy-A',
          title: 'Session A Active Team',
          status: 'active',
          taskSeq: 7,
          timers: null,
          frontierStages: [{ stageId: 'stage-A-only', title: 'Session A Exclusive Stage', executionState: 'running', writeScope: ['src/a.ts'] }],
          members: [{ memberId: 'm-a', name: 'worker-A', configuredModel: 'codex/gpt-6.1-sol', effort: 'medium', status: 'running' }],
        },
        // Simulate a leaked/historical team entry for a session currently in Single mode
        {
          teamId: 'sess-single-C',
          sessionId: 'sess-single-C',
          title: null,
          status: 'idle',
          taskSeq: 1,
          timers: null,
          frontierStages: [],
          members: [],
        },
      ],
    },
    uiPreferences: { theme: 'white', customTheme: {}, usageAnalyticsEnabled: true, autoRefreshMs: 3000 },
    usageStatus: { enabled: true, healthy: true, dshHome: '/tmp', homeExists: true, cachedGatewayRecords: 0, lastSyncAt: null, lastSyncError: null },
  };

  // --- Probe A: V223-UI-05 HUD isolation + V223-UI-06 stale `loadTranscript` & `handleSwitchMode` race guards ---
  {
    const deferredTranscriptA = {};
    deferredTranscriptA.promise = new Promise(r => { deferredTranscriptA.resolve = r; });
    const deferredSwitchB = {};
    deferredSwitchB.promise = new Promise(r => { deferredSwitchB.resolve = r; });

    const sessionsPayload = [
      {
        sessionId: 'sess-busy-A',
        title: 'Busy Session A',
        cwd: '/tmp/ws',
        agentPreset: 'leaderteam',
        updatedAt: 1000,
        isTeam: true,
        executionMode: 'team',
        isLtSession: true,
        canSwitchMode: false,
        modeBusyReason: 'Leader session is currently executing',
        modeState: { sessionId: 'sess-busy-A', mode: 'team', defaultMode: 'team', isLtSession: true, canSwitch: false, busyReason: 'Leader session is currently executing', activeTurn: true, activeMembersCount: 1, pendingReviewsCount: 0, activeConferenceId: null, updatedAt: null, switchCount: 0 },
      },
      {
        sessionId: 'sess-idle-B',
        title: 'Idle Team Session B',
        cwd: '/tmp/ws',
        agentPreset: 'leaderteam',
        updatedAt: 1001,
        isTeam: false,
        executionMode: 'team',
        isLtSession: true,
        canSwitchMode: true,
        modeBusyReason: null,
        modeState: { sessionId: 'sess-idle-B', mode: 'team', defaultMode: 'team', isLtSession: true, canSwitch: true, busyReason: null, activeTurn: false, activeMembersCount: 0, pendingReviewsCount: 0, activeConferenceId: null, updatedAt: null, switchCount: 0 },
      },
      {
        sessionId: 'sess-single-C',
        title: 'Single Mode Session C',
        cwd: '/tmp/ws',
        agentPreset: 'leaderteam',
        updatedAt: 1002,
        isTeam: false,
        executionMode: 'single',
        isLtSession: true,
        canSwitchMode: true,
        modeBusyReason: null,
        modeState: { sessionId: 'sess-single-C', mode: 'single', defaultMode: 'team', isLtSession: true, canSwitch: true, busyReason: null, activeTurn: false, activeMembersCount: 0, pendingReviewsCount: 0, activeConferenceId: null, updatedAt: null, switchCount: 0 },
      },
      {
        sessionId: 'sess-native-D',
        title: 'Native DSH Session D',
        cwd: '/tmp/ws',
        agentPreset: 'standard',
        updatedAt: 1003,
        isTeam: false,
        executionMode: 'team',
        isLtSession: false,
        canSwitchMode: false,
        modeBusyReason: 'Not an LT session',
        modeState: { sessionId: 'sess-native-D', mode: 'team', defaultMode: 'team', isLtSession: false, canSwitch: false, busyReason: 'Not an LT session', activeTurn: false, activeMembersCount: 0, pendingReviewsCount: 0, activeConferenceId: null, updatedAt: null, switchCount: 0 },
      },
    ];

    const harness = createWorkbenchHarness(baseBundle, async (url, body) => {
      if (url.endsWith('/workbench/sessions')) {
        return okJson({ liveHost: true, workspaces: [{ workspaceId: 'ws-1', path: '/tmp/ws' }], sessions: sessionsPayload });
      }
      if (url.endsWith('/workbench/transcript')) {
        if (body.sessionId === 'sess-busy-A') {
          return deferredTranscriptA.promise;
        }
        return okJson({
          sessionId: body.sessionId,
          passiveState: { running: false },
          modeState: sessionsPayload.find(s => s.sessionId === body.sessionId)?.modeState ?? null,
          messages: [{ id: `msg-${body.sessionId}`, role: 'assistant', timeMs: 2000, text: `TRANSCRIPT_FOR_${body.sessionId}`, model: 'codex/gpt-6.1-sol', toolCalls: [] }],
        });
      }
      if (url.endsWith('/workbench/mode') && body.action === 'set') {
        return deferredSwitchB.promise;
      }
      return okJson({});
    });

    let tree;
    // Initial mount loads sessions -> auto-selects `sess-busy-A`, firing slow `loadTranscript('sess-busy-A')`
    await harness.runWithMockFetch(async () => {
      harness.render();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render(); // runs effect for `selectedSessionId === 'sess-busy-A'`
    });

    // User immediately clicks `sess-idle-B` while `loadTranscript('sess-busy-A')` is still pending
    const clickSession = sid => {
      const btn = walkNodes(tree, n => n.type === 'button' && renderText(n).includes(sid.slice(0, 12)))[0];
      assert.ok(btn, `Expected sidebar button for ${sid}`);
      btn.props.onClick();
    };

    await harness.runWithMockFetch(async () => {
      clickSession('sess-idle-B');
      tree = harness.render();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    // Verify `sess-idle-B` shows its own transcript AND does NOT bleed `sess-busy-A`'s Team HUD (`stage-A-only`)
    let fullText = renderText(tree);
    assert.ok(fullText.includes('TRANSCRIPT_FOR_sess-idle-B'));
    assert.equal(fullText.includes('stage-A-only'), false, 'V223-UI-05: Unrelated Team session B must NOT bleed Session A Team HUD');
    assert.ok(fullText.includes('当前暂无活跃 LeaderTeam 团队目录'));

    // Now resolve the stale `loadTranscript('sess-busy-A')` with `running: true, canSwitch: false`!
    await harness.runWithMockFetch(async () => {
      deferredTranscriptA.resolve(okJson({
        sessionId: 'sess-busy-A',
        passiveState: { running: true },
        modeState: sessionsPayload[0].modeState,
        messages: [{ id: 'msg-stale-A', role: 'assistant', timeMs: 1999, text: 'STALE_BUSY_SESSION_A_TEXT', model: 'codex/gpt-6.1-sol', toolCalls: [] }],
      }));
      await new Promise(r => setTimeout(r, 20));
      tree = harness.render();
    });

    fullText = renderText(tree);
    assert.equal(fullText.includes('STALE_BUSY_SESSION_A_TEXT'), false, 'V223-UI-06: Late transcript from Session A must NOT overwrite Session B messages');
    assert.ok(fullText.includes('TRANSCRIPT_FOR_sess-idle-B'));
    const segBtnsOnB = walkNodes(tree, n => n.type === 'button' && n.props.className === 'lt-mode-segment-btn');
    assert.ok(segBtnsOnB.length >= 2);
    assert.ok(segBtnsOnB.every(b => b.props.disabled === false), 'V223-UI-06: Idle Session B switcher must remain enabled');
    const cancelBtnOnB = walkNodes(tree, n => n.type === 'button' && renderText(n) === '中断当前回合')[0];
    assert.equal(cancelBtnOnB.props.disabled, true, 'V223-UI-06: Cancel turn button must remain disabled on idle Session B');

    // Start `handleSwitchMode('single')` on `sess-idle-B`, then switch to `sess-single-C` BEFORE `sess-idle-B` rejects with 409
    await harness.runWithMockFetch(async () => {
      const singleSegBtn = segBtnsOnB.find(b => renderText(b).includes('Single'));
      const switchPromise = singleSegBtn.props.onClick();
      tree = harness.render();

      // Move to `sess-single-C` while `sess-idle-B` switch is still in flight
      clickSession('sess-single-C');
      tree = harness.render();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();

      // V223-UI-05: `sess-single-C` must show Single HUD even though `bundle.runtime.teams` has an entry for `sess-single-C`!
      const singleCText = renderText(tree);
      assert.ok(singleCText.includes('当前会话处于 Single 单代理直执模式'), 'V223-UI-05: Single mode session must retain Single HUD');
      assert.equal(singleCText.includes('任务 #1'), false, 'V223-UI-05: Single mode session must NOT render Team HUD');

      // Reject `sess-idle-B`'s in-flight mode switch with HTTP 409 -> error banner must NOT leak onto `sess-single-C`!
      deferredSwitchB.resolve(new Response(JSON.stringify({
        ok: false,
        contract: 'lt.public.v1',
        contractVersion: '1.1.0',
        generatedAt: new Date().toISOString(),
        error: { code: 'MODE_SWITCH_BUSY', message: 'Session B became busy', retriable: true },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
      await switchPromise;
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    const alertsOnC = walkNodes(tree, n => n.props?.role === 'alert');
    assert.equal(alertsOnC.length, 0, 'V223-UI-06: Rejected switch from Session B must NOT leak error alert onto Session C');

    // Click native DSH session `sess-native-D` -> V223-UI-05: must render native DSH info card, zero Session A HUD bleed
    await harness.runWithMockFetch(async () => {
      clickSession('sess-native-D');
      tree = harness.render();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });
    const nativeDText = renderText(tree);
    assert.ok(nativeDText.includes('DSH 原生预设会话 (standard)'), 'V223-UI-05: Native DSH session must render clean native preset card');
    assert.equal(nativeDText.includes('stage-A-only'), false, 'V223-UI-05: Native DSH session must NOT bleed Session A Team HUD');
  }

  // --- Probe B: V223-UI-08 (`capabilities.features.inSessionDualMode` absent on 1.0.0 backend) ---
  {
    let workbenchModeCalls = 0;
    const compat100Bundle = structuredClone(baseBundle);
    delete compat100Bundle.capabilities.features.inSessionDualMode;

    const harness100 = createWorkbenchHarness(compat100Bundle, async url => {
      if (url.endsWith('/workbench/mode')) {
        workbenchModeCalls += 1;
        return new Response('Not Found', { status: 404 });
      }
      if (url.endsWith('/workbench/sessions')) {
        return okJson({
          liveHost: true,
          workspaces: [{ workspaceId: 'ws-1', path: '/tmp/ws' }],
          sessions: [{ sessionId: 'sess-100', title: 'Legacy 1.0.0 Session', cwd: '/tmp/ws', agentPreset: null, updatedAt: 1000, isTeam: true }],
        });
      }
      if (url.endsWith('/workbench/transcript')) {
        // 1.0.0 backend returns no `modeState`
        return okJson({ sessionId: 'sess-100', passiveState: { running: false }, messages: [] });
      }
      return okJson({});
    });

    let tree100;
    await harness100.runWithMockFetch(async () => {
      tree100 = harness100.render();
      await new Promise(r => setTimeout(r, 15));
      tree100 = harness100.render();
      await new Promise(r => setTimeout(r, 15));
      tree100 = harness100.render();
    });

    assert.equal(
      walkNodes(tree100, n => n.props?.className === 'lt-mode-segment').length,
      0,
      '1.0.0 bundle without inSessionDualMode must hide Single/Team segmented switchers',
    );
    assert.equal(
      walkNodes(tree100, n => n.props?.['aria-label'] === '新建会话初始执行模式').length,
      0,
      '1.0.0 bundle without inSessionDualMode must hide initial executionMode <select>',
    );
    assert.equal(
      walkNodes(tree100, n => n.props?.className === 'lt-mode-bar').length,
      0,
      '1.0.0 bundle without inSessionDualMode must hide .lt-mode-bar',
    );
    assert.equal(workbenchModeCalls, 0, '1.0.0 bundle without inSessionDualMode must make 0 unsolicited /workbench/mode calls');
  }
});

test('Stage 9 Product Regressions (S8-E2E-01a/b/c, S8-E2E-02, S8-E2E-03, S8-E2E-04, S8-E2E-05): Solo-Key vs Magpie namespace isolation, workbenchCreate selectModel, >192-char Hengzhang compaction, ProvidersView without providerPresets, model-config-ui /api/sync-desktop error, and desktop.patch.yml + THIRD_PARTY_NOTICES.md', async t => {
  const zlib = await import('node:zlib');
  const { createRequire } = await import('node:module');
  const webRequire = createRequire(path.join(repoRoot, 'packages', 'lt-web', 'package.json'));
  const esbuild = webRequire('esbuild');
  const { buildSoloKeyStarterConfig, SOLO_PROVIDER_PRESETS } = await import('../../leaderteam/core/solo-key.mjs');
  const { startModelConfigServer } = await import('../../leaderteam/core/model-config-ui.mjs');
  const { startMockMagpieServer } = await import('./companion-paths.mjs');
  const { buildPublicModelCatalog } = await import('../../leaderteam/gateway/index.mjs');

  const tmpDir = makeTempSandbox(t, 's9-prod');
  const { dshHome, storageRoot, cfgFile, rt } = createIsolatedRuntime(tmpDir);
  const workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  // --- 1. S8-E2E-01a/1b/1c: Solo-Key starter (`cfg.magpie.provider === 'deepseek'`) + Magpie onboarding + `workbenchCreate` `selectModel` ---
  const baseRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'leaderteam.config.json'), 'utf8'));
  const soloStarter = buildSoloKeyStarterConfig(baseRaw, { preset: SOLO_PROVIDER_PRESETS[0] });
  assert.equal(soloStarter.magpie.provider, 'deepseek');
  fs.writeFileSync(cfgFile, JSON.stringify(soloStarter, null, 2) + '\n');
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));

  // Verify Solo-Key `deepseek/*` models remain `sourceKind: 'direct'` in `buildPublicModelCatalog` even when `cfg.magpie.provider === 'deepseek'`
  const soloCatalog = buildPublicModelCatalog({
    magpieGatewayModels: [{ id: 'localrelay/alpha-pro', owned_by: 'localrelay', reasoning_levels: ['none', 'high'] }],
    effectiveConfig: rt.config,
  });
  const soloDsEntries = soloCatalog.filter(m => m.routeId.startsWith('deepseek/'));
  assert.ok(soloDsEntries.length >= 2);
  for (const dsEntry of soloDsEntries) {
    assert.equal(dsEntry.sourceKind, 'direct', `Solo-Key ${dsEntry.routeId} must stay sourceKind="direct"`);
    assert.equal(dsEntry.providerId, 'direct:deepseek');
  }
  const gwAlphaEntry = soloCatalog.find(m => m.routeId === 'localrelay/alpha-pro');
  assert.ok(gwAlphaEntry);
  assert.equal(gwAlphaEntry.sourceKind, 'magpie');
  assert.equal(gwAlphaEntry.providerId, 'magpie:localrelay');

  const mockMagpie = await startMockMagpieServer({ version: '0.1.4731' });
  t.after(() => mockMagpie.close());

  let dshSettingsState = {
    providers: {
      deepseek: {
        displayName: 'DeepSeek',
        api: 'openai-completions',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-v4-pro', input: ['text'] }],
      },
    },
  };
  const selectModelCalls = [];
  const fallbackAgentSelectCalls = [];
  let simulateSelectModelUnavailable = false;
  const hostAgents = new Map();

  const s9Ctx = {
    agents: hostAgents,
    agentPresets: {
      defaultId: 'standard',
      async resolve(id) {
        return { id };
      },
    },
    sessionController: {
      async create(req) {
        const sid = req.sessionId || `session-s9-${selectModelCalls.length + fallbackAgentSelectCalls.length + 1}`;
        hostAgents.set(sid, {
          id: sid,
          status: 'idle',
          session: { id: sid, header: { id: sid, cwd: req.cwd || workspaceDir, agentPreset: req.agentPreset || 'leaderteam' } },
          model: {
            select(sel) {
              fallbackAgentSelectCalls.push({ sessionId: sid, ...sel });
            },
          },
        });
        return { sessionId: sid, agentPreset: req.agentPreset || 'leaderteam' };
      },
      async selectModel(req) {
        if (simulateSelectModelUnavailable) {
          throw new Error('session/model-unavailable');
        }
        selectModelCalls.push(req);
        return { selected: { provider: req.provider, model: req.model, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) } };
      },
      async list() {
        return { items: [] };
      },
    },
    settings: {
      describe() {
        return [{ ns: 'llm-pi-ai', value: structuredClone(dshSettingsState) }];
      },
      async update(_ns, nextVal) {
        dshSettingsState = structuredClone(nextVal);
      },
    },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };

  await withTestRuntime(rt, async () => {
    const h = createPublicContractHandlers(s9Ctx, rt);
    await h.gatewayControl(makeJsonPost({
      action: 'configure',
      config: {
        mode: 'external',
        externalGatewayUrl: mockMagpie.gatewayUrl,
        externalWebAdminUrl: mockMagpie.webUrl,
        externalWebKey: mockMagpie.webKey,
      },
    }));
    await h.providersMutate(makeJsonPost({
      operation: 'save-provider',
      spec: { new: true, id: 'localrelay', name: 'Local Relay', chat: 'http://127.0.0.1:19991/v1', baseAPI: 'chat', key: 'sk-relay-1234567890' },
    }));
    const syncPoolRes = await (await h.modelsSyncPool(makeJsonPost({ target: 'local', enableInExecutionPool: true }))).json();
    assert.equal(syncPoolRes.ok, true);
    assert.equal(syncPoolRes.data.dshSettingsSync.synced, true);

    // Confirm `providers.deepseek` was NEVER clobbered and Magpie models synced strictly to `providers.magpie` without `apiKeyEnv`!
    assert.equal(dshSettingsState.providers.deepseek.baseURL, 'https://api.deepseek.com');
    assert.equal(dshSettingsState.providers.deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');
    assert.equal(
      dshSettingsState.providers.deepseek.models.some(m => m.id.includes('localrelay')),
      false,
      'Magpie models must NEVER sync into providers.deepseek',
    );
    assert.ok(dshSettingsState.providers.magpie, 'Magpie provider profile must be created under providers.magpie');
    assert.equal(dshSettingsState.providers.magpie.baseURL, `${mockMagpie.gatewayUrl}/v1`);
    assert.equal(dshSettingsState.providers.magpie.headers?.Authorization, 'Bearer magpie-leaderteam');
    assert.equal('apiKeyEnv' in dshSettingsState.providers.magpie, false);

    // Configure `roles.leader` to a synced Magpie model
    const syncedMagpieModel = syncPoolRes.data.models.find(m => m.sourceKind === 'magpie');
    assert.ok(syncedMagpieModel);
    const cfgRes = await (await h.runtimeConfigure(makeJsonPost({
      target: 'local',
      changes: {
        setRoles: [
          {
            role: 'leader',
            route: syncedMagpieModel.routeId,
            effort: syncedMagpieModel.efforts.defaultEffort,
          },
        ],
      },
    }))).json();
    assert.equal(cfgRes.ok, true);
    assert.equal(rt.config.models[syncedMagpieModel.routeId].provider, 'magpie');

    // S8-E2E-01b + R2-V223-04: `workbenchCreate` immediately selects `roles.leader.route` on `liveAgent.model.select`
    // WITHOUT calling `sessionController.selectModel` (which would overwrite DSH's global agentDefaultModel)!
    const created1 = await (await h.workbenchCreate(makeJsonPost({ cwd: workspaceDir, executionMode: 'single' }))).json();
    assert.equal(created1.ok, true);
    assert.equal(selectModelCalls.length, 0, 'workbenchCreate must never call sessionController.selectModel');
    assert.equal(fallbackAgentSelectCalls.length, 1);
    assert.equal(fallbackAgentSelectCalls[0].sessionId, created1.data.sessionId);
    assert.equal(fallbackAgentSelectCalls[0].provider, 'magpie');
    assert.equal(fallbackAgentSelectCalls[0].model, syncedMagpieModel.magpieModelId);

    simulateSelectModelUnavailable = true;
    const created2 = await (await h.workbenchCreate(makeJsonPost({ cwd: workspaceDir }))).json();
    assert.equal(created2.ok, true);
    assert.equal(selectModelCalls.length, 0);
    assert.equal(fallbackAgentSelectCalls.length, 2);
    assert.equal(fallbackAgentSelectCalls[1].sessionId, created2.data.sessionId);
    assert.equal(fallbackAgentSelectCalls[1].provider, 'magpie');

    // --- 2. S8-E2E-02: Overlong >192-char pure Single session gate usage via `/api/lt/v1/usage/report` ---
    const overlongSid = `session-overlong-single-${'x'.repeat(190)}`; // 214 chars
    const { encodeSafeTeamSegment } = await import('../../packages/lt-usage/reader/service.js');
    const compactedSeg = encodeSafeTeamSegment(overlongSid);
    assert.ok(compactedSeg.length <= 192 && compactedSeg.includes('~h'));
    const zstDir = path.join(dshHome, 'sessions', compactedSeg);
    fs.mkdirSync(zstDir, { recursive: true });
    const zstRows = [
      { type: 'session', version: 4, id: overlongSid, cwd: workspaceDir, agentPreset: 'leaderteam', createdAt: 7000 },
      {
        type: 'assistant/message',
        seq: 1,
        time: 7100,
        data: {
          message: { id: 'm-overlong-1', source: { kind: 'model', provider: 'magpie', model: 'codex/gpt-6.1-sol' }, content: [{ type: 'text', text: 'OK' }] },
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        },
      },
    ];
    fs.writeFileSync(
      path.join(zstDir, 'session.v4.jsonl.zstd'),
      Buffer.concat(zstRows.map(r => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`)))),
    );
    const compactedTeamDir = path.join(storageRoot, 'teams', compactedSeg);
    fs.mkdirSync(compactedTeamDir, { recursive: true });
    appendJsonl(path.join(compactedTeamDir, 'usage.jsonl'), {
      at: new Date(7200).toISOString(),
      role: 'gate',
      route: 'codex/gpt-6.1-sol',
      ok: true,
      attempts: 1,
      tool: 'bash',
      member: 'leader',
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    });
    const overlongRep = await (await h.usageReport(makeJsonPost({ sessionId: overlongSid, syncGateway: false }))).json();
    assert.equal(overlongRep.ok, true);
    assert.equal(overlongRep.data.report.meta.kind, 'session');
    assert.equal(overlongRep.data.report.totals.totalTokens, 220, 'Overlong pure Single session must report 120 + 100 = 220 tokens');
  });

  // --- 3. S8-E2E-03: `ProvidersView.tsx` renders cleanly when optional `bundle.providerPresets` is omitted ---
  const builtProvidersView = await esbuild.build({
    entryPoints: [path.join(repoRoot, 'packages', 'lt-web', 'src', 'views', 'ProvidersView.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    jsx: 'transform',
    tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react' } }),
    external: ['react'],
  });
  const mockReactForProviders = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) =>
      typeof type === 'function' ? type(Object.assign({}, props, { children })) : { type, props: props || {}, children },
    useState: init => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
  };
  mockReactForProviders.default = mockReactForProviders;
  const pvMod = { exports: {} };
  new Function('require', 'module', 'exports', builtProvidersView.outputFiles[0].text)(
    id => (id === 'react' ? mockReactForProviders : webRequire(id)),
    pvMod,
    pvMod.exports,
  );
  const mockV22Snapshot = JSON.parse(fs.readFileSync(path.join(contractsRoot, 'mocks', 'mock-v2.2-oss-snapshot.json'), 'utf8'));
  assert.equal(mockV22Snapshot.providerPresets, undefined, 'Contract snapshot omits optional providerPresets');
  const renderedProvidersTree = pvMod.exports.ProvidersView({
    bundle: {
      capabilities: mockV22Snapshot.capabilities,
      gateway: mockV22Snapshot.gateway,
      providers: mockV22Snapshot.providers,
      // providerPresets intentionally omitted (`undefined`)!
      models: mockV22Snapshot.models,
      runtime: mockV22Snapshot.runtime,
      uiPreferences: { theme: 'white', customTheme: {}, usageAnalyticsEnabled: true, autoRefreshMs: 3000 },
      usageStatus: { enabled: true, healthy: true, dshHome: '/tmp', homeExists: true, cachedGatewayRecords: 0, lastSyncAt: null, lastSyncError: null },
    },
    onRefreshBundle: async () => {},
  });
  assert.ok(JSON.stringify(renderedProvidersTree).includes('自定义 OpenAI / Responses / Anthropic / Gemini 供应商'));

  // --- 4. S8-E2E-04: `model-config-ui.mjs` `/api/sync-desktop` surfaces `syncRes.error` instead of generic fallback ---
  const cfgSrv = await startModelConfigServer({
    configFile: cfgFile,
    dshHome,
    projectRoot: repoRoot,
    port: 0,
  });
  t.after(() => cfgSrv.close());

  if (process.platform !== 'win32') {
    const syncDesktopRes = await fetch(`${cfgSrv.url}api/sync-desktop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LT-Token': cfgSrv.csrfToken,
      },
      body: '{}',
    });
    assert.equal(syncDesktopRes.status, 409);
    const syncDesktopBody = await syncDesktopRes.json();
    assert.notEqual(syncDesktopBody.error, 'Desktop sync failed');
    assert.match(syncDesktopBody.error, /On Linux\/macOS, dsh\.bundle syncs configured models automatically/);
  }

  // --- 5. S8-E2E-05: `config/desktop.patch.yml` & `THIRD_PARTY_NOTICES.md` parity ---
  const desktopPatchText = fs.readFileSync(path.join(repoRoot, 'config', 'desktop.patch.yml'), 'utf8');
  const presetLtBlock = desktopPatchText.split('- id: preset-lt-member-readonly')[0];
  assert.equal(presetLtBlock.includes('write: false'), false, 'preset-leaderteam in desktop.patch.yml must enable write/edit for Single mode');
  assert.ok(presetLtBlock.includes('id: tool-bash'));
  assert.ok(presetLtBlock.includes('id: tool-pwsh'));
  assert.ok(presetLtBlock.includes('id: tool-jobs'));

  const noticesPath = path.join(repoRoot, 'THIRD_PARTY_NOTICES.md');
  assert.equal(fs.existsSync(noticesPath), true, 'Root THIRD_PARTY_NOTICES.md must exist');
  const noticesText = fs.readFileSync(noticesPath, 'utf8');
  assert.match(noticesText, /Apache License, Version 2\.0/);
  assert.match(noticesText, /yetone\/magpie/);
  assert.match(noticesText, /MIT/);
  assert.match(noticesText, /packages\/lt-usage\/NOTICE\.md/);
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(rootPkg.version, '2.2.3');
  assert.ok(rootPkg.files.includes('THIRD_PARTY_NOTICES.md'));
});
