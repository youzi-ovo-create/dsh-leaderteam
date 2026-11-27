// SPDX-License-Identifier: Apache-2.0
// Read-only / RPC test bridge mounted strictly via `--patch` during Clean-DSH acceptance runs.
// Exposes real DSH Host `llm`, `sessionController`, `agentDefaultModel`, `agents`, and `credentials`
// inspection + session turn driving over authenticated `/api/__lt_accept/*` routes without touching global ~/.dsh.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function collectHostPackageJsonCandidates() {
  const candidates = [];
  const envDirs = [
    process.env.LT_ACCEPT_DSH_APP,
    process.env.LT_DSH_APP,
    process.env.DSH_APP_DIR,
    process.env.DSH_DESKTOP_DIR,
  ].filter(Boolean);

  for (const dir of envDirs) {
    const resolved = path.resolve(dir);
    candidates.push(path.join(resolved, 'resources', 'app.asar', 'dsh', 'package.json'));
    candidates.push(path.join(resolved, 'resources', 'app', 'dsh', 'package.json'));
    candidates.push(path.join(resolved, 'dsh', 'package.json'));
    candidates.push(path.join(resolved, 'package.json'));
  }

  const execDir = path.dirname(process.execPath);
  candidates.push(path.join(execDir, 'resources', 'app.asar', 'dsh', 'package.json'));
  candidates.push(path.join(execDir, 'resources', 'app', 'dsh', 'package.json'));

  if (process.argv[1]) {
    let cur = path.dirname(path.resolve(process.argv[1]));
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(path.join(cur, 'package.json'));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return [...new Set(candidates)];
}

async function resolveApprovalPolicySetter() {
  try {
    const direct = await import('@deepseek-ai/dsh-user-approval');
    if (typeof direct.setApprovalPolicy === 'function') return direct.setApprovalPolicy;
  } catch {}

  for (const pkgJson of collectHostPackageJsonCandidates()) {
    try {
      if (!pkgJson.includes('.asar') && !fs.existsSync(pkgJson)) continue;
      const reqHost = createRequire(pkgJson);
      const resolved = reqHost.resolve('@deepseek-ai/dsh-user-approval');
      const ua = await import(pathToFileURL(resolved).href);
      if (typeof ua.setApprovalPolicy === 'function') return ua.setApprovalPolicy;
    } catch {}
  }
  return null;
}

const setApprovalPolicyFn = await resolveApprovalPolicySetter();

export const name = 'lt-acceptance-host-bridge';
export const inject = ['connection', 'llm', 'sessionController', 'agentDefaultModel', 'agents', 'sessions'];

function jsonResponse(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function snapshotSessionEvents(session) {
  if (!session) return [];
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents(); } catch {}
  }
  const out = [];
  const len = Number(session.seq ?? 0);
  for (let i = 0; i < len; i += 1) {
    try {
      const ev = session.eventAt(i);
      if (ev) out.push(ev);
    } catch {}
  }
  return out;
}

function hasActiveWorkInTree(agentsSvc, rootSessionId) {
  const all = typeof agentsSvc?.list === 'function' ? agentsSvc.list() : [];
  for (const ag of all) {
    const isRoot = ag.id === rootSessionId;
    const isChild = ag.session?.header?.parentSession === rootSessionId;
    if (!isRoot && !isChild) continue;
    if (ag.status === 'running') return true;
    if ((ag.inbox?.nextTurn?.length ?? 0) > 0) return true;
    if ((ag.inbox?.nextStep?.length ?? 0) > 0) return true;
  }
  return false;
}

export function apply(ctx) {
  const conn = ctx.get('connection');
  const register = typeof conn?.fetch?.register === 'function' ? conn.fetch.register.bind(conn.fetch) : null;
  if (!register) return;

  const addRoute = (routePath, methods, fn) => {
    ctx.effect(
      () => register({ path: routePath, methods, requestBody: 'buffered', fetch: fn }),
      `lt-accept:${routePath}`,
    );
  };

  addRoute('/api/__lt_accept/host-state', ['GET'], async () => {
    try {
      const llm = ctx.get('llm');
      const sc = ctx.get('sessionController');
      const adm = ctx.get('agentDefaultModel');
      const creds = ctx.get('credentials');
      const settings = ctx.get('settings');

      const providers = typeof llm?.listProviders === 'function' ? await llm.listProviders() : [];
      const modelsByProvider = {};
      for (const p of providers) {
        const pid = typeof p === 'string' ? p : p.id;
        try {
          modelsByProvider[pid] = await llm.listModels(pid);
        } catch (err) {
          modelsByProvider[pid] = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      const catalog = typeof sc?.modelCatalog === 'function' ? await sc.modelCatalog() : null;
      const defaultSelection = typeof adm?.currentSelection === 'function' ? adm.currentSelection() : null;
      const presetSvc = ctx.get('agentPresets');
      const presets = typeof presetSvc?.list === 'function' ? await presetSvc.list() : null;

      let settingsDesc = null;
      try {
        settingsDesc = typeof settings?.describe === 'function' ? await settings.describe() : null;
      } catch {}

      const credentialRefs = {};
      if (creds && typeof creds.describe === 'function') {
        const refNames = [
          'OPENAI_API_KEY',
          'DEEPSEEK_API_KEY',
          'ANTHROPIC_API_KEY',
          'DASHSCOPE_API_KEY',
          'ZHIPU_API_KEY',
          'LEADERTEAM_MAGPIE_KEY',
          'LEADERTEAM_SOLO_API_KEY',
          ...(process.env.LT_ACCEPT_CREDENTIAL_REF ? [process.env.LT_ACCEPT_CREDENTIAL_REF] : []),
        ];
        for (const refName of [...new Set(refNames)]) {
          try {
            const d = await creds.describe(refName);
            credentialRefs[refName] = { configured: Boolean(d?.configured), source: d?.source ?? null };
          } catch {}
        }
      }

      return jsonResponse({
        ok: true,
        providers,
        modelsByProvider,
        catalog,
        defaultSelection,
        presets,
        credentialRefs,
        hasSettingsService: Boolean(settings),
        hasCredentialsService: Boolean(creds),
        settingsNamespaces: Array.isArray(settingsDesc) ? settingsDesc.map(s => s.id ?? s.namespace ?? s.name) : null,
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  addRoute('/api/__lt_accept/session-create', ['POST'], async request => {
    try {
      const body = await readJsonBody(request);
      const sc = ctx.get('sessionController');
      const agents = ctx.get('agents');
      const created = await sc.create({
        ...(body.cwd ? { cwd: body.cwd } : {}),
        ...(body.agentPreset ? { agentPreset: body.agentPreset } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      const agent = agents?.get?.(created.sessionId);
      if (agent && body.autoApprove !== false && setApprovalPolicyFn) {
        try { setApprovalPolicyFn(agent.ctx, 'never'); } catch {}
      }
      const currentModel = agent?.model?.current?.() ?? null;
      return jsonResponse({
        ok: true,
        sessionId: created.sessionId,
        agentPreset: created.agentPreset ?? null,
        currentModel,
      });
    } catch (err) {
      return jsonResponse({
        ok: false,
        code: err?.code ?? null,
        error: err instanceof Error ? err.message : String(err),
      }, 400);
    }
  });

  addRoute('/api/__lt_accept/session-select-model', ['POST'], async request => {
    try {
      const body = await readJsonBody(request);
      const sc = ctx.get('sessionController');
      const agents = ctx.get('agents');
      const res = await sc.selectModel({
        sessionId: body.sessionId,
        provider: body.provider,
        model: body.model,
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
      });
      const agent = agents?.get?.(body.sessionId);
      return jsonResponse({
        ok: true,
        selected: res?.selected ?? null,
        agentCurrentModel: agent?.model?.current?.() ?? null,
      });
    } catch (err) {
      return jsonResponse({
        ok: false,
        code: err?.code ?? null,
        error: err instanceof Error ? err.message : String(err),
      }, 400);
    }
  });

  addRoute('/api/__lt_accept/session-prompt', ['POST'], async request => {
    try {
      const body = await readJsonBody(request);
      const sc = ctx.get('sessionController');
      const agents = ctx.get('agents');
      const sessionId = body.sessionId;
      const text = String(body.text ?? '');
      const timeoutMs = Number(body.timeoutMs ?? 90000);
      const requestId = body.requestId ?? `req-${randomUUID()}`;

      const agentBefore = agents?.get?.(sessionId);
      if (agentBefore && body.autoApprove !== false && setApprovalPolicyFn) {
        try { setApprovalPolicyFn(agentBefore.ctx, 'never'); } catch {}
      }
      const seqBefore = Number(agentBefore?.session?.seq ?? 0);

      await sc.commands.prompt(
        {
          sessionId,
          requestId,
          content: [{ type: 'text', text }],
        },
        { kind: 'user', rpcId: requestId },
      );

      // Also auto-approve any child subagents spawned during Team mode
      const subWatch = ctx.on('agent/created', ({ agent: childAgent }) => {
        if (body.autoApprove !== false && setApprovalPolicyFn && childAgent?.session?.header?.parentSession === sessionId) {
          try { setApprovalPolicyFn(childAgent.ctx, 'never'); } catch {}
        }
      });

      const deadline = Date.now() + timeoutMs;
      let sawTurnStart = false;
      let idleStreak = 0;
      try {
        while (Date.now() < deadline) {
          const ag = agents?.get?.(sessionId);
          const evs = snapshotSessionEvents(ag?.session).slice(seqBefore);
          if (evs.some(e => e?.type === 'turn/start')) sawTurnStart = true;
          const treeBusy = hasActiveWorkInTree(agents, sessionId);
          const hasTurnEnd = evs.some(e => e?.type === 'turn/end');
          if (sawTurnStart && hasTurnEnd && !treeBusy) {
            idleStreak += 1;
            // Wait ~350ms of consecutive quiescence so async governance / maybeAutoContinueLeader settle
            if (idleStreak >= 4) break;
          } else {
            idleStreak = 0;
          }
          await new Promise(r => setTimeout(r, 100));
        }
      } finally {
        try { subWatch?.(); } catch {}
      }

      const agAfter = agents?.get?.(sessionId);
      const newEvents = snapshotSessionEvents(agAfter?.session).slice(seqBefore);
      const assistantMessages = newEvents
        .filter(e => e?.type === 'assistant/message')
        .map(e => ({
          id: e.data?.message?.id ?? null,
          source: {
            provider: e.data?.message?.source?.provider ?? null,
            model: e.data?.message?.source?.model ?? null,
          },
          text: (e.data?.message?.content ?? [])
            .filter(b => b?.type === 'text')
            .map(b => b.text)
            .join('\n'),
          toolCalls: (e.data?.message?.content ?? [])
            .filter(b => b?.type === 'tool-call' || b?.type === 'toolCall')
            .map(b => b.name),
          usage: e.data?.usage ?? null,
        }));
      const turnEnds = newEvents
        .filter(e => e?.type === 'turn/end')
        .map(e => e.data?.reason ?? null);
      const agentErrors = newEvents
        .filter(e => e?.type === 'agent/error' || e?.type === 'turn/error')
        .map(e => e.data);

      return jsonResponse({
        ok: true,
        sessionId,
        currentModel: agAfter?.model?.current?.() ?? null,
        newEventCount: newEvents.length,
        assistantMessages,
        finalText: assistantMessages.map(m => m.text).filter(Boolean).at(-1) ?? '',
        turnEnds,
        agentErrors,
      });
    } catch (err) {
      return jsonResponse({
        ok: false,
        code: err?.code ?? null,
        error: err instanceof Error ? err.message : String(err),
      }, 500);
    }
  });
}
