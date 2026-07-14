import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PostgresKernelRepository } from '../../../kernel/src/postgres.js';
import type { SqlClient, SqlPool } from '../../../kernel/src/postgres.js';
import { runKernelMigrations } from '../../../kernel/src/migrations.js';

const databaseUrl =
  process.env.COMMANDER_KERNEL_DATABASE_URL ??
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL;

function makeRunCommand(tenantId: string) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update('graph').digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'rls-test-policy',
    steps: [{ id: `${runId}-step-0`, kind: 'agent', maxAttempts: 1 }],
  };
}

/**
 * Pool wrapper that authenticates as the bootstrap owner but immediately
 * SET SESSION ROLEs to commander_app. This is equivalent to connecting as
 * commander_app while reusing the owner connection string in test setups
 * where a dedicated app login has not been created.
 */
function createAppPool(ownerUrl: string): SqlPool & { end(): Promise<void> } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pool: Pool = new (require('pg').Pool)({ connectionString: ownerUrl, max: 2 });
  return {
    connect: async () => {
      const client = await pool.connect();
      await client.query('SET SESSION ROLE commander_app');
      return client as SqlClient;
    },
    end: () => pool.end(),
  };
}

async function probePostgres(): Promise<{ available: boolean; hasAppRole: boolean }> {
  if (!databaseUrl) return { available: false, hasAppRole: false };
  try {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const result = await pool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') AS exists"
      );
      return { available: true, hasAppRole: result.rows[0]?.exists ?? false };
    } finally {
      await pool.end();
    }
  } catch {
    return { available: false, hasAppRole: false };
  }
}

const probe = await probePostgres();
const describeIf = probe.available && probe.hasAppRole ? describe : describe.skip;

describeIf('Postgres RLS tenant isolation', () => {
  let ownerPool: Pool;
  let appPool: SqlPool & { end(): Promise<void> };

  beforeAll(async () => {
    const { Pool } = await import('pg');
    ownerPool = new Pool({ connectionString: databaseUrl, max: 4 });
    await runKernelMigrations(ownerPool);
    appPool = createAppPool(databaseUrl!);
  });

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
  });

  it('app role sees only its own tenant; owner role sees all rows', async () => {
    const tenantA = `rls-a-${Date.now()}`;
    const tenantB = `rls-b-${Date.now()}`;
    const runA = makeRunCommand(tenantA);
    const runB = makeRunCommand(tenantB);

    const appRepoA = new PostgresKernelRepository(appPool);
    const appRepoB = new PostgresKernelRepository(appPool);

    // Create one run per tenant through the app role.
    await appRepoA.createRun(runA, 'rls-test');
    await appRepoB.createRun(runB, 'rls-test');

    try {
      // A scoped connection must not see B's run.
      expect(await appRepoA.getRun(runB.id, tenantA)).toBeNull();
      expect(await appRepoB.getRun(runA.id, tenantB)).toBeNull();

      // Each tenant can still see its own run.
      expect(await appRepoA.getRun(runA.id, tenantA)).toMatchObject({ id: runA.id, tenantId: tenantA });
      expect(await appRepoB.getRun(runB.id, tenantB)).toMatchObject({ id: runB.id, tenantId: tenantB });

      // Owner connection (BYPASSRLS) can see both rows regardless of tenant scope.
      const ownerRows = await ownerPool.query<{ id: string; tenant_id: string }>(
        'SELECT id, tenant_id FROM commander_runs WHERE tenant_id = ANY($1::text[]) ORDER BY tenant_id',
        [[tenantA, tenantB]]
      );
      expect(ownerRows.rows).toHaveLength(2);
      expect(ownerRows.rows.map((r) => r.tenant_id).sort()).toEqual([tenantA, tenantB].sort());
    } finally {
      await ownerPool.query('DELETE FROM commander_runs WHERE tenant_id = ANY($1::text[])', [
        [tenantA, tenantB],
      ]);
    }
  });

  it('app role cannot disable RLS or read pg_authid', async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query('ALTER TABLE commander_runs DISABLE ROW LEVEL SECURITY')).rejects.toThrow(
        /must be owner|permission denied/i
      );
      await expect(client.query('SELECT * FROM pg_authid')).rejects.toThrow(/permission denied/i);
    } finally {
      await client.release();
    }
  });
});
