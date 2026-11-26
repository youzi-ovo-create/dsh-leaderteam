import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

globalThis[Symbol.for('leaderteam.hostImports.v1')] = {
  pluginRoot: path.join(ROOT, 'leaderteam'),
  moduleRoot: ROOT,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-r3:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-r3:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.5' }) };
    }
    if (url === 'virtual-r3:@deepseek-ai/dsh-tools/pipeline') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class ToolExecutionPipeline {
            resolveExecution(name, agent, hasParent, toolSet) { return null; }
            async dispatchToolBody(exec) {
              const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
              return await tool.execute(exec.arguments, exec);
            }
          }
        `,
      };
    }
    if (url === 'virtual-r3:@deepseek-ai/dsh-tools') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const TOOL_ABORTED_BEFORE_DISPATCH = 'aborted';
          export function defineTool(def) { return def; }
          export class ToolsService {
            view() { return []; }
            resolve(agent) { const admitted = this.view(agent); return admitted; }
            definitions() { return []; }
            get() { return null; }
            executable() { return null; }
          }
        `,
      };
    }
    if (url === 'virtual-r3:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export class BlockAssembler {}
          export function createUserMessage(t) { return { text: t }; }
          export function createToolResultMessage(r) { return r; }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const entryCore = await import('../../leaderteam/entry-core.mjs');
const { runtime, teamStore } = await import('../../leaderteam/host/runtime.mjs');
const { TeamStore } = await import('../../leaderteam/core/store.mjs');
const { PlanArchiveStore } = await import('../../leaderteam/core/plan-archive.mjs');
const {
  readSessionModeRecord,
  readSessionModeHistory,
} = await import('../../leaderteam/core/session-mode.mjs');
const {
  createPublicContractHandlers,
  extractReadableMessagesFromRows,
} = await import('../../leaderteam/plugins/leaderteam-panel/public-api.mjs');
const { HengzhangUsageBridge } = await import('../../leaderteam/usage/hengzhang-bridge.mjs');
const { resolveStorageRoot, buildReport, defaultPricing } = await import('../../packages/lt-usage/index.mjs');
const {
  extractCnyAmount,
  computeTodayUsageSummary,
} = await import('../../packages/lt-web/src/lib/api.ts');

function makeTempDir(t, suffix = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-r3-${suffix}`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeZstdSession(sessionDir, rows) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const payload = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const compressed = zlib.zstdCompressSync(Buffer.from(payload, 'utf8'));
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), compressed);
}

test('R3-BE-01 [P1]: relative storage.root stays invariant across entry-core init and read-only GET /capabilities', async t => {
  const tmp = makeTempDir(t, 'rel-root-');
  const projectDir = path.join(tmp, 'project');
  const profileDir = path.join(tmp, 'profile');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const rawCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'leaderteam.config.json'), 'utf8'));
  rawCfg.storage = { root: 'lt-data' };
  rawCfg.plugins = { scheduler: false, consensus: false, timerArchive: false, panel: false };
  const cfgPath = path.join(profileDir, 'leaderteam.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2));

  const rt = runtime();
  const snapshot = {
    config: rt.config,
    configPath: rt.configPath,
    configWatch: rt.configWatch,
    storageRoot: rt.storageRoot,
    surface: rt.surface,
    stores: rt.stores,
    actors: rt.actors,
    plugins: rt.plugins,
    gate: rt.gate,
    startupReady: rt.startupReady,
    teamConfigViews: rt.teamConfigViews,
    sessionModesCache: rt.sessionModesCache,
  };
  const prevCwd = process.cwd();
  const prevDshHome = process.env.DSH_HOME;
  const cleanups = [];
  t.after(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch {}
    }
    process.chdir(prevCwd);
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    Object.assign(rt, snapshot);
  });

  process.chdir(projectDir);
  process.env.DSH_HOME = profileDir;
  rt.stores = new Map();
  rt.actors = new Map();
  rt.teamConfigViews = new Map();
  rt.sessionModesCache = new Map();

  const fakeCtx = {
    tools: { register() {} },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      listConfigurableProviders: () => [],
    },
    agents: new Map(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(key) {
      if (key === 'profileContext') return { home: profileDir };
      return this[key] ?? null;
    },
    on() { return () => {}; },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
      return () => {};
    },
    provide() {},
    inject() {},
  };

  entryCore.apply(fakeCtx, { configPath: cfgPath, surface: 'desktop' });
  const rootAfterInit = rt.storageRoot;
  assert.equal(rootAfterInit, path.resolve(profileDir, 'lt-data'));
  assert.equal(rootAfterInit, resolveStorageRoot(profileDir));

  // Host writes Team 1 before panel opens
  teamStore('team-before-cap').ensure({ workspace: projectDir, surface: 'desktop' });
  assert.equal(TeamStore.exists(rootAfterInit, 'team-before-cap'), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'lt-data')), false);

  // Panel calls read-only GET /capabilities
  const handlers = createPublicContractHandlers(fakeCtx, rt);
  const capRes = await (
    await handlers.capabilities(new Request('http://127.0.0.1/api/lt/v1/capabilities', { method: 'GET' }))
  ).json();
  assert.equal(capRes.ok, true);
  assert.equal(rt.storageRoot, rootAfterInit, 'GET /capabilities must never mutate rt.storageRoot');

  // Host writes Team 2 after panel opens -> lands in the exact same directory and sees Team 1
  teamStore('team-after-cap').ensure({ workspace: projectDir, surface: 'desktop' });
  assert.equal(TeamStore.exists(rt.storageRoot, 'team-before-cap'), true);
  assert.equal(TeamStore.exists(rt.storageRoot, 'team-after-cap'), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'lt-data')), false);
});

test('R3-BE-02: DSH 0.2.2-rc.5 compaction surfaceOp replace keeps original Q&A and never appends summary after follow-up', () => {
  const rows = [
    {
      type: 'user/message',
      seq: 0,
      time: 1000,
      surfaceOp: 'append',
      data: { id: 'u-orig', source: { kind: 'user' }, content: [{ type: 'text', text: '原问：请检查接口边界' }] },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1100,
      surfaceOp: 'append',
      data: {
        message: {
          id: 'a-orig',
          source: { model: 'deepseek/deepseek-chat' },
          content: [{ type: 'text', text: '原答：已完成边界梳理' }],
        },
      },
    },
    {
      type: 'user/message',
      seq: 2,
      time: 1200,
      surfaceOp: 'append',
      data: { id: 'u-follow', source: { kind: 'user' }, content: [{ type: 'text', text: '追问：补充异常路径' }] },
    },
    {
      type: 'compaction/summary',
      seq: 3,
      time: 1300,
      data: {
        compactionId: 'cmp-1',
        summary: [{ type: 'text', text: '摘要：前期完成了边界梳理' }],
        shadowedRange: { start: 0, end: 1 },
        shadowedSeqs: [0, 1],
      },
    },
    {
      type: 'user/message',
      seq: 4,
      time: 1301,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: {
        id: 'u-compact-summary',
        source: { kind: 'compaction' },
        content: [{ type: 'text', text: '摘要：前期完成了边界梳理' }],
      },
    },
  ];

  const readable = extractReadableMessagesFromRows(rows);
  assert.deepEqual(
    readable.map(m => ({ id: m.id, role: m.role, text: m.text })),
    [
      { id: 'u-orig', role: 'user', text: '原问：请检查接口边界' },
      { id: 'a-orig', role: 'assistant', text: '原答：已完成边界梳理' },
      { id: 'u-follow', role: 'user', text: '追问：补充异常路径' },
    ],
  );
});

test('R3-BE-03: concurrent cross-process Team->Single switches record exactly 1 history entry and switchCount=1 across 20 rounds', async t => {
  const tmp = makeTempDir(t, 'mode-race-');
  const storageRoot = path.join(tmp, 'lt-store');
  fs.mkdirSync(storageRoot, { recursive: true });
  const workerScript = path.join(tmp, 'switch-worker.mjs');
  const controllerUrl = new URL('../../leaderteam/host/mode-controller.mjs', import.meta.url).href;
  const configUrl = new URL('../../leaderteam/core/config.mjs', import.meta.url).href;
  const cfgPath = path.join(ROOT, 'config', 'leaderteam.config.json');

  fs.writeFileSync(
    workerScript,
    `
      import { loadConfig } from ${JSON.stringify(configUrl)};
      import { switchSessionExecutionMode } from ${JSON.stringify(controllerUrl)};
      const [storageRoot, sid, targetMode, barrierMsStr] = process.argv.slice(2);
      const barrierMs = Number(barrierMsStr);
      while (Date.now() < barrierMs) {}
      const rt = {
        storageRoot,
        config: loadConfig(${JSON.stringify(cfgPath)}),
        surface: 'desktop',
        actors: new Map(),
        stores: new Map(),
        hostAgents: new Map(),
        sessionModesCache: new Map(),
      };
      const res = switchSessionExecutionMode(null, rt, sid, targetMode, {
        sessionExists: true,
        isLtSession: true,
        source: 'cross-proc-race',
      });
      process.stdout.write(JSON.stringify({ changed: res.changed, previousMode: res.previousMode, switchCount: res.modeState.switchCount }));
    `,
    'utf8',
  );

  const runChild = (sid, barrierMs) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerScript, storageRoot, sid, 'single', String(barrierMs)], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
        else resolve(JSON.parse(out));
      });
    });

  for (let round = 0; round < 20; round++) {
    const sid = `sess-race-${round}`;
    const barrierMs = Date.now() + 35;
    const [rA, rB] = await Promise.all([runChild(sid, barrierMs), runChild(sid, barrierMs)]);
    const rec = readSessionModeRecord(storageRoot, sid);
    const hist = readSessionModeHistory(storageRoot, sid);
    assert.equal(rec.mode, 'single', `round ${round}: mode must be single`);
    assert.equal(rec.switchCount, 1, `round ${round}: switchCount must be 1`);
    assert.equal(hist.length, 1, `round ${round}: history must contain exactly 1 entry, got ${JSON.stringify(hist)}`);
    assert.equal(hist[0].fromMode, 'team');
    assert.equal(hist[0].toMode, 'single');
    assert.equal(Number(rA.changed) + Number(rB.changed), 1, `round ${round}: exactly one caller should report changed=true`);
  }
});

test('R3-BE-04: plan retrospectives saved exactly 16m40s (1,000,000ms) or 0ms apart never collide or overwrite', t => {
  const tmp = makeTempDir(t, 'retro-id-');
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storeRoot, { recursive: true });

  const t0 = 1_764_100_123_456;
  const archive = new PlanArchiveStore(path.join(storeRoot, 'plan-archive'));

  const archived = archive.archivePlanSubmission({
    teamId: 'team-retro-1',
    taskSeq: 1,
    workspace: ws,
    agreementId: 'agr-1',
    proposalText: '# Feature Plan\nImplement endpoint validation and regression tests.',
    nowMs: t0 - 5000,
  });

  const r1 = archive.createRetrospective(archived.planId, { notes: '第一份复盘备注：接口边界完整', nowMs: t0 });
  const r2 = archive.createRetrospective(archived.planId, {
    notes: '第二份复盘备注：并发锁验证通过',
    nowMs: t0 + 1_000_000, // Exactly 16m40s later -> identical last 6 digits!
  });
  const r3 = archive.createRetrospective(archived.planId, {
    notes: '第三份同毫秒复盘备注',
    nowMs: t0 + 1_000_000,
  });

  assert.equal(new Set([r1.retroId, r2.retroId, r3.retroId]).size, 3);
  const loadedPlan = archive.getPlan(archived.planId);
  assert.equal(loadedPlan.execution.retrospectiveIds.length, 3);
  const listed = archive.listPlans({ limit: 20 }).find(p => p.planId === archived.planId);
  assert.equal(listed.retrospectiveCount, 3);

  const f1 = JSON.parse(fs.readFileSync(path.join(archive.retrospectivesDir, `${r1.retroId}.json`), 'utf8'));
  const f2 = JSON.parse(fs.readFileSync(path.join(archive.retrospectivesDir, `${r2.retroId}.json`), 'utf8'));
  const f3 = JSON.parse(fs.readFileSync(path.join(archive.retrospectivesDir, `${r3.retroId}.json`), 'utf8'));
  assert.equal(f1.operatorNotes, '第一份复盘备注：接口边界完整');
  assert.equal(f2.operatorNotes, '第二份复盘备注：并发锁验证通过');
  assert.equal(f3.operatorNotes, '第三份同毫秒复盘备注');
});

test('R3-FE-DATA: HengzhangUsageBridge overview.today, extractCnyAmount, and computeTodayUsageSummary isolate today cost from historical sessions', async t => {
  const tmp = makeTempDir(t, 'today-cost-');
  const dshHome = path.join(tmp, 'dsh-home');
  const storageRoot = path.join(dshHome, 'leaderteam');
  const now = new Date();
  const todayNoonMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();
  const sixDaysAgoMs = todayNoonMs - 6 * 86_400_000;

  // zcode/GLM-5.3 default pricing: input 2 CNY/M, output 8 CNY/M
  // Today: 36,000 input (0.072) + 9,000 output (0.072) = ¥0.144
  writeZstdSession(path.join(dshHome, 'sessions', 'sess-today'), [
    { type: 'session', version: 4, id: 'sess-today', createdAt: todayNoonMs - 1000, cwd: '/tmp/ws' },
    {
      type: 'assistant/message',
      time: todayNoonMs,
      seq: 1,
      data: {
        message: { id: 'a-today', source: { model: 'zcode/GLM-5.3' } },
        usage: { inputTokens: 36_000, outputTokens: 9_000, totalTokens: 45_000 },
      },
    },
  ]);

  // 6 days ago: 10,800 input (0.0216) + 2,700 output (0.0216) = ¥0.0432
  writeZstdSession(path.join(dshHome, 'sessions', 'sess-old'), [
    { type: 'session', version: 4, id: 'sess-old', createdAt: sixDaysAgoMs - 1000, cwd: '/tmp/ws' },
    {
      type: 'assistant/message',
      time: sixDaysAgoMs,
      seq: 1,
      data: {
        message: { id: 'a-old', source: { model: 'zcode/GLM-5.3' } },
        usage: { inputTokens: 10_800, outputTokens: 2_700, totalTokens: 13_500 },
      },
    },
  ]);

  const bridge = new HengzhangUsageBridge({ storageRoot, dshHome });
  const ovRes = await bridge.getOverview({ syncGateway: false });
  assert.equal(ovRes.enabled, true);

  const builtToday = buildReport({
    sessionId: 'sess-today',
    kind: 'session',
    sessions: [{
      id: 'sess-today',
      header: { id: 'sess-today', createdAt: todayNoonMs - 1000, cwd: '/tmp/ws' },
      rows: [
        { type: 'session', version: 4, id: 'sess-today', createdAt: todayNoonMs - 1000, cwd: '/tmp/ws' },
        {
          type: 'assistant/message',
          time: todayNoonMs,
          seq: 1,
          data: {
            message: { id: 'a-today', source: { model: 'zcode/GLM-5.3' } },
            usage: { inputTokens: 36_000, outputTokens: 9_000, totalTokens: 45_000 },
          },
        },
      ],
    }],
    pricing: defaultPricing,
  });
  const expectedTodayCost = builtToday.totals.costActualCny.total;
  assert.ok(expectedTodayCost > 0, 'today session must have non-zero priced cost');
  // Cumulative all-time total includes 6-days-ago session so it is strictly greater than today-only cost
  assert.ok(
    ovRes.overview.totals.costActualCny.total > expectedTodayCost,
    `cumulative total (${ovRes.overview.totals.costActualCny.total}) should exceed today cost (${expectedTodayCost})`,
  );
  // Server-computed `overview.today` is strictly today's cost
  assert.equal(ovRes.overview.today.costActualCny, expectedTodayCost);
  assert.equal(ovRes.overview.today.unpricedCalls, 0);

  // Frontend helper with `overview.today`
  const fromServer = computeTodayUsageSummary(ovRes.overview, undefined, todayNoonMs);
  assert.equal(fromServer.costCny, expectedTodayCost);
  assert.equal(fromServer.unknownCount, 0);

  // Frontend fallback when `overview.today` is omitted (e.g. raw overviewFor output)
  const rawOverviewNoToday = { ...ovRes.overview, today: undefined };
  const fromFallback = computeTodayUsageSummary(rawOverviewNoToday, undefined, todayNoonMs);
  assert.equal(fromFallback.costCny, expectedTodayCost);
  assert.equal(fromFallback.unknownCount, 0);

  // `extractCnyAmount` handles both production report `byModel[i].costActualCny` objects and numbers
  assert.equal(typeof builtToday.byModel[0].costActualCny, 'object');
  assert.equal(extractCnyAmount(builtToday.byModel[0].costActualCny), expectedTodayCost);
  assert.equal(extractCnyAmount(0.144), 0.144);
  assert.equal(extractCnyAmount(null), null);
});
