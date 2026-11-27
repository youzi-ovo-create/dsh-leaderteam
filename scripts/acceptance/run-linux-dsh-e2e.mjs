#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Reusable Linux Real-DSH End-to-End Acceptance Suite (`scripts/acceptance/run-linux-dsh-e2e.mjs`)
 *
 * Verifies a packed `dsh-leaderteam-X.Y.Z.tgz` tarball against a real Linux DeepSeek Harness runtime
 * in a completely isolated temporary `DSH_HOME` (never touches `~/.dsh` or any running process):
 *   1. `lt-installer --inspect` & `--cli` one-click install into isolated `--profile web`
 *   2. `dsh plugin --profile web list` & `lt-doctor --json` host verification
 *   3. Synthetic +0.0.1 upgrade tarball SHA-256 verification, `lt-update --apply`, and 100% user config/session/.env preservation
 *   4. `lt-update --rollback` restoration to target version with 100% state preservation
 *   5. Standalone `lt-ui` Web Console loopback HTTP verification (`/api/lt/v1/system/compatibility`, `/onboarding`, `/system/update`, `/workbench/session-config`, 405 GET guard)
 *
 * Usage:
 *   node scripts/acceptance/run-linux-dsh-e2e.mjs [--tgz <path>] [--dsh-root <path>] [--work-dir <path>] [--out <json>]
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');

function parseArgs(argv) {
  const opts = {
    tgz: '',
    dshRoot: process.env.LT_DSH_APP || '',
    workDir: '',
    out: '',
    keepWork: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--tgz') opts.tgz = argv[++i] ?? '';
    else if (a === '--dsh-root') opts.dshRoot = argv[++i] ?? '';
    else if (a === '--work-dir') opts.workDir = argv[++i] ?? '';
    else if (a === '--out') opts.out = argv[++i] ?? '';
    else if (a === '--keep-work') opts.keepWork = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runCmd(cmd, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
}

function discoverDshRuntime(explicitRoot) {
  const candidates = [
    explicitRoot ? path.resolve(explicitRoot) : null,
    path.join(os.homedir(), '.local', 'share', 'dsh-runtime', 'current'),
  ].filter(Boolean);
  for (const root of candidates) {
    const dshBinJs = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(dshBinJs)) {
      return {
        root,
        binDir: path.join(root, 'node_modules', '.bin'),
        dshBinJs,
      };
    }
  }
  throw new Error(
    'Unable to locate Linux @deepseek-ai/dsh runtime. Pass --dsh-root <dir> or set LT_DSH_APP.',
  );
}

function bumpPatch(semver) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(semver).trim());
  if (!m) return '2.2.99';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/acceptance/run-linux-dsh-e2e.mjs [--tgz <path>] [--dsh-root <path>] [--work-dir <path>] [--out <json>] [--keep-work]');
    return;
  }

  const workDir = opts.workDir
    ? path.resolve(opts.workDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'lt-linux-dsh-e2e-'));
  fs.mkdirSync(workDir, { recursive: true });

  const rt = discoverDshRuntime(opts.dshRoot);
  const dshVersion = runCmd(process.execPath, [rt.dshBinJs, '--version']).trim();
  const report = {
    startedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    nodeVersion: process.version,
    dshVersion,
    steps: {},
  };

  try {
    let tgzPath = opts.tgz ? path.resolve(opts.tgz) : '';
    if (!tgzPath) {
      const packDir = path.join(workDir, 'pack');
      fs.mkdirSync(packDir, { recursive: true });
      const packed = runCmd('npm', ['pack', '--silent', '--pack-destination', packDir], { cwd: REPO_ROOT })
        .trim()
        .split(/\r?\n/)
        .pop();
      tgzPath = path.join(packDir, packed);
    }
    assert.ok(fs.existsSync(tgzPath), `Tarball not found: ${tgzPath}`);

    const stagePkgDir = path.join(workDir, 'inspect-pkg');
    fs.mkdirSync(stagePkgDir, { recursive: true });
    runCmd('tar', ['-xzf', tgzPath, '-C', stagePkgDir]);
    const targetVersion = JSON.parse(
      fs.readFileSync(path.join(stagePkgDir, 'package', 'package.json'), 'utf8'),
    ).version;
    const upgradeVersion = bumpPatch(targetVersion);

    for (const rel of ['package.json', 'leaderteam/package.json']) {
      const p = path.join(stagePkgDir, 'package', rel);
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        j.version = upgradeVersion;
        fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
      }
    }
    const upgradeTgz = path.join(workDir, `dsh-leaderteam-${upgradeVersion}-e2e.tgz`);
    runCmd('tar', ['-czf', upgradeTgz, '-C', stagePkgDir, 'package']);
    const upgradeSha = sha256File(upgradeTgz);
    fs.rmSync(stagePkgDir, { recursive: true, force: true });

    const dshHome = path.join(workDir, 'dsh-home');
    fs.mkdirSync(dshHome, { recursive: true });
    assert.notEqual(path.resolve(dshHome), path.resolve(os.homedir(), '.dsh'), 'Refusing to touch global ~/.dsh');

    const isolatedEnv = {
      ...process.env,
      DSH_HOME: dshHome,
      LT_DSH_APP: rt.root,
      LT_DSH_BIN: rt.dshBinJs,
      PATH: `${rt.binDir}:${process.env.PATH || ''}`,
    };

    const inspectJson = JSON.parse(
      runCmd(process.execPath, [path.join(REPO_ROOT, 'bin', 'lt-installer.mjs'), '--inspect', '--dsh-home', dshHome, '--json'], { env: isolatedEnv }),
    );
    assert.ok(Array.isArray(inspectJson.targets) && inspectJson.targets.length >= 1, 'Expected >= 1 DSH target');
    report.steps.inspect = { ok: true, targetCount: inspectJson.targets.length };

    const installJson = JSON.parse(
      runCmd(process.execPath, [path.join(REPO_ROOT, 'bin', 'lt-installer.mjs'), '--cli', '--dsh-home', dshHome, '--tgz', tgzPath, '--json'], { env: isolatedEnv }),
    );
    assert.equal(installJson.ok, true, `Install failed: ${JSON.stringify(installJson)}`);
    assert.equal(installJson.install.installedVersion, targetVersion);
    const pluginList = runCmd(process.execPath, [rt.dshBinJs, 'plugin', '--profile', 'web', 'list'], { env: isolatedEnv });
    assert.match(pluginList, /dsh-leaderteam/);
    report.steps.install = { ok: true, installedVersion: targetVersion };

    const doctorJson = JSON.parse(
      runCmd(process.execPath, [path.join(REPO_ROOT, 'bin', 'lt-doctor.mjs'), '--dsh-home', dshHome, '--json'], { env: isolatedEnv }),
    );
    assert.equal(doctorJson.checks.dshHost.classification, 'VERIFIED');
    assert.equal(doctorJson.checks.dshHost.productionAllowed, true);
    report.steps.doctor = {
      ok: true,
      hostVersion: doctorJson.checks.dshHost.toolsVersion,
      classification: doctorJson.checks.dshHost.classification,
    };

    const ltStorage = path.join(dshHome, 'leaderteam');
    fs.mkdirSync(path.join(ltStorage, 'config'), { recursive: true });
    fs.mkdirSync(path.join(ltStorage, 'sessions'), { recursive: true });
    const localCfgPath = path.join(ltStorage, 'config', 'leaderteam.local.json');
    const sessionPath = path.join(ltStorage, 'sessions', 'sess-preserve.json');
    const envFilePath = path.join(dshHome, '.env');
    fs.writeFileSync(localCfgPath, JSON.stringify({ team: { maxActiveMembers: 3 } }, null, 2));
    fs.writeFileSync(sessionPath, JSON.stringify({ sessionId: 'sess-preserve', ok: true }, null, 2));
    fs.writeFileSync(envFilePath, 'DEEPSEEK_API_KEY="sk-test-preserve-0000"\n', { mode: 0o600 });
    const hashesBefore = {
      localCfg: sha256File(localCfgPath),
      session: sha256File(sessionPath),
      envFile: sha256File(envFilePath),
    };

    const upgJson = JSON.parse(
      runCmd(
        process.execPath,
        [path.join(REPO_ROOT, 'bin', 'lt-update.mjs'), '--apply', '--dsh-home', dshHome, '--tgz', upgradeTgz, '--sha256', upgradeSha, '--json'],
        { env: isolatedEnv },
      ),
    );
    assert.equal(upgJson.ok, true, `Upgrade failed: ${JSON.stringify(upgJson)}`);
    assert.equal(upgJson.toVersion, upgradeVersion);
    assert.equal(sha256File(localCfgPath), hashesBefore.localCfg);
    assert.equal(sha256File(sessionPath), hashesBefore.session);
    assert.equal(sha256File(envFilePath), hashesBefore.envFile);
    report.steps.upgrade = { ok: true, fromVersion: targetVersion, toVersion: upgradeVersion, statePreserved: true };

    const rbJson = JSON.parse(
      runCmd(process.execPath, [path.join(REPO_ROOT, 'bin', 'lt-update.mjs'), '--rollback', '--dsh-home', dshHome, '--json'], { env: isolatedEnv }),
    );
    assert.equal(rbJson.ok, true, `Rollback failed: ${JSON.stringify(rbJson)}`);
    assert.equal(rbJson.restoredVersion, targetVersion);
    assert.equal(sha256File(localCfgPath), hashesBefore.localCfg);
    assert.equal(sha256File(sessionPath), hashesBefore.session);
    assert.equal(sha256File(envFilePath), hashesBefore.envFile);
    report.steps.rollback = { ok: true, restoredVersion: targetVersion, statePreserved: true };

    const { startStandaloneLtUiServer } = await import(pathToFileURL(path.join(REPO_ROOT, 'bin', 'lt-ui.mjs')).href);
    const uiSrv = await startStandaloneLtUiServer({ port: 0, dshHome });
    try {
      const bootRes = await fetch(uiSrv.launchUrl, { redirect: 'manual' });
      assert.equal(bootRes.status, 302);
      const cookie = bootRes.headers.get('set-cookie')?.split(';')[0] ?? '';
      const origin = uiSrv.baseUrl;
      const postHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };

      const compatJson = await (await fetch(`${origin}/api/lt/v1/system/compatibility`, { headers: { Cookie: cookie } })).json();
      assert.equal(compatJson.ok, true);

      const getMutRes = await fetch(`${origin}/api/lt/v1/system/update`, { headers: { Cookie: cookie } });
      assert.equal(getMutRes.status, 405);

      const obJson = await (await fetch(`${origin}/api/lt/v1/onboarding`, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({ action: 'status' }),
      })).json();
      assert.equal(obJson.ok, true);

      const updStatusJson = await (await fetch(`${origin}/api/lt/v1/system/update`, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({ action: 'status' }),
      })).json();
      assert.equal(updStatusJson.ok, true);

      const ghostRes = await fetch(`${origin}/api/lt/v1/workbench/session-config`, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({ action: 'get', sessionId: 'e2e-linux-ghost' }),
      });
      assert.equal(ghostRes.status, 404);

      const e2eSid = 'e2e-linux-sess';
      fs.mkdirSync(path.join(dshHome, 'sessions', e2eSid), { recursive: true });
      fs.writeFileSync(
        path.join(dshHome, 'sessions', e2eSid, 'session.v4.jsonl.zstd'),
        zlib.zstdCompressSync(
          Buffer.from(`${JSON.stringify({ type: 'session', id: e2eSid, createdAt: Date.now(), cwd: workDir, agentPreset: 'leaderteam' })}\n`),
        ),
      );

      const scJson = await (await fetch(`${origin}/api/lt/v1/workbench/session-config`, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({
          action: 'set',
          sessionId: e2eSid,
          syncAllRolesToLeader: true,
          patch: {
            models: {
              'openai/gpt-4.1': {
                provider: 'openai',
                upstreamModel: 'gpt-4.1',
                family: 'gpt',
                label: 'GPT-4.1',
                efforts: ['none', 'medium', 'high'],
                defaultEffort: 'medium',
              },
            },
            roles: { leader: { route: 'openai/gpt-4.1', effort: 'medium' } },
          },
        }),
      })).json();
      assert.equal(scJson.ok, true);
      assert.equal(scJson.data.appliedImmediately, true);
      report.steps.standaloneUi = { ok: true, track: updStatusJson.data.installed.track };
    } finally {
      await uiSrv.close();
    }

    report.ok = true;
    report.completedAt = new Date().toISOString();
    if (opts.out) {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (!opts.keepWork && !opts.workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

main().catch(err => {
  console.error(`[run-linux-dsh-e2e] FAILED: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
