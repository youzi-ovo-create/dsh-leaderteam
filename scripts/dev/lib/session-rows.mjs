// Read DSH session logs (session.v4.jsonl.zstd: concatenated zstd frames of JSONL) and team stores. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** Decompress every zstd frame in order. Frame boundaries are found by magic number and confirmed by decoding. */
export function zstdFrames(buf) {
  if (!buf || buf.length < 4 || buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] || buf[2] !== MAGIC[2] || buf[3] !== MAGIC[3]) {
    throw new Error('not a zstd stream');
  }
  try {
    return zlib.zstdDecompressSync(buf);
  } catch {}
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  const out = [];
  let s = 0;
  while (s < starts.length) {
    let ok = false;
    for (let e = s + 1; e <= starts.length; e++) {
      const end = e < starts.length ? starts[e] : buf.length;
      try { out.push(zlib.zstdDecompressSync(buf.subarray(starts[s], end))); s = e; ok = true; break; } catch { /* magic inside data: extend */ }
    }
    if (!ok) throw new Error(`undecodable zstd frame at byte ${starts[s]}`);
  }
  return Buffer.concat(out);
}
export function readSessionRows(file) {
  return zstdFrames(fs.readFileSync(file)).toString('utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}
/** All sessions under <home>/sessions: [{id, dir, rows, header}] where header is the first "session" row. */
export function readSessions(home) {
  const root = path.join(home, 'sessions');
  const found = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'session.v4.jsonl.zstd') found.push(p); } };
  if (fs.existsSync(root)) walk(root);
  return found.map(f => { const rows = readSessionRows(f); return { id: path.basename(path.dirname(f)), dir: path.dirname(f), rows, header: rows.find(r => r.type === 'session') ?? null }; });
}
export function jsonl(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; }
export function teamStore(storageRoot, teamId) {
  const dir = path.join(storageRoot, 'teams', teamId);
  return { dir, members: jsonl(path.join(dir, 'members.jsonl')), gate: jsonl(path.join(dir, 'gate.jsonl')), agreements: jsonl(path.join(dir, 'agreements.jsonl')) };
}
/** Shell test runs of one acceptance module found in member session logs (job/settled rows). Pure. */
export function shellTestRuns(memberSessions, members, mod) {
  const runs = [];
  for (const s of memberSessions) for (const r of s.rows) {
    if (r.type !== 'job/settled') continue;
    const label = String(r.data?.label ?? '');
    if (label.includes(mod.testMarker ?? 'unittest') && label.includes(mod.dir)) runs.push({ member: members.find(m => m.childId === s.id)?.name ?? s.id, status: r.data?.status, detail: r.data?.detail });
  }
  return { module: mod.dir, runs, ok: runs.some(x => x.status === 'completed' && /exit code: 0\b/.test(String(x.detail))) };
}
/** {relativePath: sha256} for every regular file under root (forward slashes). */
export function workspaceManifest(root) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out[path.relative(root, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(root);
  return out;
}
