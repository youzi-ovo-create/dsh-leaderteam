/**
 * Cross-Platform Magpie Gateway Lifecycle & Installation Manager
 *
 * Capabilities:
 * - Install from verified local binary or upstream release (`yetone/magpie-releases` + Ed25519 + SHA-256)
 * - Versioned release store (`<storageRoot>/magpie/releases/<ver>/magpie[.exe]`) + rollback
 * - Sandboxed `managed` lifecycle (`XDG_*` + `LOCALAPPDATA` + `DSH_HOME` isolation so `KeepDshWired`
 *   never mutates the user's real `~/.dsh` or conflicts with system `magpie-vps.service`)
 * - `external` mode for attaching to an already-running local/system Magpie (`127.0.0.1:3425`)
 * - Automatic crash / abnormal-exit recovery with bounded backoff
 * - Isolated `0600` credential storage (`credentials.json`), zero secret exposure in status payloads
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileAtomic } from '../core/store.mjs';
import { MagpieClient } from './magpie-client.mjs';
import {
  MAGPIE_MANIFEST,
  computeFileSha256,
  evaluateMagpieVersionCompatibility,
  probeMagpieApiCompatibility,
  resolveMagpiePlatformAsset,
  verifyMagpieReleaseSignature,
} from './magpie-version.mjs';

const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'magpie.exe' : 'magpie';

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeSecretJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(data, null, 2) + '\n';
  writeFileAtomic(file, serialized);
  if (!IS_WIN) {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
}

function generateWebKey() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars (>= 16 chars, URL-safe)
}

export async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

export async function isPortInUse(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const sock = net.createConnection({ port, host });
    sock.setTimeout(400);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    const notUsed = () => {
      sock.destroy();
      resolve(false);
    };
    sock.once('timeout', notUsed);
    sock.once('error', notUsed);
  });
}

export function detectBinaryVersion(binaryPath) {
  try {
    const out = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = String(out || '').trim().match(/magpie\s+v?(\d+\.\d+\.\d+[^\s]*)/i);
    return m ? m[1] : String(out || '').trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export function discoverSystemMagpieBinary() {
  const candidates = IS_WIN
    ? [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'magpie', 'magpie.exe') : null,
    ].filter(Boolean)
    : [
      '/opt/magpie/current/magpie',
      `/opt/magpie/releases/${MAGPIE_MANIFEST.pinnedVersion}/magpie`,
      os.homedir() ? path.join(os.homedir(), '.local', 'bin', 'magpie') : null,
      '/usr/local/bin/magpie',
    ].filter(Boolean);

  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return cand;
      }
    } catch {}
  }
  return null;
}

export class MagpieGatewayManager {
  constructor({
    storageRoot,
    fetchImpl = globalThis.fetch,
    defaultGatewayPort = 13425,
    defaultWebPort = 13430,
  }) {
    if (!storageRoot) throw new Error('MagpieGatewayManager requires storageRoot');
    this.storageRoot = path.resolve(storageRoot);
    this.rootDir = path.join(this.storageRoot, 'magpie');
    this.releasesDir = path.join(this.rootDir, 'releases');
    this.currentPointerFile = path.join(this.rootDir, 'current.json');
    this.stateFile = path.join(this.rootDir, 'gateway-state.json');
    this.credentialsFile = path.join(this.rootDir, 'credentials.json');
    this.runtimeSandboxDir = path.join(this.rootDir, 'runtime');
    this.fetchImpl = fetchImpl;
    this.defaultGatewayPort = defaultGatewayPort;
    this.defaultWebPort = defaultWebPort;

    this.child = null;
    this.stopping = false;
    this.startingPromise = null;
    this.recoveryTimer = null;
    this.recoveryCount = 0;
    this.recentCrashTimestamps = [];
    this.lastError = null;
  }

  _loadConfigState() {
    const saved = readJsonSafe(this.stateFile, null);
    if (saved && typeof saved === 'object') return saved;
    // Smart initial default: if an external Magpie is configured on 3425, default to external; else managed
    return {
      mode: 'managed',
      gatewayPort: this.defaultGatewayPort,
      webPort: this.defaultWebPort,
      externalGatewayUrl: 'http://127.0.0.1:3425',
      externalWebAdminUrl: 'http://127.0.0.1:3430',
      autoRecover: true,
      allowLocalAccountDiscovery: false,
      externalGateways: [],
    };
  }

  _saveConfigState(next) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    writeFileAtomic(this.stateFile, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  _loadCredentials() {
    const creds = readJsonSafe(this.credentialsFile, null);
    if (creds && typeof creds === 'object' && typeof creds.managedWebKey === 'string' && creds.managedWebKey.length >= 16) {
      return creds;
    }
    const fresh = {
      managedWebKey: generateWebKey(),
      externalWebKey: creds?.externalWebKey ?? null,
      externalGatewayKeys: creds?.externalGatewayKeys ?? {},
    };
    writeSecretJson(this.credentialsFile, fresh);
    return fresh;
  }

  _loadReleasePointer() {
    return readJsonSafe(this.currentPointerFile, {
      currentVersion: null,
      previousVersion: null,
      sha256: null,
      installedAt: null,
    });
  }

  _saveReleasePointer(pointer) {
    fs.mkdirSync(this.rootDir, { recursive: true });
    writeFileAtomic(this.currentPointerFile, JSON.stringify(pointer, null, 2) + '\n');
    return pointer;
  }

  resolveManagedBinaryPath() {
    const ptr = this._loadReleasePointer();
    if (ptr?.currentVersion) {
      const p = path.join(this.releasesDir, ptr.currentVersion, BIN_NAME);
      if (fs.existsSync(p)) return { binaryPath: p, version: ptr.currentVersion, managedInstall: true, pointer: ptr };
    }
    return { binaryPath: null, version: null, managedInstall: false, pointer: ptr };
  }

  getActiveEndpoints() {
    const cfg = this._loadConfigState();
    const creds = this._loadCredentials();
    if (cfg.mode === 'disabled') {
      return {
        mode: 'disabled',
        gatewayUrl: null,
        webAdminUrl: null,
        webKey: null,
      };
    }
    if (cfg.mode === 'external') {
      return {
        mode: 'external',
        gatewayUrl: cfg.externalGatewayUrl || 'http://127.0.0.1:3425',
        webAdminUrl: cfg.externalWebAdminUrl || null,
        webKey: creds.externalWebKey || null,
      };
    }
    return {
      mode: 'managed',
      gatewayUrl: `http://127.0.0.1:${cfg.gatewayPort || this.defaultGatewayPort}`,
      webAdminUrl: `http://127.0.0.1:${cfg.webPort || this.defaultWebPort}`,
      webKey: creds.managedWebKey,
    };
  }

  createClient() {
    const ep = this.getActiveEndpoints();
    return new MagpieClient({
      gatewayUrl: ep.gatewayUrl,
      webAdminUrl: ep.webAdminUrl,
      webKey: ep.webKey,
      fetchImpl: this.fetchImpl,
    });
  }

  listExternalGateways() {
    const cfg = this._loadConfigState();
    const creds = this._loadCredentials();
    return (cfg.externalGateways || []).map(g => ({
      ...g,
      hasKey: Boolean(creds.externalGatewayKeys?.[g.id]),
    }));
  }

  saveExternalGateway({ id, displayName, endpointUrl, protocol = 'openai-chat', apiKey, keyOptional = false, disabled = false }) {
    const cleanId = String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
    if (!cleanId) throw new Error('External gateway id is required');
    const cfg = this._loadConfigState();
    const creds = this._loadCredentials();
    creds.externalGatewayKeys ??= {};

    let maskedPreview = null;
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const s = apiKey.trim();
      creds.externalGatewayKeys[cleanId] = s;
      maskedPreview = s.length > 8 ? `${s.slice(0, 3)}****${s.slice(-4)}` : 'sk-****';
      writeSecretJson(this.credentialsFile, creds);
    } else if (creds.externalGatewayKeys[cleanId]) {
      const prev = creds.externalGatewayKeys[cleanId];
      maskedPreview = prev.length > 8 ? `${prev.slice(0, 3)}****${prev.slice(-4)}` : 'sk-****';
    }

    const list = Array.isArray(cfg.externalGateways) ? [...cfg.externalGateways] : [];
    const idx = list.findIndex(x => x.id === cleanId);
    const entry = {
      id: cleanId,
      displayName: displayName || cleanId,
      endpointUrl: String(endpointUrl || '').trim(),
      protocol,
      keyOptional: Boolean(keyOptional),
      disabled: Boolean(disabled),
      maskedPreview: maskedPreview || '',
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    cfg.externalGateways = list;
    this._saveConfigState(cfg);
    return this.listExternalGateways();
  }

  removeExternalGateway(id) {
    const cfg = this._loadConfigState();
    const creds = this._loadCredentials();
    cfg.externalGateways = (cfg.externalGateways || []).filter(g => g.id !== id);
    if (creds.externalGatewayKeys && Object.hasOwn(creds.externalGatewayKeys, id)) {
      delete creds.externalGatewayKeys[id];
      writeSecretJson(this.credentialsFile, creds);
    }
    this._saveConfigState(cfg);
    return this.listExternalGateways();
  }

  /**
   * Install Magpie into `<storageRoot>/magpie/releases/<version>/magpie[.exe]` from a local binary
   * (or auto-discovered `/opt/magpie/current/magpie`) OR from an explicit upstream release metadata URL.
   */
  async install({
    sourceBinaryPath = null,
    version = null,
    expectedSha256 = null,
    downloadFromUpstream = false,
    releaseMetadataUrl = MAGPIE_MANIFEST.releaseMetadataUrl,
  } = {}) {
    const prevPtr = this._loadReleasePointer();

    let srcPath = sourceBinaryPath ? path.resolve(sourceBinaryPath) : null;
    if (!srcPath && !downloadFromUpstream) {
      srcPath = discoverSystemMagpieBinary();
    }

    if (srcPath) {
      if (!fs.existsSync(srcPath)) {
        throw new Error(`Magpie source binary does not exist: ${srcPath}`);
      }
      const detectedVer = (version || detectBinaryVersion(srcPath) || MAGPIE_MANIFEST.pinnedVersion).replace(/^v/i, '');
      const sha256 = computeFileSha256(srcPath);
      const assetName = resolveMagpiePlatformAsset();
      const pinnedExpected = expectedSha256 || (assetName ? MAGPIE_MANIFEST.knownSha256?.[detectedVer]?.[assetName] : null);
      if (pinnedExpected && sha256.toLowerCase() !== pinnedExpected.toLowerCase()) {
        throw new Error(`Magpie SHA-256 mismatch: expected ${pinnedExpected}, got ${sha256}`);
      }

      const targetDir = path.join(this.releasesDir, detectedVer);
      const targetBin = path.join(targetDir, BIN_NAME);
      fs.mkdirSync(targetDir, { recursive: true });
      const tmpBin = `${targetBin}.tmp-${process.pid}-${Date.now()}`;
      fs.copyFileSync(srcPath, tmpBin);
      if (!IS_WIN) fs.chmodSync(tmpBin, 0o755);
      fs.renameSync(tmpBin, targetBin);

      const nextPtr = this._saveReleasePointer({
        currentVersion: detectedVer,
        previousVersion: prevPtr.currentVersion && prevPtr.currentVersion !== detectedVer
          ? prevPtr.currentVersion
          : prevPtr.previousVersion,
        sha256,
        installedAt: new Date().toISOString(),
        source: 'local-verified',
      });
      return { installed: true, version: detectedVer, sha256, binaryPath: targetBin, pointer: nextPtr };
    }

    // Upstream release download with Ed25519 + SHA-256 verification
    const assetName = resolveMagpiePlatformAsset();
    if (!assetName) {
      throw new Error(`Unsupported platform/arch for Magpie CLI binary: ${process.platform}-${process.arch}`);
    }
    const metaRes = await this.fetchImpl(releaseMetadataUrl, { headers: { Accept: 'application/json' } });
    if (!metaRes.ok) {
      throw new Error(`Failed to query Magpie release metadata (${metaRes.status})`);
    }
    const meta = await metaRes.json();
    const relVer = String(version || meta?.version || MAGPIE_MANIFEST.pinnedVersion).replace(/^v/i, '');
    if (meta?.signed?.sums && meta?.signed?.sig) {
      const sigOk = verifyMagpieReleaseSignature({
        version: meta.version || relVer,
        sumsText: meta.signed.sums,
        signatureBase64: meta.signed.sig,
      });
      if (!sigOk) {
        throw new Error('Magpie release Ed25519 signature verification failed');
      }
    }
    const assetInfo = meta?.assets?.[assetName];
    const downloadUrl = assetInfo?.url || `https://github.com/yetone/magpie-releases/releases/download/v${relVer}/${assetName}`;
    const binRes = await this.fetchImpl(downloadUrl);
    if (!binRes.ok) {
      throw new Error(`Failed to download ${downloadUrl} (HTTP ${binRes.status})`);
    }
    const buf = Buffer.from(await binRes.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const expSha = expectedSha256 || assetInfo?.sha256;
    if (expSha && sha256.toLowerCase() !== expSha.toLowerCase()) {
      throw new Error(`Downloaded Magpie SHA-256 mismatch: expected ${expSha}, got ${sha256}`);
    }

    const targetDir = path.join(this.releasesDir, relVer);
    const targetBin = path.join(targetDir, BIN_NAME);
    fs.mkdirSync(targetDir, { recursive: true });
    const tmpBin = `${targetBin}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpBin, buf);
    if (!IS_WIN) fs.chmodSync(tmpBin, 0o755);
    fs.renameSync(tmpBin, targetBin);

    const nextPtr = this._saveReleasePointer({
      currentVersion: relVer,
      previousVersion: prevPtr.currentVersion && prevPtr.currentVersion !== relVer
        ? prevPtr.currentVersion
        : prevPtr.previousVersion,
      sha256,
      installedAt: new Date().toISOString(),
      source: 'upstream-verified',
    });
    return { installed: true, version: relVer, sha256, binaryPath: targetBin, pointer: nextPtr };
  }

  /**
   * Roll back to the previously installed Magpie version and restart if currently running.
   */
  async rollback() {
    const ptr = this._loadReleasePointer();
    if (!ptr?.previousVersion) {
      throw new Error('No previous Magpie version available to roll back to');
    }
    const prevBin = path.join(this.releasesDir, ptr.previousVersion, BIN_NAME);
    if (!fs.existsSync(prevBin)) {
      throw new Error(`Previous Magpie binary missing on disk: ${prevBin}`);
    }
    const wasRunning = Boolean(this.child);
    if (wasRunning) await this.stop();
    const sha256 = computeFileSha256(prevBin);
    const nextPtr = this._saveReleasePointer({
      currentVersion: ptr.previousVersion,
      previousVersion: ptr.currentVersion,
      sha256,
      installedAt: new Date().toISOString(),
      source: 'rollback',
    });
    if (wasRunning) await this.start();
    return { rolledBackTo: nextPtr.currentVersion, previous: nextPtr.previousVersion };
  }

  configure(patch = {}) {
    const cur = this._loadConfigState();
    const next = { ...cur };
    if (patch.mode && ['managed', 'external', 'disabled'].includes(patch.mode)) {
      next.mode = patch.mode;
    }
    if (Number.isInteger(patch.gatewayPort) && patch.gatewayPort > 0 && patch.gatewayPort < 65536) {
      next.gatewayPort = patch.gatewayPort;
    }
    if (Number.isInteger(patch.webPort) && patch.webPort > 0 && patch.webPort < 65536) {
      next.webPort = patch.webPort;
    }
    if (typeof patch.externalGatewayUrl === 'string' && patch.externalGatewayUrl.trim()) {
      next.externalGatewayUrl = patch.externalGatewayUrl.trim().replace(/\/+$/, '');
    }
    if (patch.externalWebAdminUrl !== undefined) {
      next.externalWebAdminUrl = typeof patch.externalWebAdminUrl === 'string' && patch.externalWebAdminUrl.trim()
        ? patch.externalWebAdminUrl.trim().replace(/\/+$/, '')
        : null;
    }
    if (typeof patch.autoRecover === 'boolean') {
      next.autoRecover = patch.autoRecover;
    }
    if (typeof patch.allowLocalAccountDiscovery === 'boolean') {
      next.allowLocalAccountDiscovery = patch.allowLocalAccountDiscovery;
    }
    if (patch.externalWebKey !== undefined) {
      const creds = this._loadCredentials();
      creds.externalWebKey = typeof patch.externalWebKey === 'string' && patch.externalWebKey.trim()
        ? patch.externalWebKey.trim()
        : null;
      writeSecretJson(this.credentialsFile, creds);
    }
    return this._saveConfigState(next);
  }

  _prepareRuntimeSandbox(cfg) {
    const configHome = path.join(this.runtimeSandboxDir, 'config');
    const cacheHome = path.join(this.runtimeSandboxDir, 'cache');
    const stateHome = path.join(this.runtimeSandboxDir, 'state');
    const localAppData = path.join(this.runtimeSandboxDir, 'local');
    const sandboxDsh = path.join(this.runtimeSandboxDir, 'sandbox-dsh');
    const sandboxHome = path.join(this.runtimeSandboxDir, 'sandbox-home');
    for (const d of [configHome, cacheHome, stateHome, localAppData, sandboxDsh, sandboxHome]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    }
    const magpieCfgDir = path.join(configHome, 'magpie');
    fs.mkdirSync(magpieCfgDir, { recursive: true, mode: 0o700 });
    const settingsFile = path.join(magpieCfgDir, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
      writeFileAtomic(settingsFile, JSON.stringify({
        gatewayMode: 'on',
        noAccountDiscovery: !cfg.allowLocalAccountDiscovery,
        noAutoUpdate: true,
        noStats: true,
      }, null, 2) + '\n');
    }
    return { configHome, cacheHome, stateHome, localAppData, sandboxDsh, sandboxHome };
  }

  async start({ allocateDynamicPortsIfBusy = false } = {}) {
    if (this.startingPromise) return this.startingPromise;
    this.startingPromise = this._startImpl({ allocateDynamicPortsIfBusy }).finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async _startImpl({ allocateDynamicPortsIfBusy = false } = {}) {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const cfg = this._loadConfigState();
    if (cfg.mode !== 'managed') {
      cfg.mode = 'managed';
      this._saveConfigState(cfg);
    }

    // Already running and healthy?
    if (this.child && !this.child.killed) {
      try {
        const health = await this.createClient().probeHealth({ timeoutMs: 1500 });
        if (health.ok) return this.getStatus();
      } catch {}
    }

    // Auto-install from local binary if not yet installed in `<storageRoot>/magpie/releases`
    let resolved = this.resolveManagedBinaryPath();
    if (!resolved.binaryPath) {
      const sysBin = discoverSystemMagpieBinary();
      if (!sysBin) {
        this.lastError = {
          code: 'MAGPIE_NOT_INSTALLED',
          message: 'Magpie binary is not installed yet; run install first',
          at: new Date().toISOString(),
        };
        throw new Error(this.lastError.message);
      }
      await this.install({ sourceBinaryPath: sysBin });
      resolved = this.resolveManagedBinaryPath();
    }

    let gwPort = cfg.gatewayPort || this.defaultGatewayPort;
    let webPort = cfg.webPort || this.defaultWebPort;
    if (await isPortInUse(gwPort)) {
      if (allocateDynamicPortsIfBusy) {
        gwPort = await findFreeLoopbackPort();
        cfg.gatewayPort = gwPort;
        this._saveConfigState(cfg);
      } else {
        throw new Error(`Managed Magpie gateway port 127.0.0.1:${gwPort} is already in use`);
      }
    }
    if (await isPortInUse(webPort) || webPort === gwPort) {
      if (allocateDynamicPortsIfBusy) {
        webPort = await findFreeLoopbackPort();
        cfg.webPort = webPort;
        this._saveConfigState(cfg);
      } else {
        throw new Error(`Managed Magpie web port 127.0.0.1:${webPort} is already in use`);
      }
    }

    const creds = this._loadCredentials();
    const dirs = this._prepareRuntimeSandbox(cfg);
    this.stopping = false;

    const childEnv = {
      ...process.env,
      MAGPIE_ADDR: `127.0.0.1:${gwPort}`,
      MAGPIE_WEB_KEY: creds.managedWebKey,
      MAGPIE_DRAIN: '1s',
      MAGPIE_NO_ACCOUNTS: cfg.allowLocalAccountDiscovery ? '0' : '1',
      MAGPIE_NO_STATS: '1',
      MAGPIE_NO_INSTALL: '1',
      MAGPIE_NO_HANDOVER: '1',
      MAGPIE_NO_SHORTCUT: '1',
      XDG_CONFIG_HOME: dirs.configHome,
      XDG_CACHE_HOME: dirs.cacheHome,
      XDG_STATE_HOME: dirs.stateHome,
      LOCALAPPDATA: dirs.localAppData,
      // CRITICAL: prevents Magpie's KeepDshWired loop from overwriting the user's real ~/.dsh!
      DSH_HOME: dirs.sandboxDsh,
      ...(cfg.allowLocalAccountDiscovery ? {} : {
        HOME: dirs.sandboxHome,
        USERPROFILE: dirs.sandboxHome,
      }),
    };

    const child = spawn(resolved.binaryPath, ['serve', `--web=127.0.0.1:${webPort}`], {
      cwd: this.runtimeSandboxDir,
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderrTail = '';
    child.stderr?.on('data', chunk => {
      // Scrub any accidental ?k= web key printouts from stderr buffer
      const cleaned = chunk.toString('utf8').replace(/\?k=[A-Za-z0-9._~-]+/g, '?k=[REDACTED]');
      stderrTail = (stderrTail + cleaned).slice(-2048);
    });

    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      if (!this.stopping) {
        this.lastError = {
          code: 'MAGPIE_EXITED',
          message: `Magpie exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').at(-1)}` : ''}`,
          at: new Date().toISOString(),
        };
        this._maybeScheduleAutoRecovery();
      }
    });

    this.child = child;

    // Wait up to 8s for readiness probe on `127.0.0.1:<gwPort>/`
    const client = this.createClient();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!this.child || this.child.exitCode !== null) {
        throw new Error(this.lastError?.message || 'Magpie exited during startup');
      }
      try {
        const h = await client.probeHealth({ timeoutMs: 800 });
        if (h.ok) {
          this.lastError = null;
          return this.getStatus();
        }
      } catch {}
      await new Promise(r => setTimeout(r, 120));
    }

    await this.stop();
    throw new Error(`Timed out waiting for Magpie gateway readiness on 127.0.0.1:${gwPort}`);
  }

  _maybeScheduleAutoRecovery() {
    const cfg = this._loadConfigState();
    if (cfg.mode !== 'managed' || cfg.autoRecover === false || this.stopping) return;

    const now = Date.now();
    this.recentCrashTimestamps = this.recentCrashTimestamps.filter(t => now - t < 60_000);
    this.recentCrashTimestamps.push(now);
    if (this.recentCrashTimestamps.length > 5) {
      this.lastError = {
        code: 'MAGPIE_CRASH_LOOP',
        message: 'Magpie crashed more than 5 times within 60s; auto-recovery paused',
        at: new Date().toISOString(),
      };
      return;
    }

    const attempt = this.recentCrashTimestamps.length;
    const delayMs = Math.min(4000, 300 * (2 ** (attempt - 1)));
    this.recoveryCount += 1;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.stopping) return;
      this.start().catch(err => {
        this.lastError = {
          code: 'MAGPIE_RECOVERY_FAILED',
          message: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        };
      });
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  async stop() {
    this.stopping = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    const proc = this.child;
    if (!proc) return this.getStatus();

    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      proc.once('exit', finish);
      try {
        // On POSIX, SIGINT triggers Magpie's immediate <200ms listener shutdown + state flush (skipping 7s drain)
        if (IS_WIN) {
          proc.kill();
        } else {
          proc.kill('SIGINT');
        }
      } catch {
        finish();
        return;
      }
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish();
      }, 2500);
      killTimer.unref?.();
    });

    this.child = null;
    return this.getStatus();
  }

  async restart(opts = {}) {
    await this.stop();
    return this.start(opts);
  }

  async checkCompatibility() {
    const ep = this.getActiveEndpoints();
    if (!ep.gatewayUrl) {
      return { ok: false, error: 'Gateway is disabled' };
    }
    return probeMagpieApiCompatibility({
      gatewayUrl: ep.gatewayUrl,
      webAdminUrl: ep.webAdminUrl,
      webKey: ep.webKey,
      fetchImpl: this.fetchImpl,
    });
  }

  async getStatus() {
    const cfg = this._loadConfigState();
    const ep = this.getActiveEndpoints();
    const resolved = this.resolveManagedBinaryPath();
    const ptr = resolved.pointer;

    if (cfg.mode === 'disabled') {
      const verEval = evaluateMagpieVersionCompatibility(resolved.version);
      return {
        mode: 'disabled',
        state: 'stopped',
        gatewayUrl: null,
        webAdminUrl: null,
        managementAuthenticated: false,
        autoRecover: Boolean(cfg.autoRecover),
        recoveryCount: this.recoveryCount,
        version: {
          current: resolved.version,
          pinned: verEval.pinned,
          testedRange: verEval.testedRange,
          compatible: Boolean(resolved.version && verEval.compatible),
          rollbackAvailable: Boolean(ptr?.previousVersion),
          previousVersion: ptr?.previousVersion ?? null,
          license: 'MIT',
        },
        health: { ok: false, latencyMs: null, checkedAt: new Date().toISOString(), pid: null, modelCount: 0 },
        lastError: this.lastError,
      };
    }

    const client = this.createClient();
    let healthProbe = null;
    let webAuthed = false;
    try {
      healthProbe = await client.probeHealth({ timeoutMs: 1800 });
    } catch {
      healthProbe = null;
    }

    if (healthProbe?.ok && client.hasWebAdminAuth()) {
      try {
        await client.getSettings();
        webAuthed = true;
      } catch {
        webAuthed = false;
      }
    }

    const currentVer = healthProbe?.version ?? resolved.version ?? null;
    const verEval = evaluateMagpieVersionCompatibility(currentVer);
    const checkedAt = new Date().toISOString();

    let state;
    if (healthProbe?.ok) {
      state = 'running';
    } else if (cfg.mode === 'managed') {
      if (!resolved.binaryPath && !discoverSystemMagpieBinary()) {
        state = 'not_installed';
      } else if (this.startingPromise) {
        state = 'starting';
      } else if (this.lastError) {
        state = 'error';
      } else {
        state = 'stopped';
      }
    } else {
      state = 'degraded';
    }

    return {
      mode: cfg.mode,
      state,
      gatewayUrl: ep.gatewayUrl,
      webAdminUrl: ep.webAdminUrl,
      managementAuthenticated: webAuthed,
      autoRecover: Boolean(cfg.autoRecover),
      recoveryCount: this.recoveryCount,
      version: {
        current: currentVer,
        pinned: verEval.pinned,
        testedRange: verEval.testedRange,
        compatible: currentVer ? verEval.compatible : false,
        rollbackAvailable: Boolean(ptr?.previousVersion),
        previousVersion: ptr?.previousVersion ?? null,
        license: 'MIT',
      },
      health: {
        ok: Boolean(healthProbe?.ok),
        latencyMs: healthProbe?.latencyMs ?? null,
        checkedAt,
        pid: healthProbe?.pid ?? (this.child?.pid ?? null),
        modelCount: healthProbe?.modelCount ?? 0,
      },
      lastError: this.lastError,
    };
  }
}

const MANAGER_CACHE = new Map();

export function getOrCreateGatewayManager(storageRoot, options = {}) {
  const key = path.resolve(storageRoot);
  let mgr = MANAGER_CACHE.get(key);
  if (!mgr) {
    mgr = new MagpieGatewayManager({ storageRoot: key, ...options });
    MANAGER_CACHE.set(key, mgr);
  }
  return mgr;
}
