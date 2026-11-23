#!/usr/bin/env node
// Privacy-preserving, strictly redacted GitHub Issue diagnostics generator for LeaderTeam V2.2.
// Pure Node ESM, zero external npm dependencies.
// Aggregates counts and 4-bucket token totals ONLY — never emits prompts, paths, arguments, or secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeId } from '../leaderteam/core/store.mjs';
import { checkDshHostCompatibility } from './lt-doctor.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..');

const KNOWN_ROLES = Object.freeze([
  'leader',
  'gate',
  'discussA',
  'discussB',
  'arbiter',
  'serialReviewer',
  'directExec',
]);

const KNOWN_FAMILIES = new Set(['gpt', 'glm', 'gemini', 'deepseek', 'claude', 'qwen', 'other']);
const SAFE_STATUS_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const SAFE_RULE_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/i;
const SAFE_EFFORT_RE = /^(?:none|off|minimal|low|medium|high|xhigh|max)$/;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scrub API keys, bearer tokens, hex/base64 secrets, URLs, Windows/POSIX personal & drive paths,
 * hostnames, and current OS username from any diagnostic string.
 */
export function redactDiagnosticText(input, options = {}) {
  let text = String(input ?? '');
  if (!text) return '';

  // 1. URLs (strip custom internal endpoints, userinfo, query tokens)
  text = text.replace(/\bhttps?:\/\/[^\s"'`<>|)\],;]+/gi, '<REDACTED_URL>');

  // 2. Bearer / Basic auth headers & inline key=value secrets
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [REDACTED_TOKEN]');
  text = text.replace(
    /((?:api[_-]?key|token|secret|password|passwd|pwd|authorization|credential|private[_-]?key|access[_-]?key)\s*[:=]\s*["']?)([^\s"';&|,)\]}]+)/gi,
    '$1[REDACTED]',
  );

  // 3. Provider & API key prefixes (sk-..., ak-..., ghp_..., github_pat_..., xoxb-..., AIza...)
  text = text.replace(/\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_KEY]');

  // 4. Windows & POSIX personal home paths (supports both raw `\` and JSON-escaped `\\`)
  text = text.replace(/[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)[^\s"'`<>|),;]+/gi, '<USER_HOME>/<REDACTED>');
  text = text.replace(/(?:^|(?<=[\s"'`(=:]))\/(?:home|Users)\/[^\s"'`<>|),;]+/g, '<USER_HOME>/<REDACTED>');
  text = text.replace(/(?:^|(?<=[\s"'`(=:]))\/root\/[^\s"'`<>|),;]+/g, '<USER_HOME>/<REDACTED>');

  // 5. Arbitrary Windows drive paths (e.g. E:\..., D:/..., C:\...)
  text = text.replace(/[A-Za-z]:(?:\\\\|\\|\/)[^\s"'`<>|),;]+/g, '<LOCAL_PATH>/<REDACTED>');
  text = text.replace(/\bfile:\/\/\/[^\s"'`<>|),;]+/gi, '<LOCAL_PATH>/<REDACTED>');

  // 6. Long hex (>=32 chars) and high-entropy base64 secrets (>=32 chars with mixed case + digits)
  text = text.replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED_SECRET]');
  text = text.replace(/\b(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]{32,}={0,2}\b/g, '[REDACTED_SECRET]');

  // 7. Scrub current OS hostname and username
  const sensitiveIdentities = new Set();
  try {
    const hn = options.hostname ?? os.hostname();
    if (typeof hn === 'string' && hn.trim().length >= 2) sensitiveIdentities.add(hn.trim());
  } catch {}
  try {
    const un = options.username ?? os.userInfo().username;
    if (typeof un === 'string' && un.trim().length >= 2) sensitiveIdentities.add(un.trim());
  } catch {}
  if (Array.isArray(options.extraRedactions)) {
    for (const item of options.extraRedactions) {
      if (typeof item === 'string' && item.trim().length >= 2) sensitiveIdentities.add(item.trim());
    }
  }
  const SAFE_SYSTEM_WORDS = new Set([
    'node', 'linux', 'win32', 'darwin', 'x64', 'arm64', 'user', 'root', 'test', 'main', 'true', 'false', 'null',
  ]);
  for (const ident of sensitiveIdentities) {
    if (SAFE_SYSTEM_WORDS.has(ident.toLowerCase())) continue;
    text = text.replace(new RegExp(escapeRegExp(ident), 'gi'), '<REDACTED_IDENTITY>');
  }

  return text;
}

/** Tolerant JSONL reader for diagnostics: skips blank or torn/corrupt lines instead of crashing bugreport. */
function readJsonlTolerant(file, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch {
    return { records: [], skippedLines: 0, present: false };
  }
  const records = [];
  let skippedLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') records.push(parsed);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  return { records, skippedLines, present: true };
}

function readJsonOptional(file, fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

function readLtVersion(fsImpl = fs) {
  for (const rel of ['package.json', 'leaderteam/package.json']) {
    const pkg = readJsonOptional(path.join(REPO_ROOT, rel), fsImpl);
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim();
  }
  return 'unknown';
}

function inferFamilyFromRoute(route, modelsMap) {
  if (typeof route !== 'string' || !route) return 'unknown';
  const configuredFamily = modelsMap?.[route]?.family;
  if (typeof configuredFamily === 'string' && KNOWN_FAMILIES.has(configuredFamily)) {
    return configuredFamily;
  }
  const lower = route.toLowerCase();
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('qwen') || lower.includes('bailian') || lower.includes('dashscope')) return 'qwen';
  if (lower.includes('glm') || lower.includes('zhipu') || lower.includes('zcode')) return 'glm';
  if (lower.includes('claude') || lower.includes('anthropic')) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('gpt') || lower.includes('codex') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'gpt';
  return 'other';
}

function sanitizeConfigSummary(rawCfg) {
  if (!rawCfg || typeof rawCfg !== 'object') {
    return {
      present: false,
      governanceMode: 'unknown',
      powerMonitorEnabled: true,
      roleFamilies: {},
      plugins: { scheduler: true, consensus: true, timerArchive: true, panel: true },
    };
  }
  const governanceMode = rawCfg.governance?.mode === 'approval'
    ? 'approval'
    : (rawCfg.governance?.mode === 'autonomous' ? 'autonomous' : 'autonomous');
  const powerMonitorEnabled = rawCfg.powerMonitor?.enabled !== false;

  const roleFamilies = {};
  const modelsMap = (rawCfg.models && typeof rawCfg.models === 'object') ? rawCfg.models : {};
  if (rawCfg.roles && typeof rawCfg.roles === 'object') {
    for (const role of KNOWN_ROLES) {
      const spec = rawCfg.roles[role];
      if (!spec || typeof spec !== 'object') continue;
      const family = inferFamilyFromRoute(spec.route, modelsMap);
      const effort = (typeof spec.effort === 'string' && SAFE_EFFORT_RE.test(spec.effort)) ? spec.effort : 'default';
      const fallbackCount = Array.isArray(spec.fallback) ? spec.fallback.length : 0;
      roleFamilies[role] = { family, effort, fallbackCount };
    }
  }

  const plugins = {
    scheduler: rawCfg.plugins?.scheduler !== false,
    consensus: rawCfg.plugins?.consensus !== false,
    timerArchive: rawCfg.plugins?.timerArchive !== false,
    panel: rawCfg.plugins?.panel !== false,
  };

  return {
    present: true,
    governanceMode,
    powerMonitorEnabled,
    roleFamilies,
    plugins,
  };
}

function sanitizeRuleCode(rawRule) {
  if (typeof rawRule !== 'string' || !rawRule.trim()) return 'unspecified';
  const trimmed = rawRule.trim();
  // Reject anything that looks like a path, secret, or free-form sentence
  if (
    trimmed.includes('/')
    || trimmed.includes('\\')
    || trimmed.includes(' ')
    || /^sk-/i.test(trimmed)
    || !SAFE_RULE_RE.test(trimmed)
  ) {
    return 'other-rule';
  }
  return trimmed;
}

function sanitizeRoleKey(rawRole) {
  if (typeof rawRole !== 'string' || !rawRole.trim()) return 'other';
  const trimmed = rawRole.trim();
  if (KNOWN_ROLES.includes(trimmed) || ['member', 'execution', 'investigator'].includes(trimmed)) {
    return trimmed;
  }
  return 'other';
}

function sanitizeMemberStatus(rawStatus) {
  if (typeof rawStatus !== 'string' || !rawStatus.trim()) return 'unknown';
  const lower = rawStatus.trim().toLowerCase();
  if (['done', 'blocked', 'failed', 'cancelled', 'paused', 'running', 'started', 'starting'].includes(lower)) {
    return lower;
  }
  return SAFE_STATUS_RE.test(lower) ? 'other' : 'unknown';
}

function selectTeamDirectory(storageRoot, explicitTeamId, fsImpl = fs) {
  const teamsRoot = path.join(storageRoot, 'teams');
  if (explicitTeamId) {
    const cleanId = safeId(explicitTeamId);
    const dir = path.join(teamsRoot, cleanId);
    try {
      if (fsImpl.existsSync(dir) && fsImpl.statSync(dir).isDirectory()) return dir;
    } catch {}
    return null;
  }
  let entries;
  try {
    entries = fsImpl.readdirSync(teamsRoot, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const scored = entries.map(d => {
    const dir = path.join(teamsRoot, d.name);
    let latestMs = 0;
    try { latestMs = Math.max(latestMs, fsImpl.statSync(dir).mtimeMs); } catch {}
    for (const f of ['team.json', 'gate.jsonl', 'usage.jsonl', 'governance.jsonl', 'members.jsonl']) {
      try { latestMs = Math.max(latestMs, fsImpl.statSync(path.join(dir, f)).mtimeMs); } catch {}
    }
    const teamMeta = readJsonOptional(path.join(dir, 'team.json'), fsImpl);
    if (typeof teamMeta?.createdAt === 'string') {
      const parsed = Date.parse(teamMeta.createdAt);
      if (Number.isFinite(parsed)) latestMs = Math.max(latestMs, parsed);
    }
    return { name: d.name, dir, latestMs };
  });
  scored.sort((a, b) => (b.latestMs - a.latestMs) || b.name.localeCompare(a.name));
  return scored[0].dir;
}

function toSafeNonNegInt(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function extract4BucketUsage(rec) {
  const u = (rec?.usage && typeof rec.usage === 'object') ? rec.usage : rec;
  const inputTokens = toSafeNonNegInt(u?.inputTokens ?? u?.input_tokens ?? 0);
  const cacheReadTokens = toSafeNonNegInt(u?.cacheReadTokens ?? u?.cache_read_tokens ?? 0);
  const cacheWriteTokens = toSafeNonNegInt(u?.cacheWriteTokens ?? u?.cache_write_tokens ?? 0);
  const outputTokens = toSafeNonNegInt(u?.outputTokens ?? u?.output_tokens ?? 0);
  const computedSum = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  const reportedTotal = toSafeNonNegInt(u?.totalTokens ?? u?.total_tokens ?? 0);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : computedSum,
  };
}

function emptyBucket() {
  return {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function addBucket(target, delta) {
  target.calls += 1;
  target.inputTokens += delta.inputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.outputTokens += delta.outputTokens;
  target.totalTokens += delta.totalTokens;
}

function aggregateTeamMetrics(teamDir, fsImpl = fs) {
  if (!teamDir) {
    return {
      teamFound: false,
      filesPresent: [],
      totalMembers: 0,
      membersByStatus: {},
      gate: { total: 0, allow: 0, deny: 0, byRule: { allow: {}, deny: {} } },
      usageByRole: {},
      usageTotal: emptyBucket(),
      governance: {
        supervisionReviews: 0,
        strikes: 0,
        caucuses: 0,
        conferencesOpened: 0,
        conferencesConcluded: 0,
        humanEscalations: 0,
        requestWindowEvents: 0,
        lowBatteryEvents: 0,
      },
    };
  }

  const filesPresent = [];
  for (const name of ['team.json', 'governance.json', 'members.jsonl', 'gate.jsonl', 'usage.jsonl', 'governance.jsonl']) {
    if (fsImpl.existsSync(path.join(teamDir, name))) filesPresent.push(name);
  }

  // 1. Fold members.jsonl -> counts by status ONLY (never emit member names, errors, or checkpoints)
  const memberStates = new Map();
  let anonIdx = 0;
  const membersData = readJsonlTolerant(path.join(teamDir, 'members.jsonl'), fsImpl);
  for (const r of membersData.records) {
    const id = typeof r.childId === 'string' ? r.childId : (typeof r.id === 'string' ? r.id : null);
    if (r.type === 'member' || (!r.type && id)) {
      const key = id ?? `m_${++anonIdx}`;
      memberStates.set(key, sanitizeMemberStatus(r.status ?? 'starting'));
    } else if (r.type === 'member-status' && id) {
      memberStates.set(id, sanitizeMemberStatus(r.status));
    }
  }
  const membersByStatus = {};
  for (const st of memberStates.values()) {
    membersByStatus[st] = (membersByStatus[st] ?? 0) + 1;
  }

  // 2. Aggregate gate.jsonl -> allow/deny counts by rule code ONLY (NO file paths or command arguments!)
  const gateData = readJsonlTolerant(path.join(teamDir, 'gate.jsonl'), fsImpl);
  const gate = { total: 0, allow: 0, deny: 0, byRule: { allow: {}, deny: {} } };
  for (const r of gateData.records) {
    const decision = r.decision === 'allow' ? 'allow' : (r.decision === 'deny' ? 'deny' : null);
    if (!decision) continue;
    const code = sanitizeRuleCode(r.by ?? (typeof r.rule === 'string' ? `rule:${r.rule}` : 'unspecified'));
    gate.total += 1;
    gate[decision] += 1;
    gate.byRule[decision][code] = (gate.byRule[decision][code] ?? 0) + 1;
  }

  // 3. Aggregate usage.jsonl -> 4-bucket physical token totals by role ONLY
  const usageData = readJsonlTolerant(path.join(teamDir, 'usage.jsonl'), fsImpl);
  const usageByRole = {};
  const usageTotal = emptyBucket();
  for (const r of usageData.records) {
    const role = sanitizeRoleKey(r.role);
    const delta = extract4BucketUsage(r);
    usageByRole[role] ??= emptyBucket();
    addBucket(usageByRole[role], delta);
    addBucket(usageTotal, delta);
  }

  // 4. Aggregate governance.jsonl (+ workflow.jsonl if present) -> strike/conference/request-window/low-battery counts ONLY
  const govData = readJsonlTolerant(path.join(teamDir, 'governance.jsonl'), fsImpl);
  const wfData = readJsonlTolerant(path.join(teamDir, 'workflow.jsonl'), fsImpl);
  const governance = {
    supervisionReviews: 0,
    strikes: 0,
    caucuses: 0,
    conferencesOpened: 0,
    conferencesConcluded: 0,
    humanEscalations: 0,
    requestWindowEvents: 0,
    lowBatteryEvents: 0,
  };

  for (const ev of [...govData.records, ...wfData.records]) {
    const t = String(ev?.type ?? ev?.kind ?? '').toLowerCase();
    const action = String(ev?.action ?? '').toLowerCase();
    if (t === 'supervision-completed' || t === 'stage1-supervision') {
      governance.supervisionReviews += 1;
    } else if (t === 'dispute-strike-recorded' || t === 'strike-recorded' || t === 'dispute-strike') {
      governance.strikes += 1;
    } else if (t === 'caucus-completed') {
      governance.caucuses += 1;
    } else if (t === 'conference-opened') {
      governance.conferencesOpened += 1;
    } else if (t === 'conference-concluded') {
      governance.conferencesConcluded += 1;
    } else if (t === 'human-escalation-opened') {
      governance.humanEscalations += 1;
    }

    if (t.includes('request-window') || t.includes('request_window')) {
      governance.requestWindowEvents += 1;
    }
    if (
      t.includes('low-battery')
      || t.includes('low_battery')
      || t.includes('power-shutdown')
      || action === 'notify_graceful_shutdown'
      || (t.includes('power-monitor') && action !== 'none' && action !== 'rearmed')
    ) {
      governance.lowBatteryEvents += 1;
    }
  }

  return {
    teamFound: true,
    filesPresent,
    totalMembers: memberStates.size,
    membersByStatus,
    gate,
    usageByRole,
    usageTotal,
    governance,
  };
}

function renderMarkdownBlock({ environment, config, metrics }) {
  const lines = [
    '### LeaderTeam Redacted Diagnostics (`lt-bugreport`)',
    '',
    '#### 1. Environment Summary',
    `- **OS**: \`${environment.platform}\` (\`${environment.release}\`, \`${environment.arch}\`)`,
    `- **Node.js**: \`${environment.nodeVersion}\``,
    `- **LeaderTeam**: \`${environment.ltVersion}\``,
    `- **DSH Tools**: \`${environment.dshVersion}\` (\`${environment.dshClassification}\`)`,
    '',
    '#### 2. Sanitized Config Summary',
    `- **Governance Mode**: \`${config.governanceMode}\``,
    `- **Power Monitor Enabled**: \`${config.powerMonitorEnabled}\``,
    `- **Plugins**: \`scheduler=${config.plugins.scheduler}\`, \`consensus=${config.plugins.consensus}\`, \`timerArchive=${config.plugins.timerArchive}\`, \`panel=${config.plugins.panel}\``,
  ];

  const roleEntries = Object.entries(config.roleFamilies);
  if (roleEntries.length > 0) {
    const roleSummary = roleEntries
      .map(([r, info]) => `${r}:${info.family}@${info.effort}${info.fallbackCount ? `(+${info.fallbackCount}fb)` : ''}`)
      .join(', ');
    lines.push(`- **Role Families**: \`${roleSummary}\``);
  } else {
    lines.push('- **Role Families**: `(not configured)`');
  }

  lines.push('', '#### 3. Aggregate Team Metrics');
  if (!metrics.teamFound) {
    lines.push('- **Team Store**: No team session records found in target storage root.');
    return lines.join('\n');
  }

  const memberParts = Object.entries(metrics.membersByStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([st, count]) => `${st}=${count}`);
  lines.push(`- **Artifacts Present**: \`${metrics.filesPresent.join(', ') || 'none'}\``);
  lines.push(`- **Members (${metrics.totalMembers} total)**: \`${memberParts.join(', ') || 'none'}\``);
  lines.push(`- **Safety Gate Receipts**: \`total=${metrics.gate.total}\`, \`allow=${metrics.gate.allow}\`, \`deny=${metrics.gate.deny}\``);

  const allowRules = Object.entries(metrics.gate.byRule.allow)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code}:${n}`);
  const denyRules = Object.entries(metrics.gate.byRule.deny)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code}:${n}`);
  if (allowRules.length > 0) lines.push(`  - **Allow by Rule**: \`${allowRules.join(', ')}\``);
  if (denyRules.length > 0) lines.push(`  - **Deny by Rule**: \`${denyRules.join(', ')}\``);

  const g = metrics.governance;
  lines.push(
    `- **Governance & Guards**: \`supervisions=${g.supervisionReviews}\`, \`strikes=${g.strikes}\`, \`caucuses=${g.caucuses}\`, \`conferences=${g.conferencesOpened}/${g.conferencesConcluded}\`, \`humanEscalations=${g.humanEscalations}\`, \`requestWindowEvents=${g.requestWindowEvents}\`, \`lowBatteryEvents=${g.lowBatteryEvents}\``,
  );

  lines.push('', '#### 4. Physical 4-Bucket Token Ledger (by Role)');
  lines.push('| Role | Calls | Input | Cache Read | Cache Write | Output | Total |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  const roleRows = Object.entries(metrics.usageByRole).sort(([a], [b]) => a.localeCompare(b));
  for (const [role, b] of roleRows) {
    lines.push(`| \`${role}\` | ${b.calls} | ${b.inputTokens} | ${b.cacheReadTokens} | ${b.cacheWriteTokens} | ${b.outputTokens} | ${b.totalTokens} |`);
  }
  const tot = metrics.usageTotal;
  lines.push(`| **Total** | **${tot.calls}** | **${tot.inputTokens}** | **${tot.cacheReadTokens}** | **${tot.cacheWriteTokens}** | **${tot.outputTokens}** | **${tot.totalTokens}** |`);

  return lines.join('\n');
}

function deepScrubObject(value, redactOpts) {
  if (typeof value === 'string') return redactDiagnosticText(value, redactOpts);
  if (Array.isArray(value)) return value.map(item => deepScrubObject(item, redactOpts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[redactDiagnosticText(k, redactOpts)] = deepScrubObject(v, redactOpts);
    }
    return out;
  }
  return value;
}

/**
 * Generate a strictly redacted diagnostics bundle & GitHub Issue Markdown block.
 * Zero raw prompts, zero file paths, zero command arguments, zero API keys or usernames.
 */
export function generateRedactedBugReport(options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  const env = options.env ?? process.env;
  const dshHome = options.dshHome ?? env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const storageRoot = options.storageRoot
    ? path.resolve(options.storageRoot)
    : path.join(path.resolve(dshHome), 'leaderteam');

  const teamDir = selectTeamDirectory(storageRoot, options.teamId ?? null, fsImpl);

  // Locate config: team's frozen governance.json -> DSH_HOME config -> explicit config -> repo default
  let rawConfig = null;
  if (teamDir) {
    const govSnap = readJsonOptional(path.join(teamDir, 'governance.json'), fsImpl);
    if (govSnap?.config && typeof govSnap.config === 'object') rawConfig = govSnap.config;
    if (!rawConfig) {
      const teamMeta = readJsonOptional(path.join(teamDir, 'team.json'), fsImpl);
      if (teamMeta?.config && typeof teamMeta.config === 'object') rawConfig = teamMeta.config;
    }
  }
  if (!rawConfig) {
    const candidateConfigs = [
      options.configPath ? path.resolve(options.configPath) : null,
      env.LEADERTEAM_CONFIG ? path.resolve(env.LEADERTEAM_CONFIG) : null,
      path.join(path.resolve(dshHome), 'leaderteam', 'config', 'leaderteam.config.json'),
      path.join(REPO_ROOT, 'config', 'leaderteam.config.json'),
    ].filter(Boolean);
    for (const cFile of candidateConfigs) {
      const parsed = readJsonOptional(cFile, fsImpl);
      if (parsed) {
        rawConfig = parsed;
        break;
      }
    }
  }

  let dshVersion = 'not-detected';
  let dshClassification = 'NOT_FOUND';
  try {
    const dshCheck = checkDshHostCompatibility({
      checkHost: options.checkHost ?? null,
      env,
      fsImpl,
    });
    if (dshCheck.toolsVersion) dshVersion = dshCheck.toolsVersion;
    if (dshCheck.classification) dshClassification = dshCheck.classification;
  } catch {}

  const environment = {
    platform: options.platform ?? os.platform(),
    release: options.osRelease ?? os.release(),
    arch: options.arch ?? os.arch(),
    nodeVersion: options.nodeVersion ?? process.version,
    ltVersion: options.ltVersion ?? readLtVersion(fsImpl),
    dshVersion,
    dshClassification,
  };

  const config = sanitizeConfigSummary(rawConfig);
  const metrics = aggregateTeamMetrics(teamDir, fsImpl);

  const redactOpts = {
    hostname: options.hostname,
    username: options.username,
    extraRedactions: options.extraRedactions,
  };

  const scrubbedEnv = deepScrubObject(environment, redactOpts);
  const scrubbedConfig = deepScrubObject(config, redactOpts);
  const scrubbedMetrics = deepScrubObject(metrics, redactOpts);
  const markdown = redactDiagnosticText(
    renderMarkdownBlock({ environment: scrubbedEnv, config: scrubbedConfig, metrics: scrubbedMetrics }),
    redactOpts,
  );

  return {
    ok: true,
    environment: scrubbedEnv,
    config: scrubbedConfig,
    metrics: scrubbedMetrics,
    markdown,
  };
}

function parseCliArgs(argv) {
  const opts = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--storage-root' && argv[i + 1]) opts.storageRoot = argv[++i];
    else if (a === '--dsh-home' && argv[i + 1]) opts.dshHome = argv[++i];
    else if (a === '--team' && argv[i + 1]) opts.teamId = argv[++i];
    else if (a === '--out' && argv[i + 1]) opts.outFile = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return opts;
}

function printUsage() {
  console.log([
    'Usage: lt-bugreport [options]',
    '',
    'Options:',
    '  --storage-root <dir>        Path to leaderteam storage root (contains teams/)',
    '  --dsh-home <dir>            Override DSH_HOME directory',
    '  --team <teamId>             Specific team session ID (defaults to latest)',
    '  --out <file>                Write redacted report to file instead of stdout',
    '  --json                      Output redacted JSON instead of GitHub Issue Markdown',
    '  -h, --help                  Show this help message',
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.help) {
      printUsage();
      process.exit(0);
    }
    const report = generateRedactedBugReport(cli);
    const rendered = cli.json ? JSON.stringify(report, null, 2) : report.markdown;
    if (cli.outFile) {
      const target = path.resolve(cli.outFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rendered + '\n', 'utf8');
      console.log(`Redacted bug report written to ${target}`);
    } else {
      console.log(rendered);
    }
    process.exit(0);
  } catch (err) {
    console.error(`lt-bugreport error: ${redactDiagnosticText(err instanceof Error ? err.message : String(err))}`);
    process.exit(2);
  }
}
