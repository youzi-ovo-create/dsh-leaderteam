// DSH plugin row "leaderteam-lead": the leader's team tools (mount inside the leader preset on Desktop).
import { bindHostImports } from './host/host-imports.mjs';
import { runtime } from './host/runtime.mjs';
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
  runtime().subagents = ctx.subagents ?? null;
  ctx.effect(() => () => { if (runtime().subagents === ctx.subagents) runtime().subagents = null; }, { label: 'leaderteam-lead subagents-ref' });
  registerTeamTools(ctx);
  if (typeof ctx.subagents?.waitForChildren === 'function') {
    const orig = ctx.subagents.waitForChildren.bind(ctx.subagents);
    ctx.subagents.waitForChildren = async parent => {
      let joined = await orig(parent);
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
    ctx.effect(() => () => { ctx.subagents.waitForChildren = orig; }, { label: 'leaderteam-lead review-quiescence' });
  }
}
