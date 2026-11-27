/**
 * Modular, Non-Blocking Hengzhang (`lt-usage-plugin`) Integration Bridge for Leader Team
 *
 * Architectural Guarantees (Section 五 & 六):
 * 1. NEVER enters the critical path of model inference: Magpie usage watermark polling runs
 *    asynchronously out-of-band with short timeouts and swallows upstream errors.
 * 2. Fault-isolated & toggleable: If Hengzhang is disabled or encounters any error, LT continues
 *    operating with zero impact.
 * 3. Strictly honest accounting (`unknown != 0`): Never fabricates prices, tokens, or upstream
 *    provider attribution when unavailable.
 * 4. Read-only on `<DSH_HOME>/sessions`: Custom pricing overrides and watermarks live strictly
 *    under `<storageRoot>/usage/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/store.mjs';
import {
  defaultPricing,
  pricingCatalog,
  loadHome,
  listSessions,
  overviewFor,
  reportFor,
} from '../../packages/lt-usage/index.mjs';
import { listKnownHomes, samePath } from '../../packages/lt-usage/reader/homes.js';
import { getOrCreateGatewayManager, normalizeMagpieUsageRow } from '../gateway/index.mjs';

const MAX_CACHED_GATEWAY_RECORDS = 5000;

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function withBoundedTimeout(promise, ms) {
  let timer = null;
  const timeoutPromise = new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isCursorResetError(err) {
  if (!err) return false;
  if (err.status === 410) return true;
  const code = String(err.upstreamErrorCode || '');
  if (code.startsWith('cursor_')) return true;
  if (err.status === 400 && /cursor/i.test(String(err.message || ''))) return true;
  return false;
}

export class HengzhangUsageBridge {
  constructor({
    storageRoot,
    dshHome = null,
    gatewayManager = null,
    fetchImpl = globalThis.fetch,
  }) {
    if (!storageRoot) throw new Error('HengzhangUsageBridge requires storageRoot');
    this.storageRoot = path.resolve(storageRoot);
    this.usageDir = path.join(this.storageRoot, 'usage');
    this.pricingFile = path.join(this.usageDir, 'custom-pricing.json');
    this.stateFile = path.join(this.usageDir, 'bridge-state.json');
    this.explicitDshHome = dshHome ? path.resolve(dshHome) : null;
    this.gatewayManager = gatewayManager ?? getOrCreateGatewayManager(this.storageRoot, { fetchImpl });
    this.fetchImpl = fetchImpl;

    this.gatewayRecordMap = new Map();
    this.activeFeedGatewayUrl = null;
    this.nextCursor = 'start';
    this.syncInFlight = null;
    this.lastSyncAt = null;
    this.lastSyncError = null;
    this.faultInjector = null; // Test-only hook to prove fault isolation
  }

  get gatewayRecords() {
    return Array.from(this.gatewayRecordMap.values());
  }

  set gatewayRecords(records) {
    this.gatewayRecordMap.clear();
    if (Array.isArray(records)) {
      for (const r of records) {
        if (r?.gatewayRecordId) {
          this.gatewayRecordMap.set(r.gatewayRecordId, r);
        }
      }
    }
  }

  get gatewayRecordIds() {
    return new Set(this.gatewayRecordMap.keys());
  }

  resolveDshHome(overrideHome = null) {
    if (typeof overrideHome === 'string' && overrideHome.trim()) {
      if (overrideHome.includes('\0')) {
        throw Object.assign(new Error('Invalid DSH home path'), { code: 'FORBIDDEN_HOME', status: 400 });
      }
      return path.resolve(overrideHome.trim());
    }
    if (this.explicitDshHome) return this.explicitDshHome;
    if (process.env.DSH_HOME?.trim()) return path.resolve(process.env.DSH_HOME.trim());
    return path.dirname(this.storageRoot);
  }

  /**
   * Safe DSH home resolver for untrusted HTTP callers (`Shared Interface Contract #3`):
   * rejects arbitrary filesystem directories unless `allowExternalOverride: true` OR the path
   * matches the configured `dshHome` / registered `listKnownHomes()`.
   */
  resolveSafeDshHome(overrideHome = null, { allowExternalOverride = false } = {}) {
    const baseHome = this.resolveDshHome(null);
    if (overrideHome === null || overrideHome === undefined || (typeof overrideHome === 'string' && !overrideHome.trim())) {
      return baseHome;
    }
    if (typeof overrideHome !== 'string' || overrideHome.includes('\0')) {
      throw Object.assign(new Error('Invalid DSH home override'), { code: 'FORBIDDEN_HOME', status: 403 });
    }
    const candidate = path.resolve(overrideHome.trim());
    if (allowExternalOverride) return candidate;
    if (samePath(candidate, baseHome)) return baseHome;
    const known = listKnownHomes(baseHome);
    const matched = known.find(h => samePath(candidate, h));
    if (matched) return matched;
    throw Object.assign(
      new Error(`Forbidden DSH home override: ${overrideHome}`),
      { code: 'FORBIDDEN_HOME', status: 403 },
    );
  }

  _loadState() {
    const raw = readJsonSafe(this.stateFile, null);
    return {
      enabled: raw?.enabled !== false,
    };
  }

  isEnabled() {
    return this._loadState().enabled;
  }

  setEnabled(enabled) {
    fs.mkdirSync(this.usageDir, { recursive: true });
    const next = { enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
    writeFileAtomic(this.stateFile, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  getPricing() {
    const custom = readJsonSafe(this.pricingFile, null);
    if (custom && typeof custom === 'object' && custom.routes && typeof custom.routes === 'object') {
      return {
        usdToCny: Number.isFinite(Number(custom.usdToCny)) && Number(custom.usdToCny) > 0
          ? Number(custom.usdToCny)
          : defaultPricing.usdToCny,
        routes: { ...defaultPricing.routes, ...custom.routes },
      };
    }
    return structuredClone(defaultPricing);
  }

  _getCustomRouteKeys() {
    const custom = readJsonSafe(this.pricingFile, null);
    if (custom && typeof custom === 'object' && custom.routes && typeof custom.routes === 'object') {
      return new Set(Object.keys(custom.routes));
    }
    return new Set();
  }

  savePricing(nextPricing) {
    if (!nextPricing || typeof nextPricing !== 'object' || typeof nextPricing.routes !== 'object') {
      throw new Error('Invalid pricing payload: expected { usdToCny, routes }');
    }
    const usdToCny = Number(nextPricing.usdToCny);
    if (!Number.isFinite(usdToCny) || usdToCny <= 0) {
      throw new Error('usdToCny must be a positive number');
    }
    const sanitizedRoutes = {};
    for (const [route, entry] of Object.entries(nextPricing.routes)) {
      if (!entry || typeof entry !== 'object') continue;
      sanitizedRoutes[route] = entry;
    }
    fs.mkdirSync(this.usageDir, { recursive: true });
    const payload = { usdToCny, routes: sanitizedRoutes };
    writeFileAtomic(this.pricingFile, JSON.stringify(payload, null, 2) + '\n');
    return this.getPricing();
  }

  resetPricing() {
    if (fs.existsSync(this.pricingFile)) {
      fs.rmSync(this.pricingFile, { force: true });
    }
    return this.getPricing();
  }

  /**
   * Fire-and-forget out-of-band sync from Magpie `/v1/magpie/usage/requests?cursor=...`.
   * NEVER throws, NEVER blocks model calls, and immediately no-ops if Hengzhang is disabled.
   */
  triggerBackgroundMagpieSync() {
    if (!this.isEnabled()) return Promise.resolve({ synced: false, reason: 'disabled' });
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this._pullMagpieFeedOnce()
      .catch(err => {
        this.lastSyncError = err instanceof Error ? err.message : String(err);
        return { synced: false, error: this.lastSyncError };
      })
      .finally(() => {
        this.syncInFlight = null;
      });
    return this.syncInFlight;
  }

  async _pullMagpieFeedOnce() {
    const ep = this.gatewayManager?.getActiveEndpoints?.();
    if (!ep?.gatewayUrl || ep.mode === 'disabled') {
      return { synced: false, reason: 'gateway-disabled' };
    }
    // Reset stale cursor & cache when active gateway endpoint changes (`HZ-01`)
    if (this.activeFeedGatewayUrl && this.activeFeedGatewayUrl !== ep.gatewayUrl) {
      this.gatewayRecordMap.clear();
      this.nextCursor = 'start';
    }
    this.activeFeedGatewayUrl = ep.gatewayUrl;

    const client = this.gatewayManager.createClient();
    let rounds = 0;
    let added = 0;
    let updated = 0;
    let retriedCursorReset = false;

    while (rounds < 4) {
      rounds += 1;
      let page;
      try {
        page = await client.fetchUsageFeed({ cursor: this.nextCursor, limit: 500 });
      } catch (err) {
        if (!retriedCursorReset && this.nextCursor !== 'start' && isCursorResetError(err)) {
          retriedCursorReset = true;
          this.gatewayRecordMap.clear();
          this.nextCursor = 'start';
          page = await client.fetchUsageFeed({ cursor: 'start', limit: 500 });
        } else {
          throw err;
        }
      }

      if (Array.isArray(page.deleted)) {
        for (const delItem of page.deleted) {
          const delId = typeof delItem === 'string'
            ? delItem.trim()
            : String(delItem?.id ?? delItem?.rid ?? '').trim();
          if (delId) this.gatewayRecordMap.delete(delId);
        }
      }

      for (const rawRow of page.rows) {
        const rawId = String(rawRow?.id || rawRow?.rid || '').trim();
        const norm = normalizeMagpieUsageRow(rawRow);
        if (!norm) {
          if (rawId) this.gatewayRecordMap.delete(rawId);
          continue;
        }
        const existed = this.gatewayRecordMap.has(norm.gatewayRecordId);
        if (existed) {
          this.gatewayRecordMap.delete(norm.gatewayRecordId);
          updated += 1;
        } else {
          added += 1;
        }
        this.gatewayRecordMap.set(norm.gatewayRecordId, norm);
      }

      while (this.gatewayRecordMap.size > MAX_CACHED_GATEWAY_RECORDS) {
        const oldestKey = this.gatewayRecordMap.keys().next().value;
        if (oldestKey === undefined) break;
        this.gatewayRecordMap.delete(oldestKey);
      }

      const prevCursor = this.nextCursor;
      this.nextCursor = page.nextCursor || this.nextCursor;
      const hasDeleted = Array.isArray(page.deleted) && page.deleted.length > 0;
      if (!page.hasMore || (page.rows.length === 0 && !hasDeleted && this.nextCursor === prevCursor)) break;
    }

    this.lastSyncAt = new Date().toISOString();
    this.lastSyncError = null;
    return { synced: true, added, updated, totalCached: this.gatewayRecordMap.size };
  }

  _guardEnabledAndHealthy() {
    if (!this.isEnabled()) {
      return { active: false, reason: 'disabled', error: null };
    }
    if (typeof this.faultInjector === 'function') {
      this.faultInjector();
    }
    return { active: true, reason: null, error: null };
  }

  async getStatus({ home = null, allowExternalOverride = true } = {}) {
    try {
      const check = this._guardEnabledAndHealthy();
      const resolvedHome = this.resolveSafeDshHome(home, { allowExternalOverride });
      return {
        enabled: check.active,
        healthy: true,
        dshHome: resolvedHome,
        homeExists: fs.existsSync(path.join(resolvedHome, 'sessions')),
        cachedGatewayRecords: this.gatewayRecordMap.size,
        lastSyncAt: this.lastSyncAt,
        lastSyncError: this.lastSyncError,
      };
    } catch (e) {
      if (e?.code === 'FORBIDDEN_HOME') throw e;
      return {
        enabled: this.isEnabled(),
        healthy: false,
        dshHome: null,
        homeExists: false,
        cachedGatewayRecords: this.gatewayRecordMap.size,
        lastSyncAt: this.lastSyncAt,
        lastSyncError: e instanceof Error ? e.message : String(e),
      };
    }
  }

  _storageRootForHome(resolvedHome) {
    return samePath(resolvedHome, this.resolveDshHome(null)) ? this.storageRoot : undefined;
  }

  async getOverview({ home = null, syncGateway = true, allowExternalOverride = true } = {}) {
    const check = this._guardEnabledAndHealthy();
    if (!check.active) {
      return { enabled: false, overview: null };
    }
    const resolvedHome = this.resolveSafeDshHome(home, { allowExternalOverride });
    if (syncGateway) {
      await withBoundedTimeout(this.triggerBackgroundMagpieSync(), 1200);
    }
    const pricing = this.getPricing();
    const storageRootForHome = this._storageRootForHome(resolvedHome);
    const hasSessionsDir = fs.existsSync(path.join(resolvedHome, 'sessions'));
    const preloadedHome = hasSessionsDir ? loadHome(resolvedHome) : null;
    const overview = hasSessionsDir
      ? overviewFor(resolvedHome, pricing, {
        gatewayRecords: this.gatewayRecords,
        storageRoot: storageRootForHome,
        preloadedHome,
      })
      : {
        totals: {
          callsTotal: 0,
          callsSucceeded: 0,
          unmeteredCalls: 0,
          unpricedCalls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheHitRatePct: 0,
          cacheSavingsCny: 0,
          costPeakCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
          costOffPeakCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
          costActualCny: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
          costPeakUsd: 0,
          costOffPeakUsd: 0,
          costActualUsd: 0,
        },
        byModel: [],
        sessions: [],
        errors: [],
      };
    const now = new Date();
    const startOfTodayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayDateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let todayCallsTotal = 0;
    let todayCallsSucceeded = 0;
    let todayUnmeteredCalls = 0;
    let todayUnpricedCalls = 0;
    let todayKnownCostCalls = 0;
    let todayCostCny = 0;
    if (hasSessionsDir && Array.isArray(overview.sessions)) {
      for (const sess of overview.sessions) {
        const lastMs = typeof sess?.lastActivityMs === 'number' ? sess.lastActivityMs : sess?.startedAtMs;
        if (typeof lastMs !== 'number' || lastMs < startOfTodayMs) continue;
        const repRes = reportFor(resolvedHome, sess.sessionId, pricing, {
          gatewayRecords: this.gatewayRecords,
          storageRoot: storageRootForHome,
          preloadedHome,
        });
        for (const call of repRes?.report?.calls ?? []) {
          if (typeof call?.timeMs !== 'number' || call.timeMs < startOfTodayMs) continue;
          todayCallsTotal += 1;
          if (call.ok !== false) todayCallsSucceeded += 1;
          if (call.unmetered) {
            todayUnmeteredCalls += 1;
          } else if (call.ok !== false && typeof call.costActualCny === 'number' && Number.isFinite(call.costActualCny)) {
            todayCostCny += call.costActualCny;
            todayKnownCostCalls += 1;
          } else if (call.ok !== false) {
            todayUnpricedCalls += 1;
          }
        }
      }
    }
    const overviewWithToday = {
      ...overview,
      today: {
        dateKey: todayDateKey,
        startOfDayMs: startOfTodayMs,
        callsTotal: todayCallsTotal,
        callsSucceeded: todayCallsSucceeded,
        unmeteredCalls: todayUnmeteredCalls,
        unpricedCalls: todayUnpricedCalls,
        costActualCny: todayCallsSucceeded > 0 && todayKnownCostCalls === 0
          ? null
          : Number(todayCostCny.toFixed(4)),
      },
    };
    return { enabled: true, dshHome: resolvedHome, pricing, pricingCatalog, overview: overviewWithToday };
  }

  async getSessions({ home = null, syncGateway = false, allowExternalOverride = true } = {}) {
    const check = this._guardEnabledAndHealthy();
    if (!check.active) {
      return { enabled: false, sessions: [] };
    }
    const resolvedHome = this.resolveSafeDshHome(home, { allowExternalOverride });
    if (syncGateway) {
      await withBoundedTimeout(this.triggerBackgroundMagpieSync(), 1000);
    }
    if (!fs.existsSync(path.join(resolvedHome, 'sessions'))) {
      return { enabled: true, dshHome: resolvedHome, sessions: [] };
    }
    const sessions = listSessions(resolvedHome, this.getPricing(), {
      gatewayRecords: this.gatewayRecords,
      storageRoot: this._storageRootForHome(resolvedHome),
    });
    return { enabled: true, dshHome: resolvedHome, sessions };
  }

  async getSessionReport({ sessionId, home = null, syncGateway = true, allowExternalOverride = true } = {}) {
    const check = this._guardEnabledAndHealthy();
    if (!check.active) {
      return { enabled: false, report: null };
    }
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId is required');
    }
    const resolvedHome = this.resolveSafeDshHome(home, { allowExternalOverride });
    if (syncGateway) {
      await withBoundedTimeout(this.triggerBackgroundMagpieSync(), 1200);
    }
    const pricing = this.getPricing();
    const res = reportFor(resolvedHome, sessionId, pricing, {
      gatewayRecords: this.gatewayRecords,
      storageRoot: this._storageRootForHome(resolvedHome),
    });
    if (!res) return { enabled: true, report: null, signature: null };
    const customRoutes = this._getCustomRouteKeys();
    return {
      enabled: true,
      dshHome: resolvedHome,
      signature: res.signature,
      report: res.report,
      publicRecords: toPublicLogicalUsageRecords(res.report, pricing, { customRoutes }),
    };
  }
}

function isCustomPriceRoute(matchedRoute, pricing, customRoutes = null) {
  if (!matchedRoute) return false;
  if (customRoutes instanceof Set && customRoutes.has(matchedRoute)) {
    const defEntry = defaultPricing.routes?.[matchedRoute];
    const curEntry = pricing?.routes?.[matchedRoute];
    if (!defEntry) return true;
    return JSON.stringify(curEntry) !== JSON.stringify(defEntry);
  }
  const curEntry = pricing?.routes?.[matchedRoute];
  const defEntry = defaultPricing.routes?.[matchedRoute];
  if (!curEntry) return false;
  if (!defEntry) return true;
  return JSON.stringify(curEntry) !== JSON.stringify(defEntry);
}

/**
 * Convert a Hengzhang `UsageReport` into `lt.public.v1` `LogicalUsageRecord[]`,
 * strictly enforcing `unknown != 0`, 4-bucket cache identity, and logical vs physical attempts separation.
 */
export function toPublicLogicalUsageRecords(report, pricing = defaultPricing, options = {}) {
  if (!report || !Array.isArray(report.calls)) return [];
  const teamId = report.meta?.kind === 'team' ? (report.team?.teamId ?? report.meta?.sessionId ?? null) : null;
  const usdToCny = Number(pricing?.usdToCny) > 0 ? Number(pricing.usdToCny) : 6.71;
  const customRoutes = options?.customRoutes ?? null;

  return report.calls.map(call => {
    const metered = !call.unmetered;
    const costKnown = call.costActualCny !== null && call.costActualCny !== undefined;
    const actualUsd = costKnown ? Number((call.costActualCny / usdToCny).toFixed(6)) : null;

    const sourceKind = call.group === 'governance'
      ? 'lt-governance'
      : (call.gatewayMatched
        ? 'magpie'
        : ((call.hostProvider && call.hostProvider !== 'magpie') || String(call.route || '').includes('@direct')
          ? 'direct'
          : 'dsh-session'));

    const matchedRoute = call.matchedPriceRoute || call.route || '';
    const priceSource = !costKnown
      ? 'unknown'
      : (isCustomPriceRoute(matchedRoute, pricing, customRoutes) ? 'custom' : 'catalog');

    const reasoningTokens =
      metered && Number.isInteger(call.reasoningTokens) && call.reasoningTokens >= 0
        ? Math.min(call.reasoningTokens, call.outputTokens ?? call.reasoningTokens)
        : null;

    return {
      logicalRequestId: `${report.meta?.sessionId ?? 'sess'}:n${call.n}:${call.responseId || call.step}`,
      timestampMs: call.timeMs ?? 0,
      status: call.ok ? 'ok' : 'error',
      requestedRoute: call.route || 'unknown',
      actualProvider: call.actualProvider || 'unknown',
      actualModel: call.actualModel || 'unknown',
      sourceKind,
      physicalAttemptCount: Number.isInteger(call.physicalAttempts) ? call.physicalAttempts : null,
      latencyMs: Number.isFinite(call.latencyMs) ? call.latencyMs : null,
      ttftMs: Number.isFinite(call.ttftMs) ? call.ttftMs : null,
      metered,
      tokens: {
        uncachedInputTokens: metered ? call.inputTokens : null,
        cacheReadTokens: metered ? call.cacheReadTokens : null,
        cacheWriteTokens: metered ? call.cacheWriteTokens : null,
        outputTokens: metered ? call.outputTokens : null,
        reasoningTokens,
        totalTokens: metered ? call.totalTokens : null,
      },
      cost: {
        known: costKnown,
        currency: costKnown ? 'CNY' : null,
        actualCny: costKnown ? Number(call.costActualCny.toFixed(6)) : null,
        peakCny: costKnown && call.costPeakCny != null ? Number(call.costPeakCny.toFixed(6)) : null,
        offPeakCny: costKnown && call.costOffPeakCny != null ? Number(call.costOffPeakCny.toFixed(6)) : null,
        actualUsd,
        priceSource,
      },
      attribution: {
        sessionId: call.sessionId ?? null,
        teamId,
        taskSeq: call.taskSeq ?? null,
        stageId: call.stageId ?? null,
        group: call.group || 'unknown',
        role: call.role ?? null,
        actorName: call.actor ?? null,
        degraded: Boolean(call.degraded),
      },
    };
  });
}

const BRIDGE_CACHE = new Map();

export function getOrCreateHengzhangBridge(storageRoot, options = {}) {
  const key = path.resolve(storageRoot);
  let bridge = BRIDGE_CACHE.get(key);
  if (!bridge) {
    bridge = new HengzhangUsageBridge({ storageRoot: key, ...options });
    BRIDGE_CACHE.set(key, bridge);
  } else if (options && typeof options === 'object') {
    if (options.fetchImpl) bridge.fetchImpl = options.fetchImpl;
    if (options.dshHome) bridge.explicitDshHome = path.resolve(options.dshHome);
    if (options.gatewayManager) bridge.gatewayManager = options.gatewayManager;
  }
  return bridge;
}
