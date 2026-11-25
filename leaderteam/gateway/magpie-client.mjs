/**
 * Server-to-Server Magpie HTTP Client (Gateway + Web Administration)
 *
 * Security & Protocol Rules:
 * 1. Gateway calls (`/`, `/v1/*`) go to `gatewayUrl` (`127.0.0.1:<gwPort>`) with `Authorization: Bearer magpie-leaderteam`
 *    so Magpie attributes requests cleanly on loopback without requiring an `access.json` key.
 * 2. Web Admin calls (`/api/*`) go to `webAdminUrl` (`127.0.0.1:<webPort>`) carrying `Cookie: magpie_web_<port>=<webKey>`
 *    with NO `Origin` or `Sec-Fetch-Site` headers (satisfying Magpie's server-side CrossOriginProtection).
 * 3. Secrets (`webKey`, provider `key`) are NEVER logged or echoed in error messages.
 */

export class MagpieApiError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'MagpieApiError';
    this.code = code;
    this.status = status;
  }
}

function normalizeUrlBase(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim().replace(/\/+$/, '');
}

function resolveCookiePort(webAdminUrl) {
  const u = new URL(webAdminUrl);
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

export class MagpieClient {
  constructor({
    gatewayUrl = 'http://127.0.0.1:13425',
    webAdminUrl = null,
    webKey = null,
    callerApp = 'leaderteam',
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.gatewayUrl = normalizeUrlBase(gatewayUrl);
    this.webAdminUrl = normalizeUrlBase(webAdminUrl);
    this.webKey = typeof webKey === 'string' && webKey.trim() ? webKey.trim() : null;
    this.callerApp = callerApp;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  hasWebAdminAuth() {
    return Boolean(this.webAdminUrl && this.webKey);
  }

  async _request(baseUrl, pathAndQuery, { method = 'GET', body, authKind = 'gateway', timeoutMs } = {}) {
    if (!baseUrl) {
      throw new MagpieApiError('MAGPIE_NOT_CONFIGURED', `Magpie ${authKind} URL is not configured`, 400);
    }
    const headers = { Accept: 'application/json' };
    if (authKind === 'web') {
      if (!this.webKey) {
        throw new MagpieApiError(
          'MAGPIE_WEB_AUTH_REQUIRED',
          'Magpie Web management key is required to read or mutate provider settings',
          401,
        );
      }
      const port = resolveCookiePort(baseUrl);
      headers.Cookie = `magpie_web_${port}=${this.webKey}`;
    } else if (this.callerApp) {
      headers.Authorization = `Bearer magpie-${this.callerApp}`;
    }

    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    const started = Date.now();
    try {
      const res = await this.fetchImpl(`${baseUrl}${pathAndQuery}`, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      const text = await res.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      if (!res.ok) {
        const msg = (json && typeof json.error === 'string' && json.error)
          || (json && typeof json.error?.message === 'string' && json.error.message)
          || `Magpie HTTP ${res.status} on ${pathAndQuery}`;
        const code = res.status === 401
          ? 'MAGPIE_UNAUTHORIZED'
          : (res.status === 403 ? 'MAGPIE_FORBIDDEN' : 'MAGPIE_HTTP_ERROR');
        throw new MagpieApiError(code, msg, res.status);
      }
      return { status: res.status, latencyMs, data: json };
    } catch (err) {
      if (err instanceof MagpieApiError) throw err;
      const msg = err?.name === 'AbortError'
        ? `Magpie request timed out after ${timeoutMs ?? this.timeoutMs}ms (${pathAndQuery})`
        : `Magpie unreachable (${err instanceof Error ? err.message : String(err)})`;
      throw new MagpieApiError('MAGPIE_UNREACHABLE', msg, 503);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ==================== Gateway Endpoints ==================== */

  async probeHealth({ timeoutMs = 2500 } = {}) {
    const res = await this._request(this.gatewayUrl, '/', { method: 'GET', authKind: 'gateway', timeoutMs });
    return {
      ok: res.data?.name === 'magpie',
      latencyMs: res.latencyMs,
      version: res.data?.version ?? null,
      pid: Number.isInteger(res.data?.pid) ? res.data.pid : null,
      modelCount: Number.isInteger(res.data?.models) ? res.data.models : 0,
      apis: Array.isArray(res.data?.apis) ? res.data.apis : [],
    };
  }

  async listGatewayModels() {
    const res = await this._request(this.gatewayUrl, '/v1/models', { method: 'GET', authKind: 'gateway' });
    return Array.isArray(res.data?.data) ? res.data.data : [];
  }

  async listGatewayAccounts() {
    const res = await this._request(this.gatewayUrl, '/v1/magpie/accounts?models=1', { method: 'GET', authKind: 'gateway' });
    return Array.isArray(res.data?.data) ? res.data.data : [];
  }

  async listGatewayQuotas() {
    const res = await this._request(this.gatewayUrl, '/v1/magpie/quotas', { method: 'GET', authKind: 'gateway' });
    return res.data ?? {};
  }

  async fetchUsageFeed({ cursor = 'start', limit = 500 } = {}) {
    const q = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    const res = await this._request(
      this.gatewayUrl,
      `/v1/magpie/usage/requests?${q.toString()}`,
      { method: 'GET', authKind: 'gateway', timeoutMs: 4000 },
    );
    return {
      rows: Array.isArray(res.data?.rows) ? res.data.rows : [],
      nextCursor: typeof res.data?.next_cursor === 'string' ? res.data.next_cursor : cursor,
      hasMore: Boolean(res.data?.has_more),
    };
  }

  /* ==================== Web Admin Endpoints ==================== */

  async getSettings() {
    const res = await this._request(this.webAdminUrl, '/api/settings', { method: 'GET', authKind: 'web' });
    return res.data ?? {};
  }

  async updateSettings(patch) {
    const res = await this._request(this.webAdminUrl, '/api/settings', { method: 'POST', body: patch, authKind: 'web' });
    return res.data ?? {};
  }

  async setDisabledModels(models) {
    const res = await this._request(this.webAdminUrl, '/api/settings/disabled-models', {
      method: 'POST',
      body: { models: Array.isArray(models) ? models : [] },
      authKind: 'web',
    });
    return res.data ?? {};
  }

  async listProviders() {
    const res = await this._request(this.webAdminUrl, '/api/providers', { method: 'GET', authKind: 'web' });
    return res.data ?? { providers: [], presets: [], gateway: null };
  }

  async saveProvider(spec) {
    const res = await this._request(this.webAdminUrl, '/api/provider/save', {
      method: 'POST',
      body: spec,
      authKind: 'web',
      timeoutMs: 12000,
    });
    return res.data;
  }

  async deleteProvider(id) {
    const res = await this._request(this.webAdminUrl, '/api/provider/delete', {
      method: 'POST',
      body: { id },
      authKind: 'web',
    });
    return res.data;
  }

  async toggleProvider(id, enabled) {
    const action = enabled ? 'on' : 'off';
    const res = await this._request(this.webAdminUrl, `/api/provider/${action}`, {
      method: 'POST',
      body: { id },
      authKind: 'web',
    });
    return res.data;
  }

  async discoverProviderModels(probeSpec) {
    const res = await this._request(this.webAdminUrl, '/api/provider/list', {
      method: 'POST',
      body: probeSpec,
      authKind: 'web',
      timeoutMs: 12000,
    });
    return res.data ?? { models: [], embedIds: [], rerankIds: [] };
  }

  async refreshSavedProviderModels(id) {
    const res = await this._request(this.webAdminUrl, '/api/provider/models', {
      method: 'POST',
      body: { id },
      authKind: 'web',
      timeoutMs: 12000,
    });
    return res.data;
  }

  async testProvider({ id, account, models }) {
    const body = { id };
    if (account) body.account = account;
    if (Array.isArray(models) && models.length > 0) body.test = models;
    const res = await this._request(this.webAdminUrl, '/api/provider/test', {
      method: 'POST',
      body,
      authKind: 'web',
      timeoutMs: 15000,
    });
    return res.data;
  }

  async setProviderRouting({ id, route, sessionAffinity }) {
    let latest = null;
    if (route) {
      const r = await this._request(this.webAdminUrl, '/api/provider/route', {
        method: 'POST',
        body: { id, route },
        authKind: 'web',
      });
      latest = r.data;
    }
    if (typeof sessionAffinity === 'boolean') {
      const r = await this._request(this.webAdminUrl, '/api/provider/affinity', {
        method: 'POST',
        body: { id, affinity: sessionAffinity },
        authKind: 'web',
      });
      latest = r.data;
    }
    return latest;
  }

  async setModelPreferences({ providerId, model, displayName, efforts }) {
    let latest = null;
    if (typeof displayName === 'string') {
      const r = await this._request(this.webAdminUrl, '/api/provider/name', {
        method: 'POST',
        body: { id: providerId, model, modelName: displayName },
        authKind: 'web',
      });
      latest = r.data;
    }
    if (Array.isArray(efforts)) {
      const r = await this._request(this.webAdminUrl, '/api/provider/efforts', {
        method: 'POST',
        body: { id: providerId, model, efforts },
        authKind: 'web',
      });
      latest = r.data;
    }
    return latest;
  }

  /* ==================== Multi-Key Pool CRUD ==================== */

  async mutateKey(action, payload) {
    const allowed = new Set(['add', 'import', 'use', 'on', 'off', 'rename', 'replace', 'weight', 'remove', 'remove-many']);
    if (!allowed.has(action)) {
      throw new MagpieApiError('BAD_KEY_ACTION', `Unsupported Magpie key action: ${action}`, 400);
    }
    const res = await this._request(this.webAdminUrl, `/api/keys/${action}`, {
      method: 'POST',
      body: payload,
      authKind: 'web',
    });
    return res.data;
  }

  /* ==================== OAuth Sign-In Passthrough ==================== */

  async startSignIn({ agent, linkOnly = true, proxy, site }) {
    const res = await this._request(this.webAdminUrl, '/api/signin', {
      method: 'POST',
      body: { agent, linkOnly, ...(proxy ? { proxy } : {}), ...(site ? { site } : {}) },
      authKind: 'web',
    });
    return res.data;
  }

  async getSignInStatus(signInId) {
    const res = await this._request(this.webAdminUrl, `/api/signin/${encodeURIComponent(signInId)}`, {
      method: 'GET',
      authKind: 'web',
    });
    return res.data;
  }

  async submitSignInCallback(signInId, callbackUrl) {
    const res = await this._request(this.webAdminUrl, `/api/signin/${encodeURIComponent(signInId)}/callback`, {
      method: 'POST',
      body: { url: callbackUrl },
      authKind: 'web',
    });
    return res.data;
  }

  async cancelSignIn(signInId) {
    const res = await this._request(this.webAdminUrl, `/api/signin/${encodeURIComponent(signInId)}/cancel`, {
      method: 'POST',
      body: {},
      authKind: 'web',
    });
    return res.data;
  }
}
