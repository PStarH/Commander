import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

interface RecordedRequest {
  method: string;
  path: string;
  apiKey?: string;
  tenantId?: string;
  idempotencyKey?: string;
  body?: unknown;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body.length > 0 ? (JSON.parse(body) as unknown) : undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('GATEWAY_PORT_MISSING');
  return address.port;
}

async function readProcess(child: ReturnType<typeof spawn>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.on('data', (chunk: string) => (stderr += chunk));
  const [code] = await once(child, 'close');
  return { code: typeof code === 'number' ? code : 1, stdout, stderr };
}

describe('external Agents SDK to Commander MCP transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolvePromise, reject) => {
            server.close((error) => (error ? reject(error) : resolvePromise()));
          }),
      ),
    );
  });

  it('runs in a separate process, discovers tools over stdio, and submits through the Gateway', async () => {
    const requests: RecordedRequest[] = [];
    const gateway = createServer(async (request, response) => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        ...(typeof request.headers['x-api-key'] === 'string'
          ? { apiKey: request.headers['x-api-key'] }
          : {}),
        ...(typeof request.headers['x-tenant-id'] === 'string'
          ? { tenantId: request.headers['x-tenant-id'] }
          : {}),
        ...(typeof request.headers['idempotency-key'] === 'string'
          ? { idempotencyKey: request.headers['idempotency-key'] }
          : {}),
        body: await requestBody(request),
      });
      sendJson(response, 201, {
        action: { runId: 'rollback-run-1', state: 'PROPOSED', effectType: 'kubernetes.rollback' },
      });
    });
    servers.push(gateway);
    const port = await listen(gateway);
    const root = resolve(import.meta.dirname, '..', '..', '..');
    const input = {
      mode: 'deterministic',
      toolName: 'commander_action_propose',
      args: {
        source: 'external-openai-agent',
        package: '@external/consumer',
        model: 'deterministic-test-model',
        tool: 'kubernetes.rollback',
        destination: 'k8s://sandbox/namespace/deployment',
        effectType: 'kubernetes.rollback',
        args: { targetRevision: 42 },
        idempotencyKey: 'openai-agents-mcp-rollback-1',
      },
      mcpCommand: process.execPath,
      mcpArgs: ['--import', 'tsx', resolve(root, 'packages/mcp-server/src/cli.ts')],
      mcpCwd: root,
      mcpEnv: {
        PATH: process.env.PATH ?? '',
        COMMANDER_PROFILE: 'enterprise',
        COMMANDER_ACTION_GATEWAY_URL: `http://127.0.0.1:${port}`,
        COMMANDER_API_KEY: 'fixture-gateway-key',
        COMMANDER_TENANT_ID: 'fixture-tenant',
      },
      timeoutMs: 20_000,
    };
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, '..', 'src', 'cli.ts')],
      { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin.end(JSON.stringify(input));
    const result = await readProcess(child);
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      agentPid: number;
      runtime: string;
      transport: string;
      discoveredTools: string[];
      gatewayPayload: unknown;
    };
    expect(output.agentPid).not.toBe(process.pid);
    expect(output.runtime).toBe('openai-agents-sdk');
    expect(output.transport).toBe('mcp-stdio');
    expect(output.discoveredTools).toContain('commander_action_propose');
    expect(output.gatewayPayload).toEqual({
      action: { runId: 'rollback-run-1', state: 'PROPOSED', effectType: 'kubernetes.rollback' },
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/actions',
        apiKey: 'fixture-gateway-key',
        tenantId: 'fixture-tenant',
        idempotencyKey: 'openai-agents-mcp-rollback-1',
        body: input.args,
      },
    ]);
  }, 30_000);
});
