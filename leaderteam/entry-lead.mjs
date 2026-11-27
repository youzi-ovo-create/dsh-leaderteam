// DSH plugin row "leaderteam-lead": the leader's team tools (mount inside the leader preset on Desktop).
import { bindHostImports } from './host/host-imports.mjs';
import { runtime } from './host/runtime.mjs';

const WAIT_HOOK_SYM = Symbol.for('leaderteam.subagentWaitHook.v1');
const SUBAGENTS_REFS_SYM = Symbol.for('leaderteam.subagentsRefs.v1');

let hostError;
let registerTeamTools;
try {
  bindHostImports();
  ({ registerTeamTools } = await import('./host/team-tools.mjs'));
} catch (error) { hostError = error; }

export const name = 'leaderteam-lead';
export const inject = ['tools', 'subagents'];

export function apply(ctx) {
  if (hostError) throw new Error('leaderteam: host imports unavailable; team tools cannot start', { cause: hostError });
  const rt = runtime();
  const scopeRef = Symbol('leaderteam-lead-scope');

  if (ctx.subagents) {
    if (!(rt[SUBAGENTS_REFS_SYM] instanceof Map)) {
      rt[SUBAGENTS_REFS_SYM] = new Map();
    }
    const refs = rt[SUBAGENTS_REFS_SYM];
    refs.set(scopeRef, ctx.subagents);
    rt.subagents = ctx.subagents;
    ctx.effect(() => () => {
      refs.delete(scopeRef);
      rt.subagents = refs.size > 0 ? [...refs.values()].at(-1) : null;
    }, { label: 'leaderteam-lead subagents-ref' });
  }

  registerTeamTools(ctx);

  const waitMethod = typeof ctx.subagents?.waitForTreeWork === 'function'
    ? 'waitForTreeWork'
    : (typeof ctx.subagents?.waitForChildren === 'function' ? 'waitForChildren' : null);
  if (waitMethod && ctx.subagents) {
    let hookState = ctx.subagents[WAIT_HOOK_SYM];
    if (!hookState || hookState.waitMethod !== waitMethod || ctx.subagents[waitMethod] !== hookState.wrapper) {
      const hasOwn = Object.prototype.hasOwnProperty.call(ctx.subagents, waitMethod);
      const rawOrig = ctx.subagents[waitMethod];
      const wrapper = async parent => {
        let joined = await rawOrig.call(ctx.subagents, parent);
        const jobs = [...(runtime().executionReviewJobs?.values() ?? [])].filter(j => (!parent?.id || j.teamId === parent.id) && j.promise);
        if (jobs.length > 0) {
          await Promise.allSettled(jobs.map(j => j.promise));
          joined = true;
        }
        const govJobs = [...(runtime().governanceJobs?.values() ?? [])].filter(j => (!parent?.id || j.teamId === parent.id) && j.promise);
        if (govJobs.length > 0) {
          await Promise.allSettled(govJobs.map(j => j.promise));
          joined = true;
        }
        while (parent?.id && (runtime().stopReviewPending?.has(parent.id) || runtime().directiveVerifyPending?.has(parent.id))) {
          await new Promise(r => setTimeout(r, 25));
          joined = true;
        }
        return joined;
      };
      hookState = { waitMethod, hasOwn, rawOrig, wrapper, refs: new Set() };
      ctx.subagents[waitMethod] = wrapper;
      Object.defineProperty(ctx.subagents, WAIT_HOOK_SYM, { value: hookState, configurable: true });
    }
    hookState.refs.add(scopeRef);
    ctx.effect(() => () => {
      hookState.refs.delete(scopeRef);
      if (hookState.refs.size === 0 && ctx.subagents[waitMethod] === hookState.wrapper) {
        if (hookState.hasOwn) ctx.subagents[waitMethod] = hookState.rawOrig;
        else delete ctx.subagents[waitMethod];
        delete ctx.subagents[WAIT_HOOK_SYM];
      }
    }, { label: 'leaderteam-lead review-quiescence' });
  }
}
