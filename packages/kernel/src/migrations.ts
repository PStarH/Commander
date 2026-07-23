import { createHash } from 'node:crypto';
import {
  KERNEL_CLAIM_SQL,
  KERNEL_CLAIM_RECONCILE_SQL,
  KERNEL_CLAIM_SECRET_SQL,
  KERNEL_RLS_SQL,
  KERNEL_ROLES_SQL,
  KERNEL_SCHEMA_SQL,
  KERNEL_SCHEMA_VERSION,
} from './schema.js';
import type { SqlPool } from './postgres.js';

export interface KernelMigration {
  id: string;
  checksum: string;
  sql: string;
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export const KERNEL_MIGRATIONS: readonly KernelMigration[] = [
  { id: `${KERNEL_SCHEMA_VERSION}.schema`, sql: KERNEL_SCHEMA_SQL, checksum: checksum(KERNEL_SCHEMA_SQL) },
  { id: `${KERNEL_SCHEMA_VERSION}.rls`, sql: KERNEL_RLS_SQL, checksum: checksum(KERNEL_RLS_SQL) },
  { id: `${KERNEL_SCHEMA_VERSION}.roles`, sql: KERNEL_ROLES_SQL, checksum: checksum(KERNEL_ROLES_SQL) },
  {
    id: `${KERNEL_SCHEMA_VERSION}.claim_secret`,
    sql: KERNEL_CLAIM_SECRET_SQL,
    checksum: checksum(KERNEL_CLAIM_SECRET_SQL),
  },
  { id: `${KERNEL_SCHEMA_VERSION}.claim`, sql: KERNEL_CLAIM_SQL, checksum: checksum(KERNEL_CLAIM_SQL) },
  {
    id: `${KERNEL_SCHEMA_VERSION}.claim_reconcile`,
    sql: KERNEL_CLAIM_RECONCILE_SQL,
    checksum: checksum(KERNEL_CLAIM_RECONCILE_SQL),
  },
];

export interface MigrationRunOptions {
  /** Expected role category for the connection. */
  requiredRole?: 'owner' | 'scheduler' | 'app';
}

/** Apply kernel migrations exactly once, with checksum and advisory-lock checks. */
export async function runKernelMigrations(pool: SqlPool, options?: MigrationRunOptions): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('commander.kernel.migrations'))");

    const roleRes = await client.query<{ current_user: string; session_user: string }>('SELECT current_user, session_user');
    const currentUser = roleRes.rows[0].current_user;

    // App role must never run migrations; it is not the table owner.
    if (currentUser === 'commander_app') {
      throw new Error('Kernel migrations rejected: app role is not the migration owner');
    }

    // If kernel tables already exist, the current role must own them (or be a superuser).
    // This prevents a leaked app-role connection from silently re-applying migrations.
    const ownsTable = await client.query<{ owns: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = 'commander_runs'
          AND tableowner = current_user
      ) AS owns`
    );
    const tableExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='commander_runs') AS exists`
    );
    if (tableExists.rows[0].exists && !ownsTable.rows[0].owns && currentUser !== 'postgres' && currentUser !== 'commander_owner') {
      throw new Error(`Kernel migrations rejected: current_user=${currentUser} is not the table owner`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS commander_kernel_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    for (const migration of KERNEL_MIGRATIONS) {
      const existing = await client.query<{ checksum: string }>('SELECT checksum FROM commander_kernel_migrations WHERE id=$1', [migration.id]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== migration.checksum) throw new Error(`Kernel migration checksum mismatch for ${migration.id}`);
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO commander_kernel_migrations (id, checksum) VALUES ($1,$2)', [migration.id, migration.checksum]);
    }

    // Ensure the migration owner can bypass RLS for operational queries and the
    // migrations table (which has no tenant_id column). Superusers already have
    // this attribute; the statement is a no-op in that case.
    const ownerInfo = await client.query<{ rolbypassrls: boolean; rolname: string }>(
      'SELECT rolbypassrls, rolname FROM pg_roles WHERE rolname = current_user'
    );
    if (!ownerInfo.rows[0]?.rolbypassrls) {
      await client.query(`ALTER ROLE "${ownerInfo.rows[0].rolname}" BYPASSRLS`);
    }

    // The least-privilege application role must never bypass RLS. The roles
    // migration creates it without BYPASSRLS; this defensive block ensures the
    // role exists even if that migration is skipped in a legacy/test harness.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
          CREATE ROLE commander_app NOLOGIN NOBYPASSRLS;
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve migration error */ }
    throw error;
  } finally {
    client.release();
  }
}
