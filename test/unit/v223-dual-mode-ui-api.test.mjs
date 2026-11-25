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
import { validateContractBundle } from '../../../lt-shared-contracts/tests/contract-validator.mjs';

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
const contractsRoot = path.resolve(repoRoot, '..', 'lt-shared-contracts');

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
