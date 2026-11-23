// Ported from dsh-auto-review v0.15.0 src/review.ts (Apache-2.0); see ../NOTICE. Pure.
const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|auth|credential|private[_-]?key|access[_-]?key)/iu;
export const REDACTED = '[REDACTED]';
const INLINE_SECRET_KEY = '(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|credential|private[_-]?key|access[_-]?key)';
const INLINE_SECRET_ASSIGN = new RegExp(`(${INLINE_SECRET_KEY}\\s*[:=]\\s*(?:Bearer\\s+|Basic\\s+)?)(["']?)([^\\s"';&|,)]+)`, 'giu');
const INLINE_SECRET_FLAG = new RegExp(`(--?${INLINE_SECRET_KEY}\\s+)(["']?)([^\\s"';&|,)]+)`, 'giu');

export function redactInlineSecrets(text) {
  return text
    .replace(INLINE_SECRET_ASSIGN, (_m, head, quote) => head + quote + REDACTED)
    .replace(INLINE_SECRET_FLAG, (_m, head, quote) => head + quote + REDACTED);
}
/**
 * The inline values redactInlineSecrets would hide in `text`, in order. Pure.
 * Each: { form: 'assign' | 'flag', separator: '=' | ':' | ' ', quoted: boolean, value: string }.
 * `quoted` is true only when a quote directly follows the separator (the value is a string literal).
 */
export function inlineSecretMatches(text) {
  const out = [];
  for (const m of String(text).matchAll(INLINE_SECRET_ASSIGN)) out.push({ form: 'assign', separator: m[1].includes('=') ? '=' : ':', quoted: m[2] !== '', value: m[3] });
  for (const m of String(text).matchAll(INLINE_SECRET_FLAG)) out.push({ form: 'flag', separator: ' ', quoted: m[2] !== '', value: m[3] });
  return out;
}
export function sanitizeArguments(value) {
  if (Array.isArray(value)) return value.map(item => sanitizeArguments(item));
  if (typeof value === 'object' && value !== null) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeArguments(item);
    return copy;
  }
  if (typeof value === 'string') return redactInlineSecrets(value);
  return value;
}
/** Truncate without splitting a surrogate pair; appends '…' when cut. */
export function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}
/**
 * Bound a JSON value for a reviewer prompt: long strings keep head and tail with a marker,
 * then the whole serialization is capped. Returns { text, truncated }.
 */
export function boundJson(value, maxChars, perStringChars = Math.max(200, Math.floor(maxChars / 2))) {
  let truncated = false;
  const shrink = v => {
    if (typeof v === 'string' && v.length > perStringChars) {
      truncated = true;
      const head = Math.floor(perStringChars * 0.75), tail = perStringChars - head;
      return `${truncate(v, head)}[…${v.length - head - tail} chars omitted…]${v.slice(v.length - tail)}`;
    }
    if (Array.isArray(v)) return v.map(shrink);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = shrink(x); return o; }
    return v;
  };
  let text = JSON.stringify(shrink(value));
  if (text === undefined) text = 'null';
  if (text.length > maxChars) { truncated = true; text = truncate(text, maxChars) + ' [arguments truncated]'; }
  return { text, truncated };
}
