// Deterministic JSON + hashing for receipts and agreement identities. Pure.
import { createHash } from 'node:crypto';
import { LtError } from './constants.mjs';

/** Canonical JSON: object keys sorted (code-unit order), no whitespace. Throws on non-JSON values. */
export function canonicalJson(value) {
  return encode(value, 0);
}
function encode(v, depth) {
  if (depth > 64) throw new LtError('NOT_JSON', 'value nests deeper than 64 levels');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new LtError('NOT_JSON', 'non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(x => encode(x, depth + 1)).join(',') + ']';
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new LtError('NOT_JSON', 'non-plain object');
      const keys = Object.keys(v).sort();
      return '{' + keys.map(k => {
        if (v[k] === undefined) throw new LtError('NOT_JSON', `undefined value at key ${k}`);
        return JSON.stringify(k) + ':' + encode(v[k], depth + 1);
      }).join(',') + '}';
    }
    default: throw new LtError('NOT_JSON', `unsupported type ${typeof v}`);
  }
}
export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}
export function hashJson(value) {
  return sha256Hex(canonicalJson(value));
}
/** Deep clone through canonical JSON and deep-freeze; throws on non-JSON. */
export function frozenJsonCopy(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}
export function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
