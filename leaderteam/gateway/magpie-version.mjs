/**
 * Magpie Upstream Version Pinning, Cryptographic Integrity Verification,
 * API Compatibility Probe & Patch Tracking Mechanism.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import manifest from './magpie-manifest.json' with { type: 'json' };

export const MAGPIE_MANIFEST = Object.freeze(manifest);

// ASN.1 DER prefix for raw 32-byte Ed25519 SPKI public key (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function parseMagpieVersion(ver) {
  if (typeof ver !== 'string') return null;
  const clean = ver.trim().replace(/^v/i, '');
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareMagpieVersions(a, b) {
  const pa = parseMagpieVersion(a);
  const pb = parseMagpieVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function evaluateMagpieVersionCompatibility(currentVersion) {
  const pinned = manifest.pinnedVersion;
  const minVer = manifest.testedMinVersion;
  const maxVer = manifest.testedMaxVersion;
  const testedRange = `${minVer} - ${maxVer}`;
  if (!currentVersion) {
    return {
      current: null,
      pinned,
      testedRange,
      compatible: false,
      status: 'unknown',
      license: 'MIT',
      note: 'Magpie version not detected',
    };
  }
  const parsed = parseMagpieVersion(currentVersion);
  if (!parsed) {
    return {
      current: currentVersion,
      pinned,
      testedRange,
      compatible: false,
      status: 'unrecognized',
      license: 'MIT',
      note: `Unrecognized version format: ${currentVersion}`,
    };
  }
  const aboveMin = compareMagpieVersions(currentVersion, minVer) >= 0;
  const belowMax = compareMagpieVersions(currentVersion, maxVer) <= 0;
  if (aboveMin && belowMax) {
    return {
      current: currentVersion,
      pinned,
      testedRange,
      compatible: true,
      status: currentVersion.replace(/^v/i, '') === pinned ? 'pinned' : 'tested-compatible',
      license: 'MIT',
      note: 'Within verified Magpie version range',
    };
  }
  if (!aboveMin) {
    return {
      current: currentVersion,
      pinned,
      testedRange,
      compatible: false,
      status: 'older-than-minimum',
      license: 'MIT',
      note: `Magpie ${currentVersion} is older than minimum verified ${minVer}`,
    };
  }
  // Newer minor/patch upstream release: structurally compatible if live API probe passes
  const sameMajorMinor = parsed[0] === 0 && parsed[1] === 1;
  return {
    current: currentVersion,
    pinned,
    testedRange,
    compatible: sameMajorMinor,
    status: sameMajorMinor ? 'newer-upstream-needs-probe' : 'major-drift',
    license: 'MIT',
    note: sameMajorMinor
      ? `Magpie ${currentVersion} is newer than ${maxVer}; run compatibility probe and retain rollback option`
      : `Magpie ${currentVersion} crosses major/minor boundary; verify adapter before use`,
  };
}

export function resolveMagpiePlatformAsset(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  return manifest.platformAssets[key] ?? null;
}

export function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Verify Magpie's official Ed25519 release signature over `"magpie release " + version + "\n" + sums`.
 */
export function verifyMagpieReleaseSignature({
  version,
  sumsText,
  signatureBase64,
  publicKeyBase64 = manifest.ed25519PublicKeyBase64,
}) {
  if (!version || typeof sumsText !== 'string' || typeof signatureBase64 !== 'string') {
    return false;
  }
  const rawPub = Buffer.from(publicKeyBase64, 'base64');
  if (rawPub.length !== 32) return false;
  const keyObj = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPub]),
    format: 'der',
    type: 'spki',
  });
  const message = Buffer.from(`magpie release ${String(version).replace(/^v/i, '')}\n${sumsText}`, 'utf8');
  const sig = Buffer.from(signatureBase64, 'base64');
  return crypto.verify(null, message, keyObj, sig);
}

/**
 * Probe a running Magpie instance (or mock) to confirm all adapter-required Gateway & Web endpoints
 * match expected contracts after an upstream Magpie update.
 */
export async function probeMagpieApiCompatibility({
  gatewayUrl,
  webAdminUrl = null,
  webKey = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}) {
  const checks = [];
  let detectedVersion = null;

  async function runCheck(name, url, init = {}, validator) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      const body = await res.json().catch(() => null);
      const ok = validator(res, body);
      checks.push({ name, ok, status: res.status, detail: ok ? 'ok' : 'unexpected payload shape' });
      return { ok, status: res.status, body };
    } catch (e) {
      checks.push({ name, ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) });
      return { ok: false, status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  const cleanGw = String(gatewayUrl || '').replace(/\/+$/, '');
  const rootRes = await runCheck('gateway.root', `${cleanGw}/`, {}, (res, body) => {
    if (res.ok && body?.name === 'magpie' && typeof body?.version === 'string') {
      detectedVersion = body.version;
      return true;
    }
    return false;
  });

  await runCheck('gateway.models', `${cleanGw}/v1/models`, {}, (res, body) => res.ok && Array.isArray(body?.data));
  await runCheck(
    'gateway.usage_feed',
    `${cleanGw}/v1/magpie/usage/requests?cursor=now&limit=1`,
    {},
    (res, body) => res.ok && Array.isArray(body?.rows) && typeof body?.next_cursor === 'string',
  );
  await runCheck(
    'gateway.accounts',
    `${cleanGw}/v1/magpie/accounts?models=1`,
    {},
    (res, body) => res.ok && Array.isArray(body?.data),
  );

  if (webAdminUrl && webKey) {
    const u = new URL(webAdminUrl);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const headers = { Cookie: `magpie_web_${port}=${webKey}` };
    const cleanWeb = String(webAdminUrl).replace(/\/+$/, '');
    await runCheck(
      'web.settings',
      `${cleanWeb}/api/settings`,
      { headers },
      (res, body) => res.ok && body && typeof body === 'object' && !Array.isArray(body),
    );
    await runCheck(
      'web.providers',
      `${cleanWeb}/api/providers`,
      { headers },
      (res, body) => res.ok && Array.isArray(body?.providers) && Array.isArray(body?.presets),
    );
  }

  const versionEval = evaluateMagpieVersionCompatibility(detectedVersion);
  const allChecksOk = rootRes.ok && checks.every(c => c.ok);
  return {
    ok: allChecksOk,
    detectedVersion,
    versionCompatibility: {
      ...versionEval,
      compatible: allChecksOk && (versionEval.compatible || versionEval.status === 'newer-upstream-needs-probe'),
    },
    checks,
  };
}
