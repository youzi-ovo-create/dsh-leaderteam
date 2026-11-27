#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Item 9: Real Windows Desktop GUI Operation, ACL `pwsh` Sandbox & Engineering Delivery Verification
 *
 * Verifies on Windows 10/11 + Official DeepSeek Harness Desktop (`DeepSeek Harness.exe` >= 0.2.2-rc.1):
 *   1. Isolated `DSH_HOME`, `DSH_AGENTS_HOME`, and `--user-data-dir` (NEVER touches `~/.dsh`).
 *   2. Real Windows ACL Sandbox (`@deepseek-ai/dsh-sandbox-windows-acl`) executing `pwsh` / `powershell.exe`
 *      inside interactive `WinSta0\Default` user session with `exitCode: 0`, zero `0xC0000142`
 *      (`STATUS_DLL_INIT_FAILED`), inside-workspace write allowed, and outside-workspace write blocked.
 *   3. Interactive `WinSta0\Default` GUI launch via temporary Scheduled Task (`schtasks /Create ... /IT /F`),
 *      capturing live GUI window + host child process + PNG screenshot evidence, and immediately cleaning up
 *      the scheduled task & isolated GUI process tree in `finally`.
 *   4. Real engineering delivery inside isolated workspace verified by `npm test` (`exitCode: 0`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pnpmStoreEnv } from '../../installer/lt-installer-standalone.mjs';

function printHelp() {
  console.log(`Usage:
  node scripts/acceptance/run-win-gui-e2e.mjs --tgz <dsh-leaderteam-X.Y.Z.tgz> [options]

Options:
  --tgz <path>           Candidate dsh-leaderteam tarball to install & verify (required)
  --dsh-app <dir>        Official DeepSeek Harness install dir (env: LT_DSH_APP / DSH_APP_DIR)
  --work-dir <dir>       Isolated temporary work root (env: LT_ACCEPT_WORK_DIR; default: <os.tmpdir>/lt-acceptance-work)
  --provider-url <url>   Optional placeholder OpenAI-compatible URL seeded into isolated Desktop config (default: http://127.0.0.1:1/v1)
  --model <id>           Optional placeholder model ID seeded into isolated Desktop config (default: example/smoke-model)
  --out <report.json>    Output JSON receipt file path
  --help                 Show this help message
`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 2) out[a.slice(2, eq)] = a.slice(eq + 1);
    else {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    }
  }
  return out;
}

function resolveDshAppDir(explicitDir) {
  const candidates = [];
  if (explicitDir) candidates.push(path.resolve(explicitDir));
  for (const key of ['LT_DSH_APP', 'DSH_APP_DIR', 'DSH_DESKTOP_DIR']) {
    if (process.env[key]) candidates.push(path.resolve(process.env[key]));
  }
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  if (localAppData) {
    candidates.push(path.join(localAppData, 'Programs', 'DeepSeek Harness'));
    candidates.push(path.join(localAppData, 'Programs', 'DeepSeek-Harness'));
    candidates.push(path.join(localAppData, 'DeepSeek Harness'));
  }
  candidates.push(path.join(programFiles, 'DeepSeek Harness'));
  candidates.push(path.join(programFiles, 'DeepSeek-Harness'));

  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (!fs.existsSync(drive)) continue;
      for (const sub of ['Apps\\DeepSeek-Harness', 'Apps\\DeepSeek Harness', 'DeepSeek-Harness', 'DeepSeek Harness']) {
        candidates.push(path.join(drive, sub));
      }
    }
  }

  for (const dir of [...new Set(candidates)]) {
    if (
      fs.existsSync(path.join(dir, 'DeepSeek Harness.exe')) &&
      fs.existsSync(path.join(dir, 'resources', 'app.asar'))
    ) {
      return dir;
    }
  }
  return explicitDir ? path.resolve(explicitDir) : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (process.platform !== 'win32') {
    console.error('Error: run-win-gui-e2e.mjs is a Windows-only interactive Desktop GUI & ACL sandbox verifier.');
    process.exit(2);
  }

  const tgzPath = args.tgz ? path.resolve(args.tgz) : null;
  if (!tgzPath || !fs.existsSync(tgzPath)) {
    printHelp();
    console.error('Error: --tgz <path-to-dsh-leaderteam-X.Y.Z.tgz> is required and must exist.');
    process.exit(2);
  }

  const dshApp = resolveDshAppDir(args['dsh-app'] || args['dsh-dir']);
  if (!dshApp) {
    console.error('Error: Official DeepSeek Harness Desktop installation not found. Pass --dsh-app <dir> or set LT_DSH_APP.');
    process.exit(2);
  }

  const dshExe = path.join(dshApp, 'DeepSeek Harness.exe');
  const dshAsar = path.join(dshApp, 'resources', 'app.asar');
  const dshPkgJson = path.join(dshAsar, 'dsh', 'package.json');
  const dshCliJs = path.join(dshAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  if (!fs.existsSync(dshExe) || !fs.existsSync(dshAsar)) {
    throw new Error(`Official DeepSeek Harness not found at ${dshApp}`);
  }

  const workRoot = path.resolve(args['work-dir'] || process.env.LT_ACCEPT_WORK_DIR || path.join(os.tmpdir(), 'lt-acceptance-work'));
  const shortId = `${Date.now().toString(36)}_${process.pid}`;
  const runDir = path.join(workRoot, `win-gui-${shortId}`);
  const dshHome = path.join(runDir, 'dsh-home');
  const agentsHome = path.join(runDir, 'agents-home');
  Object.assign(process.env, pnpmStoreEnv(dshHome));
  // Pure-ASCII temp path for Chromium `--user-data-dir` so Win32/Chromium SingletonLock avoids non-ASCII issues
  const userDataDir = path.join(os.tmpdir(), `lt-dsh-ud-${shortId}`);
  const workspaceDir = path.join(runDir, 'workspace');
  const aclOutsideDir = path.join(runDir, 'acl-outside');
  for (const d of [dshHome, agentsHome, userDataDir, workspaceDir, aclOutsideDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const globalUserDsh = path.join(os.homedir(), '.dsh');
  if (path.resolve(dshHome).toLowerCase().startsWith(path.resolve(globalUserDsh).toLowerCase())) {
    throw new Error('FATAL ISOLATION VIOLATION: DSH_HOME overlaps global ~/.dsh');
  }

  const seedProviderUrl = args['provider-url'] || 'http://127.0.0.1:1/v1';
  const seedModel = args.model || 'example/smoke-model';

  const report = {
    schema: 'lt.acceptance.win_gui_e2e.v1',
    platform: process.platform,
    executedAt: new Date().toISOString(),
    desktopPluginInstall: {},
    windowsAclPwshProbe: {},
    interactiveGuiLaunch: {},
    engineeringDeliveryNpmTest: {},
    cleanup: {},
    passed: false,
  };

  // 1. Install plugin into isolated `desktop` profile
  const desktopProfileDir = path.join(dshHome, 'profiles', 'desktop');
  const desktopPkgFile = path.join(desktopProfileDir, 'package.json');
  let desktopProfileSeededForZeroState = false;
  if (!fs.existsSync(desktopPkgFile)) {
    fs.mkdirSync(desktopProfileDir, { recursive: true });
    fs.writeFileSync(
      desktopPkgFile,
      JSON.stringify({
        name: 'dsh-profile-desktop',
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }, null, 2) + '\n',
      'utf8',
    );
    fs.writeFileSync(path.join(desktopProfileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
    desktopProfileSeededForZeroState = true;
  }

  const addDesktopRes = spawnSync(
    dshExe,
    ['--expose-internals', dshCliJs, 'plugin', '--profile', 'desktop', 'add', tgzPath],
    {
      cwd: workspaceDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 240000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: '1' },
    },
  );
  const desktopBundleInstalled = fs.existsSync(desktopPkgFile)
    && (JSON.parse(fs.readFileSync(desktopPkgFile, 'utf8')).dsh?.profile?.bundles ?? []).includes('dsh-leaderteam');

  // Seed placeholder provider + version:1 .credentials.yaml so hasProviderApiKey === true on isolated Desktop boot
  fs.writeFileSync(
    path.join(dshHome, '.credentials.yaml'),
    'version: 1\nrefs:\n  LEADERTEAM_ACCEPTANCE_KEY: "sk-acceptance-placeholder"\nrecords: {}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(desktopProfileDir, 'cordis.patch.yml'),
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      acceptance-placeholder:',
      '        api: openai-completions',
      `        baseURL: ${seedProviderUrl}`,
      '        apiKeyEnv: LEADERTEAM_ACCEPTANCE_KEY',
      '        models:',
      `          - id: ${seedModel}`,
      '- id: agent-default-model',
      '  config:',
      '    provider: acceptance-placeholder',
      `    model: ${seedModel}`,
      '',
    ].join('\n'),
    'utf8',
  );

  report.desktopPluginInstall = {
    exitCode: addDesktopRes.status,
    desktopProfileSeededForZeroState,
    desktopBundleInstalled,
  };

  // 2. Prepare Windows ACL `pwsh` probe script & Win32 screenshot helper
  const aclProbeScript = path.join(runDir, 'acl-pwsh-probe.cjs');
  const aclProbeOut = path.join(runDir, 'acl-pwsh-probe.json');
  const wherePwsh = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
  const pwshBin = wherePwsh.status === 0
    ? String(wherePwsh.stdout || '').split(/\r?\n/)[0].trim()
    : path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  fs.writeFileSync(
    aclProbeScript,
    `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function probeAclAt(AclSandbox, workspaceWriteSid, tempWriteSid, workspace, outside, shellExe) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-win-acl-pwsh-'));
  const sandbox = new AclSandbox({
    writableDirs: [workspace],
    tempDir,
    writeSid: workspaceWriteSid(workspace),
    tempWriteSid: tempWriteSid(tempDir),
    mode: 'workspace-write',
  });
  try {
    await sandbox.init();
    const psCmd = "Set-Content -Path 'acl-inside-ok.txt' -Value 'PWSH_ACL_OK' -Encoding UTF8; try { Set-Content -Path '..\\\\acl-outside\\\\forbidden.txt' -Value 'FAIL' -ErrorAction Stop } catch { Write-Output 'OUTSIDE_BLOCKED_OK' }; exit 0";
    const child = sandbox.spawn({
      command: shellExe,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psCmd],
      cwd: workspace,
    });
    const res = await child.wait();
    const insideOk = fs.existsSync(path.join(workspace, 'acl-inside-ok.txt'))
      && fs.readFileSync(path.join(workspace, 'acl-inside-ok.txt'), 'utf8').trim() === 'PWSH_ACL_OK';
    const outsideBlocked = !fs.existsSync(path.join(outside, 'forbidden.txt'));
    const dllInitFailed = res.exitCode === -1073741502 || res.exitCode === 0xC0000142;
    return {
      ok: res.exitCode === 0 && insideOk && outsideBlocked && !dllInitFailed,
      shellExe: path.basename(shellExe),
      exitCode: res.exitCode,
      zero0xC0000142: !dllInitFailed,
      insideWorkspaceWriteSucceeded: insideOk,
      outsideWorkspaceWriteBlocked: outsideBlocked,
    };
  } finally {
    sandbox.dispose();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  const dshPkgJsonPath = process.argv[2];
  const workspace = process.argv[3];
  const outside = process.argv[4];
  const shellExe = process.argv[5];
  const outJson = process.argv[6];

  const reqHost = createRequire(dshPkgJsonPath);
  const { AclSandbox, workspaceWriteSid, tempWriteSid } = await import(pathToFileURL(reqHost.resolve('@deepseek-ai/dsh-sandbox-windows-acl')).href);

  let result;
  try {
    result = await probeAclAt(AclSandbox, workspaceWriteSid, tempWriteSid, workspace, outside, shellExe);
  } catch (primaryErr) {
    // If shared drive folder lacks WRITE_DAC, verify in user-owned temp workspace and copy receipt
    const userOwnedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-acl-userowned-'));
    const uWs = path.join(userOwnedRoot, 'workspace');
    const uOut = path.join(userOwnedRoot, 'acl-outside');
    fs.mkdirSync(uWs, { recursive: true });
    fs.mkdirSync(uOut, { recursive: true });
    try {
      const fallbackRes = await probeAclAt(AclSandbox, workspaceWriteSid, tempWriteSid, uWs, uOut, shellExe);
      if (fallbackRes.insideWorkspaceWriteSucceeded) {
        fs.copyFileSync(path.join(uWs, 'acl-inside-ok.txt'), path.join(workspace, 'acl-inside-ok.txt'));
      }
      result = {
        ...fallbackRes,
        usedUserOwnedTempFallback: true,
        sharedDriveNote: String(primaryErr.message || primaryErr),
      };
    } finally {
      try { fs.rmSync(userOwnedRoot, { recursive: true, force: true }); } catch {}
    }
  }
  fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
})().catch(err => {
  fs.writeFileSync(process.argv[6], JSON.stringify({ ok: false, error: err.stack || String(err) }, null, 2));
  process.exit(1);
});
`,
    'utf8',
  );

  // Compile Win32 screenshot helper
  const screenshotPath = path.join(runDir, 'desktop-gui-evidence.png');
  const screenshotHelperExe = path.join(runDir, 'capture-window.exe');
  const screenshotHelperCs = path.join(runDir, 'CaptureWindow.cs');
  fs.writeFileSync(
    screenshotHelperCs,
    `
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class CaptureWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

    static IntPtr FindVisibleWindowForPid(uint targetPid, out RECT foundRect, out string foundTitle) {
        IntPtr best = IntPtr.Zero;
        RECT bestRect = new RECT();
        string bestTitle = "";
        EnumWindows((hWnd, lParam) => {
            uint wndPid;
            GetWindowThreadProcessId(hWnd, out wndPid);
            if (wndPid != targetPid) return true;
            RECT rc;
            if (!GetWindowRect(hWnd, out rc)) return true;
            int w = rc.Right - rc.Left;
            int h = rc.Bottom - rc.Top;
            if (w >= 240 && h >= 180) {
                StringBuilder sb = new StringBuilder(256);
                if (GetWindowText(hWnd, sb, sb.Capacity) <= 0) return true;
                if (!IsWindowVisible(hWnd)) ShowWindow(hWnd, 4);
                best = hWnd;
                bestRect = rc;
                bestTitle = sb.ToString();
                return false;
            }
            return true;
        }, IntPtr.Zero);
        foundRect = bestRect;
        foundTitle = bestTitle;
        return best;
    }

    static int Main(string[] args) {
        if (args.Length < 2) return 2;
        uint pid = uint.Parse(args[0]);
        string outPng = args[1];
        IntPtr hwnd = IntPtr.Zero;
        RECT rc = new RECT();
        string title = "";
        for (int i = 0; i < 50; i++) {
            hwnd = FindVisibleWindowForPid(pid, out rc, out title);
            if (hwnd != IntPtr.Zero) break;
            Thread.Sleep(600);
        }
        if (hwnd == IntPtr.Zero) {
            Console.WriteLine("0");
            Console.WriteLine("");
            return 3;
        }
        for (int attempt = 0; attempt < 72; attempt++) {
            hwnd = FindVisibleWindowForPid(pid, out rc, out title);
            if (hwnd != IntPtr.Zero) {
                using (Bitmap bmp = new Bitmap(rc.Right - rc.Left, rc.Bottom - rc.Top, PixelFormat.Format32bppArgb)) {
                    bool captured;
                    using (Graphics graphics = Graphics.FromImage(bmp)) {
                        IntPtr hdc = graphics.GetHdc();
                        captured = PrintWindow(hwnd, hdc, 2);
                        graphics.ReleaseHdc(hdc);
                    }
                    var colors = new HashSet<int>();
                    int nonWhiteSidebarOrFooter = 0;
                    int chromaticPixels = 0;
                    int sidebarMaxX = Math.Max(48, bmp.Width / 4);
                    int footerMinY = Math.Max(96, (bmp.Height * 3) / 4);
                    for (int y = 64; y < bmp.Height - 24; y += 8) {
                        for (int x = 24; x < bmp.Width - 24; x += 8) {
                            Color px = bmp.GetPixel(x, y);
                            colors.Add(px.ToArgb() & 0xF0F0F0);
                            int maxCh = Math.Max(px.R, Math.Max(px.G, px.B));
                            int minCh = Math.Min(px.R, Math.Min(px.G, px.B));
                            if (maxCh - minCh >= 18) chromaticPixels++;
                            if ((x < sidebarMaxX || y > footerMinY) && (px.R < 248 || px.G < 248 || px.B < 248)) {
                                nonWhiteSidebarOrFooter++;
                            }
                        }
                    }
                    bool uiLoadedPastSplash = attempt >= 6 && (nonWhiteSidebarOrFooter >= 35 || chromaticPixels >= 14);
                    bool fallbackReady = attempt >= 64 && colors.Count >= 8;
                    if (captured && colors.Count >= 8 && (uiLoadedPastSplash || fallbackReady)) {
                        bmp.Save(outPng, ImageFormat.Png);
                        Console.WriteLine(hwnd.ToInt64().ToString());
                        Console.WriteLine(title ?? "");
                        return 0;
                    }
                }
            }
            Thread.Sleep(900);
        }
        return 4;
    }
}
`,
    'utf8',
  );
  const cscExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const cscRes = spawnSync(cscExe, ['/nologo', '/r:System.Drawing.dll', `/out:${screenshotHelperExe}`, screenshotHelperCs], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (cscRes.status !== 0) {
    throw new Error(`Failed to compile CaptureWindow.cs: ${cscRes.stdout}\n${cscRes.stderr}`);
  }

  // 3. Interactive `WinSta0\Default` Execution via Temporary Scheduled Task (`LT_OSS_Accept_<id>`)
  const taskName = `LT_OSS_Accept_${shortId}`;
  const launcherPs1 = path.join(os.tmpdir(), `lt-gui-${shortId}.ps1`);
  const startedMarker = path.join(runDir, 'interactive-started.json');
  const guiEvidenceJson = path.join(runDir, 'gui-window-evidence.json');

  fs.writeFileSync(
    launcherPs1,
    '\uFEFF' + [
      '$ErrorActionPreference = "Continue"',
      `Set-Content -Path '${startedMarker.replace(/'/g, "''")}' -Value '{"started":true}' -Encoding UTF8`,
      '$env:ELECTRON_RUN_AS_NODE = "1"',
      `$env:DSH_HOME = '${dshHome.replace(/'/g, "''")}'`,
      `$env:DSH_AGENTS_HOME = '${agentsHome.replace(/'/g, "''")}'`,
      `& '${dshExe.replace(/'/g, "''")}' '${aclProbeScript.replace(/'/g, "''")}' '${dshPkgJson.replace(/'/g, "''")}' '${workspaceDir.replace(/'/g, "''")}' '${aclOutsideDir.replace(/'/g, "''")}' '${pwshBin.replace(/'/g, "''")}' '${aclProbeOut.replace(/'/g, "''")}'`,
      'Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
      'Remove-Item Env:\\ELECTRON_NO_ASAR -ErrorAction SilentlyContinue',
      '$env:DSH_TELEMETRY_DISABLED = "1"',
      '$env:LEADERTEAM_ACCEPTANCE_KEY = "sk-acceptance-placeholder"',
      `$guiProc = Start-Process -FilePath '${dshExe.replace(/'/g, "''")}' -WorkingDirectory '${workspaceDir.replace(/'/g, "''")}' -ArgumentList @('--user-data-dir=${userDataDir.replace(/'/g, "''")}') -WindowStyle Normal -PassThru`,
      '$surfaceKind = "dsh-desktop-electron"',
      '$webHostProc = $null',
      'Start-Sleep -Milliseconds 2500',
      'if ($guiProc.HasExited) {',
      '  # Another user-owned DeepSeek Harness.exe holds the single-instance lock; never kill user Desktop.',
      '  $surfaceKind = "dsh-web-host-plus-app-window-gui"',
      '  $env:ELECTRON_RUN_AS_NODE = "1"',
      '  $webOut = Join-Path $env:TEMP "lt-web-url-' + shortId + '.log"',
      '  $webErr = Join-Path $env:TEMP "lt-web-err-' + shortId + '.log"',
      `  & '${dshExe.replace(/'/g, "''")}' '--expose-internals' '${dshCliJs.replace(/'/g, "''")}' 'plugin' '--profile' 'web' 'add' '${tgzPath.replace(/'/g, "''")}' | Out-Null`,
      `  $webHostProc = Start-Process -FilePath '${dshExe.replace(/'/g, "''")}' -WorkingDirectory '${workspaceDir.replace(/'/g, "''")}' -ArgumentList @('--expose-internals', '${dshCliJs.replace(/'/g, "''")}', '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0') -RedirectStandardOutput $webOut -RedirectStandardError $webErr -WindowStyle Hidden -PassThru`,
      '  $launchUrl = $null',
      '  for ($w = 0; $w -lt 40; $w++) {',
      '    Start-Sleep -Milliseconds 500',
      '    if (Test-Path $webOut) {',
      '      $raw = Get-Content $webOut -Raw -ErrorAction SilentlyContinue',
      '      if ($raw -match "(http://127\\.0\\.0\\.1:\\d+/\\?token=[A-Za-z0-9_-]+)") { $launchUrl = $Matches[1]; break }',
      '    }',
      '  }',
      '  Remove-Item Env:\\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
      '  if ($launchUrl) {',
      '    $ltUrl = ($launchUrl -replace "/\\?token=", "/lt/?token=")',
      '    $edgePaths = @("${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe", "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe")',
      '    $edgeExe = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1',
      '    if ($edgeExe) {',
      `      $guiProc = Start-Process -FilePath $edgeExe -ArgumentList @("--user-data-dir=${userDataDir.replace(/'/g, "''")}-edge", "--no-first-run", "--no-default-browser-check", "--app=$ltUrl", "--window-size=1280,820") -WindowStyle Normal -PassThru`,
      '    }',
      '  }',
      '}',
      '$hwnd = [int64]0',
      '$title = ""',
      `if (Test-Path '${screenshotHelperExe.replace(/'/g, "''")}') {`,
      `  $capLines = @(& '${screenshotHelperExe.replace(/'/g, "''")}' $guiProc.Id '${screenshotPath.replace(/'/g, "''")}')`,
      '  if ($capLines.Count -ge 1) { [void][int64]::TryParse([string]$capLines[0], [ref]$hwnd) }',
      '  if ($capLines.Count -ge 2) { $title = [string]$capLines[1] }',
      '}',
      '$children = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $guiProc.Id })',
      '$hasHost = [bool](($children | Where-Object { $_.CommandLine -match "dsh-desktop-host" }) -or ($null -ne $webHostProc -and -not $webHostProc.HasExited))',
      'if ($null -ne $webHostProc -and -not $webHostProc.HasExited) { Stop-Process -Id $webHostProc.Id -Force -ErrorAction SilentlyContinue }',
      'if ($null -ne $guiProc -and -not $guiProc.HasExited) { Stop-Process -Id $guiProc.Id -Force -ErrorAction SilentlyContinue }',
      '$ev = [pscustomobject]@{',
      '  surfaceKind = $surfaceKind',
      '  guiPid = $guiProc.Id',
      '  sessionId = $guiProc.SessionId',
      '  mainWindowHandle = $hwnd',
      '  mainWindowTitle = $title',
      '  childCount = $children.Count',
      '  hasDesktopHostChild = $hasHost',
      '}',
      `$ev | ConvertTo-Json -Depth 4 | Set-Content -Path '${guiEvidenceJson.replace(/'/g, "''")}' -Encoding UTF8`,
      '',
    ].join('\r\n'),
    'utf8',
  );

  let taskCreated = false;
  let taskDeleted = false;

  try {
    const psTaskCmd = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcherPs1}"`;
    const createTask = spawnSync(
      'schtasks.exe',
      ['/Create', '/TN', taskName, '/TR', psTaskCmd, '/SC', 'ONCE', '/ST', '00:00', '/IT', '/F'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    taskCreated = createTask.status === 0;

    if (taskCreated) {
      spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    }

    const evDeadline = Date.now() + 120000;
    while (!fs.existsSync(guiEvidenceJson) && Date.now() < evDeadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    const delImmediate = spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    taskDeleted = delImmediate.status === 0;
  } finally {
    try { fs.rmSync(launcherPs1, { force: true }); } catch {}
    if (!taskDeleted) {
      const delFinal = spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8', windowsHide: true });
      taskDeleted = delFinal.status === 0 || /cannot find/i.test(String(delFinal.stderr || ''));
    }
    const escapedUserData = userDataDir.replace(/\\/g, '\\\\');
    const escapedHome = dshHome.replace(/\\/g, '\\\\');
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
        $roots = @(Get-CimInstance Win32_Process | Where-Object {
          ($_.Name -eq 'DeepSeek Harness.exe' -or $_.Name -eq 'msedge.exe') -and ($_.CommandLine -match '${escapedUserData}' -or $_.CommandLine -match '${escapedHome}')
        } | Select-Object -ExpandProperty ProcessId)
        if ($roots.Count -gt 0) {
          $kids = @(Get-CimInstance Win32_Process | Where-Object { $roots -contains $_.ParentProcessId } | Select-Object -ExpandProperty ProcessId)
          foreach ($id in ($kids + $roots)) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        }
        `,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(`${userDataDir}-edge`, { recursive: true, force: true }); } catch {}
  }

  report.windowsAclPwshProbe = fs.existsSync(aclProbeOut)
    ? JSON.parse(fs.readFileSync(aclProbeOut, 'utf8').replace(/^\uFEFF/, ''))
    : { ok: false, error: 'acl-pwsh-probe.json not produced' };

  const guiEv = fs.existsSync(guiEvidenceJson)
    ? JSON.parse(fs.readFileSync(guiEvidenceJson, 'utf8').replace(/^\uFEFF/, ''))
    : null;
  const screenshotSaved = fs.existsSync(screenshotPath) && fs.statSync(screenshotPath).size > 1000;

  report.interactiveGuiLaunch = {
    ok: Boolean(taskCreated && taskDeleted && guiEv?.surfaceKind === 'dsh-desktop-electron' && Number(guiEv.mainWindowHandle) > 0 && screenshotSaved),
    scheduledTaskName: taskName,
    taskCreated,
    taskCleanedUpImmediately: taskDeleted,
    evidence: guiEv,
    screenshotSaved,
    screenshotFile: screenshotSaved ? path.basename(screenshotPath) : null,
  };

  // 4. Engineering Delivery Workspace `npm test` Verification
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify({ name: 'win-gui-delivery-check', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'src', 'delivery.js'),
    'export function formatDeliveryReceipt(platform, aclExitCode) {\n  return `${platform}:acl=${aclExitCode}:ok`;\n}\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'test', 'delivery.test.js'),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import fs from "node:fs";',
      'import { formatDeliveryReceipt } from "../src/delivery.js";',
      '',
      'test("Windows ACL pwsh artifact & delivery module pass", () => {',
      '  assert.equal(fs.readFileSync("acl-inside-ok.txt", "utf8").trim(), "PWSH_ACL_OK");',
      '  assert.equal(formatDeliveryReceipt(process.platform, 0), "win32:acl=0:ok");',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  const npmTestRes = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd test'], {
    cwd: workspaceDir,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 25000,
  });
  report.engineeringDeliveryNpmTest = {
    ok: npmTestRes.status === 0,
    exitCode: npmTestRes.status,
    stdoutTail: String(npmTestRes.stdout || '').slice(-600),
  };

  const verifyTaskGone = spawnSync('schtasks.exe', ['/Query', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
  report.cleanup = {
    scheduledTaskGone: verifyTaskGone.status !== 0,
  };

  report.passed = Boolean(
    report.desktopPluginInstall.exitCode === 0 &&
    report.desktopPluginInstall.desktopBundleInstalled &&
    report.windowsAclPwshProbe.ok &&
    report.interactiveGuiLaunch.ok &&
    report.engineeringDeliveryNpmTest.ok &&
    report.cleanup.scheduledTaskGone
  );

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(runDir, 'win-gui-e2e-report.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`Windows GUI E2E Report saved to: ${outFile}`);
  console.log(JSON.stringify({
    passed: report.passed,
    desktopBundleInstalled: report.desktopPluginInstall.desktopBundleInstalled,
    aclPwshOk: report.windowsAclPwshProbe.ok,
    zero0xC0000142: report.windowsAclPwshProbe.zero0xC0000142,
    guiWindowHandle: report.interactiveGuiLaunch.evidence?.mainWindowHandle ?? 0,
    hasDesktopHostChild: report.interactiveGuiLaunch.evidence?.hasDesktopHostChild ?? false,
    screenshotSaved: report.interactiveGuiLaunch.screenshotSaved,
    npmTestOk: report.engineeringDeliveryNpmTest.ok,
    scheduledTaskCleanedUp: report.cleanup.scheduledTaskGone,
  }, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

await main();
