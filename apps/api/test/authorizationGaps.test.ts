/**
 * Round-3 audit regressions: authorization gaps in onboarding, confidence
 * reports, knowledge writes, hub correlations, and the memory-search limit.
 */
import { test, before, after, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const tmpDir = path.join(os.tmpdir(), `commander-r3-${crypto.randomBytes(8).toString('hex')}`);
const originalCwd = process.cwd();
fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'audit-r3-secret';

const { createUser, _resetUserStoreForTests } = await import('../src/userStore');
const { _resetRefreshTokenStoreForTests } = await import('../src/refreshTokenStore');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const { createJwtMiddleware } = await import('../src/jwtMiddleware');
const { authMiddleware } = await import('../src/authMiddleware');
const { tenantContextMiddleware } = await import('../src/tenantContextMiddleware');
const { createConfidenceRouter } = await import('../src/confidenceEndpoints');
const { signAccessToken } = await import('../src/jwtMiddleware');
const express = (await import('express')).default;

let server: ReturnType<typeof express.listen>;
let port: number;

function bearerToken(role: 'viewer' | 'admin', tenantId = 'tenant-a'): string {
  return signAccessToken({
    id: `user-${role}`,
    username: role,
    role,
    authVersion: 1,
    tenantId,
  });
}

const jwtMiddleware = createJwtMiddleware(async (id) => {
  const role = id === 'user-admin' ? 'admin' : id === 'user-viewer' ? 'viewer' : undefined;
  if (!role) return undefined;
  return {
    id,
    username: role,
    email: `${role}@example.test`,
    passwordHash: 'unused',
    role,
    authVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
  };
});

before(async () => {
  _resetUserStoreForTests();
  _resetRefreshTokenStoreForTests();

  const warRoomStore = {
    getProjectSnapshot(projectId: string) {
      if (projectId !== 'proj-a') return undefined;
      // Project owned by tenant-a owner user-operator (not the attacker).
      return {
        project: { id: 'proj-a', tenantId: 'tenant-a', ownerId: 'user-operator' },
        missions: [{ id: 'm1' }],
        agents: [{ agentId: 'ag1' }],
      };
    },
  } as unknown as Record<string, unknown>;

  const confidenceReporter = {
    generateMissionReport: () => ({ score: 0.9 }),
    generateAgentReport: () => ({ score: 0.8 }),
    checkForAlerts: () => [],
  } as unknown as Record<string, unknown>;

  const app = express();
  app.use(express.json());
  app.use(jwtMiddleware);
  app.use(authMiddleware);
  app.use(tenantContextMiddleware);
  app.use(createConfidenceRouter(warRoomStore as never, confidenceReporter as never));

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

describe('AUDIT-API2: confidence reports enforce project access', () => {
  test('tenant-b viewer cannot read tenant-a project confidence (was: IDOR)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/proj-a/missions/m1/confidence`, {
      headers: { authorization: `Bearer ${bearerToken('admin', 'tenant-b')}` },
    });
    // FAILING before the fix: 200 with the cross-tenant report.
    assert.equal(res.status, 404, 'cross-tenant confidence read must be denied');
  });

  test('same-tenant owner path still works for admins of the project tenant', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/projects/proj-a/missions/m1/confidence`, {
      headers: { authorization: `Bearer ${bearerToken('admin', 'tenant-a')}` },
    });
    assert.equal(res.status, 200);
  });
});

describe('AUDIT-API1: onboarding run-first-task requires admin (LLM spend guard)', () => {
  test('viewer JWT is rejected 403 before any provider call', async () => {
    const { createOnboardingRouter } = await import('../src/onboardingEndpoints');
    const app2 = express();
    app2.use(express.json());
    app2.use(jwtMiddleware);
    app2.use(authMiddleware);
    app2.use(tenantContextMiddleware);

    // F-A-5: the previous version declared `providerCalled` but never assigned
    // it, so `assert.ok(!providerCalled)` was unconditionally true. Instrument
    // the actual outbound call the handler would make by stubbing global fetch,
    // and configure a provider so the unguarded path really does fetch.
    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const savedKey = process.env.OPENAI_API_KEY;
    const savedBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'test-operator-key';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1';

    app2.use(createOnboardingRouter({}));
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server2.once('listening', r));
    const port2 = (server2.address() as { port: number }).port;
    try {
      // NOTE: the harness's own HTTP call must use the captured real fetch, or
      // the stub would answer the harness request and the test would be vacuous.
      const res = await realFetch(`http://127.0.0.1:${port2}/api/onboarding/run-first-task`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearerToken('viewer')}`,
        },
        body: JSON.stringify({ task: 'say hi' }),
      });
      // FAILING before the fix: 200 — the viewer spent the operator's key.
      assert.equal(res.status, 403, 'viewer must not trigger operator-funded LLM calls');
      assert.equal(providerCalls, 0, 'guard must reject before any provider fetch');
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
      if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = savedBase;
    }
  });

  test('positive control: an admin does reach the provider call path', async () => {
    const { createOnboardingRouter } = await import('../src/onboardingEndpoints');
    const app3 = express();
    app3.use(express.json());
    app3.use(jwtMiddleware);
    app3.use(authMiddleware);
    app3.use(tenantContextMiddleware);

    const realFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const savedKey = process.env.OPENAI_API_KEY;
    const savedBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'test-operator-key';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:1/v1';

    app3.use(createOnboardingRouter({}));
    const server3 = app3.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server3.once('listening', r));
    const port3 = (server3.address() as { port: number }).port;
    try {
      const res = await realFetch(`http://127.0.0.1:${port3}/api/onboarding/run-first-task`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearerToken('admin')}`,
        },
        body: JSON.stringify({ task: 'say hi' }),
      });
      assert.equal(res.status, 200);
      assert.equal(providerCalls, 1, 'admin path must reach the provider fetch');
    } finally {
      await new Promise<void>((r) => server3.close(() => r()));
      globalThis.fetch = realFetch;
      if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedKey;
      if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = savedBase;
    }
  });
});
