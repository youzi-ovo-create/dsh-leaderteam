/**
 * Zero-dependency Validator for `lt.public.v1` Shared Integration Contract
 * Enforces all 9 dual-line rules across capabilities, gateway, providers, models, runtime, and usage.
 * Accepts either a flat contract snapshot OR a live `/api/lt/v1/bundle` `ContractEnvelope`.
 */

const RAW_SECRET_PATTERNS = [
  /\bsk-(?!\*{2,}|proj-\.\.\.)[A-Za-z0-9_-]{8,}\b/,
  /\bsk-[A-Za-z0-9_-]{2,}\.\.\.[A-Za-z0-9_-]{8,}\b/,
  /\bsk-magpie-[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/i,
  /\bmagpie_web_\d+=[A-Za-z0-9._~-]{12,}\b/,
  /[?&]k=[A-Za-z0-9._~-]{16,}/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{25,}\b/,
];

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'apiKey',
  'rawKey',
  'key',
  'token',
  'secret',
  'secretKey',
  'webKey',
  'managedWebKey',
  'externalWebKey',
  'secretAccessKey',
  'sessionToken',
  'balanceToken',
  'clientKey',
  'accessToken',
  'refreshToken',
  'password',
]);

export function scanNoSecretLeakage(node, pathStr = '$', errors = []) {
  if (node === null || node === undefined) return errors;
  if (typeof node === 'string') {
    for (const re of RAW_SECRET_PATTERNS) {
      if (re.test(node)) {
        errors.push(`${pathStr}: raw credential pattern leaked in string value`);
        break;
      }
    }
    return errors;
  }
  if (Array.isArray(node)) {
    node.forEach((item, idx) => scanNoSecretLeakage(item, `${pathStr}[${idx}]`, errors));
    return errors;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_CREDENTIAL_KEYS.has(k) && v !== null && v !== undefined && v !== '') {
        errors.push(`${pathStr}.${k}: forbidden raw credential field present in public payload`);
      }
      scanNoSecretLeakage(v, `${pathStr}.${k}`, errors);
    }
  }
  return errors;
}

export function validateContractBundle(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Root bundle must be an object'] };
  }

  // Rule 3: Zero credential leakage anywhere in public snapshot or envelope
  scanNoSecretLeakage(input, '$', errors);

  // Support both flat snapshot and live `/api/lt/v1/bundle` ContractEnvelope
  let bundle = input;
  let isLiveEnvelope = false;
  if (input.ok === true && input.data && typeof input.data === 'object' && !Array.isArray(input.data)) {
    isLiveEnvelope = true;
    if (typeof input.generatedAt !== 'string' || !input.generatedAt.trim()) {
      errors.push('ContractEnvelope.generatedAt must be a non-empty ISO timestamp string');
    }
    bundle = {
      contract: input.contract,
      contractVersion: input.contractVersion,
      ...input.data,
    };
  } else if (input.ok === false) {
    return { ok: false, errors: ['ContractErrorEnvelope received instead of valid bundle'] };
  }

  if (bundle.contract !== 'lt.public.v1') {
    errors.push(`Expected contract === "lt.public.v1", got ${JSON.stringify(bundle.contract)}`);
  }
  if (!['1.0.0', '1.0.1', '1.1.0'].includes(bundle.contractVersion)) {
    errors.push(`Expected contractVersion in ["1.0.0", "1.0.1", "1.1.0"], got ${JSON.stringify(bundle.contractVersion)}`);
  }

  // Domain 1: Capabilities
  const caps = bundle.capabilities;
  if (!caps || typeof caps !== 'object') {
    errors.push('Missing capabilities descriptor');
  } else {
    if (!caps.backendLine || typeof caps.backendLine !== 'string') errors.push('capabilities.backendLine required');
    if (!caps.backendVersion || typeof caps.backendVersion !== 'string') errors.push('capabilities.backendVersion required');
    if (!['dsh-web', 'dsh-desktop', 'standalone'].includes(caps.hostKind)) {
      errors.push(`Invalid capabilities.hostKind: ${caps.hostKind}`);
    }
    if (!caps.features || typeof caps.features !== 'object') {
      errors.push('capabilities.features required');
    } else {
      if (caps.features.inSessionDualMode !== undefined && typeof caps.features.inSessionDualMode !== 'boolean') {
        errors.push('capabilities.features.inSessionDualMode must be boolean when present');
      }
      if (bundle.contractVersion === '1.1.0' && typeof caps.features.inSessionDualMode !== 'boolean') {
        errors.push('capabilities.features.inSessionDualMode boolean required for contractVersion 1.1.0');
      }
    }
    if (!Array.isArray(caps.supportedRoles)) errors.push('capabilities.supportedRoles must be an array');
    if (!caps.frontendSwitch || typeof caps.frontendSwitch.available !== 'boolean') {
      errors.push('capabilities.frontendSwitch.available boolean required');
    }
  }

  // Domain 2: Gateway Lifecycle
  const gw = bundle.gateway;
  if (!gw || typeof gw !== 'object') {
    errors.push('Missing gateway status');
  } else {
    if (!['managed', 'external', 'disabled'].includes(gw.mode)) {
      errors.push(`Invalid gateway.mode: ${gw.mode}`);
    }
    if (!['running', 'starting', 'draining', 'stopped', 'degraded', 'error', 'not_installed'].includes(gw.state)) {
      errors.push(`Invalid gateway.state: ${gw.state}`);
    }
    if (typeof gw.managementAuthenticated !== 'boolean') {
      errors.push('gateway.managementAuthenticated boolean required');
    }
    if (!gw.version || gw.version.license !== 'MIT') {
      errors.push('gateway.version.license must explicitly declare "MIT"');
    }
    if (!gw.health || typeof gw.health.ok !== 'boolean') {
      errors.push('gateway.health.ok boolean required');
    }
  }

  // Domain 3: Providers & Credentials
  const providerIds = new Set();
  if (!Array.isArray(bundle.providers)) {
    errors.push('providers must be an array');
  } else {
    for (const [i, p] of bundle.providers.entries()) {
      if (!p.providerId) errors.push(`providers[${i}].providerId required`);
      if (providerIds.has(p.providerId)) errors.push(`Duplicate providerId: ${p.providerId}`);
      providerIds.add(p.providerId);
      if (!['magpie', 'direct', 'external-gateway'].includes(p.sourceKind)) {
        errors.push(`providers[${i}].sourceKind invalid: ${p.sourceKind}`);
      }
      if (!['ready', 'degraded', 'unconfigured', 'disabled', 'auth_required'].includes(p.status)) {
        errors.push(`providers[${i}].status invalid: ${p.status}`);
      }
      if (!Array.isArray(p.credentials)) {
        errors.push(`providers[${i}].credentials must be an array`);
      } else {
        for (const [j, c] of p.credentials.entries()) {
          if (!c.credentialId || typeof c.maskedPreview !== 'string') {
            errors.push(`providers[${i}].credentials[${j}] missing credentialId or maskedPreview`);
          }
        }
      }
    }
  }

  // Domain 4 & Rule 1: Model Catalog separation (never auto-merge same-name models across sources/providers)
  const entryIds = new Set();
  const routeIds = new Set();
  const compositeIdentities = new Set();
  if (!Array.isArray(bundle.models)) {
    errors.push('models must be an array');
  } else {
    for (const [i, m] of bundle.models.entries()) {
      if (!m.entryId || !m.routeId || !m.upstreamModelId || !m.providerId || !m.sourceKind) {
        errors.push(`models[${i}] missing identity fields (entryId/routeId/upstreamModelId/providerId/sourceKind)`);
        continue;
      }
      const expectedEntryId = `${m.sourceKind}:${m.providerId}:${m.upstreamModelId}`;
      if (m.entryId !== expectedEntryId) {
        errors.push(`models[${i}].entryId (${m.entryId}) must match canonical "${expectedEntryId}"`);
      }
      if (entryIds.has(m.entryId)) errors.push(`Duplicate model entryId: ${m.entryId}`);
      entryIds.add(m.entryId);
      if (routeIds.has(m.routeId)) errors.push(`Colliding routeId (auto-merge violation): ${m.routeId}`);
      routeIds.add(m.routeId);
      const comp = `${m.sourceKind}|${m.providerId}|${m.credentialScope || ''}|${m.upstreamModelId}`;
      if (compositeIdentities.has(comp)) errors.push(`Duplicate composite model identity: ${comp}`);
      compositeIdentities.add(comp);
      if (Array.isArray(bundle.providers) && !providerIds.has(m.providerId)) {
        errors.push(`models[${i}] references unknown providerId: ${m.providerId}`);
      }
    }
  }

  // Domain 5: Runtime
  const rt = bundle.runtime;
  if (!rt || typeof rt !== 'object') {
    errors.push('Missing runtime snapshot');
  } else {
    if (!rt.modelPool || !Array.isArray(rt.modelPool.executionPool)) {
      errors.push('runtime.modelPool.executionPool must be an array');
    }
    if (!rt.roleAssignments || typeof rt.roleAssignments !== 'object') {
      errors.push('runtime.roleAssignments must be an object');
    }
    if (!Array.isArray(rt.teams)) {
      errors.push('runtime.teams must be an array');
    }
  }

  // Domain 6 & Rule 4 + Rule 5: Usage Records (logical vs physical attempts, cache 4-bucket sum, unknown != 0)
  const reqIds = new Set();
  const usageRecords =
    bundle.usageRecords === undefined && isLiveEnvelope && bundle.usageStatus && typeof bundle.usageStatus === 'object'
      ? []
      : bundle.usageRecords;

  if (!Array.isArray(usageRecords)) {
    errors.push('usageRecords must be an array');
  } else {
    for (const [i, u] of usageRecords.entries()) {
      if (!u.logicalRequestId) errors.push(`usageRecords[${i}].logicalRequestId required`);
      if (reqIds.has(u.logicalRequestId)) {
        errors.push(`Duplicate logicalRequestId (retry double-counting violation): ${u.logicalRequestId}`);
      }
      reqIds.add(u.logicalRequestId);

      if (!u.actualProvider || typeof u.actualProvider !== 'string') {
        errors.push(`usageRecords[${i}].actualProvider must be non-empty string ("unknown" when unavailable)`);
      }
      if (!u.actualModel || typeof u.actualModel !== 'string') {
        errors.push(`usageRecords[${i}].actualModel must be non-empty string ("unknown" when unavailable)`);
      }

      if (Array.isArray(u.attempts) && u.physicalAttemptCount !== null) {
        if (u.physicalAttemptCount !== u.attempts.length) {
          errors.push(`usageRecords[${i}]: physicalAttemptCount (${u.physicalAttemptCount}) != attempts.length (${u.attempts.length})`);
        }
      }

      const tok = u.tokens;
      if (!tok || typeof tok !== 'object') {
        errors.push(`usageRecords[${i}].tokens required`);
      } else if (!u.metered) {
        const tokenKeys = [
          'uncachedInputTokens',
          'cacheReadTokens',
          'cacheWriteTokens',
          'outputTokens',
          'reasoningTokens',
          'totalTokens',
        ];
        for (const tk of tokenKeys) {
          if (tok[tk] !== null) {
            errors.push(`usageRecords[${i}]: unmetered record must set tokens.${tk} = null (unknown != 0)`);
          }
        }
      } else {
        const sum4 =
          (tok.uncachedInputTokens ?? 0) +
          (tok.cacheReadTokens ?? 0) +
          (tok.cacheWriteTokens ?? 0) +
          (tok.outputTokens ?? 0);
        if (tok.totalTokens !== sum4) {
          errors.push(
            `usageRecords[${i}]: 4-bucket token identity violated (totalTokens=${tok.totalTokens} != ${sum4}; reasoningTokens must NOT be added on top of outputTokens)`
          );
        }
        if (tok.reasoningTokens !== null && tok.reasoningTokens > tok.outputTokens) {
          errors.push(`usageRecords[${i}]: reasoningTokens (${tok.reasoningTokens}) exceeds outputTokens (${tok.outputTokens})`);
        }
      }

      const cost = u.cost;
      if (!cost || typeof cost !== 'object') {
        errors.push(`usageRecords[${i}].cost required`);
      } else if (!cost.known) {
        if (
          cost.actualCny !== null ||
          cost.actualUsd !== null ||
          cost.peakCny !== null ||
          cost.offPeakCny !== null ||
          cost.currency !== null
        ) {
          errors.push(`usageRecords[${i}]: cost.known=false must keep currency/actualCny/peakCny/offPeakCny/actualUsd as null (unknown != 0)`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
