import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _resetUserStoreForTests,
  bootstrapDefaultAdminAccount,
  isInitialized,
  setUserRepository,
} from '../src/userStore.js';
import { TestUserRepository } from './authRepositories.js';

afterEach(() => {
  _resetUserStoreForTests();
});

test('user store initialization reports whether a repository is configured', () => {
  assert.equal(isInitialized(), false);

  setUserRepository(new TestUserRepository());

  assert.equal(isInitialized(), true);
});

test('initial admin bootstrap rejects an absent password instead of using a public default', async () => {
  setUserRepository(new TestUserRepository());

  await assert.rejects(
    () => bootstrapDefaultAdminAccount({}),
    /ADMIN_PASSWORD must be set before the API starts/,
  );
});
