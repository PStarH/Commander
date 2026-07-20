import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SqliteKernelRepository } from './sqlite.js';
import { createKernelRepository } from './repositoryFactory.js';

describe('SqliteKernelRepository integration', () => {
  it('applies WAL, foreign_keys, busy_timeout and file permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-sqlite-int-'));
    const path = join(dir, 'kernel.sqlite');
    const repo = new SqliteKernelRepository({ path, wal: true, busyTimeoutMs: 5000, synchronous: 'NORMAL' });
    await repo.initialize();
    try {
      // Windows NTFS does not honor Unix mode bits the same way.
      if (process.platform !== 'win32') {
        const mode = statSync(path).mode & 0o777;
        assert.equal(mode, 0o600);
        const dirMode = statSync(dir).mode & 0o777;
        assert.equal(dirMode, 0o700);
      }
    } finally {
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects :memory: without explicit test flag', () => {
    assert.throws(
      () => new SqliteKernelRepository({ path: ':memory:' }),
      /allowMemory/,
    );
  });

  it('persists pending approval and COMPLETION_UNKNOWN across reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-sqlite-persist-'));
    const path = join(dir, 'kernel.sqlite');
    const workerId = 'worker-persist';
    {
      const repo = new SqliteKernelRepository({ path, schedulerMode: true });
      await repo.initialize();
      repo.seedTestWorker(workerId, ['tenant-a'], 1);
      await repo.createRun({
        id: 'run-persist',
        tenantId: 'tenant-a',
        intentHash: 'i',
        workGraphHash: 'g',
        workGraphVersion: 'v1',
        policySnapshotId: 'p',
        steps: [
          {
            id: 'step-wait',
            kind: 'tool',
            initialState: 'WAITING_FOR_HUMAN',
            interaction: { id: 'itr-persist', prompt: 'ok?' },
          },
          { id: 'step-run', kind: 'agent' },
        ],
      }, 'test');
      const claimed = await repo.claimNextStep({
        workerId, workerGeneration: 1, tenantIds: ['tenant-a'], capabilities: ['agent', 'tool'], leaseTtlMs: 60_000,
      });
      assert.ok(claimed?.lease);
      assert.equal(claimed?.id, 'step-run');
      await repo.admitEffect({
        id: 'eff-persist', runId: 'run-persist', stepId: claimed.id, tenantId: 'tenant-a',
        type: 'http.write', idempotencyKey: 'k-persist', policyDecisionId: 'pd',
        request: {}, lease: claimed.lease, actor: workerId,
      });
      await repo.markEffectCompletionUnknown({
        effectId: 'eff-persist', tenantId: 'tenant-a', reason: 'partition', actor: 'worker',
      });
      repo.close();
    }
    {
      const repo = new SqliteKernelRepository({ path, schedulerMode: true });
      await repo.initialize();
      const interaction = await repo.getInteraction('itr-persist', 'tenant-a');
      assert.equal(interaction?.status, 'pending');
      assert.equal((await repo.getEffect('eff-persist', 'tenant-a'))?.state, 'COMPLETION_UNKNOWN');
      repo.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconcile claim allows only one handle at a time (single-writer)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kernel-sqlite-recon-'));
    const path = join(dir, 'kernel.sqlite');
    const repoA = new SqliteKernelRepository({ path, schedulerMode: true });
    const repoB = new SqliteKernelRepository({ path, schedulerMode: true });
    await repoA.initialize();
    await repoB.initialize();
    const workerId = 'worker-recon';
    repoA.seedTestWorker(workerId, ['tenant-a'], 1);
    try {
      await repoA.createRun({
        id: 'run-recon', tenantId: 'tenant-a', intentHash: 'i', workGraphHash: 'g',
        workGraphVersion: 'v1', policySnapshotId: 'p',
        steps: [{ id: 'step-recon', kind: 'agent' }],
      }, 'test');
      const step = await repoA.claimNextStep({
        workerId, workerGeneration: 1, tenantIds: ['tenant-a'], capabilities: ['agent'], leaseTtlMs: 60_000,
      });
      assert.ok(step?.lease);
      await repoA.admitEffect({
        id: 'eff-recon', runId: 'run-recon', stepId: step.id, tenantId: 'tenant-a',
        type: 'connector.github.pull-request.create', idempotencyKey: 'key-recon',
        policyDecisionId: 'pd', request: {}, lease: step.lease, actor: workerId,
      });
      await repoA.markEffectCompletionUnknown({ effectId: 'eff-recon', tenantId: 'tenant-a', reason: 'timeout', actor: 't' });
      await repoA.requestReconcile({ effectId: 'eff-recon', tenantId: 'tenant-a', actor: 'api', reconcileAfter: new Date().toISOString() });
      const claimA = await repoA.claimReconcileEffects({ limit: 1, now: new Date() });
      assert.equal(claimA.length, 1);
      const claimB = await repoB.claimReconcileEffects({ limit: 1, now: new Date() });
      assert.equal(claimB.length, 0);
    } finally {
      repoA.close();
      repoB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createKernelRepository sqlite', () => {
  it('refuses production sqlite with stable code', async () => {
    await assert.rejects(
      () => createKernelRepository({
        env: {
          NODE_ENV: 'production',
          COMMANDER_KERNEL_BACKEND: 'sqlite',
          COMMANDER_KERNEL_SQLITE_PATH: '/tmp/x.sqlite',
        },
      }),
      (e: unknown) => (e as { code?: string }).code === 'KERNEL_BACKEND_REFUSED',
    );
  });
});
