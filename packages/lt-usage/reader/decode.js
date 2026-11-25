import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeSessionBytes } from '../core/index.js';

export const MAX_DECODE_CACHE_ENTRIES = 64;
const cache = new Map();

export function getDecodeCacheSize() {
  return cache.size;
}

export function clearDecodeCache() {
  cache.clear();
}

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
  if (hit && hit.sig === sig) {
    // Refresh LRU order
    cache.delete(file);
    cache.set(file, hit);
    return hit;
  }
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
  if (cache.has(file)) cache.delete(file);
  while (cache.size >= MAX_DECODE_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
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