#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Reproducible Clean-DSH 9-Point Real Product Acceptance Suite (Items 1-8)
 * Target Platform: Windows 10/11 + Official DeepSeek Harness Desktop/CLI/Web (>= 0.2.2-rc.1)
 *
 * Isolation Guarantee:
 *   NEVER reads or mutates global `~/.dsh` (`%USERPROFILE%\.dsh`). Every invocation creates
 *   a brand-new zero-state `DSH_HOME`, `DSH_AGENTS_HOME`, `userData`, and `workspace`.
 */

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pnpmStoreEnv } from '../../installer/lt-installer-standalone.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_PLUGIN = path.join(THIS_DIR, 'lib', 'host-test-bridge.mjs');

function printHelp() {
  console.log(`Usage:
  node scripts/acceptance/run-clean-dsh-9point.mjs --tgz <dsh-leaderteam-X.Y.Z.tgz> [options]

Options:
  --tgz <path>                 Candidate dsh-leaderteam tarball to test (required)
  --version <X.Y.Z>            Expected package version (auto-detected from --tgz if omitted)
  --dual-mode <auto|true|false>Expected Single/Team dual-mode support (default: auto from capabilities)
  --upgrade-tgz <path>         Candidate newer tarball for Item 8 upgrade verification
  --rollback-tgz <path>        Candidate baseline tarball for Item 8 rollback verification
  --decoy-tag <tag>            Cross-platform decoy release tag (default: linux-v<next-patch>)
  --mode <simulated|live-provider>
                               simulated (default, zero token cost) or live-provider (read-only proxy)
  --upstream-url <url>         OpenAI-compatible base URL for live-provider mode (env: LT_ACCEPT_UPSTREAM_URL)
  --upstream-api-key <key>     API key for live-provider mode (env: LT_ACCEPT_API_KEY; never written to reports)
  --primary-model <id>         Primary model ID for live-provider mode (env: LT_ACCEPT_PRIMARY_MODEL)
  --secondary-model <id>       Secondary model ID for Item 7 switch test (env: LT_ACCEPT_SECONDARY_MODEL)
  --dsh-app <dir>              Official DeepSeek Harness install dir (env: LT_DSH_APP / DSH_APP_DIR)
  --work-dir <dir>             Isolated temporary work root (env: LT_ACCEPT_WORK_DIR; default: <os.tmpdir>/lt-acceptance-work)
  --out <report.json>          Output JSON receipt file path
  --help                       Show this help message
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
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
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

  // Scan standard top-level custom install folders across existing Windows drives
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

function bumpPatchVersion(ver) {
  const m = String(ver || '2.2.0').match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!m) return '9.9.9';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function readTarballPackageVersion(tgzPath, workTmpDir) {
  const probeDir = fs.mkdtempSync(path.join(workTmpDir, 'lt-tgz-ver-'));
  try {
    spawnSync('tar', ['-xzf', tgzPath, '-C', probeDir, 'package/package.json'], { windowsHide: true });
    const pkgPath = path.join(probeDir, 'package', 'package.json');
    if (fs.existsSync(pkgPath)) {
      return String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '');
    }
  } catch {} finally {
    try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch {}
  }
  return '';
}

function createSyntheticPatchBumpTarball(sourceTgz, nextVersion, workTmpDir) {
  const stageDir = fs.mkdtempSync(path.join(workTmpDir, 'lt-synth-upg-'));
  const extractDir = path.join(stageDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  const extRes = spawnSync('tar', ['-xzf', sourceTgz, '-C', extractDir], { windowsHide: true, encoding: 'utf8' });
  if (extRes.status !== 0) {
    throw new Error(`Failed to extract ${sourceTgz} for synthetic upgrade tarball: ${extRes.stderr}`);
  }
  for (const relPkg of ['package/package.json', 'package/leaderteam/package.json']) {
    const abs = path.join(extractDir, relPkg);
    if (fs.existsSync(abs)) {
      const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
      json.version = nextVersion;
      fs.writeFileSync(abs, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
  }
  const outTgz = path.join(stageDir, `dsh-leaderteam-${nextVersion}.tgz`);
  const packRes = spawnSync('tar', ['-czf', outTgz, '-C', extractDir, 'package'], { windowsHide: true, encoding: 'utf8' });
  if (packRes.status !== 0) {
    throw new Error(`Failed to pack synthetic upgrade tarball: ${packRes.stderr}`);
  }
  return outTgz;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkFiles(dir, base = dir, acc = {}) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).replaceAll('\\', '/');
    if (ent.isDirectory()) walkFiles(full, base, acc);
    else if (ent.isFile()) acc[rel] = sha256File(full);
  }
  return acc;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function classifyIncomingChatPayload(payload) {
  const rawText = JSON.stringify(payload?.messages ?? []);
  const sysText = (payload?.messages ?? [])
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const toolNames = (payload?.tools ?? []).map(t => t.function?.name ?? t.name).filter(Boolean).sort();

  let lastTool = '';
  const allUserChunks = [];
  const msgs = payload?.messages ?? [];
  for (const m of msgs) {
    if (m.role === 'user') {
      const c = m.content;
      const txt = typeof c === 'string'
        ? c
        : (Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : (b?.text ?? b?.content ?? ''))).join('\n') : JSON.stringify(c ?? ''));
      if (txt) allUserChunks.push(txt);
    }
  }
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (!lastTool && msgs[i].role === 'tool') {
      const c = msgs[i].content;
      lastTool = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(b => b.text ?? '').join('\n') : '');
    }
  }
  const lastUser = allUserChunks.join('\n') || rawText;

  let kind = 'other';
  let who = 'other';
  if (sysText.includes('independent asynchronous supervisor')) { kind = 'supervision'; who = 'supervisor'; }
  else if (sysText.includes('You are the final safety gate')) { kind = 'gate'; who = 'gate'; }
  else if (sysText.includes('review a team leader stopping work') || sysText.includes('resolving a stop disagreement')) { kind = 'stop-review'; who = 'stopReviewer'; }
  else if (sysText.includes('independent serial-plan advocate')) { kind = 'serial-review'; who = 'serialReviewer'; }
  else if (sysText.includes('consensus panel') && sysText.includes('independent reviewers')) { kind = 'discuss'; who = 'reviewer'; }
  else if (sysText.includes('independent arbiter')) { kind = 'arbiter'; who = 'arbiter'; }
  else if (rawText.includes('# LeaderTeam Single Mode:')) { kind = 'single-leader'; who = 'leader'; }
  else if (rawText.includes('# LeaderTeam: you are the team leader')) { kind = 'team-leader'; who = 'leader'; }
  else {
    const m = rawText.match(/# LeaderTeam: you are team member \\?"([a-z0-9-]+)\\?"/);
    if (m) { kind = 'member'; who = m[1]; }
  }
  return {
    model: payload?.model ?? null,
    reasoningEffort: payload?.reasoning_effort ?? null,
    kind,
    who,
    tools: toolNames,
    lastUser: lastUser.slice(-6000),
    lastTool,
  };
}

function writeSseReply(res, model, reply, seq) {
  const id = `chatcmpl-sim-${seq}-${Date.now()}`;
  const common = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const delta = { role: 'assistant' };
  let finishReason = 'stop';
  if (reply.tool) {
    delta.tool_calls = [{
      index: 0,
      id: `call-sim-${seq}`,
      type: 'function',
      function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) },
    }];
    finishReason = 'tool_calls';
  } else {
    delta.content = typeof reply.json === 'object' ? JSON.stringify(reply.json) : String(reply.content ?? 'OK');
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...common,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 48, completion_tokens: 16, total_tokens: 64 },
  })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function startSimulatedOrProxyUpstream(mode, workspaceDir, liveConfig) {
  const requests = [];
  let seq = 0;
  const state = {
    singleStep: 0,
    teamPhase: 0,
    memberSteps: {},
    approvedPlanId: null,
    stageFile: null,
    execModelRoute: null,
    execEffort: 'low',
    deliveryReviewed: false,
    statusDeclared: false,
  };

  if (mode === 'live-provider') {
    const upstreamOriginUrl = new URL(liveConfig.upstreamUrl);
    const upstreamBasePath = upstreamOriginUrl.pathname.replace(/\/+$/, '');
    const upstreamOrigin = upstreamOriginUrl.origin;
    const proxyToken = crypto.randomUUID();

    // Transparent read-only recorder proxy fronting user-supplied OpenAI-compatible gateway
    const server = http.createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${proxyToken}`) {
        res.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyBuf = Buffer.concat(chunks);
      let parsed = null;
      if (req.method === 'POST') {
        try { parsed = JSON.parse(bodyBuf.toString('utf8')); } catch {}
      }
      const entry = {
        seq: ++seq,
        timestampMs: Date.now(),
        method: req.method,
        url: req.url,
        hasAuthHeader: Boolean(req.headers.authorization),
        ...(parsed ? classifyIncomingChatPayload(parsed) : { model: null, kind: 'http-get' }),
      };
      requests.push(entry);

      const reqPath = String(req.url || '/');
      const forwardPath = upstreamBasePath && reqPath.startsWith('/v1')
        ? `${upstreamBasePath}${reqPath.slice('/v1'.length)}`
        : reqPath;
      const upstreamUrl = new URL(upstreamOrigin);
      const requestUrl = new URL(forwardPath, upstreamOrigin);
      upstreamUrl.pathname = requestUrl.pathname;
      upstreamUrl.search = requestUrl.search;
      const fwdHeaders = { ...req.headers, host: upstreamOriginUrl.host, authorization: `Bearer ${liveConfig.apiKey}` };
      try {
        const upRes = await fetch(upstreamUrl, {
          method: req.method,
          headers: fwdHeaders,
          redirect: 'error',
          body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuf : undefined,
        });
        entry.httpStatus = upRes.status;
        res.writeHead(upRes.status, Object.fromEntries(upRes.headers.entries()));
        if (upRes.body) {
          for await (const chunk of upRes.body) res.write(chunk);
        }
        res.end();
      } catch (err) {
        entry.httpStatus = 502;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    const port = await findFreePort();
    await new Promise(r => server.listen(port, '127.0.0.1', r));
    return {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: proxyToken,
      primaryModel: liveConfig.primaryModel,
      secondaryModel: liveConfig.secondaryModel,
      requests,
      state,
      close: () => new Promise(r => server.close(() => r())),
    };
  }

  // Deterministic simulated OpenAI-compatible server (zero paid API calls)
  const SIM_MODELS = [
    { id: 'sim-reasoner-v1', object: 'model', created: 1700000000, owned_by: 'lt-acceptance', context_window: 128000, max_output_tokens: 16384 },
    { id: 'sim-flash-v2', object: 'model', created: 1700000000, owned_by: 'lt-acceptance', context_window: 128000, max_output_tokens: 16384 },
  ];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const authHeader = String(req.headers.authorization ?? '');
    if (req.url?.startsWith('/v1/models') && req.method === 'GET') {
      requests.push({
        seq: ++seq,
        timestampMs: Date.now(),
        method: 'GET',
        url: req.url,
        hasAuthHeader: authHeader.startsWith('Bearer ') && authHeader.length > 10,
        kind: 'models-catalog',
        model: null,
      });
      if (!authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing Bearer API key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: SIM_MODELS }));
      return;
    }

    if (req.method === 'POST' && (req.url?.includes('/chat/completions'))) {
      let payload = {};
      try { payload = JSON.parse(rawBody); } catch {}
      const info = classifyIncomingChatPayload(payload);
      const curSeq = ++seq;
      requests.push({
        seq: curSeq,
        timestampMs: Date.now(),
        method: 'POST',
        url: req.url,
        hasAuthHeader: authHeader.startsWith('Bearer '),
        ...info,
      });

      if (!authHeader.startsWith('Bearer ')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }

      const wantStream = payload.stream !== false;
      const send = reply => {
        if (!wantStream) {
          const content = typeof reply.json === 'object' ? JSON.stringify(reply.json) : String(reply.content ?? 'OK');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: `chatcmpl-sim-${curSeq}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
          }));
          return;
        }
        writeSseReply(res, payload.model, reply, curSeq);
      };

      // Governance / Gate / Supervision / Review handlers
      if (info.kind === 'gate') {
        return send({ json: { decision: 'allow', risk: 'low', reason: 'authorized acceptance workspace action' } });
      }
      if (info.kind === 'stop-review') {
        return send({ json: { action: 'stop', reason: 'All requested acceptance work verified', directive: '' } });
      }
      if (info.kind === 'supervision') {
        return send({
          json: {
            stance: 'endorse',
            intervene: false,
            summary: 'Stage contract and implementation satisfy acceptance criteria.',
            concerns: [],
            suggestions: [],
            target_paths: [],
            directives_verified: true,
          },
        });
      }
      if (info.kind === 'serial-review') {
        return send({
          json: {
            verdict: 'proven',
            responsibilities: ['Bounded single-module creation and test'],
            proof: [{ constraint: 'Single cohesive file pair', evidence: 'spec.md', rules_out: 'No independent parallel unit' }],
            reason: 'Atomic stage',
            feedback: [],
          },
        });
      }
      if (info.kind === 'discuss') {
        return send({
          json: {
            stance: 'approve',
            summary: 'Approved for execution/delivery',
            reasons: ['Meets spec and workspace scope'],
            required_changes: [],
            change_items: [],
          },
        });
      }
      if (info.kind === 'arbiter') {
        return send({
          json: {
            decision: 'approve',
            summary: 'Approved by arbiter',
            reasons: ['Meets requirements'],
            required_changes: [],
          },
        });
      }

      // Member subagent execution in Team Mode
      if (info.kind === 'member') {
        const mStep = (state.memberSteps[info.who] ?? 0) + 1;
        state.memberSteps[info.who] = mStep;
        if (mStep === 1 && state.stageFile) {
          return send({ tool: 'read', args: { file_path: state.stageFile } });
        }
        if ((mStep === 1 && !state.stageFile) || (mStep === 2 && state.stageFile)) {
          return send({ tool: 'read', args: { file_path: 'spec.md' } });
        }
        const writeModStep = state.stageFile ? 3 : 2;
        if (mStep === writeModStep) {
          return send({
            tool: 'write',
            args: {
              file_path: 'src/team-mod.js',
              content: 'export function multiply(a, b) {\n  return a * b;\n}\n',
            },
          });
        }
        if (mStep === writeModStep + 1) {
          return send({
            tool: 'write',
            args: {
              file_path: 'test/team-mod.test.js',
              content: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { multiply } from "../src/team-mod.js";\n\ntest("multiply works", () => {\n  assert.equal(multiply(6, 7), 42);\n});\n',
            },
          });
        }
        if (mStep === writeModStep + 2 && info.tools.includes('pwsh')) {
          return send({
            tool: 'pwsh',
            args: {
              description: 'Run unit tests via node --test',
              command: 'npm test',
            },
          });
        }
        return send({
          content: 'STATUS: done\nCHANGED: src/team-mod.js, test/team-mod.test.js\nEVIDENCE: npm test passed (multiply(6,7)===42)\nNOTES: none',
        });
      }

      // Step 5 & Step 7 lightweight round-trip prompts
      if (info.lastUser.includes('STEP5_PING')) {
        return send({ content: 'STEP5_PONG_READY' });
      }
      if (info.lastUser.includes('STEP7_FOLLOWUP_AFTER_MODEL_SWITCH')) {
        return send({ content: `STEP7_MODEL_SWITCH_CONFIRMED:${payload.model}` });
      }

      // Step 6 Single Mode execution
      if (info.kind === 'single-leader' && info.lastUser.includes('STEP6_SINGLE_EXEC') && !info.lastUser.includes('STEP6_TEAM_EXEC')) {
        state.singleStep += 1;
        if (state.singleStep === 1 && info.tools.includes('write')) {
          return send({
            tool: 'write',
            args: {
              file_path: 'src/single-calc.js',
              content: 'export const add = (a, b) => a + b;\n',
            },
          });
        }
        if (state.singleStep === 2 && info.tools.includes('pwsh')) {
          return send({
            tool: 'pwsh',
            args: {
              description: 'Verify single-calc add(2,3)',
              command: 'node -e "import(\'./src/single-calc.js\').then(m => console.log(\'SINGLE_ADD_OK:\' + m.add(2, 3)))"',
            },
          });
        }
        return send({ content: 'SINGLE_MODE_DONE: src/single-calc.js verified' });
      }

      // Step 6 Team Mode execution (`team_plan` -> `team_dispatch` -> member -> delivery)
      if (info.kind === 'team-leader' && (info.lastUser.includes('STEP6_TEAM_EXEC') || state.teamPhase > 0)) {
        const modDoneOnDisk = fs.existsSync(path.join(workspaceDir, 'src', 'team-mod.js'))
          && fs.existsSync(path.join(workspaceDir, 'test', 'team-mod.test.js'));

        if (state.teamPhase === 0) {
          state.teamPhase = 1;
          return send({ tool: 'team_models', args: {} });
        }
        if (state.teamPhase === 1) {
          try {
            const tm = JSON.parse(info.lastTool);
            const firstModel = tm?.models?.[0];
            if (firstModel?.route) {
              state.execModelRoute = firstModel.route;
              state.execEffort = firstModel.default_effort || firstModel.efforts?.[0] || 'low';
            }
          } catch {}
          state.teamPhase = 2;
          if (info.tools.includes('team_plan')) {
            return send({
              tool: 'team_plan',
              args: {
                action: 'overview',
                summary: 'Implement multiply module and unit test',
                approach: 'Create src/team-mod.js and test/team-mod.test.js and verify with npm test',
                acceptance: ['npm test exits 0'],
                estimated_minutes: 1,
                future_work: ['impl-mod'],
              },
            });
          }
          state.teamPhase = 3;
        }
        if (state.teamPhase === 2) {
          state.teamPhase = 3;
          return send({
            tool: 'team_plan',
            args: {
              action: 'stage',
              stage_id: 'impl-mod',
              goal: 'Implement multiply(a, b) in src/team-mod.js and unit test in test/team-mod.test.js',
              method: 'Write module and test file, then run npm test via pwsh',
              interfaces: ['export function multiply(a, b)'],
              acceptance: ['test/team-mod.test.js passes via npm test'],
              profile: 'shell',
              tools: ['read', 'write', 'pwsh'],
              write_scope: ['src/**', 'test/**'],
              parallel_with: [],
              serial_reason: 'Single coupled module and its unit test',
              ready: true,
            },
          });
        }
        if (state.teamPhase === 3) {
          try {
            const stageRes = JSON.parse(info.lastTool);
            if (stageRes?.stage?.file) state.stageFile = stageRes.stage.file;
          } catch {}
          state.teamPhase = 5;
          return send({
            tool: 'team_dispatch',
            args: {
              name: 'impl-worker',
              stage_id: 'impl-mod',
              model: state.execModelRoute || payload.model,
              effort: state.execEffort || 'low',
            },
          });
        }
        if (state.teamPhase === 5 && !modDoneOnDisk) {
          if (!state.waitingDeclared && info.tools.includes('team_status')) {
            state.waitingDeclared = true;
            return send({
              tool: 'team_status',
              args: { stop_state: 'waiting_members', reason: 'Waiting for impl-worker to complete src/team-mod.js and npm test.' },
            });
          }
          return send({ content: 'WAITING_FOR_MEMBER_COMPLETION' });
        }
        const lastMsgIsDeliveredStatus = (payload.messages ?? []).at(-1)?.role === 'tool' && info.lastTool.includes('"delivered"');
        if (modDoneOnDisk && !lastMsgIsDeliveredStatus && info.tools.includes('team_status')) {
          return send({
            tool: 'team_status',
            args: { stop_state: 'delivered', reason: 'src/team-mod.js and test/team-mod.test.js created and verified.' },
          });
        }
        return send({ content: 'TEAM_MODE_DELIVERED_OK: multiply(6,7)=42 verified' });
      }

      return send({ content: 'OK' });
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  const port = await findFreePort();
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-lt-accept-sim-key-0000',
    primaryModel: 'sim-reasoner-v1',
    secondaryModel: 'sim-flash-v2',
    requests,
    state,
    close: () => new Promise(r => server.close(() => r())),
  };
}

async function bootDshWebHost({ dshApp, dshExe, dshCliJs, dshHome, agentsHome, workspaceDir, extraEnv = {} }) {
  const port = await findFreePort();
  const patchFile = path.join(dshHome, `lt-accept-bridge-${port}.patch.yml`);
  const fwdBridge = BRIDGE_PLUGIN.replaceAll('\\', '/');
  fs.writeFileSync(
    patchFile,
    `- insert:\n    - id: lt-acceptance-host-bridge\n      name: "${fwdBridge}"\n`,
    'utf8',
  );

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    LT_ACCEPT_DSH_APP: dshApp,
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: agentsHome,
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_TELEMETRY_DISABLED: '1',
    ...extraEnv,
  };

  const child = spawn(
    dshExe,
    ['--expose-internals', dshCliJs, '--profile', 'web', '--patch', patchFile, '--no-open', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: workspaceDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  let stdout = '';
  let stderr = '';
  let launchUrl = null;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for dsh --profile web URL on port ${port}.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 90000);

    const onChunk = chunk => {
      const s = chunk.toString('utf8');
      stdout += s;
      const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
      if (m && !launchUrl) {
        launchUrl = m[0];
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('exit', code => {
      if (!launchUrl) {
        clearTimeout(timer);
        reject(new Error(`dsh --profile web exited early (code=${code}).\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });

  const authRes = await fetch(launchUrl, { redirect: 'manual' });
  const rawSetCookie = authRes.headers.getSetCookie?.() ?? [authRes.headers.get('set-cookie')].filter(Boolean);
  const cookieHeader = rawSetCookie.map(c => c.split(';')[0]).join('; ');
  const baseOrigin = `http://127.0.0.1:${port}`;

  const apiFetch = async (urlPath, init = {}) => {
    const target = new URL(urlPath, baseOrigin);
    const headers = {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      origin: baseOrigin,
      ...(init.headers ?? {}),
    };
    const bodyTimeout = typeof init.body === 'object' && init.body !== null ? Number(init.body.timeoutMs || 0) : 0;
    const effectiveTimeoutMs = init.timeoutMs ?? (bodyTimeout > 0 ? bodyTimeout + 20000 : 120000);
    const res = await fetch(target, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ? (typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : undefined,
      signal: AbortSignal.timeout(effectiveTimeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, text: text.slice(0, 2000) };
  };

  const stop = async () => {
    if (child.exitCode === null) {
      try { child.kill(); } catch {}
      const deadline = Date.now() + 4000;
      while (child.exitCode === null && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
    try { fs.rmSync(patchFile, { force: true }); } catch {}
  };

  return { port, baseOrigin, cookiePresent: Boolean(cookieHeader), apiFetch, stop, getLogs: () => ({ stdout, stderr }) };
}

async function startSimulatedGithubReleasesServer({ baselineTgz, baselineVersion, upgradeTgz, upgradeVersion, decoyLinuxTag }) {
  const requests = [];
  let decoyLinuxAssetDownloaded = false;

  const baseBuf = fs.readFileSync(baselineTgz);
  const baseSha = crypto.createHash('sha256').update(baseBuf).digest('hex');
  const upgBuf = fs.readFileSync(upgradeTgz);
  const upgSha = crypto.createHash('sha256').update(upgBuf).digest('hex');
  const decoyVersion = decoyLinuxTag.replace(/^linux-v/i, '');
  const decoyFakeSha = crypto.createHash('sha256').update(`LINUX_ONLY_DECOY_${decoyVersion}`).digest('hex');

  const upgradeTag = `windows-v${upgradeVersion}`;
  const baselineTag = `windows-v${baselineVersion}`;
  const upgradeAssetName = `dsh-leaderteam-${upgradeVersion}.tgz`;
  const baselineAssetName = `dsh-leaderteam-${baselineVersion}.tgz`;
  const decoyAssetName = `dsh-leaderteam-${decoyVersion}.tgz`;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    requests.push({ method: req.method, path: u.pathname });
    const base = `http://${req.headers.host}`;

    const releases = [
      {
        id: 1004,
        tag_name: decoyLinuxTag,
        name: `LeaderTeam Linux v${decoyVersion}`,
        prerelease: false,
        draft: false,
        published_at: '2026-11-27T07:00:00Z',
        body: `SHA256: ${decoyFakeSha}  ${decoyAssetName}`,
        assets: [
          {
            name: decoyAssetName,
            browser_download_url: `${base}/assets/${decoyLinuxTag}/${decoyAssetName}`,
            size: 1024,
          },
          {
            name: 'SHA256SUMS.txt',
            browser_download_url: `${base}/assets/${decoyLinuxTag}/SHA256SUMS.txt`,
            size: 96,
          },
        ],
      },
      {
        id: 1003,
        tag_name: upgradeTag,
        name: `LeaderTeam Windows v${upgradeVersion}`,
        prerelease: false,
        draft: false,
        published_at: '2026-11-27T06:30:00Z',
        body: `SHA256: ${upgSha}  ${upgradeAssetName}`,
        assets: [
          {
            name: upgradeAssetName,
            browser_download_url: `${base}/assets/${upgradeTag}/${upgradeAssetName}`,
            size: upgBuf.length,
          },
          {
            name: `${upgradeAssetName}.sha256`,
            browser_download_url: `${base}/assets/${upgradeTag}/${upgradeAssetName}.sha256`,
            size: 96,
          },
          {
            name: 'SHA256SUMS.txt',
            browser_download_url: `${base}/assets/${upgradeTag}/SHA256SUMS.txt`,
            size: 96,
          },
        ],
      },
      {
        id: 1002,
        tag_name: baselineTag,
        name: `LeaderTeam Windows v${baselineVersion}`,
        prerelease: false,
        draft: false,
        published_at: '2026-11-27T06:00:00Z',
        body: `SHA256: ${baseSha}  ${baselineAssetName}`,
        assets: [
          {
            name: baselineAssetName,
            browser_download_url: `${base}/assets/${baselineTag}/${baselineAssetName}`,
            size: baseBuf.length,
          },
          {
            name: `${baselineAssetName}.sha256`,
            browser_download_url: `${base}/assets/${baselineTag}/${baselineAssetName}.sha256`,
            size: 96,
          },
          {
            name: 'SHA256SUMS.txt',
            browser_download_url: `${base}/assets/${baselineTag}/SHA256SUMS.txt`,
            size: 96,
          },
        ],
      },
    ];

    if (u.pathname.endsWith('/releases')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(releases));
      return;
    }
    if (u.pathname.endsWith('/releases/latest')) {
      // GitHub `/releases/latest` intentionally points to the Linux decoy so a Windows updater
      // MUST query `/releases` and filter `windows-v*`, never blindly trusting `/releases/latest`.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(releases[0]));
      return;
    }
    const tagMatch = u.pathname.match(/\/releases\/tags\/([^/]+)$/);
    if (tagMatch) {
      const hit = releases.find(r => r.tag_name === decodeURIComponent(tagMatch[1]));
      res.writeHead(hit ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hit ?? { message: 'Not Found' }));
      return;
    }
    if (u.pathname.startsWith(`/assets/${decoyLinuxTag}/`)) {
      decoyLinuxAssetDownloaded = true;
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`FORBIDDEN_CROSS_PLATFORM_DECOY_${decoyLinuxTag}`);
      return;
    }
    if (u.pathname === `/assets/${upgradeTag}/${upgradeAssetName}`) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(upgBuf);
      return;
    }
    if (u.pathname.startsWith(`/assets/${upgradeTag}/`)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${upgSha}  ${upgradeAssetName}\n`);
      return;
    }
    if (u.pathname === `/assets/${baselineTag}/${baselineAssetName}`) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(baseBuf);
      return;
    }
    if (u.pathname.startsWith(`/assets/${baselineTag}/`)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${baseSha}  ${baselineAssetName}\n`);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
  });

  const port = await findFreePort();
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    repoApiUrl: `http://127.0.0.1:${port}/repos/youzi-ovo-create/dsh-leaderteam/releases`,
    upgradeTag,
    baselineTag,
    decoyLinuxTag,
    upgradeAssetName,
    requests,
    wasDecoyDownloaded: () => decoyLinuxAssetDownloaded,
    close: () => new Promise(r => server.close(() => r())),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const tgzPath = args.tgz ? path.resolve(args.tgz) : null;
  if (!tgzPath || !fs.existsSync(tgzPath)) {
    printHelp();
    console.error('Error: --tgz <path-to-dsh-leaderteam-X.Y.Z.tgz> is required and must exist.');
    process.exit(2);
  }

  const mode = args.mode === 'live-provider' ? 'live-provider' : 'simulated';
  const liveConfig = {
    upstreamUrl: args['upstream-url'] || process.env.LT_ACCEPT_UPSTREAM_URL || '',
    apiKey: args['upstream-api-key'] || process.env.LT_ACCEPT_API_KEY || '',
    primaryModel: args['primary-model'] || process.env.LT_ACCEPT_PRIMARY_MODEL || '',
    secondaryModel: args['secondary-model'] || process.env.LT_ACCEPT_SECONDARY_MODEL || '',
  };
  if (mode === 'live-provider') {
    if (!liveConfig.upstreamUrl || !liveConfig.apiKey || !liveConfig.primaryModel || !liveConfig.secondaryModel) {
      console.error(
        'Error: --mode live-provider requires --upstream-url, --upstream-api-key, --primary-model, and --secondary-model '
        + '(or env vars LT_ACCEPT_UPSTREAM_URL / LT_ACCEPT_API_KEY / LT_ACCEPT_PRIMARY_MODEL / LT_ACCEPT_SECONDARY_MODEL).',
      );
      process.exit(2);
    }
  }

  const dshApp = resolveDshAppDir(args['dsh-app'] || args['dsh-dir']);
  if (!dshApp) {
    console.error('Error: Official DeepSeek Harness Desktop installation not found. Pass --dsh-app <dir> or set LT_DSH_APP.');
    process.exit(2);
  }
  const dshExe = path.join(dshApp, 'DeepSeek Harness.exe');
  const dshAsar = path.join(dshApp, 'resources', 'app.asar');
  const dshCliJs = path.join(dshAsar, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  if (!fs.existsSync(dshExe) || !fs.existsSync(dshAsar)) {
    throw new Error(`Official DeepSeek Harness not found at ${dshApp}`);
  }

  const workRoot = path.resolve(args['work-dir'] || process.env.LT_ACCEPT_WORK_DIR || path.join(os.tmpdir(), 'lt-acceptance-work'));
  fs.mkdirSync(workRoot, { recursive: true });

  const detectedVersion = readTarballPackageVersion(tgzPath, workRoot);
  const targetVersion = String(args.version || detectedVersion || '').replace(/^v/i, '');
  if (!detectedVersion || targetVersion !== detectedVersion) throw new Error('Candidate version must match the tarball manifest');

  const runId = `clean9-${targetVersion}-${mode}-${Date.now()}`;
  const runDir = path.join(workRoot, runId);
  const dshHome = path.join(runDir, 'dsh-home');
  const agentsHome = path.join(runDir, 'agents-home');
  Object.assign(process.env, pnpmStoreEnv(dshHome));
  const userDataDir = path.join(os.tmpdir(), `lt-c9-ud-${Date.now().toString(36)}`);
  // Place workspaceDir under user-owned os.tmpdir() so Windows ACL sandbox SetNamedSecurityInfoW (WRITE_DAC) succeeds reliably
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `lt-c9-ws-${targetVersion}-`));
  for (const d of [dshHome, agentsHome, userDataDir, workspaceDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Isolation guard: verify isolated DSH_HOME NEVER overlaps user's global ~/.dsh
  const globalUserDsh = path.join(os.homedir(), '.dsh');
  if (path.resolve(dshHome).toLowerCase().startsWith(path.resolve(globalUserDsh).toLowerCase())) {
    throw new Error('FATAL ISOLATION VIOLATION: DSH_HOME overlaps global ~/.dsh');
  }

  // Resolve upgrade / rollback tarballs for Item 8 (supports any future version!)
  let rollbackTgz = args['rollback-tgz'] ? path.resolve(args['rollback-tgz']) : tgzPath;
  const rollbackVersion = readTarballPackageVersion(rollbackTgz, workRoot);
  if (!rollbackVersion) throw new Error('Cannot read rollback package version');
  let upgradeTgz = args['upgrade-tgz'] ? path.resolve(args['upgrade-tgz']) : null;
  let upgradeVersion = upgradeTgz ? readTarballPackageVersion(upgradeTgz, workRoot) : null;
  let upgradeTarballMode = 'explicit-tarballs';
  if (upgradeTgz && (!upgradeVersion || upgradeVersion === rollbackVersion)) throw new Error('Explicit upgrade and rollback tarballs must have distinct, readable versions');
  if (!upgradeTgz) {
    const nextVer = bumpPatchVersion(rollbackVersion);
    upgradeTgz = createSyntheticPatchBumpTarball(tgzPath, nextVer, runDir);
    upgradeVersion = nextVer;
    upgradeTarballMode = 'synthetic-patch-bump';
  }
  const decoyLinuxTag = args['decoy-tag'] || `linux-v${bumpPatchVersion(upgradeVersion)}`;

  // Seed clean workspace project (`--test-isolation=none` avoids Node 24 child-process spawn EPERM inside Windows ACL low-integrity sandbox)
  fs.writeFileSync(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify({ name: 'lt-clean-accept-proj', version: '1.0.0', type: 'module', scripts: { test: 'node --test --test-isolation=none' } }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(path.join(workspaceDir, 'spec.md'), '# Acceptance Spec\nImplement multiply(a,b) in src/team-mod.js and unit tests in test/team-mod.test.js.\n', 'utf8');

  const items = [];
  const recordItem = (id, title, passed, details) => {
    items.push({ id, title, passed: Boolean(passed), ...details });
  };

  const upstream = await startSimulatedOrProxyUpstream(mode, workspaceDir, liveConfig);
  let host = null;

  try {
    // =========================================================================
    // ITEM 1: Zero-State Plugin Installation (`lt-installer-standalone.mjs` / `dsh plugin add`)
    // =========================================================================
    const unpackInspectDir = path.join(runDir, 'tgz-inspect');
    fs.mkdirSync(unpackInspectDir, { recursive: true });
    spawnSync('tar', ['-xzf', tgzPath, '-C', unpackInspectDir], { windowsHide: true });
    const pkgRoot = path.join(unpackInspectDir, 'package');
    const standaloneCandidates = [
      path.join(pkgRoot, 'installer', 'lt-installer-standalone.mjs'),
      path.join(pkgRoot, 'lt-installer-standalone.mjs'),
      path.join(pkgRoot, 'bin', 'lt-installer.mjs'),
      path.join(pkgRoot, 'bin', 'lt-installer-standalone.mjs'),
      path.join(pkgRoot, 'scripts', 'lt-installer-standalone.mjs'),
      path.join(pkgRoot, 'leaderteam', 'installer', 'lt-installer-standalone.mjs'),
    ];
    const standaloneInstaller = standaloneCandidates.find(p => fs.existsSync(p)) ?? null;

    let standaloneInstallResult = null;
    if (standaloneInstaller) {
      const stRes = spawnSync(
        process.execPath,
        [standaloneInstaller, '--tgz', tgzPath, '--dsh-home', dshHome, '--dsh-dir', dshApp, '--profile', 'web', '--non-interactive'],
        {
          cwd: workspaceDir,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 180000,
          env: { ...process.env, DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome, LT_DSH_APP: dshApp, DSH_TELEMETRY_DISABLED: '1' },
        },
      );
      standaloneInstallResult = {
        found: true,
        script: path.relative(pkgRoot, standaloneInstaller),
        exitCode: stRes.status,
        stdoutTail: String(stRes.stdout || '').slice(-600),
        stderrTail: String(stRes.stderr || '').slice(-600),
      };
    } else {
      standaloneInstallResult = { found: false, reason: 'lt-installer-standalone.mjs not present in tarball' };
    }

    const webProfilePkgPath = path.join(dshHome, 'profiles', 'web', 'package.json');
    let dshPluginAddWebResult = null;
    const webAlreadyInstalled = fs.existsSync(webProfilePkgPath)
      && (JSON.parse(fs.readFileSync(webProfilePkgPath, 'utf8')).dsh?.profile?.bundles ?? []).includes('dsh-leaderteam');
    if (!webAlreadyInstalled) {
      const addRes = spawnSync(
        dshExe,
        ['--expose-internals', dshCliJs, 'plugin', '--profile', 'web', 'add', tgzPath],
        {
          cwd: workspaceDir,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: '1' },
        },
      );
      dshPluginAddWebResult = {
        exitCode: addRes.status,
        stdoutTail: String(addRes.stdout || '').slice(-600),
        stderrTail: String(addRes.stderr || '').slice(-600),
      };
    }

    const webPkgAfter = fs.existsSync(webProfilePkgPath) ? JSON.parse(fs.readFileSync(webProfilePkgPath, 'utf8')) : null;
    const bundleRegisteredInWeb = Boolean(webPkgAfter?.dsh?.profile?.bundles?.includes('dsh-leaderteam'));
    const installedPkgJsonPath = path.join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-leaderteam', 'package.json');
    const installedVersion = fs.existsSync(installedPkgJsonPath)
      ? JSON.parse(fs.readFileSync(installedPkgJsonPath, 'utf8')).version
      : null;

    recordItem(1, 'Zero-State Plugin Installation', bundleRegisteredInWeb && installedVersion === targetVersion && Boolean(standaloneInstaller ? standaloneInstallResult.exitCode === 0 : true), {
      standaloneInstaller: standaloneInstallResult,
      dshPluginAddWeb: dshPluginAddWebResult,
      bundleRegisteredInWeb,
      installedVersion,
      note: !standaloneInstaller ? 'Tarball lacks lt-installer-standalone.mjs; installed via official dsh plugin --profile web add' : null,
    });

    // =========================================================================
    // ITEM 2: First Entry into Panel (`/lt/`, `/api/lt/v1/bundle`, `/api/lt/v1/onboarding`)
    // =========================================================================
    host = await bootDshWebHost({ dshApp, dshExe, dshCliJs, dshHome, agentsHome, workspaceDir });
    const ltPageRes = await host.apiFetch('/lt/');
    const bootstrapRes = await host.apiFetch('/api/lt/v1/bundle');
    const onboardingGetRes = await host.apiFetch('/api/lt/v1/onboarding', {
      method: 'POST',
      body: { action: 'status' },
    });
    const capabilitiesRes = await host.apiFetch('/api/lt/v1/capabilities');

    const bootstrapData = bootstrapRes.json?.data ?? bootstrapRes.json;
    const onboardingData = onboardingGetRes.json?.data ?? onboardingGetRes.json;
    const shouldAutoOpenInitial = onboardingData?.shouldAutoOpen ?? bootstrapData?.onboarding?.shouldAutoOpen ?? null;
    const detectedDualMode = capabilitiesRes.json?.data?.features?.inSessionDualMode ?? null;

    const item2Passed = Boolean(
      ltPageRes.status === 200 &&
      bootstrapRes.status === 200 &&
      bootstrapRes.json?.ok === true &&
      onboardingGetRes.status === 200 &&
      onboardingGetRes.json?.ok === true &&
      shouldAutoOpenInitial === true
    );
    recordItem(2, 'First Panel Entry & Auto-Open Onboarding', item2Passed, {
      ltHtmlStatus: ltPageRes.status,
      bundleStatus: bootstrapRes.status,
      onboardingStatus: onboardingGetRes.status,
      capabilitiesStatus: capabilitiesRes.status,
      inSessionDualMode: detectedDualMode,
      contractVersion: capabilitiesRes.json?.data?.contractVersion ?? capabilitiesRes.json?.contractVersion ?? null,
      shouldAutoOpenInitial,
      onboardingPreview: onboardingGetRes.json ?? onboardingGetRes.text.slice(0, 300),
    });

    // =========================================================================
    // ITEM 3: Single API Key Setup (`POST /api/lt/v1/onboarding` `probe-key` + `apply-quick-setup`)
    // =========================================================================
    const probeRes = await host.apiFetch('/api/lt/v1/onboarding', {
      method: 'POST',
      body: {
        action: 'probe-key',
        providerId: 'openai-compatible',
        baseURL: upstream.baseURL,
        apiKey: upstream.apiKey,
      },
    });
    const probeData = probeRes.json?.data ?? probeRes.json;

    const applySetupRes = await host.apiFetch('/api/lt/v1/onboarding', {
      method: 'POST',
      body: {
        action: 'apply-quick-setup',
        providerId: 'openai-compatible',
        apiKey: upstream.apiKey,
        customBaseURL: upstream.baseURL,
        reasoningModel: upstream.primaryModel,
        chatModel: upstream.secondaryModel,
        discoveredModels: [upstream.primaryModel, upstream.secondaryModel],
        collabPresetId: 'balanced-team',
        verifyConnectivity: true,
      },
    });
    await host.apiFetch('/api/lt/v1/onboarding', {
      method: 'POST',
      body: { action: 'complete' },
    });
    const onboardingAfterRes = await host.apiFetch('/api/lt/v1/onboarding', {
      method: 'POST',
      body: { action: 'status' },
    });
    const onboardingAfterData = onboardingAfterRes.json?.data ?? onboardingAfterRes.json;
    const shouldAutoOpenAfter = onboardingAfterData?.shouldAutoOpen ?? null;

    const item3Passed = Boolean(
      probeRes.status === 200 &&
      probeRes.json?.ok === true &&
      probeData?.ok !== false &&
      applySetupRes.status === 200 &&
      applySetupRes.json?.ok === true &&
      shouldAutoOpenAfter === false
    );
    recordItem(3, `Single API Key Quick Setup (${mode})`, item3Passed, {
      mode,
      upstreamBaseURL: upstream.baseURL,
      probeStatus: probeRes.status,
      probeOk: probeRes.json?.ok ?? false,
      discoveredCount: Array.isArray(probeData?.models) ? probeData.models.length : null,
      applyStatus: applySetupRes.status,
      applyOk: applySetupRes.json?.ok ?? false,
      shouldAutoOpenAfter,
    });

    // =========================================================================
    // ITEM 4: Real DSH Host Model Recognition & Selection
    // =========================================================================
    const hostStateRes = await host.apiFetch('/api/__lt_accept/host-state');
    const hs = hostStateRes.json ?? {};
    const catalogGroups = hs.catalog?.groups ?? [];

    let matchedProvider = null;
    let matchedPrimaryModelId = null;
    let matchedSecondaryModelId = null;
    for (const g of catalogGroups) {
      for (const m of g.models ?? []) {
        const mid = m.id;
        if (mid === upstream.primaryModel || mid.endsWith(`/${upstream.primaryModel}`) || upstream.primaryModel.endsWith(`/${mid}`)) {
          matchedProvider = g.id;
          matchedPrimaryModelId = mid;
        }
        if (mid === upstream.secondaryModel || mid.endsWith(`/${upstream.secondaryModel}`) || upstream.secondaryModel.endsWith(`/${mid}`)) {
          matchedSecondaryModelId = mid;
        }
      }
    }

    const createSessRes = await host.apiFetch('/api/__lt_accept/session-create', {
      method: 'POST',
      body: { cwd: workspaceDir, agentPreset: 'leaderteam' },
    });
    const mainSessionId = createSessRes.json?.sessionId ?? null;

    let selectModelRes = null;
    if (mainSessionId && matchedProvider && matchedPrimaryModelId) {
      selectModelRes = await host.apiFetch('/api/__lt_accept/session-select-model', {
        method: 'POST',
        body: {
          sessionId: mainSessionId,
          provider: matchedProvider,
          model: matchedPrimaryModelId,
        },
      });
    } else if (mainSessionId) {
      selectModelRes = await host.apiFetch('/api/__lt_accept/session-select-model', {
        method: 'POST',
        body: {
          sessionId: mainSessionId,
          provider: 'openai-compatible',
          model: upstream.primaryModel,
        },
      });
    }

    const item4Passed = Boolean(
      matchedProvider &&
      matchedPrimaryModelId &&
      mainSessionId &&
      selectModelRes?.status === 200 &&
      selectModelRes?.json?.ok === true
    );
    recordItem(4, 'Real DSH Host Model Recognition & Selection', item4Passed, {
      llmProviders: hs.providers,
      catalogGroupSummary: catalogGroups.map(g => ({ id: g.id, modelCount: g.models?.length ?? 0, models: (g.models ?? []).map(m => m.id).slice(0, 10) })),
      catalogFailures: hs.catalog?.failures ?? [],
      credentialRefs: hs.credentialRefs ?? {},
      matchedProvider,
      matchedPrimaryModelId,
      matchedSecondaryModelId,
      sessionId: mainSessionId,
      selectModelResult: selectModelRes?.json ?? null,
    });

    // =========================================================================
    // ITEM 5: First Message Round-Trip
    // =========================================================================
    let item5Passed = false;
    let step5Details = {};
    if (mainSessionId && item4Passed) {
      const upCountBefore5 = upstream.requests.length;
      const prompt5Res = await host.apiFetch('/api/__lt_accept/session-prompt', {
        method: 'POST',
        body: {
          sessionId: mainSessionId,
          text: 'STEP5_PING: Reply with STEP5_PONG_READY only, no file edits needed.',
          timeoutMs: 45000,
        },
      });
      const p5 = prompt5Res.json ?? {};
      const upReqs5 = upstream.requests.slice(upCountBefore5).filter(r => r.method === 'POST');
      const sessionFiles = walkFiles(path.join(dshHome, 'sessions'));
      const hasDurableZstd = Object.keys(sessionFiles).some(rel => rel.includes(mainSessionId) && rel.endsWith('session.v4.jsonl.zstd'));

      item5Passed = Boolean(
        prompt5Res.status === 200 &&
        p5.ok === true &&
        upReqs5.length >= 1 &&
        typeof p5.finalText === 'string' &&
        p5.finalText.length > 0 &&
        hasDurableZstd
      );
      step5Details = {
        upstreamCallsDuringTurn: upReqs5.length,
        finalText: p5.finalText,
        turnEnds: p5.turnEnds,
        hasDurableZstd,
      };
    } else {
      step5Details = { skippedBecauseItem4Failed: true, reason: 'DSH Host could not select model in Item 4' };
    }
    recordItem(5, 'First Message Round-Trip', item5Passed, step5Details);

    // =========================================================================
    // ITEM 6: Supported Modes Execution (Team-only vs Single + Team + Switch)
    // =========================================================================
    const expectDualMode = args['dual-mode'] === 'true'
      ? true
      : (args['dual-mode'] === 'false'
        ? false
        : (typeof detectedDualMode === 'boolean' ? detectedDualMode : targetVersion !== '2.2.2'));

    let item6Passed = false;
    let step6Details = {};
    const modeSessCreate = await host.apiFetch('/api/__lt_accept/session-create', {
      method: 'POST',
      body: { cwd: workspaceDir, agentPreset: 'leaderteam' },
    });
    const modeSessionId = modeSessCreate.json?.sessionId ?? null;
    if (modeSessionId && matchedProvider && matchedPrimaryModelId) {
      await host.apiFetch('/api/__lt_accept/session-select-model', {
        method: 'POST',
        body: { sessionId: modeSessionId, provider: matchedProvider, model: matchedPrimaryModelId },
      });
    }

    if (!expectDualMode) {
      const singleAttemptRes = modeSessionId
        ? await host.apiFetch('/api/lt/v1/workbench/mode', {
          method: 'POST',
          body: { action: 'set', sessionId: modeSessionId, mode: 'single' },
        })
        : null;

      let teamRunRes = null;
      if (modeSessionId && item4Passed) {
        teamRunRes = await host.apiFetch('/api/__lt_accept/session-prompt', {
          method: 'POST',
          body: {
            sessionId: modeSessionId,
            text: 'STEP6_TEAM_EXEC: Keep it minimal and fast — dispatch 1 member to create src/team-mod.js ("export const multiply = (a, b) => a * b;") and 1 assertion in test/team-mod.test.js, run npm test once, and deliver immediately.',
            timeoutMs: 300000,
          },
        });
      }
      const modCreated = fs.existsSync(path.join(workspaceDir, 'src', 'team-mod.js'));
      const testCreated = fs.existsSync(path.join(workspaceDir, 'test', 'team-mod.test.js'));
      const npmTest = modCreated && testCreated
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd test'], { cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 25000 })
        : null;

      item6Passed = Boolean(item4Passed && modCreated && testCreated && npmTest?.status === 0);
      step6Details = {
        version: targetVersion,
        expectDualMode: false,
        inSessionDualModeCapability: detectedDualMode,
        singleModeAttemptStatus: singleAttemptRes?.status ?? null,
        singleModeAttemptBody: singleAttemptRes?.json ?? null,
        teamFinalText: teamRunRes?.json?.finalText ?? null,
        modCreated,
        testCreated,
        npmTestExitCode: npmTest?.status ?? null,
      };
    } else {
      const setSingle1 = modeSessionId
        ? await host.apiFetch('/api/lt/v1/workbench/mode', {
          method: 'POST',
          body: { action: 'set', sessionId: modeSessionId, mode: 'single' },
        })
        : null;

      let singleTurnRes = null;
      let setTeamRes = null;
      let teamTurnRes = null;
      let setSingle2 = null;

      if (modeSessionId && item4Passed && setSingle1?.status === 200 && setSingle1?.json?.ok === true) {
        const waitModeReady = async (maxMs = 30000) => {
          const dl = Date.now() + maxMs;
          while (Date.now() < dl) {
            const st = await host.apiFetch(`/api/lt/v1/workbench/mode?sessionId=${encodeURIComponent(modeSessionId)}`);
            const ms = st.json?.data?.modeState;
            if (ms && ms.canSwitch === true && !ms.activeTurn && (ms.pendingReviewsCount ?? 0) === 0 && (ms.activeMembersCount ?? 0) === 0) break;
            await new Promise(r => setTimeout(r, 400));
          }
        };

        singleTurnRes = await host.apiFetch('/api/__lt_accept/session-prompt', {
          method: 'POST',
          body: {
            sessionId: modeSessionId,
            text: 'STEP6_SINGLE_EXEC: Write ESM file src/single-calc.js ("export const add = (a, b) => a + b;") using write tool, then reply SINGLE_MODE_DONE immediately.',
            timeoutMs: 180000,
          },
        });

        await waitModeReady(30000);
        setTeamRes = await host.apiFetch('/api/lt/v1/workbench/mode', {
          method: 'POST',
          body: { action: 'set', sessionId: modeSessionId, mode: 'team' },
        });

        teamTurnRes = await host.apiFetch('/api/__lt_accept/session-prompt', {
          method: 'POST',
          body: {
            sessionId: modeSessionId,
            text: 'STEP6_TEAM_EXEC: Keep it minimal and fast — dispatch 1 member to create src/team-mod.js ("export const multiply = (a, b) => a * b;") and 1 assertion in test/team-mod.test.js, run npm test once, and deliver immediately.',
            timeoutMs: 300000,
          },
        });

        await waitModeReady(30000);
        setSingle2 = await host.apiFetch('/api/lt/v1/workbench/mode', {
          method: 'POST',
          body: { action: 'set', sessionId: modeSessionId, mode: 'single' },
        });
      }

      const singleCalcExists = fs.existsSync(path.join(workspaceDir, 'src', 'single-calc.js'));
      const teamModExists = fs.existsSync(path.join(workspaceDir, 'src', 'team-mod.js'));
      const teamTestExists = fs.existsSync(path.join(workspaceDir, 'test', 'team-mod.test.js'));
      const npmTest = teamModExists && teamTestExists
        ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd test'], { cwd: workspaceDir, encoding: 'utf8', windowsHide: true, timeout: 25000 })
        : null;

      item6Passed = Boolean(
        setSingle1?.status === 200 &&
        setSingle1?.json?.ok === true &&
        singleCalcExists &&
        setTeamRes?.status === 200 &&
        setTeamRes?.json?.ok === true &&
        teamModExists &&
        teamTestExists &&
        npmTest?.status === 0 &&
        setSingle2?.status === 200 &&
        setSingle2?.json?.ok === true
      );
      step6Details = {
        version: targetVersion,
        expectDualMode: true,
        sessionId: modeSessionId,
        setSingle1Status: setSingle1?.status ?? null,
        singleCalcExists,
        singleFinalText: singleTurnRes?.json?.finalText ?? null,
        setTeamStatus: setTeamRes?.status ?? null,
        teamModExists,
        teamTestExists,
        npmTestExitCode: npmTest?.status ?? null,
        teamFinalText: teamTurnRes?.json?.finalText ?? null,
        setSingle2Status: setSingle2?.status ?? null,
      };
    }
    recordItem(6, `Supported Modes Execution (v${targetVersion})`, item6Passed, step6Details);

    // =========================================================================
    // ITEM 7: Idle Session Config Modification & Model Switch
    // =========================================================================
    const cfgTargetSession = mainSessionId || modeSessionId;
    const rtSnap7 = await host.apiFetch('/api/lt/v1/runtime/snapshot');
    const rtModels7 = rtSnap7.json?.data?.models ?? rtSnap7.json?.data?.config?.models ?? {};
    let targetNewRoute = null;
    for (const [rKey, rSpec] of Object.entries(rtModels7)) {
      const up = typeof rSpec === 'object' ? (rSpec.upstreamModel || rSpec.id || rKey) : rKey;
      if (rKey === upstream.secondaryModel || up === upstream.secondaryModel || rKey.endsWith(`/${upstream.secondaryModel}`)) {
        targetNewRoute = rKey;
        break;
      }
    }
    if (!targetNewRoute) {
      targetNewRoute = matchedProvider && matchedSecondaryModelId
        ? `${matchedProvider}/${matchedSecondaryModelId}`
        : `deepseek/${upstream.secondaryModel}`;
    }

    const upIdxBefore7 = upstream.requests.length;
    const putSessionCfgRes = cfgTargetSession
      ? await host.apiFetch('/api/lt/v1/workbench/session-config', {
        method: 'POST',
        body: {
          action: 'set',
          sessionId: cfgTargetSession,
          syncAllRolesToLeader: true,
          patch: {
            roles: {
              leader: { route: targetNewRoute, effort: 'none' },
            },
          },
        },
      })
      : { status: 400, ok: false, json: null };

    let step7PromptRes = null;
    let nextUpstreamModel = null;
    let zstdRecordedModel = null;
    if (cfgTargetSession && putSessionCfgRes.status === 200 && putSessionCfgRes.json?.ok === true && item4Passed) {
      step7PromptRes = await host.apiFetch('/api/__lt_accept/session-prompt', {
        method: 'POST',
        body: {
          sessionId: cfgTargetSession,
          text: 'STEP7_FOLLOWUP_AFTER_MODEL_SWITCH: Reply with STEP7_MODEL_SWITCH_CONFIRMED only.',
          timeoutMs: 45000,
        },
      });
      const postSwitchChatReqs = upstream.requests.slice(upIdxBefore7).filter(r => r.method === 'POST' && r.url?.includes('/chat/completions'));
      nextUpstreamModel = postSwitchChatReqs[0]?.model ?? null;
      zstdRecordedModel = step7PromptRes.json?.assistantMessages?.at(-1)?.source?.model ?? null;
    }

    const expectedSecId = matchedSecondaryModelId || upstream.secondaryModel;
    const hitNewModelOnWire = Boolean(
      nextUpstreamModel &&
      (nextUpstreamModel === expectedSecId || nextUpstreamModel === upstream.secondaryModel || nextUpstreamModel.endsWith(`/${expectedSecId}`))
    );
    const item7Passed = Boolean(
      putSessionCfgRes.status === 200 &&
      putSessionCfgRes.json?.ok === true &&
      hitNewModelOnWire
    );
    recordItem(7, 'Idle Session Config Modification & Model Switch', item7Passed, {
      sessionId: cfgTargetSession,
      putConfigStatus: putSessionCfgRes.status,
      expectedNewModel: upstream.secondaryModel,
      actualNextUpstreamModelOnWire: nextUpstreamModel,
      durableTranscriptAssistantModel: zstdRecordedModel,
      hitNewModelOnWire,
    });

    // Stop Web Host cleanly before Item 8 upgrade/rollback file operations
    await host.stop();
    host = null;

    // =========================================================================
    // ITEM 8: Install -> Upgrade -> Rollback + Cross-Platform Decoy Rejection + History SHA-256 Preservation
    // =========================================================================
    if (installedVersion !== rollbackVersion && fs.existsSync(rollbackTgz)) {
      const baselineInstall = spawnSync(
        dshExe,
        ['--expose-internals', dshCliJs, 'plugin', '--profile', 'web', 'add', rollbackTgz],
        {
          cwd: workspaceDir,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: '1' },
        },
      );
      if (baselineInstall.status !== 0) throw new Error(`Could not install rollback baseline: ${baselineInstall.stderr || baselineInstall.stdout || baselineInstall.status}`);
    }
    const versionBeforeUpgrade = JSON.parse(fs.readFileSync(installedPkgJsonPath, 'utf8')).version;

    const ltDir = path.join(dshHome, 'leaderteam');
    fs.mkdirSync(path.join(ltDir, 'config'), { recursive: true });
    const preservedPathsToTrack = [
      path.join(ltDir, 'config', 'leaderteam.local.json'),
      path.join(dshHome, '.credentials.yaml'),
      path.join(ltDir, 'onboarding.json'),
    ].filter(p => fs.existsSync(p));
    const sessionsHashesBefore = walkFiles(path.join(dshHome, 'sessions'));
    const teamsHashesBefore = walkFiles(path.join(ltDir, 'teams'));
    const trackedFileHashesBefore = Object.fromEntries(
      preservedPathsToTrack.map(p => [path.relative(dshHome, p).replaceAll('\\', '/'), sha256File(p)]),
    );

    const ghSim = await startSimulatedGithubReleasesServer({
      baselineTgz: rollbackTgz,
      baselineVersion: rollbackVersion,
      upgradeTgz,
      upgradeVersion,
      decoyLinuxTag,
    });

    try {
      const installedBundleDir = path.join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-leaderteam');
      const updaterCandidates = [
        path.join(installedBundleDir, 'leaderteam', 'core', 'updater.mjs'),
        path.join(installedBundleDir, 'updater.mjs'),
      ];
      const updaterModulePath = updaterCandidates.find(p => fs.existsSync(p)) ?? null;
      const ltUpdateCliPath = fs.existsSync(path.join(installedBundleDir, 'bin', 'lt-update.mjs'))
        ? path.join(installedBundleDir, 'bin', 'lt-update.mjs')
        : null;

      let checkResult = null;
      let upgradeResult = null;
      let rollbackResult = null;
      let crossPlatformRejectOk = false;
      let selectedUpgradeTag = null;
      let versionAfterUpgrade = null;
      let versionAfterRollback = null;
      let item8Error = null;

      if (updaterModulePath) {
        try {
          const mod = await import(pathToFileURL(fs.realpathSync.native(updaterModulePath)).href);
          if (typeof mod.assertTargetReleaseTagMatchesPlatform === 'function') {
            try {
              mod.assertTargetReleaseTagMatchesPlatform(decoyLinuxTag, 'win32');
            } catch (err) {
              crossPlatformRejectOk = err?.code === 'PLATFORM_RELEASE_TAG_MISMATCH';
            }
          }
          if (typeof mod.checkForUpdates === 'function') {
            if (typeof mod.compareOpenSourceReleases === 'function') {
              checkResult = await mod.checkForUpdates({
                pluginRoot: installedBundleDir,
                storageRoot: ltDir,
                track: 'open-source',
                force: true,
                currentHostVersion: '0.2.2-rc.1',
                apiUrlOverride: ghSim.repoApiUrl,
                platform: 'win32',
              });
            } else {
              // Historical pre-OLT baseline (e.g. Leader Team 2.2.3 -> OLT 1.0.0 brand-epoch reset):
              // verify OLT epoch-aware auto-selection against the 2.2.3 install root while driving 2.2.3's explicit tag upgrade.
              const repoUpdaterUrl = pathToFileURL(path.resolve(THIS_DIR, '../../leaderteam/core/updater.mjs')).href;
              const oltUpdater = await import(repoUpdaterUrl);
              checkResult = await oltUpdater.checkForUpdates({
                pluginRoot: installedBundleDir,
                storageRoot: ltDir,
                track: 'open-source',
                force: true,
                currentHostVersion: '0.2.2-rc.1',
                apiUrlOverride: ghSim.repoApiUrl,
                platform: 'win32',
              });
            }
            selectedUpgradeTag = checkResult?.latestRelease?.tagName
              || checkResult?.latestRelease?.tag
              || checkResult?.tag
              || null;
          }
          if (typeof mod.performOneClickUpgrade === 'function') {
            const dlUrl = checkResult?.latestRelease?.asset?.downloadUrl
              || checkResult?.latestRelease?.tgzAsset?.downloadUrl
              || `${ghSim.apiBaseUrl}/assets/${ghSim.upgradeTag}/${ghSim.upgradeAssetName}`;
            const sumsUrl = checkResult?.latestRelease?.sha256SumsUrl
              || checkResult?.latestRelease?.sha256SumsAsset?.downloadUrl
              || checkResult?.latestRelease?.sha256Asset?.downloadUrl
              || `${ghSim.apiBaseUrl}/assets/${ghSim.upgradeTag}/SHA256SUMS.txt`;
            upgradeResult = await mod.performOneClickUpgrade({
              pluginRoot: installedBundleDir,
              storageRoot: ltDir,
              dshHome,
              profile: 'web',
              downloadUrl: dlUrl,
              sha256SumsUrl: sumsUrl,
              targetTrack: 'open-source',
              currentHostVersion: '0.2.2-rc.1',
            });
            if (fs.existsSync(installedPkgJsonPath)) {
              versionAfterUpgrade = JSON.parse(fs.readFileSync(installedPkgJsonPath, 'utf8')).version;
            }
          }
          if (versionAfterUpgrade === upgradeVersion) {
            const upgraded = await import(pathToFileURL(fs.realpathSync.native(updaterModulePath)).href + '?after-upgrade');
            rollbackResult = await upgraded.rollbackToSavedBackup({
              storageRoot: ltDir,
              dshHome,
              profile: 'web',
            });
            if (fs.existsSync(installedPkgJsonPath)) {
              versionAfterRollback = JSON.parse(fs.readFileSync(installedPkgJsonPath, 'utf8')).version;
            }
          }
        } catch (uErr) {
          item8Error = { code: uErr?.code || null, message: uErr?.message || String(uErr) };
        }
      }

      const decoyUntouched = !ghSim.wasDecoyDownloaded();
      const sessionsHashesAfter = walkFiles(path.join(dshHome, 'sessions'));
      const teamsHashesAfter = walkFiles(path.join(ltDir, 'teams'));
      const trackedFileHashesAfter = Object.fromEntries(
        preservedPathsToTrack.filter(p => fs.existsSync(p)).map(p => [path.relative(dshHome, p).replaceAll('\\', '/'), sha256File(p)]),
      );

      const configPreserved = JSON.stringify(trackedFileHashesBefore) === JSON.stringify(trackedFileHashesAfter);
      const sessionsPreserved = Object.entries(sessionsHashesBefore).every(([k, v]) => sessionsHashesAfter[k] === v);
      const teamsPreserved = Object.entries(teamsHashesBefore).every(([k, v]) => teamsHashesAfter[k] === v);
      const allHistoryPreserved = configPreserved && sessionsPreserved && teamsPreserved;

      const hitExpectedUpgradeTag = selectedUpgradeTag === ghSim.upgradeTag;
      const item8Passed = Boolean(
        (ltUpdateCliPath || updaterModulePath) &&
        decoyUntouched &&
        crossPlatformRejectOk &&
        hitExpectedUpgradeTag &&
        versionBeforeUpgrade === rollbackVersion &&
        versionAfterUpgrade === upgradeVersion &&
        versionAfterRollback === rollbackVersion &&
        allHistoryPreserved &&
        !item8Error
      );

      recordItem(8, `Install -> Upgrade (${ghSim.upgradeTag}) -> Rollback (${ghSim.baselineTag}) & History Preservation`, item8Passed, {
        upgradeTarballMode,
        updaterFound: Boolean(ltUpdateCliPath || updaterModulePath),
        mountedReleaseTags: [`${decoyLinuxTag} (decoy)`, ghSim.upgradeTag, ghSim.baselineTag],
        decoyLinuxUntouched: decoyUntouched,
        crossPlatformRejectOk,
        selectedUpgradeTag,
        versionBeforeUpgrade,
        versionAfterUpgrade,
        versionAfterRollback,
        item8Error,
        githubSimRequests: ghSim.requests,
        historyPreservation: {
          allHistoryPreserved,
          configAndCredentialsPreserved: configPreserved,
          sessionsPreserved,
          teamsPreserved,
          trackedFilesCount: Object.keys(trackedFileHashesBefore).length,
          sessionFilesCount: Object.keys(sessionsHashesBefore).length,
          teamFilesCount: Object.keys(teamsHashesBefore).length,
        },
      });
    } finally {
      await ghSim.close();
    }
  } finally {
    if (host) {
      try { await host.stop(); } catch {}
    }
    await upstream.close();
  }

  const passedCount = items.filter(i => i.passed).length;
  const finalReport = {
    schema: 'lt.acceptance.clean_dsh_9point.v1',
    platform: process.platform,
    executedAt: new Date().toISOString(),
    parameters: {
      targetVersion,
      mode,
      upgradeTarballMode,
      decoyLinuxTag,
    },
    summary: {
      totalItems: items.length,
      passedItems: passedCount,
      failedItems: items.length - passedCount,
      allPassed: passedCount === items.length,
    },
    items,
    upstreamRequestSummary: {
      totalRequests: upstream.requests.length,
      modelsRequestedOnWire: [...new Set(upstream.requests.map(r => r.model).filter(Boolean))],
      requests: upstream.requests.map(r => ({
        seq: r.seq,
        method: r.method,
        url: r.url,
        hasAuthHeader: r.hasAuthHeader,
        kind: r.kind,
        model: r.model,
        reasoningEffort: r.reasoningEffort ?? null,
      })),
    },
  };

  const outFile = args.out
    ? path.resolve(args.out)
    : path.join(runDir, 'clean-dsh-8point-report.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(finalReport, null, 2) + '\n', 'utf8');

  console.log(`Clean-DSH Acceptance Report saved to: ${outFile}`);
  for (const item of items) {
    console.log(`  [${item.passed ? 'PASS' : 'FAIL'}] Item ${item.id}: ${item.title}`);
  }
  console.log(`Result: ${passedCount}/${items.length} passed`);
  process.exitCode = finalReport.summary.allPassed ? 0 : 1;
}

await main();
