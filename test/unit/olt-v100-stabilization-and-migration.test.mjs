import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/dsh-')) {
      return { url: `virtual-olt100:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'virtual-olt100:@deepseek-ai/dsh-tools/package.json') {
      return { format: 'json', shortCircuit: true, source: JSON.stringify({ version: '0.2.2-rc.5' }) };
    }
    if (url === 'virtual-olt100:@deepseek-ai/dsh-tools/pipeline') {
      return { format: 'module', shortCircuit: true, source: 'export class ToolExecutionPipeline {}' };
    }
    if (url === 'virtual-olt100:@deepseek-ai/dsh-tools') {
      return { format: 'module', shortCircuit: true, source: 'export const TOOL_ABORTED_BEFORE_DISPATCH = "aborted"; export function defineTool(x) { return x; }' };
    }
    if (url === 'virtual-olt100:@deepseek-ai/dsh-llm') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export class BlockAssembler {} export function createUserMessage(t) { return { text: t }; } export function createToolResultMessage(r) { return r; }',
      };
    }
    return nextLoad(url, context);
  },
});

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const { loadConfig, validateConfig } = await import('../../leaderteam/core/config.mjs');
const {
  DEFAULT_FIRST_OUTPUT_TIMEOUT_MS,
  resolveMemberExecutionRouteChain,
  inspectSubagentSideEffectSources,
  isMeaningfulAssistantStreamFrame,
  isRetryablePreToolMemberError,
} = await import('../../leaderteam/core/stream-stall-guard.mjs');
const {
  leaderSection,
  rollingLeaderSection,
  autonomousLeaderSection,
  memberSection,
} = await import('../../leaderteam/core/prompts.mjs');
const {
  parseReleaseTagForPlatform,
  resolveOpenSourceReleaseEpoch,
  compareOpenSourceReleases,
  selectReleasesForPlatform,
  checkForUpdates,
  performOneClickUpgrade,
  rollbackToSavedBackup,
} = await import('../../leaderteam/core/updater.mjs');
const {
  parseStandaloneReleaseTag,
  selectStandaloneReleaseForPlatform,
} = await import('../../installer/lt-installer-standalone.mjs');
const { SUPPORTED_DSH_ENGINE_RANGE, VERIFIED_CORE_VERSIONS } = await import('../../leaderteam/core/host-compat.mjs');
const { runtime, bindRuntimeConfigFile, teamStore } = await import('../../leaderteam/host/runtime.mjs');
const {
  onAgentStatus,
  onAgentAssistantStream,
  onSessionEvent,
  clearAllSubagentStreamWatchdogs,
} = await import('../../leaderteam/host/roles.mjs');
const { loadHome, overviewFor, reportFor } = await import('../../packages/lt-usage/index.mjs');

function buildTarHeader(name, size) {
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
  buf.write('0000644\0', 100, 8, 'ascii');
  buf.write('0000000\0', 108, 8, 'ascii');
  buf.write('0000000\0', 116, 8, 'ascii');
  buf.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  buf.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii');
  buf[156] = '0'.charCodeAt(0);
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return buf;
}

function createMockOltTgz({ version = '1.0.0', brandEpoch = 2, track = 'open-source' } = {}) {
  const files = new Map([
    [
      'package/package.json',
      JSON.stringify({
        name: 'dsh-leaderteam',
        version,
        license: 'Apache-2.0',
        engines: { node: '>=22.15', dsh: SUPPORTED_DSH_ENGINE_RANGE },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }, null, 2),
    ],
    [
      'package/leaderteam/package.json',
      JSON.stringify({
        name: 'dsh-leaderteam-internal',
        version,
        license: 'Apache-2.0',
        leaderteam: {
          brand: brandEpoch >= 2 ? 'Open Leader Team' : 'Leader Team',
          shortBrand: brandEpoch >= 2 ? 'OLT' : 'LT',
          brandEpoch,
          distributionTrack: track,
          supportedCoreRange: SUPPORTED_DSH_ENGINE_RANGE,
          supportedCoreVersions: [...VERIFIED_CORE_VERSIONS],
        },
      }, null, 2),
    ],
    ['package/cordis.patch.yml', '- id: leaderteam-core\n  name: dsh-leaderteam/core\n'],
  ]);
  const chunks = [];
  for (const [rel, content] of files.entries()) {
    const data = Buffer.from(content, 'utf8');
    chunks.push(buildTarHeader(rel, data.length));
    chunks.push(data);
    const rem = data.length % 512;
    if (rem > 0) chunks.push(Buffer.alloc(512 - rem, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks));
}

test('BUG-COMMON-01 & DP-08: stream-stall-guard resolves executionFallbacks and enforces 5-source zero-side-effect invariant', () => {
  assert.equal(DEFAULT_FIRST_OUTPUT_TIMEOUT_MS, 120_000);
  const baseCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/leaderteam.config.json'), 'utf8'));
  baseCfg.circuitBreaker = { ...(baseCfg.circuitBreaker ?? {}), firstOutputTimeoutMs: 90_000 };
  baseCfg.team.executionPool = ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash', 'codex/gpt-6.1-sol'];
  baseCfg.team.disabledModels = [];
  baseCfg.team.executionFallbacks = {
    'zcode/GLM-5.3': ['codex/gpt-6.1-sol', 'zcode/GLM-5.3-Flash'],
  };
  const cfg = validateConfig(baseCfg);
  assert.equal(cfg.circuitBreaker.firstOutputTimeoutMs, 90_000);

  const runtimeFilteredCfg = {
    ...cfg,
    team: { ...cfg.team, disabledModels: ['codex/gpt-6.1-sol'] },
  };
  const chain = resolveMemberExecutionRouteChain(runtimeFilteredCfg, 'zcode/GLM-5.3', 'high');
  assert.deepEqual(chain.map(x => x.route), ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash']);
  assert.equal(chain[0].isFallback, false);
  assert.equal(chain[1].isFallback, true);

  // All 5 tool/side-effect event sources == 0 -> canFallback: true
  const cleanCheck = inspectSubagentSideEffectSources({
    sessionEvents: [{ type: 'turn/start' }, { type: 'step/start' }],
    gateReceipts: [{ agentId: 'other-child', tool: 'write', decision: 'allow' }],
    memberProgressCount: 0,
    circuitState: { turnCompletedTools: [], activationCompletedTools: [] },
    childId: 'child-1',
  });
  assert.equal(cleanCheck.canFallback, true);
  assert.equal(cleanCheck.totalToolEvents, 0);

  // Any single non-zero source among the 5 immediately blocks automatic model fallback
  assert.equal(
    inspectSubagentSideEffectSources({
      sessionEvents: [{ type: 'tool/call', data: { name: 'read' } }],
      childId: 'child-1',
    }).canFallback,
    false,
  );
  assert.equal(
    inspectSubagentSideEffectSources({
      sessionEvents: [{ type: 'tool/result', data: { name: 'read' } }],
      childId: 'child-1',
    }).canFallback,
    false,
  );
  assert.equal(
    inspectSubagentSideEffectSources({
      sessionEvents: [{ type: 'assistant/message', data: { content: [{ type: 'tool-call', name: 'edit' }] } }],
      childId: 'child-1',
    }).canFallback,
    false,
  );
  const gateWriteCheck = inspectSubagentSideEffectSources({
    gateReceipts: [{ agentId: 'child-1', tool: 'write', decision: 'allow' }],
    childId: 'child-1',
  });
  assert.equal(gateWriteCheck.canFallback, false);
  assert.equal(gateWriteCheck.hasMutatingSideEffects, true);
  assert.equal(
    inspectSubagentSideEffectSources({
      memberProgressCount: 1,
      childId: 'child-1',
    }).canFallback,
    false,
  );

  // Stream frame classification & policy-refusal non-retry
  assert.equal(isMeaningfulAssistantStreamFrame({ type: 'start' }), false);
  assert.equal(isMeaningfulAssistantStreamFrame({ type: 'chunk', chunk: { type: 'ping' } }), false);
  assert.equal(isMeaningfulAssistantStreamFrame({ type: 'chunk', chunk: { delta: '' } }), false);
  assert.equal(isMeaningfulAssistantStreamFrame({ type: 'chunk', chunk: { reasoning: 'analyzing...' } }), true);
  assert.equal(isMeaningfulAssistantStreamFrame({ type: 'chunk', chunk: 'hello' }), true);
  assert.equal(isRetryablePreToolMemberError({ errorCode: 'CONTENT_REFUSED', errorMessage: 'content filter' }), false);
  assert.equal(isRetryablePreToolMemberError({ errorCode: 'UPSTREAM_503', errorMessage: 'service unavailable' }), true);
});

test('BUG-COMMON-01 runtime watchdog: 0-byte stall triggers fallback; active chunks refresh timer; post-write stall refuses fallback', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olt-stall-rt-'));
  const rt = runtime();
  try {
    const rawCfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/leaderteam.config.json'), 'utf8'));
    rawCfg.circuitBreaker = { ...(rawCfg.circuitBreaker ?? {}), firstOutputTimeoutMs: 70 };
    const cfgFile = path.join(tmpDir, 'leaderteam.config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(rawCfg, null, 2));
    bindRuntimeConfigFile(rt, cfgFile, loadConfig(cfgFile));
    rt.storageRoot = path.join(tmpDir, 'storage');
    rt.liveProcessMemberIds = new Set();

    const teamId = 'team-watchdog-1';
    const store = teamStore(teamId);
    store.ensure({ workspace: tmpDir, surface: 'headless' });

    // 1. Pre-tool 0-byte stall -> cancels hung child & invokes registered fallback spawner
    const child1 = 'child-hang-zero-tools';
    store.addMember({
      childId: child1,
      name: 'impl-a',
      taskSeq: 1,
      profile: 'code',
      preset: 'lt-member-code',
      model: 'zcode/GLM-5.3',
      effort: 'high',
      allowedTools: ['read', 'write'],
      loadedTools: ['read', 'write'],
      writeScope: ['src/**'],
      refs: [],
      task: 'Implement A',
      acceptance: ['A works'],
      cwd: tmpDir,
    });
    let cancelled1 = 0;
    let fallbackSpawned1 = 0;
    const mockAgent1 = {
      id: child1,
      status: 'running',
      session: {
        id: child1,
        header: { origin: 'subagent', parentSession: teamId, cwd: tmpDir },
        snapshotEvents: () => [{ type: 'turn/start' }, { type: 'step/start' }],
      },
      cancel() { cancelled1 += 1; },
    };
    rt.memberFallbackSpawners = new Map([
      [child1, {
        nextRoute: 'deepseek/deepseek-chat',
        nextEffort: 'medium',
        async spawnFallback() { fallbackSpawned1 += 1; },
      }],
    ]);
    onAgentStatus({}, { agent: mockAgent1, status: 'running' });
    await new Promise(r => setTimeout(r, 120));
    assert.equal(cancelled1, 1);
    assert.equal(fallbackSpawned1, 1);
    assert.equal(store.getMember(child1)?.status, 'failed');
    assert.match(store.getMember(child1)?.error ?? '', /STREAM_FIRST_OUTPUT_TIMEOUT/);
    assert.ok(store.workflowEvents().some(e => e.type === 'member-execution-fallback' && e.fromChildId === child1));

    // 2. Actively streaming chunks refresh timer and disarming on tool/call prevents false kill during long tool run
    const child2 = 'child-active-stream';
    store.addMember({
      childId: child2,
      name: 'impl-b',
      taskSeq: 1,
      profile: 'shell',
      preset: 'lt-member-shell',
      model: 'zcode/GLM-5.3',
      effort: 'high',
      allowedTools: ['read', 'pwsh'],
      loadedTools: ['read', 'pwsh'],
      writeScope: ['src/**'],
      refs: [],
      task: 'Run long test',
      acceptance: ['Tests pass'],
      cwd: tmpDir,
    });
    let cancelled2 = 0;
    const mockAgent2 = {
      id: child2,
      status: 'running',
      session: {
        id: child2,
        header: { origin: 'subagent', parentSession: teamId, cwd: tmpDir },
        snapshotEvents: () => [{ type: 'turn/start' }],
      },
      cancel() { cancelled2 += 1; },
    };
    onAgentStatus({}, { agent: mockAgent2, status: 'running' });
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 30));
      onAgentAssistantStream({}, { agent: mockAgent2, frame: { type: 'chunk', chunk: { delta: `tok-${i}` } } });
    }
    // Enter tool execution (e.g. long `npm test`) -> watchdog disarms so 120ms tool run does NOT trigger stall kill!
    onSessionEvent({}, mockAgent2.session, { type: 'tool/call', data: { name: 'pwsh' } });
    await new Promise(r => setTimeout(r, 120));
    assert.equal(cancelled2, 0);
    assert.equal(store.getMember(child2)?.status, 'running');

    // 3. Post-write mid-task 0-byte stall -> DP-08 refuses fallback, marks member `blocked`, never spawns second model
    const child3 = 'child-post-write-hang';
    store.addMember({
      childId: child3,
      name: 'impl-c',
      taskSeq: 1,
      profile: 'code',
      preset: 'lt-member-code',
      model: 'zcode/GLM-5.3',
      effort: 'high',
      allowedTools: ['read', 'write'],
      loadedTools: ['read', 'write'],
      writeScope: ['src/**'],
      refs: [],
      task: 'Partial write then hang',
      acceptance: ['Consistent'],
      cwd: tmpDir,
    });
    let cancelled3 = 0;
    let fallbackSpawned3 = 0;
    const mockAgent3 = {
      id: child3,
      status: 'running',
      session: {
        id: child3,
        header: { origin: 'subagent', parentSession: teamId, cwd: tmpDir },
        snapshotEvents: () => [
          { type: 'turn/start' },
          { type: 'tool/call', data: { name: 'write' } },
          { type: 'tool/result', data: { name: 'write' } },
          { type: 'step/start' },
        ],
      },
      cancel() { cancelled3 += 1; },
    };
    rt.memberFallbackSpawners.set(child3, {
      nextRoute: 'deepseek/deepseek-chat',
      nextEffort: 'medium',
      async spawnFallback() { fallbackSpawned3 += 1; },
    });
    onAgentStatus({}, { agent: mockAgent3, status: 'running' });
    rt.memberExecutionProgress.set(child3, new Set(['call-write-1']));
    await new Promise(r => setTimeout(r, 120));
    assert.equal(cancelled3, 1);
    assert.equal(fallbackSpawned3, 0, 'must NOT switch models after workspace write occurred');
    assert.equal(store.getMember(child3)?.status, 'blocked');
    assert.match(store.getMember(child3)?.error ?? '', /STREAM_FIRST_OUTPUT_TIMEOUT/);
  } finally {
    clearAllSubagentStreamWatchdogs(rt);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('BUG-COMMON-02 & V26-HZ-01: proportional verification rules in prompts + single loadHome pass in lt-usage', () => {
  const cfg = loadConfig(path.join(REPO_ROOT, 'config/leaderteam.config.json'));
  const autoPrompt = autonomousLeaderSection(cfg);
  const rollingPrompt = rollingLeaderSection(cfg);
  const approvalCfg = validateConfig({
    ...JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/leaderteam.config.json'), 'utf8')),
    governance: { mode: 'approval' },
    team: { ...JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config/leaderteam.config.json'), 'utf8')).team, rollingPlanning: false },
  });
  const approvalPrompt = leaderSection(approvalCfg);
  const memPrompt = memberSection({
    name: 'verifier',
    profile: 'shell',
    model: 'deepseek/deepseek-chat',
    effort: 'medium',
    allowedTools: ['read', 'pwsh'],
    loadedTools: ['read', 'pwsh'],
    writeScope: ['src/**'],
    refs: [],
    task: 'Run unit tests',
    acceptance: ['node --test passes'],
  });

  assert.match(autoPrompt, /Proportional Verification Rule/);
  assert.match(autoPrompt, /do NOT launch headless browsers/);
  assert.match(rollingPrompt, /do not launch headless browsers or screenshot probes during final verification/);
  assert.match(approvalPrompt, /do not launch headless browsers or screenshot probes during integration\/final verification/);
  assert.match(memPrompt, /Do not launch headless browsers or screenshot probes unless your assignment/);

  // V26-HZ-01: `preloadedHome` works identically with zero extra disk walks
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'olt-hz-preload-'));
  try {
    fs.mkdirSync(path.join(emptyHome, 'sessions'), { recursive: true });
    const preloaded = loadHome(emptyHome);
    const ov = overviewFor(emptyHome, { preloadedHome: preloaded });
    assert.deepEqual(ov.sessions, []);
    assert.equal(reportFor(emptyHome, 'missing-session', { preloadedHome: preloaded }), null);
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

test('Open Leader Team (OLT) V1.0.0 brand reset: seamless 2.2.3 -> 1.0.0 upgrade, 1.0.0 -> 1.0.1 detection, and 1.0.0 -> 2.2.3 rollback', async () => {
  // 1. Exact 4-key contract preserved on parseReleaseTagForPlatform + olt-* support
  assert.deepEqual(parseReleaseTagForPlatform('windows-v2.2.3'), {
    tagName: 'windows-v2.2.3',
    version: '2.2.3',
    prefix: 'windows',
    platformScope: 'win32',
  });
  assert.deepEqual(parseReleaseTagForPlatform('windows-v1.0.0'), {
    tagName: 'windows-v1.0.0',
    version: '1.0.0',
    prefix: 'windows',
    platformScope: 'win32',
  });
  assert.deepEqual(parseReleaseTagForPlatform('olt-windows-v1.0.0'), {
    tagName: 'olt-windows-v1.0.0',
    version: '1.0.0',
    prefix: 'windows',
    platformScope: 'win32',
  });
  assert.deepEqual(parseStandaloneReleaseTag('olt-linux-v1.0.0'), {
    tagName: 'olt-linux-v1.0.0',
    version: '1.0.0',
    prefix: 'linux',
    platformScope: 'linux',
  });

  // 2. Epoch comparator ordering: Legacy 2.2.3 (Epoch 1) < OLT 1.0.0 (Epoch 2) < OLT 1.0.1 (Epoch 2)
  assert.equal(resolveOpenSourceReleaseEpoch('windows-v2.2.3'), 1);
  assert.equal(resolveOpenSourceReleaseEpoch('windows-v1.0.0'), 2);
  assert.equal(resolveOpenSourceReleaseEpoch('olt-v1.0.0'), 2);
  assert.ok(compareOpenSourceReleases('windows-v1.0.0', 'windows-v2.2.3') > 0);
  assert.ok(compareOpenSourceReleases('windows-v2.2.3', 'windows-v1.0.0') < 0);
  assert.ok(compareOpenSourceReleases('windows-v1.0.1', 'windows-v1.0.0') > 0);

  const mixedReleases = [
    {
      tag_name: 'windows-v2.2.3',
      name: 'Leader Team Windows v2.2.3',
      prerelease: false,
      draft: false,
      assets: [{ name: 'dsh-leaderteam-2.2.3.tgz', browser_download_url: 'https://mock.invalid/2.2.3.tgz' }],
    },
    {
      tag_name: 'windows-v1.0.0',
      name: 'Open Leader Team (OLT) Windows v1.0.0',
      prerelease: false,
      draft: false,
      assets: [{ name: 'dsh-leaderteam-1.0.0.tgz', browser_download_url: 'https://mock.invalid/1.0.0.tgz' }],
    },
  ];
  const selectedWin = selectReleasesForPlatform(mixedReleases, { track: 'open-source', platform: 'win32' });
  assert.deepEqual(selectedWin.map(r => r.version), ['1.0.0', '2.2.3']);
  assert.equal(selectStandaloneReleaseForPlatform(mixedReleases, { platform: 'win32' })?.tag_name, 'windows-v1.0.0');

  // 3. End-to-end 2.2.3 -> 1.0.0 upgrade & 1.0.0 -> 2.2.3 offline rollback with 100% user data preservation
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olt-mig-e2e-'));
  try {
    const dshHome = path.join(tmp, 'dsh-home');
    const storageRoot = path.join(dshHome, 'leaderteam');
    fs.mkdirSync(path.join(storageRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(storageRoot, 'teams', 'hist-session-1'), { recursive: true });
    const localCfgFile = path.join(storageRoot, 'config', 'leaderteam.local.json');
    const membersFile = path.join(storageRoot, 'teams', 'hist-session-1', 'members.jsonl');
    fs.writeFileSync(localCfgFile, '{"keepUserConfig":true}\n');
    fs.writeFileSync(membersFile, '{"childId":"m-223","status":"done"}\n');

    const pluginRoot = path.join(tmp, 'installed-bundle');
    fs.mkdirSync(path.join(pluginRoot, 'leaderteam'), { recursive: true });
    const writeInstalledManifests = (ver, epoch) => {
      fs.writeFileSync(
        path.join(pluginRoot, 'package.json'),
        JSON.stringify({
          name: 'dsh-leaderteam',
          version: ver,
          license: 'Apache-2.0',
          engines: { dsh: SUPPORTED_DSH_ENGINE_RANGE },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }, null, 2),
      );
      fs.writeFileSync(
        path.join(pluginRoot, 'leaderteam', 'package.json'),
        JSON.stringify({
          name: 'dsh-leaderteam-internal',
          version: ver,
          license: 'Apache-2.0',
          leaderteam: {
            ...(epoch >= 2 ? { brand: 'Open Leader Team', shortBrand: 'OLT', brandEpoch: epoch } : {}),
            distributionTrack: 'open-source',
            supportedCoreVersions: [...VERIFIED_CORE_VERSIONS],
          },
        }, null, 2),
      );
      fs.writeFileSync(path.join(pluginRoot, 'cordis.patch.yml'), '- name: dsh-leaderteam/core\n');
    };
    writeInstalledManifests('2.2.3', 1);

    const olt100Tgz = createMockOltTgz({ version: '1.0.0', brandEpoch: 2 });
    const olt100Sha = crypto.createHash('sha256').update(olt100Tgz).digest('hex');
    const sums100 = `${olt100Sha}  dsh-leaderteam-1.0.0.tgz\n`;

    const mockFetch = async url => {
      const u = String(url);
      if (u.includes('/releases')) {
        return Response.json([
          {
            tag_name: 'windows-v2.2.3',
            name: 'Leader Team v2.2.3',
            prerelease: false,
            assets: [{ name: 'dsh-leaderteam-2.2.3.tgz', browser_download_url: 'https://mock.olt/2.2.3.tgz' }],
          },
          {
            tag_name: 'windows-v1.0.0',
            name: 'Open Leader Team (OLT) v1.0.0',
            prerelease: false,
            body: 'Brand reset to Open Leader Team V1.0.0',
            assets: [
              { name: 'dsh-leaderteam-1.0.0.tgz', size: olt100Tgz.length, browser_download_url: 'https://mock.olt/1.0.0.tgz' },
              { name: 'SHA256SUMS.txt', size: sums100.length, browser_download_url: 'https://mock.olt/SHA256SUMS.txt' },
            ],
          },
        ]);
      }
      if (u === 'https://mock.olt/1.0.0.tgz') return new Response(olt100Tgz, { status: 200 });
      if (u === 'https://mock.olt/SHA256SUMS.txt') return new Response(sums100, { status: 200 });
      return new Response('Not found', { status: 404 });
    };

    // Installed 2.2.3 sees OLT 1.0.0 as an available upgrade!
    const checkFrom223 = await checkForUpdates({
      pluginRoot,
      storageRoot,
      platform: 'win32',
      force: true,
      currentHostVersion: '0.2.2-rc.1',
      fetchImpl: mockFetch,
    });
    assert.equal(checkFrom223.hasUpdate, true);
    assert.equal(checkFrom223.latestRelease?.version, '1.0.0');

    const upg = await performOneClickUpgrade({
      pluginRoot,
      storageRoot,
      dshHome,
      platform: 'win32',
      currentHostVersion: '0.2.2-rc.1',
      fetchImpl: mockFetch,
      installerHook: async () => {
        writeInstalledManifests('1.0.0', 2);
      },
    });
    assert.equal(upg.ok, true);
    assert.equal(upg.fromVersion, '2.2.3');
    assert.equal(upg.toVersion, '1.0.0');

    // Once on OLT 1.0.0, historical 2.2.3 in the same GitHub feed is NOT treated as newer!
    const checkOn100 = await checkForUpdates({
      pluginRoot,
      storageRoot,
      platform: 'win32',
      force: true,
      currentHostVersion: '0.2.2-rc.1',
      fetchImpl: mockFetch,
    });
    assert.equal(checkOn100.installedVersion, '1.0.0');
    assert.equal(checkOn100.hasUpdate, false);

    // Offline rollback from OLT 1.0.0 -> Leader Team 2.2.3 restores 2.2.3 cleanly and preserves all user history
    const rb = await rollbackToSavedBackup({
      storageRoot,
      dshHome,
      backupId: upg.backupId,
      installerHook: async ({ spec }) => {
        const snapPkg = JSON.parse(fs.readFileSync(path.join(spec, 'package.json'), 'utf8'));
        writeInstalledManifests(snapPkg.version, 1);
      },
    });
    assert.equal(rb.ok, true);
    assert.equal(rb.restoredVersion, '2.2.3');
    assert.equal(fs.readFileSync(localCfgFile, 'utf8'), '{"keepUserConfig":true}\n');
    assert.equal(fs.readFileSync(membersFile, 'utf8'), '{"childId":"m-223","status":"done"}\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 4. Verify CLI aliases & launcher scripts exist on disk
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const binName of ['lt-doctor', 'olt-doctor', 'lt-bugreport', 'olt-bugreport', 'lt-ui', 'olt-ui', 'lt-installer', 'olt-installer', 'lt-update', 'olt-update']) {
    assert.ok(rootPkg.bin[binName], `bin ${binName} declared`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rootPkg.bin[binName])), `bin target for ${binName} exists`);
  }
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'Install-OpenLeaderTeam.cmd')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'install-open-leaderteam.sh')));
});
