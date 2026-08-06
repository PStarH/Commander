import { MCPServer, createFetchActionGatewayExecutor } from '@commander/core';
import type { Tool } from '@commander/core/runtime';

const baseUrl = process.env.COMMANDER_API_URL ?? 'http://127.0.0.1:4000';
const apiKey = process.env.COMMANDER_API_KEY;

if (!apiKey) {
  console.error('Set COMMANDER_API_KEY to call the Action Gateway');
  process.exit(2);
}

const ticketTool: Tool = {
  definition: {
    name: 'ticket.create',
    description: 'Create a demo support ticket',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  },
  isReadOnly: false,
  execute: async () => 'would-not-run-locally',
};

const server = new MCPServer('governed-demo', '0.2.0');
server.registerCommanderTools(
  new Map([['ticket.create', ticketTool]]),
  undefined,
  { actionGatewayExecutor: createFetchActionGatewayExecutor({ baseUrl, apiKey }) },
);

const result = (await server.handleRequest({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'ticket.create', arguments: { title: 'Reset password', requireApproval: true } },
})) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };

console.log(result.result?.content?.[0]?.text ?? result.error?.message);