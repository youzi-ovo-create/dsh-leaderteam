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
import { homeLabel, listKnownHomes, samePath } from './homes.js';

const SESSION_FILE = 'session.v4.jsonl.zstd';
const MAX_SAFE_SEGMENT_LEN = 192;

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

function isPricingObject(val) {
  return Boolean(val && typeof val === 'object' && val.routes && typeof val.routes === 'object');
}

function normalizePricingAndOptions(pricingOrOptions, maybeOptions) {
  if (maybeOptions !== undefined) {
    return {
      pricing: isPricingObject(pricingOrOptions) ? pricingOrOptions : defaultPricing,
      options: maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {}
    };
  }
  if (isPricingObject(pricingOrOptions)) {
    return { pricing: pricingOrOptions, options: {} };
  }
  if (pricingOrOptions && typeof pricingOrOptions === 'object') {
    const opts = pricingOrOptions;
    return {
      pricing: isPricingObject(opts.pricing) ? opts.pricing : defaultPricing,
      options: opts
    };
  }
  return { pricing: defaultPricing, options: {} };
}

export function resolveStorageRoot(home, options = {}) {
  if (typeof options?.storageRoot === 'string' && options.storageRoot.trim()) {
    return path.resolve(options.storageRoot.trim());
  }
  const resolvedHome = path.resolve(String(home));
  const candidates = [
    path.join(resolvedHome, 'leaderteam.local.json'),
    path.join(resolvedHome, 'leaderteam.json'),
    path.join(resolvedHome, 'leaderteam.config.json'),
    path.join(resolvedHome, 'leaderteam', 'config', 'leaderteam.local.json'),
    path.join(resolvedHome, 'leaderteam', 'config', 'leaderteam.config.json')
  ];
  for (const file of candidates) {
    const cfg = readJson(file);
    if (typeof cfg?.storage?.root === 'string' && cfg.storage.root.trim()) {
      return path.resolve(resolvedHome, cfg.storage.root.trim());
    }
  }
  return path.resolve(resolvedHome, 'leaderteam');
}

function resolveTeamsRoot(home, options = {}) {
  return path.join(resolveStorageRoot(home, options), 'teams');
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

export function encodeDshSegment(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s === '.') return '~002E';
  if (s === '..') return '~002E~002E';
  return s.replace(/[^A-Za-z0-9._-]/g, (ch) => `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function encodeRawSafeSegment(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    const isDotHazard = ch === '.' && (i === 0 || s[i - 1] === '.' || s[i + 1] === '.');
    if (!isDotHazard && ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return out;
}

function compactEncodedSegment(encoded, rawId, sliceLen = 128) {
  let prefix = encoded.slice(0, sliceLen);
  const lastTilde = prefix.lastIndexOf('~');
  if (lastTilde >= 0 && prefix.length - lastTilde < 5) {
    prefix = prefix.slice(0, lastTilde);
  }
  while (prefix.endsWith('.')) prefix = prefix.slice(0, -1);
  const digest = createHash('sha256').update(String(rawId)).digest('hex').slice(0, 32);
  return `${prefix || 'sid'}~h${digest}`;
}

export function encodeSafeTeamSegment(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (
    s.length <= MAX_SAFE_SEGMENT_LEN
    && !s.startsWith('.')
    && !s.includes('..')
    && /^[A-Za-z0-9._-]+$/.test(s)
  ) {
    return s;
  }
  if (s === '.') return '~002E';
  if (s === '..') return '~002E~002E';
  const out = encodeRawSafeSegment(s);
  if (out.length > MAX_SAFE_SEGMENT_LEN) {
    return compactEncodedSegment(out, s, 128);
  }
  return out;
}

function candidateTeamDirMatchesOwner(candDir, seg, raw) {
  const meta = readJson(path.join(candDir, 'team.json'));
  if (typeof meta?.sessionId === 'string' && meta.sessionId.trim()) {
    return meta.sessionId.trim() === raw;
  }
  const gateRows = readJsonl(path.join(candDir, 'gate.jsonl'));
  const gateOwner = gateRows.find((r) => typeof r?.teamId === 'string' && r.teamId.trim())?.teamId?.trim() ?? null;
  if (gateOwner) {
    return gateOwner === raw;
  }
  if (seg === raw && /~[0-9A-F]{4}|~h[0-9a-f]{32}/.test(raw)) {
    return false;
  }
  return true;
}

export function teamDir(home, sessionId, options = {}) {
  const teamsRoot = path.resolve(resolveTeamsRoot(home, options));
  const raw = String(sessionId ?? '');
  if (!raw || raw.includes('\0')) return path.join(teamsRoot, '__invalid__');
  const safeSeg = encodeSafeTeamSegment(raw);
  if (safeSeg) {
    const safeCand = path.resolve(teamsRoot, safeSeg);
    if (path.dirname(safeCand) === teamsRoot && fs.existsSync(safeCand)) {
      return safeCand;
    }
  }

  const altCandidates = [];
  const rawEncoded = raw !== '.' && raw !== '..' ? encodeRawSafeSegment(raw) : '';
  if (rawEncoded.length > MAX_SAFE_SEGMENT_LEN) {
    const alt120 = compactEncodedSegment(rawEncoded, raw, 120);
    if (alt120 && alt120 !== safeSeg && !altCandidates.includes(alt120)) altCandidates.push(alt120);
  }
  for (const seg of [
    encodeDshSegment(raw),
    !/[\\/]/.test(raw) && raw !== '.' && raw !== '..' && !raw.startsWith('.') && !raw.includes('..') ? raw : ''
  ]) {
    if (seg && seg !== safeSeg && seg.length <= 255 && !altCandidates.includes(seg)) {
      altCandidates.push(seg);
    }
  }
  for (const seg of altCandidates) {
    const cand = path.resolve(teamsRoot, seg);
    if (path.dirname(cand) === teamsRoot && fs.existsSync(cand) && candidateTeamDirMatchesOwner(cand, seg, raw)) {
      return cand;
    }
  }

  const fallbackSeg = safeSeg || altCandidates[0] || '__invalid__';
  return path.resolve(teamsRoot, fallbackSeg);
}

export function readGovernanceCalls(usageFile) {
  if (!usageFile || !fs.existsSync(usageFile)) return [];
  return readJsonl(usageFile).filter((record) => record && typeof record === 'object' && record.role !== 'leader');
}

function isTeamDirPath(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, 'members.jsonl')) || fs.existsSync(path.join(dir, 'team.json'));
}

export function isTeam(home, sessionId, options = {}) {
  return isTeamDirPath(teamDir(home, sessionId, options));
}

export function listTeamIds(home, options = {}) {
  const dir = resolveTeamsRoot(home, options);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function collectMemberOwnerMap(home, data = null, options = {}) {
  const memberToTeam = new Map();
  const teamsRoot = path.resolve(resolveTeamsRoot(home, options));
  const dirToSessionId = new Map();
  if (data?.sessions) {
    for (const s of data.sessions) {
      if (!s?.id || s.header?.parentSession) continue;
      dirToSessionId.set(path.resolve(teamDir(home, s.id, options)), s.id);
    }
  }
  for (const dirName of listTeamIds(home, options)) {
    const dir = path.resolve(teamsRoot, dirName);
    if (path.dirname(dir) !== teamsRoot || !isTeamDirPath(dir)) continue;
    try {
      const meta = readJson(path.join(dir, 'team.json'));
      const ownerId =
        (typeof meta?.sessionId === 'string' && meta.sessionId.trim() ? meta.sessionId.trim() : null)
        ?? dirToSessionId.get(dir)
        ?? (!dirName.includes('~h')
          ? dirName.replace(/~([0-9A-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
          : (meta?.teamId ?? dirName));
      const members = foldMembers(readJsonl(path.join(dir, 'members.jsonl')));
      for (const member of members.values()) {
        if (member.childId) memberToTeam.set(member.childId, ownerId);
      }
    } catch {
      // keep scanning other teams
    }
  }
  return memberToTeam;
}

function markSessionErrors(report, sessions) {
  for (const session of sessions) {
    if (session?.error) {
      report.meta.complete = false;
      report.meta.notes.push(`decode error ${session.id}: ${session.error.message ?? session.error}`);
    }
  }
}

function teamMeta(home, sessionId, options = {}) {
  const dir = teamDir(home, sessionId, options);
  const team = readJson(path.join(dir, 'team.json'));
  const timer = readJson(path.join(dir, 'timer.json'));
  const resolvedTeamId =
    (typeof team?.sessionId === 'string' && team.sessionId.trim() ? team.sessionId.trim() : null)
    ?? (typeof team?.teamId === 'string' && !team.teamId.includes('~h') ? team.teamId : null)
    ?? sessionId;
  return {
    teamId: resolvedTeamId,
    activeSec: Number.isFinite(timer?.teamActiveMs) ? Math.round(timer.teamActiveMs / 1000) : null
  };
}

function replayAgreementOutcome(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const created = events[0];
  if (!created || created.type !== 'created' || typeof created.kind !== 'string') return null;
  const maxRounds = Number.isInteger(created.maxRounds) && created.maxRounds >= 1 ? created.maxRounds : 1;
  const maxArbiterAttempts = Number.isInteger(created.maxArbiterAttempts) && created.maxArbiterAttempts >= 1 ? created.maxArbiterAttempts : 1;
  const taskSeq = Number.isInteger(created.taskSeq) && created.taskSeq >= 1 ? created.taskSeq : 1;
  const state = {
    id: created.id,
    kind: created.kind,
    maxRounds,
    maxArbiterAttempts,
    taskSeq,
    serialProofRequired: Boolean(created.serialProofRequired),
    rounds: [],
    arbiterAttempts: 0,
    ruling: null,
    outcome: null,
    pendingOutcome: null,
    status: 'open'
  };

  const settleDecision = (decision) => {
    if (state.serialProofRequired && decision === 'approve') {
      state.status = 'serial-review';
      state.pendingOutcome = { decision };
      state.outcome = null;
    } else {
      state.status = 'settled';
      state.outcome = { decision };
    }
  };

  for (const ev of events.slice(1)) {
    if (!ev || ev.id !== state.id) return null;
    if (ev.type === 'opinion') {
      if (state.status !== 'open') return null;
      const last = state.rounds.at(-1);
      const curRound = last && (last.A === null || last.B === null)
        ? last.n
        : (last && (last.A?.invalid || last.B?.invalid) ? null : (state.rounds.length + 1 <= state.maxRounds ? state.rounds.length + 1 : null));
      if (curRound === null || ev.round !== curRound || (ev.member !== 'A' && ev.member !== 'B')) return null;
      if (!ev.opinion || typeof ev.opinion.stance !== 'string') return null;
      let r = state.rounds.at(-1);
      if (!r || r.n !== curRound) {
        r = { n: curRound, A: null, B: null };
        state.rounds.push(r);
      }
      if (r[ev.member] !== null) return null;
      r[ev.member] = { stance: ev.opinion.stance, invalid: Boolean(ev.opinion.invalid) };
      if (r.A !== null && r.B !== null && !r.A.invalid && !r.B.invalid && r.A.stance === r.B.stance) {
        settleDecision(r.A.stance);
      }
    } else if (ev.type === 'arbiter-attempt') {
      if (state.status !== 'open' || state.ruling !== null || state.arbiterAttempts >= state.maxArbiterAttempts) return null;
      state.arbiterAttempts += 1;
    } else if (ev.type === 'ruling') {
      if (state.status !== 'open' || state.ruling !== null || state.arbiterAttempts < 1) return null;
      const adopt = ev.ruling?.adopt;
      const last = state.rounds.at(-1);
      if ((adopt !== 'A' && adopt !== 'B') || !last || !last[adopt] || last[adopt].invalid) return null;
      state.ruling = { adopt };
      settleDecision(last[adopt].stance);
    } else if (ev.type === 'independent-ruling') {
      const last = state.rounds.at(-1);
      if (state.status !== 'open' || state.arbiterAttempts < 1 || !last || !(last.A?.invalid || last.B?.invalid)) return null;
      if (!ev.opinion || typeof ev.opinion.stance !== 'string') return null;
      state.ruling = { independent: true };
      settleDecision(ev.opinion.stance);
    } else if (ev.type === 'serial-proof') {
      if (state.status !== 'serial-review' || !ev.proof) return null;
      if (ev.proof.verdict === 'proven') {
        state.status = 'settled';
        state.outcome = state.pendingOutcome;
        state.pendingOutcome = null;
      } else if (ev.proof.verdict === 'not_proven') {
        if (state.rounds.length < state.maxRounds) {
          state.status = 'open';
          state.outcome = null;
          state.pendingOutcome = null;
          state.ruling = null;
          state.arbiterAttempts = 0;
        } else {
          state.status = 'settled';
          state.outcome = { decision: 'revise' };
          state.pendingOutcome = null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }
  }
  return state;
}

function computeApprovedDeliveryTimes(agreementsFile) {
  let records;
  try {
    records = readJsonl(agreementsFile);
  } catch {
    return null;
  }
  const byId = new Map();
  for (const r of records) {
    if (!r?.id) continue;
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  const out = new Map();
  for (const recs of byId.values()) {
    const state = replayAgreementOutcome(recs);
    if (!state || state.kind !== 'delivery' || state.status !== 'settled' || state.outcome?.decision !== 'approve') {
      continue;
    }
    const times = recs.map((r) => Date.parse(r.at)).filter(Number.isFinite);
    if (times.length === 0) continue;
    const k = state.taskSeq ?? 1;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(Math.max(...times));
  }
  return out;
}

function resolveModeHistoryFile(home, sessionId, options = {}) {
  const raw = String(sessionId ?? '');
  if (!raw || raw.includes('\0')) return null;
  const seg = encodeSafeTeamSegment(raw);
  if (!seg) return null;
  const modesRoot = path.resolve(resolveStorageRoot(home, options), 'session-modes');
  const file = path.resolve(modesRoot, `${seg}.jsonl`);
  return path.dirname(file) === modesRoot ? file : null;
}

function computeSessionModeBoundaries(home, sessionId, options = {}) {
  if (Array.isArray(options?.modeBoundaries)) return options.modeBoundaries;
  const historyFile = resolveModeHistoryFile(home, sessionId, options);
  if (!historyFile || !fs.existsSync(historyFile)) return undefined;
  const out = [];
  for (const r of readJsonl(historyFile)) {
    if (!r || r.fromMode !== 'single' || r.toMode !== 'team') continue;
    const atMs = typeof r.at === 'string' ? Date.parse(r.at) : Number(r.atMs);
    if (!Number.isFinite(atMs)) continue;
    out.push({
      atMs,
      taskSeqHint: Number.isInteger(r.taskSeqHint) && r.taskSeqHint >= 1 ? r.taskSeqHint : null
    });
  }
  return out.length > 0 ? out : undefined;
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
  let maxSeq = 0;
  const hash = createHash('sha1');
  for (const r of gatewayRecords) {
    if (!r || typeof r !== 'object') continue;
    const seq = Number.isFinite(Number(r.seq)) ? Number(r.seq) : 0;
    if (seq > maxSeq) maxSeq = seq;
    const cost = r.gatewayCostUsd ?? r.cost ?? '';
    const totalTokens = r.tokens?.totalTokens ?? r.totalTokens ?? '';
    const actualProvider = r.actualProvider ?? r.provider ?? '';
    const actualModel = r.actualModel ?? r.model ?? '';
    const tries = r.physicalAttempts ?? r.tries ?? '';
    const latencyMs = r.latencyMs ?? r.ms ?? '';
    hash.update(
      `${r.gatewayRecordId ?? r.id ?? ''}:${seq}:${cost}:${totalTokens}:${actualProvider}:${actualModel}:${tries}:${latencyMs}:${r.status ?? ''}|`
    );
  }
  const lastId = gatewayRecords.at(-1)?.gatewayRecordId ?? gatewayRecords.at(-1)?.id ?? '';
  return `gw:${gatewayRecords.length}:${maxSeq}:${hash.digest('hex').slice(0, 16)}:${lastId}`;
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

export function readSignature(home, sessionId, sessions, options = {}) {
  const resolvedTeamsRoot = resolveTeamsRoot(home, options);
  const dir = teamDir(home, sessionId, options);
  const modeHistoryFile = resolveModeHistoryFile(home, sessionId, options);
  const parts = [
    `teamsRoot:${resolvedTeamsRoot}`,
    ...sessions.filter(Boolean).map((session) => `${session.file}:${session.sig}`)
  ];
  if (isTeam(home, sessionId, options)) {
    parts.push(
      fileSignature(path.join(dir, 'members.jsonl')),
      fileSignature(path.join(dir, 'usage.jsonl')),
      fileSignature(path.join(dir, 'gate.jsonl')),
      fileSignature(path.join(dir, 'agreements.jsonl')),
      fileSignature(path.join(dir, 'timer.json')),
      fileSignature(path.join(dir, 'team.json'))
    );
  } else {
    const usageFile = path.join(dir, 'usage.jsonl');
    const gateFile = path.join(dir, 'gate.jsonl');
    const agreementsFile = path.join(dir, 'agreements.jsonl');
    if (fs.existsSync(usageFile)) parts.push(fileSignature(usageFile));
    if (fs.existsSync(gateFile)) parts.push(fileSignature(gateFile));
    if (fs.existsSync(agreementsFile)) parts.push(fileSignature(agreementsFile));
  }
  if (modeHistoryFile && fs.existsSync(modeHistoryFile)) {
    parts.push(`modeHist:${fileSignature(modeHistoryFile)}`);
  }
  if (options?.modeBoundaries) {
    parts.push(JSON.stringify(options.modeBoundaries));
  }
  return signatureOf(parts);
}

function buildTeamResult(home, data, sessionId, pricing, options = {}) {
  const leader = data.byId.get(sessionId);
  const resolvedTeamsRoot = resolveTeamsRoot(home, options);
  const dir = teamDir(home, sessionId, options);
  const membersFile = path.join(dir, 'members.jsonl');
  const usageFile = path.join(dir, 'usage.jsonl');
  const gateFile = path.join(dir, 'gate.jsonl');
  const agreementsFile = path.join(dir, 'agreements.jsonl');

  const members = foldMembers(readJsonl(membersFile));
  const governance = readGovernanceCalls(usageFile);
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
      if (isTeam(home, desc.id, options)) continue;
      seenSessionIds.add(desc.id);
      sessions.push(desc);
    }
  }
  const signature = readSignature(home, sessionId, sessions, options);
  const cacheKey = `team|${resolvedTeamsRoot}|${sessionId}|${signature}|${pricingSignatureOf(pricing)}|${gatewaySignatureOf(options.gatewayRecords)}`;
  return getCachedOrCompute(cacheKey, () => {
    const approvedDeliveryTimes = options.approvedDeliveryTimes instanceof Map
      ? options.approvedDeliveryTimes
      : computeApprovedDeliveryTimes(agreementsFile);
    const modeBoundaries = computeSessionModeBoundaries(home, sessionId, options);
    const report = buildReport({
      home,
      sessionId,
      sessions,
      governance,
      members,
      approvedDeliveryTimes,
      modeBoundaries,
      pricing,
      gatewayRecords: options.gatewayRecords,
      kind: 'team'
    });
    markSessionErrors(report, sessions);
    const info = teamMeta(home, sessionId, options);
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
  const resolvedTeamsRoot = resolveTeamsRoot(home, options);
  const dir = teamDir(home, sessionId, options);
  const usageFile = path.join(dir, 'usage.jsonl');
  const gateFile = path.join(dir, 'gate.jsonl');
  const agreementsFile = path.join(dir, 'agreements.jsonl');
  const signature = readSignature(home, sessionId, sessions, options);
  const cacheKey = `session|${resolvedTeamsRoot}|${sessionId}|${signature}|${pricingSignatureOf(pricing)}|${gatewaySignatureOf(options.gatewayRecords)}`;
  return getCachedOrCompute(cacheKey, () => {
    const governance = readGovernanceCalls(usageFile);
    const gateSummary = fs.existsSync(gateFile)
      ? gateSummaryOf(readJsonl(gateFile), governance)
      : undefined;
    const approvedDeliveryTimes = options.approvedDeliveryTimes instanceof Map
      ? options.approvedDeliveryTimes
      : (fs.existsSync(agreementsFile) ? computeApprovedDeliveryTimes(agreementsFile) : undefined);
    const modeBoundaries = computeSessionModeBoundaries(home, sessionId, options);
    const report = buildReport({
      home,
      sessionId,
      sessions,
      governance,
      gateSummary,
      approvedDeliveryTimes,
      modeBoundaries,
      pricing,
      gatewayRecords: options.gatewayRecords,
      kind: 'session'
    });
    markSessionErrors(report, sessions);
    return { report, signature };
  });
}

export function reportFor(home, sessionId, pricingOrOptions = defaultPricing, maybeOptions = undefined) {
  const { pricing, options } = normalizePricingAndOptions(pricingOrOptions, maybeOptions);
  const data = options?.preloadedHome ?? loadHome(home);
  if (!data.byId.has(sessionId)) return null;
  return isTeam(home, sessionId, options)
    ? buildTeamResult(home, data, sessionId, pricing, options)
    : buildSessionResult(home, data, sessionId, pricing, options);
}

export function listSessions(home, pricingOrOptions = defaultPricing, maybeOptions = undefined) {
  const { pricing, options } = normalizePricingAndOptions(pricingOrOptions, maybeOptions);
  const data = options?.preloadedHome ?? loadHome(home);
  const memberToTeam = collectMemberOwnerMap(home, data, options);
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
        if (isTeam(home, curParent, options)) {
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
      if (session.error) throw session.error;
      result = isTeam(home, session.id, options)
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
        : report.agents.filter((agent) => agent.group === 'subagents').length;
    row.signature = signature;
    rows.push(row);
  }
  rows.sort(
    (a, b) => (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0) || String(a.id).localeCompare(String(b.id))
  );
  return rows;
}

export function overviewFor(home, pricingOrOptions = defaultPricing, maybeOptions = undefined) {
  const { pricing, options } = normalizePricingAndOptions(pricingOrOptions, maybeOptions);
  const data = options?.preloadedHome ?? loadHome(home);
  const memberToTeam = collectMemberOwnerMap(home, data, options);
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
      const result = isTeam(home, session.id, options)
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

export function homesInfo(explicit, options = {}) {
  const out = [];
  for (const home of listKnownHomes(explicit)) {
    const homeOpts = explicit && samePath(home, explicit) ? options : {};
    const files = walkSessions(path.join(home, 'sessions'));
    const teamsRoot = path.resolve(resolveTeamsRoot(home, homeOpts));
    const teamCount = listTeamIds(home, homeOpts).filter((dirName) => {
      const dir = path.resolve(teamsRoot, dirName);
      return path.dirname(dir) === teamsRoot && isTeamDirPath(dir);
    }).length;
    out.push({
      path: home,
      label: homeLabel(home),
      sessionCount: files.length,
      teamCount
    });
  }
  return out;
}
