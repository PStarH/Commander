import { createHash } from 'node:crypto';
import {
  KERNEL_CLAIM_RECONCILE_SQL,
  KERNEL_CLAIM_SECRET_SQL,
  KERNEL_ADAPTER_OPS_SQL,
  KERNEL_ADMIT_CLASS_A_SQL,
  KERNEL_TASK1_COMPLETED_REPLAY_GATE_SQL,
  KERNEL_TASK1_RUNTIME_AUTHORITY_CLOSURE_SQL,
  KERNEL_TASK1_FINAL_REVIEW_SQL,
  KERNEL_TASK1_ROLE_CLOSURE_SQL,
} from './schema.js';
import * as kernel2026072116 from './schema20260721_16.js';
import { KERNEL_TASK1_HELM_LIFECYCLE_GATE_SQL } from './task1LifecycleLedger.js';
import {
  KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
  KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_EXPAND_SQL,
} from './task1TenantContext.js';
import {
  KERNEL_TASK2_RECONCILIATION_RPCS_SQL,
  KERNEL_TASK2_RECONCILIATION_SCHEMA_SQL,
  KERNEL_TASK2_ROLE_CLOSURE_SQL,
} from './task2Reconciliation.js';
import type { SqlClient, SqlPool } from './postgres.js';
import {
  KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
  KERNEL_SIGNED_EVIDENCE_SQL,
} from './evidenceSchema.js';
import { KERNEL_COMPENSATION_PERSISTENCE_SQL } from './compensationSchema.js';
import { KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL } from './campaign2CriticalHardening.js';

export interface KernelMigration {
  id: string;
  checksum: string;
  sql: string;
}

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

const KERNEL_2026072116_SCHEMA_VERSION = kernel2026072116.KERNEL_SCHEMA_VERSION;

/** Immutable descriptors published by the merged 2026-07-21.16 baseline. */
export const KERNEL_2026072116_MIGRATIONS: readonly KernelMigration[] = [
  {
    id: `${KERNEL_2026072116_SCHEMA_VERSION}.schema`,
    sql: kernel2026072116.KERNEL_SCHEMA_SQL,
    checksum: checksum(kernel2026072116.KERNEL_SCHEMA_SQL),
  },
  {
    id: `${KERNEL_2026072116_SCHEMA_VERSION}.rls`,
    sql: kernel2026072116.KERNEL_RLS_SQL,
    checksum: checksum(kernel2026072116.KERNEL_RLS_SQL),
  },
  {
    id: `${KERNEL_2026072116_SCHEMA_VERSION}.roles`,
    sql: kernel2026072116.KERNEL_ROLES_SQL,
    checksum: checksum(kernel2026072116.KERNEL_ROLES_SQL),
  },
  {
    id: `${KERNEL_2026072116_SCHEMA_VERSION}.claim_secret`,
    sql: kernel2026072116.KERNEL_CLAIM_SECRET_SQL,
    checksum: checksum(kernel2026072116.KERNEL_CLAIM_SECRET_SQL),
  },
  {
    id: `${KERNEL_2026072116_SCHEMA_VERSION}.claim`,
    sql: kernel2026072116.KERNEL_CLAIM_SQL,
    checksum: checksum(kernel2026072116.KERNEL_CLAIM_SQL),
  },
  {
    id: `${KERNEL_2026072116_SCHEMA_VERSION}.claim_reconcile`,
    sql: kernel2026072116.KERNEL_CLAIM_RECONCILE_SQL,
    checksum: checksum(kernel2026072116.KERNEL_CLAIM_RECONCILE_SQL),
  },
];

export const KERNEL_HISTORICAL_MIGRATION_CHECKSUMS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      KERNEL_2026072116_MIGRATIONS.map((migration) => [migration.id, migration.checksum]),
    ),
  );

/** Task 1 forward descriptors are pinned independently of mutable schema exports. */
export const KERNEL_TASK1_FORWARD_MIGRATION_CHECKSUMS = Object.freeze({
  '2026-07-23.17.task1_role_closure':
    '4530eb230afb208500eec8639711fb669057b0185cb021093bc06e711fdc6070',
  '2026-07-23.17.task1_worker_registration_guard':
    '47dc6b111b972285a03be3c8c47814ef43c772a9b290da7e54ab47b0b381da8e',
  '2026-07-23.17.task1_adapter_ops_rpcs':
    '45fcc1e8c3f45228c30cc931ab3cddae7dd64c7888e81407ec8feb3e557f4e37',
  '2026-07-23.17.task1_admission_foundation':
    '7d7e029ad011daebd45f9f44773055d1142d667c034e489846116583e0587a8d',
  '2026-07-23.17.task1_adapter_ops_claims':
    '4661787e70ecce5005456e8757959f02573234d5cb5e25be9bb47c1737c33e71',
  '2026-07-25.1.task1_final_review':
    'cd38a10af9a988fcb06f57a00e5266e03baa5c03a022afd650a3dc69150a8100',
  '2026-07-26.1.task1_completed_replay_gate':
    'a946e4a209282b9a287bd0e6f82d3253d0ce91e69a382fd3d7f8cb2a93fe569c',
  '2026-07-26.1.task1_runtime_authority_closure':
    'e6dc7640498b11819d67670d765109b91c9327e841dcff2536b7cce7629077ba',
});

/** Phase-aware closure descriptors. The lifecycle owner runner, never runtime startup, applies them. */
export const KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS = Object.freeze({
  '2026-07-27.1.task1_helm_lifecycle_gate':
    '6b7e2bc0acd4ee28ad02f9c70924709bb6f9e00205247d87e752e2df5ff930f3',
  '2026-07-27.2.task1_authenticated_tenant_authority_expand':
    'd9a70e13065a7eeb82fae265080530481bd644c0798e32bd88b67722cbdf6eb5',
  '2026-07-27.3.task1_authenticated_tenant_authority_enforce':
    '9994edfd6cd1cb7f68b538b4b0f04d1f73435a003b6dba958da7ccdcffc42fc5',
});

export const KERNEL_TASK2_FORWARD_MIGRATION_CHECKSUMS = Object.freeze({
  '2026-07-26.2.task2_reconciliation_schema':
    '281a703a1cc0a6f98e53d30e78ce9cdf632f31685794bdd3d95c122e431c7703',
  '2026-07-26.2.task2_reconciliation_rpcs':
    '79007556a06e8188c4d85c23ec71d0ee114eafdff337747c5aa5ee76c8bb2b62',
  '2026-07-26.2.task2_role_closure':
    '5e56de3dfa9a4d884822c077ca28e6bdc7d482a1cfcc3a3b9a7d5a567e6e0289',
});

type Task1ForwardMigrationId = keyof typeof KERNEL_TASK1_FORWARD_MIGRATION_CHECKSUMS;
type Task1ClosureMigrationId = keyof typeof KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS;
type Task2ForwardMigrationId = keyof typeof KERNEL_TASK2_FORWARD_MIGRATION_CHECKSUMS;

function task1ForwardMigration(id: Task1ForwardMigrationId, sql: string): KernelMigration {
  const expectedChecksum = KERNEL_TASK1_FORWARD_MIGRATION_CHECKSUMS[id];
  const actualChecksum = checksum(sql);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Task 1 migration source changed without a new descriptor: ${id}`);
  }
  return { id, sql, checksum: expectedChecksum };
}

function task1ClosureMigration(id: Task1ClosureMigrationId, sql: string): KernelMigration {
  const expectedChecksum = KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS[id];
  const actualChecksum = checksum(sql);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Task 1 closure migration source changed without a new descriptor: ${id}`);
  }
  return { id, sql, checksum: expectedChecksum };
}

function task2ForwardMigration(id: Task2ForwardMigrationId, sql: string): KernelMigration {
  const expectedChecksum = KERNEL_TASK2_FORWARD_MIGRATION_CHECKSUMS[id];
  const actualChecksum = checksum(sql);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Task 2 migration source changed without a new descriptor: ${id}`);
  }
  return { id, sql, checksum: expectedChecksum };
}

/** Forward descriptors added after the immutable 2026-07-21.16 baseline. */
export const KERNEL_TASK1_FORWARD_MIGRATIONS: readonly KernelMigration[] = [
  task1ForwardMigration('2026-07-23.17.task1_role_closure', KERNEL_TASK1_ROLE_CLOSURE_SQL),
  task1ForwardMigration('2026-07-23.17.task1_worker_registration_guard', KERNEL_CLAIM_SECRET_SQL),
  task1ForwardMigration('2026-07-23.17.task1_adapter_ops_rpcs', KERNEL_ADAPTER_OPS_SQL),
  task1ForwardMigration('2026-07-23.17.task1_admission_foundation', KERNEL_ADMIT_CLASS_A_SQL),
  task1ForwardMigration('2026-07-23.17.task1_adapter_ops_claims', KERNEL_CLAIM_RECONCILE_SQL),
  task1ForwardMigration('2026-07-25.1.task1_final_review', KERNEL_TASK1_FINAL_REVIEW_SQL),
  task1ForwardMigration(
    '2026-07-26.1.task1_completed_replay_gate',
    KERNEL_TASK1_COMPLETED_REPLAY_GATE_SQL,
  ),
  task1ForwardMigration(
    '2026-07-26.1.task1_runtime_authority_closure',
    KERNEL_TASK1_RUNTIME_AUTHORITY_CLOSURE_SQL,
  ),
];

export const KERNEL_TASK2_FORWARD_MIGRATIONS: readonly KernelMigration[] = [
  task2ForwardMigration(
    '2026-07-26.2.task2_reconciliation_schema',
    KERNEL_TASK2_RECONCILIATION_SCHEMA_SQL,
  ),
  task2ForwardMigration(
    '2026-07-26.2.task2_reconciliation_rpcs',
    KERNEL_TASK2_RECONCILIATION_RPCS_SQL,
  ),
  task2ForwardMigration('2026-07-26.2.task2_role_closure', KERNEL_TASK2_ROLE_CLOSURE_SQL),
];

export const KERNEL_SIGNED_EVIDENCE_MIGRATIONS: readonly KernelMigration[] = [
  {
    id: '2026-07-29.1.signed_evidence_receipts',
    sql: KERNEL_SIGNED_EVIDENCE_SQL,
    checksum: checksum(KERNEL_SIGNED_EVIDENCE_SQL),
  },
  {
    id: '2026-07-29.2.signed_evidence_authority_closure',
    sql: KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL,
    checksum: checksum(KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL),
  },
];

export const KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS: readonly KernelMigration[] = [
  {
    id: '2026-07-29.1.governed_compensation_persistence',
    sql: KERNEL_COMPENSATION_PERSISTENCE_SQL,
    checksum: checksum(KERNEL_COMPENSATION_PERSISTENCE_SQL),
  },
];

export const KERNEL_CAMPAIGN2_CRITICAL_HARDENING_MIGRATIONS: readonly KernelMigration[] = [
  {
    id: '2026-07-29.2.campaign2_critical_authority_hardening',
    sql: KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL,
    checksum: checksum(KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL),
  },
];

export const KERNEL_FORWARD_MIGRATIONS: readonly KernelMigration[] = [
  ...KERNEL_TASK1_FORWARD_MIGRATIONS,
  ...KERNEL_TASK2_FORWARD_MIGRATIONS,
  ...KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS,
  ...KERNEL_CAMPAIGN2_CRITICAL_HARDENING_MIGRATIONS,
  ...KERNEL_SIGNED_EVIDENCE_MIGRATIONS,
];

export const KERNEL_TASK1_BASELINE_MIGRATIONS: readonly KernelMigration[] = [
  ...KERNEL_2026072116_MIGRATIONS,
  ...KERNEL_TASK1_FORWARD_MIGRATIONS,
];

export const KERNEL_TASK1_CLOSURE_MIGRATIONS: readonly KernelMigration[] = [
  task1ClosureMigration(
    '2026-07-27.1.task1_helm_lifecycle_gate',
    KERNEL_TASK1_HELM_LIFECYCLE_GATE_SQL,
  ),
  task1ClosureMigration(
    '2026-07-27.2.task1_authenticated_tenant_authority_expand',
    KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_EXPAND_SQL,
  ),
  task1ClosureMigration(
    '2026-07-27.3.task1_authenticated_tenant_authority_enforce',
    KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL,
  ),
];

export const KERNEL_MIGRATIONS: readonly KernelMigration[] = [
  ...KERNEL_TASK1_BASELINE_MIGRATIONS,
  ...KERNEL_TASK2_FORWARD_MIGRATIONS,
  ...KERNEL_COMPENSATION_PERSISTENCE_MIGRATIONS,
  ...KERNEL_CAMPAIGN2_CRITICAL_HARDENING_MIGRATIONS,
  ...KERNEL_SIGNED_EVIDENCE_MIGRATIONS,
];

export interface MigrationRunOptions {
  /** Expected role category for the connection. */
  requiredRole?: 'owner' | 'scheduler' | 'app';
}

export type Task1ClosurePhase = 'expand' | 'enforce';

const TASK1_DESCRIPTOR_NAMES = ['lifecycle', 'expand', 'enforce'] as const;
type Task1DescriptorName = (typeof TASK1_DESCRIPTOR_NAMES)[number];

function selectedTask1ClosureMigrations(
  descriptorSet: readonly string[],
): readonly KernelMigration[] {
  if (
    descriptorSet.length < 1 ||
    descriptorSet.length > TASK1_DESCRIPTOR_NAMES.length ||
    descriptorSet.some((value, index) => value !== TASK1_DESCRIPTOR_NAMES[index])
  ) {
    throw new Error('TASK1_CLOSURE_DESCRIPTOR_SET_INVALID');
  }
  return KERNEL_TASK1_CLOSURE_MIGRATIONS.slice(0, descriptorSet.length);
}

/** Apply an exact closure prefix on the already-locked owner transaction client. */
export async function applyTask1ClosureDescriptorSet(
  client: SqlClient,
  descriptorSet: readonly Task1DescriptorName[] | readonly string[],
): Promise<void> {
  for (const migration of [...KERNEL_2026072116_MIGRATIONS, ...KERNEL_TASK1_FORWARD_MIGRATIONS]) {
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM commander_kernel_migrations WHERE id=$1',
      [migration.id],
    );
    if (existing.rowCount !== 1 || existing.rows[0]?.checksum !== migration.checksum) {
      throw new Error('TASK1_CLOSURE_BASELINE_REQUIRED');
    }
  }

  for (const migration of selectedTask1ClosureMigrations(descriptorSet)) {
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM commander_kernel_migrations WHERE id=$1',
      [migration.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== migration.checksum) {
        throw new Error('TASK1_CLOSURE_CHECKSUM_MISMATCH');
      }
      continue;
    }
    await client.query(migration.sql);
    await client.query('INSERT INTO commander_kernel_migrations (id, checksum) VALUES ($1,$2)', [
      migration.id,
      migration.checksum,
    ]);
  }
}

/**
 * Apply the Task 1 closure descriptors under an exact owner session. Runtime startup deliberately
 * calls runKernelMigrations instead, whose descriptor set excludes these phase-gated migrations.
 */
export async function runTask1ClosureMigrations(
  pool: SqlPool,
  phase: Task1ClosurePhase,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('commander.kernel.migrations'))");
    const authority = await client.query<{ current_user: string; session_user: string }>(
      'SELECT current_user, session_user',
    );
    const identity = authority.rows[0];
    if (
      authority.rowCount !== 1 ||
      identity?.current_user !== 'commander_owner' ||
      identity.session_user !== 'commander_owner'
    ) {
      throw new Error('TASK1_CLOSURE_OWNER_AUTHORITY_REQUIRED');
    }

    await applyTask1ClosureDescriptorSet(
      client,
      phase === 'expand' ? ['lifecycle', 'expand'] : ['lifecycle', 'expand', 'enforce'],
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the authority or descriptor failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Apply kernel migrations exactly once, with checksum and advisory-lock checks. */
export async function runKernelMigrations(
  pool: SqlPool,
  options?: MigrationRunOptions,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('commander.kernel.migrations'))");

    const roleRes = await client.query<{ current_user: string; session_user: string }>(
      'SELECT current_user, session_user',
    );
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
      ) AS owns`,
    );
    const tableExists = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='commander_runs') AS exists`,
    );
    if (
      tableExists.rows[0].exists &&
      !ownsTable.rows[0].owns &&
      currentUser !== 'postgres' &&
      currentUser !== 'commander_owner'
    ) {
      throw new Error(
        `Kernel migrations rejected: current_user=${currentUser} is not the table owner`,
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS commander_kernel_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const closure = await client.query<{ checksum: string }>(
      'SELECT checksum FROM commander_kernel_migrations WHERE id=$1',
      ['2026-07-27.3.task1_authenticated_tenant_authority_enforce'],
    );
    const migrations =
      closure.rows[0]?.checksum ===
      KERNEL_TASK1_CLOSURE_MIGRATION_CHECKSUMS[
        '2026-07-27.3.task1_authenticated_tenant_authority_enforce'
      ]
        ? KERNEL_MIGRATIONS
        : KERNEL_TASK1_BASELINE_MIGRATIONS;
    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM commander_kernel_migrations WHERE id=$1',
        [migration.id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== migration.checksum)
          throw new Error(`Kernel migration checksum mismatch for ${migration.id}`);
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO commander_kernel_migrations (id, checksum) VALUES ($1,$2)', [
        migration.id,
        migration.checksum,
      ]);
    }

    // Ensure the migration owner can bypass RLS for operational queries and the
    // migrations table (which has no tenant_id column). Superusers already have
    // this attribute; the statement is a no-op in that case.
    const ownerInfo = await client.query<{ rolbypassrls: boolean; rolname: string }>(
      'SELECT rolbypassrls, rolname FROM pg_roles WHERE rolname = current_user',
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
    try {
      await client.query('ROLLBACK');
    } catch {
      /* preserve migration error */
    }
    throw error;
  } finally {
    client.release();
  }
}
