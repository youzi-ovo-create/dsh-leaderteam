// Session-level execution mode ('team' | 'single') with DSH-safe path encoding and atomic disk persistence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LtError } from './constants.mjs';
import { writeFileAtomic, appendJsonl, readJsonl } from './store.mjs';
import { isInside } from './paths.mjs';

export const EXECUTION_MODES = Object.freeze(['team', 'single']);
export const DEFAULT_EXECUTION_MODE = 'team';
const MAX_SAFE_SEGMENT_CHARS = 192;

export function normalizeExecutionMode(val) {
  if (typeof val !== 'string') {
    throw new LtError('BAD_EXECUTION_MODE', `invalid execution mode: ${String(val)} (expected "team" or "single")`);
  }
  const norm = val.trim().toLowerCase();
  if (!EXECUTION_MODES.includes(norm)) {
    throw new LtError('BAD_EXECUTION_MODE', `invalid execution mode "${val}" (expected "team" or "single")`);
  }
  return norm;
}

/**
 * Encode `sessionId` into a safe, deterministic single filename segment (`[A-Za-z0-9._~-]`, <= 192 chars),
 * escaping `.` / `..` / leading `.` / `~` / `:` / `/` / `\` / control & non-ASCII chars as `~XXXX` uppercase hex.
 */
export function encodeSessionModeSegment(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.trim().length === 0) {
    throw new LtError('BAD_SESSION_ID', 'sessionId must be a non-empty string');
  }
  if (sessionId.length > 256) {
    throw new LtError('BAD_SESSION_ID', `sessionId exceeds maximum length of 256 characters (got ${sessionId.length})`);
  }
  if (sessionId.includes('\u0000')) {
    throw new LtError('BAD_SESSION_ID', 'sessionId must not contain NUL bytes');
  }
  if (sessionId === '.') return '~002E';
  if (sessionId === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < sessionId.length; i++) {
    const code = sessionId.charCodeAt(i);
    const ch = sessionId[i];
    const isDotHazard = ch === '.' && (i === 0 || sessionId[i - 1] === '.' || sessionId[i + 1] === '.');
    if (!isDotHazard && ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  if (out.length > MAX_SAFE_SEGMENT_CHARS) {
    let prefix = out.slice(0, 128);
    // Avoid cutting in the middle of a `~XXXX` escape or leaving a trailing `.`
    const lastTilde = prefix.lastIndexOf('~');
    if (lastTilde >= 0 && prefix.length - lastTilde < 5) {
      prefix = prefix.slice(0, lastTilde);
    }
    while (prefix.endsWith('.')) prefix = prefix.slice(0, -1);
    const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
    out = `${prefix || 'sid'}~h${digest}`;
  }
  if (!out || out === '.' || out === '..' || out.includes('..') || !/^[A-Za-z0-9._~-]+$/.test(out) || out.length > MAX_SAFE_SEGMENT_CHARS) {
    throw new LtError('BAD_SESSION_ID', `encoded sessionId produced unsafe path segment: ${out}`);
  }
  return out;
}

export function decodeSessionModeSegment(segment) {
  if (typeof segment !== 'string' || !segment || segment.includes('~h')) return segment;
  return segment.replace(/~([0-9A-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function resolveSessionModePaths(storageRoot, sessionId, { ensureDir = false, fsImpl = fs } = {}) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
    throw new LtError('BAD_STORAGE_ROOT', 'storageRoot must be a non-empty directory path');
  }
  const absRoot = path.resolve(storageRoot);
  const modesDir = path.resolve(absRoot, 'session-modes');
  const segment = encodeSessionModeSegment(sessionId);
  const stateFile = path.resolve(modesDir, `${segment}.json`);
  const historyFile = path.resolve(modesDir, `${segment}.jsonl`);

  if (
    path.dirname(stateFile) !== modesDir
    || path.dirname(historyFile) !== modesDir
    || !isInside(stateFile, modesDir)
    || !isInside(historyFile, modesDir)
  ) {
    throw new LtError('SESSION_MODE_PATH_ESCAPE', `session mode path escaped session-modes directory for "${sessionId}"`);
  }

  let modesDirLstat = null;
  try {
    modesDirLstat = fsImpl.lstatSync(modesDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (modesDirLstat) {
    if (modesDirLstat.isSymbolicLink() || !modesDirLstat.isDirectory()) {
      throw new LtError('SESSION_MODE_PATH_ESCAPE', 'session-modes path must be a real directory, not a symlink');
    }
  } else if (ensureDir) {
    fsImpl.mkdirSync(modesDir, { recursive: true });
    modesDirLstat = fsImpl.lstatSync(modesDir);
    if (modesDirLstat.isSymbolicLink() || !modesDirLstat.isDirectory()) {
      throw new LtError('SESSION_MODE_PATH_ESCAPE', 'session-modes path must be a real directory, not a symlink');
    }
  }

  if (modesDirLstat && typeof fsImpl.realpathSync === 'function') {
    const realRoot = fsImpl.realpathSync(absRoot);
    const realModesDir = fsImpl.realpathSync(modesDir);
    if (!isInside(realModesDir, realRoot)) {
      throw new LtError('SESSION_MODE_PATH_ESCAPE', 'session-modes directory resolves outside storageRoot');
    }
    for (const targetFile of [stateFile, historyFile]) {
      let fileLstat = null;
      try {
        fileLstat = fsImpl.lstatSync(targetFile);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (fileLstat) {
        if (fileLstat.isSymbolicLink() || !fileLstat.isFile()) {
          throw new LtError('SESSION_MODE_PATH_ESCAPE', `session mode file must be a regular file, not a symlink: ${path.basename(targetFile)}`);
        }
        const realTarget = fsImpl.realpathSync(targetFile);
        if (!isInside(realTarget, realModesDir)) {
          throw new LtError('SESSION_MODE_PATH_ESCAPE', `session mode file resolves outside session-modes directory: ${path.basename(targetFile)}`);
        }
      }
    }
  }

  return { modesDir, segment, stateFile, historyFile };
}

export function readSessionModeRecord(storageRoot, sessionId) {
  const { stateFile } = resolveSessionModePaths(storageRoot, sessionId, { ensureDir: false });
  let text;
  try {
    text = fs.readFileSync(stateFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        sessionId,
        mode: DEFAULT_EXECUTION_MODE,
        persisted: false,
        createdAt: null,
        updatedAt: null,
        switchCount: 0,
        lastSwitchedFrom: null,
        lastTaskSeqHint: null,
      };
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LtError('SESSION_MODE_CORRUPT', `session mode file is not valid JSON (${stateFile}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) {
    throw new LtError('SESSION_MODE_CORRUPT', `session mode file has unsupported schema version (${stateFile})`);
  }
  if (typeof parsed.sessionId === 'string' && parsed.sessionId !== sessionId) {
    throw new LtError('SESSION_MODE_CORRUPT', `session mode file sessionId mismatch (${stateFile})`);
  }
  let mode;
  try {
    mode = normalizeExecutionMode(parsed.mode);
  } catch (err) {
    throw new LtError('SESSION_MODE_CORRUPT', `session mode file has invalid mode (${stateFile}): ${err.message}`);
  }
  return {
    v: 1,
    sessionId,
    mode,
    persisted: true,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    switchCount: Number.isInteger(parsed.switchCount) && parsed.switchCount >= 0 ? parsed.switchCount : 0,
    lastSwitchedFrom: typeof parsed.lastSwitchedFrom === 'string' && EXECUTION_MODES.includes(parsed.lastSwitchedFrom)
      ? parsed.lastSwitchedFrom
      : null,
    lastTaskSeqHint: Number.isInteger(parsed.lastTaskSeqHint) && parsed.lastTaskSeqHint >= 1 ? parsed.lastTaskSeqHint : null,
  };
}

export function writeSessionModeRecord(storageRoot, sessionId, nextMode, meta = {}) {
  const mode = normalizeExecutionMode(nextMode);
  const { stateFile, historyFile } = resolveSessionModePaths(storageRoot, sessionId, { ensureDir: true });
  let prev;
  try {
    prev = readSessionModeRecord(storageRoot, sessionId);
  } catch (err) {
    if (err?.code !== 'SESSION_MODE_CORRUPT') throw err;
    const corruptBackup = `${stateFile}.corrupt.${Date.now()}`;
    try {
      if (fs.existsSync(stateFile)) fs.renameSync(stateFile, corruptBackup);
    } catch {}
    prev = {
      sessionId,
      mode: DEFAULT_EXECUTION_MODE,
      persisted: false,
      createdAt: null,
      updatedAt: null,
      switchCount: 0,
      lastSwitchedFrom: null,
      lastTaskSeqHint: null,
    };
  }
  const nowIso = typeof meta?.at === 'string' && meta.at ? meta.at : new Date().toISOString();
  const isInitial = Boolean(meta?.initial && !prev.persisted);
  const didSwitch = !isInitial && prev.mode !== mode;
  const switchCount = (prev.switchCount ?? 0) + (didSwitch ? 1 : 0);
  const lastSwitchedFrom = didSwitch ? prev.mode : (prev.lastSwitchedFrom ?? null);
  const taskSeqHint = Number.isInteger(meta?.taskSeqHint) && meta.taskSeqHint >= 1
    ? meta.taskSeqHint
    : (prev.lastTaskSeqHint ?? null);

  const record = {
    v: 1,
    sessionId,
    mode,
    createdAt: prev.createdAt ?? nowIso,
    updatedAt: nowIso,
    switchCount,
    lastSwitchedFrom,
    lastTaskSeqHint: taskSeqHint,
  };
  writeFileAtomic(stateFile, JSON.stringify(record, null, 2) + '\n');

  const source = typeof meta?.source === 'string' && meta.source.trim() ? meta.source.trim() : 'user';
  const actor = typeof meta?.actor === 'string' && meta.actor.trim() ? meta.actor.trim() : source;
  appendJsonl(historyFile, {
    v: 1,
    at: nowIso,
    sessionId,
    fromMode: isInitial ? null : prev.mode,
    toMode: mode,
    source,
    actor,
    taskSeqHint,
  });

  return {
    ...record,
    persisted: true,
  };
}

export function readSessionModeHistory(storageRoot, sessionId) {
  const { historyFile } = resolveSessionModePaths(storageRoot, sessionId, { ensureDir: false });
  return readJsonl(historyFile).records;
}

export class SessionModeStore {
  constructor(storageRoot) {
    if (typeof storageRoot !== 'string' || !storageRoot.trim()) {
      throw new LtError('BAD_STORAGE_ROOT', 'storageRoot must be a non-empty directory path');
    }
    this.storageRoot = path.resolve(storageRoot);
    this.dir = path.join(this.storageRoot, 'session-modes');
  }

  paths(sessionId) {
    return resolveSessionModePaths(this.storageRoot, sessionId, { ensureDir: false });
  }

  exists(sessionId) {
    const { stateFile } = resolveSessionModePaths(this.storageRoot, sessionId, { ensureDir: false });
    return fs.existsSync(stateFile);
  }

  read(sessionId) {
    return readSessionModeRecord(this.storageRoot, sessionId);
  }

  getMode(sessionId) {
    return readSessionModeRecord(this.storageRoot, sessionId).mode;
  }

  write(sessionId, nextMode, meta = {}) {
    return writeSessionModeRecord(this.storageRoot, sessionId, nextMode, meta);
  }

  history(sessionId) {
    return readSessionModeHistory(this.storageRoot, sessionId);
  }
}
