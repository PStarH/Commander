import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Application } from 'express';
import type { AddressInfo } from 'node:net';
import { createA2AV2Router } from '../src/a2aV2Endpoints';
import { requireA2ABearerAuth } from '../src/a2aAuth';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startV2(options?: { authToken?: string | null }): Promise<TestServer> {
  const app: Application = express();
  app.use(express.json());
  app.use('/a2a/v2', createA2AV2Router(options));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('A2A v2 bearer auth', () => {
  it('returns 500 when authToken is explicitly unconfigured', async () => {
    const server = await startV2({ authToken: null });
    try {
      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
      });
      assert.equal(res.status, 500);
    } finally {
      await server.close();
    }
  });

  it('rejects an unknown method with JSON-RPC -32601 (auth accepted)', async () => {
    const token = 'a2a-test-token-16';
    const server = await startV2({ authToken: token });
    try {
      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown/method', params: {} }),
      });
      // F-A-7: previously `!== 401 && !== 500`, which also passed on 400/403/404.
      assert.equal(res.status, 200);
      const body = (await res.json()) as { jsonrpc: string; id: number; error?: { code: number } };
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, 1);
      assert.equal(body.error?.code, -32601);
    } finally {
      await server.close();
    }
  });

  it('rejects wrong bearer token with 401', async () => {
    const server = await startV2({ authToken: 'a2a-test-token-16' });
    try {
      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token-xxxxx',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
      });
      assert.equal(res.status, 401);
    } finally {
      await server.close();
    }
  });

  it('omitted token option resolves from env (not forced undefined)', async () => {
    const prev = process.env.COMMANDER_A2A_AUTH_TOKEN;
    process.env.COMMANDER_A2A_AUTH_TOKEN = 'env-a2a-token-16chars';
    const server = await startV2();
    try {
      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer env-a2a-token-16chars',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unknown/method', params: {} }),
      });
      // F-A-7: env-resolved token must be accepted by the SAME code path as the
      // explicit option — pin the JSON-RPC outcome, not "not 401 and not 500".
      assert.equal(res.status, 200);
      const body = (await res.json()) as { error?: { code: number } };
      assert.equal(body.error?.code, -32601);
    } finally {
      await server.close();
      if (prev === undefined) delete process.env.COMMANDER_A2A_AUTH_TOKEN;
      else process.env.COMMANDER_A2A_AUTH_TOKEN = prev;
    }
  });
});

describe('requireA2ABearerAuth', () => {
  async function callWith(authorization?: string): Promise<Response> {
    const app: Application = express();
    app.post(
      '/x',
      requireA2ABearerAuth({ token: 'a2a-configured-token-16', mode: 'rest' }),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    try {
      return await fetch(`http://127.0.0.1:${addr.port}/x`, {
        method: 'POST',
        ...(authorization === undefined ? {} : { headers: { Authorization: authorization } }),
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  // F-A-10: the test previously claimed to cover "timing-safe compare" while
  // only exercising the fail-closed branch. Split into what each case proves.
  it('fails closed with 500 when no token is configured', async () => {
    const app: Application = express();
    app.post('/x', requireA2ABearerAuth({ token: null, mode: 'rest' }), (_req, res) => {
      res.status(200).json({ ok: true });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const addr = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/x`, { method: 'POST' });
      assert.equal(res.status, 500);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('accepts the exact bearer token (positive control)', async () => {
    const res = await callWith('Bearer a2a-configured-token-16');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('rejects a wrong-length token without throwing (length-safe compare)', async () => {
    // `crypto.timingSafeEqual` throws on unequal buffer lengths; the
    // production helper must guard first. A 500 here would mean it did not.
    const res = await callWith('Bearer short');
    assert.equal(res.status, 401);
  });

  it('rejects a same-length wrong token with 401', async () => {
    const res = await callWith('Bearer a2a-configured-token-17');
    assert.equal(res.status, 401);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const res = await callWith();
    assert.equal(res.status, 401);
  });
});
