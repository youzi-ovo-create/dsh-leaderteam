// Path normalization, containment and write-scope globs (including POSIX/glob bracket character classes). Pure (fs is injectable).
import nodePath from 'node:path';
import nodeFs from 'node:fs';
import { LtError } from './constants.mjs';

export function api(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

/**
 * Resolve `p` (absolute, or relative to absolute `cwd`) to a normalized absolute path.
 * Returns null for empty/NUL/drive-relative (win32 "C:foo") input or a missing/relative cwd.
 */
export function resolvePath(p, cwd, platform = process.platform) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return null;
  const a = api(platform);
  let s = p;
  if (platform === 'win32') {
    s = s.replace(/\//g, '\\');
    if (s.startsWith('\\\\?\\UNC\\')) s = '\\\\' + s.slice(8);
    else if (s.startsWith('\\\\.\\')) return null;
    else if (s.startsWith('\\\\?\\')) {
      const inner = s.slice(4);
      if (!/^[A-Za-z]:\\/.test(inner)) return null;
      s = inner;
    }
    if (/^[A-Za-z]:(?![\\])/.test(s)) return null; // drive-relative
  }
  if (a.isAbsolute(s) && !(platform === 'win32' && /^\\(?!\\)/.test(s))) return stripTrailing(a.normalize(s), platform);
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const base = resolvePath(cwd, undefined, platform);
  if (base === null) return null;
  return stripTrailing(a.resolve(base, s), platform);
}

function stripTrailing(s, platform) {
  const a = api(platform);
  const root = a.parse(s).root;
  let out = s;
  while (out.length > root.length && (out.endsWith('/') || out.endsWith('\\'))) out = out.slice(0, -1);
  if (platform === 'win32') {
    if (/^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
    const rest = out.slice(root.length);
    if (rest.includes(':')) return null;
    if (rest.length) {
      const segs = rest.split('\\').map(seg => seg.replace(/[. ]+$/, ''));
      if (segs.some(seg => seg === '')) return null;
      out = out.slice(0, root.length) + segs.join('\\');
    }
  }
  return out;
}

/** Comparison key: case-folded on win32. */
export function pathKey(abs, platform = process.platform) {
  return platform === 'win32' ? abs.toLowerCase() : abs;
}

/** True when `child` equals `parent` or lies beneath it. Both must be resolved absolute paths. */
export function isInside(child, parent, platform = process.platform) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false;
  const c = pathKey(child, platform), p = pathKey(parent, platform);
  if (c === p) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Workspace-relative path with '/' separators ('' for the root itself), or null when outside. */
export function relativeInside(root, abs, platform = process.platform) {
  if (!isInside(abs, root, platform)) return null;
  const rel = api(platform).relative(root, abs);
  return rel.split(api(platform).sep).join('/');
}

/** Validate a workspace-relative glob; returns the normalized glob or throws LtError('BAD_GLOB'). */
export function normalizeGlob(glob, platform = process.platform) {
  if (typeof glob !== 'string' || glob.trim().length === 0) throw new LtError('BAD_GLOB', 'glob must be a non-empty string');
  const badChars = platform === 'win32' ? /["<>|\x00-\x1f]/ : /["\x00-\x1f]/;
  if (badChars.test(glob)) {
    throw new LtError('BAD_GLOB', `glob contains invalid path characters (pass each glob as a separate array item without embedded quotes): ${glob}`);
  }
  let g = glob.trim().replace(/\\/g, '/');
  while (g.startsWith('./')) g = g.slice(2);
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g)) throw new LtError('BAD_GLOB', `glob must be workspace-relative: ${glob}`);
  const segs = g.split('/');
  if (segs.some(s => s === '..')) throw new LtError('BAD_GLOB', `glob must not contain "..": ${glob}`);
  if (segs.some((s, i) => s === '' && i !== segs.length - 1)) throw new LtError('BAD_GLOB', `glob has an empty segment: ${glob}`);
  if (g.endsWith('/')) g = g.slice(0, -1);
  if (g.length === 0 || g === '.') throw new LtError('BAD_GLOB', 'glob must not name the workspace root; use "**"');
  return g;
}

function esc(s) { return s.replace(/[.+^${}()|[\]\\]/g, '\\$&'); }

function escClassCode(code) {
  const ch = String.fromCharCode(code);
  if (ch === '\\' || ch === ']' || ch === '^' || ch === '-') return '\\' + ch;
  return ch;
}

/**
 * Parse a glob bracket expression `[...]` starting at `str[startIdx] === '['` within a single path segment.
 * Supports ranges (`[0-9]`, `[a-z]`), sets (`[_a-z]`), and negation (`[!0-9]`, `[^0-9]`).
 * Returns null if unclosed before `/` or end of string (treated safely as literal `[`).
 */
function parseBracketClass(str, startIdx) {
  if (str[startIdx] !== '[') return null;
  let i = startIdx + 1;
  if (i >= str.length || str[i] === '/') return null;
  let negated = false;
  if (str[i] === '!' || str[i] === '^') {
    negated = true;
    i++;
  }
  if (i >= str.length || str[i] === '/') return null;
  const ranges = [];
  // A `]` as the very first character of the class is treated as a literal member.
  if (str[i] === ']') {
    const c = str.charCodeAt(i);
    ranges.push([c, c]);
    i++;
  }
  while (i < str.length && str[i] !== ']') {
    if (str[i] === '/') return null;
    const c1 = str.charCodeAt(i);
    if (i + 2 < str.length && str[i + 1] === '-' && str[i + 2] !== ']' && str[i + 2] !== '/') {
      const c2 = str.charCodeAt(i + 2);
      ranges.push([Math.min(c1, c2), Math.max(c1, c2)]);
      i += 3;
    } else {
      ranges.push([c1, c1]);
      i += 1;
    }
  }
  if (i >= str.length || str[i] !== ']' || ranges.length === 0) return null;
  const body = ranges
    .map(([lo, hi]) => (lo === hi ? escClassCode(lo) : `${escClassCode(lo)}-${escClassCode(hi)}`))
    .join('');
  const regexSource = negated ? `(?!/)[^${body}]` : `[${body}]`;
  return { endIdx: i, negated, ranges, regexSource };
}

/** True when `str` contains `*`, `?`, or a valid `[...]` character class. */
export function hasGlobWildcard(str) {
  if (typeof str !== 'string') return false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '*' || ch === '?') return true;
    if (ch === '[' && parseBracketClass(str, i) !== null) return true;
  }
  return false;
}

/** Compile a normalized glob. `**` = any depth (incl. zero), `*` = within a segment, `?` = one char, `[...]` = char class.
 *  A glob without wildcards matches itself and everything beneath it. */
export function globToRegExp(glob, platform = process.platform) {
  const g = normalizeGlob(glob, platform);
  const flags = platform === 'win32' ? 'i' : '';
  if (!hasGlobWildcard(g)) return new RegExp('^' + esc(g) + '(?:/.*)?$', flags);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      const atStart = i === 0 || g[i - 1] === '/';
      const atEnd = i + 2 === g.length || g[i + 2] === '/';
      if (atStart && atEnd) {
        if (i + 2 === g.length) {
          if (re.endsWith('/')) re = re.slice(0, -1) + '(?:/.*)?';
          else re += '.*';
        } else { re += '(?:.*/)?'; i++; }
        i++;
        continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (ch === '*') { re += '[^/]*'; continue; }
    if (ch === '?') { re += '[^/]'; continue; }
    if (ch === '[') {
      const parsed = parseBracketClass(g, i);
      if (parsed) {
        re += parsed.regexSource;
        i = parsed.endIdx;
        continue;
      }
    }
    re += esc(ch);
  }
  return new RegExp('^' + re + '$', flags);
}

export function matchesAnyGlob(rel, globs, platform = process.platform) {
  if (typeof rel !== 'string') return false;
  return globs.some(g => globToRegExp(g, platform).test(rel));
}

function mergeCodeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [lo, hi] = sorted[i];
    const last = out[out.length - 1];
    if (lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function codeInRanges(code, ranges) {
  return ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

function tokenizeSegment(seg) {
  const tokens = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
      continue;
    }
    if (ch === '?') {
      tokens.push({ kind: 'any' });
      continue;
    }
    if (ch === '[') {
      const parsed = parseBracketClass(seg, i);
      if (parsed) {
        tokens.push({ kind: 'class', negated: parsed.negated, ranges: mergeCodeRanges(parsed.ranges) });
        i = parsed.endIdx;
        continue;
      }
    }
    tokens.push({ kind: 'lit', code: seg.charCodeAt(i) });
  }
  return tokens;
}

function tokenMatchesCode(tok, code) {
  if (code === 47) return false; // '/'
  if (tok.kind === 'any') return true;
  if (tok.kind === 'lit') return tok.code === code;
  if (tok.kind === 'class') {
    const hit = codeInRanges(code, tok.ranges);
    return tok.negated ? !hit : hit;
  }
  return false;
}

function singleCharTokensOverlap(ta, tb) {
  if (ta.kind === 'any' || tb.kind === 'any') return true;
  if (ta.kind === 'lit') return tokenMatchesCode(tb, ta.code);
  if (tb.kind === 'lit') return tokenMatchesCode(ta, tb.code);
  // Both are 'class'
  if (!ta.negated && !tb.negated) {
    return ta.ranges.some(([l1, h1]) => tb.ranges.some(([l2, h2]) => l1 <= h2 && l2 <= h1));
  }
  if (ta.negated && tb.negated) {
    return true;
  }
  const pos = ta.negated ? tb : ta;
  const neg = ta.negated ? ta : tb;
  for (const [lo, hi] of pos.ranges) {
    let cur = lo;
    for (const [nLo, nHi] of neg.ranges) {
      if (nHi < cur) continue;
      if (nLo > cur) {
        if (cur !== 47 || cur + 1 <= Math.min(hi, nLo - 1)) return true;
        cur = 48;
      }
      cur = Math.max(cur, nHi + 1);
      if (cur > hi) break;
    }
    if (cur <= hi && !(cur === 47 && hi === 47)) return true;
  }
  return false;
}

function segmentsIntersect(segA, segB) {
  const pa = tokenizeSegment(segA);
  const pb = tokenizeSegment(segB);
  const memo = new Set();
  const step = (ia, ib) => {
    const key = `${ia}:${ib}`;
    if (memo.has(key)) return false;
    memo.add(key);
    if (ia === pa.length && ib === pb.length) return true;
    if (pa[ia]?.kind === 'star') return step(ia + 1, ib) || (ib < pb.length && step(ia, ib + 1));
    if (pb[ib]?.kind === 'star') return step(ia, ib + 1) || (ia < pa.length && step(ia + 1, ib));
    if (ia < pa.length && ib < pb.length && singleCharTokensOverlap(pa[ia], pb[ib])) return step(ia + 1, ib + 1);
    return false;
  };
  return step(0, 0);
}

function globSegmentsForOverlap(glob, platform = process.platform) {
  const g = normalizeGlob(glob, platform);
  const folded = platform === 'win32' ? g.toLowerCase() : g;
  const segs = folded.split('/');
  return hasGlobWildcard(folded) ? segs : [...segs, '**'];
}

/** True when at least one workspace-relative path could match both globs `a` and `b`. */
export function globsOverlap(a, b, platform = process.platform) {
  const sa = globSegmentsForOverlap(a, platform);
  const sb = globSegmentsForOverlap(b, platform);
  const memo = new Set();
  const dfs = (i, j) => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return false;
    memo.add(key);
    if (i === sa.length && j === sb.length) return true;
    if (sa[i] === '**') return dfs(i + 1, j) || (j < sb.length && dfs(i, j + 1));
    if (sb[j] === '**') return dfs(i, j + 1) || (i < sa.length && dfs(i + 1, j));
    if (i < sa.length && j < sb.length && segmentsIntersect(sa[i], sb[j])) return dfs(i + 1, j + 1);
    return false;
  };
  return dfs(0, 0);
}

export function anyGlobOverlaps(globsA, globsB, platform = process.platform) {
  if (!Array.isArray(globsA) || !Array.isArray(globsB)) return false;
  return globsA.some(a => globsB.some(b => globsOverlap(a, b, platform)));
}

/**
 * Resolve symlinks/junctions of the deepest existing ancestor, then re-append the missing tail.
 * Never throws; returns the input when resolution fails.
 */
export function realpathBestEffort(abs, platform = process.platform, fs = nodeFs) {
  const a = api(platform);
  let head = abs; const tail = [];
  for (let i = 0; i < 256; i++) {
    try {
      const real = (fs.realpathSync.native ?? fs.realpathSync)(head);
      return stripTrailing(tail.length ? a.join(real, ...tail.reverse()) : real, platform);
    } catch {
      const parent = a.dirname(head);
      if (parent === head) return abs;
      tail.push(a.basename(head));
      head = parent;
    }
  }
  return abs;
}
