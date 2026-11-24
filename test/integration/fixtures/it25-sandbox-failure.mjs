export const name = 'lt-it25-sandbox-failure';
export const inject = ['tools'];
export function apply(ctx) {
  const shTool = process.platform === 'win32' ? 'pwsh' : 'bash';
  const errMsg = process.platform === 'win32'
    ? 'SetNamedSecurityInfoW failed (Win32 5): grantWrite(TEST_WORKSPACE)'
    : 'bwrap: setting up uid map: Permission denied';
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') return;
    const original = ctx.tools.get(shTool, agent);
    if (!original) return; // A restored faulted member must already have shell hidden.
    agent.ctx.tools.register({ ...original, async execute() { throw new Error(errMsg); } });
  });
}
