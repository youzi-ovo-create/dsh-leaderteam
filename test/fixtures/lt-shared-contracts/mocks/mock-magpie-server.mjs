/**
 * Controllable Local Mock Magpie Server (Gateway + Web Admin)
 * Zero paid API usage, loopback-only (`127.0.0.1`), faithful to Magpie v0.1.4731..v0.1.4797 Go wire structs:
 * - Gateway port: `/`, `/api/hello`, `/v1/models`, `/v1/chat/completions`, `/v1/magpie/accounts`, `/v1/magpie/quotas`, `/v1/magpie/usage/requests` (page & cursor feed with 410 cursor_reset & deleted tombstones)
 * - Web Admin port: `Cookie: magpie_web_<port>=<webKey>` + `Sec-Fetch-Site` / `Origin` CSRF guard,
 *   `/api/settings` (settingsapi.Apply semantics), `/api/settings/account-discovery`, `/api/providers` (`providerJSON`),
 *   `/api/provider/*` (strict Go `*string` validation on `routing`/`affinity`), `/api/keys/*`, `/api/groups*`, `/api/signin*`, `/api/login/*`
 */

import http from 'node:http';
import crypto from 'node:crypto';

function maskSecret(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length <= 8) return `${s.slice(0, 2)}****`;
  // Real Magpie masks with Unicode horizontal ellipsis U+2026
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function keyIdOf(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 10);
}

// Mirrors `settingsapi.Keys` in `magpie-upstream/internal/settingsapi/settingsapi.go`:
// POST /api/settings unmarshals onto a zero-valued struct for these keys unless sent in the body!
const SETTINGS_API_ZERO_DEFAULTS = {
  theme: '',
  accent: '',
  lang: '',
  proxy: '',
  pluginProxy: '',
  updateProxy: '',
  updateSource: '',
  noStats: false,
  noUsageStats: false,
  noAutoUpdate: false,
  noAutoDownload: false,
  noUpdatePill: false,
  signInLinkOnly: false,
  currency: '',
  totalCurrency: '',
};

const VALID_SIGNIN_AGENTS = new Set(['codex', 'claude', 'gemini', 'cursor', 'copilot', 'qoder', 'zcode']);
const VALID_ROUTING_VALUES = new Set(['', 'order', 'rotate', 'usage', 'weight']);
const VALID_AFFINITY_VALUES = new Set(['', 'session', 'turn', 'off', 'strict']);

const DEFAULT_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    chat: 'https://api.deepseek.com/v1',
    responses: '',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    keyHint: 'sk-...',
    keyOptional: false,
    defaultModels: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', efforts: ['none'], images: false, context: 128000, output: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', efforts: ['none', 'low', 'medium', 'high'], images: false, context: 128000, output: 32768 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    chat: 'https://api.openai.com/v1',
    responses: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-...',
    keyOptional: false,
    defaultModels: [
      { id: 'gpt-5.2', name: 'GPT-5.2', efforts: ['low', 'medium', 'high', 'xhigh'], images: true, context: 400000, output: 128000 },
      { id: 'o4-mini', name: 'o4-mini', efforts: ['low', 'medium', 'high'], images: true, context: 200000, output: 100000 },
    ],
  },
  {
    id: 'dashscope',
    name: 'Alibaba Bailian (DashScope)',
    chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    responses: '',
    keysUrl: 'https://bailian.console.aliyun.com/',
    keyHint: 'sk-...',
    keyOptional: false,
    defaultModels: [
      { id: 'qwen4-max-preview', name: 'Qwen4 Max Preview', efforts: ['none', 'medium', 'high'], images: true, context: 262144, output: 32768 },
    ],
  },
];

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function normalizeInternalProvider(p) {
  const copy = structuredClone(p);
  copy.off = Boolean(copy.off ?? copy.disabled);
  delete copy.disabled;
  copy.keyList = (copy.keyList || copy.keys || []).map((k, idx) => ({
    id: k.id || keyIdOf(`${copy.id}-${idx}`),
    name: k.name || (idx === 0 ? 'Primary' : `Key ${idx + 1}`),
    masked: k.masked || 'sk-…0000',
    active: typeof k.active === 'boolean' ? k.active : (typeof k.primary === 'boolean' ? k.primary : idx === 0),
    on: typeof k.on === 'boolean' ? k.on : !k.disabled,
    protocol: k.protocol || '',
    weight: k.weight || 1,
    plan: k.plan || '',
  }));
  delete copy.keys;
  copy.routing = typeof copy.routing === 'string' ? copy.routing : '';
  copy.affinity = typeof copy.affinity === 'string' ? copy.affinity : '';
  return copy;
}

export async function startMockMagpieServer(options = {}) {
  const version = options.version || '0.1.4731';
  const webKey = options.webKey || 'mock-magpie-web-key-0123456789abcdef';
  const state = {
    version,
    feedEpoch: 'feed1',
    settings: {
      port: 0,
      lan: false,
      gatewayMode: 'on',
      noAccountDiscovery: true,
      noAutoUpdate: true,
      noStats: true,
      lang: 'system',
      disabledModels: [],
    },
    providers: new Map(),
    groups: new Map(),
    usageRows: [],
    deletedUsageIds: [],
    signInSessions: new Map(),
    seq: 0,
  };

  if (Array.isArray(options.initialProviders)) {
    for (const p of options.initialProviders) {
      state.providers.set(p.id, normalizeInternalProvider(p));
    }
  }
  if (Array.isArray(options.initialUsageRows)) {
    for (const r of options.initialUsageRows) {
      state.seq += 1;
      state.usageRows.push({ seq: state.seq, ...r });
    }
  }

  function isProviderReady(p) {
    if (p.off) return false;
    if (p.account) {
      const logins = Array.isArray(p.account.logins) ? p.account.logins : [];
      if (logins.length > 0) return logins.some(l => l.on !== false);
      return Boolean(p.account.user || p.account.email);
    }
    if (p.keyOptional) return true;
    return (p.keyList || []).some(k => k.on);
  }

  function buildProviderModelJSONList(p) {
    const catalogList = Array.isArray(p.catalogModels) && p.catalogModels.length > 0
      ? p.catalogModels
      : (Array.isArray(p.listed) ? p.listed : []);
    const chosenSet = Array.isArray(p.chosen) && p.chosen.length > 0 ? new Set(p.chosen) : null;
    return catalogList.map(m => {
      const mid = typeof m === 'string' ? m : m.id;
      const pref = p.modelPrefs?.[mid] || {};
      const efforts = Array.isArray(pref.efforts) && pref.efforts.length > 0
        ? pref.efforts
        : (Array.isArray(m.efforts) && m.efforts.length > 0 ? m.efforts : ['none']);
      const fullId = `${p.id}/${mid}`;
      const disabledBySetting = state.settings.disabledModels.includes(fullId);
      const exposed = !p.noModels && !disabledBySetting && (chosenSet ? chosenSet.has(mid) : true);
      return {
        id: mid,
        name: pref.name || m.name || mid,
        efforts,
        ...(Array.isArray(pref.efforts) ? { kept: pref.efforts } : {}),
        images: typeof pref.images === 'boolean' ? pref.images : Boolean(m.images),
        on: exposed,
        context: m.context || 128000,
        output: m.output || 16384,
      };
    });
  }

  function buildGatewayModels() {
    const out = [];
    for (const p of state.providers.values()) {
      if (p.off || p.unlisted || !isProviderReady(p)) continue;
      const modelJsonList = buildProviderModelJSONList(p);
      for (const m of modelJsonList) {
        if (!m.on) continue;
        const fullId = `${p.id}/${m.id}`;
        const efforts = Array.isArray(m.efforts) && m.efforts.length > 0 ? m.efforts : ['none'];
        const hasReasoning = efforts.some(e => e !== 'none');
        out.push({
          id: fullId,
          object: 'model',
          created: 0,
          owned_by: p.id,
          type: 'model',
          display_name: m.name || m.id,
          magpie_label: `${p.name} · ${m.name || m.id}`,
          reasoning: hasReasoning,
          supported_reasoning_levels: hasReasoning ? efforts.map(effort => ({ effort })) : [],
          reasoning_levels: hasReasoning ? efforts : [],
          context_window: m.context || 128000,
          context_length: m.context || 128000,
          max_output_tokens: m.output || 16384,
          modalities: { input: m.images ? ['text', 'image'] : ['text'], output: ['text'] },
          tool_call: true,
        });
      }
    }
    for (const g of state.groups.values()) {
      out.push({
        id: `group/${g.id}`,
        object: 'model',
        created: 0,
        owned_by: 'group',
        type: 'model',
        display_name: g.name || g.id,
        magpie_label: `Group · ${g.name || g.id}`,
        reasoning: true,
        reasoning_levels: ['low', 'medium', 'high'],
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        context_window: 128000,
        max_output_tokens: 16384,
        modalities: { input: ['text'], output: ['text'] },
        tool_call: true,
      });
    }
    return out;
  }

  // Emits authentic Magpie 0.1.4731 `providerJSON` Go struct fields (`GW-01`, `GW-02`, `GW-04`)
  function serializeProvider(p) {
    const keyList = (p.keyList || []).map(k => ({
      id: k.id,
      ...(k.name ? { name: k.name } : {}),
      masked: k.masked,
      active: Boolean(k.active),
      on: Boolean(k.on),
      ...(k.protocol ? { protocol: k.protocol } : {}),
      ...(k.weight && k.weight > 1 ? { weight: k.weight } : {}),
      ...(k.plan ? { plan: k.plan } : {}),
    }));
    const activeKey = keyList.find(k => k.active && k.on) || keyList.find(k => k.on) || keyList[0] || null;
    const models = buildProviderModelJSONList(p);
    const ready = isProviderReady(p);
    const exposed = ready && !p.off && !p.unlisted ? models.filter(m => m.on).length : 0;

    return {
      id: p.id,
      name: p.name,
      icon: p.icon || p.preset || 'generic',
      preset: p.preset || '',
      host: p.host || '',
      chat: p.chat || '',
      responses: p.responses || '',
      anthropic: p.anthropic || '',
      ...(p.gemini ? { gemini: p.gemini } : {}),
      keysUrl: p.keysUrl || '',
      baseAPI: p.baseAPI || (p.responses ? 'responses' : 'chat'),
      unlisted: Boolean(p.unlisted),
      noModels: Boolean(p.noModels),
      bestInFamily: Boolean(p.bestInFamily),
      off: Boolean(p.off),
      key: {
        set: keyList.length > 0,
        masked: activeKey ? activeKey.masked : '',
        optional: Boolean(p.keyOptional),
      },
      ready,
      chosen: Array.isArray(p.chosen) ? p.chosen : [],
      fallback: Array.isArray(p.fallback) ? p.fallback : [],
      routing: typeof p.routing === 'string' ? p.routing : '',
      affinity: typeof p.affinity === 'string' ? p.affinity : '',
      maxConcurrency: null,
      maxAccounts: null,
      models,
      exposed,
      agents: [],
      sponsored: false,
      keyList,
      ...(p.account ? { account: structuredClone(p.account) } : {}),
    };
  }

  function buildProvidersPayload(gwPort) {
    return {
      providers: Array.from(state.providers.values()).map(serializeProvider),
      presets: DEFAULT_PRESETS.map(({ defaultModels: _dm, ...rest }) => rest),
      gateway: {
        url: `http://127.0.0.1:${gwPort}`,
        port: gwPort,
        configured: gwPort,
        running: true,
        inProcess: true,
        mode: state.settings.gatewayMode,
        lan: false,
      },
      accountDiscoveryOff: state.settings.noAccountDiscovery,
      fetching: false,
    };
  }

  let gwPort = 0;
  let webPort = 0;

  const gatewayServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${gwPort}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/v1' || pathname === '/v1/')) {
      const models = buildGatewayModels();
      return sendJson(res, 200, {
        name: 'magpie',
        version: state.version,
        models: models.length,
        window: false,
        apis: ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'],
        pid: process.pid,
        serves: 'serve',
      });
    }
    if (req.method === 'GET' && pathname === '/api/hello') {
      return sendJson(res, 200, { name: 'magpie', version: state.version });
    }
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      const data = buildGatewayModels();
      return sendJson(res, 200, {
        object: 'list',
        data,
        has_more: false,
        first_id: data[0]?.id || '',
        last_id: data.at(-1)?.id || '',
      });
    }
    if (req.method === 'GET' && pathname === '/v1/codex/models') {
      return sendJson(res, 200, { models: [] });
    }
    if (req.method === 'GET' && pathname === '/v1/magpie/accounts') {
      const data = [];
      for (const p of state.providers.values()) {
        const provModels = buildProviderModelJSONList(p).filter(m => m.on).map(m => `${p.id}/${m.id}`);
        if (p.account) {
          const logins = Array.isArray(p.account.logins) && p.account.logins.length > 0
            ? p.account.logins
            : (p.account.user ? [{ user: p.account.user, email: p.account.email, plan: p.account.plan, on: true }] : []);
          for (const l of logins) {
            const uid = l.user || l.email || 'account';
            data.push({
              provider: p.id,
              providerName: p.name,
              id: uid,
              pin: `${p.id}/${uid}`,
              kind: 'account',
              label: l.email || uid,
              plan: l.plan || p.account.plan || '',
              on: !p.off && l.on !== false,
              models: provModels,
            });
          }
        }
        for (const k of (p.keyList || [])) {
          data.push({
            provider: p.id,
            providerName: p.name,
            id: k.id,
            pin: `${p.id}/${k.id}`,
            kind: 'key',
            label: k.name || 'Key',
            on: !p.off && Boolean(k.on),
            models: provModels,
          });
        }
      }
      return sendJson(res, 200, { object: 'list', data });
    }
    if (req.method === 'GET' && pathname === '/v1/magpie/quotas') {
      return sendJson(res, 200, { object: 'list', data: [] });
    }
    if (req.method === 'GET' && pathname === '/v1/magpie/usage/requests') {
      const cursor = url.searchParams.get('cursor');
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)));
      if (cursor !== null) {
        let afterSeq = 0;
        if (cursor === 'now') afterSeq = state.seq;
        else if (cursor !== 'start' && cursor !== '') {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
          } catch {
            return sendJson(res, 400, {
              error: { code: 'cursor_invalid', message: 'invalid usage feed cursor' },
            });
          }
          if (parsed.epoch && parsed.epoch !== state.feedEpoch) {
            return sendJson(res, 410, {
              error: {
                code: 'cursor_reset',
                message: "this cursor is of another feed (magpie's usage-feed.jsonl was lost or replaced); read the ledger again with cursor=start and drop what you hold of it",
              },
            });
          }
          afterSeq = Number(parsed.seq) || 0;
        }
        const slice = state.usageRows.filter(r => r.seq > afterSeq).slice(0, limit);
        const lastSeq = slice.at(-1)?.seq ?? afterSeq;
        const hasMore = state.usageRows.some(r => r.seq > lastSeq);
        const rows = slice.map(r => ({
          seq: r.seq,
          id: r.id,
          t: r.t,
          agent: r.agent || 'leaderteam',
          provider: r.provider,
          provider_name: r.providerName || r.provider,
          account: r.account || '',
          account_label: r.accountLabel || '',
          req: r.req,
          model: r.model,
          model_name: r.modelName || r.model,
          served: r.served || r.model,
          in: r.in,
          out: r.out,
          cache_read: r.cacheRead ?? r.cache_read ?? 0,
          cache_write: r.cacheWrite ?? r.cache_write ?? 0,
          reasoning: r.reasoning ?? 0,
          total: r.total ?? ((r.in || 0) + (r.cacheRead ?? r.cache_read ?? 0) + (r.cacheWrite ?? r.cache_write ?? 0) + (r.out || 0)),
          cost: r.cost ?? null,
          ...(typeof r.priced === 'boolean' ? { priced: r.priced } : {}),
          ...(r.handed_on ? { handed_on: true } : {}),
          ...(r.origin ? { origin: r.origin } : {}),
          ...(r.source ? { source: r.source } : {}),
          ...(r.rejected ? { rejected: true } : {}),
          ms: r.ms ?? 120,
          ttft_ms: r.ttftMs ?? r.ttft_ms ?? 40,
          status: r.status ?? 200,
          tries: r.tries ?? 1,
          effort: r.effort || '',
          session: r.session || '',
          response_id: r.responseId ?? r.response_id ?? '',
          via: r.via || 'through',
        }));
        const deleted = state.deletedUsageIds
          .filter(d => d.seq > afterSeq && d.seq <= (hasMore ? lastSeq : state.seq))
          .map(d => ({ id: d.id, seq: d.seq }));
        return sendJson(res, 200, {
          rows,
          deleted,
          next_cursor: Buffer.from(JSON.stringify({ epoch: state.feedEpoch, seq: hasMore ? lastSeq : Math.max(lastSeq, state.seq) })).toString('base64url'),
          has_more: hasMore,
        });
      }
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const rows = state.usageRows.slice(offset, offset + limit);
      return sendJson(res, 200, {
        rows,
        total: state.usageRows.length,
        failed: state.usageRows.filter(r => (r.status ?? 200) >= 400).length,
        retried: state.usageRows.filter(r => (r.tries ?? 1) > 1).length,
        offset,
        limit,
      });
    }
    if (req.method === 'POST' && pathname === '/v1/magpie/usage/requests') {
      const body = await readJsonBody(req);
      const items = Array.isArray(body) ? body : [body];
      let accepted = 0;
      let skipped = 0;
      for (const item of items) {
        const rid = item.rid || item.id || `r_${crypto.randomUUID()}`;
        if (state.usageRows.some(r => r.id === rid) && !item.upsert) {
          skipped += 1;
          continue;
        }
        state.seq += 1;
        state.usageRows = state.usageRows.filter(r => r.id !== rid);
        state.usageRows.push({
          seq: state.seq,
          id: rid,
          t: item.t || new Date().toISOString(),
          agent: item.agent || 'leaderteam',
          provider: item.provider || 'unknown',
          req: item.req || `${item.provider || 'unknown'}/${item.model || 'unknown'}`,
          model: item.model || 'unknown',
          in: item.in ?? 0,
          out: item.out ?? 0,
          cacheRead: item.cache_read ?? item.cacheRead ?? 0,
          reasoning: item.reasoning ?? 0,
          ms: item.ms ?? 0,
          ttftMs: item.ttft_ms ?? 0,
          cost: item.cost ?? null,
          ...(typeof item.priced === 'boolean' ? { priced: item.priced } : {}),
          ...(item.handed_on ? { handed_on: true } : {}),
          ...(item.origin ? { origin: item.origin } : {}),
          ...(item.source ? { source: item.source } : {}),
          ...(item.rejected ? { rejected: true } : {}),
          status: item.status ?? 200,
          tries: item.tries ?? 1,
          session: item.session || '',
          responseId: item.response_id ?? item.responseId ?? '',
          via: 'reported',
        });
        accepted += 1;
      }
      return sendJson(res, 200, { accepted, skipped });
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      const body = await readJsonBody(req);
      const reqModel = String(body.model || 'deepseek/deepseek-chat');
      const [provId, ...rest] = reqModel.split('/');
      const actualModel = rest.join('/') || reqModel;
      const responseId = `chatcmpl-mock-${crypto.randomUUID().slice(0, 12)}`;
      const auth = String(req.headers.authorization || '');
      const agentMatch = auth.match(/^Bearer\s+magpie-([A-Za-z0-9_-]+)$/i);
      state.seq += 1;
      state.usageRows.push({
        seq: state.seq,
        id: `r_${state.seq}`,
        responseId,
        t: new Date().toISOString(),
        agent: agentMatch ? agentMatch[1] : 'dsh',
        provider: provId === 'group' ? 'deepseek' : provId,
        providerName: provId === 'group' ? 'DeepSeek' : provId,
        req: reqModel,
        model: provId === 'group' ? 'deepseek-chat' : actualModel,
        served: provId === 'group' ? 'deepseek-chat' : actualModel,
        in: 120,
        out: 24,
        cacheRead: 64,
        cacheWrite: 0,
        reasoning: 0,
        total: 208,
        cost: null,
        ms: 42,
        ttftMs: 12,
        status: 200,
        tries: 1,
        session: String(req.headers['x-magpie-session'] || ''),
        via: 'through',
      });
      return sendJson(res, 200, {
        id: responseId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: provId === 'group' ? 'deepseek-chat' : actualModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: options.chatReply || 'MOCK_MAGPIE_OK' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 184,
          completion_tokens: 24,
          total_tokens: 208,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      });
    }

    return sendJson(res, 404, { error: 'Not found' });
  });

  const webServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${webPort}`);
    const pathname = url.pathname;
    const cookieName = `magpie_web_${webPort}`;

    if (req.method === 'GET' && pathname === '/' && url.searchParams.has('k')) {
      const k = url.searchParams.get('k');
      if (k !== webKey) return sendJson(res, 401, { error: 'Invalid key' });
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `${cookieName}=${webKey}; Path=/; HttpOnly; SameSite=Lax`,
      });
      return res.end();
    }

    // Faithful Magpie webOwnPage CSRF / Sec-Fetch-Site / Origin check
    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return sendJson(res, 403, { error: 'cross-site request refused' });
    }
    if (req.method === 'POST' && req.headers.origin) {
      const expectedOrigin = `http://${req.headers.host || `127.0.0.1:${webPort}`}`;
      if (req.headers.origin !== expectedOrigin) {
        return sendJson(res, 403, { error: 'cross-origin POST refused' });
      }
    }

    // Cookie session check
    const rawCookie = String(req.headers.cookie || '');
    const authed = rawCookie.split(';').some(part => {
      const [name, ...valParts] = part.trim().split('=');
      return name === cookieName && valParts.join('=') === webKey;
    });
    if (!authed) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Mock Magpie Web</title>');
    }
    if (req.method === 'GET' && pathname === '/api/settings') {
      return sendJson(res, 200, { ...state.settings, port: gwPort });
    }
    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      // Mirror `settingsapi.Apply` / `settingsapi.Merge`: keys in `settingsapi.Keys` default to Go zero values unless sent!
      const nextSettings = {
        ...state.settings,
        ...SETTINGS_API_ZERO_DEFAULTS,
      };
      for (const [k, v] of Object.entries(body || {})) {
        if (k === 'gatewayMode' || k === 'noAccountDiscovery' || k === 'disabledModels' || k === 'port') continue;
        nextSettings[k] = v;
      }
      state.settings = nextSettings;
      return sendJson(res, 200, { ...state.settings, port: gwPort });
    }
    if (req.method === 'POST' && pathname === '/api/settings/account-discovery') {
      const body = await readJsonBody(req);
      if (body.off !== undefined && typeof body.off !== 'boolean') {
        return sendJson(res, 400, { error: 'json: cannot unmarshal non-bool into Go struct field .off of type bool' });
      }
      state.settings.noAccountDiscovery = Boolean(body.off);
      return sendJson(res, 200, { ...state.settings, port: gwPort });
    }
    if (req.method === 'POST' && pathname === '/api/settings/disabled-models') {
      const body = await readJsonBody(req);
      state.settings.disabledModels = Array.isArray(body.models) ? body.models : [];
      return sendJson(res, 200, { ...state.settings, port: gwPort });
    }
    if (req.method === 'GET' && pathname === '/api/providers') {
      return sendJson(res, 200, buildProvidersPayload(gwPort));
    }

    if (req.method === 'POST' && pathname.startsWith('/api/provider/')) {
      const action = pathname.slice('/api/provider/'.length);
      const body = await readJsonBody(req);

      if (action === 'list') {
        const preset = DEFAULT_PRESETS.find(p => p.id === body.preset);
        const models = preset
          ? preset.defaultModels.map(m => ({ id: m.id, name: m.name }))
          : [{ id: 'custom-chat-v1', name: 'Custom Chat v1' }];
        return sendJson(res, 200, { models, embedIds: [], rerankIds: [] });
      }

      if (action === 'save') {
        if (body.routing !== undefined && body.routing !== null && typeof body.routing !== 'string') {
          return sendJson(res, 400, { error: 'json: cannot unmarshal non-string into Go struct field .routing of type string' });
        }
        if (body.affinity !== undefined && body.affinity !== null && typeof body.affinity !== 'string') {
          return sendJson(res, 400, { error: 'json: cannot unmarshal bool into Go struct field .affinity of type string' });
        }
        const preset = body.preset ? DEFAULT_PRESETS.find(p => p.id === body.preset) : null;
        const id = String(body.id || preset?.id || '').trim();
        if (!id) return sendJson(res, 400, { error: 'Provider id is required' });
        const existing = state.providers.get(body.from || id) || null;
        if (body.from && body.from !== id) state.providers.delete(body.from);

        let keyList = existing ? structuredClone(existing.keyList || []) : [];
        if (body.clearKey) keyList = [];
        if (typeof body.key === 'string' && body.key.trim()) {
          const parts = body.key.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
          for (const secret of parts) {
            const kid = keyIdOf(secret);
            if (!keyList.some(k => k.id === kid)) {
              keyList.push({
                id: kid,
                name: keyList.length === 0 ? 'Primary' : `Key ${keyList.length + 1}`,
                masked: maskSecret(secret),
                active: keyList.length === 0,
                on: true,
                weight: 1,
              });
            }
          }
        }
        const catalogModels = existing?.catalogModels?.length
          ? existing.catalogModels
          : (preset
            ? structuredClone(preset.defaultModels)
            : (Array.isArray(body.models) && body.models.length > 0
              ? body.models.map(m => ({ id: m, name: m, efforts: ['none'], images: false }))
              : [{ id: 'custom-chat-v1', name: 'Custom Chat v1', efforts: ['none'], images: false }]));

        const chatUrl = body.chat ?? preset?.chat ?? existing?.chat ?? '';
        const respUrl = body.responses ?? preset?.responses ?? existing?.responses ?? '';
        const endpointCandidate = String(chatUrl || respUrl || body.anthropic || body.gemini || '').trim();
        const isLoopbackUrl = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(endpointCandidate);
        state.providers.set(id, {
          id,
          name: body.name || preset?.name || existing?.name || id,
          preset: preset?.id || existing?.preset || '',
          keysUrl: preset?.keysUrl || existing?.keysUrl || '',
          keyOptional: Boolean(preset?.noKey || preset?.keyOptional || isLoopbackUrl || existing?.keyOptional),
          chat: chatUrl,
          responses: respUrl,
          anthropic: body.anthropic ?? existing?.anthropic ?? '',
          gemini: body.gemini ?? existing?.gemini ?? '',
          baseAPI: body.baseAPI || existing?.baseAPI || (preset?.responses ? 'responses' : 'chat'),
          keyList,
          catalogModels,
          chosen: Array.isArray(body.models) ? body.models : (existing?.chosen || []),
          unlisted: typeof body.unlisted === 'boolean' ? body.unlisted : Boolean(existing?.unlisted),
          noModels: typeof body.noModels === 'boolean' ? body.noModels : Boolean(existing?.noModels),
          bestInFamily: typeof body.bestInFamily === 'boolean' ? body.bestInFamily : Boolean(existing?.bestInFamily),
          modelPrefs: body.modelPrefs || existing?.modelPrefs || {},
          off: Boolean(existing?.off),
          routing: typeof body.routing === 'string' ? body.routing : (existing?.routing ?? ''),
          affinity: typeof body.affinity === 'string' ? body.affinity : (existing?.affinity ?? ''),
          ...(existing?.account ? { account: existing.account } : {}),
        });
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }

      const target = state.providers.get(body.id);
      if (!target) return sendJson(res, 400, { error: `Unknown provider: ${body.id}` });

      if (action === 'delete') {
        state.providers.delete(body.id);
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
      if (action === 'on' || action === 'off') {
        target.off = action === 'off';
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
      if (action === 'models') {
        return sendJson(res, 200, {
          count: (target.catalogModels || []).length,
          dropped: [],
          provider: serializeProvider(target),
        });
      }
      if (action === 'test') {
        const ok = isProviderReady(target);
        const proto = target.baseAPI === 'responses'
          ? 'responses'
          : (target.baseAPI === 'anthropic' ? 'anthropic' : (target.baseAPI === 'gemini' ? 'gemini' : 'chat'));
        const defaultModel = typeof target.catalogModels?.[0] === 'string'
          ? target.catalogModels[0]
          : (target.catalogModels?.[0]?.id || '');
        if (Array.isArray(body.test) && body.test.length > 0) {
          const results = body.test.map(m => ({
            protocol: proto,
            ok,
            status: ok ? 200 : 401,
            ms: 28,
            model: String(m),
            ...(ok ? {} : { error: 'Unauthorized' }),
          }));
          return sendJson(res, 200, { results });
        }
        const results = [{
          protocol: proto,
          ok,
          status: ok ? 200 : 401,
          ms: 19,
          ...(defaultModel ? { model: defaultModel } : {}),
          ...(ok ? {} : { error: 'Unauthorized' }),
        }];
        return sendJson(res, 200, { results, provider: serializeProvider(target) });
      }
      if (action === 'efforts') {
        target.modelPrefs = target.modelPrefs || {};
        target.modelPrefs[body.model] = { ...(target.modelPrefs[body.model] || {}), efforts: body.efforts || [] };
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
      if (action === 'name') {
        target.modelPrefs = target.modelPrefs || {};
        target.modelPrefs[body.model] = { ...(target.modelPrefs[body.model] || {}), name: body.modelName || '' };
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
      if (action === 'route') {
        if (body.routing !== undefined && body.routing !== null && typeof body.routing !== 'string') {
          return sendJson(res, 400, { error: 'json: cannot unmarshal non-string into Go struct field .routing of type string' });
        }
        const nextRouting = typeof body.routing === 'string' ? body.routing : '';
        if (!VALID_ROUTING_VALUES.has(nextRouting)) {
          return sendJson(res, 400, { error: `unknown routing ${JSON.stringify(nextRouting)}` });
        }
        target.routing = nextRouting;
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
      if (action === 'affinity') {
        if (body.affinity !== undefined && body.affinity !== null && typeof body.affinity !== 'string') {
          return sendJson(res, 400, { error: 'json: cannot unmarshal bool into Go struct field .affinity of type string' });
        }
        const nextAffinity = typeof body.affinity === 'string' ? body.affinity : '';
        if (!VALID_AFFINITY_VALUES.has(nextAffinity)) {
          return sendJson(res, 400, { error: `unknown affinity ${JSON.stringify(nextAffinity)}` });
        }
        target.affinity = nextAffinity;
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
    }

    if (req.method === 'POST' && pathname.startsWith('/api/keys/')) {
      const action = pathname.slice('/api/keys/'.length);
      const body = await readJsonBody(req);
      const target = state.providers.get(body.id);
      if (!target) return sendJson(res, 400, { error: `Unknown provider: ${body.id}` });
      target.keyList = target.keyList || [];

      if (action === 'add' || action === 'import') {
        const rawKeys = String(body.key || '').split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
        let added = 0;
        let had = 0;
        for (const secret of rawKeys) {
          const kid = keyIdOf(secret);
          if (target.keyList.some(k => k.id === kid)) {
            had += 1;
            continue;
          }
          target.keyList.push({
            id: kid,
            name: body.name || `Key ${target.keyList.length + 1}`,
            masked: maskSecret(secret),
            active: target.keyList.length === 0,
            on: true,
            protocol: body.protocol || '',
            plan: body.plan || '',
            weight: 1,
          });
          added += 1;
        }
        return sendJson(res, 200, { ...buildProvidersPayload(gwPort), added, had });
      }
      if (action === 'remove-many') {
        const refs = new Set(Array.isArray(body.refs) ? body.refs : []);
        const matched = target.keyList.filter(k => refs.has(k.id));
        if (matched.length === 0) {
          return sendJson(res, 400, { error: `${target.name || target.id} has none of these keys` });
        }
        const kept = target.keyList.filter(k => !refs.has(k.id));
        if (target.keyList.some(k => k.on) && !kept.some(k => k.on)) {
          return sendJson(res, 400, { error: 'those are all the keys in use; keep one on' });
        }
        const before = target.keyList.length;
        target.keyList = kept;
        if (target.keyList.length > 0 && !target.keyList.some(k => k.active)) {
          const nextOn = target.keyList.find(k => k.on) || target.keyList[0];
          nextOn.active = true;
        }
        return sendJson(res, 200, { ...buildProvidersPayload(gwPort), removed: before - target.keyList.length });
      }
      const keyEntry = target.keyList.find(k => k.id === body.ref);
      if (!keyEntry) return sendJson(res, 400, { error: `${target.name || target.id} has no such key` });
      if (action === 'remove') {
        const remainingOn = target.keyList.filter(k => k.id !== body.ref && k.on);
        if (keyEntry.on && remainingOn.length === 0) {
          return sendJson(res, 400, { error: "that's the only key in use; turn another on before removing it" });
        }
        target.keyList = target.keyList.filter(k => k.id !== body.ref);
        if (target.keyList.length > 0 && !target.keyList.some(k => k.active)) {
          const nextOn = target.keyList.find(k => k.on) || target.keyList[0];
          nextOn.active = true;
        }
        return sendJson(res, 200, buildProvidersPayload(gwPort));
      }
      if (action === 'use') {
        if (!keyEntry.on) keyEntry.on = true;
        for (const k of target.keyList) k.active = k.id === body.ref;
      } else if (action === 'on' || action === 'off') {
        if (action === 'off' && keyEntry.on) {
          const otherOn = target.keyList.filter(k => k.id !== body.ref && k.on);
          if (otherOn.length === 0) {
            return sendJson(res, 400, { error: "that's the only key in use; turn another on first" });
          }
          keyEntry.on = false;
          if (keyEntry.active) {
            keyEntry.active = false;
            otherOn[0].active = true;
          }
        } else {
          keyEntry.on = true;
        }
      } else if (action === 'rename') {
        keyEntry.name = String(body.name || keyEntry.name);
      } else if (action === 'weight') {
        keyEntry.weight = Math.max(1, Math.min(100, Number(body.weight) || 1));
      } else if (action === 'replace') {
        const kid = keyIdOf(body.key);
        keyEntry.id = kid;
        keyEntry.masked = maskSecret(body.key);
      } else if (action === 'protocol') {
        keyEntry.protocol = String(body.protocol || '');
      } else if (action === 'plan') {
        keyEntry.plan = String(body.plan || '');
      }
      return sendJson(res, 200, buildProvidersPayload(gwPort));
    }

    if (req.method === 'POST' && pathname.startsWith('/api/login/')) {
      const action = pathname.slice('/api/login/'.length);
      if (!['switch', 'forget', 'on', 'off', 'access-only', 'renewed'].includes(action)) {
        return sendJson(res, 404, { error: 'Not found' });
      }
      const body = await readJsonBody(req);
      const agent = String(body.agent || '').trim();
      const user = String(body.user || '').trim();
      const target = Array.from(state.providers.values()).find(
        p => p.account?.agent === agent || p.id === agent,
      );
      if (!target || !target.account) {
        return sendJson(res, 400, { error: `No signed-in subscription provider for agent: ${agent}` });
      }
      target.account.logins = Array.isArray(target.account.logins) ? target.account.logins : [];
      if (action === 'switch') {
        target.account.user = user;
        for (const l of target.account.logins) l.active = l.user === user;
      } else if (action === 'forget') {
        target.account.logins = target.account.logins.filter(l => l.user !== user);
        if (target.account.user === user) {
          target.account.user = target.account.logins[0]?.user || '';
        }
        if (target.account.logins.length === 0 && !target.account.user) {
          state.providers.delete(target.id);
        }
      } else if (action === 'on' || action === 'off') {
        const entry = target.account.logins.find(l => l.user === user);
        if (entry) entry.on = action === 'on';
      }
      return sendJson(res, 200, buildProvidersPayload(gwPort));
    }

    if (req.method === 'GET' && pathname === '/api/groups') {
      return sendJson(res, 200, {
        groups: Array.from(state.groups.values()),
        models: buildGatewayModels().map(m => m.id),
        defaults: {},
      });
    }
    if (req.method === 'POST' && pathname === '/api/groups/save') {
      const body = await readJsonBody(req);
      state.groups.set(body.id, { id: body.id, name: body.name || body.id, strategy: body.strategy || 'priority', routes: body.routes || [] });
      return sendJson(res, 200, { groups: Array.from(state.groups.values()) });
    }
    if (req.method === 'POST' && pathname === '/api/signin') {
      const body = await readJsonBody(req);
      if (state.settings.noAccountDiscovery) {
        return sendJson(res, 400, {
          error: 'subscription accounts are off in magpie (Settings › Privacy, or `magpie accounts discovery on`)',
        });
      }
      const agent = String(body.agent || '').trim();
      if (!VALID_SIGNIN_AGENTS.has(agent)) {
        return sendJson(res, 400, { error: `magpie can't sign in to ${agent} accounts` });
      }
      const id = `signin_${crypto.randomUUID().slice(0, 8)}`;
      const s = {
        id,
        agent,
        url: `https://auth.example.invalid/oauth/${id}`,
        state: 'waiting',
        pasteCallback: true,
        linkOnly: Boolean(body.linkOnly),
      };
      state.signInSessions.set(id, s);
      return sendJson(res, 200, s);
    }
    if (pathname.startsWith('/api/signin/')) {
      const suffix = pathname.slice('/api/signin/'.length);
      if (req.method === 'GET' && !suffix.includes('/')) {
        const s = state.signInSessions.get(suffix);
        if (!s) return sendJson(res, 404, { error: 'Unknown signin session' });
        return sendJson(res, 200, s);
      }
      if (req.method === 'POST' && suffix.endsWith('/cancel')) {
        const id = suffix.slice(0, -'/cancel'.length);
        const s = state.signInSessions.get(id);
        if (s) s.state = 'canceled';
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST' && suffix.endsWith('/callback')) {
        const id = suffix.slice(0, -'/callback'.length);
        const s = state.signInSessions.get(id);
        if (!s) return sendJson(res, 404, { error: 'Unknown signin session' });
        const body = await readJsonBody(req);
        if (!body?.url || typeof body.url !== 'string') {
          return sendJson(res, 400, { error: 'callback url is required' });
        }
        const userEmail = `user-${s.agent}@example.invalid`;
        s.state = 'done';
        s.user = userEmail;
        s.plan = 'Pro';
        const existingProv = state.providers.get(s.agent);
        const prevLogins = existingProv?.account?.logins || [];
        const nextLogins = [
          ...prevLogins.filter(l => l.user !== userEmail).map(l => ({ ...l, active: false })),
          { user: userEmail, email: userEmail, plan: 'Pro', on: true, active: true },
        ];
        state.providers.set(s.agent, {
          id: s.agent,
          name: s.agent === 'codex' ? 'Codex' : (s.agent === 'claude' ? 'Claude' : s.agent),
          preset: '',
          chat: '',
          responses: s.agent === 'codex' ? 'https://chatgpt.com/backend-api/codex' : '',
          anthropic: s.agent === 'claude' ? 'https://api.anthropic.com' : '',
          baseAPI: s.agent === 'codex' ? 'responses' : 'chat',
          keyList: [],
          catalogModels: existingProv?.catalogModels || [
            { id: `${s.agent}-sub-model`, name: `${s.agent} Subscription Model`, efforts: ['low', 'medium', 'high'], images: true },
          ],
          chosen: [],
          off: false,
          routing: existingProv?.routing || '',
          affinity: existingProv?.affinity || '',
          account: {
            agent: s.agent,
            agentName: s.agent,
            agentIcon: s.agent,
            user: userEmail,
            email: userEmail,
            plan: 'Pro',
            logins: nextLogins,
          },
        });
        res.writeHead(204);
        return res.end();
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  });

  await new Promise((resolve, reject) => {
    gatewayServer.once('error', reject);
    gatewayServer.listen(options.gatewayPort || 0, '127.0.0.1', () => {
      gwPort = gatewayServer.address().port;
      resolve();
    });
  });

  await new Promise((resolve, reject) => {
    webServer.once('error', reject);
    webServer.listen(options.webPort || 0, '127.0.0.1', () => {
      webPort = webServer.address().port;
      resolve();
    });
  });

  return {
    gatewayPort: gwPort,
    webPort,
    gatewayUrl: `http://127.0.0.1:${gwPort}`,
    webUrl: `http://127.0.0.1:${webPort}`,
    webKey,
    state,
    resetUsageFeed(newRows = []) {
      state.feedEpoch = `feed_${crypto.randomUUID().slice(0, 8)}`;
      state.usageRows = [];
      state.deletedUsageIds = [];
      state.seq = 0;
      for (const r of newRows) {
        state.seq += 1;
        state.usageRows.push({ seq: state.seq, ...r });
      }
    },
    deleteUsageRow(id) {
      state.seq += 1;
      state.usageRows = state.usageRows.filter(r => r.id !== id);
      state.deletedUsageIds.push({ seq: state.seq, id });
    },
    upsertUsageRow(row) {
      state.seq += 1;
      state.usageRows = state.usageRows.filter(r => r.id !== row.id);
      state.usageRows.push({ seq: state.seq, ...row });
    },
    async close() {
      await Promise.all([
        new Promise(r => gatewayServer.close(() => r())),
        new Promise(r => webServer.close(() => r())),
      ]);
    },
  };
}
