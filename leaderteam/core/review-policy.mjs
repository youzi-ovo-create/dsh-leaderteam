import { hashJson } from './canonical.mjs';
export const HARD_BLOCKER_CATEGORIES = Object.freeze(['safety', 'data_loss', 'user_requirement']);
const text = value => typeof value === 'string' && value.trim().length > 0;

/** Normalize legacy receipts as well as structured reviews; new ordinary revision issues become conditions. */
export function normalizeReview(opinion, { previousItems = [] } = {}) {
  let items = opinion.changeItems;
  if (!items) items = opinion.requiredChanges.map(problem => ({ id: hashJson(problem).slice(0,16), problem,
    evidence: opinion.reasons.join('; '), suggestion: opinion.suggestions?.join('; ') || problem, hard_blocker: false, category: 'ordinary' }));
  if (!Array.isArray(items) || (opinion.conditions && (!Array.isArray(opinion.conditions)||opinion.conditions.some(x=>!text(x)))) || (opinion.resolutions&&!Array.isArray(opinion.resolutions))) throw new Error('review items, conditions and resolutions must be arrays');
  for (const item of items) {
    if (!text(item.id) || !text(item.problem) || !text(item.evidence) || !text(item.suggestion) || typeof item.hard_blocker !== 'boolean') throw new Error('each change item needs id, problem, evidence, suggestion, hard_blocker');
    if (item.hard_blocker && !HARD_BLOCKER_CATEGORIES.includes(item.category)) throw new Error('hard blockers are limited to safety, data_loss, user_requirement');
  }
  const conditions = [...(opinion.conditions ?? [])];
  const rawResolutions = opinion.resolutions ?? [];
  const resolutions = opinion.stance === 'approve' && items.length === 0 && previousItems.length && opinion.reasons?.length
    ? previousItems.map(p => rawResolutions.find(r => r.id === p.id) ?? { id: p.id, status: 'resolved', evidence: opinion.reasons.join('; ') })
    : rawResolutions;
  const priorIds = new Set(previousItems.map(x => x.id));
  const blocking = [];
  for (const item of items) {
    const prior = previousItems.find(p=>p.id===item.id);
    if (prior && prior.problem !== item.problem) throw new Error('a revision cannot redefine an earlier change id');
    if (previousItems.length && !priorIds.has(item.id) && !item.hard_blocker) conditions.push(`${item.problem} — ${item.suggestion}`);
    else blocking.push(item);
  }
  if (previousItems.length) {
    for (const prior of previousItems) {
      const resolution = resolutions.find(r => r.id === prior.id);
      if (!resolution || !['resolved','unresolved'].includes(resolution.status) || !text(resolution.evidence)) throw new Error(`revision must reconcile previous change ${prior.id} with resolved/unresolved and evidence`);
      if (resolution.status === 'unresolved' && !blocking.some(x => x.id === prior.id)) blocking.push(prior);
    }
  }
  // Explicit rejection remains terminal; an ordinary new issue cannot veto an otherwise resolved revision.
  const stance = ['revise','reject'].includes(opinion.stance) && previousItems.length > 0 && blocking.length === 0 ? 'approve' : opinion.stance;
  return { ...opinion, stance, changeItems: blocking, conditions: [...new Set(conditions)], resolutions,
    requiredChanges: stance === 'revise' ? blocking.map(i => i.problem) : [] };
}

export function unresolvedHardBlockers(plan) {
  const items = [...(plan.outcome?.changeItems ?? []), ...(plan.rounds?.at(-1)?.A?.changeItems ?? []), ...(plan.rounds?.at(-1)?.B?.changeItems ?? [])];
  return items.filter(i => i.hard_blocker && HARD_BLOCKER_CATEGORIES.includes(i.category));
}
