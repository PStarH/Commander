/**
 * P0.2 — mission approve admin-only; approver from req.user.
 *
 * AUDIT F-A-3: the behavioural 401/403/200 assertions previously ran against a
 * locally re-implemented `createApproveApp` + local `requireAuth`/`requireRole`
 * mirror, so the real `projectEndpoints` approve handler was never exercised.
 * The tests below mount the PRODUCTION `createProjectRouter` with a stub store
 * and drive it over real HTTP.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { createProjectRouter } from '../src/projectEndpoints';
import { canAccessProject } from '../src/projectEndpoints';
import type { UserRole } from '../src/userStore';

const PROJECT = { id: 'proj-a', tenantId: 'tenant-a', ownerId: 'owner-a' };

interface LogInput {
  missionId: string;
  message: string;
  level: string;
}

function makeStore(logs: LogInput[], updates: Array<Record<string, unknown>>) {
  const mission = {
    id: 'm-1',
    projectId: 'proj-a',
    title: 'Ship it',
    priority: 'HIGH',
    riskLevel: 'HIGH',
    governanceMode: 'MANUAL',
    status: 'RUNNING',
    assignedAgentId: 'agent-1',
    objective: 'ship',
  };
  const store = {
    listProjects: () => [PROJECT],
    getProjectSnapshot: (projectId: string) =>
      projectId === 'proj-a' ? { project: PROJECT, missions: [mission], agents: [] } : undefined,
    updateMission: (
      missionId: string,
      input: Record<string, unknown>,
      options?: { bypassGovernance?: boolean },
    ) => {
      updates.push({ missionId, ...input, ...options });
      return { ...mission, ...input };
    },
    createLog: (input: LogInput) => {
      logs.push(input);
      return input;
    },
    listAgents: () => [],
    getGovernanceStats: () => ({}),
    getPendingApprovals: () => [],
    createMission: () => mission,
    close: () => undefined,
  };
  const memoryStore = {
    list: async () => [],
    append: async () => undefined,
  };
  const agentStateStore = { get: () => undefined };
  return { store, memoryStore, agentStateStore };
}

interface Harness {
  baseUrl: string;
  logs: LogInput[];
  updates: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

async function startApprove(
  principal: { id: string; username: string; role: UserRole; tenantId?: string } | null,
): Promise<Harness> {
  const logs: LogInput[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const { store, memoryStore, agentStateStore } = makeStore(logs, updates);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = principal;
    req.tenantId = principal?.tenantId;
    next();
  });
  app.use(
    '/api',
    createProjectRouter(store as never, memoryStore as never, agentStateStore as never),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    logs,
    updates,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function approve(baseUrl: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/missions/m-1/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /missions/:missionId/approve through the real router (P0.2)', () => {
  it('returns 401 without authentication and never mutates', async () => {
    const app = await startApprove(null);
    try {
      const res = await approve(app.baseUrl, { approver: 'forged-admin' });
      assert.equal(res.status, 401);
      assert.equal(app.logs.length, 0);
      assert.equal(app.updates.length, 0);
    } finally {
      await app.close();
    }
  });

  it('returns 403 for non-admin and never mutates', async () => {
    const app = await startApprove({
      id: 'u1',
      username: 'viewer1',
      role: 'viewer',
      tenantId: 'tenant-a',
    });
    try {
      const res = await approve(app.baseUrl, { approver: 'forged-admin' });
      assert.equal(res.status, 403);
      assert.equal(app.logs.length, 0);
      assert.equal(app.updates.length, 0);
    } finally {
      await app.close();
    }
  });

  it('admin succeeds and logs req.user.username (ignores body.approver)', async () => {
    const app = await startApprove({
      id: 'a1',
      username: 'real-admin',
      role: 'admin',
      tenantId: 'tenant-a',
    });
    try {
      const res = await approve(app.baseUrl, { approver: 'forged-admin', comment: 'lgtm' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, 'DONE');
      assert.equal(app.updates.length, 1);
      assert.equal(app.updates[0]!.bypassGovernance, true);
      assert.equal(app.logs.length, 1);
      assert.match(app.logs[0]!.message, /Mission approved by real-admin: lgtm/);
      assert.doesNotMatch(app.logs[0]!.message, /forged-admin/);
    } finally {
      await app.close();
    }
  });

  it('admin of a foreign tenant gets 404 and cannot approve', async () => {
    const app = await startApprove({
      id: 'a2',
      username: 'foreign-admin',
      role: 'admin',
      tenantId: 'tenant-b',
    });
    try {
      const res = await approve(app.baseUrl, {});
      assert.equal(res.status, 404);
      assert.equal(app.updates.length, 0);
    } finally {
      await app.close();
    }
  });
});

describe('canAccessProject is the tenant/owner authorization predicate', () => {
  const req = (user: unknown, tenantId?: string) =>
    ({ user, tenantId, apiKeyId: undefined }) as unknown as Request;

  it('allows same-tenant admin, denies foreign-tenant admin', () => {
    assert.equal(
      canAccessProject(req({ id: 'a', role: 'admin', tenantId: 'tenant-a' }, 'tenant-a'), PROJECT),
      true,
    );
    assert.equal(
      canAccessProject(req({ id: 'a', role: 'admin', tenantId: 'tenant-b' }, 'tenant-b'), PROJECT),
      false,
    );
  });

  it('denies a same-tenant non-owner without an admin role', () => {
    assert.equal(
      canAccessProject(
        req({ id: 'other', role: 'viewer', tenantId: 'tenant-a' }, 'tenant-a'),
        PROJECT,
      ),
      false,
    );
  });
});
