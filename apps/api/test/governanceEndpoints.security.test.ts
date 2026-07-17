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

function injectPrincipal(principalId: string, role: 'admin' | 'viewer' = 'admin') {
  return (req: Request, _res: Response, next: () => void) => {
    req.user = { id: principalId, username: principalId, role };
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
      getPendingForApprover: (id: string) =>
        Array.from(checkpoints.values()).filter(
          (c) => c.status === 'pending' && c.requiredApprovals.includes(id),
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
    };
    const app = express();
    app.use(express.json());
    app.use('/api/governance', createGovernanceRouter(makeManager(checkpoint) as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-1/evidence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'log', content: 'forged approval note', source: 'attacker' }),
      });
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
      req.user = { id: 'bob-admin', username: 'bob', role: 'admin' };
      next();
    });
    app.use('/api/governance', createGovernanceRouter(manager as never));

    const { port, close } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/governance/checkpoints/ckpt-2/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'ceremonial admin bypass' }),
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });
});
