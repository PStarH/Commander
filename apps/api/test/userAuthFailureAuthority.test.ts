import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import express from 'express';
import {
  resetAuthFailureStoreForTesting,
  setAuthFailureStore,
  type AuthFailureStore,
} from '../src/authFailureStore.js';
import { createUserAuthRouter } from '../src/userAuthEndpoints.js';
import {
  _resetUserStoreForTests,
  createUser,
  setUserRepository,
} from '../src/userStore.js';
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
    cleanup: async () => {},
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
