// Ported from dsh-auto-review v0.15.0 src/review.ts (Apache-2.0); see ../NOTICE. Pure.
export const REDACTED = '[REDACTED]';
const INLINE_SECRET_KEY = '(?:api[_-]?key|token|secret|password|passwd|pwd|authorization|credential|private[_-]?key|access[_-]?key)';
const INLINE_SECRET_ASSIGN = new RegExp(`((?:["'])?${INLINE_SECRET_KEY}(?:["'])?\\s*[:=]\\s*)(["']?)((?:(?:Bearer|Basic)\\s+)?)([^\\s"';&|,)}\\]\\[]+)`, 'giu');
const INLINE_SECRET_FLAG = new RegExp(`(--?${INLINE_SECRET_KEY}\\s+)(["']?)([^\\s"';&|,)]+)`, 'giu');
const STANDALONE_BEARER_RE = /\b(Bearer)\s+(?!\[REDACTED\b|tokens?\b|headers?\b|auth(?:entication|orization)?\b|scheme\b)([A-Za-z0-9._~+/=-]{6,})/giu;
const STANDALONE_BASIC_RE = /\b(Basic)\s+(?!\[REDACTED\b)(?=[A-Za-z0-9+/=]*(?:[0-9+/=]|[A-Z].*[A-Z]))([A-Za-z0-9+/=]{6,})/gu;
const STANDALONE_KEY_PREFIX_RE = /\b(?:(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{8,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/gu;
const METRIC_UNIT_WORDS = new Set(['chars', 'bytes', 'ms', 'sec', 'secs', 'seconds', 'minutes', 'min', 'pct', 'count', 'counts', 'length', 'limit', 'limits', 'size']);

function isSensitiveKey(key) {
  const words = String(key ?? '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (words.length === 0) return false;
  const last = words[words.length - 1];
  if (METRIC_UNIT_WORDS.has(last) && words.length >= 2) {
    if (!words.includes('secret') && !words.includes('password') && !words.includes('passwd') && !words.includes('pwd')) {
      return false;
    }
  }
  if (last === 'tokens' && (words[0] === 'max' || words[0] === 'min' || words[0] === 'input' || words[0] === 'output' || words[0] === 'total' || words.includes('cache'))) {
    return false;
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (
      w === 'password' || w === 'passwd' || w === 'pwd'
      || w === 'secret' || w === 'secrets'
      || w === 'token' || w === 'tokens'
      || w === 'authorization' || w === 'auth'
      || w === 'credential' || w === 'credentials'
      || w === 'apikey' || w === 'privatekey' || w === 'accesskey'
    ) {
      return true;
    }
    if ((w === 'api' || w === 'private' || w === 'access') && (words[i + 1] === 'key' || words[i + 1] === 'keys')) {
      return true;
    }
  }
  return false;
}

export function redactInlineSecrets(text) {
  return text
    .replace(INLINE_SECRET_ASSIGN, (_m, head, quote, scheme) => head + quote + scheme + REDACTED)
    .replace(INLINE_SECRET_FLAG, (_m, head, quote) => head + quote + REDACTED)
    .replace(STANDALONE_BEARER_RE, (_m, scheme) => `${scheme} ${REDACTED}`)
    .replace(STANDALONE_BASIC_RE, (_m, scheme) => `${scheme} ${REDACTED}`)
    .replace(STANDALONE_KEY_PREFIX_RE, REDACTED);
}
/**
 * The inline values redactInlineSecrets would hide in `text`, in order. Pure.
 * Each: { form: 'assign' | 'flag', separator: '=' | ':' | ' ', quoted: boolean, value: string }.
 * `quoted` is true only when a quote directly follows the separator (the value is a string literal).
 */
export function inlineSecretMatches(text) {
  const out = [];
  for (const m of String(text).matchAll(INLINE_SECRET_ASSIGN)) out.push({ form: 'assign', separator: m[1].includes('=') ? '=' : ':', quoted: m[2] !== '', value: m[4] });
  for (const m of String(text).matchAll(INLINE_SECRET_FLAG)) out.push({ form: 'flag', separator: ' ', quoted: m[2] !== '', value: m[3] });
  return out;
}
export function sanitizeArguments(value) {
  if (Array.isArray(value)) return value.map(item => sanitizeArguments(item));
  if (typeof value === 'object' && value !== null) {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = isSensitiveKey(key) ? REDACTED : sanitizeArguments(item);
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
