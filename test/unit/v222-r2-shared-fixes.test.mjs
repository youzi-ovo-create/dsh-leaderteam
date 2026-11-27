import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startStandaloneLtUiServer } from '../../bin/lt-ui.mjs';
import { getOrCreateGatewayManager } from '../../leaderteam/gateway/index.mjs';
import { HengzhangUsageBridge } from '../../leaderteam/usage/hengzhang-bridge.mjs';
import { createPublicContractHandlers } from '../../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { extractReceipts, resolveStorageRoot } from '../../packages/lt-usage/index.mjs';
import { loadSharedContractsModules, resolveLtUsagePluginDir } from '../helpers/shared-contracts-loader.mjs';

const { startMockMagpieServer, validateContractBundle } = await loadSharedContractsModules();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const ossRoot = path.dirname(resolveLtUsagePluginDir());

function writeZstdSession(sessionDir, rows) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const frames = rows.map(r => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8')));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

test('R2-SH-01: bundled packages/lt-usage stays synced with lt-usage-plugin and computes accurate taskSeq across host injections, control messages, and delivery agreements', () => {
  // 1. Verify byte-for-byte sync between lt-usage-plugin and leaderteam-v2.2-dev/packages/lt-usage
  const pluginCoreDir = path.join(ossRoot, 'lt-usage-plugin', 'packages', 'core', 'src');
  const bundledCoreDir = path.join(repoRoot, 'packages', 'lt-usage', 'core');
  if (fs.existsSync(pluginCoreDir)) {
    for (const file of fs.readdirSync(pluginCoreDir)) {
      if (!file.endsWith('.js')) continue;
      assert.equal(
        fs.readFileSync(path.join(bundledCoreDir, file), 'utf8'),
        fs.readFileSync(path.join(pluginCoreDir, file), 'utf8'),
        `packages/lt-usage/core/${file} must match lt-usage-plugin/packages/core/src/${file}`,
      );
    }
    for (const file of ['decode.js', 'homes.js', 'service.js']) {
      const expected = fs
        .readFileSync(path.join(ossRoot, 'lt-usage-plugin', 'packages', 'reader', 'src', file), 'utf8')
        .replace(/from\s+['"]@lt-usage\/core['"]/g, "from '../core/index.js'");
      assert.equal(
        fs.readFileSync(path.join(repoRoot, 'packages', 'lt-usage', 'reader', file), 'utf8'),
        expected,
        `packages/lt-usage/reader/${file} must stay synced with lt-usage-plugin`,
      );
    }
  }

  // 2. Verify extractReceipts taskSeq rules directly on bundled module
  const rows = [
    { type: 'session', version: 4, id: 's-taskseq', createdAt: 1000, cwd: '/tmp/ws' },
    { type: 'user/message', time: 1005, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'READ_GRANT: /tmp/ref' }] } },
    { type: 'user/message', time: 1010, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Build feature A' }] } },
    { type: 'user/message', time: 1020, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'snapshot' }] } },
    { type: 'user/message', time: 1030, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'clock' }] } },
    { type: 'user/message', time: 1040, data: { source: { kind: 'subagent' }, content: [{ type: 'text', text: 'worker done' }] } },
    { type: 'user/message', time: 1050, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '最大并发 4' }] } },
    { type: 'user/message', time: 1060, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] } },
    {
      type: 'assistant/message',
      time: 1100,
      seq: 1,
      data: {
        message: { id: 'm1', source: { model: 'zcode/GLM-5.3' } },
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      },
    },
    { type: 'user/message', time: 1500, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'continue.' }] } },
    {
      type: 'assistant/message',
      time: 1600,
      seq: 2,
      data: {
        message: { id: 'm2', source: { model: 'zcode/GLM-5.3' } },
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      },
    },
  ];
  const extracted = extractReceipts(rows, { approvedDeliveryTimes: new Map([[1, [1400]]]) });
  assert.deepEqual(extracted.receipts.map(r => r.taskSeq), [1, 2]);
});

test('R2-SH-02: HengzhangUsageBridge honors custom storageRoot & per-home leaderteam*.json storage.root and counts non-team safety-gate governance calls', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-r2-sh02-'));
  try {
    const primaryHome = path.join(tmpRoot, 'primary-home');
    const primaryCustomStorage = path.join(tmpRoot, 'primary-custom-storage');
    const secondaryHome = path.join(tmpRoot, 'secondary-home');
    const secondaryCustomStorage = path.join(tmpRoot, 'secondary-custom-storage');

    // Primary home: non-team session with 100 leader tokens + 65 safety-gate tokens under primaryCustomStorage
    const sid1 = 'sess-primary-single-gated';
    writeZstdSession(path.join(primaryHome, 'sessions', sid1), [
      { type: 'session', version: 4, id: sid1, createdAt: 1000, cwd: '/tmp/ws1' },
      { type: 'user/message', time: 1010, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Check files' }] } },
      {
        type: 'assistant/message',
        time: 1200,
        seq: 1,
        data: {
          message: { id: 'a-p1', source: { model: 'zcode/GLM-5.3' } },
          usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
        },
      },
    ]);
    const pGateDir = path.join(primaryCustomStorage, 'teams', sid1);
    fs.mkdirSync(pGateDir, { recursive: true });
    fs.writeFileSync(
      path.join(pGateDir, 'usage.jsonl'),
      `${JSON.stringify({
        v: 1,
        at: new Date(1150).toISOString(),
        role: 'gate',
        route: 'zcode/GLM-5.3',
        taskSeq: 1,
        ok: true,
        usage: { inputTokens: 50, outputTokens: 15, totalTokens: 65 },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(pGateDir, 'gate.jsonl'),
      `${JSON.stringify({ v: 1, at: new Date(1150).toISOString(), decision: 'allow', by: 'model' })}\n`,
    );

    // Secondary home: configures its own `storage.root` in `<secondaryHome>/leaderteam.local.json`
    const sid2 = 'sess-secondary-gated';
    fs.mkdirSync(secondaryHome, { recursive: true });
    fs.writeFileSync(
      path.join(secondaryHome, 'leaderteam.local.json'),
      JSON.stringify({ storage: { root: secondaryCustomStorage } }, null, 2),
    );
    assert.equal(resolveStorageRoot(secondaryHome), secondaryCustomStorage);
    writeZstdSession(path.join(secondaryHome, 'sessions', sid2), [
      { type: 'session', version: 4, id: sid2, createdAt: 2000, cwd: '/tmp/ws2' },
      {
        type: 'assistant/message',
        time: 2200,
        seq: 1,
        data: {
          message: { id: 'a-s1', source: { model: 'zcode/GLM-5.3' } },
          usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
        },
      },
    ]);
    const sGateDir = path.join(secondaryCustomStorage, 'teams', sid2);
    fs.mkdirSync(sGateDir, { recursive: true });
    fs.writeFileSync(
      path.join(sGateDir, 'usage.jsonl'),
      `${JSON.stringify({
        v: 1,
        at: new Date(2150).toISOString(),
        role: 'gate',
        route: 'zcode/GLM-5.3',
        taskSeq: 1,
        ok: true,
        usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      })}\n`,
    );

    const bridge = new HengzhangUsageBridge({
      storageRoot: primaryCustomStorage,
      dshHome: primaryHome,
    });

    const primaryReport = await bridge.getSessionReport({ sessionId: sid1, syncGateway: false });
    assert.equal(primaryReport.report.totals.callsTotal, 2);
    assert.equal(primaryReport.report.totals.totalTokens, 165);
    assert.equal(primaryReport.publicRecords.length, 2);
    assert.ok(primaryReport.publicRecords.some(r => r.sourceKind === 'lt-governance' && r.tokens.totalTokens === 65));

    const primaryOverview = await bridge.getOverview({ syncGateway: false });
    assert.equal(primaryOverview.overview.totals.callsTotal, 2);
    assert.equal(primaryOverview.overview.totals.totalTokens, 165);

    const primarySessions = await bridge.getSessions({ syncGateway: false });
    assert.equal(primarySessions.sessions.length, 1);
    assert.equal(primarySessions.sessions[0].callsTotal, 2);
    assert.equal(primarySessions.sessions[0].totalTokens, 165);

    // Querying secondaryHome passes `storageRoot: undefined` so secondaryHome resolves its own leaderteam.local.json!
    const secondaryOverview = await bridge.getOverview({ home: secondaryHome, syncGateway: false, allowExternalOverride: true });
    assert.equal(secondaryOverview.overview.totals.callsTotal, 2);
    assert.equal(secondaryOverview.overview.totals.totalTokens, 290);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('R2-SH-03: Magpie 0.1.4797 { id, seq } Gone tombstones evict cached gateway rows and immediately invalidate REPORT_CACHE', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-r2-sh03-'));
  const mockSrv = await startMockMagpieServer({
    version: '0.1.4797',
    initialUsageRows: [
      {
        id: 'r_gone_live',
        responseId: 'chatcmpl-gone-live',
        t: new Date(1500).toISOString(),
        req: 'group/coding-pool',
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        in: 100,
        out: 50,
        total: 150,
        tries: 2,
        ms: 320,
        status: 200,
        session: 'sess-del-1',
      },
    ],
  });

  try {
    const dshHome = path.join(tmpRoot, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    writeZstdSession(path.join(dshHome, 'sessions', 'sess-del-1'), [
      { type: 'session', version: 4, id: 'sess-del-1', createdAt: 1000, cwd: '/tmp/ws' },
      { type: 'user/message', time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Ping' }] } },
      {
        type: 'assistant/message',
        time: 1500,
        seq: 1,
        data: {
          message: {
            id: 'msg-del-1',
            source: {
              kind: 'model',
              provider: 'magpie',
              model: 'group/coding-pool',
              replayState: { response: { responseId: 'chatcmpl-gone-live' } },
            },
          },
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
      },
    ]);

    // Part A: Exact two-page cursor replay `{ rows: [...], deleted: [], next_cursor: 'c1' }` -> `{ rows: [], deleted: [{ id, seq: 2 }], next_cursor: 'c2', has_more: false }`
    const seenCursors = [];
    const scriptedFetch = async urlStr => {
      const u = new URL(urlStr);
      const cur = u.searchParams.get('cursor');
      seenCursors.push(cur);
      if (cur === 'start') {
        return Response.json({
          rows: [
            {
              id: 'r_scripted_1',
              seq: 1,
              t: new Date(1500).toISOString(),
              req: 'group/coding-pool',
              provider: 'deepseek',
              model: 'deepseek-reasoner',
              in: 100,
              out: 50,
              total: 150,
              tries: 3,
              ms: 410,
              status: 200,
              session: 'sess-del-1',
              response_id: 'chatcmpl-gone-live',
            },
          ],
          deleted: [],
          next_cursor: 'c1',
          has_more: false,
        });
      }
      if (cur === 'c1') {
        return Response.json({
          rows: [],
          deleted: [{ id: 'r_scripted_1', seq: 2 }],
          next_cursor: 'c2',
          has_more: false,
        });
      }
      return Response.json({ rows: [], deleted: [], next_cursor: cur, has_more: false });
    };

    const scriptedStorage = path.join(tmpRoot, 'scripted-storage');
    const scriptedMgr = getOrCreateGatewayManager(scriptedStorage, { fetchImpl: scriptedFetch });
    await scriptedMgr.configure({
      mode: 'external',
      externalGatewayUrl: 'http://127.0.0.1:19999',
      externalWebAdminUrl: 'http://127.0.0.1:19998',
    });
    const scriptedBridge = new HengzhangUsageBridge({
      storageRoot: scriptedStorage,
      dshHome,
      gatewayManager: scriptedMgr,
      fetchImpl: scriptedFetch,
    });

    const repBefore = await scriptedBridge.getSessionReport({ sessionId: 'sess-del-1', syncGateway: true });
    assert.equal(scriptedBridge.nextCursor, 'c1');
    assert.equal(scriptedBridge.gatewayRecordMap.size, 1);
    assert.equal(repBefore.report.calls[0].gatewayMatched, true);
    assert.equal(repBefore.report.calls[0].actualProvider, 'deepseek');
    assert.equal(repBefore.report.calls[0].physicalAttempts, 3);

    const ovBefore = await scriptedBridge.getOverview({ syncGateway: false });
    assert.equal(ovBefore.overview.totals.totalTokens, 150);

    // Second sync receives `{ rows: [], deleted: [{ id: 'r_scripted_1', seq: 2 }], next_cursor: 'c2', has_more: false }`
    const repAfter = await scriptedBridge.getSessionReport({ sessionId: 'sess-del-1', syncGateway: true });
    assert.deepEqual(seenCursors, ['start', 'c1']);
    assert.equal(scriptedBridge.nextCursor, 'c2');
    assert.equal(scriptedBridge.gatewayRecordMap.size, 0);
    assert.equal(repAfter.report.calls[0].gatewayMatched, false);
    assert.equal(repAfter.report.calls[0].actualProvider, 'unknown');
    assert.equal(repAfter.report.calls[0].physicalAttempts, null);

    // Part B: End-to-end against calibrated Mock Magpie 0.1.4797 emitting `deleted: [{ id, seq }]`
    const liveMgr = getOrCreateGatewayManager(storageRoot);
    await liveMgr.configure({
      mode: 'external',
      externalGatewayUrl: mockSrv.gatewayUrl,
      externalWebAdminUrl: mockSrv.webUrl,
      externalWebKey: mockSrv.webKey,
    });
    const liveBridge = new HengzhangUsageBridge({ storageRoot, dshHome, gatewayManager: liveMgr });
    await liveBridge.triggerBackgroundMagpieSync();
    assert.equal(liveBridge.gatewayRecordMap.has('r_gone_live'), true);

    mockSrv.deleteUsageRow('r_gone_live');
    await liveBridge.triggerBackgroundMagpieSync();
    assert.equal(liveBridge.gatewayRecordMap.has('r_gone_live'), false);
    assert.equal(liveBridge.gatewayRecordMap.size, 0);
  } finally {
    await mockSrv.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('R2-SH-04: disabling usage analytics via usage/toggle keeps standalone workbench/sessions populated (including blank team.json sessions)', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-r2-sh04-'));
  let uiServer = null;
  const prevDshHome = process.env.DSH_HOME;
  try {
    const dshHome = path.join(tmpRoot, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');

    // 1. Durable root team session + child member session (must be excluded) + plain session + archived session (must be excluded)
    writeZstdSession(path.join(dshHome, 'sessions', 'team-durable-1'), [
      { type: 'session', version: 4, id: 'team-durable-1', createdAt: 1000, cwd: '/tmp/proj-a' },
      { type: 'session/title', time: 1050, data: { title: 'Durable Team Session' } },
      {
        type: 'assistant/message',
        time: 1200,
        seq: 1,
        data: {
          message: { id: 'm-t1', source: { model: 'zcode/GLM-5.3' } },
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        },
      },
    ]);
    writeZstdSession(path.join(dshHome, 'sessions', 'child-member-1'), [
      { type: 'session', version: 4, id: 'child-member-1', parentSession: 'team-durable-1', createdAt: 1100, cwd: '/tmp/proj-a' },
    ]);
    const durableTeamDir = path.join(storageRoot, 'teams', 'team-durable-1');
    fs.mkdirSync(durableTeamDir, { recursive: true });
    fs.writeFileSync(path.join(durableTeamDir, 'team.json'), JSON.stringify({ v: 1, teamId: 'team-durable-1', workspace: '/tmp/proj-a' }));
    fs.writeFileSync(
      path.join(durableTeamDir, 'members.jsonl'),
      `${JSON.stringify({ type: 'member', childId: 'child-member-1', name: 'worker-a', actorRole: 'member' })}\n`,
    );

    writeZstdSession(path.join(dshHome, 'sessions', 'plain-durable-1'), [
      { type: 'session', version: 4, id: 'plain-durable-1', createdAt: 2000, cwd: '/tmp/proj-b' },
      { type: 'session/title', time: 2050, data: { title: 'Plain Session' } },
    ]);

    writeZstdSession(path.join(dshHome, 'sessions', 'archived-sess-1'), [
      { type: 'session', version: 4, id: 'archived-sess-1', createdAt: 1500, cwd: '/tmp/proj-arch' },
    ]);

    // 2. Blank LT team directory without `session.v4.jsonl.zstd` yet
    const blankTeamDir = path.join(storageRoot, 'teams', 'team-blank-1');
    fs.mkdirSync(blankTeamDir, { recursive: true });
    fs.writeFileSync(
      path.join(blankTeamDir, 'team.json'),
      JSON.stringify({
        v: 1,
        teamId: 'team-blank-1',
        sessionId: 'team-blank-1',
        workspace: '/tmp/proj-blank',
        createdAt: new Date(3000).toISOString(),
      }),
    );

    // Verify archivedSet filtering directly via createPublicContractHandlers
    const rtLocal = { plugins: {}, actors: new Map(), stores: new Map() };
    const mockCtx = {
      workspaceRegistry: {
        list: () => [],
        archivedSessionIds: () => ['archived-sess-1'],
      },
    };
    const handlers = createPublicContractHandlers(mockCtx, rtLocal, { dshHome });
    const toggleOffRes = await (await handlers.usageToggle(new Request('http://127.0.0.1/api/lt/v1/usage/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }))).json();
    assert.equal(toggleOffRes.ok, true);
    assert.equal(toggleOffRes.data.enabled, false);

    const ovDisabled = await (await handlers.usageOverview(new Request('http://127.0.0.1/api/lt/v1/usage/overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }))).json();
    assert.equal(ovDisabled.ok, true);
    assert.equal(ovDisabled.data.enabled, false);

    const wbAfterDisable = await (await handlers.workbenchSessions(new Request('http://127.0.0.1/api/lt/v1/workbench/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }))).json();
    assert.equal(wbAfterDisable.ok, true);
    assert.equal(wbAfterDisable.data.liveHost, false);
    assert.deepEqual(
      wbAfterDisable.data.sessions.map(s => s.sessionId),
      ['team-blank-1', 'plain-durable-1', 'team-durable-1'],
    );
    const blankRow = wbAfterDisable.data.sessions.find(s => s.sessionId === 'team-blank-1');
    assert.equal(blankRow.cwd, '/tmp/proj-blank');
    assert.equal(blankRow.isTeam, true);
    assert.equal(blankRow.agentPreset, 'leaderteam');

    // Also verify over real HTTP via standalone `startStandaloneLtUiServer`
    uiServer = await startStandaloneLtUiServer({ port: 0, dshHome, requireAuth: true });
    const headers = {
      Authorization: `Bearer ${uiServer.token}`,
      Origin: uiServer.baseUrl,
      'Content-Type': 'application/json',
    };
    const httpToggle = await (await fetch(`${uiServer.baseUrl}/api/lt/v1/usage/toggle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(httpToggle.data.enabled, false);

    const httpOverview = await (await fetch(`${uiServer.baseUrl}/api/lt/v1/usage/overview`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })).json();
    assert.equal(httpOverview.data.enabled, false);

    const httpWb = await (await fetch(`${uiServer.baseUrl}/api/lt/v1/workbench/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })).json();
    assert.equal(httpWb.ok, true);
    assert.equal(httpWb.data.sessions.some(s => s.sessionId === 'team-durable-1'), true);
    assert.equal(httpWb.data.sessions.some(s => s.sessionId === 'plain-durable-1'), true);
    assert.equal(httpWb.data.sessions.some(s => s.sessionId === 'team-blank-1'), true);
    assert.equal(httpWb.data.sessions.some(s => s.sessionId === 'child-member-1'), false);

    const bundleEnv = await (await fetch(`${uiServer.baseUrl}/api/lt/v1/bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })).json();
    assert.equal(validateContractBundle(bundleEnv).ok, true);
  } finally {
    if (uiServer) await uiServer.close();
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('R2-DEL-03: verify-v22x-productization-e2e.mjs guards outerBaselineRepoClean when standalone layout has no outer ../leaderteam-v2.2-dev/.git', () => {
  const scriptPath = path.join(repoRoot, 'scripts', 'dev', 'verify-v22x-productization-e2e.mjs');
  const src = fs.readFileSync(scriptPath, 'utf8');
  assert.match(src, /const outerRepoDir = path\.resolve\(ossRoot, '\.\.', 'leaderteam-v2\.2-dev'\);/);
  assert.match(src, /fs\.existsSync\(path\.join\(outerRepoDir, '\.git'\)\)/);
  assert.match(src, /'skipped-standalone-layout'/);

  // Simulate standalone layout in /tmp/lt-r2-* where outerRepoDir does not exist
  const tmpStandalone = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-r2-del03-'));
  try {
    const fakeOssRoot = path.join(tmpStandalone, 'restored-bundle', 'open-source-v2.2.x');
    fs.mkdirSync(fakeOssRoot, { recursive: true });
    const outerRepoDir = path.resolve(fakeOssRoot, '..', 'leaderteam-v2.2-dev');
    assert.equal(fs.existsSync(path.join(outerRepoDir, '.git')), false);
    const outerBaselineRepoClean = fs.existsSync(path.join(outerRepoDir, '.git'))
      ? true
      : 'skipped-standalone-layout';
    assert.equal(outerBaselineRepoClean, 'skipped-standalone-layout');
  } finally {
    fs.rmSync(tmpStandalone, { recursive: true, force: true });
  }
});
