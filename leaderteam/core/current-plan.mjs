// Full current plan is core state, independent of optional timer/archive plugins.
import fs from 'node:fs';
import path from 'node:path';
import { safeId, writeFileAtomic } from './store.mjs';
import { realpathBestEffort, isInside } from './paths.mjs';

export function currentPlanRoot(storageRoot, teamId) {
  return path.join(storageRoot, 'teams', safeId(teamId), 'plans');
}
export function currentPlanFile(storageRoot, teamId, taskSeq) {
  if (!Number.isInteger(taskSeq) || taskSeq < 1) throw new Error('invalid current plan task sequence');
  return path.join(currentPlanRoot(storageRoot, teamId), `task-${taskSeq}`, 'plan.md');
}
export function assertCurrentPlanPath(file, storageRoot, teamId, taskSeq) {
  const expected = currentPlanFile(storageRoot, teamId, taskSeq);
  if (path.resolve(file) !== path.resolve(expected)) throw new Error('current plan writes must target this task plan.md');
  const root = currentPlanRoot(storageRoot, teamId);
  if (!isInside(realpathBestEffort(file), realpathBestEffort(root))) throw new Error('current plan path escapes its team directory');
  for (let cur = file; isInside(cur, storageRoot) && cur !== path.dirname(cur); cur = path.dirname(cur)) {
    try { if (fs.lstatSync(cur).isSymbolicLink()) throw new Error('current plan path contains a symbolic link or junction'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.resolve(cur) === path.resolve(storageRoot)) break;
  }
  return expected;
}
export function readCurrentPlan(storageRoot, teamId, taskSeq) {
  const file = assertCurrentPlanPath(currentPlanFile(storageRoot, teamId, taskSeq), storageRoot, teamId, taskSeq);
  try { return { file, content: fs.readFileSync(file, 'utf8') }; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function writeCurrentPlan(storageRoot, teamId, taskSeq, content, mode = 'write') {
  if (typeof content !== 'string' || !content.trim() || content.length > 400000) throw new Error('current plan must contain 1..400000 characters');
  if (!['write', 'append'].includes(mode)) throw new Error('invalid current plan write mode');
  const file = assertCurrentPlanPath(currentPlanFile(storageRoot, teamId, taskSeq), storageRoot, teamId, taskSeq);
  const prior = readCurrentPlan(storageRoot, teamId, taskSeq)?.content ?? '';
  const next = mode === 'append' ? prior + content : content;
  if (next.length > 400000) throw new Error('current plan exceeds 400000 characters');
  writeFileAtomic(file, next);
  return { path: file, bytes: Buffer.byteLength(next), previous_bytes: Buffer.byteLength(prior), scope: 'current_plan' };
}
