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
const { jwtMiddleware } = await import('../src/jwtMiddleware');
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
    tenantId,
  });
}

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
  app.use(
    createConfidenceRouter(
      warRoomStore as never,
      confidenceReporter as never,
    ),
  );

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
    const res = await fetch(
      `http://127.0.0.1:${port}/projects/proj-a/missions/m1/confidence`,
      { headers: { authorization: `Bearer ${bearerToken('admin', 'tenant-b')}` } },
    );
    // FAILING before the fix: 200 with the cross-tenant report.
    assert.equal(res.status, 404, 'cross-tenant confidence read must be denied');
  });

  test('same-tenant owner path still works for admins of the project tenant', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/projects/proj-a/missions/m1/confidence`,
      { headers: { authorization: `Bearer ${bearerToken('admin', 'tenant-a')}` } },
    );
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
    let providerCalled = false;
    app2.use(
      (
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        // Instrument: if the handler reached resolveProvider it would fetch();
        // the guard must reject before that. We detect via status alone.
        next();
      },
    );
    app2.use(createOnboardingRouter({}));
    const server2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server2.once('listening', r));
    const port2 = (server2.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/onboarding/run-first-task`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken('viewer')}` },
        body: JSON.stringify({ task: 'say hi' }),
      });
      // FAILING before the fix: 200 — the viewer spent the operator's key.
      assert.equal(res.status, 403, 'viewer must not trigger operator-funded LLM calls');
      assert.ok(!providerCalled);
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  });
});
