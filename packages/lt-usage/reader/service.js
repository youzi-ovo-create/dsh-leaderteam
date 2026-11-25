import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  aggregateOverview,
  buildReport,
  defaultPricing,
  foldMembers,
  parseJsonl
} from '../core/index.js';
import { fileSignature, readSessionFile } from './decode.js';
import { homeLabel, listKnownHomes } from './homes.js';

const SESSION_FILE = 'session.v4.jsonl.zstd';

export function loadPricingFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || !raw.routes || typeof raw.routes !== 'object') {
    throw new Error('pricing file must contain a routes object');
  }
  const usdToCny = Number(raw.usdToCny);
  return {
    usdToCny: Number.isFinite(usdToCny) && usdToCny > 0 ? usdToCny : defaultPricing.usdToCny,
    routes: raw.routes
  };
}

function walkSessions(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSessions(full));
    else if (entry.name === SESSION_FILE) out.push(full);
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function signatureOf(parts) {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(String(part)).update('|');
  return hash.digest('hex').slice(0, 16);
}

export function loadHome(home) {
  const files = walkSessions(path.join(home, 'sessions'));
  const sessions = files.map(readSessionFile);
  const byId = new Map();
  for (const session of sessions) {
    if (!byId.has(session.id)) byId.set(session.id, session);
  }
  return { home, files, sessions, byId };
}

export function teamDir(home, sessionId) {
  return path.join(home, 'leaderteam', 'teams', sessionId);
}

export function isTeam(home, sessionId) {
  const dir = teamDir(home, sessionId);
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return (
    fs.existsSync(path.join(dir, 'members.jsonl')) || fs.existsSync(path.join(dir, 'team.json'))
  );
}

export function listTeamIds(home) {
  const dir = path.join(home, 'leaderteam', 'teams');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function collectMemberOwnerMap(home) {
  const memberToTeam = new Map();
  for (const teamId of listTeamIds(home)) {
    if (!isTeam(home, teamId)) continue;
    try {
      const members = foldMembers(readJsonl(path.join(teamDir(home, teamId), 'members.jsonl')));
      for (const member of members.values()) {
        if (member.childId) memberToTeam.set(member.childId, teamId);
      }
    } catch {
      // keep scanning other teams
    }
  }
  return memberToTeam;
}

function markSessionErrors(report, sessions) {
  for (const session of sessions) {
    if (session.error) {
      report.meta.complete = false;
      report.meta.notes.push(`decode error ${session.id}: ${session.error.message ?? session.error}`);
    }
  }
}

function teamMeta(home, sessionId) {
  const dir = teamDir(home, sessionId);
  const team = readJson(path.join(dir, 'team.json'));
  const timer = readJson(path.join(dir, 'timer.json'));
  return {
    teamId: team?.teamId ?? sessionId,
    activeSec: Number.isFinite(timer?.teamActiveMs) ? Math.round(timer.teamActiveMs / 1000) : null
  };
}

function gateSummaryOf(gateRecords, governance) {
  let allow = 0;
  let deny = 0;
  let modelReviews = 0;
  for (const record of gateRecords) {
    if (record?.decision === 'allow') allow++;
    else if (record?.decision === 'deny') deny++;
    const byText =
      typeof record?.by === 'string'
        ? record.by
        : record?.by == null
          ? ''
          : JSON.stringify(record.by);
    if (/model/i.test(byText)) modelReviews++;
  }
  return {
    reviews: gateRecords.length,
    allow,
    deny,
    modelReviews,
    degraded: governance.filter((record) => record?.degraded).length
  };
}

const REPORT_CACHE = new Map();
const MAX_REPORT_CACHE = 160;

function pricingSignatureOf(pricing) {
  return signatureOf([JSON.stringify(pricing ?? defaultPricing)]);
}

function gatewaySignatureOf(gatewayRecords) {
  if (!Array.isArray(gatewayRecords) || gatewayRecords.length === 0) return 'gw:0';
  return `gw:${gatewayRecords.length}:${gatewayRecords.at(-1)?.gatewayRecordId ?? gatewayRecords.at(-1)?.seq ?? ''}`;
}

function getCachedOrCompute(cacheKey, compute) {
  if (REPORT_CACHE.has(cacheKey)) return REPORT_CACHE.get(cacheKey);
  const val = compute();
  if (REPORT_CACHE.size >= MAX_REPORT_CACHE) {
    const oldest = REPORT_CACHE.keys().next().value;
    if (oldest !== undefined) REPORT_CACHE.delete(oldest);
  }
  REPORT_CACHE.set(cacheKey, val);
  return val;
}

function buildTeamResult(home, data, sessionId, pricing, options = {}) {
  const leader = data.byId.get(sessionId);
  const dir = teamDir(home, sessionId);
  const membersFile = path.join(dir, 'members.jsonl');
  const usageFile = path.join(dir, 'usage.jsonl');
  const gateFile = path.join(dir, 'gate.jsonl');
  const timerFile = path.join(dir, 'timer.json');
  const teamFile = path.join(dir, 'team.json');

  const members = foldMembers(readJsonl(membersFile));
  const governance = readJsonl(usageFile);
  const memberSessions = [];
  for (const member of members.values()) {
    const session = data.byId.get(member.childId);
    if (session) memberSessions.push(session);
  }
  const sessions = [leader, ...memberSessions];
  const seenSessionIds = new Set(sessions.filter(Boolean).map((s) => s.id));
  for (const rootSess of [leader, ...memberSessions]) {
    if (!rootSess) continue;
    for (const desc of collectDescendants(data, rootSess)) {
      if (!desc?.id || seenSessionIds.has(desc.id)) continue;
      if (isTeam(home, desc.id)) continue;
      seenSessionIds.add(desc.id);
      sessions.push(desc);
    }
  }
  const signature = signatureOf([
    ...sessions.map((session) => `${session.file}:${session.sig}`),
    fileSignature(membersFile),
    fileSignature(usageFile),
    fileSignature(gateFile),
    fileSignature(timerFile),
    fileSignature(teamFile)
  ]);
  const cacheKey = `team|${sessionId}|${signature}|${pricingSignatureOf(pricing)}|${gatewaySignatureOf(options.gatewayRecords)}`;
  return getCachedOrCompute(cacheKey, () => {
    const report = buildReport({
      home,
      sessionId,
      sessions,
      governance,
      members,
      pricing,
      gatewayRecords: options.gatewayRecords,
      kind: 'team'
    });
    markSessionErrors(report, sessions);
    const info = teamMeta(home, sessionId);
    report.team = {
      teamId: info.teamId,
      activeSec: info.activeSec,
      membersTotal: members.size
    };
    if (fs.existsSync(gateFile)) {
      report.team.gateSummary = gateSummaryOf(readJsonl(gateFile), governance);
    }
    return { report, signature };
  });
}

function collectDescendants(data, root) {
  const children = new Map();
  for (const session of data.sessions) {
    const parent = session.header?.parentSession;
    if (!parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(session);
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0) ||
        String(a.id).localeCompare(String(b.id))
    );
  }
  const ordered = [root];
  const seen = new Set([root.id]);
  for (let i = 0; i < ordered.length; i++) {
    for (const child of children.get(ordered[i].id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      ordered.push(child);
    }
  }
  return ordered;
}

function buildSessionResult(home, data, sessionId, pricing, options = {}) {
  const root = data.byId.get(sessionId);
  const sessions = collectDescendants(data, root);
  const signature = signatureOf(sessions.map((session) => `${session.file}:${session.sig}`));
  const cacheKey = `session|${sessionId}|${signature}|${pricingSignatureOf(pricing)}|${gatewaySignatureOf(options.gatewayRecords)}`;
  return getCachedOrCompute(cacheKey, () => {
    const report = buildReport({
      home,
      sessionId,
      sessions,
      pricing,
      gatewayRecords: options.gatewayRecords,
      kind: 'session'
    });
    markSessionErrors(report, sessions);
    return { report, signature };
  });
}

export function reportFor(home, sessionId, pricing = defaultPricing, options = {}) {
  const data = loadHome(home);
  if (!data.byId.has(sessionId)) return null;
  return isTeam(home, sessionId)
    ? buildTeamResult(home, data, sessionId, pricing, options)
    : buildSessionResult(home, data, sessionId, pricing, options);
}

export function listSessions(home, pricing = defaultPricing, options = {}) {
  const data = loadHome(home);
  const memberToTeam = collectMemberOwnerMap(home);
  const rows = [];
  const seen = new Set();
  for (const session of data.sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    const parentSessionId = session.header?.parentSession ?? null;
    let teamId = memberToTeam.get(session.id) ?? null;
    if (!teamId && parentSessionId) {
      let curParent = parentSessionId;
      const visited = new Set([session.id]);
      while (curParent && !visited.has(curParent)) {
        visited.add(curParent);
        if (isTeam(home, curParent)) {
          teamId = curParent;
          break;
        }
        if (memberToTeam.has(curParent)) {
          teamId = memberToTeam.get(curParent);
          break;
        }
        curParent = data.byId.get(curParent)?.header?.parentSession ?? null;
      }
    }
    const isChild = Boolean(teamId || (parentSessionId && data.byId.has(parentSessionId)));
    let result;
    try {
      result = isTeam(home, session.id)
        ? buildTeamResult(home, data, session.id, pricing, options)
        : buildSessionResult(home, data, session.id, pricing, options);
    } catch (err) {
      rows.push({
        id: session.id,
        kind: 'session',
        cwd: session.header?.cwd ?? null,
        parentSessionId,
        teamId,
        isChild,
        startedAtMs: session.header?.createdAt ?? null,
        lastActivityMs: null,
        callsTotal: 0,
        totalTokens: 0,
        memberCount: 0,
        signature: session.sig,
        error: err.message ?? String(err)
      });
      continue;
    }
    const { report, signature } = result;
    const row = {
      id: report.meta.sessionId,
      kind: report.meta.kind,
      cwd: report.meta.cwd ?? null,
      parentSessionId,
      teamId,
      isChild
    };
    if (report.meta.title !== undefined) row.title = report.meta.title;
    row.startedAtMs = report.meta.startedAtMs;
    row.lastActivityMs = report.meta.lastActivityMs;
    row.callsTotal = report.totals.callsTotal;
    row.totalTokens = report.totals.totalTokens;
    row.memberCount =
      report.meta.kind === 'team'
        ? (report.team?.membersTotal ?? 0)
        : Math.max(0, report.agents.length - 1);
    row.signature = signature;
    rows.push(row);
  }
  rows.sort(
    (a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0) || String(a.id).localeCompare(String(b.id))
  );
  return rows;
}

export function overviewFor(home, pricing = defaultPricing, options = {}) {
  const data = loadHome(home);
  const memberToTeam = collectMemberOwnerMap(home);
  const reports = [];
  const errors = [];
  const signatures = new Map();
  const seen = new Set();
  for (const session of data.sessions) {
    if (session.header?.parentSession) continue;
    if (memberToTeam.has(session.id)) continue;
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    if (session.error) {
      errors.push({
        sessionId: session.id,
        error: session.error?.message ?? String(session.error)
      });
      continue;
    }
    try {
      const result = isTeam(home, session.id)
        ? buildTeamResult(home, data, session.id, pricing, options)
        : buildSessionResult(home, data, session.id, pricing, options);
      reports.push(result.report);
      signatures.set(session.id, result.signature);
    } catch (err) {
      errors.push({
        sessionId: session.id,
        error: err?.message ?? String(err)
      });
    }
  }
  const overview = aggregateOverview(reports, { errors });
  for (const row of overview.sessions) {
    row.signature = signatures.get(row.sessionId) ?? null;
  }
  return overview;
}

export function homesInfo(explicit) {
  const out = [];
  for (const home of listKnownHomes(explicit)) {
    const files = walkSessions(path.join(home, 'sessions'));
    const teamCount = listTeamIds(home).filter((id) => isTeam(home, id)).length;
    out.push({
      path: home,
      label: homeLabel(home),
      sessionCount: files.length,
      teamCount
    });
  }
  return out;
}
