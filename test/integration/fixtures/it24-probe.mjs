export const name = 'lt-it24-frozen-admission-probe';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'it24_load_probe',
    description: 'Test-only causal check of official step admission after a completed load.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(_args, exec) {
      const loader = ctx.tools.get('team_tools', exec.agent, exec.toolSet);
      await loader.execute({ action: 'load', names: ['write'] }, exec);
      const loadedNow = Boolean(ctx.tools.get('write', exec.agent));
      const stepFrozen = ctx.tools.get('write', exec.agent, exec.toolSet) === undefined;
      if (!exec.toolSet || !loadedNow || !stepFrozen) throw new Error('step admission widened after loading');
      return { loadedNow, stepFrozen };
    },
  }), { label: 'it24_load_probe' });
}
