import { setApiKeyStore } from '../../dist/apiKeyStore.js';
import { setAuthFailureStore } from '../../dist/authFailureStore.js';
import { setRateLimitStoreForTesting } from '../../dist/securityMiddleware.js';
import { setUserRepository } from '../../dist/userStore.js';

const configuredUser = process.env.COMMANDER_TEST_AUTH_USER
  ? JSON.parse(process.env.COMMANDER_TEST_AUTH_USER)
  : undefined;
const users = configuredUser ? [configuredUser] : [];

setRateLimitStoreForTesting({
  async consume(buckets) {
    const resetAt = Date.now() + 60_000;
    return buckets.map(() => ({ count: 1, resetAt }));
  },
  async cleanup() {
    return 0;
  },
});

setAuthFailureStore({
  async get() {
    return undefined;
  },
  async recordFailure(_failureKey, now) {
    return { count: 1, firstFailureAt: now, lastFailureAt: now, lockedUntil: 0 };
  },
  async cleanup() {},
});

setApiKeyStore({
  async create() {
    throw new Error('Test API-key fixture does not support mutation');
  },
  async findByHash() {
    return undefined;
  },
  async list() {
    return [];
  },
  async listByTenant() {
    return [];
  },
  async delete() {
    return false;
  },
});

setUserRepository({
  async findUserById(id) {
    return users.find((user) => user.id === id);
  },
  async findUserByUsername(username) {
    return users.find((user) => user.username.toLowerCase() === username.toLowerCase());
  },
  async findUserByEmail(email) {
    return users.find((user) => user.email.toLowerCase() === email.toLowerCase());
  },
  async findUserByOidcIdentity() {
    return undefined;
  },
  async listUsers() {
    return [];
  },
  async createUser() {
    return { error: 'Test user fixture does not support mutation' };
  },
  async bindUserToOidcIdentity() {
    return { error: 'Test user fixture does not support mutation' };
  },
  async updateLastLogin() {},
  async updateUserRole() {
    return null;
  },
  async updateUser() {
    return { error: 'Test user fixture does not support mutation' };
  },
  async resetUserPassword() {
    return null;
  },
  async deleteUser() {
    return { success: false };
  },
  async countAdmins() {
    return 1;
  },
  async bootstrapDefaultAdmin() {},
});
