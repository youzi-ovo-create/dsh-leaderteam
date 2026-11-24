// Comprehensive regression suite reproducing and verifying all 15 findings from the 6.2 Astra V2.2 audit (1 P0 + 10 P1 + 4 P2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig, validateConfig } from '../../leaderteam/core/config.mjs';
import { TeamStore } from '../../leaderteam/core/store.mjs';
import { replayGovernanceState } from '../../leaderteam/core/governance-protocol.mjs';
import {
  LEGACY_PATCH_BEGIN,
  LEGACY_PATCH_END,
  detectLegacyProfilePatchConflicts,
  cleanLegacyProfilePatches,
} from '../../leaderteam/core/legacy-patch-guard.mjs';
import { buildSoloKeyStarterConfig, buildSoloProviderSettingsTemplates, SOLO_PROVIDER_PRESETS } from '../../leaderteam/core/solo-key.mjs';
import { syncUpstreamModelsToDshSettings } from '../../leaderteam/core/upstream-models.mjs';
import { scanPosixShell, classifySandboxBoundary } from '../../leaderteam/core/gate-policy.mjs';
import { parseQuotaState, routeQuota, routeQuota5hWindow } from '../../leaderteam/core/quota.mjs';

import { locateHostAnchor, bindHostImports } from '../../leaderteam/host/host-imports.mjs';
import { readSystemPowerSample } from '../../leaderteam/host/power-adapter.mjs';
import { assertNoLegacyDesktopPatchOverride } from '../../leaderteam/plugins/leaderteam-panel/index.mjs';
import { resolveSendMessageTargetId } from '../../leaderteam/host/activation.mjs';
import { refreshUpstreamCatalog } from '../../leaderteam/host/runtime.mjs';

import { runDoctorChecks } from '../../bin/lt-doctor.mjs';
import { redactDiagnosticText, generateRedactedBugReport } from '../../bin/lt-bugreport.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const INTERNAL_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'leaderteam', 'package.json'), 'utf8'));
const BASE_RAW_CFG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'), 'utf8'));

const VALID_PIPELINE_SRC = `
class ToolExecutionPipeline {
  resolveExecution() {}
  async dispatchToolBody(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet);
    return await tool.execute(exec.arguments, exec);
  }
}
`;

// Self-contained suite-wide mock DSH 0.2.2-rc.5 host so this unit file runs 100% standalone offline on Windows & Linux.
const SUITE_MOCK_HOST = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-astra-suite-host-'));
{
  const toolsDir = path.join(SUITE_MOCK_HOST, 'node_modules', '@deepseek-ai', 'dsh-tools');
  const llmDir = path.join(SUITE_MOCK_HOST, 'node_modules', '@deepseek-ai', 'dsh-llm');
  const execDir = path.join(SUITE_MOCK_HOST, 'node_modules', '@deepseek-ai', 'dsh-tool-executor-native');
  fs.mkdirSync(path.join(toolsDir, 'lib'), { recursive: true });
  fs.mkdirSync(llmDir, { recursive: true });
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(SUITE_MOCK_HOST, 'package.json'), JSON.stringify({ name: 'mock-dsh-host', version: '0.2.2-rc.5' }));
  fs.writeFileSync(path.join(toolsDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tools',
    version: '0.2.2-rc.5',
    type: 'module',
    exports: { '.': './index.js', './pipeline': './lib/pipeline.js', './package.json': './package.json' },
  }));
  fs.writeFileSync(path.join(toolsDir, 'index.js'), 'export const TOOL_ABORTED_BEFORE_DISPATCH = "ABORT"; export const defineTool = d => d;\n');
  fs.writeFileSync(path.join(toolsDir, 'lib', 'pipeline.js'), `export ${VALID_PIPELINE_SRC}`);
  fs.writeFileSync(path.join(llmDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.2.2-rc.5', type: 'module', main: './index.js' }));
  fs.writeFileSync(
    path.join(llmDir, 'index.js'),
    [
      'export const createUserMessage = x => x;',
      'export const boundContextSummary = x => x;',
      'export class BlockAssembler {',
      '  constructor() { this._text = ""; }',
      '  push(c) { if (c?.type === "text-delta" && typeof c.text === "string") this._text += c.text; }',
      '  blocks() { return this._text ? [{ type: "text", text: this._text }] : []; }',
      '}',
    ].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(execDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-executor-native', version: '0.2.2-rc.5', type: 'module', main: './index.js' }));
  fs.writeFileSync(path.join(execDir, 'index.js'), 'export default {};\n');

  const prevModRoot = process.env.LT_DSH_MODULE_ROOT;
  process.env.LT_DSH_MODULE_ROOT = SUITE_MOCK_HOST;
  try {
    bindHostImports();
  } finally {
    if (prevModRoot === undefined) delete process.env.LT_DSH_MODULE_ROOT;
    else process.env.LT_DSH_MODULE_ROOT = prevModRoot;
  }
}
test.after(() => {
  fs.rmSync(SUITE_MOCK_HOST, { recursive: true, force: true });
});

// ============================================================================
// T1 (P0): Autonomous dual supervision NEVER converts failed reviewers to `endorse`
// ============================================================================
test('P0: queueAsyncSupervision defers when one or both reviewers fail, preserves single valid side, and settles only with two real opinions', async () => {
  const tmpStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p0-store-'));
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p0-ws-'));
  try {
    const { queueAsyncSupervision, retryDeferredSupervisions } = await import('../../leaderteam/host/governance.mjs');

    fs.writeFileSync(path.join(tmpWs, 'app.js'), 'export const x = 1;\n', 'utf8');
    // Distinct models for discussA (`deepseek/deepseek-v4-pro`) and discussB (`deepseek/deepseek-flash`) with zero fallbacks so we control each reviewer cleanly
    const customRaw = buildSoloKeyStarterConfig(BASE_RAW_CFG, { preset: SOLO_PROVIDER_PRESETS[0] });
    customRaw.roles.discussA.fallback = [];
    customRaw.roles.discussA.retries = 0;
    customRaw.roles.discussB.fallback = [];
    customRaw.roles.discussB.retries = 0;
    customRaw.team.leaderModelAsLastResort = false;
    const cfg = validateConfig(customRaw);

    let mode = 'both_fail';
    let callsA = 0;
    let callsB = 0;
    const mockLlm = {
      async *stream(req) {
        const isA = req.model === 'deepseek-v4-pro';
        if (isA) callsA++;
        else callsB++;
        if (mode === 'both_fail') {
          throw new Error('503 upstream overloaded');
        }
        if (mode === 'a_ok_b_fail') {
          if (!isA) throw new Error('429 reviewer B rate limited');
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              stance: 'comment',
              intervene: false,
              summary: 'Reviewer A real concern',
              concerns: ['Check boundary null case'],
              suggestions: ['Add guard'],
              target_paths: ['app.js'],
            }),
          };
          yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        const summary = isA ? 'Reviewer A valid opinion' : 'Reviewer B valid opinion';
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            stance: 'endorse',
            intervene: false,
            summary,
            concerns: [],
            suggestions: [],
            target_paths: ['app.js'],
          }),
        };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };

    const store = new TeamStore(tmpStoreRoot, 'team-p0');
    store.ensure({ workspace: tmpWs, surface: 'headless' });
    const fakeRt = {
      config: cfg,
      storageRoot: tmpStoreRoot,
      llm: mockLlm,
      planningDisposed: false,
      governanceJobs: new Map(),
      supervisedDigests: new Set(),
      inFlightSupervisionKeys: new Set(),
      partialSupervisionOpinions: new Map(),
    };
    const actor = { role: 'leader', teamId: 'team-p0', cwd: tmpWs };

    // 1. Both reviewers fail -> MUST record `supervision-deferred`, ZERO `supervision-completed`, ZERO fake `endorse`!
    const run1 = queueAsyncSupervision({
      ctx: {},
      rt: fakeRt,
      store,
      actor,
      leaderAgent: null,
      taskSeq: 1,
      phaseKind: 'delivery',
      targets: ['app.js'],
      summary: 'Final delivery check',
      proposal: 'Implemented app.js',
    });
    const res1 = await run1.promise;
    assert.equal(res1.status, 'deferred');
    assert.deepEqual(res1.missingReviewers, ['discussA', 'discussB']);
    assert.equal(store.governanceEvents().filter(e => e.type === 'supervision-completed').length, 0);
    const gov1 = replayGovernanceState(store.governanceEvents(), 1);
    assert.equal(gov1.completedSupervisionCount, 0);
    assert.equal(gov1.pendingSupervisions.length, 1);

    // 2. Retry when A succeeds and B fails -> still deferred, A's valid opinion cached!
    mode = 'a_ok_b_fail';
    const retried1 = retryDeferredSupervisions({ ctx: {}, rt: fakeRt, store, actor, leaderAgent: null, taskSeq: 1 });
    assert.equal(retried1.length, 1);
    const res2 = await retried1[0].promise;
    assert.equal(res2.status, 'deferred');
    assert.deepEqual(res2.missingReviewers, ['discussB']);
    assert.equal(store.governanceEvents().filter(e => e.type === 'supervision-completed').length, 0);
    const gov2 = replayGovernanceState(store.governanceEvents(), 1);
    assert.equal(gov2.pendingSupervisions.length, 1);
    assert.equal(gov2.pendingSupervisions[0].hasValidOpinionA, true);
    assert.equal(gov2.pendingSupervisions[0].hasValidOpinionB, false);

    // 3. Reviewer B recovers -> retry reuses A's cached valid opinion (callsA does not increase!) and finally emits `supervision-completed`!
    const callsABeforeRecovery = callsA;
    mode = 'both_ok';
    const retried2 = retryDeferredSupervisions({ ctx: {}, rt: fakeRt, store, actor, leaderAgent: null, taskSeq: 1 });
    assert.equal(retried2.length, 1);
    const res3 = await retried2[0].promise;
    assert.equal(res3.status, 'advisory');
    assert.equal(callsA, callsABeforeRecovery, 'cached valid opinionA must not be re-billed');
    const completedEvs = store.governanceEvents().filter(e => e.type === 'supervision-completed');
    assert.equal(completedEvs.length, 1);
    assert.equal(completedEvs[0].opinionA.summary, 'Reviewer A real concern');
    assert.equal(completedEvs[0].opinionB.summary, 'Reviewer B valid opinion');
    const gov3 = replayGovernanceState(store.governanceEvents(), 1);
    assert.equal(gov3.pendingSupervisions.length, 0);
    assert.equal(gov3.completedSupervisionCount, 1);
  } finally {
    fs.rmSync(tmpStoreRoot, { recursive: true, force: true });
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ============================================================================
// T2 (P1-1): Legacy Desktop profile patch conflict guard & `--clean-legacy-patch`
// ============================================================================
test('P1-1: detects legacy V2.1 cordis.patch.yml override, locks gate Fail-Closed on conflict, and cleans cleanly with backup', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-legacy-patch-'));
  try {
    const profileDir = path.join(tmpHome, 'profiles', 'desktop');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dsh: { profile: { bundles: ['dsh-leaderteam'] } },
    }, null, 2));
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    const userOutsideLine = '- id: custom-user-row\n  disabled: false\n';
    const legacyBlock = [
      userOutsideLine.trimEnd(),
      LEGACY_PATCH_BEGIN,
      '- id: leaderteam-core',
      '  name: "file:///C:/old-lt-v2.1/leaderteam/entry-core.mjs"',
      LEGACY_PATCH_END,
      '',
    ].join('\n');
    fs.writeFileSync(patchFile, legacyBlock, 'utf8');

    const conflicts = detectLegacyProfilePatchConflicts({ dshHome: tmpHome, currentBundleRoot: REPO_ROOT });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].bundleInstalled, true);
    assert.equal(conflicts[0].hasManagedBlock, true);

    // Runtime conflict guard locks `rt.gate` Fail-Closed so stale V2.1 gate cannot run silently
    const fakeRt = {
      startupReady: { coreVersion: '2.1.1' },
      gate: { actorFor: () => ({ role: 'leader', teamId: 't1' }), decide: async () => ({ decision: 'allow' }) },
    };
    assert.throws(
      () => assertNoLegacyDesktopPatchOverride({ leaderteamReady: { coreVersion: '2.1.1' } }, fakeRt, { dshHome: tmpHome, expectedVersion: '2.2.0' }),
      /Legacy LeaderTeam profile patch override detected/,
    );
    assert.equal(fakeRt.startupReady, null);
    const lockedVerdict = await fakeRt.gate.decide();
    assert.equal(lockedVerdict.decision, 'deny');
    assert.equal(lockedVerdict.by, 'legacy-profile-patch-conflict');

    // Doctor fails before cleaning and passes after cleaning
    const docBefore = runDoctorChecks({
      nodeVersion: '22.19.0',
      platform: 'linux',
      dshHome: tmpHome,
      execFileSyncImpl: () => 'bash 5.2',
      env: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(docBefore.checks.configuration.status, 'fail');
    assert.match(docBefore.checks.configuration.summary, /clean-legacy-patch/);

    const cleaned = cleanLegacyProfilePatches({ dshHome: tmpHome });
    assert.equal(cleaned.length, 1);
    assert.equal(fs.existsSync(cleaned[0].backupFile), true);
    const afterText = fs.readFileSync(patchFile, 'utf8');
    assert.equal(afterText.includes('leaderteam-core'), false);
    assert.equal(afterText.includes('custom-user-row'), true);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ============================================================================
// T3 (P1-2): Strict non-hoisted pnpm layout (`@deepseek-ai/dsh` -> `@deepseek-ai/dsh-base` -> `dsh-tools`)
// ============================================================================
test('P1-2: locateHostAnchor and lt-doctor resolve strict non-hoisted pnpm layout via dsh-base carrier hop', () => {
  const pnpmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-strict-pnpm-'));
  try {
    // Simulate strict `hoist=false` pnpm virtual store:
    // `<pnpmRoot>/node_modules/@deepseek-ai/dsh` ONLY sees `@deepseek-ai/dsh-base` (NOT `dsh-tools`),
    // and `@deepseek-ai/dsh-base`'s virtual node_modules holds `dsh-tools`, `dsh-llm`, `dsh-tool-executor-native`.
    const storeDshNm = path.join(pnpmRoot, '.pnpm', 'dsh@0.2.2-rc.5', 'node_modules', '@deepseek-ai');
    const storeBaseNm = path.join(pnpmRoot, '.pnpm', 'dsh-base@0.2.2-rc.5', 'node_modules', '@deepseek-ai');

    const dshDir = path.join(storeDshNm, 'dsh');
    const baseLinkInDsh = path.join(storeDshNm, 'dsh-base');
    const baseDir = path.join(storeBaseNm, 'dsh-base');
    const toolsDir = path.join(storeBaseNm, 'dsh-tools');
    const llmDir = path.join(storeBaseNm, 'dsh-llm');
    const execDir = path.join(storeBaseNm, 'dsh-tool-executor-native');

    fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true });
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(path.join(toolsDir, 'lib'), { recursive: true });
    fs.mkdirSync(llmDir, { recursive: true });
    fs.mkdirSync(execDir, { recursive: true });

    fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5', dependencies: { '@deepseek-ai/dsh-base': '0.2.2-rc.5' } }));
    fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '// cli entry\n');
    fs.writeFileSync(path.join(baseDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.5' }));
    fs.writeFileSync(path.join(toolsDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.2-rc.5', exports: { './package.json': './package.json' } }));
    fs.writeFileSync(path.join(toolsDir, 'lib', 'pipeline.js'), VALID_PIPELINE_SRC);
    fs.writeFileSync(path.join(llmDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.2.2-rc.5', main: './index.js' }));
    fs.writeFileSync(path.join(llmDir, 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(execDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-executor-native', version: '0.2.2-rc.5', main: './index.js' }));
    fs.writeFileSync(path.join(execDir, 'index.js'), 'export {};\n');

    const junctionType = process.platform === 'win32' ? 'junction' : 'dir';
    const topDshParent = path.join(pnpmRoot, 'node_modules', '@deepseek-ai');
    fs.mkdirSync(topDshParent, { recursive: true });
    let entryBinPath;
    try {
      fs.symlinkSync(baseDir, baseLinkInDsh, junctionType);
      fs.symlinkSync(dshDir, path.join(topDshParent, 'dsh'), junctionType);
      entryBinPath = path.join(topDshParent, 'dsh', 'lib', 'bin.js');
    } catch (err) {
      if (err?.code !== 'EPERM') throw err;
      // Restricted Windows AppContainer fallback: build an equivalent non-hoisted nested tree without symlinks
      const nestedDsh = path.join(topDshParent, 'dsh');
      const nestedBase = path.join(nestedDsh, 'node_modules', '@deepseek-ai', 'dsh-base');
      const nestedBasePeers = path.join(nestedBase, 'node_modules', '@deepseek-ai');
      fs.cpSync(dshDir, nestedDsh, { recursive: true });
      fs.cpSync(baseDir, nestedBase, { recursive: true });
      fs.mkdirSync(nestedBasePeers, { recursive: true });
      fs.cpSync(toolsDir, path.join(nestedBasePeers, 'dsh-tools'), { recursive: true });
      fs.cpSync(llmDir, path.join(nestedBasePeers, 'dsh-llm'), { recursive: true });
      fs.cpSync(execDir, path.join(nestedBasePeers, 'dsh-tool-executor-native'), { recursive: true });
      entryBinPath = path.join(nestedDsh, 'lib', 'bin.js');
    }
    fs.writeFileSync(path.join(pnpmRoot, 'package.json'), JSON.stringify({ name: 'strict-pnpm-workspace', private: true }));

    const found = locateHostAnchor({
      execPath: process.execPath,
      argv: [process.execPath, entryBinPath],
      env: {},
      pluginRoot: path.join(pnpmRoot, 'isolated-plugin'),
    });
    assert.ok(found, 'strict non-hoisted pnpm layout must resolve anchor');
    assert.match(found.anchor, /dsh-base\/package\.json$/);

    const doc = runDoctorChecks({
      checkHost: pnpmRoot,
      nodeVersion: '22.19.0',
      platform: 'linux',
      execFileSyncImpl: () => 'bash 5.2',
      env: { DEEPSEEK_API_KEY: 'sk-pnpm' },
    });
    assert.equal(doc.checks.dshHost.classification, 'VERIFIED');
    assert.equal(doc.checks.dshHost.toolsVersion, '0.2.2-rc.5');
  } finally {
    fs.rmSync(pnpmRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// T4 (P1-3): Production whitelist strictly limited to E2E-verified `0.2.2-rc.1` & `0.2.2-rc.5`
// ============================================================================
test('P1-3: supportedCoreVersions and engines.dsh admit ONLY E2E-verified 0.2.2-rc.1 and 0.2.2-rc.5', async () => {
  assert.deepEqual(INTERNAL_PKG.leaderteam.supportedCoreVersions, ['0.2.2-rc.1', '0.2.2-rc.5']);
  assert.equal(ROOT_PKG.engines.dsh, '0.2.2-rc.1 || 0.2.2-rc.5');
  const { assertCompatiblePipeline } = await import('../../leaderteam/host/final-gate.mjs');
  const fakeProto = {
    resolveExecution() {},
    dispatchToolBody: new Function('exec', 'const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet); return (async () => await tool.execute(exec.arguments, exec))();'),
  };
  for (const unverified of ['0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.4', '0.2.3']) {
    assert.throws(
      () => assertCompatiblePipeline(fakeProto, unverified, INTERNAL_PKG.leaderteam.supportedCoreVersions),
      /not a verified core version/,
    );
  }
});

// ============================================================================
// T5 (P1-4): Solo-Key `DEEPSEEK_API_KEY` auto-registers provider & models in clean DSH settings
// ============================================================================
test('P1-4: Solo-Key DEEPSEEK_API_KEY auto-provisions providers.deepseek with compat flags in empty llm-pi-ai settings', async () => {
  const soloCfg = buildSoloKeyStarterConfig(BASE_RAW_CFG, { preset: SOLO_PROVIDER_PRESETS[0] });
  const providerTemplates = buildSoloProviderSettingsTemplates({ DEEPSEEK_API_KEY: 'sk-live-deepseek' });

  let savedNs = null;
  let savedData = null;
  const mockSettings = {
    describe() {
      return { namespaces: [{ ns: 'llm-pi-ai', data: { providers: {} } }] };
    },
    async update(ns, nextData) {
      savedNs = ns;
      savedData = nextData;
    },
  };
  const mockCtx = { get: name => (name === 'settings' ? mockSettings : null) };
  const modelsToSync = Object.entries(soloCfg.models).map(([route, spec]) => ({
    route,
    provider: spec.provider,
    upstreamModel: spec.upstreamModel,
    efforts: spec.efforts,
    vision: spec.vision,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  }));

  const res = await syncUpstreamModelsToDshSettings(mockCtx, modelsToSync, 'deepseek', { providerTemplates });
  assert.equal(res.synced, true);
  assert.equal(res.changed, true);
  assert.equal(savedNs, 'llm-pi-ai');
  assert.ok(savedData?.providers?.deepseek, 'providers.deepseek must be created when absent');
  assert.equal(savedData.providers.deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(savedData.providers.deepseek.baseURL, 'https://api.deepseek.com');
  const reasoner = savedData.providers.deepseek.models.find(m => m.id === 'deepseek-v4-pro');
  const chat = savedData.providers.deepseek.models.find(m => m.id === 'deepseek-flash');
  assert.ok(reasoner && chat);
  assert.equal(reasoner.compat?.thinkingFormat, 'deepseek');
  assert.equal(reasoner.compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(chat.reasoningEfforts, false);
});

// ============================================================================
// T6 (P1-5): `rc.5` `send_message` split-brain prevented when reusing member name across taskSeq
// ============================================================================
test('P1-5: startSubagentCompat allocates deterministic hostAgentName on DUPLICATE_AGENT_NAME and resolves current task target', async () => {
  const { startSubagentCompat } = await import('../../leaderteam/host/team-tools.mjs');
  const tmpStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-p1-5-'));
  try {
    const catalog = new Map();
    const mockSubagents = {
      resolveName(_caller, name) { return catalog.get(name); },
      async startActivation(spec) {
        if (spec.name && catalog.has(spec.name)) {
          const err = new Error(`duplicate agent name: ${spec.name}`);
          err.code = 'DUPLICATE_AGENT_NAME';
          throw err;
        }
        if (spec.name) catalog.set(spec.name, spec.childId);
        return { childId: spec.childId };
      },
    };

    const s1 = await startSubagentCompat(mockSubagents, {
      provider: 'spawn',
      childId: 'uuid-task1-impl',
      name: 'impl',
      taskSeq: 1,
      label: 'impl',
      delivery: 'parent',
      prompt: [],
    });
    assert.equal(s1.hostAgentName, 'impl');
    assert.equal(catalog.get('impl'), 'uuid-task1-impl');

    const s2 = await startSubagentCompat(mockSubagents, {
      provider: 'spawn',
      childId: 'uuid-task2-impl',
      name: 'impl',
      taskSeq: 2,
      label: 'impl',
      delivery: 'parent',
      prompt: [],
    });
    assert.equal(s2.hostAgentName, 'impl-t2');
    assert.equal(catalog.get('impl-t2'), 'uuid-task2-impl');
    assert.equal(catalog.get('impl'), 'uuid-task1-impl');

    const store = new TeamStore(tmpStoreDir, 'team-split');
    store.ensure({ workspace: tmpStoreDir, surface: 'headless' });
    store.addMember({ childId: 'uuid-task1-impl', name: 'impl', taskSeq: 1, profile: 'code', writeScope: ['a/**'] });
    store.setMemberHostName('uuid-task1-impl', s1.hostAgentName);
    store.setMemberStatus('uuid-task1-impl', 'done');

    store.addMember({ childId: 'uuid-task2-impl', name: 'impl', taskSeq: 2, profile: 'code', writeScope: ['b/**'] });
    store.setMemberHostName('uuid-task2-impl', s2.hostAgentName);
    store.setMemberStatus('uuid-task2-impl', 'done');

    const targetInTask2 = resolveSendMessageTargetId(store, { agent: 'impl', message: 'hi' }, 2);
    assert.equal(targetInTask2, 'uuid-task2-impl');
    const targetMember2 = store.getMember(targetInTask2);
    assert.equal(targetMember2.hostAgentName, 'impl-t2');
    assert.equal(mockSubagents.resolveName(null, targetMember2.hostAgentName), 'uuid-task2-impl');
  } finally {
    fs.rmSync(tmpStoreDir, { recursive: true, force: true });
  }
});

// ============================================================================
// T7 & T8 (P1-6 & P1-7): `entry-lead` respects disabled `interrupt_agent` & reference-counts wait hooks
// ============================================================================
test('P1-6 & P1-7: entry-lead never re-registers disabled interrupt_agent and ref-counts multi-leader waitForTreeWork hooks', async () => {
  const leadMod = await import('../../leaderteam/entry-lead.mjs');
  const registeredToolsA = new Map();
  const registeredToolsB = new Map();
  const cleanupsA = [];
  const cleanupsB = [];

  const origWaitCalls = [];
  const sharedSubagents = {
    resolveName: async () => 'id-1',
    interrupt: () => {},
    async waitForTreeWork(parent) {
      origWaitCalls.push(parent?.id ?? null);
      return false;
    },
  };
  const originalMethodRef = sharedSubagents.waitForTreeWork;

  const makeCtx = (toolMap, cleanups) => ({
    subagents: sharedSubagents,
    tools: {
      get: name => toolMap.get(name),
      register: def => {
        toolMap.set(def.name, def);
        return () => toolMap.delete(def.name);
      },
    },
    effect: fn => {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
    },
  });

  leadMod.apply(makeCtx(registeredToolsA, cleanupsA));
  leadMod.apply(makeCtx(registeredToolsB, cleanupsB));

  // P1-6: `interrupt_agent` was NOT in `toolMap` (explicitly disabled by host config) -> must remain absent!
  assert.equal(registeredToolsA.has('interrupt_agent'), false);
  assert.equal(registeredToolsB.has('interrupt_agent'), false);

  // P1-7: Disposing Leader A while Leader B is still mounted MUST keep review-quiescence wait hook active for B!
  const { runtime } = await import('../../leaderteam/host/runtime.mjs');
  const rt = runtime();
  rt.governanceJobs ??= new Map();
  let govResolved = false;
  rt.governanceJobs.set('sup-test-b', {
    teamId: 'leader-b',
    promise: new Promise(r => setTimeout(() => { govResolved = true; r(); }, 20)),
  });

  for (const fn of cleanupsA.reverse()) fn();
  assert.notEqual(sharedSubagents.waitForTreeWork, originalMethodRef, 'wait hook must stay mounted while Leader B is active');
  assert.equal(rt.subagents, sharedSubagents, 'runtime().subagents must remain bound while Leader B is active');

  const joinedForB = await sharedSubagents.waitForTreeWork({ id: 'leader-b' });
  assert.equal(joinedForB, true);
  assert.equal(govResolved, true);
  rt.governanceJobs.delete('sup-test-b');

  // Disposing Leader B (last reference) cleanly restores original method!
  for (const fn of cleanupsB.reverse()) fn();
  assert.equal(sharedSubagents.waitForTreeWork, originalMethodRef, 'original waitForTreeWork must be restored after last leader unmounts');
});

// ============================================================================
// T9 (P1-8): Shell tokenizer never hangs on Unicode / vertical whitespace (`pwsh` & `bash`)
// ============================================================================
test('P1-8: scanPosixShell and classifySandboxBoundary handle NBSP, vertical tab, form feed, and ideographic space in <20ms', () => {
  const tricky = 'echo\u00A0"hello"\v&&\fgit\u2003status\u3000src/index.js';
  const t0 = Date.now();
  const scanned = scanPosixShell(tricky, { treatBacktickAsSubstitution: false });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `tokenizer took ${elapsed}ms`);
  assert.ok(scanned.tokens.some(t => t.type === 'word' && t.value === 'echo'));
  assert.ok(scanned.tokens.some(t => t.type === 'word' && t.value === 'git'));

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pwsh-ws-'));
  try {
    const cfg = loadConfig(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'));
    const res = classifySandboxBoundary({
      tool: 'pwsh',
      args: { command: `Write-Output\u00A0"ok"\v;\u3000Get-ChildItem\fsrc` },
      actor: { role: 'member', profile: 'shell', cwd: tmpWs, writeScope: ['src/**'], allowedTools: ['pwsh', 'read'] },
      cwd: tmpWs,
      platform: 'win32',
    }, cfg);
    assert.equal(typeof res.confined, 'boolean');
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ============================================================================
// T10 (P1-9): Multi-team low-battery delivery & post-AC auto-wakeup block
// ============================================================================
test('P1-9: low-battery delivers per-team without dropping busy leaders and blocks scale-up wakeups after AC reconnect until user message', async () => {
  const {
    pollAndDeliverPowerMonitor,
    onLeaderTurnCompleted,
    maybeNotifyLeaderScaleUp,
    clearPowerPauseForTeamOnUserMessage,
    isTeamAwaitingUserAfterPowerPause,
  } = await import('../../leaderteam/host/concurrency.mjs');
  const { runtime } = await import('../../leaderteam/host/runtime.mjs');

  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-power-multi-'));
  const rt = runtime();
  const prevSnap = {
    config: rt.config,
    storageRoot: rt.storageRoot,
    powerMonitorState: rt.powerMonitorState,
    actors: new Map(rt.actors),
  };
  try {
    const cfg = loadConfig(path.join(REPO_ROOT, 'config', 'leaderteam.config.json'));
    rt.config = cfg;
    rt.storageRoot = tmpStore;
    rt.powerMonitorState = null;
    rt.actors.clear();

    const inboxA = [];
    const inboxB = [];
    const agentA = { id: 'team-a', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup: m => inboxA.push(m), session: { snapshotEvents: () => [] } };
    const agentB = { id: 'team-b', status: 'running', inbox: { nextTurn: [], nextStep: [] }, followup: m => inboxB.push(m), session: { snapshotEvents: () => [] } };

    new TeamStore(tmpStore, 'team-a').ensure({ workspace: tmpStore, surface: 'desktop' });
    new TeamStore(tmpStore, 'team-b').ensure({ workspace: tmpStore, surface: 'desktop' });
    rt.actors.set('team-a', { role: 'leader', teamId: 'team-a', agent: agentA });
    rt.actors.set('team-b', { role: 'leader', teamId: 'team-b', agent: agentB });

    // 1. Battery drops to 16%: idle Team A receives notice immediately; busy Team B stays in `pendingTeams`!
    await pollAndDeliverPowerMonitor({}, rt, {
      sample: { status: 'ok', onBattery: true, batteryPct: 16 },
      nowMs: 1000,
    });
    assert.equal(inboxA.length, 1);
    assert.equal(inboxB.length, 0);
    assert.equal(rt.powerMonitorState.pendingNotice, true);
    assert.deepEqual(rt.powerMonitorState.pendingTeams, ['team-b']);

    // 2. Team B finishes its turn and becomes idle -> receives its deferred low-battery notice!
    agentB.status = 'idle';
    onLeaderTurnCompleted({}, 'team-b');
    assert.equal(inboxB.length, 1);
    assert.equal(rt.powerMonitorState.pendingNotice, false);
    assert.deepEqual(rt.powerMonitorState.pendingTeams, []);

    // 3. AC power reconnects (`rearmed`): `latched` becomes false, BUT `pausedTeamsAwaitingUser` keeps BOTH teams paused!
    const rearmed = await pollAndDeliverPowerMonitor({}, rt, {
      sample: { status: 'ok', onBattery: false, batteryPct: 50 },
      nowMs: 2000,
    });
    assert.equal(rearmed.action, 'rearmed');
    assert.equal(rt.powerMonitorState.latched, false);
    assert.equal(isTeamAwaitingUserAfterPowerPause(rt, 'team-a'), true);
    assert.equal(isTeamAwaitingUserAfterPowerPause(rt, 'team-b'), true);
    assert.equal(maybeNotifyLeaderScaleUp({}, 'team-a', { userCapRaised: true }), false);

    // 4. User sends message to Team A -> ONLY Team A clears its pause hold; Team B remains paused!
    clearPowerPauseForTeamOnUserMessage(rt, 'team-a');
    assert.equal(isTeamAwaitingUserAfterPowerPause(rt, 'team-a'), false);
    assert.equal(isTeamAwaitingUserAfterPowerPause(rt, 'team-b'), true);
  } finally {
    rt.config = prevSnap.config;
    rt.storageRoot = prevSnap.storageRoot;
    rt.powerMonitorState = prevSnap.powerMonitorState;
    rt.actors.clear();
    for (const [k, v] of prevSnap.actors) rt.actors.set(k, v);
    fs.rmSync(tmpStore, { recursive: true, force: true });
  }
});

// ============================================================================
// T11 (P1-10): Per-provider 5h request counting, 5h-only quota, & 3-tier execution
// ============================================================================
test('P1-10: 5h request window isolates per-provider calls, ignores 7-day-only low quota, suppresses probes in Tier 1, and enforces Tier 3', async () => {
  // 1. 7-day low balance (2%) with healthy 5-hour balance (85%) or 7-day-only snapshot NEVER triggers 5h confirmed quota!
  const snapMixed = parseQuotaState({
    schema_version: 1,
    generated_at: new Date(100_000).toISOString(),
    accounts: [{
      id: 'acc-1',
      provider: 'deepseek',
      windows: [
        { name: '5 hours', remaining: 85 },
        { name: '7 days', remaining: 2 },
      ],
    }],
  });
  const quotaCfg = { maxSnapshotAgeSec: 600, lowBelowPct: 15, exhaustedBelowPct: 5, gptReservePct: 10 };
  const general = routeQuota(snapMixed, 'deepseek/deepseek-reasoner', { family: 'deepseek' }, quotaCfg, new Date(110_000));
  const only5h = routeQuota5hWindow(snapMixed, 'deepseek/deepseek-reasoner', { family: 'deepseek' }, quotaCfg, new Date(110_000));
  assert.equal(general.bestRemainingPct, 2);
  assert.equal(only5h.bestRemainingPct, 85);
  assert.equal(only5h.status, 'ok');

  const snap7dOnly = parseQuotaState({
    schema_version: 1,
    generated_at: new Date(100_000).toISOString(),
    accounts: [{ id: 'acc-2', provider: 'deepseek', windows: [{ name: '7 days', remaining: 3 }] }],
  });
  const missing5h = routeQuota5hWindow(snap7dOnly, 'deepseek/deepseek-reasoner', { family: 'deepseek' }, quotaCfg, new Date(110_000));
  assert.equal(missing5h.status, 'unknown');
  assert.equal(missing5h.bestRemainingPct, null);

  // 2. Per-provider request counting + Tier 1 probe suppression + Tier 3 audit
  const { evaluateTeamRequestWindow, recordSessionModelRequest } = await import('../../leaderteam/host/concurrency.mjs');
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rw-prov-'));
  try {
    const rawCfg = buildSoloKeyStarterConfig(BASE_RAW_CFG, { preset: SOLO_PROVIDER_PRESETS[0] });
    rawCfg.requestWindow = {
      enabled: true,
      windowMs: 5 * 3600 * 1000,
      windowsByProvider: { deepseek: { maxRequests: 10 } },
      softThrottlePct: 20,
      hardPausePct: 10,
    };
    const cfg = validateConfig(rawCfg);
    const st = new TeamStore(tmpStore, 'team-rw');
    st.ensure({ workspace: tmpStore, surface: 'headless' });
    const nowMs = Date.now();
    // Add 9 foreign-provider (`openai`) usage calls -> must NOT count toward `deepseek`!
    for (let i = 0; i < 9; i++) {
      st.appendUsage({ role: 'gate', route: 'openai/gpt-4.1-mini', provider: 'openai', ok: true, attempts: 1 });
    }
    // Add 4 `deepseek` governance calls + 4 `deepseek` leader/member turns = 8/10 (20% remaining -> Tier 1 `trim_probes`!)
    const fakeRt = { config: cfg, storageRoot: tmpStore, actors: new Map() };
    for (let i = 0; i < 4; i++) {
      st.appendUsage({ role: 'discussA', route: 'deepseek/deepseek-reasoner', provider: 'deepseek', ok: true, attempts: 1 });
      recordSessionModelRequest(fakeRt, { teamId: 'team-rw', role: i % 2 === 0 ? 'leader' : 'member', route: 'deepseek/deepseek-chat', provider: 'deepseek', atMs: nowMs - 1000 });
    }
    const tier1 = evaluateTeamRequestWindow(fakeRt, 'team-rw', nowMs);
    assert.equal(tier1.local_estimated_requests_5h, 8);
    assert.equal(tier1.tier, 'trim_probes');
    assert.equal(tier1.suppressOptionalModelProbes, true);

    // Tier 1 suppresses optional `/v1/models` endpoint probing in `refreshUpstreamCatalog`
    fakeRt.upstreamCatalog = { discoveredAt: new Date(nowMs - 10000).toISOString(), providers: ['deepseek'], models: [] };
    fakeRt.upstreamCatalogAtMs = nowMs - 10000;
    fakeRt.shouldSuppressOptionalProbes = () => true;
    const cachedCat = await refreshUpstreamCatalog({}, fakeRt, { force: false, probeEndpoints: true });
    assert.equal(cachedCat, fakeRt.upstreamCatalog);

    // Add 1 more `deepseek` turn -> 9/10 (10% remaining <= hardPausePct 10% -> Tier 3 `checkpoint_pause`!)
    recordSessionModelRequest(fakeRt, { teamId: 'team-rw', role: 'leader', route: 'deepseek/deepseek-reasoner', provider: 'deepseek', atMs: nowMs - 500 });
    const tier3 = evaluateTeamRequestWindow(fakeRt, 'team-rw', nowMs);
    assert.equal(tier3.local_estimated_requests_5h, 9);
    assert.equal(tier3.tier, 'checkpoint_pause');
    assert.equal(tier3.triggerCheckpointPause, true);
    assert.equal(tier3.skipGovernanceReviews, false);
    assert.equal(fs.existsSync(path.join(tmpStore, 'request-window-audit.jsonl')), true);
    assert.ok(st.governanceEvents().some(e => e.type === 'request-window-checkpoint-pause'));
  } finally {
    fs.rmSync(tmpStore, { recursive: true, force: true });
  }
});

// ============================================================================
// T12 (P2-1): Windows CIM `EstimatedChargeRemaining: null` is NEVER coerced to `0%`
// ============================================================================
test('P2-1: readSystemPowerSample returns unknown instead of 0% when EstimatedChargeRemaining is null or empty', async () => {
  for (const badCharge of [null, undefined, '']) {
    const sample = await readSystemPowerSample({
      platform: 'win32',
      execFile: (_cmd, _args, _opts, cb) => {
        cb(null, JSON.stringify({ BatteryStatus: 1, EstimatedChargeRemaining: badCharge }), '');
      },
    });
    assert.equal(sample.status, 'unknown');
    assert.equal(sample.batteryPct, null);
  }
});

// ============================================================================
// T13 (P2-2): `lt-doctor` rejects invalid `powerMonitor.pollIntervalMs: 1000` identically to runtime
// ============================================================================
test('P2-2: lt-doctor fails on 1-second powerMonitor.pollIntervalMs without stripping V2.2 config sections', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-doc-strict-cfg-'));
  try {
    const badCfg = structuredClone(BASE_RAW_CFG);
    badCfg.powerMonitor = { enabled: true, pollIntervalMs: 1000 };
    const cfgPath = path.join(tmpDir, 'leaderteam.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(badCfg, null, 2));

    assert.throws(() => validateConfig(badCfg), /pollIntervalMs/);
    const report = runDoctorChecks({
      nodeVersion: '22.19.0',
      platform: 'linux',
      configPath: cfgPath,
      execFileSyncImpl: () => 'bash 5.2',
      env: { DEEPSEEK_API_KEY: 'sk-test' },
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.configuration.status, 'fail');
    assert.equal(report.checks.configuration.configValid, false);
    assert.match(report.checks.configuration.summary, /pollIntervalMs/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// T14 & T15 (P2-3 & P2-4): `lt-bugreport` scrubs UNC/spaced paths, preserves keys for `username="role"`, and counts global guard events
// ============================================================================
test('P2-3 & P2-4: lt-bugreport scrubs UNC & spaced paths, preserves schema keys when username="role", and counts global guard files', () => {
  // P2-3a: UNC & spaced paths
  const rawDiag = [
    'Failed at \\\\corp-fs01\\Team Share\\Secret Folder\\design spec.md: permission denied',
    'POSIX UNC //nas-prod/Engineering Share/private notes/roadmap.txt',
    'Home path C:\\Users\\John Doe\\My Secret Project\\client key.txt: ENOENT',
    'Linux home /home/jane doe/private workspace/notes.md: EACCES',
    'Quoted drive "E:\\Shared Work\\Project Alpha\\secret.json"',
  ].join('\n');
  const scrubbed = redactDiagnosticText(rawDiag, { username: 'role', hostname: 'status' });
  for (const forbidden of ['corp-fs01', 'Team Share', 'Secret Folder', 'design spec', 'nas-prod', 'Engineering Share', 'John Doe', 'My Secret Project', 'jane doe', 'private workspace', 'Project Alpha']) {
    assert.equal(scrubbed.includes(forbidden), false, `leaked path segment: ${forbidden} in:\n${scrubbed}`);
  }

  // P2-3b (`username: 'role'`) + P2-4 (global `request-window-audit.jsonl` & `power-monitor-state.json`)
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-bugreport-p2-'));
  try {
    const teamDir = path.join(tmpStore, 'teams', 'team-01');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify({ createdAt: new Date().toISOString() }) + '\n');
    fs.writeFileSync(path.join(teamDir, 'usage.jsonl'), JSON.stringify({
      role: 'leader',
      usage: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 40, totalTokens: 200 },
    }) + '\n');
    fs.writeFileSync(
      path.join(tmpStore, 'request-window-audit.jsonl'),
      [
        JSON.stringify({ teamId: 'team-01', kind: 'request-window-throttle', tier: 'checkpoint_pause', atMs: 1001 }),
        JSON.stringify({ teamId: 'team-01', kind: 'request-window-throttle', tier: 'checkpoint_pause', atMs: 2002 }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(tmpStore, 'power-monitor-state.json'),
      JSON.stringify({ v: 1, latched: true, triggerCount: 3, autoResumeAllowed: false }, null, 2) + '\n',
    );

    const report = generateRedactedBugReport({
      storageRoot: tmpStore,
      username: 'role',
      hostname: 'config',
    });
    assert.equal(report.ok, true);
    assert.equal(report.metrics.governance.requestWindowEvents, 2);
    assert.equal(report.metrics.governance.lowBatteryEvents, 3);
    assert.equal(report.metrics.usageTotal.totalTokens, 200);
    assert.match(report.markdown, /requestWindowEvents=2/);
    assert.match(report.markdown, /lowBatteryEvents=3/);
  } finally {
    fs.rmSync(tmpStore, { recursive: true, force: true });
  }
});
