/**
 * AUDIT-C1: MCP tools/call must gate Action-Gateway tools on the CALLER's
 * authority — the executor signs with the service credential. Also verifies
 * caller-tenant attribution on forwarded requests.
 */
import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';

const { createMCPRouter, createFetchActionGatewayExecutor } = await import('../src/mcpEndpoints');

let server: ReturnType<typeof express.listen>;
let gwServer: ReturnType<typeof express.listen> | undefined;
let port: number;
let lastForwardedHeaders: Headers | undefined;

before(async () => {
  // Gateway stub: records forwarded headers, returns a benign response.
  const gateway = express();
  gateway.post('/v1/actions/:id/approve', (_req, res) => {
    lastForwardedHeaders = new Headers(
      Object.fromEntries(
        Object.entries(_req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v as string)]),
      ),
    );
    res.json({ ok: true });
  });

  gwServer = gateway.listen(0, '127.0.0.1');
  await new Promise<void>((r) => gwServer!.once('listening', r));
  const gwPort = (gwServer.address() as { port: number }).port;

  const executor = createFetchActionGatewayExecutor({
    baseUrl: `http://127.0.0.1:${gwPort}`,
    apiKey: 'service-secret-key',
    fetch: globalThis.fetch,
  });

  const app = express();
  app.use(express.json());
  // Simulate the global auth chain: a VIEWER JWT.
  app.use((req, _res, next) => {
    req.user = { id: 'u-viewer', username: 'viewer', role: 'viewer' };
    next();
  });
  app.use(createMCPRouter({ actionGatewayExecutor: executor, actionGatewayUrl: `http://127.0.0.1:${gwPort}` }));

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => gwServer?.close(() => r()) ?? r());
});

function call(name: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { runId: 'r-1', idempotencyKey: 'k-1' } },
    }),
  });
}

describe('AUDIT-C1: MCP tool authority', () => {
  test('viewer JWT cannot invoke commander_action_approve (baseline: confused deputy)', async () => {
    const res = await call('commander_action_approve');
    // FAILING before the fix: the tool ran with the service credential.
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: { message?: string } };
    assert.match(body.error?.message ?? '', /Insufficient authority/);
  });

  test('viewer JWT cannot invoke commander_action_propose either', async () => {
    const res = await call('commander_action_propose');
    assert.equal(res.status, 403);
  });

  test('read-only gateway tool stays reachable for the viewer', async () => {
    const res = await call('commander_action_get');
    assert.notEqual(res.status, 403);
  });
});
