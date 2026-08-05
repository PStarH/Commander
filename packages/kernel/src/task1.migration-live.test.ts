import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Pool } from 'pg';
import {
  KERNEL_2026072116_MIGRATIONS,
  KERNEL_FORWARD_MIGRATIONS,
  KERNEL_TASK1_BASELINE_MIGRATIONS,
  KERNEL_TASK1_CLOSURE_MIGRATIONS,
  KERNEL_TASK1_POST_CLOSURE_MIGRATIONS,
  KERNEL_TASK2_FORWARD_MIGRATIONS,
  runKernelMigrations,
  runTask1ClosureMigrations,
} from './migrations.js';
import { KERNEL_TASK2_RECONCILIATION_SCHEMA_SQL_HISTORICAL } from './task2Reconciliation.js';

const ownerUrl = process.env.COMMANDER_TASK1_PG_URL;

type LedgerRow = {
  id: string;
  checksum: string;
  applied_at: string;
};

function databaseUrl(databaseName: string): string {
  const url = new URL(ownerUrl!);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function databaseIdentifier(databaseName: string): string {
  if (!/^commander_task1_migration_[a-z0-9_]+$/.test(databaseName)) {
    throw new Error('unsafe test database identifier');
  }
  return `"${databaseName}"`;
}

async function withTestDatabase<T>(
  adminPool: Pool,
  label: string,
  run: (pool: Pool, databaseName: string) => Promise<T>,
  owner?: 'commander_owner',
): Promise<T> {
  const databaseName = `commander_task1_migration_${label}_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const identifier = databaseIdentifier(databaseName);
  await adminPool.query(`CREATE DATABASE ${identifier}${owner ? ` OWNER ${owner}` : ''}`);
  const pool = new Pool({ connectionString: databaseUrl(databaseName), max: 4 });
  try {
    return await run(pool, databaseName);
  } finally {
    await pool.end();
    await adminPool.query(`DROP DATABASE ${identifier} WITH (FORCE)`);
  }
}

async function applyFrozenBaseline(pool: Pool): Promise<void> {
  await pool.query('BEGIN');
  try {
    await pool.query(`
      CREATE TABLE commander_kernel_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const migration of KERNEL_2026072116_MIGRATIONS) {
      await pool.query(migration.sql);
      await pool.query('INSERT INTO commander_kernel_migrations (id, checksum) VALUES ($1, $2)', [
        migration.id,
        migration.checksum,
      ]);
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function readLedger(pool: Pool): Promise<LedgerRow[]> {
  const result = await pool.query<LedgerRow>(`
    SELECT id, checksum, applied_at::text
    FROM commander_kernel_migrations
    ORDER BY id
  `);
  return result.rows;
}

const forbiddenForwardIds = new Set([
  '2026-07-23.17.schema',
  '2026-07-23.17.rls',
  '2026-07-23.17.roles',
  '2026-07-23.17.claim_secret',
  '2026-07-23.17.claim',
  '2026-07-23.17.claim_reconcile',
]);

describe('Task 1 PostgreSQL migration history', { skip: !ownerUrl }, () => {
  it('upgrades the immutable .16 baseline with only Task 1 forward descriptors', async () => {
    const adminPool = new Pool({ connectionString: ownerUrl, max: 2 });
    try {
      await withTestDatabase(adminPool, 'upgrade', async (pool) => {
        await applyFrozenBaseline(pool);
        const baselineLedger = await readLedger(pool);

        await runKernelMigrations(pool);
        const upgradedLedger = await readLedger(pool);

        assert.deepEqual(
          upgradedLedger.filter((row) => row.id.startsWith('2026-07-21.16.')),
          baselineLedger,
          'baseline checksum and applied_at values must remain unchanged',
        );
        assert.deepEqual(
          upgradedLedger.map((row) => row.id).sort(),
          KERNEL_TASK1_BASELINE_MIGRATIONS.map((migration) => migration.id).sort(),
        );
        assert.equal(
          upgradedLedger.some((row) => forbiddenForwardIds.has(row.id)),
          false,
        );
        assert.deepEqual(
          upgradedLedger.find((row) => row.id === '2026-07-26.1.task1_runtime_authority_closure'),
          {
            id: '2026-07-26.1.task1_runtime_authority_closure',
            checksum: 'e6dc7640498b11819d67670d765109b91c9327e841dcff2536b7cce7629077ba',
            applied_at: upgradedLedger.find(
              (row) => row.id === '2026-07-26.1.task1_runtime_authority_closure',
            )?.applied_at,
          },
        );

        await runKernelMigrations(pool);
        assert.deepEqual(await readLedger(pool), upgradedLedger);
      });
    } finally {
      await adminPool.end();
    }
  });

  it('rejects a corrupted historical checksum before adding forward rows', async () => {
    const adminPool = new Pool({ connectionString: ownerUrl, max: 2 });
    try {
      await withTestDatabase(adminPool, 'checksum', async (pool) => {
        await applyFrozenBaseline(pool);
        await pool.query(
          `UPDATE commander_kernel_migrations
           SET checksum=$1
           WHERE id='2026-07-21.16.schema'`,
          ['0'.repeat(64)],
        );

        await assert.rejects(
          () => runKernelMigrations(pool),
          /Kernel migration checksum mismatch for 2026-07-21\.16\.schema/,
        );
        const forwardCount = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM commander_kernel_migrations
           WHERE id = ANY($1::text[])`,
          [KERNEL_FORWARD_MIGRATIONS.map((migration) => migration.id)],
        );
        assert.equal(Number(forwardCount.rows[0]?.count), 0);
      });
    } finally {
      await adminPool.end();
    }
  });

  it('records the same ledger on fresh install and baseline upgrade', async () => {
    const adminPool = new Pool({ connectionString: ownerUrl, max: 2 });
    try {
      const upgraded = await withTestDatabase(adminPool, 'parity_upgrade', async (pool) => {
        await applyFrozenBaseline(pool);
        await runKernelMigrations(pool);
        return readLedger(pool);
      });
      const fresh = await withTestDatabase(adminPool, 'parity_fresh', async (pool) => {
        await runKernelMigrations(pool);
        return readLedger(pool);
      });

      assert.deepEqual(
        fresh.map(({ id, checksum }) => ({ id, checksum })),
        upgraded.map(({ id, checksum }) => ({ id, checksum })),
      );
      assert.equal(
        fresh.some(({ id }) => KERNEL_TASK1_POST_CLOSURE_MIGRATIONS.some((migration) => migration.id === id)),
        false,
        'fresh baseline migration must not record post-closure repairs',
      );
    } finally {
      await adminPool.end();
    }
  });

  it('applies phase-gated closure descriptors through the real owner login', async () => {
    const adminPool = new Pool({ connectionString: ownerUrl, max: 2 });
    const password = `owner-${randomUUID()}`;
    try {
      await adminPool.query(`
        DO $role$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
            CREATE ROLE commander_owner NOLOGIN;
          END IF;
        END
        $role$
      `);
      await adminPool.query(
        `ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS PASSWORD '${password}'`,
      );
      const runtimeRoles = [
        ['commander_app', false],
        ['commander_tenant_authority', false],
        ['commander_scheduler', true],
        ['commander_worker', false],
        ['commander_adapter_ops', false],
      ] as const;
      for (const [role, bypassRls] of runtimeRoles) {
        await adminPool.query(`
          DO $runtime_role$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
              CREATE ROLE ${role};
            END IF;
          END
          $runtime_role$
        `);
        await adminPool.query(
          `ALTER ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION ${bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`,
        );
        await adminPool.query(
          `GRANT ${role} TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE`,
        );
      }
      await withTestDatabase(
        adminPool,
        'closure',
        async (_pool, databaseName) => {
          const ownerDsn = new URL(databaseUrl(databaseName));
          ownerDsn.username = 'commander_owner';
          ownerDsn.password = password;
          const lifecyclePool = new Pool({ connectionString: ownerDsn.toString(), max: 2 });
          try {
            await runKernelMigrations(lifecyclePool);
            await runTask1ClosureMigrations(lifecyclePool, 'expand');
            let ledger = await readLedger(lifecyclePool);
            assert.deepEqual(
              ledger.filter(({ id }) => id.startsWith('2026-07-27.')).map(({ id }) => id),
              KERNEL_TASK1_CLOSURE_MIGRATIONS.slice(0, 2).map(({ id }) => id),
            );
            assert.equal(
              await lifecyclePool
                .query<{ relation: string | null }>(
                  `SELECT pg_catalog.to_regclass('public.commander_tenant_cutover_state')::text AS relation`,
                )
                .then(({ rows }) => rows[0]?.relation),
              'commander_tenant_cutover_state',
            );

            await runTask1ClosureMigrations(lifecyclePool, 'enforce');
            await assert.rejects(
              () => lifecyclePool.query(KERNEL_TASK2_RECONCILIATION_SCHEMA_SQL_HISTORICAL),
              /TASK2_TASK1_ENFORCE_BASELINE_REQUIRED/,
              'the frozen Task 2 descriptor must reject the canonical Task 1 enforce ledger',
            );
            await runKernelMigrations(lifecyclePool);
            ledger = await readLedger(lifecyclePool);
            assert.deepEqual(
              ledger.filter(({ id }) => id.startsWith('2026-07-27.')).map(({ id }) => id),
              KERNEL_TASK1_CLOSURE_MIGRATIONS.map(({ id }) => id),
            );
            assert.deepEqual(
              ledger.filter(({ id }) => id.startsWith('2026-07-26.2.')).map(({ id }) => id),
              KERNEL_TASK2_FORWARD_MIGRATIONS.filter(({ id }) => id.startsWith('2026-07-26.2.'))
                .filter(({ id }) => id !== '2026-07-26.2.task2_reconciliation_schema')
                .map(({ id }) => id)
                .sort(),
            );
            assert.deepEqual(
              ledger.filter(({ id }) => id.startsWith('2026-08-05.1.')).map(({ id }) => id),
              KERNEL_TASK1_POST_CLOSURE_MIGRATIONS.map(({ id }) => id),
            );
            assert.equal(
              ledger.some(
                ({ id }) => id === '2026-08-02.3.task2_reconciliation_schema_canonical_baseline',
              ),
              true,
            );
          } finally {
            await lifecyclePool.end();
          }
        },
        'commander_owner',
      );
    } finally {
      await adminPool.query('ALTER ROLE commander_owner NOLOGIN NOCREATEROLE');
      await adminPool.end();
    }
  });
});
