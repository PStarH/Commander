import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createStdioMcpServer } from '@commander/mcp-server';
import { MCPServer } from '@commander/core';
import type { Tool } from '@commander/core/runtime';
import { parseSimpleToml } from '../helpers/simpleToml.js';
import {
  createGatewayRoutedMcpServer,
  InMemoryGateway,
  proveMcpGovernedLifecycle,
  withGateway,
} from '../helpers/gatewayHarness.js';

describe('codex CLI integration', () => {
  it('committed config.toml advertises the commander MCP server behind the gateway', () => {
    const config = parseSimpleToml(
      readFileSync(new URL('./config.toml', import.meta.url), 'utf8'),
    );
    const mcpServers = config.mcp_servers as Record<string, unknown>;
    const serverCfg = mcpServers.commander as Record<string, unknown>;
    assert.ok(serverCfg);
    assert.equal(serverCfg.command, 'node');
    assert.deepEqual(serverCfg.args, ['./packages/mcp-server/dist/cli.js']);
    const env = serverCfg.env as Record<string, string>;
    assert.equal(env.COMMANDER_ACTION_GATEWAY_URL, 'http://127.0.0.1:4000');
  });

  it('server advertises commander + model-router tools (discovery)', async () => {
    const { server } = createStdioMcpServer({ modelRouterOnly: true });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const result = response.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['execute_agent', 'list_models', 'route_task']);
  });

  it('routes ticket.create through the gateway and completes the governed lifecycle', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const { localCalls, handleRequest } = createGatewayRoutedMcpServer(baseUrl);
      const evidence = await proveMcpGovernedLifecycle(handleRequest, gateway, baseUrl);
      assert.equal(evidence.verification.ok, true);
      assert.deepEqual(localCalls, []);
    });
  });

  it('fails closed (ACTION_GATEWAY_REQUIRED) without a gateway executor', async () => {
    const localCalls: string[] = [];
    const ticketTool: Tool = {
      definition: {
        name: 'ticket.create',
        description: 'Create a demo support ticket',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
      },
      isReadOnly: false,
      execute: async () => {
        localCalls.push('called');
        return 'local';
      },
    };
    const server = new MCPServer('fail-closed-codex', '0.2.0');
    server.registerCommanderTools(new Map([['ticket.create', ticketTool]]));
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ticket.create', arguments: { title: 'x' } },
    });
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    assert.match(text, /ACTION_GATEWAY_REQUIRED/);
    assert.deepEqual(localCalls, []);
  });
});