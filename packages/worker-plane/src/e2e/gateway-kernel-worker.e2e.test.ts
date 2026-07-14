import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import { PostgresKernelRepository, runKernelMigrations, type NewKernelStep } from '@commander/kernel';
import {
  WorkerService,
  PostgresWorkerRegistry,
  ApiKeyWorkerAuthenticator,
  createAgentStepExecutor,
} from '@commander/worker-plane';

const databaseUrl = process.env.COMMANDER_KERNEL_DATABASE_URL ?? process.env.DATABASE_URL;

class MockProvider {
  readonly name = 'mock';
  async call(_request: unknown): Promise<Record<string, unknown>> {
    return {
      id: 'mock-1',
      model: 'mock-model',
      content: 'completed by mock provider',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
}

describe('Gateway → Kernel → Worker real execution loop', { skip: !databaseUrl }, () => {
  it('executes a default V1 agent run end-to-end in PostgreSQL', async () => {
    if (!databaseUrl) return;
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const tenantId = `e2e-tenant-${Date.now()}`;
    const workerId = `e2e-worker-${Date.now()}`;

    // Ensure schema exists before the test starts.
    await runKernelMigrations(pool);

    const kernel = new PostgresKernelRepository(pool);
    await kernel.initialize();

    const executor = createAgentStepExecutor({
      providers: { mock: new MockProvider() },
      config: { defaultProvider: 'mock' },
    });

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
      executor,
      { leaseTtlMs: 5000, workerHeartbeatMs: 1000, pollIntervalMs: 50 },
    );

    await worker.start();

    const step: NewKernelStep = {
      id: `step-${tenantId}`,
      kind: 'agent',
      input: {
        goal: 'say hello',
        agentId: 'agent-default',
        definitionVersion: 'v1',
        providerSnapshot: { provider: 'mock', model: 'mock-model' },
      } as Record<string, unknown>,
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
      const events = await kernel.listEvents(run.id, tenantId);
      assert.equal(finalRun?.state, 'SUCCEEDED', `run ended in state ${finalRun?.state}`);

      assert.ok(events.some((e) => e.type === 'run.succeeded'), 'run.succeeded event present');

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
});
