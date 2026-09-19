import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import express from 'express';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore.js';
import { createUserAuthRouter } from '../src/userAuthEndpoints.js';
import { _resetUserStoreForTests, createUser, setUserRepository } from '../src/userStore.js';
import { TestUserRepository } from './authRepositories.js';

afterEach(() => {
  resetAuthFailureStoreForTesting();
  _resetUserStoreForTests();
});

test('invalid password attempts are persisted through the authentication-failure authority', async () => {
  const calls: string[] = [];
  const authority: AuthFailureStore = {
    get: async () => undefined,
    recordFailure: async (key) => {
      calls.push(key);
      return {
        count: 1,
        firstFailureAt: Date.now(),
        lastFailureAt: Date.now(),
        lockedUntil: 0,
      };
    },
    cleanup: async () => 0,
  };
  setAuthFailureStore(authority);
  setUserRepository(new TestUserRepository());
  await createUser({
    username: 'login-user',
    email: 'login-user@example.test',
    password: ['correct', 'password'].join('-'),
  });

  const app = express();
  app.use(express.json());
  app.use(createUserAuthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'login-user', password: ['wrong', 'password'].join('-') }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(calls, ['127.0.0.1']);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

// AUDIT F-B-17: the previous case only proved `recordFailure` was invoked with
// the IP key — a stub returning `lockedUntil: 0` means lockout enforcement was
// never asserted. These cases exercise the lockout and the fail-closed path.
test('a locked IP is rejected 429 with Retry-After before any credential check', async () => {
  const lockedUntil = Date.now() + 120_000;
  setAuthFailureStore({
    get: async () => ({
      count: 5,
      firstFailureAt: Date.now() - 1000,
      lastFailureAt: Date.now(),
      lockedUntil,
    }),
    recordFailure: async () => {
      throw new Error('recordFailure must not run for a locked IP');
    },
    cleanup: async () => 0,
  });
  setUserRepository(new TestUserRepository());
  await createUser({
    username: 'locked-user',
    email: 'locked-user@example.test',
    password: ['correct', 'password'].join('-'),
  });

  const app = express();
  app.use(express.json());
  app.use(createUserAuthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Correct credentials, so only the lockout can explain the rejection.
      body: JSON.stringify({
        username: 'locked-user',
        password: ['correct', 'password'].join('-'),
      }),
    });

    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    const body = (await response.json()) as { retryAfter?: number };
    assert.ok(Number(body.retryAfter) >= 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('login fails closed with 503 when the failure authority is unavailable', async () => {
  setAuthFailureStore({
    get: async () => {
      throw new Error('AUTH_DATABASE_URL_REQUIRED');
    },
    recordFailure: async () => {
      throw new Error('AUTH_DATABASE_URL_REQUIRED');
    },
    cleanup: async () => 0,
  });
  setUserRepository(new TestUserRepository());
  await createUser({
    username: 'authority-down',
    email: 'authority-down@example.test',
    password: ['correct', 'password'].join('-'),
  });

  const app = express();
  app.use(express.json());
  app.use(createUserAuthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'authority-down',
        password: ['correct', 'password'].join('-'),
      }),
    });

    assert.equal(response.status, 503, 'an unavailable authority must not admit the login');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
