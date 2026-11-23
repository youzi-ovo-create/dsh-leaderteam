'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let physicalFs = fs;
try { physicalFs = require('original-fs'); } catch { /* Plain Node fixture inspection. */ }

const REQUIRED_PIPELINE_SHA256 = 'f6c850cefce30831c4c5f160e831856b105935331bacd1ae0823129001614bc6';
const REQUIRED_RESOLVE_SNIPPET = 'this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0, exec.toolSet)';
const REQUIRED_EXECUTE_SNIPPET = 'await tool.execute(exec.arguments, exec)';
const SEMVER_WITH_PRERELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function statKind(file) {
  const stat = physicalFs.lstatSync(file);
  if (stat.isSymbolicLink()) return 'reparse';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = physicalFs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function sha256Bytes(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireLayoutFile(app, relativePath, label) {
  const file = path.join(app, relativePath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Missing official Desktop ${label}: ${relativePath}`);
  }
  const realApp = fs.realpathSync(app);
  const relative = path.relative(realApp, fs.realpathSync(file));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(`Packaged file escapes the candidate: ${relativePath}`);
  let ancestor = file;
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Linked candidate path rejected: ${ancestor}`);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return file;
}

async function inspectApp(app) {
  const resolvedApp = path.resolve(app);
  const exe = path.join(resolvedApp, 'DeepSeek Harness.exe');
  const asar = path.join(resolvedApp, 'resources', 'app.asar');
  const dshCmd = path.join(resolvedApp, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const runtimeFile = path.join(resolvedApp, 'resources', 'runtime', 'primary-runtime', 'runtime.json');
  const required = [
    [exe, 'DeepSeek Harness.exe'],
    [dshCmd, 'official dsh.cmd'],
    [runtimeFile, 'primary runtime metadata'],
  ];
  for (const [file, label] of required) requireLayoutFile(resolvedApp, path.relative(resolvedApp, file), label);
  const asarKind = statKind(asar);
  if (asarKind !== 'file' && asarKind !== 'directory') throw new Error('resources/app.asar must be a regular file or unpacked directory');

  const metadataFiles = [
    'package.json', 'dsh/package.json',
    'dsh/node_modules/@deepseek-ai/dsh-tools/package.json',
    'dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json',
  ];
  for (const file of metadataFiles) requireLayoutFile(resolvedApp, path.join('resources', 'app.asar', file), file);
  const desktop = readJson(path.join(asar, 'package.json'));
  const runtime = readJson(runtimeFile);
  const dsh = readJson(path.join(asar, 'dsh', 'package.json'));
  const tools = readJson(path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'));
  const host = readJson(path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'package.json'));
  const pipelineFile = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'pipeline.js');
  const cliFile = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const binFile = path.join(asar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  for (const file of [pipelineFile, cliFile, binFile]) {
    requireLayoutFile(resolvedApp, path.relative(resolvedApp, file), path.relative(asar, file));
  }
  const pipelineSource = fs.readFileSync(pipelineFile, 'utf8');
  const desktopVersion = typeof desktop.version === 'string' ? desktop.version : null;
  const versions = {
    appPackage: desktopVersion,
    dshRuntime: typeof dsh.version === 'string' ? dsh.version : null,
    primaryRuntime: typeof runtime.desktopVersion === 'string' ? runtime.desktopVersion : null,
    tools: typeof tools.version === 'string' ? tools.version : null,
    desktopHost: typeof host.version === 'string' ? host.version : null,
  };
  const versionValues = [...new Set(Object.values(versions))];
  return {
    ok: desktop.name === '@deepseek-ai/dsh-desktop' && versionValues.length === 1 && SEMVER_WITH_PRERELEASE.test(versionValues[0]),
    app: resolvedApp,
    executable: exe,
    appAsarKind: asarKind,
    packageName: desktop.name ?? null,
    versions,
    desktopVersion,
    toolsVersion: versions.tools,
    versionsConsistent: versionValues.length === 1,
    versionSyntaxValid: versionValues.length === 1 && SEMVER_WITH_PRERELEASE.test(versionValues[0]),
    appAsarSHA256: asarKind === 'file' ? await sha256File(asar) : null,
    pipelineSHA256: await sha256Bytes(pipelineFile),
    desktopHostCliSHA256: await sha256Bytes(cliFile),
    dshBinSHA256: await sha256Bytes(binFile),
    requiredResolvePresent: pipelineSource.includes(REQUIRED_RESOLVE_SNIPPET),
    requiredExecutePresent: pipelineSource.includes(REQUIRED_EXECUTE_SNIPPET),
    requiredMethodChecksRetained: pipelineSource.includes(REQUIRED_RESOLVE_SNIPPET) && pipelineSource.includes(REQUIRED_EXECUTE_SNIPPET),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let app;
  if (args.length === 1) app = path.dirname(process.execPath);
  else if (args.length === 2 && args[0] === '--app') app = args[1];
  else {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Usage: inspect-update-candidate.cjs [--app <official app directory>]' }));
    process.exitCode = 2;
    return;
  }
  try {
    const report = await inspectApp(app);
    process.stdout.write(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  REQUIRED_PIPELINE_SHA256,
  REQUIRED_RESOLVE_SNIPPET,
  REQUIRED_EXECUTE_SNIPPET,
  inspectApp,
  sha256File,
  sha256Bytes,
};
