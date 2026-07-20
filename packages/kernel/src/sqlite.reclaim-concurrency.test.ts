/**
 * S4 / E5: concurrent reclaimExpiredLeases on one SQLite file (BEGIN IMMEDIATE serializes writers).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SqliteKernelRepository } from './sqlite.js';

describe('SQLite reclaimExpiredLeases concurrency (S4)', () => {
  it('two repositories on one DB: no double reclaim, no throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmdr-reclaim-'));
    const dbPath = join(dir, 'kernel.sqlite');
    const busyMs = 5_000;
    const repoA = new SqliteKernelRepository({ path: dbPath, busyTimeoutMs: busyMs, schedulerMode: true });
    const repoB = new SqliteKernelRepository({ path: dbPath, busyTimeoutMs: busyMs, schedulerMode: true });
    await repoA.initialize();
    try {
      repoA.seedTestWorker('worker-a', ['tenant-a'], 1);
      await repoA.createRun(
        {
          id: 'run-reclaim-race',
          tenantId: 'tenant-a',
          intentHash: 'intent',
          workGraphHash: 'graph',
          workGraphVersion: 'v1',
          policySnapshotId: 'policy',
          steps: [{ id: 'step-reclaim', kind: 'agent' }],
        },
        'gateway',
      );

      const claimed = await repoA.claimNextStep({
        workerId: 'worker-a',
        workerGeneration: 1,
        tenantIds: ['tenant-a'],
        capabilities: ['agent', 'tool'],
        leaseTtlMs: 1_000,
      });
      assert.ok(claimed?.lease);
      await repoA.heartbeatStep(claimed!.id, 'tenant-a', claimed!.lease!, -10_000);
      await repoB.initialize();
      const reclaimAt = new Date();

      const outcomes = await Promise.allSettled([
        repoA.reclaimExpiredLeases(reclaimAt, 10),
        repoB.reclaimExpiredLeases(reclaimAt, 10),
      ]);
      const reclaimedBatches = outcomes.map((outcome, i) => {
        if (outcome.status === 'fulfilled') return outcome.value;
        if (outcome.reason && typeof outcome.reason === 'object' && 'code' in outcome.reason && outcome.reason.code === 'SQLITE_BUSY') {
          return [];
        }
        throw new Error(`repo ${i} reclaim failed: ${outcome.reason}`);
      });
      const [fromA, fromB] = reclaimedBatches;
      const reclaimedIds = [...fromA, ...fromB].map((s) => s.id);
      const unique = new Set(reclaimedIds);
      assert.equal(unique.size, reclaimedIds.length, 'no step reclaimed twice across connections');
      assert.equal(unique.size, 1, 'exactly one reclaim wins');
      assert.equal(reclaimedIds[0], 'step-reclaim');
      assert.ok(
        outcomes.some((o) => o.status === 'fulfilled'),
        'at least one connection must complete reclaim (peer may SQLITE_BUSY under dual-writer)',
      );

      const step = await repoA.getStep('step-reclaim', 'tenant-a');
      assert.ok(step);
      assert.notEqual(step.state, 'RUNNING', 'lease must be cleared after reclaim');
    } finally {
      repoA.close();
      repoB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
