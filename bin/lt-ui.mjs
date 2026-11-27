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
  CONTRACT_ID,
  CONTRACT_VERSION,
  PUBLIC_API_ROUTES,
  PUBLIC_READONLY_API_ROUTES,
  createPublicContractHandlers,
  serveLtWebStaticRequest,
} from '../leaderteam/plugins/leaderteam-panel/public-api.mjs';
import { runtime } from '../leaderteam/host/runtime.mjs';

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const COOKIE_PREFIX = 'lt_workbench_sid';

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

function isAllowedApiOrigin(originHeader, hostHeader) {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== 'string') return false;
  const trimmed = originHeader.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  try {
    const originUrl = new URL(trimmed);
    if (originUrl.protocol !== 'http:') return false;
    return originUrl.host.toLowerCase() === String(hostHeader || '').trim().toLowerCase();
  } catch {
    return false;
  }
}

function parseCookies(raw) {
  const out = {};
  for (const part of String(raw || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      if (!key) continue;
      const rawVal = part.slice(idx + 1).trim();
      try {
        out[key] = decodeURIComponent(rawVal);
      } catch {
        out[key] = rawVal;
      }
    }
  }
  return out;
}

function readBoundedBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const onData = chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.pause();
        req.removeListener('data', onData);
        resolve({ tooLarge: true, buffer: null });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ tooLarge: false, buffer: Buffer.concat(chunks) });
    });
    req.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendPayloadTooLargeAndDestroy(req, res, maxBytes = MAX_BODY_BYTES) {
  // Drain bounded request bytes (up to 16 MiB / 1000ms) BEFORE ending `res` with Connection: close
  // so Winsock never sees unread inbound bytes on socket close and never emits TCP RST (ECONNRESET).
  let finished = false;
  let drained = 0;
  const maxDrain = maxBytes * 8;
  const send413 = forceDestroy => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    req.removeListener('data', onDrainData);
    req.removeListener('end', onEnd);
    if (!res.headersSent) {
      res.writeHead(413, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: `Request body exceeds ${maxBytes} bytes` },
      }),
      () => {
        if (forceDestroy) {
          const g = setTimeout(() => { try { req.destroy(); } catch {} }, 100);
          g.unref?.();
        }
      },
    );
  };
  const onDrainData = chunk => {
    drained += chunk.length;
    if (drained > maxDrain) send413(true);
  };
  const onEnd = () => send413(false);
  const timer = setTimeout(() => send413(true), 1000);
  timer.unref?.();
  if (req.readableEnded) {
    send413(false);
    return;
  }
  req.on('data', onDrainData);
  req.once('end', onEnd);
  req.resume();
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
    dshHome,
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
    [PUBLIC_API_ROUTES.WORKBENCH_SESSION_CONFIG, handlers.workbenchSessionConfig],
    [PUBLIC_API_ROUTES.ARCHIVE_QUERY, handlers.archiveQuery],
    [PUBLIC_API_ROUTES.ARCHIVE_ACTION, handlers.archiveAction],
    [PUBLIC_API_ROUTES.USAGE_STATUS, handlers.usageStatus],
    [PUBLIC_API_ROUTES.USAGE_OVERVIEW, handlers.usageOverview],
    [PUBLIC_API_ROUTES.USAGE_SESSIONS, handlers.usageSessions],
    [PUBLIC_API_ROUTES.USAGE_REPORT, handlers.usageReport],
    [PUBLIC_API_ROUTES.USAGE_PRICING, handlers.usagePricing],
    [PUBLIC_API_ROUTES.USAGE_TOGGLE, handlers.usageToggle],
    [PUBLIC_API_ROUTES.UI_PREFERENCES, handlers.uiPreferences],
    [PUBLIC_API_ROUTES.SYSTEM_COMPATIBILITY, handlers.systemCompatibility],
    [PUBLIC_API_ROUTES.SYSTEM_UPDATE, handlers.systemUpdate],
    [PUBLIC_API_ROUTES.ONBOARDING, handlers.onboarding],
  ]);

  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (!isAllowedLoopbackHost(host, boundPort)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden host (DNS rebinding & port-mismatch guard)');
        return;
      }
      const secFetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
      if (secFetchSite === 'cross-site') {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Cross-site request refused');
        return;
      }

      const cookieName = `${COOKIE_PREFIX}_${boundPort}`;
      const url = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
      if (req.method === 'GET' && url.searchParams.has('token')) {
        const tok = url.searchParams.get('token') || '';
        if (!safeEqual(tok, launchToken)) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('Invalid launch token');
          return;
        }
        url.searchParams.delete('token');
        res.writeHead(302, {
          Location: url.pathname + (url.search || ''),
          'Set-Cookie': `${cookieName}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end();
        return;
      }

      const isAuthed = () => {
        if (!requireAuth) return true;
        const cookies = parseCookies(req.headers.cookie);
        if (cookies[cookieName] && safeEqual(cookies[cookieName], sessionSecret)) return true;
        const auth = String(req.headers.authorization || '');
        if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), launchToken)) return true;
        return false;
      };

      const apiHandler = routeMap.get(url.pathname);
      if (apiHandler || url.pathname.startsWith('/api/')) {
        if (secFetchSite === 'same-site' || !isAllowedApiOrigin(req.headers.origin, host)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({
            ok: false,
            error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin or cross-port API request refused' },
          }));
          return;
        }
        if (!apiHandler) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'API route not found' } }));
          return;
        }
        if (!isAuthed()) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }));
          return;
        }

        const reqMethod = String(req.method || 'GET').toUpperCase();
        const isReadOnlyRoute = PUBLIC_READONLY_API_ROUTES.has(url.pathname);
        const allowedMethods = isReadOnlyRoute ? ['GET', 'POST'] : ['POST'];
        if (!allowedMethods.includes(reqMethod)) {
          const allowHeader = allowedMethods.join(', ');
          res.writeHead(405, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            Allow: allowHeader,
          });
          res.end(JSON.stringify({
            ok: false,
            contract: CONTRACT_ID,
            contractVersion: CONTRACT_VERSION,
            generatedAt: new Date().toISOString(),
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: `HTTP ${reqMethod} is not allowed on ${url.pathname}; use ${allowHeader}`,
              retriable: false,
            },
          }));
          return;
        }

        const declaredLen = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
        if (declaredLen !== null && Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
          sendPayloadTooLargeAndDestroy(req, res, MAX_BODY_BYTES);
          return;
        }

        let bodyBuf = Buffer.alloc(0);
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const readRes = await readBoundedBody(req, MAX_BODY_BYTES);
          if (readRes.tooLarge) {
            sendPayloadTooLargeAndDestroy(req, res, MAX_BODY_BYTES);
            return;
          }
          bodyBuf = readRes.buffer;

          const ct = String(req.headers['content-type'] || '').toLowerCase();
          const isJsonCt = ct.includes('application/json');
          if (!isJsonCt) {
            const allowEmpty = bodyBuf.length === 0 && ct === '' && req.headers['content-length'] === '0';
            if (!allowEmpty) {
              res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({
                ok: false,
                error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'POST API requests require Content-Type: application/json' },
              }));
              return;
            }
          }
        }

        const fetchReq = new Request(url.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' || bodyBuf.length === 0 ? undefined : bodyBuf,
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
