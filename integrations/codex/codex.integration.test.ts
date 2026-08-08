import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createStdioMcpServer } from '@commander/mcp-server';
import { parseSimpleToml } from '../helpers/simpleToml.js';
import {
  baseAction,
  InMemoryGateway,
  putKillSwitch,
  proveGatewayMcpLifecycle,
  withGateway,
} from '../helpers/gatewayHarness.js';

const GATEWAY_TOOLS = [
  'commander_action_evidence',
  'commander_action_get',
  'commander_action_propose',
  'commander_action_simulate',
];

describe('codex CLI integration', () => {
  it('committed config.toml advertises the commander MCP server behind the gateway', () => {
    const config = parseSimpleToml(readFileSync(new URL('./config.toml', import.meta.url), 'utf8'));
    const mcpServers = config.mcp_servers as Record<string, unknown>;
    const serverCfg = mcpServers.commander as Record<string, unknown>;
    assert.ok(serverCfg);
    assert.equal(serverCfg.command, 'node');
    assert.deepEqual(serverCfg.args, ['./packages/mcp-server/dist/cli.js']);
    assert.equal(serverCfg.cwd, '.');
    const env = serverCfg.env as Record<string, string>;
    assert.equal(env.COMMANDER_ACTION_GATEWAY_URL, 'http://127.0.0.1:4000');
  });

  it('server advertises the four agent-facing gateway tools (discovery)', async () => {
    const { server, status } = createStdioMcpServer({});
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const result = response.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, GATEWAY_TOOLS);
    assert.equal(status.enterpriseWrites, true);
  });

  it('routes an agent proposal through the gateway and completes the governed lifecycle', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const { server } = createStdioMcpServer({ actionGatewayUrl: baseUrl });
      const evidence = await proveGatewayMcpLifecycle(
        (request) => server.handleRequest(request as Parameters<typeof server.handleRequest>[0]),
        gateway,
        baseUrl,
      );
      assert.equal(evidence.verification.ok, true);
    });
  });

  it('fails closed (ACTION_GATEWAY_REQUIRED) without a configured gateway', async () => {
    const { server } = createStdioMcpServer({});
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'commander_action_propose',
        arguments: {
          action: 'ticket.create',
          args: { title: 'x' },
        },
      },
    });
    const error = response.error as { message: string };
    assert.ok(error);
    assert.match(error.message, /ACTION_GATEWAY_REQUIRED/);
  });

  it('does not let agent input bypass a package kill switch', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const enabled = await putKillSwitch(baseUrl, 'package', 'commander.action-gateway', {
        enabled: true,
        reason: 'integration test',
      });
      assert.equal(enabled.status, 200);

      const { server } = createStdioMcpServer({ actionGatewayUrl: baseUrl });
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'commander_action_propose',
          arguments: {
            action: 'ticket.create',
            ...baseAction,
            package: 'untrusted-package',
          },
        },
      });

      const error = response.error as { message: string };
      assert.ok(error);
      assert.match(error.message, /KILL_SWITCH_ACTIVE/);
    });
  });

  it('does not let agent input bypass a model kill switch', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const enabled = await putKillSwitch(baseUrl, 'model', 'gateway-default', {
        enabled: true,
        reason: 'integration test',
      });
      assert.equal(enabled.status, 200);

      const { server } = createStdioMcpServer({ actionGatewayUrl: baseUrl });
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'commander_action_propose',
          arguments: {
            action: 'ticket.create',
            ...baseAction,
            model: 'untrusted-model',
          },
        },
      });

      const error = response.error as { message: string };
      assert.ok(error);
      assert.match(error.message, /KILL_SWITCH_ACTIVE/);
    });
  });
});
