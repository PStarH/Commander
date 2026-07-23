/**
 * GOV-3 inbox binding — pending-approval queries must be scoped to the
 * authenticated principal; client-supplied reviewerId/approverId cannot widen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request, type Response } from 'express';
import { CheckpointManager } from '../src/governanceCheckpoint';
import { createGovernanceRouter } from '../src/governanceEndpoints.js';

type Checkpoint = {
  id: string;
  missionId: string;
  status: string;
  requiredApprovals: string[];
  currentApprovals: Array<{ reviewerId: string }>;
  context: { agentId?: string; evidence: unknown[] };
  tenantId?: string;
};

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function injectPrincipal(
  principalId: string,
  role: 'admin' | 'operator' | 'viewer' = 'admin',
  tenantId = 'tenant-a',
) {
  return (req: Request, _res: Response, next: () => void) => {
    req.user = { id: principalId, username: principalId, role, tenantId };
    req.tenantId = tenantId;
    next();
  };
}

describe('governance pending-approval inbox binding (GOV-3)', () => {
  it('rejects unauthenticated pending-approvals with 401', async () => {
    const manager = new CheckpointManager();
    const app = express();
    app.use(express.json());
    app.use('/api/governance', createGovernanceRouter(manager));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/pending-approvals`);
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  it('forged reviewerId cannot list another approver inbox', async () => {
    const manager = new CheckpointManager();
    manager.create(
      'mission-1',
      'task-1',
      'agent-1',
      'executor',
      'deploy',
      'MANUAL',
      80,
      'HIGH',
      [],
      ['approver-a'],
      undefined,
      'tenant-a',
    );

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('approver-b'));
    app.use('/api/governance', createGovernanceRouter(manager));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/pending-approvals?reviewerId=approver-a`,
      );
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('returns only the authenticated principal pending approvals', async () => {
    const manager = new CheckpointManager();
    manager.create(
      'mission-1',
      'task-1',
      'agent-1',
      'executor',
      'deploy-a',
      'MANUAL',
      80,
      'HIGH',
      [],
      ['approver-a'],
      undefined,
      'tenant-a',
    );
    manager.create(
      'mission-2',
      'task-2',
      'agent-2',
      'executor',
      'deploy-b',
      'MANUAL',
      80,
      'HIGH',
      [],
      ['approver-b'],
      undefined,
      'tenant-a',
    );

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('approver-a'));
    app.use('/api/governance', createGovernanceRouter(manager));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/pending-approvals`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { pending: Array<{ taskId: string }>; count: number };
      assert.equal(body.count, 1);
      assert.equal(body.pending[0]?.taskId, 'task-1');
    } finally {
      await close();
    }
  });

  it('GET /checkpoints?approverId= rejects forged approverId with 403', async () => {
    const manager = new CheckpointManager();
    manager.create(
      'mission-1',
      'task-1',
      'agent-1',
      'executor',
      'deploy',
      'MANUAL',
      80,
      'HIGH',
      [],
      ['approver-a'],
      undefined,
      'tenant-a',
    );

    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('approver-b'));
    app.use('/api/governance', createGovernanceRouter(manager));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/checkpoints?approverId=approver-a`,
      );
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });
});

describe('governance mutating endpoints auth (GOV-3/GOV-4)', () => {
  function makeManager(initial?: Checkpoint) {
    const checkpoints = new Map<string, Checkpoint>();
    if (initial) checkpoints.set(initial.id, initial);
    return {
      get: (id: string) => checkpoints.get(id),
      getPendingForApprover: (id: string, tenantId?: string) =>
        Array.from(checkpoints.values()).filter(
          (c) =>
            c.status === 'pending' &&
            c.requiredApprovals.includes(id) &&
            (!tenantId || c.tenantId === tenantId),
        ),
      getPendingByMission: () => [],
      getAll: () => Array.from(checkpoints.values()),
      create: (...args: unknown[]) => {
        const checkpoint: Checkpoint = {
          id: 'ckpt-new',
          missionId: args[0] as string,
          status: 'pending',
          requiredApprovals: (args[9] as string[]) ?? [],
          currentApprovals: [],
          context: { agentId: args[2] as string, evidence: [] },
          tenantId: args[11] as string | undefined,
        };
        checkpoints.set(checkpoint.id, checkpoint);
        return checkpoint;
      },
      approve: () => {
        throw new Error('approve should not be called');
      },
      reject: () => {
        throw new Error('reject should not be called');
      },
      addEvidence: (id: string, evidence: { content: string }) => {
        const cp = checkpoints.get(id);
        if (!cp) throw new Error('missing');
        cp.context.evidence = [{ content: evidence.content }];
        return cp;
      },
      checkExpirations: () => [],
      getStats: () => ({ pending: 1, approved: 0, rejected: 0, expired: 0 }),
    };
  }

  it('rejects unauthenticated evidence tampering with 401', async () => {
    const checkpoint: Checkpoint = {
      id: 'ckpt-1',
      missionId: 'm1',
      status: 'pending',
      requiredApprovals: ['alice'],
      currentApprovals: [],
      context: { agentId: 'agent-1', evidence: [] },
      tenantId: 'tenant-a',
    };
    const app = express();
    app.use(express.json());
    app.use('/api/governance', createGovernanceRouter(makeManager(checkpoint) as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-1/evidence`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'log',
            content: 'forged approval note',
            source: 'attacker',
          }),
        },
      );
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  it('forbids admin not listed in requiredApprovals from approving (403 exact binding)', async () => {
    const checkpoint: Checkpoint = {
      id: 'ckpt-2',
      missionId: 'm1',
      status: 'pending',
      requiredApprovals: ['alice'],
      currentApprovals: [],
      context: { agentId: 'agent-1', evidence: [] },
      tenantId: 'tenant-a',
    };
    const manager = {
      ...makeManager(checkpoint),
      approve: () => {
        throw new Error('approve must not run for unauthorized principal');
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      req.user = {
        id: 'bob-admin',
        username: 'bob',
        role: 'admin',
        tenantId: 'tenant-a',
      };
      req.tenantId = 'tenant-a';
      next();
    });
    app.use('/api/governance', createGovernanceRouter(manager as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-2/approve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'ceremonial admin bypass' }),
        },
      );
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('forbids a low-privilege caller from creating a checkpoint for an arbitrary mission', async () => {
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('viewer-1', 'viewer'));
    app.use('/api/governance', createGovernanceRouter(makeManager() as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          missionId: 'other-mission',
          taskId: 'task-1',
          agentId: 'viewer-1',
          taskDescription: 'forge governance state',
        }),
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('allows a tenant-bound operator to create a tenant-bound checkpoint', async () => {
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('operator-1', 'operator'));
    app.use('/api/governance', createGovernanceRouter(makeManager() as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          missionId: 'mission-a',
          taskId: 'task-1',
          agentId: 'agent-1',
          taskDescription: 'authorized checkpoint',
        }),
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { tenantId?: string };
      assert.equal(body.tenantId, 'tenant-a');
    } finally {
      await close();
    }
  });

  it('hides a cross-tenant checkpoint even from a listed approver', async () => {
    const checkpoint: Checkpoint = {
      id: 'ckpt-tenant-b',
      missionId: 'm1',
      status: 'pending',
      requiredApprovals: ['alice'],
      currentApprovals: [],
      context: { agentId: 'agent-b', evidence: [] },
      tenantId: 'tenant-b',
    };
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('alice', 'admin', 'tenant-a'));
    app.use('/api/governance', createGovernanceRouter(makeManager(checkpoint) as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-tenant-b`);
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  });

  it('requires tenant binding before approval authority is accepted', async () => {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next) => {
      req.user = { id: 'alice', username: 'alice', role: 'admin' };
      req.tenantId = 'tenant-a';
      next();
    });
    app.use('/api/governance', createGovernanceRouter(makeManager() as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-1/approve`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('forbids an agent from rejecting its own checkpoint', async () => {
    const checkpoint: Checkpoint = {
      id: 'ckpt-self-reject',
      missionId: 'm1',
      status: 'pending',
      requiredApprovals: ['agent-1'],
      currentApprovals: [],
      context: { agentId: 'agent-1', evidence: [] },
      tenantId: 'tenant-a',
    };
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('agent-1', 'admin'));
    app.use('/api/governance', createGovernanceRouter(makeManager(checkpoint) as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-self-reject/reject`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'self reject' }),
        },
      );
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('blocks unauthenticated and viewer-triggered expiration processing', async () => {
    for (const middleware of [undefined, injectPrincipal('viewer-1', 'viewer')] as const) {
      const app = express();
      app.use(express.json());
      if (middleware) app.use(middleware);
      app.use('/api/governance', createGovernanceRouter(makeManager() as never));

      const { port, close } = await listen(app);
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/governance/checkpoints/check-expirations`,
          { method: 'POST' },
        );
        assert.equal(res.status, middleware ? 403 : 401);
      } finally {
        await close();
      }
    }
  });

  it('scopes operator-triggered expiration processing to the authenticated tenant', async () => {
    let observedTenant: string | undefined;
    const manager = {
      ...makeManager(),
      checkExpirations: (tenantId?: string) => {
        observedTenant = tenantId;
        return [];
      },
    };
    const app = express();
    app.use(express.json());
    app.use(injectPrincipal('operator-1', 'operator'));
    app.use('/api/governance', createGovernanceRouter(manager as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/governance/checkpoints/check-expirations`,
        { method: 'POST' },
      );
      assert.equal(res.status, 200);
      assert.equal(observedTenant, 'tenant-a');
    } finally {
      await close();
    }
  });
});
