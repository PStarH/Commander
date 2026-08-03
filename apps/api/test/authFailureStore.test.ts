import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuthFailureStore } from '../src/authFailureStore.js';

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('AuthFailureStore authority selection', () => {
  it('fails production startup when AUTH_FAILURE_REDIS_URL is absent', async () => {
    await withEnvironment(
      {
        NODE_ENV: 'production',
        AUTH_FAILURE_REDIS_URL: undefined,
        AUTH_FAILURE_STORE_PATH: undefined,
      },
      () => {
        assert.throws(
          () => createAuthFailureStore(),
          /AUTH_FAILURE_REDIS_URL is required in production/,
        );
      },
    );
  });

  for (const commanderEnv of ['production', 'prod']) {
    it(`fails startup for COMMANDER_ENV=${commanderEnv} without Redis`, () => {
      assert.throws(
        () =>
          createAuthFailureStore({
            environment: {
              NODE_ENV: 'development',
              COMMANDER_ENV: commanderEnv,
            },
          }),
        /AUTH_FAILURE_REDIS_URL is required in production/,
      );
    });
  }

  it('uses explicit in-memory state outside production when Redis is not configured', async () => {
    const store = createAuthFailureStore({
      environment: { NODE_ENV: 'test' },
    });
    const entry = {
      count: 2,
      firstFailureAt: 100,
      lastFailureAt: 200,
      lockedUntil: 300,
    };

    await store.set('127.0.0.1', entry);
    assert.deepEqual(await store.get('127.0.0.1'), entry);
  });

  it('does not fall back when the Redis module loader fails', async () => {
    const store = createAuthFailureStore({
      environment: {
        NODE_ENV: 'production',
        AUTH_FAILURE_REDIS_URL: 'redis://authority.invalid:6379',
      },
      loadRedis: async () => {
        throw new Error('redis loader unavailable');
      },
    });

    await assert.rejects(() => store.get('127.0.0.1'), /redis loader unavailable/);
  });

  it('does not fall back when Redis connection fails', async () => {
    const store = createAuthFailureStore({
      environment: {
        NODE_ENV: 'production',
        AUTH_FAILURE_REDIS_URL: 'redis://authority.invalid:6379',
      },
      loadRedis: async () => ({
        createClient: () => ({
          connect: async () => {
            throw new Error('redis connection unavailable');
          },
          get: async () => null,
          set: async () => 'OK',
          del: async () => 0,
        }),
      }),
    });

    await assert.rejects(() => store.get('127.0.0.1'), /redis connection unavailable/);
  });

  it('configures Redis to fail requests promptly while unavailable', async () => {
    let receivedOptions: unknown;
    const store = createAuthFailureStore({
      environment: {
        NODE_ENV: 'production',
        AUTH_FAILURE_REDIS_URL: 'redis://authority.invalid:6379',
      },
      loadRedis: async () => ({
        createClient: (options) => {
          receivedOptions = options;
          return {
            connect: async () => undefined,
            get: async () => null,
            set: async () => 'OK',
            del: async () => 0,
          };
        },
      }),
    });

    assert.equal(await store.get('127.0.0.1'), undefined);
    assert.deepEqual(receivedOptions, {
      url: 'redis://authority.invalid:6379',
      disableOfflineQueue: true,
      socket: { connectTimeout: 5_000, reconnectStrategy: false },
    });
  });

  it('propagates Redis command failures', async () => {
    const store = createAuthFailureStore({
      environment: {
        NODE_ENV: 'production',
        AUTH_FAILURE_REDIS_URL: 'redis://authority.invalid:6379',
      },
      loadRedis: async () => ({
        createClient: () => ({
          connect: async () => undefined,
          get: async () => {
            throw new Error('redis command failed');
          },
          set: async () => 'OK',
          del: async () => 0,
        }),
      }),
    });

    await assert.rejects(() => store.get('127.0.0.1'), /redis command failed/);
  });

  it('rejects malformed Redis authority entries', async () => {
    const store = createAuthFailureStore({
      environment: {
        NODE_ENV: 'production',
        AUTH_FAILURE_REDIS_URL: 'redis://authority.invalid:6379',
      },
      loadRedis: async () => ({
        createClient: () => ({
          connect: async () => undefined,
          get: async () => '{"count":"invalid"}',
          set: async () => 'OK',
          del: async () => 0,
        }),
      }),
    });

    await assert.rejects(() => store.get('127.0.0.1'), /Redis auth failure entry is malformed/);
  });
});
