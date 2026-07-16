-- Bootstrap the Commander V2 Postgres roles before the migration job starts.
-- This script runs once as the bootstrap superuser (POSTGRES_USER) via the
-- /docker-entrypoint-initdb.d/ mechanism.
--
-- =============================================================================
-- SECURITY — passwords and privilege model
-- =============================================================================
-- NEVER ship default role passwords to production.
-- PostgreSQL .sql init files cannot expand ${ENV}. Before first boot, substitute
-- the placeholders below (or generate this file from a secret manager), e.g.:
--
--   COMMANDER_OWNER_PASSWORD / COMMANDER_APP_PASSWORD / COMMANDER_SCHEDULER_PASSWORD
--
--   sed \
--     -e "s/__COMMANDER_OWNER_PASSWORD__/${COMMANDER_OWNER_PASSWORD}/g" \
--     -e "s/__COMMANDER_APP_PASSWORD__/${COMMANDER_APP_PASSWORD}/g" \
--     -e "s/__COMMANDER_SCHEDULER_PASSWORD__/${COMMANDER_SCHEDULER_PASSWORD}/g" \
--     postgres-init.sql | psql ...
--
-- After migrations complete, long-running API/worker processes MUST connect as
-- commander_app (RLS-enforced). Do NOT use commander_owner as a runtime identity:
-- BYPASSRLS + CREATEROLE are migration/bootstrap privileges only.
-- =============================================================================

-- Migration owner: owns the schema, runs migrations.
-- BYPASSRLS: needed so migrations can seed/alter RLS-protected tables.
-- CREATEROLE: needed so the roles migration can create/alter commander_app /
-- commander_scheduler. Revoke CREATEROLE from this role after migrations if
-- your ops policy requires a tighter bootstrap account.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    CREATE ROLE commander_owner WITH LOGIN PASSWORD '__COMMANDER_OWNER_PASSWORD__' BYPASSRLS CREATEROLE;
  ELSE
    ALTER ROLE commander_owner WITH LOGIN PASSWORD '__COMMANDER_OWNER_PASSWORD__' BYPASSRLS CREATEROLE;
  END IF;
END $$;

-- Application role: used by API/worker replicas at runtime, subject to RLS.
-- NOBYPASSRLS / no CREATEROLE — this is the long-running identity.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    CREATE ROLE commander_app WITH LOGIN PASSWORD '__COMMANDER_APP_PASSWORD__' NOBYPASSRLS NOCREATEROLE;
  ELSE
    ALTER ROLE commander_app WITH LOGIN PASSWORD '__COMMANDER_APP_PASSWORD__' NOBYPASSRLS NOCREATEROLE;
  END IF;
END $$;

-- Scheduler/recovery role: cross-tenant scans and recovery only.
-- BYPASSRLS without CREATEROLE — not a general-purpose runtime login for apps.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_scheduler') THEN
    CREATE ROLE commander_scheduler WITH LOGIN PASSWORD '__COMMANDER_SCHEDULER_PASSWORD__' BYPASSRLS NOCREATEROLE;
  ELSE
    ALTER ROLE commander_scheduler WITH LOGIN PASSWORD '__COMMANDER_SCHEDULER_PASSWORD__' BYPASSRLS NOCREATEROLE;
  END IF;
END $$;

-- Grant the owner enough privileges to create and own the kernel schema.
GRANT ALL PRIVILEGES ON DATABASE commander TO commander_owner;
GRANT CREATE ON SCHEMA public TO commander_owner;
-- The owner must be able to re-grant these roles to itself in the roles migration.
GRANT commander_app TO commander_owner WITH ADMIN OPTION;
GRANT commander_scheduler TO commander_owner WITH ADMIN OPTION;

-- Application and scheduler roles still need to connect and use the schema.
-- Table-level privileges are granted by the kernel roles migration.
GRANT CONNECT ON DATABASE commander TO commander_app;
GRANT USAGE ON SCHEMA public TO commander_app;

GRANT CONNECT ON DATABASE commander TO commander_scheduler;
GRANT USAGE ON SCHEMA public TO commander_scheduler;
