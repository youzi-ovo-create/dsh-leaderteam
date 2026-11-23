// Zero-dependency loopback Web UI server for visually editing LeaderTeam member models,
// reasoning efforts, candidate pool, and governance roles outside DeepSeek Harness Desktop.
// Strictly binds to 127.0.0.1 and enforces Host/Origin validation + per-instance CSRF token.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectModelConfiguration, applyModelConfigChanges, resolveDefaultDshHome } from './model-config-writer.mjs';

const MAX_BODY_BYTES = 256 * 1024;

function isAllowedLoopbackHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const expectedA = `127.0.0.1:${port}`;
  const expectedB = `localhost:${port}`;
  const lower = hostHeader.trim().toLowerCase();
  return lower === expectedA || lower === expectedB;
}

function isAllowedOrigin(originHeader, port) {
  if (originHeader === undefined) return true; // same-origin GET or local non-browser client with token
  const lower = String(originHeader).trim().toLowerCase();
  return lower === `http://127.0.0.1:${port}` || lower === `http://localhost:${port}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function runDesktopSync({ projectRoot, dshHome, profile = 'desktop', dryRun = false }) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Desktop installer sync requires Windows PowerShell (install-desktop.ps1).' };
  }
  const script = path.join(projectRoot, 'scripts', 'install-desktop.ps1');
  const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', profile];
  if (dshHome) psArgs.push('-DshHome', dshHome);
  if (dryRun) psArgs.push('-DryRun');
  const r = spawnSync('powershell', psArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    exitCode: r.status ?? 1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

function renderHtml(csrfToken) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LeaderTeam 模型与成员池配置器</title>
<style>
  :root {
    --bg: #0f172a;
    --panel: #1e293b;
    --panel-alt: #0b1220;
    --border: #334155;
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #38bdf8;
    --accent-hover: #0ea5e9;
    --ok: #22c55e;
    --warn: #f59e0b;
    --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.5;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: var(--muted); font-size: 13px; }
  .banner {
    padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--panel); margin-bottom: 16px; font-size: 13px;
  }
  .banner.ok { border-color: rgba(34,197,94,0.45); }
  .banner.warn { border-color: rgba(245,158,11,0.55); }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 16px; margin-bottom: 18px;
  }
  .card h2 { font-size: 16px; margin: 0 0 12px 0; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button {
    background: #334155; color: var(--text); border: 1px solid #475569;
    border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #475569; }
  button.primary { background: var(--accent-hover); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover { background: #0284c7; }
  button.danger { background: rgba(239,68,68,0.16); border-color: rgba(239,68,68,0.5); color: #fca5a5; }
  select, input[type="text"], input[type="number"] {
    background: var(--panel-alt); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 8px; font-size: 13px;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border-bottom: 1px solid var(--border); padding: 8px 6px; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .tag {
    display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
    border: 1px solid var(--border); background: var(--panel-alt); color: var(--muted);
  }
  .tag.gpt { color: #fca5a5; border-color: rgba(239,68,68,0.4); }
  .tag.glm { color: #86efac; border-color: rgba(34,197,94,0.4); }
  .tag.gemini { color: #93c5fd; border-color: rgba(59,130,246,0.4); }
  .eff-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .eff-chip { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; background: var(--panel-alt); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border); }
  .grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; align-items: end; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .field input, .field select { width: 100%; }
  pre#statusLog {
    background: var(--panel-alt); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; margin: 0;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>LeaderTeam 外部模型与成员配置器</h1>
      <div class="sub" id="filePaths">正在读取本机配置…</div>
    </div>
    <div class="toolbar">
      <label class="sub">写入目标：</label>
      <select id="targetSelect">
        <option value="base">正式配置 (leaderteam.config.json + 自动同步 YAML)</option>
        <option value="local">本机覆盖 (leaderteam.local.json)</option>
      </select>
      <button id="reloadBtn">刷新状态</button>
      <button id="dryRunBtn">预览校验 (Dry Run)</button>
      <button id="saveBtn" class="primary">原子保存配置</button>
    </div>
  </header>

  <div id="syncBanner" class="banner">正在检查 Desktop 同步状态…</div>

  <div class="card">
    <h2>
      <span>1. 成员候选模型池 (<code>team.executionPool</code>) 与模型目录 (<code>models</code>)</span>
      <span class="toolbar">
        <button id="btnDisableGpt">成员池排除全部 GPT（保护 Codex 额度）</button>
        <button id="btnEnableAll">全部加入成员池</button>
      </span>
    </h2>
    <div class="sub" style="margin-bottom:10px;">
      勾选“允许成员使用”后，领队在 <code>team_models</code> / <code>team_dispatch</code> 中即可按能力和额度调度该模型及所勾选的推理档位。对已注册模型的开关和档位收窄会在运行中的 DSH 会话中实时热重载生效。
    </div>
    <table>
      <thead>
        <tr>
          <th style="width:74px;">允许成员</th>
          <th>路由 (provider/model) 与名称</th>
          <th style="width:95px;">家族</th>
          <th style="width:250px;">可选推理档位 (efforts)</th>
          <th style="width:105px;">默认档位</th>
          <th>领队选型参考 (strengths)</th>
          <th style="width:70px;">操作</th>
        </tr>
      </thead>
      <tbody id="modelsBody"></tbody>
    </table>

    <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border);">
      <div style="font-size:13px; font-weight:600; margin-bottom:8px;">新增或更新模型路由</div>
      <div class="grid-form">
        <div class="field"><label>模型路由 (如 antigravity/gemini-4-carbon)</label><input id="newRoute" type="text" placeholder="provider/model" /></div>
        <div class="field"><label>显示名称 (label)</label><input id="newLabel" type="text" placeholder="Gemini 4 Carbon" /></div>
        <div class="field"><label>模型家族</label><select id="newFamily"></select></div>
        <div class="field"><label>支持档位 (逗号分隔)</label><input id="newEfforts" type="text" value="low,medium,high" /></div>
        <div class="field"><label>默认档位</label><input id="newDefaultEffort" type="text" value="medium" /></div>
        <div class="field"><label>额度窗口过滤 (可选, 逗号分隔)</label><input id="newQuotaWindows" type="text" placeholder="留空表示该账户全部窗口" /></div>
        <div class="field" style="grid-column: span 2;"><label>特长说明 (strengths)</label><input id="newStrengths" type="text" placeholder="复杂实现、长文档分析…" /></div>
        <div class="field"><button id="addModelBtn">+ 加入列表（待保存）</button></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>
      <span>2. 领队与固定治理角色配置 (<code>roles</code>)</span>
      <span class="toolbar">
        <label class="sub">领队模型核对策略：</label>
        <select id="leaderPolicySelect">
          <option value="enforce">enforce（强制匹配）</option>
          <option value="warn">warn（仅提示不阻断）</option>
          <option value="off">off（关闭检查）</option>
        </select>
      </span>
    </h2>
    <p class="sub">治理角色与领队模型策略在新建团队（新会话）时生效，现有团队继续使用冻结的治理快照。成员模型池、允许档位和并发配置可即时更新。治理修改会记录操作用户、时间和变更内容。</p>
    <table>
      <thead>
        <tr>
          <th style="width:140px;">角色</th>
          <th style="width:280px;">模型路由 (route)</th>
          <th style="width:130px;">推理档位 (effort)</th>
          <th style="width:120px;">maxTokens</th>
          <th style="width:130px;">timeoutMs</th>
          <th style="width:90px;">retries</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody id="rolesBody"></tbody>
    </table>
  </div>

  <div class="card">
    <h2>
      <span>3. 执行结果与 Desktop 同步</span>
      <span class="toolbar">
        <button id="syncDesktopBtn">同步新模型到 Desktop 配置（需先退出 DSH）</button>
        <button id="clearLocalBtn" class="danger" style="display:none;">清除本机模型/角色覆盖</button>
      </span>
    </h2>
    <pre id="statusLog">就绪。</pre>
  </div>
</div>

<script>
const CSRF = ${JSON.stringify(csrfToken)};
const ROLE_META = {
  leader: '领队主会话基准模型（新建会话需选一致模型，或将策略改为 warn/off）',
  gate: '安全门模型审查（每次受控写入/命令/派发前执行，不计入执行并发）',
  discussA: '双盲讨论评审 A（计划与交付审阅）',
  discussB: '双盲讨论评审 B（计划与交付审阅）',
  arbiter: '独立裁断者（评审分歧时终局裁断）',
  serialReviewer: '串行方案辩护复核（充分、真实地说明为何选择串行；理由不足退回双评审）',
};
const STD_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

let state = null;
let draft = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-LT-Token': CSRF },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function log(obj) {
  document.getElementById('statusLog').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

function initDraftFromState(s) {
  const models = s.models.map(m => ({
    route: m.route,
    family: m.family,
    label: m.label,
    efforts: [...m.efforts],
    defaultEffort: m.defaultEffort,
    strengths: m.strengths || '',
    quotaWindows: m.quotaWindows ? [...m.quotaWindows] : null,
    inPool: m.inExecutionPool,
  }));
  // Sort pool items first in exact executionPool order, then non-pool items
  models.sort((a, b) => {
    const ia = s.executionPool.indexOf(a.route);
    const ib = s.executionPool.indexOf(b.route);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.route.localeCompare(b.route);
  });
  draft = {
    removedRoutes: [],
    models,
    roles: structuredClone(s.roles),
    leaderModelPolicy: s.leaderModelPolicy,
  };
}

function renderBanner() {
  const b = document.getElementById('syncBanner');
  const ds = state.desktopSync;
  const ov = state.localOverrides;
  const ovParts = [];
  if (ov.exists) {
    if (ov.executionPool) ovParts.push('executionPool');
    if (ov.leaderModelPolicy) ovParts.push('leaderModelPolicy');
    if (ov.roles.length) ovParts.push('roles(' + ov.roles.join(',') + ')');
    if (ov.models.length) ovParts.push('models(' + ov.models.join(',') + ')');
  }
  document.getElementById('clearLocalBtn').style.display = ovParts.length > 0 ? 'inline-block' : 'none';
  b.className = 'banner ' + (ds.hotReloadableNow ? 'ok' : 'warn');
  b.textContent = (ds.hotReloadableNow ? '实时热重载可用：' : '需要退出 DSH 同步一次：') + ds.note +
    (ovParts.length ? ' ｜ 当前存在 leaderteam.local.json 覆盖项：' + ovParts.join('、') : '');
  document.getElementById('filePaths').textContent =
    '正式配置：' + state.configFile + (state.localFile ? ' ｜ 本地覆盖：' + state.localFile : '');
}

function renderModels() {
  const tbody = document.getElementById('modelsBody');
  tbody.innerHTML = '';
  draft.models.forEach((m, idx) => {
    const tr = document.createElement('tr');
    const allEffs = [...new Set([...STD_EFFORTS, ...m.efforts])];

    const tdPool = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = m.inPool;
    cb.onchange = () => { m.inPool = cb.checked; };
    tdPool.appendChild(cb);
    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.style.padding = '1px 5px';
    upBtn.style.marginLeft = '6px';
    upBtn.disabled = idx === 0;
    upBtn.onclick = () => {
      const tmp = draft.models[idx - 1];
      draft.models[idx - 1] = draft.models[idx];
      draft.models[idx] = tmp;
      renderModels();
    };
    tdPool.appendChild(upBtn);
    tr.appendChild(tdPool);

    const tdRoute = document.createElement('td');
    const routeDiv = document.createElement('div');
    routeDiv.style.fontFamily = 'monospace';
    routeDiv.style.fontWeight = '600';
    routeDiv.textContent = m.route;
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.value = m.label;
    labelInput.style.marginTop = '4px';
    labelInput.style.width = '180px';
    labelInput.oninput = () => { m.label = labelInput.value; };
    tdRoute.appendChild(routeDiv);
    tdRoute.appendChild(labelInput);
    tr.appendChild(tdRoute);

    const tdFam = document.createElement('td');
    const famSel = document.createElement('select');
    state.supportedFamilies.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      if (f === m.family) opt.selected = true;
      famSel.appendChild(opt);
    });
    famSel.onchange = () => { m.family = famSel.value; };
    tdFam.appendChild(famSel);
    tr.appendChild(tdFam);

    const tdEff = document.createElement('td');
    const effWrap = document.createElement('div');
    effWrap.className = 'eff-list';
    allEffs.forEach(eff => {
      const chip = document.createElement('label');
      chip.className = 'eff-chip';
      const ecb = document.createElement('input');
      ecb.type = 'checkbox';
      ecb.checked = m.efforts.includes(eff);
      ecb.onchange = () => {
        if (ecb.checked && !m.efforts.includes(eff)) m.efforts.push(eff);
        if (!ecb.checked) m.efforts = m.efforts.filter(x => x !== eff);
        if (!m.efforts.includes(m.defaultEffort) && m.efforts.length > 0) m.defaultEffort = m.efforts[0];
        renderModels();
        renderRoles();
      };
      chip.appendChild(ecb);
      chip.appendChild(document.createTextNode(eff));
      effWrap.appendChild(chip);
    });
    tdEff.appendChild(effWrap);
    tr.appendChild(tdEff);

    const tdDef = document.createElement('td');
    const defSel = document.createElement('select');
    m.efforts.forEach(eff => {
      const opt = document.createElement('option');
      opt.value = eff; opt.textContent = eff;
      if (eff === m.defaultEffort) opt.selected = true;
      defSel.appendChild(opt);
    });
    defSel.onchange = () => { m.defaultEffort = defSel.value; };
    tdDef.appendChild(defSel);
    tr.appendChild(tdDef);

    const tdStr = document.createElement('td');
    const strIn = document.createElement('input');
    strIn.type = 'text';
    strIn.value = m.strengths;
    strIn.style.width = '100%';
    strIn.oninput = () => { m.strengths = strIn.value; };
    tdStr.appendChild(strIn);
    tr.appendChild(tdStr);

    const tdAct = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '移除';
    delBtn.style.padding = '3px 8px';
    delBtn.onclick = () => {
      const usedBy = Object.entries(draft.roles).filter(([, r]) => r.route === m.route).map(([k]) => k);
      if (usedBy.length > 0) {
        log('无法移除 ' + m.route + '：当前仍被角色 [' + usedBy.join(', ') + '] 使用，请先切换对应角色模型。');
        return;
      }
      if (!draft.removedRoutes.includes(m.route)) draft.removedRoutes.push(m.route);
      draft.models.splice(idx, 1);
      renderModels();
      renderRoles();
    };
    tdAct.appendChild(delBtn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });
}

function renderRoles() {
  document.getElementById('leaderPolicySelect').value = draft.leaderModelPolicy;
  const tbody = document.getElementById('rolesBody');
  tbody.innerHTML = '';
  Object.keys(ROLE_META).forEach(roleKey => {
    const r = draft.roles[roleKey];
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.innerHTML = '<strong>' + roleKey + '</strong>';
    tr.appendChild(tdName);

    const tdRoute = document.createElement('td');
    const routeSel = document.createElement('select');
    routeSel.style.width = '100%';
    draft.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.route;
      opt.textContent = m.route + ' (' + m.label + ')';
      if (m.route === r.route) opt.selected = true;
      routeSel.appendChild(opt);
    });
    const tdEff = document.createElement('td');
    const effSel = document.createElement('select');
    const populateEfforts = () => {
      effSel.innerHTML = '';
      const m = draft.models.find(x => x.route === r.route);
      const effs = m ? m.efforts : [r.effort];
      if (!effs.includes(r.effort) && effs.length > 0) r.effort = m ? m.defaultEffort : effs[0];
      effs.forEach(e => {
        const o = document.createElement('option');
        o.value = e; o.textContent = e;
        if (e === r.effort) o.selected = true;
        effSel.appendChild(o);
      });
    };
    routeSel.onchange = () => {
      r.route = routeSel.value;
      populateEfforts();
    };
    effSel.onchange = () => { r.effort = effSel.value; };
    populateEfforts();
    tdRoute.appendChild(routeSel);
    tdEff.appendChild(effSel);
    tr.appendChild(tdRoute);
    tr.appendChild(tdEff);

    ['maxTokens', 'timeoutMs', 'retries'].forEach(field => {
      const td = document.createElement('td');
      if (roleKey === 'leader') {
        td.textContent = '—';
      } else {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.style.width = '95px';
        inp.value = r[field];
        inp.oninput = () => { r[field] = Number.parseInt(inp.value, 10); };
        td.appendChild(inp);
      }
      tr.appendChild(td);
    });

    const tdDesc = document.createElement('td');
    tdDesc.className = 'sub';
    tdDesc.textContent = ROLE_META[roleKey];
    tr.appendChild(tdDesc);
    tbody.appendChild(tr);
  });
}

function buildChangesPayload() {
  const target = document.getElementById('targetSelect').value;
  const upsertModels = draft.models.map(m => ({
    route: m.route,
    family: m.family,
    label: m.label,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    strengths: m.strengths,
    ...(m.quotaWindows ? { quotaWindows: m.quotaWindows } : { clearQuotaWindows: true }),
  }));
  const poolSet = draft.models.filter(m => m.inPool).map(m => m.route);
  const setRoles = Object.entries(draft.roles).map(([role, spec]) => ({ role, ...spec }));
  return {
    target,
    changes: {
      ...(target === 'base' && draft.removedRoutes.length ? { removeModels: draft.removedRoutes, prunePool: true } : {}),
      upsertModels,
      poolSet,
      setRoles,
      leaderModelPolicy: document.getElementById('leaderPolicySelect').value,
    },
  };
}

async function refresh() {
  state = await api('GET', '/api/state');
  const famSel = document.getElementById('newFamily');
  famSel.innerHTML = '';
  state.supportedFamilies.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f; opt.textContent = f;
    if (f === 'gemini') opt.selected = true;
    famSel.appendChild(opt);
  });
  initDraftFromState(state);
  renderBanner();
  renderModels();
  renderRoles();
}

document.getElementById('reloadBtn').onclick = () => refresh().then(() => log('已从磁盘重新读取最新配置。')).catch(e => log('读取失败：' + e.message));
document.getElementById('leaderPolicySelect').onchange = e => { draft.leaderModelPolicy = e.target.value; };
document.getElementById('btnDisableGpt').onclick = () => {
  draft.models.forEach(m => { if (m.family === 'gpt') m.inPool = false; });
  renderModels();
};
document.getElementById('btnEnableAll').onclick = () => {
  draft.models.forEach(m => { m.inPool = true; });
  renderModels();
};
document.getElementById('addModelBtn').onclick = () => {
  const route = document.getElementById('newRoute').value.trim();
  if (!route || !route.includes('/')) { log('请填写形如 provider/model 的模型路由。'); return; }
  const label = document.getElementById('newLabel').value.trim() || route.slice(route.indexOf('/') + 1);
  const family = document.getElementById('newFamily').value;
  const efforts = document.getElementById('newEfforts').value.split(',').map(s => s.trim()).filter(Boolean);
  const defaultEffort = document.getElementById('newDefaultEffort').value.trim() || efforts[0] || 'medium';
  const qwRaw = document.getElementById('newQuotaWindows').value.trim();
  const quotaWindows = qwRaw ? qwRaw.split(',').map(s => s.trim()).filter(Boolean) : null;
  const strengths = document.getElementById('newStrengths').value.trim();
  draft.removedRoutes = draft.removedRoutes.filter(r => r !== route);
  const existing = draft.models.find(m => m.route === route);
  if (existing) {
    Object.assign(existing, { family, label, efforts, defaultEffort, strengths, quotaWindows, inPool: true });
  } else {
    draft.models.push({ route, family, label, efforts, defaultEffort, strengths, quotaWindows, inPool: true });
  }
  renderModels();
  renderRoles();
  log('已将 ' + route + ' 加入编辑草稿，点击右上角 [原子保存配置] 写入磁盘。');
};
document.getElementById('dryRunBtn').onclick = async () => {
  try {
    const payload = buildChangesPayload();
    const res = await api('POST', '/api/apply', { ...payload, dryRun: true });
    log(res);
  } catch (e) { log('校验未通过：' + e.message); }
};
document.getElementById('saveBtn').onclick = async () => {
  try {
    const payload = buildChangesPayload();
    const res = await api('POST', '/api/apply', { ...payload, dryRun: false });
    await refresh();
    log(res);
  } catch (e) { log('保存未完成，请刷新并核对配置和治理修改记录：' + e.message); }
};
document.getElementById('syncDesktopBtn').onclick = async () => {
  try {
    log('正在调用 scripts/install-desktop.ps1 同步 Desktop 配置…');
    const res = await api('POST', '/api/sync-desktop', {});
    await refresh();
    log(res);
  } catch (e) { log('同步 Desktop 失败：' + e.message); }
};
document.getElementById('clearLocalBtn').onclick = async () => {
  try {
    const res = await api('POST', '/api/apply', { target: 'local', dryRun: false, changes: { clearLocal: { all: true } } });
    await refresh();
    log(res);
  } catch (e) { log('清除本机覆盖失败：' + e.message); }
};
refresh().catch(e => log('初始化失败：' + e.message));
</script>
</body>
</html>`;
}

/** Start the loopback-only configuration UI server on 127.0.0.1. */
export async function startModelConfigServer(options = {}) {
  const configFile = path.resolve(options.configFile);
  const projectRoot = path.resolve(options.projectRoot ?? path.resolve(path.dirname(configFile), '..'));
  const requestedPort = options.port ?? 0;
  const csrfToken = options.csrfToken ?? crypto.randomBytes(32).toString('hex');

  let activePort = requestedPort;
  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedLoopbackHost(req.headers.host, activePort)) {
        return sendJson(res, 403, { error: 'Forbidden host header (loopback 127.0.0.1 only)' });
      }
      if (!isAllowedOrigin(req.headers.origin, activePort)) {
        return sendJson(res, 403, { error: 'Forbidden cross-origin request' });
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${activePort}`);

      if (req.method === 'GET' && url.pathname === '/') {
        const html = renderHtml(csrfToken);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        res.end(html);
        return;
      }

      // Every API route requires the per-instance X-LT-Token header
      if (req.headers['x-lt-token'] !== csrfToken) {
        return sendJson(res, 403, { error: 'Missing or invalid X-LT-Token' });
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const snap = inspectModelConfiguration({
          configFile,
          localFile: options.localFile,
          dshHome: options.dshHome,
          profile: options.profile,
          projectRoot,
        });
        return sendJson(res, 200, snap);
      }

      if (req.method === 'POST' && url.pathname === '/api/apply') {
        const body = await readJsonBody(req);
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const backupDir = body.dryRun
          ? null
          : (options.backupRoot
            ? path.join(path.resolve(options.backupRoot), `model-config-${stamp}`)
            : path.join(projectRoot, 'backups', 'model-config', `ui-${stamp}`));
        const result = applyModelConfigChanges(body.changes ?? {}, {
          configFile,
          localFile: options.localFile,
          target: body.target === 'local' ? 'local' : 'base',
          dryRun: Boolean(body.dryRun),
          backupDir,
          dshHome: options.dshHome,
          profile: options.profile,
          projectRoot,
        });
        return sendJson(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/sync-desktop') {
        const body = await readJsonBody(req);
        const dshHome = resolveDefaultDshHome({ dshHome: options.dshHome, configFile, projectRoot });
        const syncRes = runDesktopSync({
          projectRoot,
          dshHome,
          profile: options.profile ?? 'desktop',
          dryRun: Boolean(body.dryRun),
        });
        if (!syncRes.ok) {
          return sendJson(res, 409, { error: syncRes.stderr || syncRes.stdout || 'Desktop sync failed', details: syncRes });
        }
        return sendJson(res, 200, syncRes);
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = Number.isInteger(e?.statusCode) ? e.statusCode : 400;
      return sendJson(res, status, {
        error: e instanceof Error ? e.message : String(e),
        code: e?.code ?? 'BAD_REQUEST',
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  activePort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  return {
    server,
    port: activePort,
    url: `http://127.0.0.1:${activePort}/`,
    csrfToken,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
