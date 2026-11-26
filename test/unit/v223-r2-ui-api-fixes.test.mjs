import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../leaderteam/core/config.mjs';
import { TeamStore, encodeTeamStoreId, appendJsonl } from '../../leaderteam/core/store.mjs';
import {
  readSessionModeRecord,
  writeSessionModeRecord,
  readSessionModeHistory,
} from '../../leaderteam/core/session-mode.mjs';
import { runtime, bindRuntimeConfigFile } from '../../leaderteam/host/runtime.mjs';
import {
  createPublicContractHandlers,
  readAllControllerSessionEvents,
  resolveHostSessionModeHints,
  collectKnownSessionModeItems,
} from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import {
  createPanelHandlers,
  buildPanelStateSnapshot,
} from '../../leaderteam/plugins/leaderteam-panel/panel-api.mjs';
import { encodeDshSegment } from '../../packages/lt-usage/index.mjs';
import { startStandaloneLtUiServer } from '../../bin/lt-ui.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-r2-ui:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-r2-ui:@deepseek-ai/dsh-llm') {
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

const { onAgentCreated } = await import('../../leaderteam/host/roles.mjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function makeTempSandbox(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-r2-ui-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeJsonPost(body = {}, url = 'http://127.0.0.1/api/lt/v1/workbench/mode') {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function writeZstdSession(sessionDir, rows) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const frames = rows.map(r => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8')));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
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
  const cfgRaw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfgRaw.storage = { root: storageRoot };
  fs.writeFileSync(cfgFile, JSON.stringify(cfgRaw, null, 2) + '\n');
  const cfg = loadConfig(cfgFile, { includeLocal: false });

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
    hostAgents: new Map(),
    teamRuntimes: new Map(),
    sessionModesCache: new Map(),
    executionReviewJobs: new Map(),
    governanceJobs: new Map(),
    stopReviewPending: new Set(),
    directiveVerifyPending: new Set(),
    inFlightGateReviews: new Map(),
    inFlightShellCallsBySession: new Map(),
    workbenchCreatedSessionIds: new Set(),
  };
  bindRuntimeConfigFile(rt, cfgFile, cfg);
  return { dshHome, storageRoot, cfgFile, rt };
}

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

/**
 * Build a faithful DSH 0.2.2-rc.5 `sessionController.events` paginating simulator (`DEFAULT_MAX_MESSAGES = 50`).
 * Supports `beforeSeq`, `throughSeq`, and `maxMessages` (optionally capping page size to `hardPageCap` so multi-page
 * backward pagination is exercised even when caller requests `maxMessages: 500`).
 */
function buildPaginatingEventsController(sessionsBySid, { defaultMaxMessages = 50, hardPageCap = 50 } = {}) {
  const calls = [];
  return {
    calls,
    async events(req) {
      calls.push(structuredClone(req));
      const sid = req?.address?.sessionId ?? req?.sessionId;
      const allRecords = sessionsBySid.get(sid);
      if (!allRecords) {
        const err = new Error(`Session not found: ${sid}`);
        err.code = 'session/not-found';
        throw err;
      }
      const cursor = allRecords.length - 1;
      const effectiveCut = Number.isSafeInteger(req?.throughSeq) ? Math.min(cursor, req.throughSeq) : cursor;
      const upperExclusive = Number.isSafeInteger(req?.beforeSeq)
        ? Math.min(effectiveCut + 1, req.beforeSeq)
        : effectiveCut + 1;
      const requestedMax = Number.isSafeInteger(req?.maxMessages) && req.maxMessages > 0
        ? req.maxMessages
        : defaultMaxMessages;
      const msgLimit = Math.min(requestedMax, hardPageCap);

      // Walk backwards from `upperExclusive - 1` until `msgLimit` message events are collected (matching DSH history.js)
      let msgCount = 0;
      let startIdx = upperExclusive;
      for (let i = upperExclusive - 1; i >= 0; i--) {
        const ev = allRecords[i]?.event ?? allRecords[i];
        startIdx = i;
        if (ev?.type === 'user/message' || ev?.type === 'assistant/message') {
          msgCount += 1;
          if (msgCount >= msgLimit) {
            // Also include seq 0 if we're at index 1 and index 0 is non-message header? In DSH, if startIdx > 0, hasMore is true!
            break;
          }
        }
      }
      const records = allRecords.slice(startIdx, upperExclusive);
      const hasMore = startIdx > 0;
      return {
        cursor: effectiveCut,
        records,
        hasMore,
      };
    },
  };
}

function buildColdSessionWireAndDurableRows(sid, cwd, messageCount, { preset = 'leaderteam', origin = undefined } = {}) {
  const wireRecords = [];
  const durableRows = [
    {
      type: 'session',
      version: 4,
      id: sid,
      cwd,
      agentPreset: preset,
      ...(origin ? { origin } : {}),
      createdAt: 1000,
    },
  ];
  wireRecords.push({
    type: 'event',
    event: {
      seq: 0,
      type: 'session/header',
      time: 1000,
      data: {
        id: sid,
        cwd,
        agentPreset: preset,
        ...(origin ? { origin } : {}),
      },
    },
  });

  let seq = 1;
  for (let m = 1; m <= messageCount; m++) {
    const label = `MSG_${String(m).padStart(2, '0')}`;
    const isUser = m % 2 === 1;
    if (isUser) {
      const uEv = {
        seq,
        type: 'user/message',
        time: 1000 + seq * 10,
        data: {
          message: {
            id: `u-${sid}-${m}`,
            source: { kind: 'user' },
            content: [{ type: 'text', text: label }],
          },
        },
      };
      wireRecords.push({ type: 'event', event: uEv });
      durableRows.push(uEv);
      seq += 1;

      const tsEv = { seq, type: 'turn/start', time: 1000 + seq * 10, data: { turn: Math.ceil(m / 2) } };
      wireRecords.push({ type: 'event', event: tsEv });
      durableRows.push(tsEv);
      seq += 1;
    } else {
      const aEv = {
        seq,
        type: 'assistant/message',
        time: 1000 + seq * 10,
        data: {
          message: {
            id: `a-${sid}-${m}`,
            source: { kind: 'model', provider: 'magpie', model: 'codex/gpt-6.1-sol' },
            content: [{ type: 'text', text: label }],
          },
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        },
      };
      wireRecords.push({ type: 'event', event: aEv });
      durableRows.push(aEv);
      seq += 1;

      const teEv = { seq, type: 'turn/end', time: 1000 + seq * 10, data: { turn: m / 2 } };
      wireRecords.push({ type: 'event', event: teEv });
      durableRows.push(teEv);
      seq += 1;
    }
  }
  return { wireRecords, durableRows };
}

test('R2-V223-02: Cold-resumed 62-message session paginates backward completely (messages 1..62 in chronological order) and preserves seq:0 session/header preset & origin', async t => {
  const tmpDir = makeTempSandbox(t, '02-pagination');
  const { dshHome, cfgFile, rt } = createIsolatedRuntime(tmpDir);
  const ws = path.join(tmpDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });

  const sid62 = 'sess-cold-62-messages';
  const sidSub62 = 'sess-cold-62-subagent';
  const { wireRecords: wire62, durableRows: durable62 } = buildColdSessionWireAndDurableRows(sid62, ws, 62, {
    preset: 'leaderteam',
  });
  const { wireRecords: wireSub62, durableRows: durableSub62 } = buildColdSessionWireAndDurableRows(sidSub62, ws, 62, {
    preset: 'leaderteam',
    origin: 'subagent',
  });
  writeZstdSession(path.join(dshHome, 'sessions', sid62), durable62);
  writeZstdSession(path.join(dshHome, 'sessions', sidSub62), durableSub62);

  const sessionsMap = new Map([
    [sid62, wire62],
    [sidSub62, wireSub62],
  ]);
  // Force 50-message page cap so 62 messages require 2+ pages (latest 50 messages = 13..62, older page = 1..12 + seq:0)
  const pager = buildPaginatingEventsController(sessionsMap, { defaultMaxMessages: 50, hardPageCap: 50 });

  const coldCtx = {
    sessionController: {
      events: req => pager.events(req),
      async state() {
        return { active: false, running: false };
      },
      async list() {
        // Simulate cold unhydrated list where projections are empty
        return {
          items: [
            { sessionId: sid62, cwd: ws, updatedAt: 5000, running: false, blank: false, projections: { values: {} } },
          ],
        };
      },
    },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };

  await withTestRuntime(rt, async () => {
    // 1. Direct helper check: `readAllControllerSessionEvents` fetches all pages in exact 0..cursor order
    const ac = new AbortController();
    const allRows = await readAllControllerSessionEvents(coldCtx.sessionController, sid62, ac.signal, { dshHome });
    assert.equal(allRows.length, wire62.length, 'Must fetch every event from seq 0 through cursor');
    assert.ok(pager.calls.length >= 2, '62 messages under 50-message page cap must execute backward pagination');
    assert.equal(pager.calls[0].maxMessages, 500);
    assert.ok(Number.isSafeInteger(pager.calls[1].beforeSeq) && pager.calls[1].beforeSeq > 0);
    assert.equal(pager.calls[1].throughSeq, wire62.length - 1);
    for (let i = 0; i < wire62.length; i++) {
      assert.equal(allRows[i].event.seq, i, `Event at index ${i} must have chronological seq ${i}`);
    }

    // 2. `workbenchTranscript` returns all 62 messages (`MSG_01` .. `MSG_62`), never dropping earliest 12 (`MSG_01..MSG_12`)!
    const h = createPublicContractHandlers(coldCtx, rt, { dshHome, configPath: cfgFile });
    const txRes = await (await h.workbenchTranscript(makeJsonPost({ sessionId: sid62 }))).json();
    assert.equal(txRes.ok, true);
    assert.equal(txRes.data.messages.length, 62, 'All 62 messages must be returned');
    assert.equal(txRes.data.messages[0].text, 'MSG_01', 'Earliest message MSG_01 must be preserved');
    assert.equal(txRes.data.messages[11].text, 'MSG_12', '12th message MSG_12 must be preserved');
    assert.equal(txRes.data.messages[61].text, 'MSG_62', 'Latest message MSG_62 must be last');
    for (let i = 0; i < 62; i++) {
      assert.equal(txRes.data.messages[i].text, `MSG_${String(i + 1).padStart(2, '0')}`);
    }
    assert.equal(txRes.data.modeState.isLtSession, true);

    // 3. `resolveHostSessionModeHints` / `workbenchMode` preserves seq:0 `session/header` (`agentPreset` & `origin: 'subagent'`)
    // even when `dshHome` is unavailable (pure controller pagination) AND when `projections` is provided!
    const noDiskCtx = {
      sessionController: {
        events: req => pager.events(req),
        async state() {
          return { active: false, running: false };
        },
      },
      get(k) {
        return this[k] ?? null;
      },
    };
    const hints62 = await resolveHostSessionModeHints(noDiskCtx, rt, sid62, path.join(tmpDir, 'empty-home'));
    assert.equal(hints62.agentPreset, 'leaderteam');
    assert.equal(hints62.sessionExists, true);

    const hintsSub62 = await resolveHostSessionModeHints(noDiskCtx, rt, sidSub62, path.join(tmpDir, 'empty-home'));
    assert.equal(hintsSub62.origin, 'subagent');
    const subModeRes = await (await h.workbenchMode(
      new Request(`http://127.0.0.1/api/lt/v1/workbench/mode?sessionId=${sidSub62}`, { method: 'GET' }),
    )).json();
    assert.equal(subModeRes.ok, true);
    assert.equal(subModeRes.data.modeState.isLtSession, false, '>50-msg cold subagent session must retain subagent origin');

    // Also verify `sessionController.projections` fast path for >50-msg cold native session
    const projCtx = {
      sessionController: {
        async projections({ sessionId }) {
          if (sessionId === 'sess-proj-native') return { cursor: 140, values: { agentPreset: 'coder' } };
          return { values: {} };
        },
        async state() {
          return { active: false, running: false };
        },
      },
      get(k) {
        return this[k] ?? null;
      },
    };
    const projH = createPublicContractHandlers(projCtx, rt, { dshHome, configPath: cfgFile });
    const projMode = await (await projH.workbenchMode(
      new Request('http://127.0.0.1/api/lt/v1/workbench/mode?sessionId=sess-proj-native', { method: 'GET' }),
    )).json();
    assert.equal(projMode.data.modeState.isLtSession, false);
    assert.match(projMode.data.modeState.busyReason ?? '', /coder/);

    // 4. Mid-pagination failure / missing `beforeSeq` falls back cleanly to `findDurableSessionRows(dshHome, sessionId)`!
    const brokenPagerCtx = {
      sessionController: {
        async events(req) {
          if (req?.beforeSeq !== undefined) {
            throw new Error('Transient mid-pagination controller error');
          }
          return {
            cursor: wire62.length - 1,
            records: wire62.slice(-40),
            hasMore: true,
          };
        },
        async state() {
          return { active: false, running: false };
        },
      },
      get(k) {
        if (k === 'profileContext') return { home: dshHome };
        return this[k] ?? null;
      },
    };
    const brokenH = createPublicContractHandlers(brokenPagerCtx, rt, { dshHome, configPath: cfgFile });
    const fallbackTx = await (await brokenH.workbenchTranscript(makeJsonPost({ sessionId: sid62 }))).json();
    assert.equal(fallbackTx.ok, true);
    assert.equal(fallbackTx.data.messages.length, 62, 'Mid-pagination failure must fall back to durable zstd rows (all 62 messages)');
    assert.equal(fallbackTx.data.messages[0].text, 'MSG_01');
  });
});

test('R2-V223-03a: Standalone lt-ui & panel-api detect open turn on disk (turn/start without turn/end) and reject non-existent sessionId across all endpoints', async t => {
  const tmpDir = makeTempSandbox(t, '03a-open-turn');
  const { dshHome, storageRoot, cfgFile, rt } = createIsolatedRuntime(tmpDir);
  const ws = path.join(tmpDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });

  const openSid = 'sess-open-turn-on-disk';
  const openRows = [
    { type: 'session', version: 4, id: openSid, cwd: ws, agentPreset: 'leaderteam', createdAt: 2000 },
    {
      seq: 1,
      type: 'user/message',
      time: 2010,
      data: { message: { id: 'u-open-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Run long build' }] } },
    },
    { seq: 2, type: 'turn/start', time: 2020, data: { turn: 1 } },
  ];
  writeZstdSession(path.join(dshHome, 'sessions', openSid), openRows);

  // Also test when `liveSession` already supplies `agentPreset` while `!sessionController`: must STILL inspect durableRows for openTurn!
  const standaloneWithSessionHeaderCtx = {
    sessions: new Map([[openSid, { id: openSid, header: { id: openSid, cwd: ws, agentPreset: 'leaderteam' } }]]),
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };
  const hintsWithHeader = await resolveHostSessionModeHints(standaloneWithSessionHeaderCtx, rt, openSid, dshHome);
  assert.equal(hintsWithHeader.passiveRunning, true, 'Must detect openTurn on disk even when agentPreset was already known');
  assert.equal(hintsWithHeader.sessionExists, true);

  // Pure standalone (`!sessionController`) via HTTP `lt-ui` server AND `panel-api.mjs`
  const prevDshHome = process.env.DSH_HOME;
  const uiSrv = await startStandaloneLtUiServer({ port: 0, dshHome, configPath: cfgFile, requireAuth: false });
  t.after(async () => {
    await uiSrv.close();
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  });

  // 1a. Standalone GET /workbench/mode?sessionId=openSid -> activeTurn: true, canSwitch: false
  const getOpenMode = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode?sessionId=${openSid}`)).json();
  assert.equal(getOpenMode.ok, true);
  assert.equal(getOpenMode.data.modeState.isLtSession, true);
  assert.equal(getOpenMode.data.modeState.activeTurn, true);
  assert.equal(getOpenMode.data.modeState.canSwitch, false);
  assert.match(getOpenMode.data.modeState.busyReason ?? '', /executing/i);

  // 1b. Standalone POST /workbench/mode set -> 409 MODE_SWITCH_BUSY
  const setOpenRes = await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set', sessionId: openSid, mode: 'single' }),
  });
  assert.equal(setOpenRes.status, 409);
  const setOpenJson = await setOpenRes.json();
  assert.equal(setOpenJson.error.code, 'MODE_SWITCH_BUSY');
  assert.equal(setOpenJson.error.details.modeState.activeTurn, true);

  // 1c. Standalone POST /workbench/transcript -> synthesizes running `passiveState` AND `modeState.activeTurn === true`
  const txOpenJson = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: openSid }),
  })).json();
  assert.equal(txOpenJson.ok, true);
  assert.equal(txOpenJson.data.passiveState?.running, true);
  assert.equal(txOpenJson.data.modeState.activeTurn, true);
  assert.equal(txOpenJson.data.modeState.canSwitch, false);

  // 1d. Standalone /workbench/sessions & /workbench/mode?action=list & panel-api session-mode all report canSwitchMode: false
  const wbSessions = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).json();
  const openSessItem = wbSessions.data.sessions.find(s => s.sessionId === openSid);
  assert.ok(openSessItem);
  assert.equal(openSessItem.canSwitchMode, false);
  assert.equal(openSessItem.modeState.activeTurn, true);

  const listModesJson = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode?action=list`)).json();
  const listOpenItem = listModesJson.data.sessions.find(s => s.sessionId === openSid);
  assert.ok(listOpenItem);
  assert.equal(listOpenItem.canSwitchMode, false);
  assert.equal(listOpenItem.modeState.activeTurn, true);

  const standaloneCtx = { get: k => (k === 'profileContext' ? { home: dshHome } : null) };
  const panelHandlers = createPanelHandlers(standaloneCtx, rt, { dshHome });
  const panelGetOpen = await (await panelHandlers.sessionMode(makeJsonPost({ action: 'get', sessionId: openSid }))).json();
  assert.equal(panelGetOpen.ok, true);
  assert.equal(panelGetOpen.value.modeState.activeTurn, true);
  assert.equal(panelGetOpen.value.modeState.canSwitch, false);

  const panelSetOpenRes = await panelHandlers.sessionMode(makeJsonPost({ action: 'set', sessionId: openSid, mode: 'single' }));
  assert.equal(panelSetOpenRes.status, 409);

  // 1e. Append `turn/end` on disk -> session becomes idle (`canSwitch: true`) and switches cleanly!
  writeZstdSession(path.join(dshHome, 'sessions', openSid), [
    ...openRows,
    { seq: 3, type: 'turn/end', time: 2090, data: { turn: 1 } },
  ]);
  const getClosedMode = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode?sessionId=${openSid}`)).json();
  assert.equal(getClosedMode.data.modeState.activeTurn, false);
  assert.equal(getClosedMode.data.modeState.canSwitch, true);

  // 2. Non-existent `sessionId = 'does-not-exist'` across standalone `lt-ui`, live host `sessionController`, `workbenchTranscript`, and `panel-api`
  const missingSid = 'does-not-exist';
  const getMissingUi = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/mode?sessionId=${missingSid}`)).json();
  assert.equal(getMissingUi.ok, true);
  assert.equal(getMissingUi.data.modeState.isLtSession, false);
  assert.equal(getMissingUi.data.modeState.canSwitch, false);
  assert.equal(getMissingUi.data.modeState.busyReason, 'Session does not exist');

  const txMissingUi = await (await fetch(`${uiSrv.baseUrl}/api/lt/v1/workbench/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: missingSid }),
  })).json();
  assert.equal(txMissingUi.ok, true);
  assert.equal(txMissingUi.data.modeState.isLtSession, false);
  assert.equal(txMissingUi.data.modeState.canSwitch, false);
  assert.equal(txMissingUi.data.modeState.busyReason, 'Session does not exist');

  // Even when live DSH `sessionController.state({ sessionId })` returns `{ active: false, running: false }` without throwing!
  const liveHostCtx = {
    sessionController: {
      async state() {
        return { active: false, running: false };
      },
      async list() {
        return { items: [] };
      },
      async events() {
        const err = new Error('not found');
        err.code = 'session/not-found';
        throw err;
      },
    },
    get(k) {
      if (k === 'profileContext') return { home: dshHome };
      return this[k] ?? null;
    },
  };
  const liveH = createPublicContractHandlers(liveHostCtx, rt, { dshHome, configPath: cfgFile });
  const getMissingLive = await (await liveH.workbenchMode(
    new Request(`http://127.0.0.1/api/lt/v1/workbench/mode?sessionId=${missingSid}`, { method: 'GET' }),
  )).json();
  assert.equal(getMissingLive.data.modeState.isLtSession, false);
  assert.equal(getMissingLive.data.modeState.canSwitch, false);
  assert.equal(getMissingLive.data.modeState.busyReason, 'Session does not exist');

  const livePanelH = createPanelHandlers(liveHostCtx, rt, { dshHome });
  const panelGetMissing = await (await livePanelH.sessionMode(makeJsonPost({ action: 'get', sessionId: missingSid }))).json();
  assert.equal(panelGetMissing.ok, true);
  assert.equal(panelGetMissing.value.modeState.isLtSession, false);
  assert.equal(panelGetMissing.value.modeState.canSwitch, false);
  assert.equal(panelGetMissing.value.modeState.busyReason, 'Session does not exist');

  const panelSetMissingRes = await livePanelH.sessionMode(makeJsonPost({
    action: 'set',
    sessionId: missingSid,
    mode: 'single',
  }));
  assert.equal(panelSetMissingRes.status, 400);
  const panelSetMissingJson = await panelSetMissingRes.json();
  assert.equal(panelSetMissingJson.ok, false);
  assert.equal(panelSetMissingJson.error.code, 'MODE_NOT_LT_SESSION');
  assert.equal(fs.existsSync(path.join(storageRoot, 'session-modes', `${missingSid}.json`)), false);
});

test('R2-V223-04: workbenchCreate without body.model sets leader model ONLY on the created LT session Agent and leaves DSH global default model 100% untouched', async t => {
  const tmpDir = makeTempSandbox(t, '04-default-model');
  const { dshHome, cfgFile, rt } = createIsolatedRuntime(tmpDir);
  const ws = path.join(tmpDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });

  // Faithful DSH 0.2.2-rc.5 `agentDefaultModel` + `sessionController.selectModel` side-effect trap
  let globalDefaultModel = { provider: 'native', model: 'user-default', reasoningEffort: 'low' };
  let saveSelectionCount = 0;
  let controllerSelectModelCount = 0;
  let settingsMutationCount = 0;
  const resolvedCallConfigs = [];
  const hostAgents = new Map();
  const hostSessions = new Map();

  const dshCtx = {
    agents: hostAgents,
    sessions: hostSessions,
    agentDefaultModel: {
      current() {
        return structuredClone(globalDefaultModel);
      },
      saveSelection(sel) {
        saveSelectionCount += 1;
        globalDefaultModel = structuredClone(sel);
      },
    },
    llm: {
      async resolveCallConfig(sel) {
        resolvedCallConfigs.push(structuredClone(sel));
        return sel;
      },
    },
    settings: {
      describe() {
        return [{ ns: 'agent-default-model', value: structuredClone(globalDefaultModel) }];
      },
      async update() {
        settingsMutationCount += 1;
      },
    },
    agentPresets: {
      defaultId: 'standard',
      async resolve(id) {
        return { id };
      },
      presetForSession(sess) {
        return sess?.header?.agentPreset ?? 'standard';
      },
    },
    sessionController: {
      async create(req) {
        const sid = req.sessionId || `sess-${hostAgents.size + 1}`;
        const preset = req.agentPreset || 'standard';
        let recorded = null;
        const selectCalls = [];
        const sessionObj = {
          id: sid,
          header: { id: sid, cwd: req.cwd || ws, agentPreset: preset },
          snapshotEvents: () => [],
        };
        const agentObj = {
          id: sid,
          status: 'idle',
          inbox: { nextTurn: [], nextStep: [] },
          session: sessionObj,
          options: {
            get model() {
              return globalDefaultModel.model;
            },
          },
          model: {
            recordedSelection() {
              return recorded;
            },
            effective() {
              return recorded ?? structuredClone(globalDefaultModel);
            },
            select(sel) {
              selectCalls.push(structuredClone(sel));
              recorded = structuredClone(sel);
            },
            _selectCalls: selectCalls,
          },
        };
        hostSessions.set(sid, sessionObj);
        hostAgents.set(sid, agentObj);
        return { sessionId: sid, agentPreset: preset };
      },
      async selectModel(req) {
        // Real DSH 0.2.2-rc.5 `commands.js:176-177`: mutates global profile default!
        controllerSelectModelCount += 1;
        const selected = {
          provider: req.provider,
          model: req.model,
          ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}),
        };
        hostAgents.get(req.sessionId)?.model?.select(selected);
        dshCtx.agentDefaultModel.saveSelection(selected);
        return { selected };
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

  await withTestRuntime(rt, async () => {
    const h = createPublicContractHandlers(dshCtx, rt, { dshHome, configPath: cfgFile });

    // 1. Create LT session without `body.model`
    const ltCreated = await (await h.workbenchCreate(makeJsonPost({ cwd: ws, executionMode: 'single' }))).json();
    assert.equal(ltCreated.ok, true);
    const ltSid = ltCreated.data.sessionId;
    const ltAgent = hostAgents.get(ltSid);

    // LT session selected configured `roles.leader` model (`codex/gpt-6.1-sol`, `effort: 'high'`)
    assert.equal(ltAgent.model.recordedSelection()?.provider, 'magpie');
    assert.equal(ltAgent.model.recordedSelection()?.model, 'codex/gpt-6.1-sol');
    assert.equal(ltAgent.model.recordedSelection()?.reasoningEffort, 'high');
    assert.equal(ltAgent.model._selectCalls.length, 1);
    assert.equal(resolvedCallConfigs.length, 1);

    // ZERO calls to `sessionController.selectModel`, `agentDefaultModel.saveSelection`, or `settings.update`!
    assert.equal(controllerSelectModelCount, 0, 'Must NEVER call sessionController.selectModel');
    assert.equal(saveSelectionCount, 0, 'Must NEVER overwrite DSH agentDefaultModel');
    assert.equal(settingsMutationCount, 0, 'Must NEVER mutate DSH settings on workbenchCreate');
    assert.deepEqual(globalDefaultModel, {
      provider: 'native',
      model: 'user-default',
      reasoningEffort: 'low',
    });

    // 2. Subsequent native DSH session (`agentPreset: 'standard'`) retains `native/user-default`!
    const nativeCreated = await (await h.workbenchCreate(makeJsonPost({ cwd: ws, agentPreset: 'standard' }))).json();
    assert.equal(nativeCreated.ok, true);
    const nativeAgent = hostAgents.get(nativeCreated.data.sessionId);
    assert.equal(nativeAgent.model.recordedSelection(), null);
    assert.deepEqual(nativeAgent.model.effective(), {
      provider: 'native',
      model: 'user-default',
      reasoningEffort: 'low',
    });
  });
});

test('R2-V223-05b: Panel & standalone session enumeration map physical teams/<dir> to logical sessionId without duplicating foo/bar or colliding with foo~002Fbar', async t => {
  const tmpDir = makeTempSandbox(t, '05b-logical-id');
  const { dshHome, storageRoot, cfgFile, rt } = createIsolatedRuntime(tmpDir);
  const ws = path.join(tmpDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });

  const sidSlash = 'foo/bar';
  const sidLiteralTilde = 'foo~002Fbar';

  // `'foo/bar'` started in Team (`teams/foo~002Fbar/team.json`) and later switched to Single (`session-modes/foo~002Fbar.json`)
  const storeSlash = new TeamStore(storageRoot, sidSlash);
  storeSlash.ensure({ workspace: ws, surface: 'desktop' });
  assert.equal(encodeTeamStoreId(sidSlash, storageRoot), 'foo~002Fbar');
  writeSessionModeRecord(storageRoot, sidSlash, 'single', { source: 'user', taskSeqHint: 1 });
  writeZstdSession(path.join(dshHome, 'sessions', encodeDshSegment(sidSlash)), [
    { type: 'session', version: 4, id: sidSlash, cwd: ws, agentPreset: 'leaderteam', createdAt: 3000 },
  ]);

  // Phase 1: ONLY `'foo/bar'` exists -> must appear ONCE as `'foo/bar'` (`mode: 'single'`), NEVER twice (`'foo/bar'` + `'foo~002Fbar'`)!
  const standaloneCtx = { get: k => (k === 'profileContext' ? { home: dshHome } : null) };
  await withTestRuntime(rt, async () => {
    const knownPhase1 = await collectKnownSessionModeItems(standaloneCtx, rt, dshHome);
    assert.equal(knownPhase1.length, 1, `Expected 1 session, got ${JSON.stringify(knownPhase1.map(x => x.sessionId))}`);
    assert.equal(knownPhase1[0].sessionId, sidSlash);
    assert.equal(knownPhase1[0].executionMode, 'single');
    assert.equal(knownPhase1[0].isTeam, true);

    const pubH = createPublicContractHandlers(standaloneCtx, rt, { dshHome, configPath: cfgFile });
    const wbPhase1 = await (await pubH.workbenchSessions(makeJsonPost({}))).json();
    assert.equal(wbPhase1.data.sessions.length, 1);
    assert.equal(wbPhase1.data.sessions[0].sessionId, sidSlash);
    assert.equal(wbPhase1.data.sessions[0].executionMode, 'single');

    const panelH = createPanelHandlers(standaloneCtx, rt, { dshHome });
    const panelListPhase1 = await (await panelH.sessionMode(makeJsonPost({ action: 'list' }))).json();
    assert.equal(panelListPhase1.value.sessions.length, 1);
    assert.equal(panelListPhase1.value.sessions[0].sessionId, sidSlash);
    assert.equal(panelListPhase1.value.sessions[0].executionMode, 'single');

    const panelStatePhase1 = await buildPanelStateSnapshot(standaloneCtx, rt);
    assert.equal(panelStatePhase1.sessionModes.length, 1);
    assert.equal(panelStatePhase1.sessionModes[0].sessionId, sidSlash);
    assert.equal(panelStatePhase1.sessionModes[0].executionMode, 'single');

    // Also test legacy `members.jsonl`-only directory (no `team.json` at all!) for `'alpha/beta'` (`teams/alpha~002Fbeta/members.jsonl`)
    const legacySeg = encodeTeamStoreId('alpha/beta', storageRoot);
    assert.equal(legacySeg, 'alpha~002Fbeta');
    const legacyDir = path.join(storageRoot, 'teams', legacySeg);
    fs.mkdirSync(legacyDir, { recursive: true });
    appendJsonl(path.join(legacyDir, 'members.jsonl'), {
      v: 1,
      type: 'member',
      at: new Date().toISOString(),
      childId: 'm-leg-1',
      name: 'w1',
      profile: 'code',
      status: 'done',
      taskSeq: 1,
    });
    writeSessionModeRecord(storageRoot, 'alpha/beta', 'single', { source: 'user', taskSeqHint: 1 });

    const wbWithLegacy = await (await pubH.workbenchSessions(makeJsonPost({}))).json();
    assert.equal(wbWithLegacy.data.sessions.filter(s => s.sessionId === 'alpha/beta').length, 1);
    assert.equal(wbWithLegacy.data.sessions.some(s => s.sessionId === 'alpha~002Fbeta'), false);

    // Phase 2: Now ALSO create distinct session `'foo~002Fbar'` in Team mode (`teams/foo~007E002Fbar/team.json`)!
    const storeTilde = new TeamStore(storageRoot, sidLiteralTilde);
    storeTilde.ensure({ workspace: ws, surface: 'desktop' });
    assert.equal(encodeTeamStoreId(sidLiteralTilde, storageRoot), 'foo~007E002Fbar');
    writeZstdSession(path.join(dshHome, 'sessions', encodeDshSegment(sidLiteralTilde)), [
      { type: 'session', version: 4, id: sidLiteralTilde, cwd: ws, agentPreset: 'leaderteam', createdAt: 3100 },
    ]);

    const knownPhase2 = await collectKnownSessionModeItems(standaloneCtx, rt, dshHome);
    const slashEntry = knownPhase2.find(s => s.sessionId === sidSlash);
    const tildeEntry = knownPhase2.find(s => s.sessionId === sidLiteralTilde);
    assert.ok(slashEntry, 'foo/bar must exist');
    assert.ok(tildeEntry, 'foo~002Fbar must exist independently');
    assert.equal(slashEntry.executionMode, 'single');
    assert.equal(tildeEntry.executionMode, 'team');

    const wbPhase2 = await (await pubH.workbenchSessions(makeJsonPost({}))).json();
    assert.equal(wbPhase2.data.sessions.find(s => s.sessionId === sidSlash)?.executionMode, 'single');
    assert.equal(wbPhase2.data.sessions.find(s => s.sessionId === sidLiteralTilde)?.executionMode, 'team');
  });
});

test('R2-V223-07a: workbenchCreate with executionMode="single" pre-seeds Single mode for BOTH explicit sessionId and auto-minted sessionId (0 TeamStore files, 1 history entry, safe rollback)', async t => {
  const tmpDir = makeTempSandbox(t, '07a-explicit-single');
  const { dshHome, storageRoot, cfgFile, rt } = createIsolatedRuntime(tmpDir);
  const ws = path.join(tmpDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });

  const hostSessions = new Map();
  const hostAgents = new Map();
  let rejectCreateSid = null;

  const liveCtx = {
    sessions: hostSessions,
    agents: hostAgents,
    agentPresets: {
      defaultId: 'standard',
      async resolve(id) {
        return { id };
      },
      presetForSession(sess) {
        return sess?.header?.agentPreset ?? 'standard';
      },
    },
    sessionController: {
      async create(req) {
        const sid = req.sessionId || `sess-auto-${hostSessions.size + 1}`;
        if (sid === rejectCreateSid || hostSessions.has(sid)) {
          throw new Error(`Session create rejected for ${sid}`);
        }
        const preset = req.agentPreset || 'leaderteam';
        const sessionObj = {
          id: sid,
          header: { id: sid, cwd: req.cwd || ws, agentPreset: preset },
          snapshotEvents: () => [],
        };
        const agentObj = {
          id: sid,
          status: 'idle',
          inbox: { nextTurn: [], nextStep: [] },
          session: sessionObj,
          options: {},
          model: {
            recordedSelection: () => null,
            select() {},
          },
          ctx: {
            systemPrompt: {
              section: () => () => {},
              context: () => () => {},
            },
          },
        };
        hostSessions.set(sid, sessionObj);
        hostAgents.set(sid, agentObj);
        rt.hostAgents.set(sid, agentObj);
        // Fire real `onAgentCreated` synchronously inside `sessionController.create`!
        withTestRuntime(rt, () => onAgentCreated(liveCtx, { agent: agentObj }));
        return { sessionId: sid, agentPreset: preset };
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

  await withTestRuntime(rt, async () => {
    const h = createPublicContractHandlers(liveCtx, rt, { dshHome, configPath: cfgFile });

    // 1. Explicit `body.sessionId` with `executionMode: 'single'`
    const explicitSid = 'custom-single-session-explicit-01';
    const expRes = await (await h.workbenchCreate(makeJsonPost({
      cwd: ws,
      sessionId: explicitSid,
      executionMode: 'single',
    }))).json();
    assert.equal(expRes.ok, true);
    assert.equal(expRes.data.sessionId, explicitSid);
    assert.equal(expRes.data.executionMode, 'single');
    assert.equal(TeamStore.exists(storageRoot, explicitSid), false, 'Explicit sessionId in Single mode must create 0 TeamStore files');
    assert.equal(fs.existsSync(path.join(storageRoot, 'teams', explicitSid)), false);
    const expHist = readSessionModeHistory(storageRoot, explicitSid);
    assert.equal(expHist.length, 1, 'Must write exactly 1 initial mode history entry');
    assert.equal(expHist[0].fromMode, null);
    assert.equal(expHist[0].toMode, 'single');
    assert.equal(rt.actors.get(explicitSid)?.executionMode, 'single');
    assert.ok(rt.actors.get(explicitSid)?.allowedTools.includes('write'));

    // 2. Omitted `body.sessionId` with `executionMode: 'single'`
    const autoRes = await (await h.workbenchCreate(makeJsonPost({
      cwd: ws,
      executionMode: 'single',
    }))).json();
    assert.equal(autoRes.ok, true);
    const autoSid = autoRes.data.sessionId;
    assert.ok(autoSid.startsWith('session-'));
    assert.equal(TeamStore.exists(storageRoot, autoSid), false, 'Auto-minted sessionId in Single mode must create 0 TeamStore files');
    const autoHist = readSessionModeHistory(storageRoot, autoSid);
    assert.equal(autoHist.length, 1, 'Auto-minted Single session must write exactly 1 initial mode history entry');
    assert.equal(autoHist[0].fromMode, null);
    assert.equal(autoHist[0].toMode, 'single');

    // 3a. Rollback on `sessionController.create` failure when `sessionId` did NOT previously exist
    rejectCreateSid = 'explicit-failed-create-sid';
    const failNew = await (await h.workbenchCreate(makeJsonPost({
      cwd: ws,
      sessionId: 'explicit-failed-create-sid',
      executionMode: 'single',
    }))).json();
    assert.equal(failNew.ok, false);
    assert.equal(readSessionModeRecord(storageRoot, 'explicit-failed-create-sid').persisted, false);
    assert.equal(readSessionModeHistory(storageRoot, 'explicit-failed-create-sid').length, 0);
    rejectCreateSid = null;

    // 3b. Existing Team session (`alreadyExisted === true`): duplicate `workbenchCreate` failure must NOT wipe existing state!
    const existingTeamRes = await (await h.workbenchCreate(makeJsonPost({
      cwd: ws,
      sessionId: 'existing-team-sid',
      executionMode: 'team',
    }))).json();
    assert.equal(existingTeamRes.ok, true);
    assert.equal(TeamStore.exists(storageRoot, 'existing-team-sid'), true);
    assert.equal(readSessionModeRecord(storageRoot, 'existing-team-sid').mode, 'team');

    const dupFail = await (await h.workbenchCreate(makeJsonPost({
      cwd: ws,
      sessionId: 'existing-team-sid',
      executionMode: 'single',
    }))).json();
    assert.equal(dupFail.ok, false);
    assert.equal(readSessionModeRecord(storageRoot, 'existing-team-sid').mode, 'team', 'Existing Team session mode must not be clobbered or deleted');
    assert.equal(TeamStore.exists(storageRoot, 'existing-team-sid'), true);
  });
});

test('R2-V223-08: Out-of-order loadTranscript / loadSessions / panel poll responses NEVER overwrite freshly switched UI mode in WorkbenchView.tsx or client.js', async () => {
  const webRequire = createRequire(path.join(repoRoot, 'packages', 'lt-web', 'package.json'));
  const esbuild = webRequire('esbuild');

  // Compile `WorkbenchView.tsx` in-memory via `esbuild`
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
    new Function('require', 'module', 'exports', compiledWorkbenchJs)(
      id => (id === 'react' ? mockReact : webRequire(id)),
      mod,
      mod.exports,
    );
    const { WorkbenchView, isStaleModeSnapshot } = mod.exports;

    const intervalCallbacks = [];
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
      globalThis.setInterval = fn => {
        intervalCallbacks.push(fn);
        return intervalCallbacks.length;
      };
      globalThis.clearInterval = () => {};
      globalThis.fetch = async (url, init) => apiHandler(String(url), JSON.parse(init?.body || '{}'));
      try {
        const vnode = WorkbenchView({
          bundle: initialBundle,
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

    return { render, runWithMockFetch, intervalCallbacks, isStaleModeSnapshot };
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

  const bundle = {
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
      roleAssignments: { leader: { route: 'codex/gpt-6.1-sol', effort: 'high', fallback: [] } },
      scheduler: { maxActiveMembers: 4, effectiveCap: 4, activeExecutionMembers: 0, pressureBand: 'normal' },
      teams: [],
    },
    uiPreferences: { theme: 'white', customTheme: {}, usageAnalyticsEnabled: true, autoRefreshMs: 3000 },
    usageStatus: { enabled: true, healthy: true, dshHome: '/tmp', homeExists: true, cachedGatewayRecords: 0, lastSyncAt: null, lastSyncError: null },
  };

  const makeSnap = (sessionId, mode, switchCount) => ({
    sessionId,
    mode,
    defaultMode: 'team',
    isLtSession: true,
    canSwitch: true,
    busyReason: null,
    activeTurn: false,
    activeMembersCount: 0,
    pendingReviewsCount: 0,
    activeConferenceId: null,
    updatedAt: '2026-11-26T05:00:00.000Z',
    switchCount,
  });

  // --- 1. Direct `isStaleModeSnapshot` monotonic `switchCount` check ---
  {
    const dummyHarness = createWorkbenchHarness(bundle, async () => okJson({}));
    const { isStaleModeSnapshot } = dummyHarness;
    assert.equal(isStaleModeSnapshot(makeSnap('s1', 'single', 1), makeSnap('s1', 'team', 0)), true);
    assert.equal(isStaleModeSnapshot(makeSnap('s1', 'single', 1), makeSnap('s1', 'single', 1)), false);
    assert.equal(isStaleModeSnapshot(makeSnap('s1', 'single', 1), makeSnap('s1', 'team', 2)), false);
    assert.equal(isStaleModeSnapshot(makeSnap('s1', 'single', 5), makeSnap('s2', 'team', 0)), false);
  }

  // --- 2. Rendered `WorkbenchView` Race A (`loadTranscript` vs `handleSwitchMode`) & Race B (`loadSessions` vs `handleSwitchMode`) ---
  {
    const sid = 'sess-race-08';
    const pendingTranscriptQueue = [];
    const pendingSessionsQueue = [];
    let transcriptIntercept = false;
    let sessionsIntercept = false;

    const harness = createWorkbenchHarness(bundle, async (url, body) => {
      if (url.endsWith('/workbench/sessions')) {
        if (sessionsIntercept) {
          return new Promise(resolve => pendingSessionsQueue.push(resolve));
        }
        return okJson({
          liveHost: true,
          workspaces: [{ workspaceId: 'ws-1', path: '/tmp/ws' }],
          sessions: [
            {
              sessionId: sid,
              title: 'Race Session',
              cwd: '/tmp/ws',
              agentPreset: 'leaderteam',
              updatedAt: 1000,
              isTeam: false,
              executionMode: 'team',
              isLtSession: true,
              canSwitchMode: true,
              modeBusyReason: null,
              modeState: makeSnap(sid, 'team', 0),
            },
          ],
        });
      }
      if (url.endsWith('/workbench/transcript')) {
        if (transcriptIntercept) {
          return new Promise(resolve => pendingTranscriptQueue.push(resolve));
        }
        return okJson({
          sessionId: body.sessionId,
          passiveState: { running: false },
          modeState: makeSnap(sid, 'team', 0),
          messages: [{ id: 'm-1', role: 'assistant', timeMs: 1000, text: 'Initial reply', model: 'codex/gpt-6.1-sol', toolCalls: [] }],
        });
      }
      if (url.endsWith('/workbench/mode') && body.action === 'set') {
        const nextCount = body.mode === 'single' ? 1 : 2;
        return okJson({
          changed: true,
          previousMode: body.mode === 'single' ? 'team' : 'single',
          modeState: makeSnap(sid, body.mode, nextCount),
        });
      }
      return okJson({});
    });

    let tree;
    await harness.runWithMockFetch(async () => {
      harness.render();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    // Confirm initial mode is Team
    const getActiveModeState = vnode => {
      const singleBtn = walkNodes(
        vnode,
        n => n.type === 'button' && n.props?.className === 'lt-mode-segment-btn' && renderText(n).includes('Single'),
      )[0];
      const teamBtn = walkNodes(
        vnode,
        n => n.type === 'button' && n.props?.className === 'lt-mode-segment-btn' && renderText(n).includes('Team'),
      )[0];
      const badge = walkNodes(vnode, n => n.props?.className === 'lt-mode-badge')[0];
      return {
        singlePressed: singleBtn?.props?.['aria-pressed'],
        teamPressed: teamBtn?.props?.['aria-pressed'],
        badgeMode: badge?.props?.['data-mode'],
        singleBtn,
        teamBtn,
      };
    };

    let ui = getActiveModeState(tree);
    assert.equal(ui.teamPressed, true);
    assert.equal(ui.singlePressed, false);
    assert.equal(ui.badgeMode, 'team');

    // Race A: Fire an in-flight 3s poll `loadTranscript(sid)` BEFORE switching to Single!
    transcriptIntercept = true;
    let slowPollPromise;
    await harness.runWithMockFetch(async () => {
      const pollFn = harness.intervalCallbacks.at(-1);
      assert.equal(typeof pollFn, 'function');
      slowPollPromise = pollFn();
      assert.equal(pendingTranscriptQueue.length, 1, 'Slow loadTranscript poll is now in flight');

      // User clicks `Single 单代理直执` while `loadTranscript` is in flight -> finishes FIRST (`Single`, `switchCount: 1`)!
      ui.singleBtn.props.onClick();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    ui = getActiveModeState(tree);
    assert.equal(ui.singlePressed, true, 'UI switched to Single');
    assert.equal(ui.badgeMode, 'single', 'Sidebar badge switched to Single');

    // Now resolve the slower pre-switch `loadTranscript` with stale `mode: 'team', switchCount: 0`!
    await harness.runWithMockFetch(async () => {
      pendingTranscriptQueue.shift()(okJson({
        sessionId: sid,
        passiveState: { running: false },
        modeState: makeSnap(sid, 'team', 0),
        messages: [{ id: 'm-1', role: 'assistant', timeMs: 1000, text: 'Stale poll reply', model: 'codex/gpt-6.1-sol', toolCalls: [] }],
      }));
      await slowPollPromise;
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    ui = getActiveModeState(tree);
    assert.equal(ui.singlePressed, true, 'Stale in-flight loadTranscript MUST NOT overwrite Single modeState back to Team');
    assert.equal(ui.teamPressed, false);
    assert.equal(ui.badgeMode, 'single', 'Stale in-flight loadTranscript MUST NOT overwrite sidebar badge back to Team');
    transcriptIntercept = false;

    // Race B: Fire slow `loadSessions()` ("刷新" button) while in Single (`switchCount: 1`), switch back to Team (`switchCount: 2`),
    // then resolve slow `loadSessions()` carrying stale `Single` (`switchCount: 1`)!
    sessionsIntercept = true;
    let slowSessionsPromise;
    await harness.runWithMockFetch(async () => {
      const refreshBtn = walkNodes(tree, n => n.type === 'button' && renderText(n) === '刷新')[0];
      slowSessionsPromise = refreshBtn.props.onClick();
      assert.equal(pendingSessionsQueue.length, 1, 'Slow loadSessions poll is now in flight');

      ui.teamBtn.props.onClick();
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    ui = getActiveModeState(tree);
    assert.equal(ui.teamPressed, true, 'UI switched back to Team (switchCount=2)');
    assert.equal(ui.badgeMode, 'team');

    await harness.runWithMockFetch(async () => {
      pendingSessionsQueue.shift()(okJson({
        liveHost: true,
        workspaces: [{ workspaceId: 'ws-1', path: '/tmp/ws' }],
        sessions: [
          {
            sessionId: sid,
            title: 'Race Session',
            cwd: '/tmp/ws',
            agentPreset: 'leaderteam',
            updatedAt: 1005,
            isTeam: false,
            executionMode: 'single',
            isLtSession: true,
            canSwitchMode: true,
            modeBusyReason: null,
            modeState: makeSnap(sid, 'single', 1),
          },
        ],
      }));
      await slowSessionsPromise;
      await new Promise(r => setTimeout(r, 15));
      tree = harness.render();
    });

    ui = getActiveModeState(tree);
    assert.equal(ui.teamPressed, true, 'Stale in-flight loadSessions MUST NOT overwrite Team (switchCount=2) back to Single (switchCount=1)');
    assert.equal(ui.singlePressed, false);
    assert.equal(ui.badgeMode, 'team');
  }

  // --- 3. Embedded DSH `/` Panel (`leaderteam-panel/client.js`): stale `session-mode` list & `state` polls NEVER regress switched mode ---
  {
    const clientCode = fs.readFileSync(path.join(repoRoot, 'leaderteam', 'plugins', 'leaderteam-panel', 'client.js'), 'utf8');
    let panelDesc = null;
    const pendingListResolvers = [];
    const pendingStateResolvers = [];

    const sandbox = {
      window: {
        location: { protocol: 'http:', pathname: '/' },
        __ModuleLoader__: { load(d) { panelDesc = d; } },
      },
      fetch: async (route, init) => {
        const body = JSON.parse(init?.body || '{}');
        if (String(route).includes('session-mode') && body.action === 'list') {
          return new Promise(resolve => pendingListResolvers.push(resolve));
        }
        if (String(route).includes('session-mode') && body.action === 'set') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              value: {
                changed: true,
                modeState: makeSnap(body.sessionId, body.mode, 1),
                sessions: [
                  {
                    sessionId: body.sessionId,
                    title: 'Panel Race Session',
                    executionMode: body.mode,
                    isLtSession: true,
                    canSwitchMode: true,
                    modeBusyReason: null,
                    modeState: makeSnap(body.sessionId, body.mode, 1),
                  },
                ],
              },
            }),
          };
        }
        if (String(route).includes('state')) {
          return new Promise(resolve => pendingStateResolvers.push(resolve));
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) };
      },
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(clientCode, sandbox);

    const states = [];
    const refs = [];
    let stateIdx = 0;
    let refIdx = 0;
    const statefulReact = {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState(init) {
        const idx = stateIdx++;
        if (states.length <= idx) {
          states[idx] = Array.isArray(init) && init.length === 0 && idx === 11
            ? [
                {
                  sessionId: 'panel-race-1',
                  title: 'Panel Race Session',
                  executionMode: 'team',
                  isLtSession: true,
                  canSwitchMode: true,
                  modeState: makeSnap('panel-race-1', 'team', 0),
                },
              ]
            : init;
        }
        const setter = next => {
          states[idx] = typeof next === 'function' ? next(states[idx]) : next;
        };
        return [states[idx], setter];
      },
      useRef(init) {
        const idx = refIdx++;
        if (refs.length <= idx) refs[idx] = { current: init };
        return refs[idx];
      },
      useEffect: () => {},
      useCallback: fn => fn,
    };

    const panelPlugin = panelDesc.factory(m => (m === 'react' ? statefulReact : null));
    const renderPanel = () => {
      stateIdx = 0;
      refIdx = 0;
      return panelPlugin.ConsoleView({});
    };

    let pTree = renderPanel();
    // Ensure `sessionModes` has our seeded `panel-race-1` even if hook index shifted
    let refreshModesBtn = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '刷新会话模式')[0];
    let refreshStateBtn = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '刷新状态')[0];
    assert.ok(refreshModesBtn);
    assert.ok(refreshStateBtn);

    // Seed initial state via `loadState` first so `panel-race-1` is in `sessionModes` (`Team`, `switchCount: 0`)
    const initLoadPromise = refreshStateBtn.props.onClick();
    pendingStateResolvers.shift()({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessionModes: [
            {
              sessionId: 'panel-race-1',
              title: 'Panel Race Session',
              executionMode: 'team',
              isLtSession: true,
              canSwitchMode: true,
              modeState: makeSnap('panel-race-1', 'team', 0),
            },
          ],
        },
      }),
    });
    await initLoadPromise;
    pTree = renderPanel();
    assert.ok(renderText(pTree).includes('切换为 Single'));

    // Now start BOTH slow `onRefreshSessionModes` AND slow `loadState` BEFORE clicking `切换为 Single`!
    refreshModesBtn = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '刷新会话模式')[0];
    refreshStateBtn = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '刷新状态')[0];
    const slowListPromise = refreshModesBtn.props.onClick();
    const slowStatePromise = refreshStateBtn.props.onClick();
    assert.equal(pendingListResolvers.length, 1);
    assert.equal(pendingStateResolvers.length, 1);

    // Switch `panel-race-1` to `Single` (`switchCount: 1`) -> resolves immediately!
    const switchBtn = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '切换为 Single')[0];
    await switchBtn.props.onClick();
    pTree = renderPanel();
    assert.ok(renderText(pTree).includes('切换为 Team'), 'Panel switched to Single');

    // Resolve stale `session-mode` list AND stale `state` carrying `mode: 'team', switchCount: 0`!
    pendingListResolvers.shift()({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessions: [
            {
              sessionId: 'panel-race-1',
              title: 'Panel Race Session',
              executionMode: 'team',
              isLtSession: true,
              canSwitchMode: true,
              modeState: makeSnap('panel-race-1', 'team', 0),
            },
          ],
        },
      }),
    });
    pendingStateResolvers.shift()({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          sessionModes: [
            {
              sessionId: 'panel-race-1',
              title: 'Panel Race Session',
              executionMode: 'team',
              isLtSession: true,
              canSwitchMode: true,
              modeState: makeSnap('panel-race-1', 'team', 0),
            },
          ],
        },
      }),
    });
    await Promise.all([slowListPromise, slowStatePromise]);
    pTree = renderPanel();
    const afterRaceTeamBtns = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '切换为 Team');
    const afterRaceSingleBtns = walkNodes(pTree, n => n.type === 'button' && renderText(n) === '切换为 Single');
    const afterRaceSingleBadges = walkNodes(pTree, n => n.type === 'span' && renderText(n) === 'Single');
    assert.equal(afterRaceTeamBtns.length, 1, 'Stale panel polls MUST NOT overwrite switched Single mode back to Team');
    assert.equal(afterRaceSingleBtns.length, 0);
    assert.equal(afterRaceSingleBadges.length, 1);
  }
});
