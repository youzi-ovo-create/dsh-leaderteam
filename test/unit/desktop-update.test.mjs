import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_PIPELINE_SHA256,
  REQUIRED_EXECUTE_SNIPPET,
  REQUIRED_RESOLVE_SNIPPET,
  inspectApp,
} from '../../scripts/dev/inspect-update-candidate.cjs';
import {
  EXPECTED_SCENARIOS,
  EXPECTED_PROVIDER_MERGE_CHECKS,
  STAGED_TREES,
  baselineApp,
  TOOL_FILES,
  assessIntegration,
  assessProviderMerge,
  toolHashes,
  evaluateArtifact,
  inspectionEnvironment,
  prepareLocatorStaging,
  prepareStage,
  validateNewWorkDirectory,
} from '../../scripts/dev/verify-desktop-update.mjs';

function temporaryProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `desktop-update-${name}-`));
  fs.mkdirSync(path.join(project, 'scratch', 'update-qualification'), { recursive: true });
  return project;
}

function write(file, contents = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function candidateFixture(version = '0.3.0', pipelineHashMatches = true) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-update-candidate-'));
  write(path.join(app, 'DeepSeek Harness.exe'), 'fake exe');
  write(path.join(app, 'resources/runtime/cli/bin/dsh.cmd'), 'fake cmd');
  write(path.join(app, 'resources/runtime/primary-runtime/runtime.json'), JSON.stringify({ desktopVersion: version }));
  const asar = path.join(app, 'resources/app.asar');
  const packageText = extra => JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version, ...extra });
  write(path.join(asar, 'package.json'), packageText());
  write(path.join(asar, 'dsh/package.json'), packageText({ name: '@deepseek-ai/dsh-desktop-runtime' }));
  write(path.join(asar, 'dsh/node_modules/@deepseek-ai/dsh-tools/package.json'), packageText({ name: '@deepseek-ai/dsh-tools' }));
  write(path.join(asar, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json'), packageText({ name: '@deepseek-ai/dsh-desktop-host' }));
  write(path.join(asar, 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/pipeline.js'), pipelineHashMatches
    ? `prefix ${REQUIRED_RESOLVE_SNIPPET} middle ${REQUIRED_EXECUTE_SNIPPET} suffix`
    : `prefix ${REQUIRED_RESOLVE_SNIPPET} middle changed ${REQUIRED_EXECUTE_SNIPPET} suffix`);
  write(path.join(asar, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), 'qualified cli');
  write(path.join(asar, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'), 'qualified bin');
  return app;
}

test('work directories must be new and stay inside the qualification root', () => {
  const project = temporaryProject('paths');
  const base = path.join(project, 'scratch', 'update-qualification');
  const requested = path.join(base, 'new-run');
  assert.equal(validateNewWorkDirectory(project, requested), path.normalize(requested));
  fs.mkdirSync(requested, { recursive: true });
  assert.throws(() => validateNewWorkDirectory(project, requested), /already exists/);
  assert.throws(() => validateNewWorkDirectory(project, path.join(project, '..', 'escape')), /must be a new child/);
});

test('work directories reject a reparse ancestor before creation', () => {
  const project = temporaryProject('reparse');
  const base = path.join(project, 'scratch', 'update-qualification');
  fs.mkdirSync(base, { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-update-outside-'));
  const linked = path.join(base, 'linked');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateNewWorkDirectory(project, path.join(linked, 'new-run')), /Reparse\/symlink ancestor/);
  assert.equal(fs.existsSync(path.join(outside, 'new-run')), false);
});

test('inspection always uses Node mode and clears inherited runtime routing', () => {
  const env = inspectionEnvironment({ LT_DSH_EXEC: 'foreign.exe', LT_DSH_ENTRY: 'foreign.js', NODE_OPTIONS: '--require foreign.js', ELECTRON_RUN_AS_NODE: '0', DSH_HOME: 'daily-home' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  for (const name of ['LT_DSH_EXEC', 'LT_DSH_ENTRY', 'NODE_OPTIONS', 'DSH_HOME']) assert.equal(name in env, false);
});

test('inspector reads actual packaged metadata and preserves strict method checks', async () => {
  const report = await inspectApp(candidateFixture('0.3.0'));
  assert.equal(report.ok, true);
  assert.equal(report.packageName, '@deepseek-ai/dsh-desktop');
  assert.equal(report.desktopVersion, '0.3.0');
  assert.equal(report.versionsConsistent, true);
  const source = `prefix ${REQUIRED_RESOLVE_SNIPPET} middle ${REQUIRED_EXECUTE_SNIPPET} suffix`;
  assert.equal(report.pipelineSHA256, crypto.createHash('sha256').update(source).digest('hex'));
  assert.equal(report.requiredResolvePresent, true);
  assert.equal(report.requiredExecutePresent, true);
  assert.equal(report.requiredMethodChecksRetained, true);
});

test('changed pipeline or execution-subject fingerprints stop unknown qualification', async () => {
  const baseline = { ...await inspectApp(candidateFixture('0.2.2-rc.1')), pipelineSHA256: REQUIRED_PIPELINE_SHA256 };
  const unknownSame = { ...await inspectApp(candidateFixture('0.3.0')), pipelineSHA256: REQUIRED_PIPELINE_SHA256 };
  assert.equal(evaluateArtifact(unknownSame, baseline).eligible, true);
  assert.equal(evaluateArtifact(unknownSame, baseline).knownVersion, false);

  const pipelineChanged = await inspectApp(candidateFixture('0.3.0', false));
  assert.equal(evaluateArtifact(pipelineChanged, baseline).eligible, false);
  assert.match(evaluateArtifact(pipelineChanged, baseline).failures.join(';'), /pipeline fingerprint differs/);

  const executorChanged = { ...unknownSame, desktopHostCliSHA256: 'changed' };
  assert.equal(evaluateArtifact(executorChanged, baseline).eligible, false);
  assert.match(evaluateArtifact(executorChanged, baseline).failures.join(';'), /desktop-host CLI execution subject changed/);
});

test('unknown version changes only the staged locator copy', () => {
  const project = temporaryProject('staging');
  const source = path.join(project, 'dsh-runtime.mjs');
  const sourceText = `const DEFAULT_APP = 'runtime/official-desktop/0.2.2-rc.1';\n`
    + `if (runtime.desktopVersion !== '0.2.2-rc.1') throw new Error();\n`
    + `if (artifact.toolsVersion !== '0.2.2-rc.1') throw new Error();\n`;
  fs.writeFileSync(source, sourceText);
  const before = fs.readFileSync(source);
  const record = prepareLocatorStaging(path.join(project, 'stage', 'scripts'), source, '0.3.0');
  assert.equal(fs.readFileSync(source).equals(before), true);
  assert.equal(record.sourceUnchanged, true);
  assert.equal(record.replacements.length, 2);
  assert.equal(record.replacements.every(item => item.oldValue.includes('0.2.2-rc.1') && item.newValue.includes('0.3.0')), true);
  const staged = fs.readFileSync(record.stagedLocator, 'utf8');
  assert.equal(staged.includes("runtime.desktopVersion !== '0.3.0'"), true);
  assert.equal(staged.includes("artifact.toolsVersion !== '0.3.0'"), true);
  assert.equal(staged.includes("DEFAULT_APP = 'runtime/official-desktop/0.2.2-rc.1'"), true);
});

test('the expected scenario list is exactly the scenario files of this project', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integration', 'scenarios');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).map(f => f.slice(0, -4)).sort();
  assert.deepEqual([...EXPECTED_SCENARIOS].sort(), files);
});

test('integration pass requires zero exit and one exact all-scenario summary', () => {
  const names = [...EXPECTED_SCENARIOS];
  const n = names.length;
  const output = `${names.map(name => `PASS ${name}`).join('\n')}\n\n${n}/${n} scenarios passed\n`;
  assert.equal(assessIntegration(0, output).automatedPassed, true);
  assert.equal(assessIntegration(1, output).automatedPassed, false);
  assert.equal(assessIntegration(0, output.replace(`${n}/${n} scenarios passed`, '')).automatedPassed, false);
  const partial = output.replace('PASS it01-happy-path', 'FAIL it01-happy-path').replace(`${n}/${n} scenarios passed`, `${n - 1}/${n} scenarios passed`);
  assert.equal(assessIntegration(0, partial).automatedPassed, false);
  assert.deepEqual(assessIntegration(1, partial).failedScenarios, ['it01-happy-path']);
  assert.equal(assessIntegration(0, output.replace('it01-happy-path', 'unexpected-test')).automatedPassed, false);
});

test('unknown core admission affects the private staging package only', () => {
  const project = temporaryProject('core-admission');
  const packageFile = path.join(project, 'leaderteam/package.json');
  write(packageFile, JSON.stringify({ leaderteam: { supportedCoreVersions: ['0.2.2-rc.1'] } }));
  const packageBefore = fs.readFileSync(packageFile);
  write(path.join(project, 'config/fixture.json'), '{}');
  write(path.join(project, 'test/integration/fixture.mjs'), '');
  write(path.join(project, 'test/fixtures/quota-state.json'), '{}');
  for (const rel of ['scripts/install-desktop.ps1', 'scripts/dev/inspect-dsh-artifact.cjs', 'scripts/dev/lib/session-rows.mjs']) write(path.join(project, rel), `// ${rel}\n`);
  const locator = "if (runtime.desktopVersion !== '0.2.2-rc.1') throw Error();\nif (artifact.toolsVersion !== '0.2.2-rc.1') throw Error();";
  write(path.join(project, 'scripts/dsh-runtime.mjs'), locator);
  const work = path.join(project, 'scratch/update-qualification/private');
  fs.mkdirSync(work);
  const result = prepareStage(project, work, '0.3.0', path.join(work, 'verification.log'));
  const staged = JSON.parse(fs.readFileSync(path.join(result.stage, 'leaderteam/package.json')));
  assert.deepEqual(staged.leaderteam.supportedCoreVersions, ['0.2.2-rc.1', '0.3.0']);
  assert.equal(fs.readFileSync(packageFile).equals(packageBefore), true);
  assert.equal(fs.readFileSync(path.join(project, 'scripts/dsh-runtime.mjs'), 'utf8'), locator);
  assert.deepEqual(result.manifest.supportedCoreStaging.oldValue, ['0.2.2-rc.1']);
  for (const rel of ['scripts/install-desktop.ps1', 'scripts/dev/inspect-dsh-artifact.cjs', 'scripts/dev/lib/session-rows.mjs']) {
    assert.equal(fs.readFileSync(path.join(result.stage, rel), 'utf8'), fs.readFileSync(path.join(project, rel), 'utf8'), `${rel} staged`);
    assert.ok(result.manifest.files.some(f => f.relativePath === rel), `${rel} in manifest`);
  }
  assert.ok(fs.statSync(path.join(result.stage, 'reports/desktop-preview')).isDirectory());
});

test('desktop configuration merge must report exactly the expected checks with exit 0', () => {
  const ok = `x\nPASS desktop-provider-merge (${EXPECTED_PROVIDER_MERGE_CHECKS} checks; official CLI, installed patch, no model calls)\n`;
  assert.equal(assessProviderMerge(0, ok).passed, true);
  assert.equal(assessProviderMerge(1, ok).passed, false);
  assert.equal(assessProviderMerge(0, ok.replace(String(EXPECTED_PROVIDER_MERGE_CHECKS), '18')).passed, false);
  assert.equal(assessProviderMerge(0, 'nothing').passed, false);
  assert.equal(assessProviderMerge(0, ok + ok).passed, false, 'exactly one summary');
});

test('the verifier records its own file hashes', () => {
  const project = temporaryProject('tool-hashes');
  for (const rel of TOOL_FILES) write(path.join(project, rel), rel);
  const hashes = toolHashes(project);
  assert.deepEqual(hashes.map(h => h.path), TOOL_FILES);
  assert.equal(hashes[0].sha256, crypto.createHash('sha256').update(TOOL_FILES[0]).digest('hex'));
  fs.rmSync(path.join(project, TOOL_FILES[1]));
  assert.equal(toolHashes(project)[1].sha256, null);
});

test('the staged copy holds every project script (scripts call each other by relative path)', () => {
  const real = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const project = temporaryProject('whole-scripts');
  const copy = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const e of fs.readdirSync(from, { withFileTypes: true })) { const a = path.join(from, e.name), b = path.join(to, e.name); if (e.isDirectory()) copy(a, b); else fs.copyFileSync(a, b); } };
  for (const tree of STAGED_TREES) copy(path.join(real, tree), path.join(project, tree));
  const work = path.join(project, 'scratch/update-qualification/whole');
  fs.mkdirSync(work);
  const result = prepareStage(project, work, '0.3.0', path.join(work, 'verification.log'));
  const list = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => { const p = path.join(d, e.name); return e.isDirectory() ? list(p, base) : [path.relative(base, p).split(path.sep).join('/')]; });
  const source = list(path.join(project, 'scripts')).sort(), staged = list(path.join(result.stage, 'scripts')).sort();
  assert.deepEqual(staged, source);
  assert.ok(staged.includes('dev/inspect-dsh-artifact.cjs'), 'the runtime locator dependency is staged');
  for (const rel of source) if (rel !== 'dsh-runtime.mjs') assert.equal(fs.readFileSync(path.join(result.stage, 'scripts', rel)).equals(fs.readFileSync(path.join(project, 'scripts', rel))), true, rel);
  assert.equal(fs.readFileSync(path.join(result.stage, 'scripts/dsh-runtime.mjs'), 'utf8').includes("runtime.desktopVersion !== '0.3.0'"), true, 'the locator is the version-adjusted copy');
});

test('the baseline app is inspected through its physical path', () => {
  const project = temporaryProject('baseline-real');
  const target = path.join(project, 'real-app');
  fs.mkdirSync(target);
  const link = path.join(project, 'linked-app');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(baselineApp(link), fs.realpathSync.native(target));
  assert.equal(baselineApp(path.join(project, 'missing')), path.join(project, 'missing'));
});
