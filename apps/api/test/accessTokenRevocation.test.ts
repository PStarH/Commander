import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { TestUserRepository } from './authRepositories.js';

const originalJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'access-token-revocation-test-secret-32';

const users = new TestUserRepository();
const {
  createUser,
  deleteUser,
  findUserById,
  resetUserPassword,
  setUserRepository,
  updateUserRole,
  _resetUserStoreForTests,
} = await import('../src/userStore.js');
const { jwtMiddleware, signAccessToken } = await import('../src/jwtMiddleware.js');

let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

before(async () => {
  setUserRepository(users);
  const app = express();
  app.use(jwtMiddleware);
  app.get('/protected', (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({ role: req.user.role });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  _resetUserStoreForTests();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

async function issueToken(username: string, role: 'admin' | 'viewer' = 'viewer') {
  const created = await createUser({
    username,
    email: `${username}@example.test`,
    password: 'test-password',
    role,
  });
  assert.ok(!('error' in created));
  const user = await findUserById(created.user.id);
  assert.ok(user);
  const token = signAccessToken(user);
  assert.equal(
    (await fetch(`${baseUrl}/protected`, { headers: { authorization: `Bearer ${token}` } })).status,
    200,
  );
  return { token, user };
}

async function protectedStatus(token: string): Promise<number> {
  return (
    await fetch(`${baseUrl}/protected`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status;
}

test('password reset immediately invalidates existing access tokens', async () => {
  const { token, user } = await issueToken('password-reset-user');
  assert.ok(await resetUserPassword(user.id, 'new-test-password'));
  assert.equal(await protectedStatus(token), 401);
});

test('role downgrade immediately invalidates existing privileged access tokens', async () => {
  const { token, user } = await issueToken('role-downgrade-user', 'admin');
  assert.ok(await updateUserRole(user.id, 'viewer'));
  assert.equal(await protectedStatus(token), 401);
});

test('user deletion immediately invalidates existing access tokens', async () => {
  const { token, user } = await issueToken('deleted-user');
  assert.deepEqual(await deleteUser(user.id), { success: true });
  assert.equal(await protectedStatus(token), 401);
});
