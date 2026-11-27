import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

globalThis[Symbol.for('leaderteam.hostImports.v1')] = {
  pluginRoot: path.join(ROOT, 'leaderteam'),
  moduleRoot: ROOT,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-v222-r3:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-v222-r3:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.5' }) };
    }
    if (url === 'virtual-v222-r3:@deepseek-ai/dsh-tools/pipeline') {
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
    if (url === 'virtual-v222-r3:@deepseek-ai/dsh-tools') {
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
    if (url === 'virtual-v222-r3:@deepseek-ai/dsh-llm') {
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
  createPublicContractHandlers,
  extractReadableMessagesFromRows,
} = await import('../../leaderteam/plugins/leaderteam-panel/public-api.mjs');
const { resolveStorageRoot } = await import('../../packages/lt-usage/index.mjs');

function makeTempDir(t, suffix = '') {
  const originCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-v222-r3-${suffix}`));
  t.after(() => {
    try {
      if (process.cwd().toLowerCase().startsWith(dir.toLowerCase())) {
        process.chdir(originCwd);
      }
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {}
  });
  return dir;
}

test('V222-R3-01 [P1]: relative storage.root stays invariant across entry-core init and read-only GET /capabilities', async t => {
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
  };
  const prevCwd = process.cwd();
  const prevDshHome = process.env.DSH_HOME;
  const cleanups = [];
  t.after(() => {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch {}
    }
    try { rt.configWatch?.close?.(); } catch {}
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

  teamStore('team-before-cap').ensure({ workspace: projectDir, surface: 'desktop' });
  assert.equal(TeamStore.exists(rootAfterInit, 'team-before-cap'), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'lt-data')), false);

  const handlers = createPublicContractHandlers(fakeCtx, rt);
  const capRes = await (
    await handlers.capabilities(new Request('http://127.0.0.1/api/lt/v1/capabilities', { method: 'GET' }))
  ).json();
  assert.equal(capRes.ok, true);
  assert.equal(rt.storageRoot, rootAfterInit);

  teamStore('team-after-cap').ensure({ workspace: projectDir, surface: 'desktop' });
  assert.equal(TeamStore.exists(rt.storageRoot, 'team-before-cap'), true);
  assert.equal(TeamStore.exists(rt.storageRoot, 'team-after-cap'), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'lt-data')), false);
});

test('V222-R3-02: DSH 0.2.2-rc.5 compaction surfaceOp replace preserves original Q&A in chronological order', () => {
  const rows = [
    {
      type: 'user/message',
      seq: 0,
      time: 1000,
      surfaceOp: 'append',
      data: { id: 'u-orig', source: { kind: 'user' }, content: [{ type: 'text', text: '原问' }] },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1100,
      surfaceOp: 'append',
      data: { message: { id: 'a-orig', source: { model: 'deepseek/deepseek-chat' }, content: [{ type: 'text', text: '原答' }] } },
    },
    {
      type: 'user/message',
      seq: 2,
      time: 1200,
      surfaceOp: 'append',
      data: { id: 'u-follow', source: { kind: 'user' }, content: [{ type: 'text', text: '追问' }] },
    },
    {
      type: 'user/message',
      seq: 3,
      time: 1300,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      data: { id: 'u-summary', source: { kind: 'compaction' }, content: [{ type: 'text', text: '摘要' }] },
    },
  ];
  const readable = extractReadableMessagesFromRows(rows);
  assert.deepEqual(
    readable.map(m => ({ id: m.id, role: m.role, text: m.text })),
    [
      { id: 'u-orig', role: 'user', text: '原问' },
      { id: 'a-orig', role: 'assistant', text: '原答' },
      { id: 'u-follow', role: 'user', text: '追问' },
    ],
  );
});

test('V222-R3-03: plan retrospectives saved 16m40s (1,000,000ms) or 0ms apart never collide or overwrite', t => {
  const tmp = makeTempDir(t, 'retro-id-');
  const ws = path.join(tmp, 'ws');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storeRoot, { recursive: true });

  const t0 = 1_764_100_123_456;
  const archive = new PlanArchiveStore(path.join(storeRoot, 'plan-archive'));
  const archived = archive.archivePlanSubmission({
    teamId: 'team-retro-v222',
    taskSeq: 1,
    workspace: ws,
    agreementId: 'agr-v222-1',
    proposalText: '# V2.2.2 Archive Plan\nVerify collision-free retrospective ids.',
    nowMs: t0 - 5000,
  });

  const r1 = archive.createRetrospective(archived.planId, { notes: '备注一', nowMs: t0 });
  const r2 = archive.createRetrospective(archived.planId, { notes: '备注二', nowMs: t0 + 1_000_000 });
  const r3 = archive.createRetrospective(archived.planId, { notes: '备注三', nowMs: t0 + 1_000_000 });

  assert.equal(new Set([r1.retroId, r2.retroId, r3.retroId]).size, 3);
  assert.equal(archive.getPlan(archived.planId).execution.retrospectiveIds.length, 3);
  assert.equal(archive.listPlans({ limit: 20 }).find(p => p.planId === archived.planId).retrospectiveCount, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive.retrospectivesDir, `${r1.retroId}.json`), 'utf8')).operatorNotes, '备注一');
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive.retrospectivesDir, `${r2.retroId}.json`), 'utf8')).operatorNotes, '备注二');
  assert.equal(JSON.parse(fs.readFileSync(path.join(archive.retrospectivesDir, `${r3.retroId}.json`), 'utf8')).operatorNotes, '备注三');
});
