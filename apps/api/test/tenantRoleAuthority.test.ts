import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { TestUserRepository } from './authRepositories.js';
import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/refreshTokenStore.js';

const originalJwtSecret = process.env.JWT_SECRET;
const TEST_PASSWORD = ['tenant', 'password'].join('-');
process.env.JWT_SECRET = 'tenant-role-authority-test-secret-32';
const users = new TestUserRepository();
const { createUser, setUserRepositoryForTesting, updateUserRole } = await import('../src/userStore.js');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints.js');
const { verifyToken } = await import('../src/jwtMiddleware.js');

class TestRefreshTokenRepository implements RefreshTokenRepository {
  async insert(_record: RefreshTokenRecord): Promise<void> {}
  async consume(_jti: string): Promise<boolean> {
    return false;
  }
  async revoke(_jti: string): Promise<void> {}
}

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

before(async () => {
  setUserRepositoryForTesting(users);
  const app = express();
  app.use(express.json());
  app.use(createUserAuthRouter({ refreshTokens: new TestRefreshTokenRepository() }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  setUserRepositoryForTesting(undefined);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

test('tenant role updates are observed by the next login only in that tenant', async () => {
  const created = await createUser({
    username: 'role-user',
    email: 'role-user@example.test',
    password: TEST_PASSWORD,
    tenantId: 'tenant-a',
    role: 'viewer',
  });
  assert.ok(!('error' in created));
  users.grantMembership(created.user.id, 'tenant-b', 'viewer');

  assert.ok(await updateUserRole(created.user.id, 'tenant-a', 'admin'));

  const login = async (tenantId: string) => {
    const response = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'role-user', password: TEST_PASSWORD, tenantId }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { token: string };
  };

  assert.equal(verifyToken((await login('tenant-a')).token)?.role, 'admin');
  assert.equal(verifyToken((await login('tenant-b')).token)?.role, 'viewer');
});
