/**
 * R1 residual: SQLite / InMemory worker-mode claimNextStep must match PG durable authz.
 * Empty caller tenantIds must NOT mean all tenants; scope comes from commander_workers.tenant_ids.
 * P1-A: worker-mode claims require unforgeable claimSecret from seed/register.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import { SqliteKernelRepository } from './sqlite.js';
import type { CreateKernelRun } from './types.js';

const runFor = (id: string, tenantId: string, stepId: string): CreateKernelRun => ({
  id,
  tenantId,
  intentHash: 'intent',
  workGraphHash: 'graph',
  workGraphVersion: 'v1',
  policySnapshotId: 'policy-v1',
  steps: [{ id: stepId, kind: 'agent' }],
});

async function withSqliteWorkerRepo(
  fn: (repo: SqliteKernelRepository) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'claim-authz-'));
  const repo = new SqliteKernelRepository({
    path: join(dir, 'kernel.sqlite'),
    schedulerMode: false,
  });
  await repo.initialize();
  try {
    await fn(repo);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('claimNextStep durable authz parity (R1)', () => {
  describe('InMemory (schedulerMode: false)', () => {
    it('empty caller tenantIds scopes to durable worker tenant_ids', async () => {
      const kernel = new InMemoryKernelRepository({ schedulerMode: false });
      await kernel.createRun(runFor('run-a', 'tenant-a', 'step-a'), 'gateway');
      await kernel.createRun(runFor('run-b', 'tenant-b', 'step-b'), 'gateway');
      const secret = kernel.seedTestWorker('worker-a', ['tenant-a'], 1);

      const claimed = await kernel.claimNextStep({
        workerId: 'worker-a',
        workerGeneration: 1,
        claimSecret: secret,
        leaseTtlMs: 30_000,
        capabilities: ['agent'],
      });
      assert.ok(claimed, 'durable tenant_ids must allow claim within scope');
      assert.equal(claimed.tenantId, 'tenant-a');
      assert.equal(claimed.id, 'step-a');

      const second = await kernel.claimNextStep({
        workerId: 'worker-a',
        workerGeneration: 1,
        claimSecret: secret,
        leaseTtlMs: 30_000,
        capabilities: ['agent'],
        // Caller widening must be ignored on worker path.
        tenantIds: ['tenant-b'],
      });
      assert.equal(second, null, 'caller tenantIds must not widen durable authz');
    });

    it('fails closed for missing / inactive / stale generation / empty durable tenants / wrong secret', async () => {
      const kernel = new InMemoryKernelRepository({ schedulerMode: false });
      await kernel.createRun(runFor('run-a', 'tenant-a', 'step-a'), 'gateway');

      assert.equal(
        await kernel.claimNextStep({
          workerId: 'missing',
          workerGeneration: 1,
          claimSecret: 'nope',
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        null,
        'missing worker must claim nothing',
      );

      const emptySecret = kernel.seedTestWorker('worker-empty', [], 1);
      assert.equal(
        await kernel.claimNextStep({
          workerId: 'worker-empty',
          workerGeneration: 1,
          claimSecret: emptySecret,
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        null,
        'empty durable tenant_ids must claim nothing',
      );

      kernel.seedTestWorker('worker-stale', ['tenant-a'], 9);
      assert.equal(
        await kernel.claimNextStep({
          workerId: 'worker-stale',
          workerGeneration: 1,
          claimSecret: 'stale-secret',
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        null,
        'stale workerGeneration must claim nothing',
      );

      const offSecret = kernel.seedTestWorker('worker-off', ['tenant-a'], 1, { status: 'OFFLINE' });
      assert.equal(
        await kernel.claimNextStep({
          workerId: 'worker-off',
          workerGeneration: 1,
          claimSecret: offSecret,
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        null,
        'inactive worker must claim nothing',
      );

      const starSecret = kernel.seedTestWorker('worker-star', ['*'], 1);
      assert.equal(
        await kernel.claimNextStep({
          workerId: 'worker-star',
          workerGeneration: 1,
          claimSecret: starSecret,
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        null,
        "durable tenant_ids=['*'] must fail closed (not expand)",
      );

      const goodSecret = kernel.seedTestWorker('worker-secret', ['tenant-a'], 1);
      assert.equal(
        await kernel.claimNextStep({
          workerId: 'worker-secret',
          workerGeneration: 1,
          claimSecret: 'wrong-secret',
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        null,
        'wrong claimSecret must claim nothing',
      );
      assert.ok(
        await kernel.claimNextStep({
          workerId: 'worker-secret',
          workerGeneration: 1,
          claimSecret: goodSecret,
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        }),
        'correct claimSecret must allow claim',
      );
    });
  });

  describe('SQLite (schedulerMode: false)', () => {
    it('empty caller tenantIds scopes to durable worker tenant_ids', async () => {
      await withSqliteWorkerRepo(async (repo) => {
        await repo.createRun(runFor('run-a', 'tenant-a', 'step-a'), 'gateway');
        await repo.createRun(runFor('run-b', 'tenant-b', 'step-b'), 'gateway');
        const secret = repo.seedTestWorker('worker-a', ['tenant-a'], 1);

        const claimed = await repo.claimNextStep({
          workerId: 'worker-a',
          workerGeneration: 1,
          claimSecret: secret,
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
        });
        assert.ok(claimed, 'durable tenant_ids must allow claim within scope');
        assert.equal(claimed.tenantId, 'tenant-a');
        assert.equal(claimed.id, 'step-a');

        const widen = await repo.claimNextStep({
          workerId: 'worker-a',
          workerGeneration: 1,
          claimSecret: secret,
          leaseTtlMs: 30_000,
          capabilities: ['agent'],
          tenantIds: ['tenant-b'],
        });
        assert.equal(widen, null, 'caller tenantIds must not widen durable authz');
      });
    });

    it('fails closed for missing / inactive / stale generation / empty durable tenants / wrong secret', async () => {
      await withSqliteWorkerRepo(async (repo) => {
        await repo.createRun(runFor('run-a', 'tenant-a', 'step-a'), 'gateway');

        assert.equal(
          await repo.claimNextStep({
            workerId: 'missing',
            workerGeneration: 1,
            claimSecret: 'nope',
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          null,
          'missing worker must claim nothing',
        );

        const emptySecret = repo.seedTestWorker('worker-empty', [], 1);
        assert.equal(
          await repo.claimNextStep({
            workerId: 'worker-empty',
            workerGeneration: 1,
            claimSecret: emptySecret,
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          null,
          'empty durable tenant_ids must claim nothing',
        );

        repo.seedTestWorker('worker-stale', ['tenant-a'], 9);
        assert.equal(
          await repo.claimNextStep({
            workerId: 'worker-stale',
            workerGeneration: 1,
            claimSecret: 'stale-secret',
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          null,
          'stale workerGeneration must claim nothing',
        );

        const offSecret = repo.seedTestWorker('worker-off', ['tenant-a'], 1, { status: 'OFFLINE' });
        assert.equal(
          await repo.claimNextStep({
            workerId: 'worker-off',
            workerGeneration: 1,
            claimSecret: offSecret,
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          null,
          'inactive worker must claim nothing',
        );

        const starSecret = repo.seedTestWorker('worker-star', ['*'], 1);
        assert.equal(
          await repo.claimNextStep({
            workerId: 'worker-star',
            workerGeneration: 1,
            claimSecret: starSecret,
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          null,
          "durable tenant_ids=['*'] must fail closed (not expand)",
        );

        const goodSecret = repo.seedTestWorker('worker-secret', ['tenant-a'], 1);
        assert.equal(
          await repo.claimNextStep({
            workerId: 'worker-secret',
            workerGeneration: 1,
            claimSecret: 'wrong-secret',
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          null,
          'wrong claimSecret must claim nothing',
        );
        assert.ok(
          await repo.claimNextStep({
            workerId: 'worker-secret',
            workerGeneration: 1,
            claimSecret: goodSecret,
            leaseTtlMs: 30_000,
            capabilities: ['agent'],
          }),
          'correct claimSecret must allow claim',
        );
      });
    });
  });
});

describe('claimReconcileEffects durable authz parity (P1-4)', () => {
  async function parkUnknownEffect(
    repo: SqliteKernelRepository | InMemoryKernelRepository,
    input: {
      workerId: string;
      workerGeneration: number;
      claimSecret: string;
      effectId: string;
      tenantId: string;
      runId: string;
      stepId: string;
    },
  ): Promise<void> {
    const claimed = await repo.claimNextStep({
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      claimSecret: input.claimSecret,
      leaseTtlMs: 30_000,
      capabilities: ['agent'],
    });
    assert.ok(claimed?.lease, 'setup claim must succeed');
    assert.equal(claimed.tenantId, input.tenantId);
    const admitted = await repo.admitEffect({
      id: input.effectId,
      runId: input.runId,
      stepId: claimed.id,
      tenantId: input.tenantId,
      type: 'ticket.create',
      idempotencyKey: `idem-${input.effectId}`,
      policyDecisionId: 'decision-1',
      policySnapshotId: 'policy-v1',
      actionDigest: 'a'.repeat(64),
      request: {},
      lease: claimed.lease,
      actor: input.workerId,
    });
    assert.equal(admitted.admitted, true);
    await repo.markEffectCompletionUnknown({
      effectId: input.effectId,
      tenantId: input.tenantId,
      reason: 'timeout',
      actor: input.workerId,
    });
    await repo.requestReconcile({
      effectId: input.effectId,
      tenantId: input.tenantId,
      actor: 'api',
      reconcileAfter: new Date(Date.now() - 1_000).toISOString(),
    });
  }

  describe('InMemory (schedulerMode: false)', () => {
    it('scopes reconcile claims to durable worker tenant_ids and fails closed', async () => {
      const kernel = new InMemoryKernelRepository({ schedulerMode: false });
      await kernel.createRun(runFor('run-a', 'tenant-a', 'step-a'), 'gateway');
      await kernel.createRun(runFor('run-b', 'tenant-b', 'step-b'), 'gateway');
      const secretA = kernel.seedTestWorker('worker-a', ['tenant-a'], 1);
      const secretB = kernel.seedTestWorker('worker-b', ['tenant-b'], 1);

      await parkUnknownEffect(kernel, {
        workerId: 'worker-a',
        workerGeneration: 1,
        claimSecret: secretA,
        effectId: 'eff-a',
        tenantId: 'tenant-a',
        runId: 'run-a',
        stepId: 'step-a',
      });
      await parkUnknownEffect(kernel, {
        workerId: 'worker-b',
        workerGeneration: 1,
        claimSecret: secretB,
        effectId: 'eff-b',
        tenantId: 'tenant-b',
        runId: 'run-b',
        stepId: 'step-b',
      });

      const claimed = await kernel.claimReconcileEffects({
        limit: 10,
        now: new Date(),
        workerId: 'worker-a',
        workerGeneration: 1,
        claimSecret: secretA,
      });
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.effect.tenantId, 'tenant-a');

      assert.equal(
        (
          await kernel.claimReconcileEffects({
            limit: 10,
            now: new Date(),
            workerId: 'worker-a',
            workerGeneration: 1,
            claimSecret: 'peer-guess',
          })
        ).length,
        0,
        'peer without secret must not claim reconcile effects',
      );

      assert.equal(
        (
          await kernel.claimReconcileEffects({
            limit: 10,
            now: new Date(),
            workerId: 'missing',
            workerGeneration: 1,
            claimSecret: 'x',
          })
        ).length,
        0,
      );

      const emptySecret = kernel.seedTestWorker('worker-empty', [], 1);
      assert.equal(
        (
          await kernel.claimReconcileEffects({
            limit: 10,
            now: new Date(),
            workerId: 'worker-empty',
            workerGeneration: 1,
            claimSecret: emptySecret,
          })
        ).length,
        0,
      );

      const starSecret = kernel.seedTestWorker('worker-star', ['*'], 1);
      assert.equal(
        (
          await kernel.claimReconcileEffects({
            limit: 10,
            now: new Date(),
            workerId: 'worker-star',
            workerGeneration: 1,
            claimSecret: starSecret,
          })
        ).length,
        0,
        "durable tenant_ids=['*'] must fail closed on reconcile claim",
      );
    });
  });

  describe('SQLite (schedulerMode: false)', () => {
    it('scopes reconcile claims to durable worker tenant_ids; missing workerId throws', async () => {
      await withSqliteWorkerRepo(async (repo) => {
        await repo.createRun(runFor('run-a', 'tenant-a', 'step-a'), 'gateway');
        await repo.createRun(runFor('run-b', 'tenant-b', 'step-b'), 'gateway');
        const secretA = repo.seedTestWorker('worker-a', ['tenant-a'], 1);
        const secretB = repo.seedTestWorker('worker-b', ['tenant-b'], 1);

        await parkUnknownEffect(repo, {
          workerId: 'worker-a',
          workerGeneration: 1,
          claimSecret: secretA,
          effectId: 'eff-a',
          tenantId: 'tenant-a',
          runId: 'run-a',
          stepId: 'step-a',
        });
        await parkUnknownEffect(repo, {
          workerId: 'worker-b',
          workerGeneration: 1,
          claimSecret: secretB,
          effectId: 'eff-b',
          tenantId: 'tenant-b',
          runId: 'run-b',
          stepId: 'step-b',
        });

        const claimed = await repo.claimReconcileEffects({
          limit: 10,
          now: new Date(),
          workerId: 'worker-a',
          workerGeneration: 1,
          claimSecret: secretA,
        });
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.effect.tenantId, 'tenant-a');

        await assert.rejects(
          () => repo.claimReconcileEffects({ limit: 10, now: new Date() }),
          /claimReconcileEffects requires workerId/,
        );

        repo.seedTestWorker('worker-stale', ['tenant-a'], 9);
        assert.equal(
          (
            await repo.claimReconcileEffects({
              limit: 10,
              now: new Date(),
              workerId: 'worker-stale',
              workerGeneration: 1,
              claimSecret: 'stale',
            })
          ).length,
          0,
          'stale generation must claim nothing',
        );
      });
    });
  });
});
