#!/usr/bin/env npx tsx
/**
 * demo-qa helper: idempotently prepare the throwaway QA Postgres (port 5433)
 * for the golden-path E2E test:
 *
 *   0. roles + schema grants (Postgres 15+ removed public CREATE)
 *   1. runKernelMigrations        — baseline + forward migrations with ledger
 *   2. runTask1ClosureMigrations  — expand + enforce closure phases (owner-only)
 *   3. second runKernelMigrations — full set once the canonical closure is
 *      present in the ledger (task2, auth persistence, memory schema)
 *   4. hand api_* and memory_* tables to commander_app (the API's schema
 *      manager owns and ALTERs them at boot; production grants come from
 *      Helm jobs)
 *
 * QA-only: requires the local trust-auth cluster created by initdb with
 * `--auth=trust -U commander_owner` on 127.0.0.1:5433 (never a real database).
 */
import { Pool } from 'pg';
import {
  runKernelMigrations,
  runTask1ClosureMigrations,
} from '../../packages/kernel/src/migrations';

const APP_TABLES = [
  'api_tasks',
  'api_artifacts',
  'api_governance_checkpoints',
  'api_governance_configs',
  'memory_items',
  'memory_audit_events',
];

async function ensureRoles(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname LIKE 'commander%'",
  );
  const existing = new Set(rows.map((r) => r.rolname));
  const wanted: Array<[string, string]> = [
    ['commander_app', 'LOGIN PASSWORD'],
    ['commander_scheduler', 'NOLOGIN'],
    ['commander_worker', 'NOLOGIN'],
    ['commander_adapter_ops', 'NOLOGIN'],
    ['commander_tenant_authority', 'NOLOGIN'],
  ];
  for (const [name] of wanted) {
    if (!existing.has(name)) {
      const password = name === 'commander_app' ? " PASSWORD 'commander_app'" : '';
      await pool.query(
        `CREATE ROLE "${name}" ${name === 'commander_app' ? 'LOGIN' : 'NOLOGIN'}${password}`,
      );
    }
  }
  await pool.query('GRANT USAGE, CREATE ON SCHEMA public TO commander_app');
}

async function handAppTablesToAppRole(pool: Pool): Promise<void> {
  // Tables the API's own initSchema() manages must be owned by commander_app.
  // Freshly they are created by the API itself; when the kernel bootstrap ran
  // first, they exist as commander_owner and must be transferred.
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tableowner <> 'commander_app'
        AND tablename = ANY($1)`,
    [APP_TABLES],
  );
  for (const row of rows) {
    await pool.query(`ALTER TABLE public."${row.tablename}" OWNER TO commander_app`);
  }
}

async function main() {
  const pool = new Pool({
    host: '127.0.0.1',
    port: 5433,
    user: 'commander_owner',
    database: 'commander',
    max: 2,
  });

  console.log('[qa-schema] ensuring roles and schema grants…');
  await ensureRoles(pool);

  console.log('[qa-schema] running kernel migrations (baseline + forward)…');
  await runKernelMigrations(pool);
  console.log('[qa-schema] kernel migrations OK');

  console.log('[qa-schema] running task1 closure migrations (expand + enforce)…');
  await runTask1ClosureMigrations(pool, 'expand');
  await runTask1ClosureMigrations(pool, 'enforce');
  console.log('[qa-schema] task1 closure OK');

  // Second pass: with the canonical enforce closure in the ledger, the
  // migrator now admits the full KERNEL_MIGRATIONS set (task2, auth, memory).
  console.log('[qa-schema] running kernel migrations second pass (full set)…');
  await runKernelMigrations(pool);
  console.log('[qa-schema] full kernel migrations OK');

  console.log('[qa-schema] transferring API-managed tables to commander_app…');
  await handAppTablesToAppRole(pool);

  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM commander_kernel_migrations',
  );
  console.log(`[qa-schema] ledger rows: ${rows[0]?.count}`);
  console.log('[qa-schema] READY');
  await pool.end();
}

main().catch((err) => {
  console.error('QA schema bootstrap failed:', (err as Error).message);
  process.exit(1);
});
