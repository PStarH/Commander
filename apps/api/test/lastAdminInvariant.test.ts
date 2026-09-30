/**
 * AUTH-04: the "at least one admin" invariant. The last-admin PATCH guard only
 * matched `targetUser.role === 'admin'`, so the only `super_admin` could be
 * demoted (the PATCH path has no self-demotion guard either). Role changes and
 * deletes now go through the repository under one membership lock, and the
 * guard covers both admin-level roles.
 */
process.env.JWT_SECRET = 'last-admin-invariant-test-secret-32';

import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import express from 'express';
import { TestUserRepository } from './authRepositories.js';
import { setUserRepository, _resetUserStoreForTests } from '../src/userStore';
import { createJwtMiddleware, signAccessToken } from '../src/jwtMiddleware';
import { createUserAuthRouter } from '../src/userAuthEndpoints';

interface Harness {
  port: number;
  close: () => Promise<void>;
  repo: TestUserRepository;
  tokenFor: (id: string) => Promise<string>;
}

let harness: Harness;

async function buildHarness(): Promise<Harness> {
  const repo = new TestUserRepository();
  setUserRepository(repo);
  const app = express();
  app.use(express.json());
  app.use(createJwtMiddleware(async (id) => repo.findUserById(id)));
  app.use(createUserAuthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    repo,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    tokenFor: async (id: string) => {
      const user = await repo.findUserById(id);
      assert.ok(user, `user ${id} must exist`);
      return signAccessToken({
        id: user!.id,
        username: user!.username,
        role: user!.role,
        authVersion: user!.authVersion,
      });
    },
  };
}

async function createUser(
  repo: TestUserRepository,
  username: string,
  role: 'super_admin' | 'admin' | 'viewer',
): Promise<string> {
  const created = await repo.createUser({
    username,
    email: `${username}@example.test`,
    password: 'test-password',
    role,
  });
  assert.ok(!('error' in created), `createUser(${username}) must succeed`);
  return created.user.id;
}

function patchRole(port: number, token: string, id: string, role: string) {
  return fetch(`http://127.0.0.1:${port}/api/auth/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  });
}

describe('AUTH-04: last-admin invariant', () => {
  before(() => {
    _resetUserStoreForTests();
  });

  after(async () => {
    if (harness) await harness.close();
    _resetUserStoreForTests();
  });

  test('the only super_admin cannot demote itself via PATCH', async () => {
    harness = await buildHarness();
    try {
      const id = await createUser(harness.repo, 'sole-super', 'super_admin');
      const token = await harness.tokenFor(id);

      const response = await patchRole(harness.port, token, id, 'viewer');

      // Pre-fix: 200 — the guard matched only `role === 'admin'`, so the sole
      // super_admin was demoted and the system was left with zero admins.
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: string };
      assert.match(body.error ?? '', /last admin/i);
      const after = await harness.repo.findUserById(id);
      assert.equal(after?.role, 'super_admin', 'the role must not have changed');
    } finally {
      await harness.close();
    }
  });

  test('the only admin cannot demote itself via PATCH', async () => {
    harness = await buildHarness();
    try {
      const id = await createUser(harness.repo, 'sole-admin', 'admin');
      const token = await harness.tokenFor(id);

      const response = await patchRole(harness.port, token, id, 'viewer');

      assert.equal(response.status, 400);
      assert.equal((await harness.repo.findUserById(id))?.role, 'admin');
    } finally {
      await harness.close();
    }
  });

  test('positive control: demoting one admin while another remains still works', async () => {
    harness = await buildHarness();
    try {
      const actor = await createUser(harness.repo, 'admin-a', 'admin');
      const target = await createUser(harness.repo, 'admin-b', 'admin');
      const token = await harness.tokenFor(actor);

      const response = await patchRole(harness.port, token, target, 'viewer');

      assert.equal(response.status, 200);
      assert.equal((await harness.repo.findUserById(target))?.role, 'viewer');
      assert.equal(await harness.repo.countAdmins(), 1);
    } finally {
      await harness.close();
    }
  });

  test('the repository refuses to delete the last admin-level account', async () => {
    harness = await buildHarness();
    try {
      const id = await createUser(harness.repo, 'sole-super', 'super_admin');
      const result = await harness.repo.deleteUser(id);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /last admin/i);
      assert.ok(await harness.repo.findUserById(id), 'the account must still exist');
    } finally {
      await harness.close();
    }
  });

  test('the repository reports last_admin for updateUserRole on a lone super_admin', async () => {
    harness = await buildHarness();
    try {
      const id = await createUser(harness.repo, 'sole-super', 'super_admin');
      const outcome = await harness.repo.updateUserRole(id, 'viewer');
      assert.deepEqual(outcome, { outcome: 'last_admin' });
      assert.equal((await harness.repo.findUserById(id))?.role, 'super_admin');
    } finally {
      await harness.close();
    }
  });
});
