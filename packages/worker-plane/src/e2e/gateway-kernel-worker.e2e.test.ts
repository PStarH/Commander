import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import {
  PostgresKernelRepository,
  runKernelMigrations,
  type NewKernelStep,
} from '@commander/kernel';
import {
  WorkerService,
  PostgresWorkerRegistry,
  ApiKeyWorkerAuthenticator,
  type StepExecutor,
} from '@commander/worker-plane';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

/** Deterministic executor — proves worker↔kernel claim/complete without AgentRuntime/LLM. */
const deterministicExecutor: StepExecutor = {
  async execute(step) {
    return {
      status: 'completed',
      summary: `deterministic:${String((step.input as { goal?: string })?.goal ?? '')}`,
      runId: step.runId,
    };
  },
};

function agentInput(goal: string): Record<string, unknown> {
  return {
    goal,
    agentId: 'agent-default',
    definitionVersion: 'v1',
    providerSnapshot: { provider: 'mock', model: 'mock-model' },
  };
}

describe('Gateway → Kernel → Worker real execution loop', { skip: !databaseUrl }, () => {
  it('executes a default V1 agent run end-to-end in PostgreSQL', async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const tenantId = `e2e-tenant-${Date.now()}`;
    const workerId = `e2e-worker-${Date.now()}`;

    await runKernelMigrations(pool);

    const kernel = new PostgresKernelRepository(pool);
    await kernel.initialize();

    const registry = new PostgresWorkerRegistry(pool);
    await registry.initialize();

    const authenticator = new ApiKeyWorkerAuthenticator({
      validTokens: new Set(['worker-token']),
      defaultTenantIds: [tenantId],
      defaultCapabilities: ['agent'],
    });

    const worker = new WorkerService(
      {
        id: workerId,
        kind: 'agent',
        version: 'e2e',
        capabilities: ['agent'],
        maxConcurrency: 2,
      },
      {
        subject: `worker:${workerId}`,
        token: 'worker-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      authenticator,
      registry,
      kernel,
      deterministicExecutor,
      { leaseTtlMs: 5000, workerHeartbeatMs: 1000, pollIntervalMs: 50 },
    );

    await worker.start();

    const step: NewKernelStep = {
      id: `step-${tenantId}`,
      kind: 'agent',
      input: agentInput('say hello'),
      maxAttempts: 1,
    };

    const run = await kernel.createRun(
      {
        id: `run-${tenantId}`,
        tenantId,
        intentHash: 'intent-e2e',
        workGraphHash: 'hash-e2e',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-e2e',
        steps: [step],
      },
      'e2e-test',
    );

    try {
      for (let i = 0; i < 200; i++) {
        const claimed = await worker.pollOnce();
        if (!claimed) {
          const current = await kernel.getRun(run.id, tenantId);
          if (current?.state === 'SUCCEEDED' || current?.state === 'FAILED') break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      await worker.waitForIdle();

      const finalRun = await kernel.getRun(run.id, tenantId);
      const finalStep = await kernel.getStep(step.id, tenantId);
      const events = await kernel.listEvents(run.id, tenantId);
      assert.equal(
        finalRun?.state,
        'SUCCEEDED',
        `run ended in state ${finalRun?.state}; step=${JSON.stringify(finalStep?.error ?? finalStep?.state)}`,
      );

      assert.ok(
        events.some((e) => e.type === 'run.succeeded'),
        'run.succeeded event present',
      );

      const outbox = await pool.query(
        "SELECT * FROM commander_outbox WHERE tenant_id=$1 AND payload->>'runId'=$2",
        [tenantId, run.id],
      );
      assert.ok((outbox.rowCount ?? 0) > 0, 'outbox publication exists');
    } finally {
      await worker.stop();
      await pool.query('DELETE FROM commander_steps WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_workers WHERE id=$1', [workerId]);
      await pool.end();
    }
  });

  it('reclaims an expired lease so a second worker completes without dual success', async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const tenantId = `e2e-reclaim-${Date.now()}`;
    const workerA = `e2e-wA-${Date.now()}`;
    const workerB = `e2e-wB-${Date.now()}`;

    await runKernelMigrations(pool);
    // Recovery/reclaim is a scheduler-plane write (cross-tenant). Worker claims use
    // the same repo with an explicit tenantIds scope on claimNextStep.
    const kernel = new PostgresKernelRepository(pool, { schedulerMode: true });
    await kernel.initialize();

    await pool.query(
      `INSERT INTO commander_workers (id,kind,version,capabilities,max_concurrency,status,generation,identity_subject,tenant_ids)
       VALUES ($1,'agent','e2e','["agent"]',2,'ACTIVE',1,$2,$3::jsonb),
              ($4,'agent','e2e','["agent"]',2,'ACTIVE',1,$5,$6::jsonb)`,
      [workerA, workerA, JSON.stringify([tenantId]), workerB, workerB, JSON.stringify([tenantId])],
    );

    const runId = `run-${tenantId}`;
    const stepId = `step-${tenantId}`;
    await kernel.createRun(
      {
        id: runId,
        tenantId,
        intentHash: 'intent-reclaim',
        workGraphHash: 'hash-reclaim',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy-e2e',
        steps: [
          {
            id: stepId,
            kind: 'agent',
            input: agentInput('reclaim path'),
            maxAttempts: 3,
          },
        ],
      },
      'e2e-reclaim',
    );

    try {
      const claimed = await kernel.claimNextStep({
        workerId: workerA,
        workerGeneration: 1,
        tenantIds: [tenantId],
        capabilities: ['agent'],
        leaseTtlMs: 80,
      });
      assert.ok(claimed, 'worker A claims first');
      const staleLease = claimed!.lease!;
      const staleVersion = claimed!.version;

      await new Promise((r) => setTimeout(r, 120));
      const reclaimed = await kernel.reclaimExpiredLeases(new Date(), 10);
      assert.ok(
        reclaimed.some((s) => s.id === stepId),
        'expired lease reclaimed',
      );

      const second = await kernel.claimNextStep({
        workerId: workerB,
        workerGeneration: 1,
        tenantIds: [tenantId],
        capabilities: ['agent'],
        leaseTtlMs: 30_000,
      });
      assert.ok(second, 'worker B claims after reclaim');
      assert.notEqual(second!.lease!.token, staleLease.token, 'new lease token');
      assert.notEqual(
        second!.lease!.fencingEpoch,
        staleLease.fencingEpoch,
        'fencing epoch advanced',
      );

      const zombie = await kernel.completeStep({
        stepId,
        tenantId,
        lease: staleLease,
        expectedVersion: staleVersion,
        output: { status: 'zombie' },
        actor: workerA,
      });
      assert.equal(zombie, null, 'zombie worker A cannot complete after reclaim');

      const done = await kernel.completeStep({
        stepId,
        tenantId,
        lease: second!.lease!,
        expectedVersion: second!.version,
        output: { status: 'ok' },
        actor: workerB,
      });
      assert.ok(done);
      assert.equal(done!.state, 'SUCCEEDED');

      const finalRun = await kernel.getRun(runId, tenantId);
      assert.equal(finalRun?.state, 'SUCCEEDED');
    } finally {
      await pool.query('DELETE FROM commander_steps WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_runs WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_events WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_outbox WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM commander_workers WHERE id = ANY($1::text[])', [
        [workerA, workerB],
      ]);
      await pool.end();
    }
  });
});
