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

  it('accepts bearer token when configured', async () => {
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
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 500);
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
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 500);
    } finally {
      await server.close();
      if (prev === undefined) delete process.env.COMMANDER_A2A_AUTH_TOKEN;
      else process.env.COMMANDER_A2A_AUTH_TOKEN = prev;
    }
  });
});

describe('requireA2ABearerAuth', () => {
  it('uses timing-safe compare and fails closed without token', async () => {
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
});
