import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { A2AServer } from '../../src/mcp/a2aServer';
import type { AgentRuntimeInterface } from '../../src/runtime';

const stubRuntime = {
  execute: vi.fn(),
} as unknown as AgentRuntimeInterface;

const AUTH_TOKEN = 'test-auth-token-0123456789abcdef';

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.write(data);
    req.end();
  });
}

describe('A2AServer bearer auth', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('rejects JSON-RPC requests without Authorization header', async () => {
    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
      },
      stubRuntime,
    );
    await server.start();

    const res = await postJson(server.getPort(), '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/list',
      params: {},
    });

    expect(res.status).toBe(401);
  });

  it('rejects JSON-RPC requests with wrong bearer token', async () => {
    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
      },
      stubRuntime,
    );
    await server.start();

    const res = await postJson(
      server.getPort(),
      '/',
      { jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} },
      { Authorization: 'Bearer wrong-token' },
    );

    expect(res.status).toBe(401);
  });

  it('accepts JSON-RPC requests with correct bearer token', async () => {
    server = new A2AServer(
      {
        port: 0,
        host: '127.0.0.1',
        agentCard: { name: 'test', version: '1.0', capabilities: {} } as any,
        authToken: AUTH_TOKEN,
      },
      stubRuntime,
    );
    await server.start();

    const res = await postJson(
      server.getPort(),
      '/',
      { jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} },
      { Authorization: `Bearer ${AUTH_TOKEN}` },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).error).toBeUndefined();
  });
});
