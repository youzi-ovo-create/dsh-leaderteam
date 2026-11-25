/**
 * Cross-Platform Magpie Gateway Lifecycle & Installation Manager
 *
 * Capabilities:
 * - Install from verified local binary or upstream release (`yetone/magpie-releases` + Ed25519 + SHA-256)
 * - Versioned release store (`<storageRoot>/magpie/releases/<ver>/magpie[.exe]`) + rollback
 * - Sandboxed `managed` lifecycle (`XDG_*` + `LOCALAPPDATA` + `DSH_HOME` + `HOME` isolation so `KeepDshWired`
 *   and subscription sign-in never mutate the user's real `~/.dsh` or `$HOME` or conflict with system `magpie-vps.service`)
 * - Cross-process PID persistence (`<storageRoot>/magpie/runtime/managed-pid.json`) with strict binary/cmdline ownership verification
 * - `external` mode for attaching to an already-running local/system Magpie
 * - Automatic crash / abnormal-exit recovery with bounded backoff
 * - Isolated `0600` credential storage (`credentials.json`), zero secret exposure in status or stderr payloads
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileAtomic } from '../core/store.mjs';
import { MagpieClient } from './magpie-client.mjs';
import { sanitizeMaskedPreview } from './magpie-adapter.mjs';
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
const MAX_STDERR_LOG_BYTES = 512 * 1024;

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

function scrubSecretText(rawText, creds = null) {
  let out = String(rawText || '');
  out = out.replace(/([?&]k=)[A-Za-z0-9._~-]+/g, '$1[REDACTED]');
  out = out.replace(/(MAGPIE_WEB_KEY=)[^\s"']+/g, '$1[REDACTED]');
  out = out.replace(/(magpie_web_\d+=)[A-Za-z0-9._~-]+/g, '$1[REDACTED]');
  for (const secret of [creds?.managedWebKey, creds?.externalWebKey]) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isPathInsideDir(childPath, parentDir) {
  try {
    const resolvedParent = path.resolve(parentDir);
    const resolvedChild = path.resolve(childPath);
    const rel = path.relative(resolvedParent, resolvedChild);
    return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
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
    keepAliveOnParentExit = false,
  }) {
    if (!storageRoot) throw new Error('MagpieGatewayManager requires storageRoot');
    this.storageRoot = path.resolve(storageRoot);
    this.rootDir = path.join(this.storageRoot, 'magpie');
    this.releasesDir = path.join(this.rootDir, 'releases');
    this.currentPointerFile = path.join(this.rootDir, 'current.json');
    this.stateFile = path.join(this.rootDir, 'gateway-state.json');
    this.credentialsFile = path.join(this.rootDir, 'credentials.json');
    this.runtimeSandboxDir = path.join(this.rootDir, 'runtime');
    this.pidFile = path.join(this.runtimeSandboxDir, 'managed-pid.json');
    this.stderrLogFile = path.join(this.runtimeSandboxDir, 'magpie-stderr.log');
    this.fetchImpl = fetchImpl;
    this.defaultGatewayPort = defaultGatewayPort;
    this.defaultWebPort = defaultWebPort;
    this.keepAliveOnParentExit = Boolean(keepAliveOnParentExit);

    this.child = null;
    this.stopping = false;
    this._lifecycleEpoch = 0;
    this.startingPromise = null;
    this.recoveryTimer = null;
    this.recoveryCount = 0;
    this.recentCrashTimestamps = [];
    this.lastError = null;
    this._exitHook = null;
    this._stoppingPids = new Set();
  }

  _loadConfigState() {
    const saved = readJsonSafe(this.stateFile, null);
    if (saved && typeof saved === 'object') return saved;
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

  _readManagedPidRecord() {
    const rec = readJsonSafe(this.pidFile, null);
    if (!rec || typeof rec !== 'object' || !Number.isInteger(rec.pid) || rec.pid <= 1) {
      return null;
    }
    return rec;
  }

  _writeManagedPidRecord(record) {
    fs.mkdirSync(this.runtimeSandboxDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.pidFile, JSON.stringify(record, null, 2) + '\n');
    if (!IS_WIN) {
      try { fs.chmodSync(this.pidFile, 0o600); } catch {}
    }
  }

  _removeManagedPidRecord(expectedPid = null) {
    try {
      if (expectedPid !== null) {
        const cur = this._readManagedPidRecord();
        if (cur && cur.pid !== expectedPid) return;
      }
      if (fs.existsSync(this.pidFile)) {
        fs.rmSync(this.pidFile, { force: true });
      }
    } catch {}
  }

  /**
   * Synchronously verify via `/proc/<pid>/cmdline` & `/proc/<pid>/exe` (Linux) + `releasesDir` containment
   * whether `saved` belongs strictly to this `MagpieGatewayManager` instance's isolated release binary.
   * Returns `true` (owned), `false` (definitely foreign/dead), or `null` (indeterminate without `/proc`, needs HTTP PID probe).
   */
  _verifyOwnedPidSync(saved) {
    if (!saved || !Number.isInteger(saved.pid) || saved.pid <= 1) return false;
    if (saved.pid === process.pid) return false;
    if (typeof saved.binaryPath !== 'string' || !isPathInsideDir(saved.binaryPath, this.releasesDir)) {
      return false;
    }
    if (!isPidAlive(saved.pid)) return false;

    if (process.platform === 'linux') {
      try {
        const cmdlineBuf = fs.readFileSync(`/proc/${saved.pid}/cmdline`);
        const args = cmdlineBuf.toString('utf8').split('\0').filter(Boolean);
        if (args.length === 0) return false;
        const hasServe = args.includes('serve');
        const hasWebArg = saved.webPort ? args.includes(`--web=127.0.0.1:${saved.webPort}`) : true;
        let exeMatches = false;
        try {
          const procExe = fs.realpathSync(`/proc/${saved.pid}/exe`);
          exeMatches = isPathInsideDir(procExe, this.releasesDir);
        } catch {
          exeMatches = isPathInsideDir(args[0], this.releasesDir);
        }
        return Boolean(hasServe && hasWebArg && exeMatches);
      } catch {
        return false;
      }
    }
    return null;
  }

  async _verifyOwnedPid(saved) {
    const syncVerdict = this._verifyOwnedPidSync(saved);
    if (typeof syncVerdict === 'boolean') return syncVerdict;
    if (!saved?.gatewayPort) return false;
    try {
      const probeClient = new MagpieClient({
        gatewayUrl: `http://127.0.0.1:${saved.gatewayPort}`,
        fetchImpl: this.fetchImpl,
      });
      const h = await probeClient.probeHealth({ timeoutMs: 1000 });
      return Boolean(h.ok && h.pid === saved.pid);
    } catch {
      return false;
    }
  }

  async _isOwnedManagedProcessRunning() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return true;
    const saved = this._readManagedPidRecord();
    if (!saved) return false;
    return this._verifyOwnedPid(saved);
  }

  async _terminateOwnedPid(pid) {
    if (!isPidAlive(pid)) return;
    try {
      process.kill(pid, IS_WIN ? 'SIGTERM' : 'SIGINT');
    } catch {
      return;
    }
    const sigkillDeadline = Date.now() + 2500;
    while (Date.now() < sigkillDeadline) {
      if (!isPidAlive(pid)) return;
      await new Promise(r => setTimeout(r, 40));
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
    const finalDeadline = Date.now() + 500;
    while (Date.now() < finalDeadline && isPidAlive(pid)) {
      await new Promise(r => setTimeout(r, 30));
    }
  }

  _installParentExitCleanup(child) {
    this._removeParentExitCleanup();
    this._exitHook = () => {
      if (this.child === child && child.exitCode === null) {
        try {
          if (IS_WIN) child.kill();
          else child.kill('SIGINT');
        } catch {}
      }
      this._removeManagedPidRecord(child.pid);
    };
    process.once('exit', this._exitHook);
  }

  _removeParentExitCleanup() {
    if (this._exitHook) {
      process.removeListener('exit', this._exitHook);
      this._exitHook = null;
    }
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

  saveExternalGateway({
    id,
    displayName,
    endpointUrl,
    protocol = 'openai-chat',
    apiKey,
    clearKey = false,
    keyOptional = false,
    disabled = false,
  }) {
    const cleanId = String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
    if (!cleanId) throw new Error('External gateway id is required');
    const cfg = this._loadConfigState();
    const creds = this._loadCredentials();
    creds.externalGatewayKeys ??= {};

    let maskedPreview = '';
    if (clearKey === true || apiKey === null) {
      if (Object.hasOwn(creds.externalGatewayKeys, cleanId)) {
        delete creds.externalGatewayKeys[cleanId];
        writeSecretJson(this.credentialsFile, creds);
      }
      maskedPreview = '';
    } else if (typeof apiKey === 'string' && apiKey.trim()) {
      const s = apiKey.trim();
      creds.externalGatewayKeys[cleanId] = s;
      maskedPreview = sanitizeMaskedPreview(s, 'api_key');
      writeSecretJson(this.credentialsFile, creds);
    } else if (creds.externalGatewayKeys[cleanId]) {
      maskedPreview = sanitizeMaskedPreview(creds.externalGatewayKeys[cleanId], 'api_key');
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
      maskedPreview,
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
   * Roll back to the previously installed Magpie version and restart if currently running (in-process or cross-process).
   */
  async rollback({ keepAliveOnParentExit } = {}) {
    const ptr = this._loadReleasePointer();
    if (!ptr?.previousVersion) {
      throw new Error('No previous Magpie version available to roll back to');
    }
    const prevBin = path.join(this.releasesDir, ptr.previousVersion, BIN_NAME);
    if (!fs.existsSync(prevBin)) {
      throw new Error(`Previous Magpie binary missing on disk: ${prevBin}`);
    }
    const wasInProcessChild = Boolean(this.child && this.child.exitCode === null);
    const wasRunning = wasInProcessChild || (await this._isOwnedManagedProcessRunning());
    const shouldKeepAlive = typeof keepAliveOnParentExit === 'boolean'
      ? keepAliveOnParentExit
      : (wasRunning && !wasInProcessChild ? true : this.keepAliveOnParentExit);

    if (wasRunning) await this.stop();
    const sha256 = computeFileSha256(prevBin);
    const nextPtr = this._saveReleasePointer({
      currentVersion: ptr.previousVersion,
      previousVersion: ptr.currentVersion,
      sha256,
      installedAt: new Date().toISOString(),
      source: 'rollback',
    });
    if (wasRunning) {
      await this.start({ keepAliveOnParentExit: shouldKeepAlive });
    }
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
      // Sync `settings.json` immediately so already-created sandboxes reflect the change (`GW-04`)
      const settingsFile = path.join(this.runtimeSandboxDir, 'config', 'magpie', 'settings.json');
      if (fs.existsSync(settingsFile)) {
        const curSettings = readJsonSafe(settingsFile, {}) || {};
        writeFileAtomic(
          settingsFile,
          JSON.stringify({ ...curSettings, noAccountDiscovery: !next.allowLocalAccountDiscovery }, null, 2) + '\n',
        );
      }
    }
    if (patch.externalWebKey !== undefined) {
      const creds = this._loadCredentials();
      creds.externalWebKey = typeof patch.externalWebKey === 'string' && patch.externalWebKey.trim()
        ? patch.externalWebKey.trim()
        : null;
      writeSecretJson(this.credentialsFile, creds);
    }

    // Stop active managed child if switching away from `managed` or changing managed ports (`GW-05`)
    const leavingManaged = cur.mode === 'managed' && next.mode !== 'managed';
    const changingManagedPorts =
      next.mode === 'managed' &&
      (next.gatewayPort !== cur.gatewayPort || next.webPort !== cur.webPort);
    if (leavingManaged || changingManagedPorts) {
      this._stopManagedProcessesImmediateSync();
    }

    return this._saveConfigState(next);
  }

  _stopManagedProcessesImmediateSync() {
    this._lifecycleEpoch += 1;
    this.stopping = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this._removeParentExitCleanup();
    const proc = this.child;
    this.child = null;
    if (proc && proc.exitCode === null) {
      const childPid = proc.pid;
      if (Number.isInteger(childPid) && childPid > 1) {
        this._stoppingPids.add(childPid);
      }
      try {
        if (IS_WIN) proc.kill();
        else proc.kill('SIGINT');
      } catch {}
      const fallback = setTimeout(() => {
        if (proc.exitCode === null) {
          try { proc.kill('SIGKILL'); } catch {}
        }
        if (childPid && !isPidAlive(childPid)) {
          this._stoppingPids.delete(childPid);
        }
      }, 2000);
      fallback.unref?.();
      proc.once('exit', () => {
        clearTimeout(fallback);
        if (childPid) this._stoppingPids.delete(childPid);
      });
    }
    const saved = this._readManagedPidRecord();
    if (saved && saved.pid !== proc?.pid) {
      const owned = this._verifyOwnedPidSync(saved);
      if (owned === true) {
        if (isPidAlive(saved.pid)) {
          this._stoppingPids.add(saved.pid);
        }
        try {
          process.kill(saved.pid, IS_WIN ? 'SIGTERM' : 'SIGINT');
        } catch {}
        const fallback = setTimeout(() => {
          if (isPidAlive(saved.pid)) {
            try { process.kill(saved.pid, 'SIGKILL'); } catch {}
          }
          if (!isPidAlive(saved.pid)) {
            this._stoppingPids.delete(saved.pid);
          }
        }, 2000);
        fallback.unref?.();
      }
    }
    this._removeManagedPidRecord();
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
    const existing = readJsonSafe(settingsFile, null);
    const hasExistingBool = existing && typeof existing === 'object' && typeof existing.noAccountDiscovery === 'boolean';
    const nextSettings = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      gatewayMode: 'on',
      noAccountDiscovery: cfg.allowLocalAccountDiscovery
        ? false
        : (hasExistingBool ? existing.noAccountDiscovery : true),
      noAutoUpdate: true,
      noStats: true,
    };
    writeFileAtomic(settingsFile, JSON.stringify(nextSettings, null, 2) + '\n');
    return { configHome, cacheHome, stateHome, localAppData, sandboxDsh, sandboxHome };
  }

  async start({ allocateDynamicPortsIfBusy = false, keepAliveOnParentExit } = {}) {
    if (this.startingPromise) return this.startingPromise;
    const myEpoch = ++this._lifecycleEpoch;
    this.stopping = false;
    const effectiveKeepAlive = typeof keepAliveOnParentExit === 'boolean'
      ? keepAliveOnParentExit
      : this.keepAliveOnParentExit;
    this.startingPromise = this._startImpl({
      allocateDynamicPortsIfBusy,
      keepAliveOnParentExit: effectiveKeepAlive,
      myEpoch,
    }).finally(() => {
      this.startingPromise = null;
    });
    return this.startingPromise;
  }

  async _startImpl({ allocateDynamicPortsIfBusy = false, keepAliveOnParentExit = false, myEpoch }) {
    const ensureNotAborted = () => {
      if (this.stopping || this._lifecycleEpoch !== myEpoch) {
        const err = new Error('Magpie start aborted by concurrent stop or reconfigure');
        err.code = 'MAGPIE_START_ABORTED';
        throw err;
      }
    };

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    // S3-UIGW-06: Wait briefly (up to 1500ms) for any synchronously signaled managed PIDs to release ports
    if (this._stoppingPids.size > 0) {
      const waitDeadline = Date.now() + 1500;
      while (this._stoppingPids.size > 0 && Date.now() < waitDeadline) {
        for (const pid of [...this._stoppingPids]) {
          if (!isPidAlive(pid)) {
            this._stoppingPids.delete(pid);
          }
        }
        if (this._stoppingPids.size === 0) break;
        await new Promise(r => setTimeout(r, 25));
        ensureNotAborted();
      }
      for (const pid of [...this._stoppingPids]) {
        if (isPidAlive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        } else {
          this._stoppingPids.delete(pid);
        }
      }
      if (this._stoppingPids.size > 0) {
        const killDeadline = Date.now() + 150;
        while (this._stoppingPids.size > 0 && Date.now() < killDeadline) {
          for (const pid of [...this._stoppingPids]) {
            if (!isPidAlive(pid)) this._stoppingPids.delete(pid);
          }
          if (this._stoppingPids.size === 0) break;
          await new Promise(r => setTimeout(r, 20));
          ensureNotAborted();
        }
        this._stoppingPids.clear();
      }
    }

    const cfg = this._loadConfigState();
    if (cfg.mode !== 'managed') {
      cfg.mode = 'managed';
      this._saveConfigState(cfg);
    }

    // 1. Already running in-process and healthy on current ports?
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      try {
        const health = await this.createClient().probeHealth({ timeoutMs: 1500 });
        ensureNotAborted();
        if (health.ok && (!health.pid || health.pid === this.child.pid)) {
          return this.getStatus();
        }
      } catch {}
    }

    // 2. Already running cross-process (`managed-pid.json`) on current ports?
    const existingPidRec = this._readManagedPidRecord();
    if (existingPidRec) {
      const owned = await this._verifyOwnedPid(existingPidRec);
      ensureNotAborted();
      if (owned) {
        const samePorts =
          existingPidRec.gatewayPort === (cfg.gatewayPort || this.defaultGatewayPort) &&
          existingPidRec.webPort === (cfg.webPort || this.defaultWebPort);
        if (samePorts) {
          try {
            const health = await this.createClient().probeHealth({ timeoutMs: 1500 });
            ensureNotAborted();
            if (health.ok && (!health.pid || health.pid === existingPidRec.pid)) {
              return this.getStatus();
            }
          } catch {}
        }
        // Owned process on stale ports or unhealthy -> terminate cleanly before respawning
        await this._terminateOwnedPid(existingPidRec.pid);
        this._removeManagedPidRecord(existingPidRec.pid);
        ensureNotAborted();
      } else {
        this._removeManagedPidRecord(existingPidRec.pid);
      }
    }

    // 3. Auto-install from local binary if not yet installed in `<storageRoot>/magpie/releases`
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
      ensureNotAborted();
      resolved = this.resolveManagedBinaryPath();
    }

    let gwPort = cfg.gatewayPort || this.defaultGatewayPort;
    let webPort = cfg.webPort || this.defaultWebPort;
    const maxBindAttempts = allocateDynamicPortsIfBusy ? 3 : 1;

    for (let bindAttempt = 0; bindAttempt < maxBindAttempts; bindAttempt++) {
      ensureNotAborted();
      if (bindAttempt > 0) {
        gwPort = await findFreeLoopbackPort();
        webPort = await findFreeLoopbackPort();
        while (webPort === gwPort) {
          webPort = await findFreeLoopbackPort();
        }
        ensureNotAborted();
        cfg.gatewayPort = gwPort;
        cfg.webPort = webPort;
        this._saveConfigState(cfg);
      } else {
        if (await isPortInUse(gwPort)) {
          ensureNotAborted();
          if (allocateDynamicPortsIfBusy) {
            gwPort = await findFreeLoopbackPort();
            ensureNotAborted();
            cfg.gatewayPort = gwPort;
            this._saveConfigState(cfg);
          } else {
            throw new Error(`Managed Magpie gateway port 127.0.0.1:${gwPort} is already in use`);
          }
        }
        if (await isPortInUse(webPort) || webPort === gwPort) {
          ensureNotAborted();
          if (allocateDynamicPortsIfBusy) {
            webPort = await findFreeLoopbackPort();
            while (webPort === gwPort) {
              webPort = await findFreeLoopbackPort();
            }
            ensureNotAborted();
            cfg.webPort = webPort;
            this._saveConfigState(cfg);
          } else {
            throw new Error(`Managed Magpie web port 127.0.0.1:${webPort} is already in use`);
          }
        }
      }

      ensureNotAborted();
      const creds = this._loadCredentials();
      const dirs = this._prepareRuntimeSandbox(cfg);

      // Note on `MAGPIE_NO_ACCOUNTS`: we clear `MAGPIE_NO_ACCOUNTS: ''` and control discovery via
      // `settings.json` (`noAccountDiscovery: true` by default) + strict `HOME: dirs.sandboxHome` isolation!
      // That keeps host accounts 100% unread while allowing explicit OAuth sign-in inside `sandboxHome` (`GW-04`).
      const childEnv = {
        ...process.env,
        MAGPIE_ADDR: `127.0.0.1:${gwPort}`,
        MAGPIE_WEB_KEY: creds.managedWebKey,
        MAGPIE_DRAIN: '1s',
        MAGPIE_NO_ACCOUNTS: '',
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
          DBUS_SESSION_BUS_ADDRESS: '',
        }),
      };

      let stderrLogFd = null;
      if (keepAliveOnParentExit) {
        try {
          if (fs.existsSync(this.stderrLogFile) && fs.statSync(this.stderrLogFile).size > MAX_STDERR_LOG_BYTES) {
            fs.truncateSync(this.stderrLogFile, 0);
          }
        } catch {}
        stderrLogFd = fs.openSync(this.stderrLogFile, 'a', 0o600);
      }

      let child;
      let startupCompleted = false;
      try {
        child = spawn(resolved.binaryPath, ['serve', `--web=127.0.0.1:${webPort}`], {
          cwd: this.runtimeSandboxDir,
          env: childEnv,
          detached: Boolean(keepAliveOnParentExit),
          stdio: ['ignore', 'ignore', keepAliveOnParentExit ? stderrLogFd : 'pipe'],
          windowsHide: true,
        });
      } finally {
        if (stderrLogFd !== null) {
          try { fs.closeSync(stderrLogFd); } catch {}
        }
      }

      if (child.pid) {
        this._writeManagedPidRecord({
          pid: child.pid,
          binaryPath: resolved.binaryPath,
          gatewayPort: gwPort,
          webPort,
          startedAt: new Date().toISOString(),
        });
      }

      if (!keepAliveOnParentExit) {
        this._installParentExitCleanup(child);
      }

      let stderrTail = '';
      child.stderr?.on('data', chunk => {
        const cleaned = scrubSecretText(chunk.toString('utf8'), creds);
        stderrTail = (stderrTail + cleaned).slice(-2048);
      });

      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this._removeParentExitCleanup();
        }
        this._removeManagedPidRecord(child.pid);
        if (!this.stopping) {
          let logHint = stderrTail.trim();
          if (!logHint && keepAliveOnParentExit) {
            try {
              const raw = fs.readFileSync(this.stderrLogFile, 'utf8');
              logHint = scrubSecretText(raw.slice(-1024), creds).trim();
            } catch {}
          }
          const tailLine = logHint ? `: ${logHint.split('\n').at(-1)}` : '';
          this.lastError = {
            code: 'MAGPIE_EXITED',
            message: scrubSecretText(
              `Magpie exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})${tailLine}`,
              creds,
            ),
            at: new Date().toISOString(),
          };
          if (startupCompleted && !keepAliveOnParentExit) {
            this._maybeScheduleAutoRecovery();
          }
        }
      });

      this.child = child;

      // Wait up to 8s for readiness probe on `127.0.0.1:<gwPort>/` verifying PID identity (`GW-05`)
      const client = this.createClient();
      const deadline = Date.now() + 8000;
      let retryPortConflict = false;

      while (Date.now() < deadline) {
        if (this.stopping || this._lifecycleEpoch !== myEpoch) {
          await this._killChildRef(child);
          const err = new Error('Magpie start aborted by concurrent stop');
          err.code = 'MAGPIE_START_ABORTED';
          throw err;
        }
        if (!this.child || this.child.exitCode !== null) {
          const exitMsg = this.lastError?.message || 'Magpie exited during startup';
          if (allocateDynamicPortsIfBusy && bindAttempt + 1 < maxBindAttempts && /address already in use|bind:/i.test(exitMsg)) {
            retryPortConflict = true;
            break;
          }
          throw new Error(exitMsg);
        }
        try {
          const h = await client.probeHealth({ timeoutMs: 800 });
          if (h.ok) {
            if (h.pid && child.pid && h.pid !== child.pid) {
              await this._killChildRef(child);
              if (allocateDynamicPortsIfBusy && bindAttempt + 1 < maxBindAttempts) {
                retryPortConflict = true;
                break;
              }
              throw new Error(`Managed Magpie gateway port 127.0.0.1:${gwPort} was bound by another Magpie process (pid=${h.pid})`);
            }
            startupCompleted = true;
            this.lastError = null;
            if (keepAliveOnParentExit) {
              child.unref?.();
            }
            return this.getStatus();
          }
        } catch (probeErr) {
          if (String(probeErr?.message || '').includes('bound by another Magpie process')) {
            throw probeErr;
          }
        }
        await new Promise(r => setTimeout(r, 120));
      }

      if (retryPortConflict) {
        continue;
      }

      await this._killChildRef(child);
      throw new Error(`Timed out waiting for Magpie gateway readiness on 127.0.0.1:${gwPort}`);
    }

    throw new Error('Failed to bind free loopback ports for managed Magpie gateway');
  }

  async _killChildRef(proc) {
    if (!proc) return;
    if (proc.exitCode !== null) {
      this._removeManagedPidRecord(proc.pid);
      return;
    }
    await new Promise(resolve => {
      let settled = false;
      let killTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        resolve();
      };
      proc.once('exit', finish);
      try {
        if (IS_WIN) proc.kill();
        else proc.kill('SIGINT');
      } catch {
        finish();
        return;
      }
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        finish();
      }, 2500);
      killTimer.unref?.();
    });
    if (this.child === proc) {
      this.child = null;
      this._removeParentExitCleanup();
    }
    this._removeManagedPidRecord(proc.pid);
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
        const creds = readJsonSafe(this.credentialsFile, null);
        this.lastError = {
          code: 'MAGPIE_RECOVERY_FAILED',
          message: scrubSecretText(err instanceof Error ? err.message : String(err), creds),
          at: new Date().toISOString(),
        };
      });
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  async stop() {
    this._lifecycleEpoch += 1;
    this.stopping = true;
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (this.startingPromise) {
      await this.startingPromise.catch(() => {});
    }

    const proc = this.child;
    if (proc) {
      await this._killChildRef(proc);
    }

    // Cross-process stop via `managed-pid.json` with strict ownership verification (`GW-03`)
    const saved = this._readManagedPidRecord();
    if (saved) {
      const owned = await this._verifyOwnedPid(saved);
      if (owned) {
        await this._terminateOwnedPid(saved.pid);
      }
      this._removeManagedPidRecord(saved.pid);
    }

    this._removeParentExitCleanup();
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
    const creds = this._loadCredentials();
    const ep = this.getActiveEndpoints();
    const resolved = this.resolveManagedBinaryPath();
    const ptr = resolved.pointer;
    const safeLastError = this.lastError
      ? {
        ...this.lastError,
        message: scrubSecretText(this.lastError.message, creds),
      }
      : null;

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
        lastError: safeLastError,
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
      } else if (safeLastError) {
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
      lastError: safeLastError,
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
  } else if (options && typeof options === 'object') {
    if (options.fetchImpl) mgr.fetchImpl = options.fetchImpl;
    if (Number.isInteger(options.defaultGatewayPort) && options.defaultGatewayPort > 0) {
      mgr.defaultGatewayPort = options.defaultGatewayPort;
    }
    if (Number.isInteger(options.defaultWebPort) && options.defaultWebPort > 0) {
      mgr.defaultWebPort = options.defaultWebPort;
    }
    if (typeof options.keepAliveOnParentExit === 'boolean') {
      mgr.keepAliveOnParentExit = options.keepAliveOnParentExit;
    }
  }
  return mgr;
}
