export const name = 'lt-it25-sandbox-failure';
export const inject = ['tools'];
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return;
    const original = ctx.tools.get('pwsh', agent);
    if (!original) return; // A restored faulted member must already have shell hidden.
    agent.ctx.tools.register({ ...original, async execute() { throw new Error('SetNamedSecurityInfoW failed (Win32 5): grantWrite(TEST_WORKSPACE)'); } });
  });
}
