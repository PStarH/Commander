/**
 * LM-20 / AUDIT api-remaining#L7 — the three conflict-detection entry points
 * (proactive, reactive, summary) must reuse the project authorization predicate
 * instead of trusting "the snapshot exists".
 *
 * Before the fix each handler called `store.getProjectSnapshot(projectId)`,
 * checked only for `undefined`, and then walked `snapshot.agents` /
 * `snapshot.missions` — leaking agent ids, agent status, mission counts,
 * priorities and governance modes across tenants and across owners.
 */
import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const tmpDir = path.join(os.tmpdir(), `commander-lm20-${crypto.randomBytes(8).toString('hex')}`);
const originalCwd = process.cwd();
fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'lm20-secret';

const { _resetUserStoreForTests } = await import('../src/userStore');
const { _resetRefreshTokenStoreForTests } = await import('../src/refreshTokenStore');
const { createJwtMiddleware, signAccessToken } = await import('../src/jwtMiddleware');
const { authMiddleware } = await import('../src/authMiddleware');
const { tenantContextMiddleware } = await import('../src/tenantContextMiddleware');
const { createConflictRouter } = await import('../src/conflictEndpoints');
const express = (await import('express')).default;

type Role = 'super_admin' | 'admin' | 'viewer';

const USERS: Record<string, { role: Role; tenantId: string }> = {
  'user-admin-a': { role: 'admin', tenantId: 'tenant-a' },
  'user-admin-b': { role: 'admin', tenantId: 'tenant-b' },
  'user-owner': { role: 'viewer', tenantId: 'tenant-a' },
  'user-other': { role: 'viewer', tenantId: 'tenant-a' },
  'user-super': { role: 'super_admin', tenantId: 'tenant-b' },
};

function bearerToken(userId: string): string {
  const u = USERS[userId];
  return signAccessToken({
    id: userId,
    username: userId,
    role: u.role,
    authVersion: 1,
    tenantId: u.tenantId,
  });
}

const jwtMiddleware = createJwtMiddleware(async (id) => {
  const u = USERS[id];
  if (!u) return undefined;
  return {
    id,
    username: id,
    email: `${id}@example.test`,
    passwordHash: 'unused',
    role: u.role,
    authVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  };
});

// Project owned by tenant-a / user-owner. tenant-b and same-tenant non-owners
// must not be able to read any of its conflict surface.
const SNAPSHOT = {
  project: { id: 'proj-a', tenantId: 'tenant-a', ownerId: 'user-owner' },
  agents: [
    { agentId: 'ag-secret-1', agentName: 'secret-agent', status: 'ACTIVE', specialty: 'finance' },
  ],
  missions: [
    {
      id: 'mission-secret-1',
      assignedAgentId: 'ag-secret-1',
      priority: 'CRITICAL',
      status: 'RUNNING',
      governanceMode: 'MANUAL',
    },
  ],
};

let server: ReturnType<typeof express.listen>;
let port: number;

before(async () => {
  _resetUserStoreForTests();
  _resetRefreshTokenStoreForTests();

  const store = {
    getProjectSnapshot(projectId: string) {
      return projectId === 'proj-a' ? SNAPSHOT : undefined;
    },
  } as unknown as Parameters<typeof createConflictRouter>[0];

  const app = express();
  app.use(express.json());
  app.use(jwtMiddleware);
  app.use(authMiddleware);
  app.use(tenantContextMiddleware);
  app.use(createConflictRouter(store));

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  process.chdir(originalCwd);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const ROUTES: Array<{ name: string; method: 'GET' | 'POST'; url: string; body?: unknown }> = [
  {
    name: 'proactive',
    method: 'POST',
    url: '/projects/proj-a/conflict-detection/proactive',
    body: { agentId: 'ag-secret-1', proposedAction: { type: 'READ', target: 'x' } },
  },
  {
    name: 'reactive',
    method: 'POST',
    url: '/projects/proj-a/conflict-detection/reactive',
    body: { recentActions: [{ agentId: 'ag-secret-1', type: 'READ', target: 'x' }] },
  },
  { name: 'summary', method: 'GET', url: '/projects/proj-a/conflict-detection/summary' },
];

async function call(route: (typeof ROUTES)[number], token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${route.url}`, {
    method: route.method,
    headers,
    body: route.method === 'POST' ? JSON.stringify(route.body ?? {}) : undefined,
  });
}

/** Denial must not leak anything about the project's agents or missions. */
function assertNoLeak(text: string) {
  for (const needle of [
    'ag-secret-1',
    'secret-agent',
    'mission-secret-1',
    'CRITICAL',
    'MANUAL',
    'RUNNING',
    'agentWorkloads',
    'potentialConflicts',
    'conflicts',
  ]) {
    assert.ok(!text.includes(needle), `denied response leaked "${needle}": ${text}`);
  }
}

describe('LM-20: conflict entry points reuse project authorization', () => {
  for (const route of ROUTES) {
    test(`${route.name}: cross-tenant admin is denied 404 with no leak`, async () => {
      const res = await call(route, bearerToken('user-admin-b'));
      const text = await res.text();
      assert.equal(res.status, 404, `${route.name} must deny cross-tenant access`);
      assertNoLeak(text);
    });

    test(`${route.name}: same-tenant non-owner is denied 404 with no leak`, async () => {
      const res = await call(route, bearerToken('user-other'));
      const text = await res.text();
      assert.equal(res.status, 404, `${route.name} must deny same-tenant non-owner`);
      assertNoLeak(text);
    });

    test(`${route.name}: anonymous is denied and never reaches the handler`, async () => {
      const res = await call(route);
      const text = await res.text();
      // Upstream auth fails closed for anonymous (401, or 500 when the auth DB
      // is not configured in this test process). Either way: no data, no 2xx.
      assert.ok(res.status >= 400, `anonymous must be denied, got ${res.status}`);
      assertNoLeak(text);
    });

    test(`${route.name}: unknown project id is 404`, async () => {
      const res = await call(
        { ...route, url: route.url.replace('proj-a', 'proj-missing') },
        bearerToken('user-admin-a'),
      );
      assert.equal(res.status, 404);
    });

    test(`${route.name}: same-tenant admin is allowed`, async () => {
      const res = await call(route, bearerToken('user-admin-a'));
      assert.equal(res.status, 200);
    });

    test(`${route.name}: same-tenant owner is allowed`, async () => {
      const res = await call(route, bearerToken('user-owner'));
      assert.equal(res.status, 200);
    });

    test(`${route.name}: super_admin keeps existing bypass semantics`, async () => {
      const res = await call(route, bearerToken('user-super'));
      assert.equal(res.status, 200);
    });
  }

  test('body/query cannot spoof the principal tenant', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/projects/proj-a/conflict-detection/summary?tenantId=tenant-a`,
      {
        headers: {
          authorization: `Bearer ${bearerToken('user-admin-b')}`,
          'x-tenant-id': 'tenant-a',
          'content-type': 'application/json',
        },
      },
    );
    const text = await res.text();
    assert.ok(
      res.status >= 400,
      `spoofed tenant header/query must not grant access, got ${res.status}`,
    );
    assertNoLeak(text);
  });
});
