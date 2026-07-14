/**
 * Minimal workload generator for PostgreSQL disaster-recovery drills.
 *
 * Creates a single kernel run and prints its id/tenantId as JSON so that
 * shell scripts can capture and verify it after PITR or failover.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresKernelRepository } from './postgres.js';
import { runKernelMigrations } from './migrations.js';

export interface CreatedRun {
  id: string;
  tenantId: string;
}

export async function createDrillRun(databaseUrl: string): Promise<CreatedRun> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runKernelMigrations(pool);
    const repo = new PostgresKernelRepository(pool);
    const tenantId = `tenant-drill-${Date.now()}`;
    const id = `run_${randomUUID().slice(0, 8)}`;
    const run = await repo.createRun({
      id,
      tenantId,
      intentHash: createHash('sha256').update(id).digest('hex'),
      workGraphHash: createHash('sha256').update('[]').digest('hex'),
      workGraphVersion: 'v1',
      policySnapshotId: 'drill-policy',
      steps: [{ id: `${id}-step-0`, kind: 'agent', maxAttempts: 3, priority: 0 }],
    }, 'drill');
    return { id: run.id, tenantId: run.tenantId };
  } finally {
    await pool.end();
  }
}

async function main() {
  const databaseUrl = process.argv[2];
  if (!databaseUrl) {
    console.error('Usage: tsx packages/kernel/src/drillWorkload.ts <databaseUrl>');
    process.exit(1);
  }
  const run = await createDrillRun(databaseUrl);
  console.log(JSON.stringify(run));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
