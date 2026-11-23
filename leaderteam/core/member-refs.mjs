// One reference check shared by execution review and dispatch; references are files, never globs.
import fs from 'node:fs';
import { resolvePath, realpathBestEffort, isInside, relativeInside, matchesAnyGlob } from './paths.mjs';

export function resolveMemberRefs(cfg, cwd, requested = [], platform = process.platform, { futureWriteScopes = [] } = {}) {
  const workspace = resolvePath(cwd, undefined, platform);
  const realWorkspace = realpathBestEffort(workspace, platform);
  const globals = cfg.paths.globalRefRoots.map(g => resolvePath(g, undefined, platform)).filter(Boolean);
  const realGlobals = globals.map(g => realpathBestEffort(g, platform));
  const refs = [];
  for (const ref of requested) {
    if (/[*?]/.test(ref)) throw new Error(`ref must name one existing file, not a glob: ${ref}; expand it to explicit files`);
    const p = resolvePath(ref, workspace, platform);
    if (p === null) throw new Error(`invalid ref path: ${ref}`);
    const realP = realpathBestEffort(p, platform);
    const lexOk = isInside(p, workspace, platform) || globals.some(g => isInside(p, g, platform));
    const realOk = isInside(realP, realWorkspace, platform) || realGlobals.some(g => isInside(realP, g, platform));
    if (!lexOk || !realOk) throw new Error(`ref must be inside the workspace or a global reference root: ${ref}`);
    let st; try { st = fs.statSync(p); } catch (error) {
      const rel = relativeInside(workspace, p, platform);
      if (error.code === 'ENOENT' && rel !== null && matchesAnyGlob(rel, futureWriteScopes, platform)) { refs.push(p); continue; }
      throw new Error(`ref does not exist: ${p}`);
    }
    if (!st.isFile()) throw new Error(`ref is not a file: ${p}`);
    refs.push(p);
  }
  if (refs.length > cfg.team.maxRefsPerMember) throw new Error(`at most ${cfg.team.maxRefsPerMember} refs`);
  return refs;
}
