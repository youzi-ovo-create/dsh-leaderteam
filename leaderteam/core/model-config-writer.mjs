// External model catalog, member execution pool, and governance role configuration writer.
// Validates both standalone base config and merged (base + local) config before atomic writes,
// keeps Magpie YAML patch templates synchronized, and inspects Desktop cordis.patch.yml drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LtError, FAMILIES, MODEL_ROUTE_RE, EFFORT_ID_RE, DSH_EFFORTS } from './constants.mjs';
import { validateConfig, deepMergePlain, routeModel } from './config.mjs';
import { writeFileAtomic, writeFilesTransactional, appendJsonl } from './store.mjs';
import { hashJson } from './canonical.mjs';

export const ROLE_KEYS = Object.freeze(['leader', 'gate', 'discussA', 'discussB', 'arbiter', 'serialReviewer', 'directExec']);

const DEFAULT_ROLE_LIMITS = Object.freeze({
  gate: { maxTokens: 8000, timeoutMs: 60000, retries: 1 },
  discussA: { maxTokens: 16000, timeoutMs: 300000, retries: 1 },
  discussB: { maxTokens: 16000, timeoutMs: 300000, retries: 1 },
  arbiter: { maxTokens: 16000, timeoutMs: 600000, retries: 1 },
  serialReviewer: { maxTokens: 16000, timeoutMs: 180000, retries: 0 },
  directExec: { timeoutMs: 180000, retries: 1 },
});

const MANAGED_BEGIN = '# >>> leaderteam (managed by scripts/install-desktop.ps1; do not edit inside)';
const MANAGED_END = '# <<< leaderteam';
const ROW_RE = /^[ \t]*-\s*\{id:\s*(?:"([^"]+)"|'([^']+)'|([^,\s}]+))[^{}]*?(?:,\s*reasoningEfforts:\s*\{([^}]*)\})?\s*\}/gm;

const isPlainObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJsonObject(file, label) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    throw new LtError('BAD_CONFIG', `cannot read ${label} ${file}: ${e.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new LtError('BAD_CONFIG', `${label} ${file} is not valid JSON: ${e.message}`);
  }
  if (!isPlainObj(parsed)) {
    throw new LtError('BAD_CONFIG', `${label} ${file} must be a JSON object`);
  }
  return parsed;
}

export function inferFamilyFromRoute(route) {
  const lower = String(route ?? '').toLowerCase();
  if (lower.startsWith('codex/') || /(?:^|\/)(?:gpt-|o1|o3|o4)/.test(lower)) return 'gpt';
  if (lower.startsWith('zcode/') || lower.includes('glm')) return 'glm';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('qwen')) return 'qwen';
  return 'other';
}

export function renderMagpieModelRows(cfg, indent = '          ') {
  const defaultProvider = cfg?.magpie?.provider ?? 'magpie';
  const rows = [];
  for (const [id, spec] of Object.entries(cfg.models)) {
    if (!MODEL_ROUTE_RE.test(id)) {
      throw new LtError('BAD_CONFIG', `invalid model route for Magpie YAML row: "${id}"`);
    }
    if (!Array.isArray(spec?.efforts) || spec.efforts.length === 0) {
      throw new LtError('BAD_CONFIG', `model "${id}" must define non-empty efforts`);
    }
    for (const e of spec.efforts) {
      if (!EFFORT_ID_RE.test(e)) {
        throw new LtError('BAD_CONFIG', `invalid effort "${e}" on model "${id}" for Magpie YAML row`);
      }
      if (!DSH_EFFORTS.includes(e)) {
        throw new LtError('BAD_CONFIG', `effort "${e}" on model "${id}" is unsupported by DSH; use one of ${DSH_EFFORTS.join(', ')}`);
      }
    }
    const prov = spec?.provider ?? defaultProvider;
    if (prov !== defaultProvider) continue;
    const upstreamId = spec?.upstreamModel ?? id;
    const yamlId = /[:@\s"']/.test(upstreamId) ? JSON.stringify(upstreamId) : upstreamId;
    const realEfforts = spec.efforts.filter(e => e !== 'none');
    const hasNoneWithThinking = realEfforts.length > 0 && spec.efforts.includes('none') && !realEfforts.includes('off');
    const effectiveEfforts = hasNoneWithThinking ? ['off', ...realEfforts] : realEfforts;
    const explicitWireMap = isPlainObj(spec?.reasoningEfforts) ? spec.reasoningEfforts : null;
    const yamlScalar = v => (/^(?:y|n|yes|no|true|false|on|off|null|~)$/i.test(v) || /[:@\s"']/.test(v) ? JSON.stringify(v) : v);
    const fields = [`id: ${yamlId}`];
    if (Number.isInteger(spec?.contextWindow) && spec.contextWindow > 0) {
      fields.push(`contextWindow: ${spec.contextWindow}`);
    }
    if (Number.isInteger(spec?.maxTokens) && spec.maxTokens > 0) {
      fields.push(`maxTokens: ${spec.maxTokens}`);
    }
    fields.push(`input: ${spec.vision ? '[text, image]' : '[text]'}`);
    if (effectiveEfforts.length > 0) {
      const efforts = effectiveEfforts.map(e => {
        const wire = explicitWireMap && typeof explicitWireMap[e] === 'string'
          ? explicitWireMap[e]
          : (e === 'off' ? 'none' : e);
        const wireOut = e === 'off' ? JSON.stringify(wire) : yamlScalar(wire);
        return `${yamlScalar(e)}: ${wireOut}`;
      }).join(', ');
      fields.push(`reasoningEfforts: {${efforts}}`);
    }
    rows.push(`${indent}- {${fields.join(', ')}}`);
  }
  return rows.join('\n');
}

export function rewriteModelsBlock(yamlText, renderedRows) {
  const populatedRe = /^([ \t]*models:)[ \t]*\r?\n((?:[ \t]*- \{id: [^\r\n]+\}\r?\n?)+)/m;
  const emptyRe = /^([ \t]*models:)[ \t]*\[\][ \t]*(\r?\n|$)/m;
  const eol = yamlText.includes('\r\n') ? '\r\n' : '\n';
  const trimmed = typeof renderedRows === 'string' ? renderedRows.trim() : '';

  if (populatedRe.test(yamlText)) {
    return yamlText.replace(populatedRe, (_, head, prev) => {
      const trailingNewline = prev.endsWith(eol) || prev.endsWith('\n');
      if (!trimmed) {
        return `${head} []${trailingNewline ? eol : ''}`;
      }
      const rows = renderedRows.replace(/\r?\n/g, eol);
      return `${head}${eol}${rows}${trailingNewline ? eol : ''}`;
    });
  }
  if (emptyRe.test(yamlText)) {
    return yamlText.replace(emptyRe, (_, head, tailEol) => {
      const hasTail = Boolean(tailEol);
      if (!trimmed) {
        return `${head} []${hasTail ? eol : ''}`;
      }
      const rows = renderedRows.replace(/\r?\n/g, eol);
      return `${head}${eol}${rows}${hasTail ? eol : ''}`;
    });
  }
  throw new Error('Could not locate models block in patch template');
}

/**
 * Parse Magpie model IDs and reasoningEfforts keys from a patch template or Desktop cordis.patch.yml.
 * When `requireManagedBlock` is true, inspects only the `# >>> leaderteam ... # <<< leaderteam` block.
 */
export function parseMagpiePatchModels(yamlText, { requireManagedBlock = false } = {}) {
  if (typeof yamlText !== 'string' || !yamlText.trim()) return null;
  let target = yamlText;
  const beginIdx = yamlText.indexOf(MANAGED_BEGIN);
  if (beginIdx >= 0) {
    const endIdx = yamlText.indexOf(MANAGED_END, beginIdx + MANAGED_BEGIN.length);
    if (endIdx < 0) return null;
    target = yamlText.slice(beginIdx + MANAGED_BEGIN.length, endIdx);
  } else if (requireManagedBlock) {
    return null;
  }
  const map = new Map();
  ROW_RE.lastIndex = 0;
  let match;
  while ((match = ROW_RE.exec(target)) !== null) {
    const id = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    const rawEfforts = (match[4] ?? '').trim();
    const efforts = rawEfforts
      ? rawEfforts.split(',').map(part => part.split(':')[0].trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : ['none'];
    map.set(id, efforts);
  }
  return map;
}

function isWritablePathOrAncestor(targetPath) {
  let cur = path.resolve(targetPath);
  while (true) {
    if (fs.existsSync(cur)) {
      try {
        fs.accessSync(cur, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export function resolveWritableBackupRoot({
  explicitBackupRoot = null,
  configFile,
  localFile = null,
  target = 'base',
  dshHome = null,
  projectRoot = null,
} = {}) {
  if (explicitBackupRoot) return path.resolve(explicitBackupRoot);
  const resolvedCfg = configFile ? path.resolve(configFile) : null;
  const resolvedRoot = projectRoot ? path.resolve(projectRoot) : null;
  const cfgParent = resolvedCfg ? path.resolve(path.dirname(resolvedCfg), '..') : null;

  // Prefer keeping backups beside the managed DSH config (`<dshHome>/leaderteam/backups/model-config`)
  // or project root ONLY when that directory is actually writable (never fail with EACCES on read-only node_modules).
  const candidates = [];
  if (cfgParent && (!resolvedRoot || cfgParent !== resolvedRoot)) {
    candidates.push(path.join(cfgParent, 'backups', 'model-config'));
  }
  if (resolvedRoot) {
    const inNodeModules = resolvedRoot.replaceAll('\\', '/').includes('/node_modules/');
    if (!inNodeModules) {
      candidates.push(path.join(resolvedRoot, 'backups', 'model-config'));
    }
  }
  const effDshHome = resolveDefaultDshHome({ dshHome, configFile: resolvedCfg, projectRoot: resolvedRoot });
  if (effDshHome) {
    candidates.push(path.join(effDshHome, 'leaderteam', 'backups', 'model-config'));
  }
  if (target === 'local' && localFile) {
    candidates.push(path.join(path.dirname(path.resolve(localFile)), '.backups', 'model-config'));
  }
  if (resolvedCfg) {
    candidates.push(path.join(path.dirname(resolvedCfg), '.backups', 'model-config'));
  }
  if (resolvedRoot) {
    candidates.push(path.join(resolvedRoot, 'backups', 'model-config'));
  }
  candidates.push(path.join(os.tmpdir(), 'leaderteam-backups', 'model-config'));

  for (const cand of candidates) {
    if (isWritablePathOrAncestor(cand)) return cand;
  }
  return candidates[candidates.length - 1];
}

export function resolveDefaultDshHome({ dshHome, configFile, projectRoot } = {}) {
  if (typeof dshHome === 'string' && dshHome.trim()) return path.resolve(dshHome);
  if (process.env.LT_DSH_HOME?.trim()) return path.resolve(process.env.LT_DSH_HOME);
  if (process.env.DSH_HOME?.trim()) return path.resolve(process.env.DSH_HOME);
  const root = projectRoot
    ? path.resolve(projectRoot)
    : (configFile ? path.resolve(path.dirname(configFile), '..') : null);
  if (root) {
    const pathsJson = path.join(root, 'config', 'official-desktop.paths.json');
    if (fs.existsSync(pathsJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pathsJson, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof parsed?.home === 'string' && parsed.home.trim()) {
          return path.resolve(parsed.home);
        }
      } catch {}
    }
  }
  const homeDotDsh = os.homedir() ? path.join(os.homedir(), '.dsh') : null;
  if (homeDotDsh && fs.existsSync(homeDotDsh)) return homeDotDsh;
  return null;
}

/** Inspect whether Desktop's installed cordis.patch.yml already registers all configured Magpie models & efforts. */
export function inspectDesktopSync(effectiveCfg, options = {}) {
  const profile = options.profile ?? 'desktop';
  const dshHome = resolveDefaultDshHome(options);
  if (!dshHome) {
    return {
      configured: false,
      dshHome: null,
      profile,
      patchFile: null,
      installed: false,
      inSync: false,
      hotReloadableNow: true,
      missingCatalogRoutes: [],
      missingCatalogEfforts: {},
      missingActiveRoutes: [],
      missingActiveEfforts: {},
      note: 'No DSH Desktop home configured locally; LeaderTeam config files are ready.',
    };
  }
  const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  if (!fs.existsSync(patchFile)) {
    const allRoutes = Object.keys(effectiveCfg.models);
    return {
      configured: true,
      dshHome,
      profile,
      patchFile,
      installed: false,
      inSync: false,
      hotReloadableNow: false,
      missingCatalogRoutes: allRoutes,
      missingCatalogEfforts: {},
      missingActiveRoutes: allRoutes,
      missingActiveEfforts: {},
      note: 'cordis.patch.yml not found in Desktop profile; run scripts/install-desktop.ps1 after quitting DSH Desktop.',
    };
  }
  let text = '';
  try { text = fs.readFileSync(patchFile, 'utf8'); } catch {
    return {
      configured: true,
      dshHome,
      profile,
      patchFile,
      installed: false,
      inSync: false,
      hotReloadableNow: false,
      missingCatalogRoutes: [],
      missingCatalogEfforts: {},
      missingActiveRoutes: [],
      missingActiveEfforts: {},
      note: 'Unable to read Desktop cordis.patch.yml.',
    };
  }
  const registered = parseMagpiePatchModels(text, { requireManagedBlock: true });
  if (!registered) {
    const allRoutes = Object.keys(effectiveCfg.models);
    return {
      configured: true,
      dshHome,
      profile,
      patchFile,
      installed: false,
      inSync: false,
      hotReloadableNow: false,
      missingCatalogRoutes: allRoutes,
      missingCatalogEfforts: {},
      missingActiveRoutes: allRoutes,
      missingActiveEfforts: {},
      note: 'LeaderTeam managed block is not installed in Desktop cordis.patch.yml; run scripts/install-desktop.ps1.',
    };
  }

  const activeSet = new Set([
    ...effectiveCfg.team.executionPool,
    ...ROLE_KEYS.flatMap(k => [
      effectiveCfg.roles[k]?.route,
      ...(effectiveCfg.roles[k]?.fallback ?? []).map(f => f?.route),
    ]).filter(Boolean),
  ]);
  const defaultProvider = effectiveCfg.magpie?.provider ?? 'magpie';

  const missingCatalogRoutes = [];
  const missingCatalogEfforts = {};
  const missingActiveRoutes = [];
  const missingActiveEfforts = {};

  for (const [route, spec] of Object.entries(effectiveCfg.models)) {
    const prov = spec?.provider ?? defaultProvider;
    if (prov !== defaultProvider) continue;
    const upstreamId = spec?.upstreamModel ?? route;
    const regEfforts = registered.get(upstreamId) ?? registered.get(route);
    if (!regEfforts) {
      missingCatalogRoutes.push(route);
      if (activeSet.has(route)) missingActiveRoutes.push(route);
      continue;
    }
    const missingEffs = spec.efforts.filter(e => e !== 'none' && !regEfforts.includes(e));
    if (missingEffs.length > 0) {
      missingCatalogEfforts[route] = missingEffs;
      if (activeSet.has(route)) missingActiveEfforts[route] = missingEffs;
    }
  }

  const inSync = missingCatalogRoutes.length === 0 && Object.keys(missingCatalogEfforts).length === 0;
  const hotReloadableNow = missingActiveRoutes.length === 0 && Object.keys(missingActiveEfforts).length === 0;

  return {
    configured: true,
    dshHome,
    profile,
    patchFile,
    installed: true,
    inSync,
    hotReloadableNow,
    missingCatalogRoutes,
    missingCatalogEfforts,
    missingActiveRoutes,
    missingActiveEfforts,
    note: hotReloadableNow
      ? (inSync
        ? 'Desktop Magpie model registry is in sync; member pool, effort, and role edits take effect live without restarting DSH.'
        : 'Active execution pool and role models are registered in Desktop (live hot-reload works now); quit DSH and run --sync-desktop later to register inactive catalog additions.')
      : 'New active model route(s) or effort(s) are not yet in Desktop cordis.patch.yml: quit DSH Desktop completely and run with --sync-desktop (or scripts/install-desktop.ps1).',
  };
}

function summarizeLocalOverrides(localRaw) {
  if (!isPlainObj(localRaw)) {
    return { exists: false, models: [], executionPool: false, leaderModelPolicy: false, roles: [] };
  }
  return {
    exists: true,
    models: isPlainObj(localRaw.models) ? Object.keys(localRaw.models) : [],
    executionPool: Array.isArray(localRaw.team?.executionPool),
    leaderModelPolicy: localRaw.team?.leaderModelPolicy !== undefined,
    roles: isPlainObj(localRaw.roles) ? Object.keys(localRaw.roles).filter(k => ROLE_KEYS.includes(k)) : [],
  };
}

function defaultPatchTargets(configFile) {
  const dir = path.dirname(path.resolve(configFile));
  if (path.basename(configFile) !== 'leaderteam.config.json') return [];
  return ['desktop-magpie.patch.yml', 'magpie-models.patch.yml']
    .map(name => path.join(dir, name))
    .filter(p => fs.existsSync(p));
}

export function inspectPatchTemplateSync(baseCfg, configFile, patchFiles = defaultPatchTargets(configFile)) {
  const rows = renderMagpieModelRows(baseCfg);
  const drifted = [];
  for (const file of patchFiles) {
    const current = fs.readFileSync(file, 'utf8');
    const next = rewriteModelsBlock(current, rows);
    if (current.replace(/\r\n/g, '\n') !== next.replace(/\r\n/g, '\n')) {
      drifted.push(file);
    }
  }
  return { patchFiles, inSync: drifted.length === 0, drifted };
}

/** Full read-only snapshot of base, local override, effective config, YAML patch sync, and Desktop sync. */
export function inspectModelConfiguration(options = {}) {
  const configFile = path.resolve(options.configFile);
  const localFile = options.localFile
    ? path.resolve(options.localFile)
    : (path.basename(configFile) === 'leaderteam.config.json'
      ? path.join(path.dirname(configFile), 'leaderteam.local.json')
      : null);

  const baseRaw = readJsonObject(configFile, 'config');
  const baseConfig = validateConfig(baseRaw);
  const hasLocal = Boolean(localFile && fs.existsSync(localFile));
  const localRaw = hasLocal ? readJsonObject(localFile, 'local config override') : null;
  const mergedRaw = hasLocal ? deepMergePlain(baseRaw, localRaw) : baseRaw;
  const effective = validateConfig(mergedRaw);

  const patchSync = inspectPatchTemplateSync(baseConfig, configFile, options.patchFiles);
  const desktopSync = inspectDesktopSync(effective, {
    dshHome: options.dshHome,
    profile: options.profile,
    configFile,
    projectRoot: options.projectRoot,
  });

  const poolSet = new Set(effective.team.executionPool);
  const modelsView = Object.entries(effective.models).map(([route, spec]) => ({
    route,
    provider: spec.provider ?? effective.magpie.provider,
    upstreamModel: spec.upstreamModel ?? route,
    family: spec.family,
    label: spec.label,
    efforts: [...spec.efforts],
    defaultEffort: spec.defaultEffort,
    reasoningEfforts: spec.reasoningEfforts ? { ...spec.reasoningEfforts } : null,
    contextWindow: spec.contextWindow ?? null,
    maxTokens: spec.maxTokens ?? null,
    strengths: spec.strengths ?? '',
    quotaWindows: spec.quotaWindows ? [...spec.quotaWindows] : null,
    inExecutionPool: poolSet.has(route),
    poolIndex: effective.team.executionPool.indexOf(route),
    usedByRoles: ROLE_KEYS.filter(r => effective.roles[r].route === route),
    overriddenInLocal: Boolean(isPlainObj(localRaw?.models?.[route])),
    onlyInLocal: !Object.hasOwn(baseConfig.models, route),
  }));

  return {
    configFile,
    localFile,
    hasLocalFile: hasLocal,
    localOverrides: summarizeLocalOverrides(localRaw),
    supportedFamilies: [...FAMILIES],
    leaderModelPolicy: effective.team.leaderModelPolicy,
    executionPool: [...effective.team.executionPool],
    models: modelsView,
    roles: structuredClone(effective.roles),
    baseRoles: structuredClone(baseConfig.roles),
    baseExecutionPool: [...baseConfig.team.executionPool],
    plugins: structuredClone(effective.plugins),
    timer: structuredClone(effective.timer),
    planArchive: structuredClone(effective.planArchive),
    powerMonitor: structuredClone(effective.powerMonitor),
    requestWindow: structuredClone(effective.requestWindow),
    patchSync,
    desktopSync,
  };
}

function pruneEmptyObjects(obj) {
  if (!isPlainObj(obj)) return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObj(v)) {
      pruneEmptyObjects(v);
      if (Object.keys(v).length === 0) delete obj[k];
    }
  }
  return obj;
}

function backupFiles(files, backupRoot) {
  const existing = files.filter(f => f && fs.existsSync(f));
  if (existing.length === 0) return null;
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const src of existing) {
    const dest = path.join(backupRoot, path.basename(src));
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
  }
  return backupRoot;
}

function governanceSettings(raw) {
  const roles = raw.roles ?? {};
  const routes = Object.values(roles).flatMap(r => [r.route, ...(r.fallback ?? []).map(f => f.route)]).filter(Boolean);
  return { roles, leaderModelPolicy: raw.team?.leaderModelPolicy ?? null,
    models: Object.fromEntries([...new Set(routes)].sort().map(route => [route, raw.models?.[route] ?? null])) };
}

/**
 * Apply transactional model/pool/role edits to either `leaderteam.config.json` (`target: 'base'`, default)
 * or `leaderteam.local.json` (`target: 'local'`). Validates standalone base AND merged config before writing.
 */
export function applyModelConfigChanges(changes = {}, options = {}) {
  const target = options.target === 'local' ? 'local' : 'base';
  const dryRun = Boolean(options.dryRun);
  const configFile = path.resolve(options.configFile);
  const localFile = options.localFile
    ? path.resolve(options.localFile)
    : path.join(path.dirname(configFile), 'leaderteam.local.json');

  const baseRaw = readJsonObject(configFile, 'config');
  validateConfig(baseRaw);
  const hasExistingLocal = fs.existsSync(localFile);
  const localRaw = hasExistingLocal ? readJsonObject(localFile, 'local config override') : {};
  if (hasExistingLocal) {
    validateConfig(deepMergePlain(baseRaw, localRaw));
  }

  const nextBase = structuredClone(baseRaw);
  const nextLocal = structuredClone(localRaw);
  const warnings = [];
  const touched = {
    models: new Set(),
    removedModels: new Set(),
    roles: new Set(),
    pool: false,
    leaderModelPolicy: false,
  };

  let localClearedInBaseMode = false;

  // 1. Optional clearLocal / clearLocalOverrides / clearLocalRolesAndPool operations
  if (changes.clearLocalOverrides === true || changes.clearLocalRolesAndPool === true) {
    if (changes.clearLocalOverrides === true) {
      delete nextLocal.models;
    }
    delete nextLocal.roles;
    if (isPlainObj(nextLocal.team)) {
      delete nextLocal.team.executionPool;
      delete nextLocal.team.leaderModelPolicy;
    }
    pruneEmptyObjects(nextLocal);
    if (target === 'base' && hasExistingLocal) {
      localClearedInBaseMode = true;
    }
  }

  if (changes.clearLocal) {
    if (target !== 'local') {
      throw new LtError('BAD_CONFIG', 'clearLocal options require target="local" (--local)');
    }
    const cl = changes.clearLocal;
    if (cl.all) {
      delete nextLocal.models;
      delete nextLocal.roles;
      if (isPlainObj(nextLocal.team)) {
        delete nextLocal.team.executionPool;
        delete nextLocal.team.leaderModelPolicy;
      }
    } else {
      for (const r of cl.models ?? []) {
        if (isPlainObj(nextLocal.models)) delete nextLocal.models[r];
      }
      for (const role of cl.roles ?? []) {
        if (!ROLE_KEYS.includes(role)) throw new LtError('BAD_CONFIG', `unknown role "${role}" in clearLocal.roles`);
        if (isPlainObj(nextLocal.roles)) delete nextLocal.roles[role];
      }
      if (cl.pool && isPlainObj(nextLocal.team)) delete nextLocal.team.executionPool;
      if (cl.leaderModelPolicy && isPlainObj(nextLocal.team)) delete nextLocal.team.leaderModelPolicy;
    }
    pruneEmptyObjects(nextLocal);
  }

  // 2. Upsert / update models
  const discoveredMap = new Map();
  if (Array.isArray(options.discoveredModels)) {
    for (const dm of options.discoveredModels) {
      if (dm?.route) discoveredMap.set(dm.route, dm);
    }
  }

  const requestedAutoRoutes = new Set([
    ...(changes.poolSet ?? []),
    ...(changes.poolEnable ?? []),
    ...(changes.setRoles ?? []).flatMap(r => [
      r?.route,
      ...(Array.isArray(r?.fallback) ? r.fallback.map(f => f?.route) : []),
    ]).filter(Boolean),
  ]);
  const explicitUpsertRoutes = new Set((changes.upsertModels ?? []).map(x => x?.route?.trim()).filter(Boolean));
  const autoUpserts = [];
  for (const r of requestedAutoRoutes) {
    if (explicitUpsertRoutes.has(r)) continue;
    if (target === 'base') {
      if (Object.hasOwn(nextBase.models ?? {}, r)) continue;
      if (isPlainObj(nextLocal.models?.[r])) {
        const localSpec = structuredClone(nextLocal.models[r]);
        delete localSpec.enableInPool;
        delete localSpec.disableInPool;
        autoUpserts.push({ route: r, ...localSpec });
        continue;
      }
    } else {
      if (Object.hasOwn(nextBase.models ?? {}, r) || Object.hasOwn(nextLocal.models ?? {}, r)) continue;
    }
    const dm = discoveredMap.get(r);
    if (dm) {
      autoUpserts.push({
        route: dm.route,
        provider: dm.provider,
        upstreamModel: dm.upstreamModel,
        family: dm.family,
        label: dm.label,
        efforts: dm.efforts,
        defaultEffort: dm.defaultEffort,
        ...(isPlainObj(dm.reasoningEfforts) ? { reasoningEfforts: { ...dm.reasoningEfforts } } : {}),
        strengths: dm.strengths,
        ...(typeof dm.vision === 'boolean' ? { vision: dm.vision } : {}),
        ...(Number.isInteger(dm.contextWindow) && dm.contextWindow > 0 ? { contextWindow: dm.contextWindow } : {}),
        ...(Number.isInteger(dm.maxTokens ?? dm.defaultMaxTokens) && (dm.maxTokens ?? dm.defaultMaxTokens) > 0
          ? { maxTokens: dm.maxTokens ?? dm.defaultMaxTokens }
          : {}),
        ...(Array.isArray(dm.quotaWindows) && dm.quotaWindows.length > 0 ? { quotaWindows: [...dm.quotaWindows] } : {}),
      });
    }
  }

  const poolAutoEnable = [];
  const poolAutoDisable = [];
  for (const item of [...autoUpserts, ...(changes.upsertModels ?? [])]) {
    if (!isPlainObj(item) || typeof item.route !== 'string' || !item.route.trim()) {
      throw new LtError('BAD_CONFIG', 'upsertModels entry requires a non-empty string "route"');
    }
    const route = item.route.trim();
    const priorEffective = (isPlainObj(nextLocal.models?.[route]) || isPlainObj(nextBase.models?.[route]))
      ? deepMergePlain(nextBase.models?.[route] ?? {}, nextLocal.models?.[route] ?? {})
      : null;
    const priorTarget = target === 'base' ? nextBase.models?.[route] : priorEffective;

    const efforts = item.efforts !== undefined
      ? item.efforts
      : (Array.isArray(priorTarget?.efforts) ? [...priorTarget.efforts] : ['low', 'medium', 'high']);

    let defaultEffort;
    if (item.defaultEffort !== undefined) {
      defaultEffort = item.defaultEffort;
    } else if (priorTarget?.defaultEffort && Array.isArray(efforts) && efforts.includes(priorTarget.defaultEffort)) {
      defaultEffort = priorTarget.defaultEffort;
    } else if (Array.isArray(efforts) && efforts.length > 0) {
      defaultEffort = !priorTarget && efforts.includes('medium') ? 'medium' : efforts[0];
    } else {
      defaultEffort = '';
    }

    const spec = {
      family: item.family ?? priorTarget?.family ?? inferFamilyFromRoute(route),
      label: item.label ?? priorTarget?.label ?? routeModel(route),
      efforts,
      defaultEffort,
    };
    if (item.clearReasoningEfforts || item.reasoningEfforts === null) {
      // omit reasoningEfforts
    } else if (isPlainObj(item.reasoningEfforts)) {
      spec.reasoningEfforts = { ...item.reasoningEfforts };
    } else if (isPlainObj(priorTarget?.reasoningEfforts)) {
      const keptEfforts = {};
      for (const [ek, ev] of Object.entries(priorTarget.reasoningEfforts)) {
        const keyStillValid = ek === 'off'
          ? (Array.isArray(efforts) && (efforts.includes('off') || efforts.includes('none')))
          : (Array.isArray(efforts) && efforts.includes(ek));
        if (keyStillValid) keptEfforts[ek] = ev;
      }
      if (Object.keys(keptEfforts).length > 0) {
        spec.reasoningEfforts = keptEfforts;
      }
    }
    if (item.vision !== undefined || priorTarget?.vision !== undefined) spec.vision = item.vision ?? priorTarget.vision;
    if (item.contextWindow !== undefined) {
      if (item.contextWindow !== null) spec.contextWindow = item.contextWindow;
    } else if (priorTarget?.contextWindow !== undefined) {
      spec.contextWindow = priorTarget.contextWindow;
    }
    if (item.maxTokens !== undefined) {
      if (item.maxTokens !== null) spec.maxTokens = item.maxTokens;
    } else if (priorTarget?.maxTokens !== undefined) {
      spec.maxTokens = priorTarget.maxTokens;
    }
    const defaultProvider = nextBase.magpie?.provider ?? 'magpie';
    if (item.provider !== undefined) {
      if (item.provider && item.provider !== defaultProvider) spec.provider = item.provider;
    } else if (priorTarget?.provider !== undefined) {
      spec.provider = priorTarget.provider;
    }
    if (item.upstreamModel !== undefined) {
      if (item.upstreamModel && item.upstreamModel !== route) spec.upstreamModel = item.upstreamModel;
    } else if (priorTarget?.upstreamModel !== undefined) {
      spec.upstreamModel = priorTarget.upstreamModel;
    }
    if (item.strengths !== undefined) {
      if (item.strengths !== '') spec.strengths = item.strengths;
    } else if (priorTarget?.strengths !== undefined) {
      spec.strengths = priorTarget.strengths;
    }
    if (item.clearQuotaWindows) {
      // omit quotaWindows
    } else if (item.quotaWindows !== undefined) {
      if (Array.isArray(item.quotaWindows) && item.quotaWindows.length > 0) {
        spec.quotaWindows = [...item.quotaWindows];
      } else if (item.quotaWindows !== null) {
        spec.quotaWindows = item.quotaWindows;
      }
    } else if (priorTarget?.quotaWindows !== undefined) {
      spec.quotaWindows = [...priorTarget.quotaWindows];
    }

    if (target === 'base') {
      nextBase.models ??= {};
      nextBase.models[route] = spec;
    } else {
      nextLocal.models ??= {};
      nextLocal.models[route] = spec;
      if (!Object.hasOwn(nextBase.models ?? {}, route)) {
        warnings.push(`model "${route}" was added only in leaderteam.local.json; to sync Magpie YAML patch templates automatically, add catalog models in base config (omit --local)`);
      }
    }
    touched.models.add(route);
    if (item.enableInPool) poolAutoEnable.push(route);
    if (item.disableInPool) poolAutoDisable.push(route);
  }

  // 3. Remove models
  for (const rawRoute of changes.removeModels ?? []) {
    const route = String(rawRoute ?? '').trim();
    if (!route) throw new LtError('BAD_CONFIG', 'removeModels entry must be a non-empty string');
    if (target === 'local') {
      const inBase = Object.hasOwn(nextBase.models ?? {}, route);
      const inLocal = isPlainObj(nextLocal.models) && Object.hasOwn(nextLocal.models, route);
      if (!inBase && !inLocal) {
        throw new LtError('BAD_CONFIG', `model "${route}" does not exist in leaderteam.local.json`);
      }
      if (inLocal) {
        delete nextLocal.models[route];
      }
      if (inBase) {
        nextLocal.team ??= {};
        const prevDisabled = Array.isArray(nextLocal.team.disabledModels)
          ? [...nextLocal.team.disabledModels]
          : [...(nextBase.team?.disabledModels ?? [])];
        if (!prevDisabled.includes(route)) prevDisabled.push(route);
        nextLocal.team.disabledModels = prevDisabled;
        poolAutoDisable.push(route);
        warnings.push(`base catalog model "${route}" has been disabled and removed from the local execution pool in leaderteam.local.json`);
      } else if (changes.prunePool && Array.isArray(nextLocal.team?.executionPool)) {
        nextLocal.team.executionPool = nextLocal.team.executionPool.filter(r => r !== route);
        touched.pool = true;
      }
    } else {
      if (!isPlainObj(nextBase.models) || !Object.hasOwn(nextBase.models, route)) {
        throw new LtError('BAD_CONFIG', `model "${route}" does not exist in models`);
      }
      delete nextBase.models[route];
      if (changes.prunePool && Array.isArray(nextBase.team?.executionPool)) {
        nextBase.team.executionPool = nextBase.team.executionPool.filter(r => r !== route);
        touched.pool = true;
      }
    }
    touched.removedModels.add(route);
  }

  // 4. Member executionPool mutations
  const mergedModelsNow = deepMergePlain(nextBase.models ?? {}, nextLocal.models ?? {});
  const hasPoolOps = (
    changes.poolSet !== undefined ||
    (changes.poolEnableFamilies?.length ?? 0) > 0 ||
    (changes.poolDisableFamilies?.length ?? 0) > 0 ||
    (changes.poolEnable?.length ?? 0) > 0 ||
    (changes.poolDisable?.length ?? 0) > 0 ||
    poolAutoEnable.length > 0 ||
    poolAutoDisable.length > 0
  );
  if (hasPoolOps) {
    let pool = changes.poolSet !== undefined
      ? [...changes.poolSet]
      : [
        ...(target === 'local'
          ? (Array.isArray(nextLocal.team?.executionPool) ? nextLocal.team.executionPool : (nextBase.team?.executionPool ?? []))
          : (nextBase.team?.executionPool ?? [])),
      ];

    for (const fam of changes.poolEnableFamilies ?? []) {
      if (!FAMILIES.includes(fam)) throw new LtError('BAD_CONFIG', `unknown family "${fam}" (expected one of ${FAMILIES.join(', ')})`);
      for (const [r, spec] of Object.entries(mergedModelsNow)) {
        if (spec?.family === fam && !pool.includes(r)) pool.push(r);
      }
    }
    for (const fam of changes.poolDisableFamilies ?? []) {
      if (!FAMILIES.includes(fam)) throw new LtError('BAD_CONFIG', `unknown family "${fam}" (expected one of ${FAMILIES.join(', ')})`);
      pool = pool.filter(r => mergedModelsNow[r]?.family !== fam);
    }
    for (const r of [...(changes.poolEnable ?? []), ...poolAutoEnable]) {
      if (!pool.includes(r)) pool.push(r);
    }
    const disableSet = new Set([...(changes.poolDisable ?? []), ...poolAutoDisable]);
    if (disableSet.size > 0) {
      for (const r of disableSet) {
        if (!Object.hasOwn(mergedModelsNow, r) && !pool.includes(r)) {
          throw new LtError('BAD_CONFIG', `cannot disable unknown model "${r}"`);
        }
      }
      pool = pool.filter(r => !disableSet.has(r));
    }

    if (target === 'base') {
      nextBase.team ??= {};
      nextBase.team.executionPool = pool;
    } else {
      nextLocal.team ??= {};
      nextLocal.team.executionPool = pool;
    }
    touched.pool = true;
  }

  // 5. Roles & leaderModelPolicy
  for (const item of changes.setRoles ?? []) {
    if (!isPlainObj(item) || !ROLE_KEYS.includes(item.role)) {
      throw new LtError('BAD_CONFIG', `role must be one of: ${ROLE_KEYS.join(', ')}`);
    }
    const role = item.role;
    const priorEffective = deepMergePlain(nextBase.roles?.[role] ?? {}, nextLocal.roles?.[role] ?? {});
    const prior = target === 'base' ? (nextBase.roles?.[role] ?? {}) : priorEffective;
    const route = item.route ?? prior.route;
    if (typeof route !== 'string' || !route.trim()) {
      throw new LtError('BAD_CONFIG', `roles.${role}.route must be specified`);
    }
    if (item.requireExplicitEffort && (typeof item.effort !== 'string' || !item.effort.trim())) {
      throw new LtError('BAD_CONFIG', `roles.${role} update requires explicit effort`);
    }
    let effort;
    if (item.effort !== undefined) {
      effort = item.effort;
    } else if (item.route && item.route !== prior.route) {
      effort = mergedModelsNow[route]?.defaultEffort ?? prior.effort;
    } else {
      effort = prior.effort;
    }
    const targetModelSpec = mergedModelsNow[route];
    if (
      !item.requireExplicitEffort &&
      (options.autoAlignRoleEfforts || (item.route && item.route !== prior.route)) &&
      Array.isArray(targetModelSpec?.efforts) &&
      targetModelSpec.efforts.length > 0 &&
      !targetModelSpec.efforts.includes(effort)
    ) {
      effort = targetModelSpec.defaultEffort && targetModelSpec.efforts.includes(targetModelSpec.defaultEffort)
        ? targetModelSpec.defaultEffort
        : targetModelSpec.efforts[0];
    }

    const leaderMaxTokens = (item.clearMaxTokens || item.maxTokens === null)
      ? undefined
      : (item.maxTokens ?? prior.maxTokens);
    const nonLeaderMaxTokens = (item.clearMaxTokens || item.maxTokens === null)
      ? DEFAULT_ROLE_LIMITS[role]?.maxTokens
      : (item.maxTokens ?? prior.maxTokens ?? DEFAULT_ROLE_LIMITS[role]?.maxTokens);

    const nextRole = role === 'leader'
      ? {
        route,
        effort,
        ...(leaderMaxTokens !== undefined ? { maxTokens: leaderMaxTokens } : {}),
      }
      : {
        ...prior,
        route,
        effort,
        ...(nonLeaderMaxTokens !== undefined ? { maxTokens: nonLeaderMaxTokens } : {}),
        timeoutMs: item.timeoutMs ?? prior.timeoutMs ?? DEFAULT_ROLE_LIMITS[role].timeoutMs,
        retries: item.retries ?? prior.retries ?? DEFAULT_ROLE_LIMITS[role].retries,
        ...(Array.isArray(item.fallback) ? { fallback: item.fallback.map(f => {
          const fbCopy = { ...f };
          const fbSpec = mergedModelsNow[fbCopy.route];
          if (
            options.autoAlignRoleEfforts &&
            Array.isArray(fbSpec?.efforts) &&
            fbSpec.efforts.length > 0 &&
            !fbSpec.efforts.includes(fbCopy.effort)
          ) {
            fbCopy.effort = fbSpec.defaultEffort && fbSpec.efforts.includes(fbSpec.defaultEffort)
              ? fbSpec.defaultEffort
              : fbSpec.efforts[0];
          }
          return fbCopy;
        }) } : {}),
      };
    if (role !== 'leader' && nonLeaderMaxTokens === undefined) delete nextRole.maxTokens;
    if (role !== 'leader' && Array.isArray(nextRole.fallback)) nextRole.fallback = nextRole.fallback.filter(f => f.route !== route);

    if (target === 'base') {
      nextBase.roles ??= {};
      nextBase.roles[role] = nextRole;
    } else {
      nextLocal.roles ??= {};
      nextLocal.roles[role] = nextRole;
    }
    touched.roles.add(role);
  }

  if (changes.leaderModelPolicy !== undefined) {
    if (target === 'base') {
      nextBase.team ??= {};
      nextBase.team.leaderModelPolicy = changes.leaderModelPolicy;
    } else {
      nextLocal.team ??= {};
      nextLocal.team.leaderModelPolicy = changes.leaderModelPolicy;
    }
    touched.leaderModelPolicy = true;
  }

  // 5b. Optional detachable plugins / timer / planArchive settings
  if (isPlainObj(changes.setPlugins)) {
    const dest = target === 'base' ? nextBase : nextLocal;
    dest.plugins = { ...(dest.plugins ?? {}), ...changes.setPlugins };
  }
  if (isPlainObj(changes.setTimer)) {
    const dest = target === 'base' ? nextBase : nextLocal;
    dest.timer = { ...(dest.timer ?? {}), ...changes.setTimer };
  }
  if (isPlainObj(changes.setPlanArchive)) {
    const dest = target === 'base' ? nextBase : nextLocal;
    dest.planArchive = { ...(dest.planArchive ?? {}), ...changes.setPlanArchive };
  }
  if (isPlainObj(changes.setPowerMonitor)) {
    const dest = target === 'base' ? nextBase : nextLocal;
    dest.powerMonitor = { ...(dest.powerMonitor ?? {}), ...changes.setPowerMonitor };
  }
  if (isPlainObj(changes.setRequestWindow)) {
    const dest = target === 'base' ? nextBase : nextLocal;
    dest.requestWindow = { ...(dest.requestWindow ?? {}), ...changes.setRequestWindow };
  }

  // Auto-unblock disabledFamilies when a user explicitly enables or assigns a model of that family
  if ((changes.poolDisableFamilies?.length ?? 0) === 0) {
    const previewMerged = deepMergePlain(nextBase, nextLocal);
    const activeRoutes = new Set([
      ...(previewMerged.team?.executionPool ?? []),
      ...Object.values(previewMerged.roles ?? {}).flatMap(r => [r?.route, ...(r?.fallback ?? []).map(f => f?.route)]).filter(Boolean),
    ]);
    const activeFams = new Set([...activeRoutes].map(r => previewMerged.models?.[r]?.family).filter(Boolean));
    const curDisabledFams = previewMerged.team?.disabledFamilies ?? [];
    if (Array.isArray(curDisabledFams) && curDisabledFams.some(f => activeFams.has(f))) {
      const filteredFams = curDisabledFams.filter(f => !activeFams.has(f));
      if (target === 'base') {
        nextBase.team ??= {};
        nextBase.team.disabledFamilies = filteredFams;
      } else {
        nextLocal.team ??= {};
        nextLocal.team.disabledFamilies = filteredFams;
      }
    }
  }

  pruneEmptyObjects(nextLocal);

  // 6. Strict validation of BOTH standalone base and merged (base + local) before any disk write
  const validatedBase = validateConfig(nextBase);
  const hasEffectiveLocal = hasExistingLocal || Object.keys(nextLocal).length > 0;
  const mergedRaw = hasEffectiveLocal ? deepMergePlain(nextBase, nextLocal) : nextBase;
  const effective = validateConfig(mergedRaw);

  // 7. Detect local overrides shadowing base edits
  const shadowedByLocal = [];
  if (target === 'base' && hasExistingLocal) {
    if (touched.pool && Array.isArray(nextLocal.team?.executionPool)) {
      if (JSON.stringify(nextLocal.team.executionPool) !== JSON.stringify(nextBase.team.executionPool)) {
        shadowedByLocal.push('team.executionPool');
      }
    }
    if (touched.leaderModelPolicy && nextLocal.team?.leaderModelPolicy !== undefined && nextLocal.team.leaderModelPolicy !== nextBase.team.leaderModelPolicy) {
      shadowedByLocal.push('team.leaderModelPolicy');
    }
    for (const role of touched.roles) {
      if (isPlainObj(nextLocal.roles?.[role])) {
        if (JSON.stringify(effective.roles[role]) !== JSON.stringify(validatedBase.roles[role])) {
          shadowedByLocal.push(`roles.${role}`);
        }
      }
    }
    for (const route of touched.models) {
      if (isPlainObj(nextLocal.models?.[route])) {
        if (JSON.stringify(effective.models[route]) !== JSON.stringify(validatedBase.models[route])) {
          shadowedByLocal.push(`models["${route}"]`);
        }
      }
    }
    if (shadowedByLocal.length > 0) {
      warnings.push(`leaderteam.local.json overrides [${shadowedByLocal.join(', ')}] at runtime; pass --local to edit or --clear-local-* to remove the local override`);
    }
  }

  // 8. Compute target serialization & Magpie YAML patch template updates
  const targetFile = target === 'base' ? configFile : localFile;
  const serializedTarget = JSON.stringify(target === 'base' ? nextBase : nextLocal, null, 2) + '\n';
  const prevTargetText = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : null;
  const targetChanged = (target === 'local' && !hasExistingLocal && Object.keys(nextLocal).length === 0)
    ? false
    : (prevTargetText === null || prevTargetText.replace(/\r\n/g, '\n') !== serializedTarget.replace(/\r\n/g, '\n'));

  const prevLocalText = localClearedInBaseMode && fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8') : null;
  const serializedLocalInBaseMode = localClearedInBaseMode ? (JSON.stringify(nextLocal, null, 2) + '\n') : null;
  const sidecarLocalChanged = Boolean(
    localClearedInBaseMode &&
    prevLocalText !== null &&
    serializedLocalInBaseMode !== null &&
    prevLocalText.replace(/\r\n/g, '\n') !== serializedLocalInBaseMode.replace(/\r\n/g, '\n'),
  );

  const patchWrites = [];
  if (target === 'base' && options.syncPatches !== false) {
    const patchFiles = options.patchFiles ?? defaultPatchTargets(configFile);
    const rows = renderMagpieModelRows(validatedBase);
    const forceModelPatchSync = targetChanged && (touched.models.size > 0 || touched.removedModels.size > 0);
    for (const pf of patchFiles) {
      const curYaml = fs.readFileSync(pf, 'utf8');
      const nextYaml = rewriteModelsBlock(curYaml, rows);
      if (curYaml.replace(/\r\n/g, '\n') !== nextYaml.replace(/\r\n/g, '\n') || forceModelPatchSync) {
        patchWrites.push({ file: pf, content: nextYaml });
      }
    }
  }

  const changed = targetChanged || sidecarLocalChanged || patchWrites.length > 0;
  const beforeGovernance = governanceSettings(target === 'base' ? baseRaw : localRaw);
  const afterGovernance = governanceSettings(target === 'base' ? nextBase : nextLocal);
  const governanceChanged = hashJson(beforeGovernance) !== hashJson(afterGovernance);
  const auditDir = target === 'local' ? path.dirname(targetFile) : path.dirname(configFile);
  const auditFile = path.join(auditDir, 'governance-changes.jsonl');
  let backupPath = null;
  let auditId = null;
  if (!dryRun && changed) {
    if (options.backupDir) {
      backupPath = backupFiles(
        [targetFile, ...(sidecarLocalChanged ? [localFile] : []), ...patchWrites.map(w => w.file)],
        path.resolve(options.backupDir),
      );
    }
    if (governanceChanged) {
      auditId = randomUUID();
      // Persist intent before touching config: a crash remains visible as an unfinished change.
      appendJsonl(auditFile, { v: 1, id: auditId, event: 'prepared', at: new Date().toISOString(),
        actor: { user: process.env.USERNAME ?? process.env.USER ?? 'unknown', pid: process.pid },
        target, targetFile, before: beforeGovernance, after: afterGovernance,
        beforeSha256: hashJson(target === 'base' ? baseRaw : localRaw),
        afterSha256: hashJson(target === 'base' ? nextBase : nextLocal) });
    }
    const plannedWrites = [
      ...(targetChanged ? [{ file: targetFile, content: serializedTarget }] : []),
      ...(sidecarLocalChanged ? [{ file: localFile, content: serializedLocalInBaseMode }] : []),
      ...patchWrites,
    ];
    writeFilesTransactional(plannedWrites);
    if (auditId) appendJsonl(auditFile, { v: 1, id: auditId, event: 'applied', at: new Date().toISOString() });
  }

  const desktopSync = inspectDesktopSync(effective, {
    dshHome: options.dshHome,
    profile: options.profile,
    configFile,
    projectRoot: options.projectRoot,
  });

  return {
    target,
    targetFile,
    configFile,
    localFile,
    dryRun,
    changed,
    saved: !dryRun && changed,
    backupPath,
    governanceAudit: { changed: governanceChanged, file: auditFile, id: auditId, appliesTo: 'new-team' },
    patchesUpdated: patchWrites.map(w => w.file),
    shadowedByLocal,
    warnings,
    writtenConfig: target === 'base' ? nextBase : nextLocal,
    effective: {
      leaderModelPolicy: effective.team.leaderModelPolicy,
      executionPool: [...effective.team.executionPool],
      roles: structuredClone(effective.roles),
      models: structuredClone(effective.models),
      plugins: structuredClone(effective.plugins),
      timer: structuredClone(effective.timer),
      planArchive: structuredClone(effective.planArchive),
      powerMonitor: structuredClone(effective.powerMonitor),
      requestWindow: structuredClone(effective.requestWindow),
    },
    desktopSync,
  };
}
