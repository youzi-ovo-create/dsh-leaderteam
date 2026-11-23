// Skill catalog discovery and loader module. Pure filesystem operations with strict boundary checks.

import nodePath from 'node:path';
import nodeFs from 'node:fs';
import { LtError } from './constants.mjs';
import { resolvePath, isInside, pathKey } from './paths.mjs';
import { sha256Hex } from './canonical.mjs';

const DEFAULT_MAX_SKILLS = 100;
const DEFAULT_MAX_BYTES = 65536; // 64 KiB
const MAX_SEARCH_DEPTH = 4;

/**
 * Minimal frontmatter parser.
 * Extracts `name` and `description` from YAML frontmatter (between opening and closing ---).
 * Handles:
 * - unquoted, single-quoted, and double-quoted values
 * - folded multiline (>)
 * - literal multiline (|)
 * - indented continuation lines
 * Falls back to first Markdown heading (# ...) for name if not in frontmatter.
 */
export function extractSkillMetadata(text, fallbackDirName = '') {
  if (typeof text !== 'string') {
    return { name: fallbackDirName, description: '' };
  }

  const cleanText = text.replace(/^\uFEFF/, '');
  let name = null;
  let description = null;

  const fmMatch = cleanText.match(/^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\s*\r?\n|$)/);
  if (fmMatch) {
    const lines = fmMatch[1].split(/\r?\n/);
    const fields = {};
    let currentKey = null;
    let multilineMode = null; // 'folded' (>), 'literal' (|), 'continuation' (indented)
    let multilineLines = [];

    const flushMultiline = () => {
      if (!currentKey) return;
      if (multilineMode === 'literal') {
        fields[currentKey] = multilineLines.join('\n').trim();
      } else if (multilineMode === 'folded') {
        fields[currentKey] = multilineLines.join(' ').replace(/\s+/g, ' ').trim();
      } else if (multilineMode === 'continuation') {
        const combined = [fields[currentKey], ...multilineLines].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        fields[currentKey] = combined;
      }
      currentKey = null;
      multilineMode = null;
      multilineLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Indented continuation
      if (/^\s+/.test(line) && currentKey) {
        multilineLines.push(line.trim());
        continue;
      }
      flushMultiline();

      const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].toLowerCase();
        let val = kvMatch[2].trim();
        if (val === '>' || val === '>-' || val === '>+') {
          currentKey = key;
          multilineMode = 'folded';
          multilineLines = [];
        } else if (val === '|' || val === '|-' || val === '|+') {
          currentKey = key;
          multilineMode = 'literal';
          multilineLines = [];
        } else {
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          fields[key] = val;
          currentKey = key;
          multilineMode = 'continuation';
          multilineLines = [];
        }
      }
    }
    flushMultiline();

    if (typeof fields.name === 'string' && fields.name.trim().length > 0) {
      name = fields.name.trim();
    }
    if (typeof fields.description === 'string') {
      description = fields.description.trim();
    }
  }

  // Fallback for name: first Markdown heading # ...
  if (!name) {
    const headingMatch = cleanText.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      name = headingMatch[1].trim();
    }
  }

  // Fallback for name: fallbackDirName
  if (!name && fallbackDirName) {
    name = fallbackDirName;
  }

  return {
    name: name || 'skill',
    description: description || '',
  };
}

/**
 * Normalizes and resolves an authorized boundary root (workspace or globalRefRoot).
 * Returns { resolved, real } or null if invalid / cannot be resolved.
 */
function resolveAuthorizedRoot(p, base, platform = process.platform, fs = nodeFs) {
  const resolved = resolvePath(p, base, platform);
  if (!resolved) return null;
  let real = resolved;
  try {
    const rawReal = (fs.realpathSync.native ?? fs.realpathSync)(resolved);
    real = resolvePath(rawReal, undefined, platform) ?? resolved;
  } catch {
    // Keep resolved if not existing yet
  }
  return { resolved, real };
}

/**
 * Create a slug from a skill name for deterministic IDs.
 */
function slugifyName(name) {
  const raw = String(name).trim();
  const ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  return raw ? `skill-${sha256Hex(raw).slice(0, 8)}` : 'skill';
}

/**
 * Discover skills in configured roots without loading bodies into model context.
 *
 * @param {Object} options
 * @param {string} options.workspace - Absolute or relative path to workspace.
 * @param {string[]} [options.globalRefRoots] - Authorized reference roots.
 * @param {string[]} [options.skillRoots] - Roots to discover skills in.
 * @param {number} [options.maxSkills=100] - Maximum skills to return.
 * @returns {Array<{id: string, name: string, description: string, path: string, root: string}>}
 */
export function discoverSkills({
  workspace,
  globalRefRoots = [],
  skillRoots,
  maxSkills = DEFAULT_MAX_SKILLS,
} = {}) {
  const platform = process.platform;
  const fs = nodeFs;

  if (typeof workspace !== 'string' || workspace.trim().length === 0) {
    throw new LtError('INVALID_WORKSPACE', 'workspace is required and must be a non-empty string');
  }

  const wsRoot = resolveAuthorizedRoot(workspace, process.cwd(), platform, fs);
  if (!wsRoot) {
    throw new LtError('INVALID_WORKSPACE', `Invalid workspace path: ${workspace}`);
  }

  const authRoots = [wsRoot];
  if (Array.isArray(globalRefRoots)) {
    for (const ref of globalRefRoots) {
      if (typeof ref === 'string' && ref.trim().length > 0) {
        const root = resolveAuthorizedRoot(ref, wsRoot.resolved, platform, fs);
        if (root) authRoots.push(root);
      }
    }
  }

  // Determine candidate skill roots
  let candidateRoots;
  if (skillRoots === undefined || skillRoots === null) {
    candidateRoots = [
      nodePath.join(wsRoot.resolved, '.agents', 'skills'),
      nodePath.join(wsRoot.resolved, '.leaderteam', 'skills'),
    ];
  } else if (Array.isArray(skillRoots)) {
    candidateRoots = skillRoots.map(r => {
      if (typeof r !== 'string' || r.trim().length === 0) {
        throw new LtError('INVALID_ROOT', 'skillRoot must be a non-empty string');
      }
      return resolvePath(r, wsRoot.resolved, platform);
    });
  } else {
    throw new LtError('INVALID_ARGUMENT', 'skillRoots must be an array or undefined');
  }

  const effectiveMax = Number.isInteger(maxSkills) && maxSkills > 0 ? maxSkills : DEFAULT_MAX_SKILLS;

  // Validate and deduplicate candidate roots
  const validRoots = [];
  const seenRootKeys = new Set();

  for (const rootPath of candidateRoots) {
    if (!rootPath) {
      throw new LtError('ROOT_OUT_OF_BOUNDS', 'Invalid root path');
    }

    // Lexical check: must be inside an authorized root
    const lexicalAllowed = authRoots.some(r => isInside(rootPath, r.resolved, platform));
    if (!lexicalAllowed) {
      throw new LtError('ROOT_OUT_OF_BOUNDS', `Skill root is lexically outside authorized roots: ${rootPath}`);
    }

    // Check existence: missing roots are ignored
    if (!fs.existsSync(rootPath)) {
      continue;
    }

    // Stat: must be directory
    let stat;
    try {
      stat = fs.statSync(rootPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    // Realpath check: must be inside authorized realpath
    let realRoot;
    try {
      const rawReal = (fs.realpathSync.native ?? fs.realpathSync)(rootPath);
      realRoot = resolvePath(rawReal, undefined, platform) ?? rawReal;
    } catch {
      continue;
    }

    const realAllowed = authRoots.some(r => isInside(realRoot, r.real, platform));
    if (!realAllowed) {
      throw new LtError('ROOT_OUT_OF_BOUNDS', `Skill root realpath is outside authorized roots: ${rootPath} -> ${realRoot}`);
    }

    const k = pathKey(rootPath, platform);
    if (!seenRootKeys.has(k)) {
      seenRootKeys.add(k);
      validRoots.push({ resolved: rootPath, real: realRoot });
    }
  }

  // Sort valid roots deterministically
  validRoots.sort((a, b) => pathKey(a.resolved, platform).localeCompare(pathKey(b.resolved, platform)));

  const discovered = [];
  const seenSkillFileRealpaths = new Set();

  // Helper to process a SKILL.md file
  function tryAddSkill(skillMdPath, currentRoot) {
    if (discovered.length >= effectiveMax) return true;

    let stat;
    try {
      stat = fs.statSync(skillMdPath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    let realFilePath;
    try {
      const rawReal = (fs.realpathSync.native ?? fs.realpathSync)(skillMdPath);
      realFilePath = resolvePath(rawReal, undefined, platform) ?? rawReal;
    } catch {
      return false;
    }

    // Must be inside current root realpath and authorized roots
    if (!isInside(realFilePath, currentRoot.real, platform)) return false;
    if (!authRoots.some(r => isInside(realFilePath, r.real, platform))) return false;

    const fileKey = pathKey(realFilePath, platform);
    if (seenSkillFileRealpaths.has(fileKey)) return false;
    seenSkillFileRealpaths.add(fileKey);

    // Read file locally to extract metadata only (do not store body in context)
    let text = '';
    try {
      const fd = fs.openSync(skillMdPath, 'r');
      try {
        const header = Buffer.alloc(Math.min(stat.size, 8192));
        const count = fs.readSync(fd, header, 0, header.length, 0);
        text = header.subarray(0, count).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch {
      return false;
    }

    const fallbackDirName = nodePath.basename(nodePath.dirname(skillMdPath));
    const meta = extractSkillMetadata(text, fallbackDirName);

    discovered.push({
      candidateName: meta.name.slice(0, 160),
      description: meta.description.slice(0, 1000),
      path: skillMdPath,
      root: currentRoot.resolved,
    });

    return discovered.length >= effectiveMax;
  }

  // Scan each root
  for (const rootObj of validRoots) {
    if (discovered.length >= effectiveMax) break;

    // Check if root itself directly contains SKILL.md
    const directSkillMd = nodePath.join(rootObj.resolved, 'SKILL.md');
    if (fs.existsSync(directSkillMd)) {
      if (tryAddSkill(directSkillMd, rootObj)) break;
      continue;
    }

    // Traversal queue for bounded directory search
    const queue = [{ dirPath: rootObj.resolved, depth: 0 }];
    const visitedDirs = new Set([pathKey(rootObj.real, platform)]);

    while (queue.length > 0) {
      if (discovered.length >= effectiveMax) break;
      const { dirPath, depth } = queue.shift();

      let entries;
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      // Sort entries deterministically
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

      // Check for SKILL.md in current directory (unless at root depth 0, which was checked above)
      if (depth > 0) {
        const skillMdEntry = entries.find(e => e.name.toLowerCase() === 'skill.md');
        if (skillMdEntry) {
          const skillMdPath = nodePath.join(dirPath, skillMdEntry.name);
          if (tryAddSkill(skillMdPath, rootObj)) break;
          // When a directory is a skill (contains SKILL.md), do not recurse into its subdirectories
          continue;
        }
      }

      if (depth >= MAX_SEARCH_DEPTH) continue;

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        const name = entry.name;
        // Ignore hidden, .git, node_modules, vendor
        if (name.startsWith('.')) continue;
        const lowerName = name.toLowerCase();
        if (lowerName === 'node_modules' || lowerName === 'vendor') continue;

        const subPath = nodePath.join(dirPath, name);

        let realSub;
        try {
          const rawReal = (fs.realpathSync.native ?? fs.realpathSync)(subPath);
          realSub = resolvePath(rawReal, undefined, platform) ?? rawReal;
        } catch {
          continue;
        }

        // Must not traverse junctions/symlinks outside authorized roots
        if (!authRoots.some(r => isInside(realSub, r.real, platform))) {
          continue;
        }
        if (!isInside(realSub, rootObj.real, platform)) {
          continue;
        }

        const subKey = pathKey(realSub, platform);
        if (visitedDirs.has(subKey)) continue;
        visitedDirs.add(subKey);

        queue.push({ dirPath: subPath, depth: depth + 1 });
      }
    }
  }

  // Stable deterministic ID generation and duplicate name disambiguation
  const seenIds = new Set();
  const catalog = [];

  for (const item of discovered) {
    const baseSlug = slugifyName(item.candidateName);
    let finalId = baseSlug;

    if (seenIds.has(finalId)) {
      let counter = 2;
      while (seenIds.has(`${baseSlug}-${counter}`)) {
        counter++;
      }
      finalId = `${baseSlug}-${counter}`;
    }
    seenIds.add(finalId);

    const record = {
      id: finalId,
      name: item.candidateName,
      description: item.description,
      path: item.path,
      root: item.root,
    };

    // Attach non-enumerable properties for tamper detection
    Object.defineProperty(record, '_canonicalPath', {
      value: item.path,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(record, '_canonicalRoot', {
      value: item.root,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    catalog.push(record);
  }

  return catalog;
}

/**
 * Load skill instructions and verify boundaries and sha256.
 *
 * @param {Array} catalog - Catalog array returned by discoverSkills.
 * @param {string} id - Skill ID to load.
 * @param {Object} options
 * @param {string} options.workspace - Absolute or relative path to workspace.
 * @param {string[]} [options.globalRefRoots] - Authorized reference roots.
 * @param {number} [options.maxBytes=65536] - Maximum allowed byte size.
 * @returns {{id: string, name: string, path: string, root: string, text: string, sha256: string}}
 */
export function loadSkill(catalog, id, {
  workspace,
  globalRefRoots = [],
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const platform = process.platform;
  const fs = nodeFs;

  if (!Array.isArray(catalog)) {
    throw new LtError('INVALID_CATALOG', 'catalog must be an array');
  }

  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new LtError('INVALID_SKILL_ID', 'id must be a non-empty string');
  }

  const matches = catalog.filter(entry => entry && entry.id === id);
  if (matches.length === 0) {
    throw new LtError('SKILL_NOT_FOUND', `Skill not found in catalog: ${id}`);
  }
  if (matches.length > 1) {
    throw new LtError('DUPLICATE_SKILL_ID', `Duplicate skill id '${id}' found in catalog`);
  }

  const entry = matches[0];
  if (!entry.path || typeof entry.path !== 'string' || !entry.root || typeof entry.root !== 'string') {
    throw new LtError('INVALID_CATALOG_ENTRY', 'Catalog entry is missing required path or root properties');
  }

  // Path changed after discovery check
  if (entry._canonicalPath !== undefined && entry._canonicalPath !== entry.path) {
    throw new LtError('SKILL_PATH_TAMPERED', `Skill path was modified after discovery: ${entry.path}`);
  }
  if (entry._canonicalRoot !== undefined && entry._canonicalRoot !== entry.root) {
    throw new LtError('SKILL_PATH_TAMPERED', `Skill root was modified after discovery: ${entry.root}`);
  }

  if (!/[/\\]skill\.md$/i.test(entry.path)) {
    throw new LtError('SKILL_PATH_TAMPERED', `Skill path does not point to SKILL.md: ${entry.path}`);
  }

  if (typeof workspace !== 'string' || workspace.trim().length === 0) {
    throw new LtError('INVALID_WORKSPACE', 'workspace is required and must be a non-empty string');
  }

  const wsRoot = resolveAuthorizedRoot(workspace, process.cwd(), platform, fs);
  if (!wsRoot) {
    throw new LtError('INVALID_WORKSPACE', `Invalid workspace path: ${workspace}`);
  }

  const authRoots = [wsRoot];
  if (Array.isArray(globalRefRoots)) {
    for (const ref of globalRefRoots) {
      if (typeof ref === 'string' && ref.trim().length > 0) {
        const root = resolveAuthorizedRoot(ref, wsRoot.resolved, platform, fs);
        if (root) authRoots.push(root);
      }
    }
  }

  // Revalidate entry.root is authorized lexically
  const rootLexicalMatch = authRoots.some(r => isInside(entry.root, r.resolved, platform));
  if (!rootLexicalMatch) {
    throw new LtError('ROOT_OUT_OF_BOUNDS', `Skill root is outside authorized roots: ${entry.root}`);
  }

  // Revalidate entry.path is lexically inside entry.root
  if (!isInside(entry.path, entry.root, platform)) {
    throw new LtError('SKILL_ESCAPE', `Skill path is outside root: ${entry.path}`);
  }

  // Revalidate realpath of root
  let realRoot;
  try {
    const rawReal = (fs.realpathSync.native ?? fs.realpathSync)(entry.root);
    realRoot = resolvePath(rawReal, undefined, platform) ?? rawReal;
  } catch {
    throw new LtError('ROOT_NOT_FOUND', `Skill root does not exist: ${entry.root}`);
  }

  const rootRealMatch = authRoots.some(r => isInside(realRoot, r.real, platform));
  if (!rootRealMatch) {
    throw new LtError('ROOT_OUT_OF_BOUNDS', `Skill root realpath is outside authorized roots: ${entry.root} -> ${realRoot}`);
  }

  // Check file exists on disk
  if (!fs.existsSync(entry.path)) {
    throw new LtError('SKILL_NOT_FOUND', `Skill file missing: ${entry.path}`);
  }

  let stat;
  try {
    stat = fs.statSync(entry.path);
  } catch (err) {
    throw new LtError('SKILL_NOT_FOUND', `Cannot stat skill file: ${entry.path}`, { cause: err.message });
  }

  if (!stat.isFile()) {
    throw new LtError('SKILL_INVALID', `Skill path is not a file: ${entry.path}`);
  }

  const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  if (stat.size > byteLimit) {
    throw new LtError('SKILL_TOO_LARGE', `Skill size ${stat.size} exceeds maximum ${byteLimit} bytes`);
  }

  let realFilePath;
  try {
    const rawReal = (fs.realpathSync.native ?? fs.realpathSync)(entry.path);
    realFilePath = resolvePath(rawReal, undefined, platform) ?? rawReal;
  } catch (err) {
    throw new LtError('SKILL_NOT_FOUND', `Cannot resolve realpath: ${entry.path}`, { cause: err.message });
  }

  if (!isInside(realFilePath, realRoot, platform)) {
    throw new LtError('SKILL_ESCAPE', `Skill realpath escapes root: ${realFilePath} not inside ${realRoot}`);
  }

  const fileRealMatch = authRoots.some(r => isInside(realFilePath, r.real, platform));
  if (!fileRealMatch) {
    throw new LtError('SKILL_ESCAPE', `Skill realpath escapes authorized roots: ${realFilePath}`);
  }

  const text = fs.readFileSync(entry.path, 'utf8');
  const actualBytes = Buffer.byteLength(text, 'utf8');
  if (actualBytes > byteLimit) {
    throw new LtError('SKILL_TOO_LARGE', `Skill content length ${actualBytes} bytes exceeds maximum ${byteLimit} bytes`);
  }

  const sha256 = sha256Hex(text);

  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    root: entry.root,
    text,
    sha256,
  };
}
