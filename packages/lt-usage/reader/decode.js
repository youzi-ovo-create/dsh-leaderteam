import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeSessionBytes } from '../core/index.js';

const cache = new Map();

export function decompressZstd(bytes) {
  return zlib.zstdDecompressSync(bytes);
}

export function readSessionFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return {
      file,
      sig: null,
      rows: [],
      header: null,
      id: path.basename(path.dirname(file)),
      error: err
    };
  }
  const sig = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.sig === sig) return hit;
  let entry;
  try {
    const rows = decodeSessionBytes(fs.readFileSync(file), decompressZstd);
    const header = rows.find((row) => row?.type === 'session') ?? null;
    entry = {
      file,
      sig,
      rows,
      header,
      id: header?.id ?? path.basename(path.dirname(file)),
      error: null
    };
  } catch (err) {
    entry = {
      file,
      sig,
      rows: [],
      header: null,
      id: path.basename(path.dirname(file)),
      error: err
    };
  }
  cache.set(file, entry);
  return entry;
}

export function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}