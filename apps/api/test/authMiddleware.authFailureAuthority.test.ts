import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import {
  resetApiKeyStore,
  setApiKeyStore,
  type ApiKeyCreationResult,
  type ApiKeyRecord,
  type ApiKeyStore,
} from '../src/apiKeyStore.js';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore.js';

afterEach(() => {
  resetAuthFailureStoreForTesting();
  resetApiKeyStore();
});

const noApiKeys: ApiKeyStore = {
  list: async (): Promise<Omit<ApiKeyRecord, 'hash'>[]> => [],
  listByTenant: async (): Promise<Omit<ApiKeyRecord, 'hash'>[]> => [],
  findByHash: async (): Promise<ApiKeyRecord | undefined> => undefined,
  create: async (): Promise<ApiKeyCreationResult> => {
    throw new Error('test API-key store does not mint keys');
  },
  revoke: async (): Promise<ApiKeyRecord | undefined> => undefined,
  delete: async (): Promise<boolean> => false,
};

describe('auth middleware failure-authority boundary', () => {
  it('returns 500 when lockout authority cannot be read', async () => {
    const unavailableStore: AuthFailureStore = {
      get: async () => {
        throw new Error('lockout authority unavailable');
      },
      recordFailure: async () => {
        throw new Error('lockout authority unavailable');
      },
      cleanup: async () => undefined,
    };
    setAuthFailureStore(unavailableStore);
    const { authMiddleware } = await import('../src/authMiddleware.js');

    const app = express();
    app.use(authMiddleware);
    app.get('/private', (_req, res) => res.status(200).json({ ok: true }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/private`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'Internal server error' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('returns 500 when an invalid credential failure cannot be recorded', async () => {
    let recordCalls = 0;
    const unavailableStore: AuthFailureStore = {
      get: async () => undefined,
      recordFailure: async () => {
        recordCalls += 1;
        throw new Error('lockout authority write unavailable');
      },
      cleanup: async () => undefined,
    };
    setAuthFailureStore(unavailableStore);
    setApiKeyStore(noApiKeys);
    const { authMiddleware } = await import('../src/authMiddleware.js');

    const app = express();
    app.use(authMiddleware);
    app.get('/private', (_req, res) => res.status(200).json({ ok: true }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const response = await fetch(`http://127.0.0.1:${address.port}/private`, {
        headers: { 'x-api-key': 'invalid-key' },
      });
      assert.equal(response.status, 500);
      assert.equal(recordCalls, 1);
      assert.deepEqual(await response.json(), { error: 'Internal server error' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
