// Append-only JSONL team store. One directory per team (team id = leader session id). Sync fs; single writer process per team.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LtError } from './constants.mjs';

export function safeId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._~-]{1,192}$/.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new LtError('BAD_ID', `unsafe id: ${id}`);
  }
  return id;
}

function encodeCanonicalTeamStoreSegment(teamId) {
  if (typeof teamId !== 'string' || teamId.length === 0 || teamId.trim().length === 0 || teamId.length > 256 || teamId.includes('\u0000')) {
    throw new LtError('BAD_ID', `unsafe id: ${teamId}`);
  }
  if (/^[A-Za-z0-9._-]{1,192}$/.test(teamId) && teamId !== '.' && teamId !== '..' && !teamId.startsWith('.') && !teamId.includes('..')) {
    return teamId;
  }
  if (teamId === '.') return '~002E';
  if (teamId === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < teamId.length; i++) {
    const code = teamId.charCodeAt(i);
    const ch = teamId[i];
    const isDotHazard = ch === '.' && (i === 0 || teamId[i - 1] === '.' || teamId[i + 1] === '.');
    if (!isDotHazard && ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  if (out.length > 192) {
    let prefix = out.slice(0, 128);
    const lastTilde = prefix.lastIndexOf('~');
    if (lastTilde >= 0 && prefix.length - lastTilde < 5) prefix = prefix.slice(0, lastTilde);
    while (prefix.endsWith('.')) prefix = prefix.slice(0, -1);
    const digest = createHash('sha256').update(teamId).digest('hex').slice(0, 32);
    out = `${prefix || 'sid'}~h${digest}`;
  }
  return safeId(out);
}

function readJsonSilent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function encodeTeamStoreId(teamId, root = null) {
  const canonicalSeg = encodeCanonicalTeamStoreSegment(teamId);
  if (!root || teamId === canonicalSeg) {
    return canonicalSeg;
  }
  try {
    if (fs.existsSync(path.join(root, 'teams', canonicalSeg))) {
      return canonicalSeg;
    }
  } catch {}
  if (/^[A-Za-z0-9._~-]{1,192}$/.test(teamId) && teamId !== '.' && teamId !== '..' && !teamId.startsWith('.') && !teamId.includes('..')) {
    try {
      const candDir = path.join(root, 'teams', teamId);
      if (fs.existsSync(candDir)) {
        const teamMeta = readJsonSilent(path.join(candDir, 'team.json'));
        if (typeof teamMeta?.sessionId === 'string' && teamMeta.sessionId.trim()) {
          return teamMeta.sessionId.trim() === teamId ? teamId : canonicalSeg;
        }
        const gateOwner = readJsonl(path.join(candDir, 'gate.jsonl')).records
          .find(r => typeof r?.teamId === 'string' && r.teamId.trim())?.teamId?.trim() ?? null;
        if (gateOwner) {
          return gateOwner === teamId ? teamId : canonicalSeg;
        }
        if (/~[0-9A-F]{4}|~h[0-9a-f]{32}/.test(teamId)) {
          return canonicalSeg;
        }
        return teamId;
      }
    } catch {}
  }
  return canonicalSeg;
}

export function decodeEncodedStoreSegment(seg) {
  if (typeof seg !== 'string' || !seg) return '';
  if (/~h[0-9a-f]{32}$/.test(seg)) return seg;
  return seg.replace(/~([0-9A-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function resolveTeamStoreLogicalId(root, dirName) {
  if (typeof dirName !== 'string' || !dirName) return dirName;
  const dir = path.join(root, 'teams', dirName);
  const meta = readJsonSilent(path.join(dir, 'team.json'));
  if (typeof meta?.sessionId === 'string' && meta.sessionId.trim()) {
    return meta.sessionId.trim();
  }
  const gateOwner = readJsonl(path.join(dir, 'gate.jsonl')).records
    .find(r => typeof r?.teamId === 'string' && r.teamId.trim())?.teamId?.trim() ?? null;
  if (gateOwner) return gateOwner;
  const candidate = typeof meta?.teamId === 'string' && meta.teamId.trim() ? meta.teamId.trim() : dirName;
  if (!/~h[0-9a-f]{32}$/.test(candidate)) {
    return decodeEncodedStoreSegment(candidate);
  }
  return dirName;
}
/**
 * A crash can leave the last line without its newline. Before appending: a complete record only gets its newline;
 * a partial one is moved to "<file>.torn" and cut off. Otherwise the next record would be glued to the fragment,
 * be lost, and turn into a corrupt middle line that makes the whole file unreadable.
 */
function repairTail(file) {
  let fd;
  try { fd = fs.openSync(file, 'r+'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    const all = Buffer.alloc(size);
    fs.readSync(fd, all, 0, size, 0);
    const keep = all.lastIndexOf(0x0a) + 1;
    const tail = all.subarray(keep);
    let complete = true;
    try { JSON.parse(tail.toString('utf8')); } catch { complete = false; }
    if (complete) { fs.writeSync(fd, '\n', size); return; }
    fs.appendFileSync(`${file}.torn`, Buffer.concat([tail, Buffer.from('\n')]));
    fs.ftruncateSync(fd, keep);
  } finally { fs.closeSync(fd); }
}
export function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(record);
  if (line.includes('\n')) throw new LtError('STORE', 'record serialization contains a newline');
  repairTail(file);
  fs.appendFileSync(file, line + '\n', { encoding: 'utf8' });
}
/** Read records; a missing file is empty; an unparsable LAST line (torn write) is skipped; any other bad line throws. */
export function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { records: [], skipped: 0 }; throw e; }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records = []; let skipped = 0;
  lines.forEach((line, i) => {
    try { records.push(JSON.parse(line)); } catch {
      if (i === lines.length - 1) skipped++; else throw new LtError('STORE_CORRUPT', `${file}: line ${i + 1} is not valid JSON`);
    }
  });
  return { records, skipped };
}
/** Write a whole file atomically (tmp + rename). */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, text, 'utf8');
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

/**
 * Stage temporary files in every target directory before renaming any destination file,
 * rolling back any already-renamed files if a subsequent rename fails.
 */
export function writeFilesTransactional(writes) {
  if (!Array.isArray(writes) || writes.length === 0) return;
  const staged = [];
  const renamed = [];
  try {
    for (const { file, content } of writes) {
      const existed = fs.existsSync(file);
      const previousContent = existed ? fs.readFileSync(file, 'utf8') : null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      const fd = fs.openSync(tmp, 'wx');
      try {
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
      } catch (e) {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      fs.closeSync(fd);
      staged.push({ file, tmp, existed, previousContent });
    }
    for (const item of staged) {
      fs.renameSync(item.tmp, item.file);
      renamed.push(item);
    }
  } catch (err) {
    for (let i = renamed.length - 1; i >= 0; i--) {
      const item = renamed[i];
      try {
        if (item.existed) writeFileAtomic(item.file, item.previousContent);
        else fs.unlinkSync(item.file);
      } catch {}
    }
    for (const item of staged) {
      try { if (fs.existsSync(item.tmp)) fs.unlinkSync(item.tmp); } catch {}
    }
    throw err;
  }
}

export class TeamStore {
  constructor(root, teamId) {
    this.rawTeamId = teamId;
    this.teamId = encodeTeamStoreId(teamId, root);
    this.dir = path.join(root, 'teams', this.teamId);
    this.membersFile = path.join(this.dir, 'members.jsonl');
    this.agreementsFile = path.join(this.dir, 'agreements.jsonl');
    this.gateFile = path.join(this.dir, 'gate.jsonl');
    this.authorizationFile = path.join(this.dir, 'authorization.md');
    this.timerFile = path.join(this.dir, 'timer.json');
    this.stagnationFile = path.join(this.dir, 'stagnation-selections.jsonl');
    this.governanceFile = path.join(this.dir, 'governance.jsonl');
  }
  static exists(root, teamId) {
    try {
      const sid = encodeTeamStoreId(teamId, root);
      return fs.existsSync(path.join(root, 'teams', sid, 'members.jsonl')) || fs.existsSync(path.join(root, 'teams', sid, 'team.json'));
    } catch {
      return false;
    }
  }
  ensure(meta) {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = path.join(this.dir, 'team.json');
    if (!fs.existsSync(f)) {
      const persistedSessionId = typeof meta?.sessionId === 'string' && meta.sessionId.trim()
        ? meta.sessionId.trim()
        : this.rawTeamId;
      writeFileAtomic(f, JSON.stringify({
        v: 1,
        createdAt: new Date().toISOString(),
        ...meta,
        teamId: this.teamId,
        sessionId: persistedSessionId,
      }, null, 2));
      return;
    }
    if (typeof this.rawTeamId === 'string' && this.rawTeamId) {
      try {
        const existing = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (existing && typeof existing === 'object' && !Array.isArray(existing) && typeof existing.sessionId !== 'string') {
          writeFileAtomic(f, JSON.stringify({ ...existing, sessionId: this.rawTeamId }, null, 2));
        }
      } catch {}
    }
  }
  /** Members keyed by childId, with the latest status folded in. */
  members() {
    const map = new Map();
    for (const [revision, r] of readJsonl(this.membersFile).records.entries()) {
      if (r.type === 'member') map.set(r.childId, { ...r, status: 'starting', statusRevision: revision });
      else if (r.type === 'member-status' && map.has(r.childId)) {
        const member = map.get(r.childId);
        const clearGov = r.status === 'running' || r.status === 'done';
        map.set(r.childId, {
          ...member,
          status: r.status,
          statusRevision: member.status === r.status ? member.statusRevision : revision,
          ...(clearGov ? { governanceState: null, pausedByConferenceId: null } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(r.failure ? { failure: r.failure } : {}),
        });
      }
      else if (r.type === 'member-tools' && map.has(r.childId)) map.set(r.childId, { ...map.get(r.childId), loadedTools: r.loadedTools, ...(r.shellFailure ? { shellFailure: r.shellFailure } : {}) });
      else if (r.type === 'member-host-name' && map.has(r.childId)) map.set(r.childId, { ...map.get(r.childId), hostAgentName: r.hostAgentName });
      else if (r.type === 'member-binding' && map.has(r.childId)) map.set(r.childId, { ...map.get(r.childId), taskSeq: r.taskSeq, planId: r.planId });
      else if (r.type === 'member-governance' && map.has(r.childId)) {
        map.set(r.childId, {
          ...map.get(r.childId),
          governanceState: r.governanceState ?? null,
          pausedByConferenceId: r.conferenceId ?? null,
          ...(r.resumePoint ? { resumePoint: r.resumePoint } : {}),
          ...(r.checkpoint ? { checkpoint: r.checkpoint } : {}),
        });
      }
    }
    return map;
  }
  getMember(childId) { return this.members().get(childId); }
  addMember(rec) {
    const ownerPid = Number.isInteger(rec?.ownerPid) && rec.ownerPid > 0 ? rec.ownerPid : process.pid;
    appendJsonl(this.membersFile, { v: 1, type: 'member', at: new Date().toISOString(), ...rec, ownerPid });
  }
  setMemberStatus(childId, status, error, failure) { appendJsonl(this.membersFile, { v: 1, type: 'member-status', at: new Date().toISOString(), childId, status, ...(error ? { error } : {}), ...(failure ? { failure } : {}) }); }
  setMemberBinding(childId, taskSeq, planId) { appendJsonl(this.membersFile, { v: 1, type: 'member-binding', at: new Date().toISOString(), childId, taskSeq, planId }); }
  setMemberHostName(childId, hostAgentName) { appendJsonl(this.membersFile, { v: 1, type: 'member-host-name', at: new Date().toISOString(), childId, hostAgentName }); }
  setMemberTools(childId, loadedTools, shellFailure) { appendJsonl(this.membersFile, { v: 1, type: 'member-tools', at: new Date().toISOString(), childId, loadedTools, ...(shellFailure ? { shellFailure } : {}) }); }
  setMemberGovernanceState(childId, governanceState, meta = {}) { appendJsonl(this.membersFile, { v: 1, type: 'member-governance', at: new Date().toISOString(), childId, governanceState, ...meta }); }
  agreementEvents(id) { return readJsonl(this.agreementsFile).records.filter(r => r.id === id).map(({ v, at, ...ev }) => ev); }
  agreementIds() { return [...new Set(readJsonl(this.agreementsFile).records.filter(r => r.type === 'created').map(r => r.id))]; }
  /** Raw agreement records including their write time `at` (ISO). */
  agreementRecords() { return readJsonl(this.agreementsFile).records; }
  appendAgreementEvent(ev) { appendJsonl(this.agreementsFile, { v: 1, at: new Date().toISOString(), ...ev }); }
  saveAgreementInput(id, input) { writeFileAtomic(path.join(this.dir, 'agreements', `${safeId(id)}.input.json`), JSON.stringify(input, null, 1)); }
  loadAgreementInput(id) { return JSON.parse(fs.readFileSync(path.join(this.dir, 'agreements', `${safeId(id)}.input.json`), 'utf8')); }
  appendGateReceipt(r) { appendJsonl(this.gateFile, { v: 1, at: new Date().toISOString(), ...r }); }
  /** One record per tool-less model request made by LeaderTeam itself (gate, discussA, discussB, arbiter). */
  appendUsage(r) { appendJsonl(path.join(this.dir, 'usage.jsonl'), { v: 1, at: new Date().toISOString(), ...r }); }
  appendWorkflowEvent(r) { appendJsonl(path.join(this.dir, 'workflow.jsonl'), { v: 1, at: new Date().toISOString(), ...r }); }
  workflowEvents() { return readJsonl(path.join(this.dir, 'workflow.jsonl')).records; }
  usageRecords() { return readJsonl(path.join(this.dir, 'usage.jsonl')).records; }
  gateReceipts() { return readJsonl(this.gateFile).records; }
  appendAuthorization(text) { fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.authorizationFile, text.endsWith('\n') ? text : text + '\n', 'utf8'); }
  readAuthorization() { try { return fs.readFileSync(this.authorizationFile, 'utf8'); } catch { return ''; } }
  readTimerState() {
    try { return JSON.parse(fs.readFileSync(this.timerFile, 'utf8')); } catch { return null; }
  }
  writeTimerState(state) {
    writeFileAtomic(this.timerFile, JSON.stringify(state, null, 2) + '\n');
    return state;
  }
  appendStagnationSelection(rec) {
    appendJsonl(this.stagnationFile, { v: 1, at: new Date().toISOString(), ...rec });
  }
  stagnationSelections() {
    return readJsonl(this.stagnationFile).records;
  }
  appendGovernanceEvent(rec) {
    appendJsonl(this.governanceFile, { v: 1, at: new Date().toISOString(), ...rec });
  }
  governanceEvents() {
    return readJsonl(this.governanceFile).records;
  }
  saveMemberCheckpoint(childId, conferenceId, checkpoint) {
    const cid = conferenceId ? safeId(conferenceId) : 'latest';
    const file = path.join(this.dir, 'checkpoints', `${safeId(childId)}-${cid}.json`);
    const payload = { v: 1, savedAt: new Date().toISOString(), childId, conferenceId: conferenceId ?? null, ...checkpoint };
    writeFileAtomic(file, JSON.stringify(payload, null, 2) + '\n');
    return payload;
  }
  loadMemberCheckpoint(childId, conferenceId) {
    const cid = conferenceId ? safeId(conferenceId) : 'latest';
    const file = path.join(this.dir, 'checkpoints', `${safeId(childId)}-${cid}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }
}
