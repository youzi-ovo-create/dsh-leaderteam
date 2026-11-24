// Run in official Electron Node mode; no LLM calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDshRuntime } from '../../scripts/dsh-runtime.mjs';

export async function runCli() {
  const runtime = resolveDshRuntime();
  const requireHost = createRequire(path.join(runtime.moduleRoot, 'package.json'));
  const { AclSandbox, workspaceWriteSid, tempWriteSid } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-sandbox-windows-acl')).href);
  const parent = process.env.LT_ACL_PROBE_ROOT;
  if (!parent || !path.isAbsolute(parent)) throw new Error('LT_ACL_PROBE_ROOT must be an absolute test fixture path');
  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  const nonce = `${Date.now()}-${process.pid}`;
  const insideFile = `inside-${nonce}.txt`;
  const outsideFile = `forbidden-${nonce}.txt`;
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leaderteam-acl-'));
  const sandbox = new AclSandbox({ writableDirs: [workspace], tempDir, writeSid: workspaceWriteSid(workspace), tempWriteSid: tempWriteSid(tempDir), mode: 'workspace-write' });
  try {
    await sandbox.init();
    const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const child = sandbox.spawn({ command, args: ['/d', '/c', `echo INSIDE_OK>${insideFile} & echo MUST_BE_DENIED>..\\outside\\${outsideFile}`], cwd: workspace });
    const result = await child.wait();
    const insideWritten = fs.existsSync(path.join(workspace, insideFile)) && fs.readFileSync(path.join(workspace, insideFile), 'utf8').trim() === 'INSIDE_OK';
    const outsideWritten = fs.existsSync(path.join(outside, outsideFile));
    console.log(JSON.stringify({ fixture: parent, exitCode: result.exitCode, insideWritten, outsideWritten }));
    if (!insideWritten || outsideWritten) throw new Error('Windows sandbox write boundary probe failed');
  } finally { sandbox.dispose(); }
}

function isMainCliModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const selfPath = fileURLToPath(metaUrl);
  if (path.resolve(argv1) === selfPath) return true;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(selfPath);
  } catch {
    return false;
  }
}

if (isMainCliModule(import.meta.url)) await runCli();
