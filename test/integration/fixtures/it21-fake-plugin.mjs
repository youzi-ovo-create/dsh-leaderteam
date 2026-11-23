export const name = 'lt-test-it21-fake-tool';
export const inject = ['tools'];

export function apply(ctx) {
  const def = {
    name: 'it21_fake_mcp_tool',
    description: 'Fake MCP distinctive description marker IT21_FAKE_MCP_TOOL_DESC',
    parameters: {
      type: 'object',
      properties: {
        it21_fake_param: {
          type: 'string',
          description: 'Distinctive parameter marker IT21_FAKE_PARAM_DESC',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
    },
    async execute(args) {
      return { ok: true, echo: args?.it21_fake_param };
    },
  };
  ctx.effect(() => ctx.tools.register(def), { label: 'it21_fake_mcp_tool' });
}
