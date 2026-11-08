/**
 * A very small MCP server core: just enough for the agent to call the tools the worker offers on
 * 127.0.0.1. The worker holds the site's token; the agent only sees these tools.
 */
export interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

/** Answers one JSON-RPC message. Notifications get no reply, so this returns null for them. */
export async function handleRpc(message: RpcMessage, tools: Record<string, McpTool>): Promise<Record<string, unknown> | null> {
  if (message.id === undefined) return null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'turinglife', version: '1.0.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const tool = tools[message.params?.name ?? ''];
      if (!tool) return reply({ content: [{ type: 'text', text: `No tool ${message.params?.name}.` }], isError: true });
      try {
        return reply({ content: [{ type: 'text', text: await tool.run(message.params?.arguments ?? {}) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  }
}
