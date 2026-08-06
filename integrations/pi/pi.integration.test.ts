import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createStdioMcpServer } from '@commander/mcp-server';
import { parseSimpleToml } from '../helpers/simpleToml.js';
import {
  createGatewayRoutedMcpServer,
  InMemoryGateway,
  proveMcpGovernedLifecycle,
  withGateway,
} from '../helpers/gatewayHarness.js';

const GATEWAY_TOOLS = [
  'commander_action_approve',
  'commander_action_evidence',
  'commander_action_get',
  'commander_action_propose',
  'commander_action_reconcile',
  'commander_action_simulate',
];

describe('pi agent (OH-MY-PI) integration', () => {
  it('committed .omp/mcp.json advertises the commander MCP server behind the gateway', () => {
    const config = JSON.parse(
      readFileSync(new URL('./.omp/mcp.json', import.meta.url), 'utf8'),
    ) as {
      mcpServers: {
        commander: {
          type: string;
          command: string;
          args: string[];
          cwd: string;
          env: Record<string, string>;
        };
      };
    };
    const serverCfg = config.mcpServers.commander;
    assert.ok(serverCfg);
    assert.equal(serverCfg.type, 'stdio');
    assert.equal(serverCfg.command, 'node');
    assert.deepEqual(serverCfg.args, ['./packages/mcp-server/dist/cli.js']);
    assert.equal(serverCfg.cwd, '${PWD}');
    assert.equal(serverCfg.env.COMMANDER_ACTION_GATEWAY_URL, 'http://127.0.0.1:4000');
  });

  it('server advertises the six canonical gateway tools (discovery)', async () => {
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

  it('routes ticket.create through the gateway and completes the governed lifecycle', async () => {
    const gateway = new InMemoryGateway();
    await withGateway(gateway, async (baseUrl) => {
      const { localCalls, handleRequest } = createGatewayRoutedMcpServer(baseUrl);
      const evidence = await proveMcpGovernedLifecycle(handleRequest, gateway, baseUrl);
      assert.equal(evidence.verification.ok, true);
      assert.deepEqual(localCalls, []);
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
          source: 'test-agent',
          package: 'test-package',
          model: 'test-model',
          tool: 'ticket.create',
          destination: 'demo://tickets',
          effectType: 'demo.ticket.create',
          args: { title: 'x' },
          idempotencyKey: 'action-key-fail-closed',
        },
      },
    });
    const error = response.error as { message: string };
    assert.ok(error);
    assert.match(error.message, /ACTION_GATEWAY_REQUIRED/);
  });

  it('spawned dist/cli.js completes the MCP initialize handshake and advertises gateway tools', async () => {
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'mcp-server', 'dist', 'cli.js');
    const child = spawn(process.execPath, [cliPath], {
      env: { ...process.env, COMMANDER_ACTION_GATEWAY_URL: 'http://127.0.0.1:4000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    try {
      const request = lineClient(child);
      const initialized = (await request({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pi-integration-test', version: '0.0.0' },
        },
      })) as {
        result?: { protocolVersion: string; serverInfo: { name: string; version: string } };
      };
      assert.equal(initialized.result?.protocolVersion, '2024-11-05');
      assert.equal(initialized.result?.serverInfo.name, 'commander-mcp-server');
      assert.equal(initialized.result?.serverInfo.version, '0.2.0');
      const listed = (await request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      })) as { result?: { tools: Array<{ name: string }> } };
      const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
      assert.deepEqual(names, GATEWAY_TOOLS);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(detail + '\n[stderr] ' + stderr);
    } finally {
      child.kill();
    }
  });
});

/**
 * Minimal line-delimited JSON-RPC client over the child's stdio: writes one
 * request, resolves with the next complete response line.
 */
function lineClient(child: ChildProcessWithoutNullStreams) {
  let buffer = '';
  const pending: Array<(line: string) => void> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) pending.shift()?.(line);
    }
  });
  return (request: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP request timed out')), 10_000);
      pending.push((line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as unknown);
      });
      child.stdin.write(JSON.stringify(request) + '\n', (err) => {
        if (err) reject(err);
      });
    });
}
