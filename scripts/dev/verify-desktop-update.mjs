#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import inspectorModule from './inspect-update-candidate.cjs';

const { REQUIRED_PIPELINE_SHA256 } = inspectorModule;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNOWN_DESKTOP_VERSION = '0.2.2-rc.1';
const BASELINE_APP = path.join(ROOT, 'runtime', 'official-desktop', KNOWN_DESKTOP_VERSION);
function defaultBaselineApp() {
  if (fs.existsSync(BASELINE_APP)) return BASELINE_APP;
  try {
    const p = path.join(ROOT, 'config', 'official-desktop.paths.json');
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (typeof parsed?.app === 'string' && parsed.app.trim() && fs.existsSync(parsed.app)) return parsed.app;
    }
  } catch {}
  return BASELINE_APP;
}
/** The qualified local baseline, resolved to its physical path (the candidate inspector rejects linked ancestors). */
export function baselineApp(app = defaultBaselineApp()) {
  try { return fs.realpathSync.native(app); } catch { return app; }
}
const SOURCE_LOCATOR = path.join(ROOT, 'scripts', 'dsh-runtime.mjs');
const INSPECTOR = path.join(ROOT, 'scripts', 'dev', 'inspect-update-candidate.cjs');
export const EXPECTED_SCENARIOS = [
  'it01-happy-path', 'it02-gate-deny', 'it03-rewrite-caught', 'it04-review-failure',
  'it05-hard-rules', 'it06-plan-required', 'it07-quota', 'it08-arbiter',
  'it09-agreement-resume', 'it10-resume-member', 'it11-fail-loud', 'it12-read-boundary',
  'it13-read-completion', 'it14-core-missing', 'it15-standard-scope', 'it16-executor-readiness',
  'it17-leader-model', 'it18-parallel-members', 'it19-acceptance-checker', 'it20-discussion-context',
  'it21-task-tools', 'it22-skill-context', 'it23-role-configuration', 'it24-load-admission',
  'it25-sandbox-stop', 'it26-untrusted-description', 'it27-leader-read-grant', 'it28-workflow-lifecycle',
  'it29-gate-fallback', 'it35-resume-activation',
  'it36-required-review-missing', 'it37-core-current-plan',
  'it38-environment-escalation', 'it39-invalid-review-arbitration', 'it40-output-recovery', 'it42-rolling-planning', 'it43-serial-challenge', 'it44-v19-repairs-e2e', 'it45-power-redistribution-e2e',
  'it29-elastic-concurrency', 'it30-concurrency-races-and-isolation',
  'it31-live-model-config-reload',
  'it32-timer-archive-accountable-review',
  'it33-modular-plugins-and-upstream-models',
  'it34-adversarial-rationality',
];
export const EXPECTED_PROVIDER_MERGE_CHECKS = 23;
/** The verifier's own files: hashed at start and end so a result names the exact tool that produced it. */
export const TOOL_FILES = ['scripts/verify-desktop-update.ps1', 'scripts/dev/verify-desktop-update.mjs', 'scripts/dev/inspect-update-candidate.cjs'];
/** Project trees copied whole into the private staging copy. scripts/ is copied entirely because its files call
 *  one another by relative path (e.g. dsh-runtime.mjs runs scripts/dev/inspect-dsh-artifact.cjs); the staged
 *  locator then replaces scripts/dsh-runtime.mjs with its version-adjusted copy. */
export const STAGED_TREES = ['leaderteam', 'config', 'test/integration', 'test/fixtures', 'scripts'];
const ROUTE_ENV_KEYS = [
  'LT_DSH_EXEC', 'LT_DSH_ENTRY', 'LT_DSH_BIN', 'LT_DSH_EXEC_ARGS', 'LT_DSH_APP',
  'LT_DSH_PROFILE', 'LT_DSH_VERSION', 'DSH_HOME', 'DSH_DESKTOP_USER_DATA_DIR',
  'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
];

const hashBytes = data => crypto.createHash('sha256').update(data).digest('hex');
const hashFile = file => hashBytes(fs.readFileSync(file));

export function validateNewWorkDirectory(projectRoot, requested, options = {}) {
  const lstat = options.lstat ?? fs.lstatSync;
  const exists = options.exists ?? fs.existsSync;
  const root = path.resolve(projectRoot);
  const base = path.join(root, 'scratch', 'update-qualification');
  const target = requested
    ? path.resolve(root, requested)
    : path.join(base, `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(6).toString('hex')}`);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Work directory must be a new child of ${base}; rejected: ${target}`);
  }
  if (exists(target)) throw new Error(`Work directory already exists: ${target}`);

  let current = path.dirname(target);
  while (true) {
    if (exists(current)) {
      const stat = lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Reparse/symlink ancestor is not allowed: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Work directory ancestor is not a directory: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.normalize(target);
}

export function inspectionEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of ROUTE_ENV_KEYS) delete env[key];
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function runInspector(app, exe, logFile) {
  const env = inspectionEnvironment();
  const result = spawnSync(exe, [INSPECTOR, '--app', app], {
    cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, env,
  });
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] inspector app=${app}\nstatus=${result.status}\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}\n`);
  let report = null;
  try { report = JSON.parse((result.stdout ?? '').trim()); } catch { report = null; }
  if (!report || typeof report !== 'object') throw new Error(`Candidate/baseline artifact inspector returned no JSON (exit ${result.status}).`);
  if (result.status !== 0) throw new Error(`Artifact inspector failed (exit ${result.status}): ${report.error ?? 'invalid artifact'}`);
  return { report, status: result.status, stderr: result.stderr ?? '' };
}

export function evaluateArtifact(candidate, baseline) {
  const failures = [];
  if (!candidate?.ok) failures.push('candidate metadata/layout/version is invalid');
  if (candidate?.packageName !== '@deepseek-ai/dsh-desktop') failures.push('packageName is not @deepseek-ai/dsh-desktop');
  if (candidate?.versionsConsistent !== true) failures.push('app/runtime/tools versions are inconsistent');
  if (candidate?.versionSyntaxValid !== true) failures.push('desktop version syntax is invalid');
  if (candidate?.pipelineSHA256 !== REQUIRED_PIPELINE_SHA256) failures.push('pipeline fingerprint differs from the qualified baseline');
  if (candidate?.requiredMethodChecksRetained !== true) failures.push('required pipeline resolve/execute method checks are missing');
  if (candidate?.desktopHostCliSHA256 !== baseline?.desktopHostCliSHA256) failures.push('desktop-host CLI execution subject changed; adaptation required');
  if (candidate?.dshBinSHA256 !== baseline?.dshBinSHA256) failures.push('dsh bin execution subject changed; adaptation required');
  if (baseline?.pipelineSHA256 !== REQUIRED_PIPELINE_SHA256 || baseline?.requiredMethodChecksRetained !== true) failures.push('local baseline artifact no longer matches the qualified fingerprint');
  const known = candidate?.desktopVersion === KNOWN_DESKTOP_VERSION;
  return {
    knownVersion: known,
    pipelineExact: candidate?.pipelineSHA256 === REQUIRED_PIPELINE_SHA256,
    executionSubjectsIdentical: candidate?.desktopHostCliSHA256 === baseline?.desktopHostCliSHA256 &&
      candidate?.dshBinSHA256 === baseline?.dshBinSHA256,
    failures,
    eligible: failures.length === 0,
  };
}

function copyTree(source, destination, logFile, manifest, relativeRoot) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to copy reparse/symlink: ${source}`);
  if (!stat.isDirectory()) throw new Error(`Expected directory: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) throw new Error(`Refusing to copy reparse/symlink: ${src}`);
    const rel = path.join(relativeRoot, entry.name);
    if (st.isDirectory()) copyTree(src, dst, logFile, manifest, rel);
    else if (st.isFile()) {
      fs.copyFileSync(src, dst);
      const record = { relativePath: rel.replaceAll('\\', '/'), sha256: hashFile(dst) };
      manifest.files.push(record);
      fs.appendFileSync(logFile, `copied ${record.relativePath} ${record.sha256}\n`);
    } else throw new Error(`Refusing non-regular staged file: ${src}`);
  }
}

export function prepareLocatorStaging(stageScriptsDir, sourceLocator, candidateVersion) {
  if (typeof candidateVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidateVersion)) throw new Error('Invalid staging version');
  fs.mkdirSync(stageScriptsDir, { recursive: true });
  const sourceBytes = fs.readFileSync(sourceLocator);
  const sourceHashBefore = hashBytes(sourceBytes);
  const source = sourceBytes.toString('utf8');
  const replacements = [
    {
      file: 'scripts/dsh-runtime.mjs',
      field: 'official primary runtime exact version',
      oldValue: "if (runtime.desktopVersion !== '0.2.2-rc.1')",
      newValue: `if (runtime.desktopVersion !== '${candidateVersion}')`,
    },
    {
      file: 'scripts/dsh-runtime.mjs',
      field: 'official artifact tools exact version',
      oldValue: "artifact.toolsVersion !== '0.2.2-rc.1'",
      newValue: `artifact.toolsVersion !== '${candidateVersion}'`,
    },
  ];
  let staged = source;
  for (const replacement of replacements) {
    if (!staged.includes(replacement.oldValue)) throw new Error(`Cannot stage candidate locator: expected check is absent: ${replacement.field}`);
    staged = staged.replace(replacement.oldValue, replacement.newValue);
  }
  const destination = path.join(stageScriptsDir, 'dsh-runtime.mjs');
  fs.writeFileSync(destination, staged);
  const sourceHashAfter = hashFile(sourceLocator);
  return {
    sourceLocator,
    stagedLocator: destination,
    candidateVersion,
    replacements,
    sourceSHA256Before: sourceHashBefore,
    sourceSHA256After: sourceHashAfter,
    stagedSHA256: hashBytes(staged),
    sourceUnchanged: sourceHashBefore === sourceHashAfter,
  };
}

export function prepareStage(projectRoot, workDir, candidateVersion, logFile) {
  const stage = path.join(workDir, 'staging');
  fs.mkdirSync(stage, { recursive: true });
  const manifest = { createdAt: new Date().toISOString(), files: [] };
  copyTree(path.join(projectRoot, 'leaderteam'), path.join(stage, 'leaderteam'), logFile, manifest, 'leaderteam');
  copyTree(path.join(projectRoot, 'config'), path.join(stage, 'config'), logFile, manifest, 'config');
  copyTree(path.join(projectRoot, 'test', 'integration'), path.join(stage, 'test', 'integration'), logFile, manifest, 'test/integration');
  const stagedPackage = path.join(stage, 'leaderteam', 'package.json');
  const packageBefore = fs.readFileSync(stagedPackage);
  const packageConfig = JSON.parse(packageBefore);
  const originalVersions = [...packageConfig.leaderteam.supportedCoreVersions];
  if (!originalVersions.includes(candidateVersion)) packageConfig.leaderteam.supportedCoreVersions.push(candidateVersion);
  fs.writeFileSync(stagedPackage, JSON.stringify(packageConfig, null, 2) + '\n');
  manifest.supportedCoreStaging = {
    file: 'leaderteam/package.json', oldValue: originalVersions,
    newValue: packageConfig.leaderteam.supportedCoreVersions,
    beforeSHA256: hashBytes(packageBefore), afterSHA256: hashFile(stagedPackage),
  };
  copyTree(path.join(projectRoot, 'test', 'fixtures'), path.join(stage, 'test', 'fixtures'), logFile, manifest, 'test/fixtures');
  copyTree(path.join(projectRoot, 'scripts'), path.join(stage, 'scripts'), logFile, manifest, 'scripts');
  for (const dir of ['reports/desktop-preview', 'test-work']) fs.mkdirSync(path.join(stage, dir), { recursive: true });
  const locatorRecord = prepareLocatorStaging(path.join(stage, 'scripts'), path.join(projectRoot, 'scripts', 'dsh-runtime.mjs'), candidateVersion);
  manifest.locator = locatorRecord;
  fs.writeFileSync(path.join(workDir, 'staging-manifest.json'), JSON.stringify(manifest, null, 2));
  return { stage, manifest };
}

export function assessIntegration(status, output) {
  const passNames = [...output.matchAll(/^PASS\s+(\S+)/gm)].map(match => match[1]);
  const failNames = [...output.matchAll(/^FAIL\s+(\S+)/gm)].map(match => match[1]);
  const summaries = [...output.matchAll(/(\d+)\/(\d+)\s+scenarios passed/g)];
  const summary = summaries.at(-1);
  const reportedPassed = summary ? Number(summary[1]) : null;
  const reportedTotal = summary ? Number(summary[2]) : null;
  const uniquePassed = new Set(passNames);
  const expected = new Set(EXPECTED_SCENARIOS);
  const scenarioSetExact = uniquePassed.size === passNames.length &&
    passNames.length === expected.size && [...uniquePassed].every(name => expected.has(name));
  const automatedPassed = status === 0 && reportedPassed === EXPECTED_SCENARIOS.length && reportedTotal === EXPECTED_SCENARIOS.length &&
    failNames.length === 0 && scenarioSetExact && summaries.length === 1;
  return {
    status,
    reportedPassed,
    reportedTotal,
    summaryPresent: Boolean(summary),
    passedScenarios: [...uniquePassed].sort(),
    failedScenarios: [...new Set(failNames)].sort(),
    expectedScenarioCount: expected.size,
    scenarioSetExact,
    automatedPassed,
  };
}

function runIntegration(stage, workDir, candidateApp, logFile) {
  const integrationWork = path.join(workDir, 'integration-work');
  const privateHome = path.join(workDir, 'private-dsh-home');
  const privateUserData = path.join(workDir, 'private-desktop-user-data');
  for (const directory of [integrationWork, privateHome, privateUserData]) fs.mkdirSync(directory, { recursive: true });
  const env = { ...process.env };
  for (const key of ROUTE_ENV_KEYS) delete env[key];
  env.LT_DSH_APP = candidateApp;
  env.LT_WORK_DIR = integrationWork;
  env.DSH_HOME = privateHome;
  env.DSH_DESKTOP_USER_DATA_DIR = privateUserData;
  env.DSH_TELEMETRY_DISABLED = '1';
  const args = ['test/integration/run.mjs'];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: stage, windowsHide: true, encoding: 'utf8', timeout: 45 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] integration command=${process.execPath} ${args.join(' ')}\n${output}`);
  const assessment = assessIntegration(result.status ?? -1, output);
  return { ...assessment, command: `node ${args.join(' ')}`, durationMs: Date.now() - started };
}

export function assessProviderMerge(status, output) {
  const match = [...output.matchAll(/^PASS desktop-provider-merge \((\d+) checks/gm)];
  const checks = match.length === 1 ? Number(match[0][1]) : null;
  return { status, checks, expectedChecks: EXPECTED_PROVIDER_MERGE_CHECKS, passed: status === 0 && checks === EXPECTED_PROVIDER_MERGE_CHECKS };
}

function runProviderMerge(stage, candidateApp, logFile) {
  const env = { ...process.env };
  for (const key of ROUTE_ENV_KEYS) delete env[key];
  env.LT_DSH_APP = candidateApp;
  env.DSH_TELEMETRY_DISABLED = '1';
  const args = ['test/integration/desktop-provider-merge.mjs'];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: stage, windowsHide: true, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, env });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] provider merge command=${process.execPath} ${args.join(' ')}\n${output}`);
  return { ...assessProviderMerge(result.status ?? -1, output), command: `node ${args.join(' ')}`, durationMs: Date.now() - started };
}

export function toolHashes(projectRoot) {
  return TOOL_FILES.map(rel => { const file = path.join(projectRoot, rel); return { path: rel, sha256: fs.existsSync(file) ? hashFile(file) : null }; });
}

function writeMarkdown(report, workDir) {
  const artifact = report.candidate.artifact ?? {};
  const signature = report.signature ?? {};
  const locator = report.locatorStaging?.staged;
  const lines = [
    '# 官方 Desktop 更新自动复验报告',
    '',
    `- 结果：${report.automatedPassed ? 'automated candidate qualification PASSED' : 'FAILED'}`,
    `- needsNativeQualification：true`,
    `- 候选目录：\`${report.candidate.app ?? 'N/A'}\``,
    `- 候选来源：\`${report.candidate.source}\``,
    `- 候选版本：\`${artifact.desktopVersion ?? 'N/A'}\``,
    `- packageName：\`${artifact.packageName ?? 'N/A'}\``,
    `- app.asar SHA256：\`${artifact.appAsarSHA256 ?? 'N/A'}\``,
    `- pipeline SHA256：\`${artifact.pipelineSHA256 ?? 'N/A'}\``,
    `- EXE 签名：\`${signature.exe?.status ?? 'N/A'}\`; DeepSeek 签名=\`${signature.exe?.isDeepSeekSigned ?? false}\``,
    `- 安装包 SHA256：\`${signature.installer?.sha256 ?? 'N/A'}\``,
    `- staging locator 调整：\`${locator ? `${locator.replacements.length} 处精确版本常量` : '未发生（已知版本）'}\``,
    `- 集成结果：\`${report.integration?.reportedPassed ?? 0}/${report.integration?.reportedTotal ?? 0}\`; exit=\`${report.integration?.status ?? 'not-run'}\``,
    `- Desktop 配置实载（官方 CLI，安装/卸载合并）：\`${report.providerMerge?.checks ?? 0}/${EXPECTED_PROVIDER_MERGE_CHECKS}\`; exit=\`${report.providerMerge?.status ?? 'not-run'}\``,
    `- 复验工具哈希：${(report.tool?.end ?? []).map(t => t.path + ' ' + String(t.sha256).slice(0, 12)).join('；')}；运行中未变化=\`${report.tool?.unchanged ?? false}\``,
    `- 检查与测试阶段耗时（不含签名、解包）：\`${report.timing.durationMs} ms\``,
    '',
    '## 边界',
    '',
    `- 仅自动复验 ${EXPECTED_SCENARIOS.length} 个脚本化集成场景与 ${EXPECTED_PROVIDER_MERGE_CHECKS} 项 Desktop 配置实载检查；未运行官方安装器，未升级，未修改正式白名单。`,
    '- `automatedPassed=true` 仍需 GUI、真实模型和原生行为验收（`needsNativeQualification=true`）。',
    `- 失败原因：${report.failures.length ? report.failures.join('；') : '无'}`,
    '',
    '结构化结果见 `result.json`，完整执行日志见 `verification.log`，staging 清单见 `staging-manifest.json`。',
  ];
  fs.writeFileSync(path.join(workDir, 'report.md'), lines.join('\n'), 'utf8');
}

export async function runVerification(options) {
  const started = Date.now();
  const projectRoot = path.resolve(options.projectRoot ?? ROOT);
  const workDir = path.resolve(options.workDir);
  const qualificationRoot = path.join(projectRoot, 'scratch', 'update-qualification');
  const workRelative = path.relative(qualificationRoot, workDir);
  if (!workRelative || workRelative.startsWith('..') || path.isAbsolute(workRelative)) throw new Error('Verification directory must stay below scratch/update-qualification');
  let ancestor = workDir;
  while (true) {
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Linked verification ancestor rejected: ${ancestor}`);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const logFile = path.join(workDir, 'verification.log');
  fs.mkdirSync(workDir, { recursive: true });
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] verification started\n`);
  const failures = [];
  const toolStart = toolHashes(projectRoot);
  let providerMerge = null;
  let baselineInspection = null;
  let candidateInspection = null;
  let compatibility = null;
  let staging = null;
  let integration = null;
  let locator = null;
  let sourceIntegrity = null;
  try {
    const sourceLocatorHashBefore = hashFile(SOURCE_LOCATOR);
    const baseline = baselineApp();
    baselineInspection = runInspector(baseline, path.join(baseline, 'DeepSeek Harness.exe'), logFile).report;
    const candidateRun = runInspector(options.candidateApp, path.join(options.candidateApp, 'DeepSeek Harness.exe'), logFile);
    candidateInspection = candidateRun.report;
    compatibility = evaluateArtifact(candidateInspection, baselineInspection);
    failures.push(...compatibility.failures);
    locator = {
      sourceLocator: SOURCE_LOCATOR,
      sourceSHA256Before: sourceLocatorHashBefore,
      sourceSHA256After: hashFile(SOURCE_LOCATOR),
      sourceUnchanged: sourceLocatorHashBefore === hashFile(SOURCE_LOCATOR),
      staged: null,
    };
    if (!compatibility.eligible) throw new Error(`Candidate artifact rejected: ${compatibility.failures.join('; ')}`);
    staging = prepareStage(projectRoot, workDir, candidateInspection.desktopVersion, logFile);
    locator.staged = staging.manifest.locator;
    integration = runIntegration(staging.stage, workDir, options.candidateApp, logFile);
    if (!integration.automatedPassed) failures.push(`Integration did not produce an exact ${EXPECTED_SCENARIOS.length}/${EXPECTED_SCENARIOS.length} pass (exit=${integration.status}, summary=${integration.reportedPassed}/${integration.reportedTotal})`);
    providerMerge = runProviderMerge(staging.stage, options.candidateApp, logFile);
    if (!providerMerge.passed) failures.push(`Desktop configuration merge checks did not pass ${EXPECTED_PROVIDER_MERGE_CHECKS}/${EXPECTED_PROVIDER_MERGE_CHECKS} (exit=${providerMerge.status}, checks=${providerMerge.checks})`);
  } catch (error) {
    failures.push(error.message);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERROR ${error.stack ?? error.message}\n`);
  }
  if (staging) {
    const changedFiles = staging.manifest.files.filter(record => {
      const source = path.join(projectRoot, record.relativePath);
      return !fs.existsSync(source) || hashFile(source) !== record.sha256;
    }).map(record => record.relativePath);
    if (hashFile(SOURCE_LOCATOR) !== locator.sourceSHA256Before) changedFiles.push('scripts/dsh-runtime.mjs');
    sourceIntegrity = { sourceUnchanged: changedFiles.length === 0, changedFiles };
    if (changedFiles.length) failures.push(`Original project files changed: ${changedFiles.join(', ')}`);
  }
  const toolEnd = toolHashes(projectRoot);
  const toolUnchanged = JSON.stringify(toolStart) === JSON.stringify(toolEnd);
  if (!toolUnchanged) failures.push('The verifier tool files changed during the run');
  const finished = new Date();
  const report = {
    schemaVersion: 1,
    status: failures.length ? 'failed' : 'passed',
    automatedPassed: failures.length === 0,
    needsNativeQualification: true,
    candidate: {
      source: options.candidateSource,
      installer: options.installer ?? null,
      app: options.candidateApp,
      artifact: candidateInspection,
    },
    signature: options.signature ?? null,
    baseline: baselineInspection,
    compatibility,
    locatorStaging: locator,
    sourceIntegrity,
    integration,
    providerMerge,
    tool: { start: toolStart, end: toolEnd, unchanged: toolUnchanged },
    failures,
    workDir,
    timing: { startedAt: new Date(started).toISOString(), finishedAt: finished.toISOString(), durationMs: finished.getTime() - started },
    limitations: [
      'Automated scripted candidate qualification only.',
      'GUI, real-model, installer, and native desktop qualification remain required.',
      'No production home, whitelist, installation, or upgrade was touched.',
    ],
  };
  fs.writeFileSync(path.join(workDir, 'result.json'), JSON.stringify(report, null, 2));
  writeMarkdown(report, workDir);
  fs.appendFileSync(logFile, `[${finished.toISOString()}] verification finished status=${report.status}\n`);
  return report;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`);
    parsed[args[index].slice(2)] = args[index + 1];
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv);
    for (const required of ['candidate-app', 'work-dir', 'candidate-source']) {
      if (!args[required]) throw new Error(`Missing --${required}`);
    }
    let signature = null;
    if (args.signature) signature = JSON.parse(fs.readFileSync(args.signature, 'utf8'));
    const report = await runVerification({
      projectRoot: ROOT,
      candidateApp: path.resolve(args['candidate-app']),
      workDir: path.resolve(args['work-dir']),
      candidateSource: args['candidate-source'],
      installer: args.installer ? path.resolve(args.installer) : null,
      signature,
    });
    console.log(JSON.stringify({ workDir: report.workDir, status: report.status, automatedPassed: report.automatedPassed, failures: report.failures }));
    process.exitCode = report.automatedPassed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
