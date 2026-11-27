import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import {
  TeamStore,
  encodeTeamStoreId,
  readJsonl,
  resolveTeamStoreLogicalId,
  appendJsonl,
} from '../../leaderteam/core/store.mjs';
import {
  currentPlanFile,
  writeCurrentPlan,
  readCurrentPlan,
} from '../../leaderteam/core/current-plan.mjs';
import {
  writeTeamConcurrencyFile,
  readTeamConcurrencyFile,
  resetAllTeamChatOverridesOnDisk,
} from '../../leaderteam/core/scheduler.mjs';
import {
  encodeSessionModeSegment,
  resolveSessionModePaths,
  readSessionModeRecord,
  writeSessionModeRecord,
  readSessionModeHistory,
} from '../../leaderteam/core/session-mode.mjs';
import {
  runtime,
  bindRuntimeConfigFile,
  teamStore,
} from '../../leaderteam/host/runtime.mjs';
import {
  getSessionExecutionMode,
  inspectSessionModeState,
  switchSessionExecutionMode,
} from '../../leaderteam/host/mode-controller.mjs';
import {
  onAgentCreated,
  reconcileStaleMembers,
  isProcessPidAlive,
} from '../../leaderteam/host/roles.mjs';
import { recentTeamObservability } from '../../leaderteam/host/observability.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { HengzhangUsageBridge } from '../../leaderteam/usage/hengzhang-bridge.mjs';
import { encodeDshSegment } from '../../packages/lt-usage/index.mjs';
import { startStandaloneLtUiServer } from '../../bin/lt-ui.mjs';
import { generateRedactedBugReport } from '../../bin/lt-bugreport.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const ossRoot = path.resolve(repoRoot, '..');

function makeTempSandbox(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-r2-223-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeZstdSession(sessionDir, rows) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const frames = rows.map(r => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8')));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

function resetRuntimeForTest(storageRoot, cfgFile) {
  const rt = runtime();
  rt.storageRoot = storageRoot;
  rt.surface = 'desktop';
  rt.cordisCompositionMode = false;
  rt.plugins = { scheduler: null, consensus: null, timerArchive: null, panel: null };
  rt.actors = new Map();
  rt.reads = new Map();
  rt.readProgress = new Map();
  rt.stores = new Map();
  rt.teamConfigViews = new Map();
  rt.sessionModesCache = new Map();
  rt.gatePatternCache = new Map();
  rt.inFlightGateReviews = new Map();
  rt.inFlightShellCallsBySession = new Map();
  rt.executionReviewJobs = new Map();
  rt.governanceJobs = new Map();
  rt.stopReviewPending = new Set();
  rt.directiveVerifyPending = new Set();
  rt.liveProcessMemberIds = new Set();
  rt.hostAgents = new Map();
  rt.counters = { allowed: 0, denied: 0, uncontrolled: 0, reviewErrors: 0 };
  rt.llm = null;
  rt.workspaceShellFailures = new Map();
  rt.circuitStates = new Map();
  rt.workbenchCreatedSessionIds = new Set();
  bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile, { includeLocal: false }));
  return rt;
}

function createFakePromptRegistry() {
  const sections = new Map();
  const contexts = new Map();
  return {
    sections,
    contexts,
    systemPrompt: {
      section(entry) {
        sections.set(entry.name, entry);
        return () => {
          if (sections.get(entry.name) === entry) sections.delete(entry.name);
        };
      },
      context(entry) {
        contexts.set(entry.name, entry);
        return () => {
          if (contexts.get(entry.name) === entry) contexts.delete(entry.name);
        };
      },
    },
  };
}

function createMockCtx({ presetMap = new Map(), sessionsMap = new Map(), agentsMap = new Map(), dshHome = null } = {}) {
  return {
    sessions: sessionsMap,
    agents: agentsMap,
    agentPresets: {
      presetForSession(sess) {
        if (!sess) return undefined;
        return presetMap.get(sess.id) ?? sess.header?.agentPreset;
      },
    },
    profileContext: dshHome ? { home: dshHome } : null,
    get(name) {
      return this[name] ?? null;
    },
  };
}

async function spawnSleeperProcess() {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('READY')) resolve();
    });
  });
  return child;
}

async function killProcessAndWait(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

test('R2-V223-01: inspectSessionModeState & GET /workbench/mode perform 0 disk writes and never cancel active members owned by another live process or unmounted host', async t => {
  const tmp = makeTempSandbox(t, 'r2-01');
  const dshHome = path.join(tmp, 'dsh-home');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const childProc = await spawnSleeperProcess();
  t.after(() => killProcessAndWait(childProc));
  assert.notEqual(childProc.pid, process.pid);
  assert.equal(isProcessPidAlive(childProc.pid), true);

  // 1. Default addMember records ownerPid === process.pid
  const pidCheckStore = new TeamStore(storageRoot, 'sess-ownerpid-default');
  pidCheckStore.ensure({ workspace: ws, surface: 'desktop' });
  pidCheckStore.addMember({ childId: 'm-default-pid', name: 'w-default', profile: 'code', taskSeq: 1 });
  assert.equal(pidCheckStore.getMember('m-default-pid').ownerPid, process.pid);

  // 2. Simulate Process A (`childProc.pid`) running an active member in `sess-cross-proc`
  const sid = 'sess-cross-proc';
  writeZstdSession(path.join(dshHome, 'sessions', sid), [
    { type: 'session', version: 4, id: sid, createdAt: 1000, cwd: ws, agentPreset: 'leaderteam' },
  ]);
  const store = new TeamStore(storageRoot, sid);
  store.ensure({ workspace: ws, surface: 'desktop' });
  store.addMember({
    childId: 'child-proc-a-1',
    name: 'impl-proc-a',
    profile: 'code',
    taskSeq: 1,
    ownerPid: childProc.pid,
  });
  store.setMemberStatus('child-proc-a-1', 'running');

  const membersBeforeBytes = fs.readFileSync(store.membersFile, 'utf8');
  const statBefore = fs.statSync(store.membersFile);

  // Process B Case 1: Unmounted standalone viewer (`GET /api/lt/v1/workbench/mode`)
  const prevDshHome = process.env.DSH_HOME;
  let uiServer = await startStandaloneLtUiServer({ port: 0, dshHome, configPath: cfgFile, requireAuth: false });
  t.after(async () => {
    if (uiServer) await uiServer.close();
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  });
  const getModeRes = await (await fetch(`${uiServer.baseUrl}/api/lt/v1/workbench/mode?sessionId=${sid}`)).json();
  await uiServer.close();
  uiServer = null;
  if (prevDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevDshHome;
  assert.equal(getModeRes.ok, true);
  assert.equal(getModeRes.data.modeState.isLtSession, true);
  assert.equal(getModeRes.data.modeState.activeMembersCount, 1);
  assert.equal(getModeRes.data.modeState.canSwitch, false);
  assert.match(getModeRes.data.modeState.busyReason ?? '', /team member/i);
  assert.equal(fs.readFileSync(store.membersFile, 'utf8'), membersBeforeBytes, 'GET /workbench/mode must make 0 writes to members.jsonl');
  assert.equal(fs.statSync(store.membersFile).mtimeMs, statBefore.mtimeMs);
  assert.equal(store.getMember('child-proc-a-1').status, 'running');

  // Process B Case 2: Even when Process B mounts `sid` in its own runtime (`actors` + `hostAgents` without `child-proc-a-1`),
  // neither `inspectSessionModeState` nor `reconcileStaleMembers` may cancel Process A's live PID member!
  const presetMap = new Map([[sid, 'leaderteam']]);
  const sessionsMap = new Map();
  const agentsMap = new Map();
  const ctxB = createMockCtx({ presetMap, sessionsMap, agentsMap, dshHome });
  const leaderAgentB = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: k => ctxB.get(k) },
    session: { id: sid, header: { id: sid, cwd: ws, agentPreset: 'leaderteam' }, snapshotEvents: () => [] },
  };
  sessionsMap.set(sid, leaderAgentB.session);
  agentsMap.set(sid, leaderAgentB);
  rt.hostAgents.set(sid, leaderAgentB);
  onAgentCreated(ctxB, { agent: leaderAgentB });

  // `onAgentCreated` called `reconcileStaleMembers` -> must NOT have cancelled `child-proc-a-1`!
  assert.equal(store.getMember('child-proc-a-1').status, 'running');
  assert.equal(fs.readFileSync(store.membersFile, 'utf8'), membersBeforeBytes);

  const snapMountedB = inspectSessionModeState(ctxB, rt, sid);
  assert.equal(snapMountedB.activeMembersCount, 1);
  assert.equal(snapMountedB.canSwitch, false);
  assert.throws(
    () => switchSessionExecutionMode(ctxB, rt, sid, 'single'),
    err => err?.code === 'MODE_SWITCH_BUSY',
  );

  // 3. Kill Process A (`childProc`) -> `ownerPid` is now dead (`ESRCH`)
  await killProcessAndWait(childProc);
  assert.equal(isProcessPidAlive(childProc.pid), false);

  // Read-only `inspectSessionModeState` STILL makes 0 disk writes while recognizing dead ownerPid as stale (`canSwitch: true`)!
  const snapAfterExit = inspectSessionModeState(ctxB, rt, sid);
  assert.equal(snapAfterExit.activeMembersCount, 0);
  assert.equal(snapAfterExit.canSwitch, true);
  assert.equal(fs.readFileSync(store.membersFile, 'utf8'), membersBeforeBytes, 'inspectSessionModeState must remain 0-write even after ownerPid exit');

  // Explicit `reconcileStaleMembers` on mounted host now marks the exited process's member as cancelled
  reconcileStaleMembers(rt, store);
  assert.equal(store.getMember('child-proc-a-1').status, 'cancelled');

  // 4. Legacy member record WITHOUT `ownerPid`: unmounted passive observer must NEVER cancel it
  const legacySid = 'sess-legacy-no-pid';
  const legacyStore = new TeamStore(storageRoot, legacySid);
  legacyStore.ensure({ workspace: ws, surface: 'desktop' });
  appendJsonl(legacyStore.membersFile, {
    v: 1,
    type: 'member',
    at: new Date().toISOString(),
    childId: 'legacy-running-1',
    name: 'legacy-worker',
    profile: 'code',
    taskSeq: 1,
  });
  legacyStore.setMemberStatus('legacy-running-1', 'running');
  const unmountedRt = {
    storageRoot,
    config: rt.config,
    actors: new Map(),
    stores: new Map(),
    liveProcessMemberIds: new Set(),
    hostAgents: new Map(),
  };
  reconcileStaleMembers(unmountedRt, legacyStore);
  assert.equal(legacyStore.getMember('legacy-running-1').status, 'running', 'Unmounted observer must not cancel legacy member without ownerPid');
  const legacySnap = inspectSessionModeState(createMockCtx({ dshHome }), unmountedRt, legacySid);
  assert.equal(legacySnap.activeMembersCount, 1);
  assert.equal(legacySnap.canSwitch, false);
});

test('R2-V223-03b: non-existent sessionId returns isLtSession=false, canSwitch=false, busyReason="Session does not exist" across runtime & HTTP API', async t => {
  const tmp = makeTempSandbox(t, 'r2-03b');
  const dshHome = path.join(tmp, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const ctx = createMockCtx({ dshHome });
  const missingSid = 'sess-nonexistent-ghost-404';

  // 1. Direct `inspectSessionModeState` & `switchSessionExecutionMode`
  const snap1 = inspectSessionModeState(ctx, rt, missingSid);
  assert.equal(snap1.isLtSession, false);
  assert.equal(snap1.canSwitch, false);
  assert.equal(snap1.busyReason, 'Session does not exist');

  const snapExplicitFalse = inspectSessionModeState(ctx, rt, missingSid, { sessionExists: false, agentPreset: 'leaderteam' });
  assert.equal(snapExplicitFalse.isLtSession, false);
  assert.equal(snapExplicitFalse.canSwitch, false);
  assert.equal(snapExplicitFalse.busyReason, 'Session does not exist');

  rt.surface = 'headless';
  const snapStandaloneHeadless = inspectSessionModeState(ctx, rt, missingSid, { standaloneLookup: true });
  assert.equal(snapStandaloneHeadless.isLtSession, false);
  assert.equal(snapStandaloneHeadless.canSwitch, false);
  assert.equal(snapStandaloneHeadless.busyReason, 'Session does not exist');
  rt.surface = 'desktop';

  assert.throws(
    () => switchSessionExecutionMode(ctx, rt, missingSid, 'single'),
    err => err?.code === 'MODE_NOT_LT_SESSION' && /Session does not exist/i.test(err.message),
  );

  // 2. Public API GET & POST `/api/lt/v1/workbench/mode`
  const handlers = createPublicContractHandlers(ctx, rt, { dshHome, configPath: cfgFile });
  const getGhost = await (await handlers.workbenchMode(
    new Request(`http://127.0.0.1/api/lt/v1/workbench/mode?sessionId=${missingSid}`, { method: 'GET' }),
  )).json();
  assert.equal(getGhost.ok, true);
  assert.equal(getGhost.data.modeState.isLtSession, false);
  assert.equal(getGhost.data.modeState.canSwitch, false);
  assert.equal(getGhost.data.modeState.busyReason, 'Session does not exist');

  const setGhostRes = await handlers.workbenchMode(new Request('http://127.0.0.1/api/lt/v1/workbench/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set', sessionId: missingSid, mode: 'single' }),
  }));
  assert.equal(setGhostRes.status, 400);
  const setGhostJson = await setGhostRes.json();
  assert.equal(setGhostJson.ok, false);
  assert.equal(setGhostJson.error.code, 'MODE_NOT_LT_SESSION');
  assert.equal(setGhostJson.error.details.modeState.isLtSession, false);
  assert.equal(fs.existsSync(path.join(storageRoot, 'session-modes')), false, 'Ghost session query/set must create 0 files');
});

test('R2-V223-05a: canonical ~ -> ~007E encoding keeps foo/bar and foo~002Fbar 100% isolated across TeamStore, runtime, plans, scheduler, observability, bugreport, and Hengzhang', async t => {
  const tmp = makeTempSandbox(t, 'r2-05a');
  const dshHome = path.join(tmp, 'dsh-home');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const ctx = createMockCtx({ dshHome });

  const sidSlash = 'foo/bar';
  const sidTilde = 'foo~002Fbar';

  // 1. Canonical segment parity with encodeSessionModeSegment in empty storage
  const segSlash = encodeTeamStoreId(sidSlash, storageRoot);
  const segTilde = encodeTeamStoreId(sidTilde, storageRoot);
  assert.equal(segSlash, 'foo~002Fbar');
  assert.equal(segTilde, 'foo~007E002Fbar');
  assert.equal(segSlash, encodeSessionModeSegment(sidSlash));
  assert.equal(segTilde, encodeSessionModeSegment(sidTilde));

  // 2. Creating TeamStore for 'foo/bar' does NOT make TeamStore.exists true for 'foo~002Fbar'!
  const storeSlash = teamStore(sidSlash);
  storeSlash.ensure({ workspace: ws, surface: 'desktop' });
  storeSlash.addMember({ childId: 'child-slash-1', name: 'worker-slash', profile: 'code', taskSeq: 1 });
  assert.equal(TeamStore.exists(storageRoot, sidSlash), true);
  assert.equal(TeamStore.exists(storageRoot, sidTilde), false, 'foo~002Fbar must NOT collide with foo/bar directory');

  // 3. Creating TeamStore for 'foo~002Fbar' in the SAME runtime gets a separate store & directory!
  const storeTilde = teamStore(sidTilde);
  assert.notEqual(storeTilde, storeSlash);
  assert.notEqual(storeTilde.dir, storeSlash.dir);
  storeTilde.ensure({ workspace: ws, surface: 'desktop' });
  storeTilde.addMember({ childId: 'child-tilde-1', name: 'worker-tilde', profile: 'readonly', taskSeq: 1 });

  assert.deepEqual([...storeSlash.members().keys()], ['child-slash-1']);
  assert.deepEqual([...storeTilde.members().keys()], ['child-tilde-1']);
  assert.equal(resolveTeamStoreLogicalId(storageRoot, 'foo~002Fbar'), 'foo/bar');
  assert.equal(resolveTeamStoreLogicalId(storageRoot, 'foo~007E002Fbar'), 'foo~002Fbar');

  // 4. Plans & concurrency files stay strictly separate
  writeCurrentPlan(storageRoot, sidSlash, 1, '# Plan SLASH\n');
  writeCurrentPlan(storageRoot, sidTilde, 1, '# Plan TILDE\n');
  assert.equal(readCurrentPlan(storageRoot, sidSlash, 1)?.content, '# Plan SLASH\n');
  assert.equal(readCurrentPlan(storageRoot, sidTilde, 1)?.content, '# Plan TILDE\n');
  assert.notEqual(currentPlanFile(storageRoot, sidSlash, 1), currentPlanFile(storageRoot, sidTilde, 1));

  writeTeamConcurrencyFile(storageRoot, sidSlash, { maxActiveMembers: 3, lastChatDirectiveIndex: 1 });
  writeTeamConcurrencyFile(storageRoot, sidTilde, { maxActiveMembers: 6, lastChatDirectiveIndex: 2 });
  assert.equal(readTeamConcurrencyFile(storageRoot, sidSlash)?.maxActiveMembers, 3);
  assert.equal(readTeamConcurrencyFile(storageRoot, sidTilde)?.maxActiveMembers, 6);
  assert.equal(resetAllTeamChatOverridesOnDisk(storageRoot), 2);
  assert.equal(readTeamConcurrencyFile(storageRoot, sidSlash)?.maxActiveMembers, null);
  assert.equal(readTeamConcurrencyFile(storageRoot, sidTilde)?.maxActiveMembers, null);

  // 5. Durable sessions, observability, lt-bugreport, and Hengzhang bridge
  writeZstdSession(path.join(dshHome, 'sessions', encodeDshSegment(sidSlash)), [
    { type: 'session', version: 4, id: sidSlash, createdAt: 1000, cwd: ws, agentPreset: 'leaderteam' },
    {
      type: 'assistant/message',
      time: 1100,
      seq: 1,
      data: {
        message: { id: 'm-slash', source: { provider: 'magpie', model: 'codex/gpt-6.1-sol' } },
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      },
    },
  ]);
  writeZstdSession(path.join(dshHome, 'sessions', encodeDshSegment(sidTilde)), [
    { type: 'session', version: 4, id: sidTilde, createdAt: 2000, cwd: ws, agentPreset: 'leaderteam' },
    {
      type: 'assistant/message',
      time: 2100,
      seq: 1,
      data: {
        message: { id: 'm-tilde', source: { provider: 'magpie', model: 'codex/gpt-6.1-sol' } },
        usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
      },
    },
  ]);

  const obs = recentTeamObservability(ctx, rt, 10);
  const obsSlash = obs.find(o => o.teamId === sidSlash);
  const obsTilde = obs.find(o => o.teamId === sidTilde);
  assert.ok(obsSlash, 'recentTeamObservability must include logical foo/bar');
  assert.ok(obsTilde, 'recentTeamObservability must include logical foo~002Fbar');
  assert.equal(obsSlash.members[0].id, 'child-slash-1');
  assert.equal(obsTilde.members[0].id, 'child-tilde-1');
  assert.equal(obsSlash.usage.groups.leader.tokens.totalTokens, 120);
  assert.equal(obsTilde.usage.groups.leader.tokens.totalTokens, 250);

  const bugSlash = generateRedactedBugReport({ dshHome, storageRoot, teamId: sidSlash, hostname: 'h', username: 'u' });
  const bugTilde = generateRedactedBugReport({ dshHome, storageRoot, teamId: sidTilde, hostname: 'h', username: 'u' });
  assert.equal(bugSlash.metrics.teamFound, true);
  assert.equal(bugTilde.metrics.teamFound, true);

  const bridge = new HengzhangUsageBridge({ storageRoot, dshHome });
  const repSlash = await bridge.getSessionReport({ sessionId: sidSlash, syncGateway: false });
  const repTilde = await bridge.getSessionReport({ sessionId: sidTilde, syncGateway: false });
  assert.equal(repSlash.report.totals.totalTokens, 120);
  assert.equal(repSlash.report.team.teamId, sidSlash);
  assert.equal(repTilde.report.totals.totalTokens, 250);
  assert.equal(repTilde.report.team.teamId, sidTilde);
});

test('R2-V223-06: writeSessionModeRecord appends audit history BEFORE updating stateFile and rolls back history if stateFile write fails', t => {
  const tmp = makeTempSandbox(t, 'r2-06');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);
  const sid = 'sess-eacces-atomic';
  const presetMap = new Map([[sid, 'leaderteam']]);
  const sessionsMap = new Map();
  const agentsMap = new Map();
  const ctx = createMockCtx({ presetMap, sessionsMap, agentsMap });

  // Seed initial Single mode before mounting leader
  writeSessionModeRecord(storageRoot, sid, 'single', { initial: true, source: 'create', taskSeqHint: 1 });
  const leaderAgent = {
    id: sid,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: { systemPrompt: createFakePromptRegistry().systemPrompt, get: k => ctx.get(k) },
    session: { id: sid, header: { id: sid, cwd: ws, agentPreset: 'leaderteam' }, snapshotEvents: () => [] },
  };
  sessionsMap.set(sid, leaderAgent.session);
  agentsMap.set(sid, leaderAgent);
  rt.hostAgents.set(sid, leaderAgent);
  onAgentCreated(ctx, { agent: leaderAgent });
  assert.equal(rt.actors.get(sid).executionMode, 'single');

  const { stateFile, historyFile } = resolveSessionModePaths(storageRoot, sid, { ensureDir: false });
  assert.equal(readSessionModeHistory(storageRoot, sid).length, 1);

  // 1. Make historyFile read-only (0o444) -> EACCES on Single -> Team switch!
  fs.chmodSync(historyFile, 0o444);
  t.after(() => {
    try { fs.chmodSync(historyFile, 0o644); } catch {}
  });

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    assert.throws(
      () => switchSessionExecutionMode(ctx, rt, sid, 'team', { source: 'ui-toggle' }),
      err => err?.code === 'EACCES' || err?.code === 'EPERM',
    );

    // State file, memory cache, and live actor MUST still be in 'single' mode with switchCount=0!
    const afterFailRec = readSessionModeRecord(storageRoot, sid);
    assert.equal(afterFailRec.mode, 'single', 'stateFile must remain untouched when historyFile append fails');
    assert.equal(afterFailRec.switchCount, 0);
    assert.equal(getSessionExecutionMode(rt, sid), 'single');
    assert.equal(rt.actors.get(sid).executionMode, 'single');
    assert.equal(TeamStore.exists(storageRoot, sid), false, 'Failed Single->Team switch must not initialize TeamStore');

    // Restore permissions and retry -> succeeds with changed: true, switchCount: 1, and writes single -> team audit entry!
    fs.chmodSync(historyFile, 0o644);
    const retried = switchSessionExecutionMode(ctx, rt, sid, 'team', { source: 'ui-toggle-retry' });
    assert.equal(retried.changed, true);
    assert.equal(retried.previousMode, 'single');
    assert.equal(retried.modeState.mode, 'team');
    assert.equal(retried.modeState.switchCount, 1);
    assert.equal(rt.actors.get(sid).executionMode, 'team');

    const hist = readSessionModeHistory(storageRoot, sid);
    assert.equal(hist.length, 2);
    assert.equal(hist[0].fromMode, null);
    assert.equal(hist[0].toMode, 'single');
    assert.equal(hist[1].fromMode, 'single');
    assert.equal(hist[1].toMode, 'team');
  } else {
    // On Windows (where chmod 0o444 may or may not block appendFileSync depending on ACLs), deterministically fail appendFileSync first
    fs.chmodSync(historyFile, 0o644);
    const origAppend = fs.appendFileSync;
    fs.appendFileSync = (targetPath, ...rest) => {
      if (path.resolve(String(targetPath)) === path.resolve(historyFile)) {
        const err = new Error('Simulated EACCES on historyFile append');
        err.code = 'EACCES';
        throw err;
      }
      return origAppend(targetPath, ...rest);
    };
    try {
      assert.throws(
        () => switchSessionExecutionMode(ctx, rt, sid, 'team', { source: 'ui-toggle' }),
        err => err?.code === 'EACCES' || err?.code === 'EPERM',
      );
    } finally {
      fs.appendFileSync = origAppend;
    }
    const afterFailRec = readSessionModeRecord(storageRoot, sid);
    assert.equal(afterFailRec.mode, 'single', 'stateFile must remain untouched when historyFile append fails');
    assert.equal(afterFailRec.switchCount, 0);

    const retried = switchSessionExecutionMode(ctx, rt, sid, 'team', { source: 'ui-toggle-retry' });
    assert.equal(retried.changed, true);
    assert.equal(retried.modeState.mode, 'team');
    assert.equal(retried.modeState.switchCount, 1);
  }

  // 2. Rollback verification: if `writeFileAtomic(stateFile)` fails AFTER `appendJsonl(historyFile)` succeeded,
  //    `historyFile` is truncated back to `prevHistSize`!
  const histBytesBefore = fs.readFileSync(historyFile, 'utf8');
  const origRenameSync = fs.renameSync;
  fs.renameSync = (oldPath, newPath) => {
    if (String(newPath) === stateFile) {
      const err = new Error('Simulated atomic rename failure');
      err.code = 'EIO';
      throw err;
    }
    return origRenameSync(oldPath, newPath);
  };
  try {
    assert.throws(
      () => writeSessionModeRecord(storageRoot, sid, 'single', { source: 'rollback-test' }),
      err => err?.code === 'EIO',
    );
  } finally {
    fs.renameSync = origRenameSync;
    // Clean up any leftover .tmp file from the simulated rename failure
    for (const f of fs.readdirSync(path.dirname(stateFile))) {
      if (f.endsWith('.tmp')) fs.rmSync(path.join(path.dirname(stateFile), f), { force: true });
    }
  }
  assert.equal(fs.readFileSync(historyFile, 'utf8'), histBytesBefore, 'historyFile must roll back cleanly if stateFile atomic rename fails');
  assert.equal(readSessionModeRecord(storageRoot, sid).mode, 'team');
});

test('R2-V223-07b & Forward-Merged R2-SH-01..04: zero duplicate single->single audit entries on persistInitial, v2.2.3 manifest versions, and standalone Single session discovery with usage disabled', async t => {
  // 1. Package versions align at 1.0.0 (Open Leader Team V1.0.0; lt-shared-contracts schema supports 1.1.0)
  for (const rel of ['package.json', 'leaderteam/package.json', 'packages/lt-web/package.json']) {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
    assert.equal(pkgJson.version, '1.0.0', `${rel} must align at 1.0.0`);
  }
  const { SHARED_CONTRACTS_ROOT } = await import('./companion-paths.mjs');
  const schemaText = fs.readFileSync(path.join(SHARED_CONTRACTS_ROOT, 'schemas/lt-public-v1.schema.json'), 'utf8');
  assert.match(schemaText, /"1\.1\.0"/);

  const tmp = makeTempSandbox(t, 'r2-07b');
  const dshHome = path.join(tmp, 'dsh-home');
  const ws = path.join(tmp, 'ws');
  const storageRoot = path.join(dshHome, 'leaderteam');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.mkdirSync(storageRoot, { recursive: true });

  const cfgRaw = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config/leaderteam.config.json'), 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  const cfgFile = path.join(tmp, 'leaderteam.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2));

  const rt = resetRuntimeForTest(storageRoot, cfgFile);

  // 2. Calling `switchSessionExecutionMode` with `persistInitial: true` twice on pre-seeded Single session writes ONLY 1 history record
  const preSeededSid = 'session-preseeded-single-1';
  switchSessionExecutionMode(null, rt, preSeededSid, 'single', {
    persistInitial: true,
    isLtSession: true,
    agentPreset: 'leaderteam',
    source: 'workbench-create',
  });
  switchSessionExecutionMode(null, rt, preSeededSid, 'single', {
    persistInitial: true,
    isLtSession: true,
    agentPreset: 'leaderteam',
    source: 'workbench-create',
  });
  const preHist = readSessionModeHistory(storageRoot, preSeededSid);
  assert.equal(preHist.length, 1, 'persistInitial on an already pre-seeded session must NOT write a duplicate single->single audit record');
  assert.equal(preHist[0].fromMode, null);
  assert.equal(preHist[0].toMode, 'single');

  // Also verify via `workbenchCreate({ cwd: ws, executionMode: 'single' })` when host honors the pre-minted sessionId
  const liveCtx = {
    sessionController: {
      async create(opts) {
        return { sessionId: opts.sessionId ?? 'session-auto-1', cwd: opts.cwd, agentPreset: opts.agentPreset ?? 'leaderteam' };
      },
      async list() {
        return { items: [] };
      },
    },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };
  const liveHandlers = createPublicContractHandlers(liveCtx, rt, { dshHome, configPath: cfgFile });
  const createRes = await (await liveHandlers.workbenchCreate(new Request('http://127.0.0.1/api/lt/v1/workbench/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: ws, executionMode: 'single' }),
  }))).json();
  assert.equal(createRes.ok, true);
  const createdSid = createRes.data.sessionId;
  const createdHist = readSessionModeHistory(storageRoot, createdSid);
  assert.equal(createdHist.length, 1, 'workbenchCreate in Single mode must emit exactly 1 initial audit entry');
  assert.equal(createdHist[0].fromMode, null);
  assert.equal(createdHist[0].toMode, 'single');

  // 3. Standalone `workbenchSessions` with Hengzhang usage disabled still lists pure Single sessions (`session-modes/*.json`)
  const standaloneHandlers = createPublicContractHandlers({ get: () => null }, { plugins: {}, actors: new Map(), stores: new Map() }, { dshHome, configPath: cfgFile });
  await standaloneHandlers.usageToggle(new Request('http://127.0.0.1/api/lt/v1/usage/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  }));
  const wbStandalone = await (await standaloneHandlers.workbenchSessions(new Request('http://127.0.0.1/api/lt/v1/workbench/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }))).json();
  assert.equal(wbStandalone.ok, true);
  assert.equal(wbStandalone.data.liveHost, false);
  const singleRow = wbStandalone.data.sessions.find(s => s.sessionId === createdSid);
  assert.ok(singleRow, 'Blank pure Single session must appear in standalone workbench/sessions even when Hengzhang is disabled');
  assert.equal(singleRow.executionMode, 'single');
  assert.equal(singleRow.isLtSession, true);
  assert.equal(singleRow.isTeam, false);
});
