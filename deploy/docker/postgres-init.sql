-- Bootstrap the Commander V2 Postgres roles before the migration job starts.
-- This script runs once as the bootstrap superuser (POSTGRES_USER) via the
-- /docker-entrypoint-initdb.d/ mechanism.

-- Migration owner: owns the schema, runs migrations, can bypass RLS.
-- CREATEROLE is required so the migration job can create/alter the auxiliary
-- kernel roles (commander_app, commander_scheduler) in the roles migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    CREATE ROLE commander_owner WITH LOGIN PASSWORD 'commander_owner' BYPASSRLS CREATEROLE;
  ELSE
    ALTER ROLE commander_owner WITH LOGIN BYPASSRLS CREATEROLE;
  END IF;
END $$;

-- Application role: used by API/worker replicas, subject to RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    CREATE ROLE commander_app WITH LOGIN PASSWORD 'commander_app' NOBYPASSRLS;
  ELSE
    ALTER ROLE commander_app WITH LOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Scheduler/recovery role: cross-tenant scans and recovery, BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_scheduler') THEN
    CREATE ROLE commander_scheduler WITH LOGIN PASSWORD 'commander_scheduler' BYPASSRLS;
  ELSE
    ALTER ROLE commander_scheduler WITH LOGIN BYPASSRLS;
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
