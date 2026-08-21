import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore.js';

afterEach(() => resetAuthFailureStoreForTesting());

async function requestWith(store: AuthFailureStore, headers: Record<string, string> = {}) {
  setAuthFailureStore(store);
  const { authMiddleware } = await import('../src/authMiddleware.js');
  const app = express();
  app.use(authMiddleware);
  app.get('/private', (_req, res) => res.status(200).json({ ok: true }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return await fetch('http://127.0.0.1:' + address.port + '/private', { headers });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('auth middleware failure-authority boundary', () => {
  it('fails closed with a sanitized 503 when lockout authority cannot be read', async () => {
    const response = await requestWith({
      get: async () => { throw new Error('postgres authority unavailable: secret-dsn'); },
      recordFailure: async () => { throw new Error('unreachable'); },
      cleanup: async () => undefined,
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Authentication service unavailable' });
  });

  it('fails closed with a sanitized 503 when an invalid credential cannot be recorded', async () => {
    let recordCalls = 0;
    const response = await requestWith(
      {
        get: async () => undefined,
        recordFailure: async () => { recordCalls += 1; throw new Error('postgres authority unavailable: secret-dsn'); },
        cleanup: async () => undefined,
      },
      { 'x-api-key': 'invalid-key' },
    );
    assert.equal(response.status, 503);
    assert.equal(recordCalls, 1);
    assert.deepEqual(await response.json(), { error: 'Authentication service unavailable' });
  });
});
