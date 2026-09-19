import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Application } from 'express';
import type { AddressInfo } from 'node:net';
import { createA2AV2Router } from '../src/a2aV2Endpoints';
import { resolveA2AAuthToken } from '../src/a2aAuth';

const AUTH_TOKEN = 'test-a2a-auth-token-16';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startV2(authToken: string | null | undefined): Promise<TestServer> {
  const app: Application = express();
  app.use(express.json());
  const opts = authToken === undefined ? undefined : { authToken: authToken as string | null };
  app.use('/a2a/v2', createA2AV2Router(opts));
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

describe('resolveA2AAuthToken', () => {
  it('requires ≥16 chars from COMMANDER_A2A_AUTH_TOKEN or A2A_AUTH_TOKEN', () => {
    assert.equal(resolveA2AAuthToken({ COMMANDER_A2A_AUTH_TOKEN: 'short' }), undefined);
    assert.equal(resolveA2AAuthToken({ A2A_AUTH_TOKEN: AUTH_TOKEN }), AUTH_TOKEN);
    assert.equal(
      resolveA2AAuthToken({
        COMMANDER_A2A_AUTH_TOKEN: AUTH_TOKEN,
        A2A_AUTH_TOKEN: 'other-token-16xx',
      }),
      AUTH_TOKEN,
    );
  });
});

describe('A2A v2 bearer auth (hard rule)', () => {
  it('returns 500 JSON-RPC when authToken is not configured', async () => {
    const server = await startV2(null);
    try {
      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }),
      });
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: { code: number; message: string } };
      assert.equal(body.error.code, -32005);
      assert.match(body.error.message, /authToken is not configured/i);
    } finally {
      await server.close();
    }
  });

  it('returns 401 without Authorization when token is configured', async () => {
    const server = await startV2(AUTH_TOKEN);
    try {
      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} }),
      });
      assert.equal(res.status, 401);
    } finally {
      await server.close();
    }
  });

  it('accepts valid Bearer token and still allows public agent-card', async () => {
    const server = await startV2(AUTH_TOKEN);
    try {
      const card = await fetch(`${server.baseUrl}/a2a/v2/.well-known/agent-card.json`);
      assert.equal(card.status, 200);

      const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } },
        }),
      });
      // F-A-8: pin the JSON-RPC envelope instead of "not 401 and not 500",
      // which also accepted 403/404/400/502.
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        jsonrpc: string;
        id: number;
        result?: { task?: { id?: string } };
        error?: { code: number };
      };
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.id, 1);
      assert.equal(body.error, undefined);
      assert.ok(body.result?.task?.id, 'expected a created task in the JSON-RPC result');
    } finally {
      await server.close();
    }
  });
});

describe('A2A v2 task lifecycle', () => {
  it('keeps a CANCELED task CANCELED after the scheduled completion fires', async () => {
    const server = await startV2(AUTH_TOKEN);
    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AUTH_TOKEN}`,
      };
      const rpc = async (
        id: number,
        method: string,
        params: Record<string, unknown>,
      ): Promise<{
        result?: { task?: { id: string; status: { state: string } } };
        error?: { code: number };
      }> => {
        const res = await fetch(`${server.baseUrl}/a2a/v2/`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
        return (await res.json()) as {
          result?: { task?: { id: string; status: { state: string } } };
          error?: { code: number };
        };
      };

      // Warm the connection so the cancel below reliably lands inside the 50 ms
      // window in which `message/send` schedules its COMPLETED transition.
      await rpc(0, 'tasks/list', {});

      const sent = await rpc(1, 'message/send', {
        message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      });
      const taskId = sent.result?.task?.id;
      assert.ok(taskId, 'expected message/send to create a task');

      const canceled = await rpc(2, 'tasks/cancel', { id: taskId });
      assert.equal(canceled.error, undefined);
      assert.equal(canceled.result?.task?.status.state, 'CANCELED');

      // The endpoint schedules COMPLETED ~50 ms after message/send; wait past it.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const fetched = await rpc(3, 'tasks/get', { id: taskId });
      assert.equal(fetched.error, undefined);
      assert.equal(fetched.result?.task?.status.state, 'CANCELED');
    } finally {
      await server.close();
    }
  });
});
