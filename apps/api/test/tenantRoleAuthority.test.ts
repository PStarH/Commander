import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { TestUserRepository } from './authRepositories.js';
import type { RefreshTokenRecord, RefreshTokenRepository } from '../src/refreshTokenStore.js';

const originalJwtSecret = process.env.JWT_SECRET;
const TEST_PASSWORD = ['tenant', 'password'].join('-');
process.env.JWT_SECRET = 'tenant-role-authority-test-secret-32';
const users = new TestUserRepository();
const { createUser, setUserRepositoryForTesting, updateUserRole } =
  await import('../src/userStore.js');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints.js');
const { jwtMiddleware, verifyToken } = await import('../src/jwtMiddleware.js');

class TestRefreshTokenRepository implements RefreshTokenRepository {
  async insert(_record: RefreshTokenRecord): Promise<void> {}
  async consume(_jti: string): Promise<boolean> {
    return false;
  }
  async revoke(_jti: string): Promise<void> {}
  async revokeAllForUser(_userId: string): Promise<void> {}
  async withUserSessionLock<T>(_userId: string, operation: (session: this) => Promise<T>): Promise<T> {
    return operation(this);
  }
}

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

before(async () => {
  setUserRepositoryForTesting(users);
  const app = express();
  app.use(express.json());
  app.use(jwtMiddleware);
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

test('tenant user listings do not disclose other tenants and use membership roles', async () => {
  const admin = await createUser({
    username: 'listing-admin',
    email: 'listing-admin@example.test',
    password: TEST_PASSWORD,
    tenantId: 'tenant-a',
    role: 'viewer',
  });
  const localUser = await createUser({
    username: 'tenant-a-user',
    email: 'tenant-a-user@example.test',
    password: TEST_PASSWORD,
    tenantId: 'tenant-a',
    role: 'viewer',
  });
  const foreignUser = await createUser({
    username: 'tenant-b-user',
    email: 'tenant-b-user@example.test',
    password: TEST_PASSWORD,
    tenantId: 'tenant-b',
    role: 'viewer',
  });
  assert.ok(!('error' in admin));
  assert.ok(!('error' in localUser));
  assert.ok(!('error' in foreignUser));
  users.grantMembership(admin.user.id, 'tenant-a', 'admin');

  const login = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'listing-admin',
      password: TEST_PASSWORD,
      tenantId: 'tenant-a',
    }),
  });
  assert.equal(login.status, 200);
  const token = ((await login.json()) as { token: string }).token;

  const response = await fetch(baseUrl + '/api/auth/users', {
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    users: Array<{ id: string; role: string }>;
  };

  assert.equal(body.users.find((user) => user.id === admin.user.id)?.role, 'admin');
  assert.ok(body.users.some((user) => user.id === localUser.user.id));
  assert.equal(
    body.users.some((user) => user.id === foreignUser.user.id),
    false,
  );
});

test('deleting a tenant user preserves that user in other tenants', async () => {
  const admin = await createUser({
    username: 'delete-tenant-admin',
    email: 'delete-tenant-admin@example.test',
    password: TEST_PASSWORD,
    tenantId: 'tenant-a',
    role: 'admin',
  });
  const target = await createUser({
    username: 'delete-tenant-target',
    email: 'delete-tenant-target@example.test',
    password: TEST_PASSWORD,
    tenantId: 'tenant-a',
    role: 'viewer',
  });
  assert.ok(!('error' in admin));
  assert.ok(!('error' in target));
  users.grantMembership(target.user.id, 'tenant-b', 'viewer');

  const adminLogin = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'delete-tenant-admin',
      password: TEST_PASSWORD,
      tenantId: 'tenant-a',
    }),
  });
  assert.equal(adminLogin.status, 200);
  const token = ((await adminLogin.json()) as { token: string }).token;

  const deletion = await fetch(baseUrl + '/api/auth/users/' + target.user.id, {
    method: 'DELETE',
    headers: { authorization: 'Bearer ' + token },
  });
  assert.equal(deletion.status, 200);

  const login = async (tenantId: string) =>
    fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'delete-tenant-target',
        password: TEST_PASSWORD,
        tenantId,
      }),
    });

  assert.equal((await login('tenant-a')).status, 401);
  assert.equal((await login('tenant-b')).status, 200);
});
