import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as dns from 'node:dns';
import * as http from 'node:http';
import { A2AClient } from '../../src/mcp/a2aClient';
import { A2AServer } from '../../src/mcp/a2aServer';
import {
  getOutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
} from '../../src/security/outboundNetworkPolicy';
import type { AgentRuntimeInterface } from '../../src/runtime';

const stubRuntime = {
  execute: vi.fn(),
} as unknown as AgentRuntimeInterface;

const AUTH_TOKEN = 'test-auth-token-0123456789abcdef';
const originalFetch = globalThis.fetch;
const originalLookup = dns.promises.lookup;

afterEach(() => {
  globalThis.fetch = originalFetch;
  dns.promises.lookup = originalLookup;
  resetOutboundNetworkPolicy();
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server failed to listen');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

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
  let port: number;

  beforeAll(async () => {
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
    port = server.getPort();
  });

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('rejects JSON-RPC requests without Authorization header', async () => {
    const res = await postJson(port, '/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/list',
      params: {},
    });

    expect(res.status).toBe(401);
  });

  it('rejects JSON-RPC requests with wrong bearer token', async () => {
    const res = await postJson(
      port,
      '/',
      { jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} },
      { Authorization: 'Bearer wrong-token' },
    );

    expect(res.status).toBe(401);
  });

  it('accepts JSON-RPC requests with correct bearer token', async () => {
    const res = await postJson(
      port,
      '/',
      { jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} },
      { Authorization: `Bearer ${AUTH_TOKEN}` },
    );

    expect(res.status).toBe(200);
    expect((res.body as any).error).toBeUndefined();
  });
});

describe('A2AClient outbound security', () => {
  it('rejects a private DNS answer before opening an A2A connection', async () => {
    dns.promises.lookup = (async () => [
      { address: '127.0.0.1', family: 4 },
    ]) as typeof dns.promises.lookup;
    const client = new A2AClient('https://rebind.example.test', AUTH_TOKEN);

    await expect(client.getAgentCard()).rejects.toThrow(/OUTBOUND_BLOCKED.*private IP/i);
  });

  it('rejects a cross-origin redirect without forwarding Authorization', async () => {
    let targetHits = 0;
    let targetAuthorization: string | undefined;
    const target = http.createServer((req, res) => {
      targetHits += 1;
      targetAuthorization = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'redirect target' }));
    });
    const targetUrl = await listen(target);
    const source = http.createServer((_req, res) => {
      res.writeHead(302, { location: `${targetUrl}/stolen` });
      res.end();
    });
    const sourceUrl = await listen(source);
    const policy = getOutboundNetworkPolicy({ enabled: true });
    const localFetch = (init?: RequestInit) => originalFetch(sourceUrl, init);
    globalThis.fetch = ((_url, init) => localFetch(init)) as typeof globalThis.fetch;
    policy.ssrfCheckedFetch = (async (_url, init) =>
      localFetch(init)) as typeof policy.ssrfCheckedFetch;

    try {
      const client = new A2AClient('https://public-a2a.example.test', AUTH_TOKEN);
      await expect(client.getAgentCard()).rejects.toThrow(/redirects are not allowed/i);
      expect(targetHits).toBe(0);
      expect(targetAuthorization).toBeUndefined();
    } finally {
      await close(source);
      await close(target);
    }
  });

  it('defines same-origin redirects as denied', async () => {
    let redirectedHits = 0;
    const source = http.createServer((req, res) => {
      if (req.url === '/redirected-card') {
        redirectedHits += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'redirected card' }));
        return;
      }
      res.writeHead(302, { location: '/redirected-card' });
      res.end();
    });
    const sourceUrl = await listen(source);
    const policy = getOutboundNetworkPolicy({ enabled: true });
    const localFetch = (init?: RequestInit) => originalFetch(sourceUrl, init);
    globalThis.fetch = ((_url, init) => localFetch(init)) as typeof globalThis.fetch;
    policy.ssrfCheckedFetch = (async (_url, init) =>
      localFetch(init)) as typeof policy.ssrfCheckedFetch;

    try {
      const client = new A2AClient('https://public-a2a.example.test', AUTH_TOKEN);
      await expect(client.getAgentCard()).rejects.toThrow(/redirects are not allowed/i);
      expect(redirectedHits).toBe(0);
    } finally {
      await close(source);
    }
  });
});
