import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(HERE, '..', '..', '..');
export const REGISTRY_FILE = path.join(PROJECT_ROOT, '.lt-usage-reader', 'homes.json');

export function isHomeDir(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return fs.statSync(path.join(dir, 'sessions')).isDirectory();
  } catch {
    return false;
  }
}

export function registryFile() {
  return process.env.LT_USAGE_REGISTRY
    ? path.resolve(process.env.LT_USAGE_REGISTRY)
    : REGISTRY_FILE;
}

export function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    return Array.isArray(data.homes)
      ? data.homes.filter((item) => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export function registerHome(dir) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('home path is required');
  }
  const resolved = path.resolve(dir);
  if (!isHomeDir(resolved)) {
    throw new Error(`not a home directory (missing sessions/): ${resolved}`);
  }
  const homes = readRegistry();
  if (!homes.some((item) => samePath(item, resolved))) homes.push(resolved);
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ homes }, null, 2)}\n`);
  return resolved;
}

export function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export function listKnownHomes(explicit) {
  const out = [];
  const add = (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (out.some((item) => samePath(item, resolved))) return;
    if (isHomeDir(resolved)) out.push(resolved);
  };
  add(explicit);
  add(process.env.DSH_HOME);
  add('D:\\DSH-Official-Data\\home');
  add('D:\\DSH-Official-Data');
  for (const dir of readRegistry()) add(dir);
  return out;
}

export function resolveDefaultHome(explicit) {
  if (explicit && !isHomeDir(explicit)) {
    throw new Error(`not a home directory (missing sessions/): ${path.resolve(explicit)}`);
  }
  const homes = listKnownHomes(explicit);
  if (homes.length === 0) {
    throw new Error(
      'no DSH home found (use --home, set DSH_HOME, or register one via POST /api/homes)'
    );
  }
  return homes[0];
}

export function resolveHomeParam(param, explicit) {
  if (explicit && !isHomeDir(explicit)) {
    throw new Error(`not a home directory (missing sessions/): ${path.resolve(explicit)}`);
  }
  const homes = listKnownHomes(explicit);
  if (!param) {
    if (homes.length === 0) throw new Error('no DSH home found');
    return homes[0];
  }
  const resolved = path.resolve(param);
  const found = homes.find((item) => samePath(item, resolved));
  if (!found) {
    throw new Error(`unknown home: ${param} (register it with POST /api/homes)`);
  }
  return found;
}

export function homeLabel(dir) {
  const base = path.basename(dir);
  if (base.toLowerCase() === 'home') {
    const parent = path.basename(path.dirname(dir));
    if (parent) return `${parent}/home`;
  }
  return base;
}