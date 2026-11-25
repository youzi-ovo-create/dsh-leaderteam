#!/usr/bin/env node
/**
 * `lt-ui` — Standalone Loopback Server for Leader Team Native Workbench
 * Serves the exact same LT Native Frontend (`web-dist`) and `/api/lt/v1/*` contract endpoints
 * with loopback `Host`/`Origin`/`Sec-Fetch-Site` fences and launch-token HttpOnly cookie auth.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_API_ROUTES,
  createPublicContractHandlers,
  serveLtWebStaticRequest,
} from '../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { runtime } from '../leaderteam/host/runtime.mjs';

const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;
const COOKIE_NAME = 'lt_workbench_sid';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export async function startStandaloneLtUiServer({
  port = 4320,
  dshHome = null,
  configPath = null,
  requireAuth = true,
} = {}) {
  if (dshHome) process.env.DSH_HOME = dshHome;
  const launchToken = crypto.randomBytes(24).toString('hex');
  const sessionSecret = crypto.randomBytes(24).toString('hex');

  const rt = runtime();
  const handlers = createPublicContractHandlers(null, rt, {
    configPath,
    hostKindOverride: 'standalone',
  });
  const routeMap = new Map([
    [PUBLIC_API_ROUTES.CAPABILITIES, handlers.capabilities],
    [PUBLIC_API_ROUTES.BUNDLE, handlers.bundle],
    [PUBLIC_API_ROUTES.GATEWAY_STATUS, handlers.gatewayStatus],
    [PUBLIC_API_ROUTES.GATEWAY_CONTROL, handlers.gatewayControl],
    [PUBLIC_API_ROUTES.PROVIDERS_LIST, handlers.providersList],
    [PUBLIC_API_ROUTES.PROVIDERS_MUTATE, handlers.providersMutate],
    [PUBLIC_API_ROUTES.MODELS_CATALOG, handlers.modelsCatalog],
    [PUBLIC_API_ROUTES.MODELS_SYNC_POOL, handlers.modelsSyncPool],
    [PUBLIC_API_ROUTES.RUNTIME_SNAPSHOT, handlers.runtimeSnapshot],
    [PUBLIC_API_ROUTES.RUNTIME_CONFIGURE, handlers.runtimeConfigure],
    [PUBLIC_API_ROUTES.WORKBENCH_SESSIONS, handlers.workbenchSessions],
    [PUBLIC_API_ROUTES.WORKBENCH_TRANSCRIPT, handlers.workbenchTranscript],
    [PUBLIC_API_ROUTES.WORKBENCH_CREATE, handlers.workbenchCreate],
    [PUBLIC_API_ROUTES.WORKBENCH_PROMPT, handlers.workbenchPrompt],
    [PUBLIC_API_ROUTES.WORKBENCH_CANCEL, handlers.workbenchCancel],
    [PUBLIC_API_ROUTES.ARCHIVE_QUERY, handlers.archiveQuery],
    [PUBLIC_API_ROUTES.ARCHIVE_ACTION, handlers.archiveAction],
    [PUBLIC_API_ROUTES.USAGE_STATUS, handlers.usageStatus],
    [PUBLIC_API_ROUTES.USAGE_OVERVIEW, handlers.usageOverview],
    [PUBLIC_API_ROUTES.USAGE_SESSIONS, handlers.usageSessions],
    [PUBLIC_API_ROUTES.USAGE_REPORT, handlers.usageReport],
    [PUBLIC_API_ROUTES.USAGE_PRICING, handlers.usagePricing],
    [PUBLIC_API_ROUTES.USAGE_TOGGLE, handlers.usageToggle],
    [PUBLIC_API_ROUTES.UI_PREFERENCES, handlers.uiPreferences],
  ]);

  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (!LOOPBACK_HOST_RE.test(host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden host (DNS rebinding guard)');
        return;
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Cross-site request refused');
        return;
      }

      const url = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
      if (req.method === 'GET' && url.searchParams.has('token')) {
        const tok = url.searchParams.get('token') || '';
        if (!safeEqual(tok, launchToken)) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid launch token');
          return;
        }
        url.searchParams.delete('token');
        res.writeHead(302, {
          Location: url.pathname + (url.search || ''),
          'Set-Cookie': `${COOKIE_NAME}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }

      const isAuthed = () => {
        if (!requireAuth) return true;
        const cookies = parseCookies(req.headers.cookie);
        if (cookies[COOKIE_NAME] && safeEqual(cookies[COOKIE_NAME], sessionSecret)) return true;
        const auth = String(req.headers.authorization || '');
        if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), launchToken)) return true;
        return false;
      };

      const apiHandler = routeMap.get(url.pathname);
      if (apiHandler) {
        if (!isAuthed()) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
          return;
        }
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const bodyBuf = Buffer.concat(chunks);
        const fetchReq = new Request(url.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : bodyBuf,
        });
        const fetchRes = await apiHandler(fetchReq);
        const outBuf = Buffer.from(await fetchRes.arrayBuffer());
        const outHeaders = Object.fromEntries(fetchRes.headers.entries());
        res.writeHead(fetchRes.status, outHeaders);
        res.end(outBuf);
        return;
      }

      const fetchReq = new Request(url.toString(), { method: req.method, headers: req.headers });
      const staticRes = await serveLtWebStaticRequest(fetchReq, {
        mountPrefix: url.pathname.startsWith('/lt') ? '/lt' : '',
        authorizeIndex: () => (isAuthed() ? undefined : new Response('Unauthorized — open the launch URL printed in terminal', { status: 401 })),
      });
      const outBuf = Buffer.from(await staticRes.arrayBuffer());
      res.writeHead(staticRes.status, Object.fromEntries(staticRes.headers.entries()));
      res.end(outBuf);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      boundPort = server.address().port;
      resolve();
    });
  });

  return {
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    launchUrl: `http://127.0.0.1:${boundPort}/?token=${launchToken}`,
    token: launchToken,
    async close() {
      await new Promise(r => server.close(() => r()));
    },
  };
}

function isMainCliModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainCliModule()) {
  const argv = process.argv.slice(2);
  let port = 4320;
  let dshHome = null;
  let configPath = null;
  let requireAuth = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) port = Number(argv[++i]);
    else if (argv[i] === '--dsh-home' && argv[i + 1]) dshHome = argv[++i];
    else if (argv[i] === '--config' && argv[i + 1]) configPath = argv[++i];
    else if (argv[i] === '--no-auth') requireAuth = false;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: lt-ui [--port 4320] [--dsh-home <dir>] [--config <file>] [--no-auth]');
      process.exit(0);
    }
  }
  startStandaloneLtUiServer({ port, dshHome, configPath, requireAuth }).then(info => {
    console.log(`Leader Team Workbench listening on ${info.baseUrl}`);
    console.log(`Open in browser: ${info.launchUrl}`);
  });
}
