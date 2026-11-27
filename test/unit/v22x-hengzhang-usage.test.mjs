import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HengzhangUsageBridge } from '../../leaderteam/usage/index.mjs';
import { MagpieGatewayManager } from '../../leaderteam/gateway/index.mjs';
import { loadSharedContractsModules, resolveLtUsagePluginDir } from '../helpers/shared-contracts-loader.mjs';

const { sharedContractsDir, startMockMagpieServer, validateContractBundle } = await loadSharedContractsModules();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hengzhangFixtureHome = path.join(resolveLtUsagePluginDir(), 'fixtures', 'test-home');

function writeZstdSession(sessionDir, rows) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const frames = rows.map(r => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

test('HengzhangUsageBridge: reconciles DSH zstd sessions + LT sidecars + Magpie usage feed with honest unknown != 0 semantics', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-hengzhang-bridge-'));
  const dshHome = path.join(tmpDir, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const teamId = 'session-team-demo-01';

  // Write synthetic leader & child zstd sessions + LT team sidecars
  writeZstdSession(path.join(dshHome, 'sessions', 'proj', teamId), [
    { type: 'session', version: 4, id: teamId, createdAt: 10000, cwd: '/tmp/proj' },
    { type: 'session/title', time: 10005, data: { title: '网关成本归因测试' } },
    { type: 'user/message', time: 10010, data: { text: '开始任务' } },
    { type: 'request/header', time: 10020, data: {} },
    {
      type: 'assistant/message',
      time: 10370,
      seq: 1,
      data: {
        message: {
          id: 'm-lead-1',
          source: {
            kind: 'model',
            provider: 'magpie',
            model: 'group/flagship',
            replayState: { response: { responseId: 'chatcmpl-lead-001' } },
          },
        },
        usage: { inputTokens: 1200, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 200, totalTokens: 2200 },
      },
    },
    { type: 'request/header', time: 10500, data: {} },
    {
      type: 'assistant/message',
      time: 10900,
      seq: 2,
      data: {
        message: {
          id: 'm-lead-unpriced',
          source: { kind: 'model', provider: 'magpie', model: 'custom-vendor/private-alpha' },
        },
        usage: { inputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, totalTokens: 350 },
      },
    },
  ]);

  const childId = 'child-member-01';
  writeZstdSession(path.join(dshHome, 'sessions', 'proj', childId), [
    { type: 'session', version: 4, id: childId, parentSession: teamId, createdAt: 10400, cwd: '/tmp/proj' },
    { type: 'request/header', time: 10410, data: {} },
    {
      type: 'assistant/message',
      time: 10710,
      seq: 1,
      data: {
        message: {
          id: 'm-child-1',
          source: { kind: 'model', provider: 'deepseek', model: 'deepseek/deepseek-v4.1-flash-1017' },
        },
        usage: { inputTokens: 500, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 100, totalTokens: 1100 },
      },
    },
  ]);

  const teamDir = path.join(storageRoot, 'teams', teamId);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'members.jsonl'),
    JSON.stringify({ type: 'member', childId, name: 'impl-core', actorRole: 'member', stageId: 'stage-a', taskSeq: 1 }) + '\n',
  );
  fs.writeFileSync(
    path.join(teamDir, 'usage.jsonl'),
    JSON.stringify({
      v: 1,
      at: new Date(10600).toISOString(),
      role: 'gate',
      purpose: 'safety-gate',
      taskSeq: 1,
      route: 'zcode/GLM-5.3',
      effort: 'low',
      ok: true,
      attempts: 2,
      latencyMs: 185,
      usage: { inputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 60, totalTokens: 460 },
    }) + '\n',
  );

  const srv = await startMockMagpieServer({
    initialUsageRows: [
      {
        id: 'r_gw_lead_1',
        responseId: 'chatcmpl-lead-001',
        t: new Date(10370).toISOString(),
        session: teamId,
        req: 'group/flagship',
        provider: 'codex',
        model: 'gpt-6.2-sol',
        in: 1200,
        cacheRead: 800,
        out: 200,
        total: 2200,
        tries: 3,
        ms: 348,
        ttftMs: 92,
        status: 200,
      },
    ],
  });

  try {
    const gwMgr = new MagpieGatewayManager({ storageRoot });
    gwMgr.configure({
      mode: 'external',
      externalGatewayUrl: srv.gatewayUrl,
      externalWebAdminUrl: srv.webUrl,
      externalWebKey: srv.webKey,
    });

    const bridge = new HengzhangUsageBridge({ storageRoot, dshHome, gatewayManager: gwMgr });
    const overviewRes = await bridge.getOverview();
    assert.equal(overviewRes.enabled, true);
    assert.equal(overviewRes.overview.sessions.length, 1); // child session NOT double-counted!
    assert.equal(overviewRes.overview.totals.callsTotal, 4);

    const repRes = await bridge.getSessionReport({ sessionId: teamId });
    assert.equal(repRes.report.calls.length, 4);

    // 1. Correlated group/flagship call got actualProvider="codex", actualModel="gpt-6.2-sol", physicalAttempts=3
    const leadCall = repRes.report.calls.find(c => c.route === 'group/flagship');
    assert.equal(leadCall.actualProvider, 'codex');
    assert.equal(leadCall.actualModel, 'gpt-6.2-sol');
    assert.equal(leadCall.physicalAttempts, 3);
    assert.equal(leadCall.latencyMs, 348);
    assert.ok(leadCall.costActualCny > 0);

    // 2. Unpriced custom route stays actualProvider="unknown" & costActualCny=null (unknown != 0!)
    const unpricedCall = repRes.report.calls.find(c => c.route === 'custom-vendor/private-alpha');
    assert.equal(unpricedCall.actualProvider, 'unknown');
    assert.equal(unpricedCall.costActualCny, null);

    // 3. Governance sidecar call carries role="gate", taskSeq=1, physicalAttempts=2, latencyMs=185
    const gateCall = repRes.report.calls.find(c => c.group === 'governance');
    assert.equal(gateCall.role, 'gate');
    assert.equal(gateCall.taskSeq, 1);
    assert.equal(gateCall.physicalAttempts, 2);
    assert.equal(gateCall.latencyMs, 185);

    // 4. Public `LogicalUsageRecord[]` passes shared `lt.public.v1` contract validator
    const mockBundle = JSON.parse(
      fs.readFileSync(path.join(sharedContractsDir, 'mocks', 'mock-v2.2-oss-snapshot.json'), 'utf8'),
    );
    mockBundle.usageRecords = repRes.publicRecords;
    const valid = validateContractBundle(mockBundle);
    assert.equal(valid.ok, true, valid.errors.join('; '));
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Hengzhang non-blocking & fault-isolation: disabling or injecting faults never blocks model calls or crashes status', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-hengzhang-fault-'));
  const srv = await startMockMagpieServer();
  try {
    const storageRoot = path.join(tmpDir, 'lt-storage');
    const gwMgr = new MagpieGatewayManager({ storageRoot });
    // Point gateway to an unreachable port for usage sync to prove non-blocking resilience
    gwMgr.configure({ mode: 'external', externalGatewayUrl: 'http://127.0.0.1:9' });
    const bridge = new HengzhangUsageBridge({
      storageRoot,
      dshHome: hengzhangFixtureHome,
      gatewayManager: gwMgr,
    });

    // 1. Even with unreachable gateway, model calls to srv.gatewayUrl complete immediately while background sync swallows error
    const t0 = Date.now();
    bridge.triggerBackgroundMagpieSync(); // fire-and-forget!
    const chatRes = await fetch(`${srv.gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chatRes.status, 200);
    assert.ok(Date.now() - t0 < 500, 'Model call was not blocked by Hengzhang background sync');

    // 2. Toggle Hengzhang OFF -> returns clean disabled state without reading sessions
    bridge.setEnabled(false);
    const offOverview = await bridge.getOverview();
    assert.equal(offOverview.enabled, false);
    assert.equal(offOverview.overview, null);

    // 3. Re-enable and inject simulated internal fault -> getStatus catches cleanly (`healthy: false`)
    bridge.setEnabled(true);
    bridge.faultInjector = () => {
      throw new Error('SIMULATED_HENGZHANG_INTERNAL_CRASH');
    };
    const faultyStatus = await bridge.getStatus();
    assert.equal(faultyStatus.healthy, false);
    assert.match(faultyStatus.lastSyncError, /SIMULATED_HENGZHANG_INTERNAL_CRASH/);
  } finally {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
