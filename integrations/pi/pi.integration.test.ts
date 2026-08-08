import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createStdioMcpServer } from '@commander/mcp-server';
import {
  InMemoryGateway,
  proveGatewayMcpLifecycle,
  withGateway,
} from '../helpers/gatewayHarness.js';

const GATEWAY_TOOLS = [
  'commander_action_evidence',
  'commander_action_get',
  'commander_action_propose',
  'commander_action_simulate',
];

interface OmpMcpConfig {
  mcpServers: {
    commander: {
      type: string;
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
    };
  };
}

describe('pi agent (OH-MY-PI) integration', () => {
  it('committed .omp/mcp.json advertises the commander MCP server behind the gateway', () => {
    const serverCfg = readOmpMcpConfig().mcpServers.commander;
    assert.ok(serverCfg);
    assert.equal(serverCfg.type, 'stdio');
    assert.equal(serverCfg.command, 'node');
    assert.deepEqual(serverCfg.args, ['./packages/mcp-server/dist/cli.js']);
    // OH-MY-PI expands ${PWD} itself at discovery time; the committed config
    // keeps the placeholder so the server runs in whichever project pi starts in.
    assert.equal(serverCfg.cwd, '${PWD}');
    assert.equal(serverCfg.env.COMMANDER_ACTION_GATEWAY_URL, 'http://127.0.0.1:4000');
  });

  it('config format: ${PWD} in the committed .omp/mcp.json expands to an absolute cwd and spawns the advertised server', async () => {
    const serverCfg = readOmpMcpConfig().mcpServers.commander;
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    // OMP resolves ${VAR} / ${VAR:-default} from its own process env at
    // discovery; mirror that with the repo root standing in for PWD.
    const env = { ...process.env, PWD: repoRoot, ...serverCfg.env };
    const command = expandEnvVars(serverCfg.command, env);
    const args = serverCfg.args.map((arg) => expandEnvVars(arg, env));
    const cwd = expandEnvVars(serverCfg.cwd, env);
    assert.ok(isAbsolute(cwd), `cwd should expand to an absolute path, got ${cwd}`);
    assert.equal(cwd, repoRoot);

    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
});

function readOmpMcpConfig(): OmpMcpConfig {
  return JSON.parse(
    readFileSync(new URL('./.omp/mcp.json', import.meta.url), 'utf8'),
  ) as OmpMcpConfig;
}

/**
 * Mirrors OH-MY-PI's discovery-time env expansion for `.omp/mcp.json`:
 * `${VAR}` and `${VAR:-default}` resolve from the process env, and unresolved
 * placeholders stay literal (OMP keeps them as-is rather than failing).
 */
function expandEnvVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(
    /\$\{([^}:]+)(?::-([^}]*))?\}/g,
    (_, varName: string, defaultValue?: string) => {
      const envValue = env[varName];
      if (envValue !== undefined) return envValue;
      if (defaultValue !== undefined) return defaultValue;
      return `\${${varName}}`;
    },
  );
}

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
