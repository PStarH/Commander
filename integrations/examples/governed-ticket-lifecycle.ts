import { createStdioMcpServer } from '@commander/mcp-server';

const baseUrl = process.env.COMMANDER_API_URL ?? 'http://127.0.0.1:4000';
const apiKey = process.env.COMMANDER_API_KEY;

if (!apiKey) {
  console.error('Set COMMANDER_API_KEY to call the Action Gateway');
  process.exit(2);
}

const { server } = createStdioMcpServer({
  actionGatewayUrl: baseUrl,
  actionGatewayApiKey: apiKey,
});

const result = (await server.handleRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'commander_action_propose',
    arguments: {
      source: 'example-agent',
      package: 'governed-ticket-lifecycle',
      model: 'demo-model',
      tool: 'ticket.create',
      destination: 'demo://tickets/approval',
      effectType: 'demo.ticket.create',
      args: { title: 'Reset password', requireApproval: true },
      idempotencyKey: `example-${Date.now()}`,
    },
  },
})) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };

console.log(result.result?.content?.[0]?.text ?? result.error?.message);
