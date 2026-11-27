#!/usr/bin/env node
/**
 * `lt-installer` — Graphical One-Click Installer & Environment Wizard for LeaderTeam (Issue #2).
 *
 * - Default (`lt-installer` or double-clicked via `Install-LeaderTeam.cmd` / `install-leaderteam.sh`):
 *   Starts a secure loopback (`127.0.0.1`) Graphical Installer UI in the default browser with
 *   one-time launch token HttpOnly cookie auth, auto-detecting DSH Desktop & CLI installations,
 *   checking compatibility, installing `.tgz` or downloading from GitHub Releases, optionally configuring
 *   the user's first API Key, and launching DSH Desktop / Web Console with one click!
 * - Headless / CI mode (`--cli`, `--inspect`, `--json`):
 *   Runs automated detection or installation without opening a browser.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  inspectInstallerEnvironment,
  runOneClickInstallation,
  launchInstalledClient,
  translateInstallErrorToPlainChinese,
} from '../leaderteam/core/installer.mjs';
import { checkForUpdates } from '../leaderteam/core/updater.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isAllowedLoopbackHost(hostHeader, boundPort) {
  if (typeof hostHeader !== 'string' || !hostHeader || !boundPort) return false;
  const lower = hostHeader.trim().toLowerCase();
  return (
    lower === `127.0.0.1:${boundPort}` ||
    lower === `localhost:${boundPort}` ||
    lower === `[::1]:${boundPort}`
  );
}

function isAllowedOrigin(originHeader, hostHeader) {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string') return false;
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' && u.host.toLowerCase() === String(hostHeader || '').trim().toLowerCase();
  } catch {
    return false;
  }
}

function parseCookies(raw) {
  const out = {};
  for (const seg of String(raw || '').split(';')) {
    const idx = seg.indexOf('=');
    if (idx > 0) {
      const k = seg.slice(0, idx).trim();
      const v = seg.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function readBoundedBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        resolve({ tooLarge: true, buffer: null });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve({ tooLarge: false, buffer: Buffer.concat(chunks) });
    });
    req.on('error', err => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function openSystemBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref?.();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref?.();
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      child.unref?.();
    }
  } catch {}
}

export function renderInstallerHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LeaderTeam 一键安装与环境引导向导</title>
<style>
  :root {
    --bg: #f5f7f9;
    --surface: #ffffff;
    --surface-alt: #eef3f6;
    --ink: #1b3039;
    --muted: #566b75;
    --accent: #2a657c;
    --accent-hover: #215164;
    --seal: #92544e;
    --ok: #1f7a4c;
    --ok-bg: #e9f6ef;
    --warn: #9a6700;
    --warn-bg: #fff8e6;
    --err: #a3263f;
    --err-bg: #fdecef;
    --line: #d6e0e6;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.55;
  }
  .wrap { max-width: 860px; margin: 28px auto 60px; padding: 0 20px; }
  .hero {
    background: linear-gradient(135deg, #1b3039 0%, #2a657c 100%);
    color: #fff;
    padding: 26px 30px;
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgba(27,48,57,0.12);
    margin-bottom: 20px;
  }
  .hero h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: 0.3px; }
  .hero p { margin: 0; opacity: 0.9; font-size: 14px; }
  .steps-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 18px;
  }
  .step-pill {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
    font-size: 13px;
    color: var(--muted);
    font-weight: 500;
  }
  .step-pill.active { border-color: var(--accent); color: var(--accent); background: #f0f7fa; font-weight: 600; }
  .step-pill.done { border-color: var(--ok); color: var(--ok); background: var(--ok-bg); }
  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 22px 24px;
    margin-bottom: 16px;
    box-shadow: 0 2px 8px rgba(27,48,57,0.04);
  }
  .card h2 { margin: 0 0 12px; font-size: 17px; display: flex; align-items: center; justify-content: space-between; }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 9px;
    border-radius: 99px;
    font-size: 12px;
    font-weight: 600;
  }
  .badge.ok { background: var(--ok-bg); color: var(--ok); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .badge.err { background: var(--err-bg); color: var(--err); }
  .target-item {
    border: 1.5px solid var(--line);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 10px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .target-item.selected { border-color: var(--accent); background: #f4f9fc; }
  .target-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 600; }
  .target-meta { font-size: 12.5px; color: var(--muted); margin-top: 5px; word-break: break-all; }
  .field { margin-top: 12px; }
  .field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; }
  .field input, .field select {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    font-size: 14px;
    color: var(--ink);
    background: #fff;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  button {
    padding: 10px 18px;
    border-radius: 7px;
    border: 1px solid transparent;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  button.primary { background: var(--accent); color: #fff; }
  button.primary:hover:not(:disabled) { background: var(--accent-hover); }
  button.secondary { background: var(--surface-alt); color: var(--ink); border-color: var(--line); }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  .alert { padding: 14px 16px; border-radius: 8px; margin-top: 12px; font-size: 13.5px; }
  .alert.err { background: var(--err-bg); color: var(--err); border: 1px solid #f2b8c4; }
  .alert.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #f0d799; }
  .alert.ok { background: var(--ok-bg); color: var(--ok); border: 1px solid #b5e2c9; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { background: var(--surface-alt); font-weight: 600; }
  .log-box {
    background: #142026;
    color: #d9e7ee;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    padding: 12px 14px;
    border-radius: 7px;
    max-height: 180px;
    overflow: auto;
    margin-top: 12px;
  }
  details summary { cursor: pointer; font-weight: 600; font-size: 13.5px; color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>LeaderTeam 图形化一键安装器</h1>
    <p>自动识别 DeepSeek Harness 安装环境、校验宿主版本兼容性、一键完成插件安装与初始模型配置——全程无需命令行。</p>
  </div>

  <div class="steps-bar">
    <div id="sp1" class="step-pill active">1. 环境与兼容检测</div>
    <div id="sp2" class="step-pill">2. 选择版本与模型(可选)</div>
    <div id="sp3" class="step-pill">3. 一键自动安装</div>
    <div id="sp4" class="step-pill">4. 直接启动客户端</div>
  </div>

  <div class="card">
    <h2>
      <span>第一步：本机 DeepSeek Harness 环境自动识别</span>
      <button class="secondary" id="btnRescan" type="button">重新扫描</button>
    </h2>
    <div id="targetsBox">正在扫描本机环境…</div>
    <div class="field">
      <label for="customDshInput">手动指定 DeepSeek Harness 安装目录（可选）</label>
      <div class="row" style="margin-top:6px">
        <input id="customDshInput" type="text" placeholder="例如 D:\\Apps\\DeepSeek-Harness（留空则自动扫描全盘与注册表）" style="flex:1" />
        <button class="secondary" id="btnProbeCustom" type="button">检测此目录</button>
      </div>
    </div>
    <div id="legacyBox"></div>
    <div style="margin-top:12px">
      <details>
        <summary>查看完整 DSH 宿主版本兼容性列表</summary>
        <div id="matrixBox"></div>
      </details>
    </div>
  </div>

  <div class="card">
    <h2><span>第二步：选择安装来源与快速模型接入（可选）</span></h2>
    <div class="field">
      <label for="sourceSelect">安装包来源</label>
      <select id="sourceSelect"></select>
    </div>
    <div class="field" id="uploadRow" style="display:none">
      <label for="tgzFileInput">选择本地已下载的 <code>dsh-leaderteam-*.tgz</code> 安装包</label>
      <input id="tgzFileInput" type="file" accept=".tgz,application/gzip" />
    </div>
    <div class="field" id="localPathRow" style="display:none">
      <label for="localTgzPathInput">填写本地 <code>.tgz</code> 安装包完整路径</label>
      <input id="localTgzPathInput" type="text" placeholder="例如 D:\\Downloads\\dsh-leaderteam-2.2.3.tgz" />
    </div>
    <div class="field">
      <label for="providerSelect">首次使用免命令行接入模型（可留空，安装后在控制台向导中配置）</label>
      <div class="row">
        <select id="providerSelect" style="width:220px"></select>
        <input id="apiKeyInput" type="password" placeholder="粘贴对应厂商的 API Key（可选，本地安全存储）" style="flex:1" />
      </div>
      <div id="providerHint" class="target-meta"></div>
    </div>
  </div>

  <div class="card">
    <h2><span>第三步：执行一键安装</span></h2>
    <div class="row">
      <button class="primary" id="btnInstall" type="button">立即一键安装 LeaderTeam</button>
    </div>
    <div id="progressBox" class="log-box" style="display:none"></div>
    <div id="resultBox"></div>
  </div>

  <div class="card" id="launchCard" style="display:none">
    <h2><span>第四步：安装完成 — 立即开始使用</span></h2>
    <p style="margin-top:0;font-size:14px;color:var(--muted)" id="nextHintText"></p>
    <div class="row">
      <button class="primary" id="btnLaunch" type="button">立即启动客户端并进入新手引导</button>
    </div>
    <div id="launchStatus"></div>
  </div>
</div>

<script>
(function() {
  let state = null;
  let selectedTargetId = null;

  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      const err = new Error((json.error && json.error.message) || ('HTTP ' + res.status));
      err.friendly = json.error && json.error.friendly;
      throw err;
    }
    return json.data;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderEnv(envData) {
    state = envData;
    const box = document.getElementById('targetsBox');
    if (!envData.targets || envData.targets.length === 0) {
      box.innerHTML = '<div class="alert warn"><strong>未自动检测到已安装的 DeepSeek Harness</strong><br>请先安装官方 DeepSeek Harness 客户端（版本 &gt;= 0.2.2-rc.1），或展开下方输入框指定您的客户端目录。</div>';
    } else {
      if (!selectedTargetId || !envData.targets.some(t => t.id === selectedTargetId)) {
        const rec = envData.targets.find(t => t.recommended) || envData.targets[0];
        selectedTargetId = rec.id;
      }
      box.innerHTML = envData.targets.map(t => {
        const compat = t.compatibility || {};
        const badgeCls = compat.productionAllowed ? 'ok' : 'err';
        const badgeText = compat.classification === 'VERIFIED'
          ? '已实机认证兼容 (' + (t.dshVersion || '') + ')'
          : (compat.productionAllowed ? '结构契约兼容 (' + (t.dshVersion || '') + ')' : '版本不兼容 (' + (t.dshVersion || '未知') + ')');
        const installedTag = t.installedLtVersion ? ' · 当前已装 LT v' + esc(t.installedLtVersion) : ' · 尚未安装 LT';
        const warnRunning = (t.kind === 'official-desktop' && t.desktopRunning)
          ? '<div class="alert warn" style="margin-top:8px">检测到 DeepSeek Harness 桌面端正在运行，请先退出客户端后再点击安装。</div>'
          : '';
        return '<div class="target-item ' + (t.id === selectedTargetId ? 'selected' : '') + '" data-tid="' + esc(t.id) + '">' +
          '<div class="target-head"><span>' + esc(t.label) + '</span><span class="badge ' + badgeCls + '">' + esc(badgeText) + '</span></div>' +
          '<div class="target-meta">路径：' + esc(t.installDir) + ' · Profile：' + esc(t.profile) + installedTag + '</div>' +
          warnRunning +
          '</div>';
      }).join('');
      box.querySelectorAll('.target-item').forEach(el => {
        el.addEventListener('click', () => {
          selectedTargetId = el.getAttribute('data-tid');
          renderEnv(state);
        });
      });
    }

    const legacyBox = document.getElementById('legacyBox');
    if (envData.legacyPatchConflicts && envData.legacyPatchConflicts.length > 0) {
      legacyBox.innerHTML = '<div class="alert warn">检测到 ' + envData.legacyPatchConflicts.length + ' 处旧版 V2.1 配置文件补丁，一键安装时将自动为您备份并无损清理。</div>';
    } else {
      legacyBox.innerHTML = '';
    }

    // Matrix
    const mRows = (envData.compatibilityMatrix && envData.compatibilityMatrix.rows) || [];
    document.getElementById('matrixBox').innerHTML = '<table><thead><tr><th>DSH 版本系列</th><th>适用形态</th><th>状态</th><th>说明</th></tr></thead><tbody>' +
      mRows.map(r => '<tr><td><code>' + esc(r.versionPattern) + '</code></td><td>' + esc((r.surfaces || []).join(' / ')) + '</td><td><span class="badge ' + (r.productionAllowed ? 'ok' : 'err') + '">' + esc(r.statusLabel) + '</span></td><td>' + esc(r.notes) + '</td></tr>').join('') +
      '</tbody></table>';

    // Source options
    const srcSel = document.getElementById('sourceSelect');
    const opts = [];
    (envData.bundledTarballs || []).forEach(b => {
      opts.push({ val: 'bundled:' + b.path, label: '使用随附离线安装包：' + b.fileName + ' (v' + b.version + ')' });
    });
    if (envData.localSourceBundle && envData.localSourceBundle.available) {
      opts.push({ val: 'local-source', label: '使用当前本地目录插件源码包 (v' + envData.localSourceBundle.version + ')' });
    }
    opts.push({ val: 'download:open-source', label: '在线下载最新「开源维护版 (Apache-2.0)」官方发布包' });
    opts.push({ val: 'download:closed-free', label: '在线下载最新「闭源免费公开发行版」官方发布包' });
    opts.push({ val: 'upload-tgz', label: '手动选择电脑上的 .tgz 安装包文件…' });
    opts.push({ val: 'path-tgz', label: '手动输入本地 .tgz 安装包完整路径…' });
    srcSel.innerHTML = opts.map(o => '<option value="' + esc(o.val) + '">' + esc(o.label) + '</option>').join('');
    srcSel.onchange = () => {
      document.getElementById('uploadRow').style.display = srcSel.value === 'upload-tgz' ? 'block' : 'none';
      document.getElementById('localPathRow').style.display = srcSel.value === 'path-tgz' ? 'block' : 'none';
    };
    srcSel.onchange();

    // Providers
    const pSel = document.getElementById('providerSelect');
    const presets = envData.providerPresets || [];
    pSel.innerHTML = '<option value="">暂不填写（进入控制台后再引导配置）</option>' +
      presets.map(p => '<option value="' + esc(p.id) + '">' + esc(p.displayName) + ' (' + esc(p.envVar) + ')</option>').join('');
    pSel.onchange = () => {
      const hit = presets.find(p => p.id === pSel.value);
      document.getElementById('providerHint').textContent = hit ? hit.guideHint : '安装完成后首次进入控制台也会弹出图形化三步配置向导。';
    };
    pSel.onchange();
  }

  async function scan(customPath) {
    try {
      const data = await api('/api/installer/inspect', { customDshPath: customPath || null });
      renderEnv(data);
    } catch (e) {
      document.getElementById('targetsBox').innerHTML = '<div class="alert err">环境扫描失败：' + esc(e.message) + '</div>';
    }
  }

  document.getElementById('btnRescan').onclick = () => scan(null);
  document.getElementById('btnProbeCustom').onclick = () => scan(document.getElementById('customDshInput').value.trim());

  document.getElementById('btnInstall').onclick = async () => {
    const btn = document.getElementById('btnInstall');
    const prog = document.getElementById('progressBox');
    const resBox = document.getElementById('resultBox');
    btn.disabled = true;
    resBox.innerHTML = '';
    prog.style.display = 'block';
    prog.textContent = '准备开始安装…\\n';
    document.getElementById('sp2').className = 'step-pill done';
    document.getElementById('sp3').className = 'step-pill active';

    try {
      const srcVal = document.getElementById('sourceSelect').value;
      const customPathVal = document.getElementById('customDshInput').value.trim();
      let payload = {
        targetId: selectedTargetId,
        customDshPath: customPathVal || null,
        providerId: document.getElementById('providerSelect').value,
        apiKey: document.getElementById('apiKeyInput').value.trim(),
      };
      if (srcVal.startsWith('bundled:')) {
        payload.sourceKind = 'local-tgz';
        payload.localTgzPath = srcVal.slice('bundled:'.length);
      } else if (srcVal === 'local-source') {
        payload.sourceKind = 'local-source';
      } else if (srcVal.startsWith('download:')) {
        payload.sourceKind = 'download-release';
        payload.track = srcVal.slice('download:'.length);
      } else if (srcVal === 'path-tgz') {
        const localP = document.getElementById('localTgzPathInput').value.trim();
        if (!localP) throw new Error('请先输入本地 .tgz 安装包的完整路径');
        payload.sourceKind = 'local-tgz';
        payload.localTgzPath = localP;
      } else if (srcVal === 'upload-tgz') {
        const fileInput = document.getElementById('tgzFileInput');
        const file = fileInput.files && fileInput.files[0];
        if (!file) throw new Error('请先选择本地 .tgz 安装包文件');
        prog.textContent += '正在上传本地安装包 ' + file.name + '…\\n';
        const upRes = await fetch('/api/installer/upload-tgz?name=' + encodeURIComponent(file.name), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: await file.arrayBuffer()
        });
        const upJson = await upRes.json();
        if (!upRes.ok || !upJson.ok) throw new Error((upJson.error && upJson.error.message) || '上传安装包失败');
        payload.sourceKind = 'local-tgz';
        payload.localTgzPath = upJson.data.stagedPath;
      }

      prog.textContent += '正在执行环境检查、插件安装与健康验证（首次安装可能需要 10~40 秒，请稍候）…\\n';
      const out = await api('/api/installer/install', payload);
      prog.textContent += '✔ 安装成功！版本：Open Leader Team (OLT) v' + (out.installedVersion || '') + ' (' + out.installedTrack + ')\\n';
      resBox.innerHTML = '<div class="alert ok"><strong>Open Leader Team (OLT) v' + esc(out.installedVersion || '') + ' 安装成功！</strong><br>' + esc(out.nextStepHint) + '</div>';
      document.getElementById('sp1').className = 'step-pill done';
      document.getElementById('sp3').className = 'step-pill done';
      document.getElementById('sp4').className = 'step-pill active';
      document.getElementById('nextHintText').textContent = out.nextStepHint;
      document.getElementById('launchCard').style.display = 'block';
      await scan(null);
    } catch (e) {
      const f = e.friendly || { title: '安装未完成', friendlyMessage: e.message, suggestion: '请根据提示检查后重试。', rawDetail: e.message };
      prog.textContent += '✖ ' + f.title + '\\n';
      resBox.innerHTML = '<div class="alert err"><strong>' + esc(f.title) + '</strong><br>' + esc(f.friendlyMessage) +
        '<br><strong>处理建议：</strong>' + esc(f.suggestion) +
        '<details style="margin-top:6px"><summary style="color:inherit">查看技术详情</summary><pre style="white-space:pre-wrap;margin:6px 0 0;font-size:12px">' + esc(f.rawDetail || e.message) + '</pre></details></div>';
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btnLaunch').onclick = async () => {
    const statusEl = document.getElementById('launchStatus');
    statusEl.innerHTML = '<div class="alert ok">正在为您启动客户端…</div>';
    try {
      const res = await api('/api/installer/launch', { targetId: selectedTargetId });
      statusEl.innerHTML = '<div class="alert ok">' + esc(res.message) + '</div>';
      if (res.url) {
        setTimeout(() => { window.location.href = res.url; }, 800);
      }
    } catch (e) {
      statusEl.innerHTML = '<div class="alert err">启动失败：' + esc(e.message) + '</div>';
    }
  };

  scan(null);
})();
</script>
</body>
</html>`;
}

export async function startInstallerGuiServer({
  port = 0,
  dshHome = null,
  repoRoot = REPO_ROOT,
  openBrowser = true,
} = {}) {
  const launchToken = crypto.randomBytes(24).toString('hex');
  const sessionSecret = crypto.randomBytes(24).toString('hex');
  const uploadedFiles = new Set();

  const server = http.createServer(async (req, res) => {
    const boundPort = server.address()?.port;
    const cookieName = `lt_installer_sid_${boundPort}`;

    const sendJson = (status, obj, extraHeaders = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders,
      });
      res.end(JSON.stringify(obj));
    };

    if (!isAllowedLoopbackHost(req.headers.host, boundPort)) {
      sendJson(403, { ok: false, error: { code: 'FORBIDDEN_HOST', message: 'Loopback host required' } });
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    if (req.method === 'GET' && pathname === '/') {
      const qToken = parsedUrl.searchParams.get('token');
      if (qToken && safeEqual(qToken, launchToken)) {
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${cookieName}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      const cookies = parseCookies(req.headers.cookie);
      if (!safeEqual(cookies[cookieName], sessionSecret)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized: open the full installer URL printed by lt-installer.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(renderInstallerHtml());
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const bearer = String(req.headers.authorization || '').startsWith('Bearer ')
      ? String(req.headers.authorization).slice(7).trim()
      : null;
    const authed = safeEqual(cookies[cookieName], sessionSecret) || (bearer && safeEqual(bearer, launchToken));
    if (!authed) {
      sendJson(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid installer session' } });
      return;
    }
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      sendJson(403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin request blocked' } });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } }, { Allow: 'POST' });
      return;
    }

    try {
      if (pathname === '/api/installer/upload-tgz') {
        const rawName = path.posix.basename(String(parsedUrl.searchParams.get('name') || 'package.tgz'));
        if (!rawName.endsWith('.tgz')) {
          sendJson(400, { ok: false, error: { message: '仅支持上传 .tgz 文件' } });
          return;
        }
        const readRes = await readBoundedBody(req, MAX_UPLOAD_BYTES);
        if (readRes.tooLarge) {
          sendJson(413, { ok: false, error: { message: '安装包体积超出上限' } });
          return;
        }
        const envSnap = inspectInstallerEnvironment({ repoRoot, dshHome });
        const stageDir = path.join(envSnap.dshHome, 'leaderteam', 'installer-uploads');
        fs.mkdirSync(stageDir, { recursive: true });
        const stagedPath = path.join(stageDir, `${Date.now()}-${rawName}`);
        fs.writeFileSync(stagedPath, readRes.buffer);
        uploadedFiles.add(stagedPath);
        sendJson(200, { ok: true, data: { stagedPath, sizeBytes: readRes.buffer.length } });
        return;
      }

      const bodyRes = await readBoundedBody(req);
      if (bodyRes.tooLarge) {
        sendJson(413, { ok: false, error: { message: '请求体过大' } });
        return;
      }
      const body = bodyRes.buffer.length > 0 ? JSON.parse(bodyRes.buffer.toString('utf8')) : {};

      if (pathname === '/api/installer/inspect') {
        const data = inspectInstallerEnvironment({
          repoRoot,
          dshHome,
          customDshPath: body.customDshPath || null,
        });
        sendJson(200, { ok: true, data });
        return;
      }

      if (pathname === '/api/installer/check-release') {
        const data = await checkForUpdates({
          pluginRoot: repoRoot,
          track: body.track || 'open-source',
          targetVersion: body.targetVersion || body.version || null,
          force: true,
        });
        sendJson(200, { ok: true, data });
        return;
      }

      if (pathname === '/api/installer/install') {
        const out = await runOneClickInstallation({
          repoRoot,
          dshHome,
          customDshPath: body.customDshPath || null,
          targetId: body.targetId || null,
          sourceKind: body.sourceKind || 'auto',
          localTgzPath: body.localTgzPath || null,
          track: body.track || 'open-source',
          targetVersion: body.targetVersion || body.version || null,
          providerId: body.providerId || '',
          apiKey: body.apiKey || '',
        });
        sendJson(200, { ok: true, data: out });
        return;
      }

      if (pathname === '/api/installer/launch') {
        const out = await launchInstalledClient({
          repoRoot,
          dshHome,
          targetId: body.targetId || null,
          webPort: Number(body.webPort) || 4096,
        });
        sendJson(200, { ok: true, data: out });
        return;
      }

      sendJson(404, { ok: false, error: { code: 'NOT_FOUND', message: `Unknown route: ${pathname}` } });
    } catch (err) {
      const friendly = err.friendly || translateInstallErrorToPlainChinese(err);
      sendJson(400, {
        ok: false,
        error: {
          code: friendly.code || 'INSTALL_FAILED',
          message: friendly.friendlyMessage || err.message,
          friendly,
        },
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const boundPort = server.address().port;
  const launchUrl = `http://127.0.0.1:${boundPort}/?token=${launchToken}`;
  if (openBrowser) openSystemBrowser(launchUrl);

  return {
    server,
    port: boundPort,
    launchToken,
    url: launchUrl,
    async close() {
      for (const f of uploadedFiles) {
        try { fs.rmSync(f, { force: true }); } catch {}
      }
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

function parseArgs(argv) {
  const opts = {
    gui: true,
    inspectOnly: false,
    json: false,
    help: false,
    noOpen: false,
    port: 0,
    dshHome: null,
    customDshPath: null,
    targetId: null,
    tgz: null,
    version: null,
    track: 'open-source',
    provider: '',
    launch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gui') opts.gui = true;
    else if (a === '--cli' || a === '--non-interactive') opts.gui = false;
    else if (a === '--inspect') { opts.gui = false; opts.inspectOnly = true; }
    else if (a === '--json') opts.json = true;
    else if (a === '--no-open') opts.noOpen = true;
    else if (a === '--launch') opts.launch = true;
    else if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]) || 0;
    else if (a === '--dsh-home' && argv[i + 1]) opts.dshHome = argv[++i];
    else if (a === '--custom-path' && argv[i + 1]) opts.customDshPath = argv[++i];
    else if (a === '--target' && argv[i + 1]) opts.targetId = argv[++i];
    else if (a === '--tgz' && argv[i + 1]) opts.tgz = argv[++i];
    else if ((a === '--version' || a === '--tag') && argv[i + 1]) opts.version = argv[++i];
    else if (a === '--track' && argv[i + 1]) opts.track = argv[++i];
    else if (a === '--provider' && argv[i + 1]) opts.provider = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log([
    'Usage: lt-installer [options]',
    '',
    'Options:',
    '  --gui                   Start graphical browser-based one-click installer (default)',
    '  --no-open               Do not auto-open browser in --gui mode',
    '  --cli                   Run automated non-interactive installation',
    '  --inspect               Scan local DSH installations and print summary',
    '  --custom-path <dir>     Specify custom DSH installation folder',
    '  --tgz <file>            Install a specific local .tgz bundle',
    '  --version <tag>         Target platform release tag (e.g. windows-v2.2.3 or linux-v2.2.3)',
    '  --track <id>            Track when downloading: open-source | closed-free',
    '  --dsh-home <dir>        Override DSH_HOME directory',
    '  --launch                Launch DSH client immediately after --cli install',
    '  --json                  Output machine-readable JSON (with --cli / --inspect)',
    '  -h, --help              Show this help message',
  ].join('\n'));
}

function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return path.resolve(argv1) === fileURLToPath(metaUrl);
  }
}

if (isMain(import.meta.url)) {
  (async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      printHelp();
      process.exit(0);
    }
    if (opts.inspectOnly) {
      const snap = inspectInstallerEnvironment({
        dshHome: opts.dshHome,
        customDshPath: opts.customDshPath,
      });
      if (opts.json) console.log(JSON.stringify(snap, null, 2));
      else {
        console.log(`Detected ${snap.targets.length} DeepSeek Harness environment(s):`);
        for (const t of snap.targets) {
          console.log(`  - [${t.compatibility.classification}] ${t.label} (${t.dshVersion || 'unknown'}) @ ${t.installDir}`);
        }
      }
      process.exit(0);
    }
    if (!opts.gui) {
      try {
        const res = await runOneClickInstallation({
          dshHome: opts.dshHome,
          customDshPath: opts.customDshPath,
          targetId: opts.targetId,
          sourceKind: opts.tgz ? 'local-tgz' : (opts.version ? 'download-release' : 'auto'),
          localTgzPath: opts.tgz,
          track: opts.track,
          targetVersion: opts.version,
          providerId: opts.provider,
        });
        let launchRes = null;
        if (opts.launch) {
          launchRes = await launchInstalledClient({ dshHome: opts.dshHome, targetId: res.target.id });
        }
        if (opts.json) console.log(JSON.stringify({ ok: true, install: res, launch: launchRes }, null, 2));
        else console.log(`✔ Open Leader Team (OLT) v${res.installedVersion} installed into ${res.target.label}.\n${res.nextStepHint}`);
        process.exit(0);
      } catch (e) {
        const f = e.friendly || translateInstallErrorToPlainChinese(e);
        if (opts.json) console.log(JSON.stringify({ ok: false, error: f }, null, 2));
        else console.error(`✖ ${f.title}\n  ${f.friendlyMessage}\n  建议：${f.suggestion}`);
        process.exit(1);
      }
    }

    const srv = await startInstallerGuiServer({
      port: opts.port,
      dshHome: opts.dshHome,
      openBrowser: !opts.noOpen,
    });
    console.log([
      '============================================================',
      '  Open Leader Team (OLT) 图形化一键安装向导已启动',
      `  请在浏览器打开：${srv.url}`,
      '  （完成安装后按 Ctrl+C 即可关闭本窗口）',
      '============================================================',
    ].join('\n'));
  })().catch(err => {
    console.error(`lt-installer error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
