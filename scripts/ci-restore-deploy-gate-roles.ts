import { Pool } from 'pg';

const adminDsn = process.env.DATABASE_URL?.trim();
if (!adminDsn) throw new Error('DATABASE_URL_REQUIRED_FOR_CI_ROLE_RESTORE');

const pool = new Pool({ connectionString: adminDsn, max: 1 });

async function main(): Promise<void> {
  try {
    await pool.query(`
      BEGIN;
      DO $do$
      BEGIN
        IF (
          SELECT count(*)
          FROM pg_catalog.pg_roles
          WHERE rolname = ANY(ARRAY[
            'commander_owner',
            'commander_app',
            'commander_tenant_authority',
            'commander_scheduler',
            'commander_worker',
            'commander_adapter_ops'
          ])
        ) <> 6 THEN
          RAISE EXCEPTION 'CI_DEPLOY_GATE_ROLE_RESTORE_INCOMPLETE';
        END IF;
      END $do$;
      ALTER ROLE commander_owner LOGIN NOSUPERUSER NOCREATEDB CREATEROLE INHERIT
        NOREPLICATION BYPASSRLS PASSWORD 'commander_owner';
      ALTER ROLE commander_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS PASSWORD 'commander_app';
      ALTER ROLE commander_tenant_authority LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS PASSWORD 'commander_tenant_authority';
      ALTER ROLE commander_scheduler LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION BYPASSRLS PASSWORD 'commander_scheduler';
      ALTER ROLE commander_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS PASSWORD 'commander_worker';
      ALTER ROLE commander_adapter_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
        NOREPLICATION NOBYPASSRLS PASSWORD 'commander_adapter_ops';
      COMMIT;
    `);
    console.log('CI deploy-gate runtime roles restored');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
