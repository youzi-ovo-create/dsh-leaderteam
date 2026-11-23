// DSH plugin row "leaderteam-lead": the leader's team tools (mount inside the leader preset on Desktop).
import { bindHostImports } from './host/host-imports.mjs';
import { runtime } from './host/runtime.mjs';
let hostError;
let registerTeamTools;
let defineTool;
try {
  bindHostImports();
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
  ({ registerTeamTools } = await import('./host/team-tools.mjs'));
} catch (error) { hostError = error; }
export const name = 'leaderteam-lead';
export const inject = ['tools', 'subagents'];
export function apply(ctx) {
  if (hostError) throw new Error('leaderteam: host imports unavailable; team tools cannot start', { cause: hostError });
  runtime().subagents = ctx.subagents ?? null;
  ctx.effect(() => () => { if (runtime().subagents === ctx.subagents) runtime().subagents = null; }, { label: 'leaderteam-lead subagents-ref' });
  registerTeamTools(ctx);
  if (defineTool && !ctx.tools?.get?.('interrupt_agent') && typeof ctx.subagents?.interrupt === 'function' && typeof ctx.subagents?.resolveName === 'function') {
    const interruptTool = defineTool({
      name: 'interrupt_agent',
      description: "Ask a subagent to stop its current work. This call returns without waiting for it to stop. You can continue a local subagent's conversation later with send_message.",
      parameters: {
        agent: {
          type: 'string',
          required: true,
          description: 'The name of an agent created under you: your direct child or a deeper descendant.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { accepted: { type: 'boolean', required: true } },
        },
        render: args => [{ type: 'text', text: `interrupt requested for agent ${args.agent}` }],
      },
      async execute(args, exec) {
        const caller = exec.agent;
        if (!caller) throw new Error('interrupt_agent requires a calling agent');
        const targetId = await ctx.subagents.resolveName(caller, args.agent, exec.signal);
        ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: caller });
        return { accepted: true };
      },
    });
    ctx.effect(() => ctx.tools.register(interruptTool), { label: 'leaderteam-lead interrupt-agent' });
  }
  const waitMethod = typeof ctx.subagents?.waitForTreeWork === 'function'
    ? 'waitForTreeWork'
    : (typeof ctx.subagents?.waitForChildren === 'function' ? 'waitForChildren' : null);
  if (waitMethod) {
    const orig = ctx.subagents[waitMethod].bind(ctx.subagents);
    ctx.subagents[waitMethod] = async parent => {
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
    ctx.effect(() => () => { ctx.subagents[waitMethod] = orig; }, { label: 'leaderteam-lead review-quiescence' });
  }
}
