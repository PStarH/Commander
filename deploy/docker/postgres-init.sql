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
--   COMMANDER_OWNER_PASSWORD / COMMANDER_APP_PASSWORD / COMMANDER_SCHEDULER_PASSWORD /
--   COMMANDER_WORKER_PASSWORD
--
--   sed \
--     -e "s/__COMMANDER_OWNER_PASSWORD__/${COMMANDER_OWNER_PASSWORD}/g" \
--     -e "s/__COMMANDER_APP_PASSWORD__/${COMMANDER_APP_PASSWORD}/g" \
--     -e "s/__COMMANDER_SCHEDULER_PASSWORD__/${COMMANDER_SCHEDULER_PASSWORD}/g" \
--     -e "s/__COMMANDER_WORKER_PASSWORD__/${COMMANDER_WORKER_PASSWORD}/g" \
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

-- Worker/adapter-ops role: least-privilege runtime login for workers and
-- adapter-ops. Subject to RLS (NOBYPASSRLS), no CREATEROLE — DML only, granted
-- by the kernel roles migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    CREATE ROLE commander_worker WITH LOGIN PASSWORD '__COMMANDER_WORKER_PASSWORD__' NOBYPASSRLS NOCREATEROLE;
  ELSE
    ALTER ROLE commander_worker WITH LOGIN PASSWORD '__COMMANDER_WORKER_PASSWORD__' NOBYPASSRLS NOCREATEROLE;
  END IF;
END $$;

-- Grant the owner enough privileges to create and own the kernel schema.
GRANT ALL PRIVILEGES ON DATABASE commander TO commander_owner;
GRANT CREATE ON SCHEMA public TO commander_owner;
-- The owner must be able to re-grant these roles to itself in the roles migration.
GRANT commander_app TO commander_owner WITH ADMIN OPTION;
GRANT commander_scheduler TO commander_owner WITH ADMIN OPTION;
GRANT commander_worker TO commander_owner WITH ADMIN OPTION;

-- Application, scheduler, and worker roles still need to connect and use the schema.
-- Table-level privileges are granted by the kernel roles migration.
GRANT CONNECT ON DATABASE commander TO commander_app;
GRANT USAGE ON SCHEMA public TO commander_app;

GRANT CONNECT ON DATABASE commander TO commander_scheduler;
GRANT USAGE ON SCHEMA public TO commander_scheduler;

GRANT CONNECT ON DATABASE commander TO commander_worker;
GRANT USAGE ON SCHEMA public TO commander_worker;

-- Claim / worker-register RPC EXECUTE parity (functions created by kernel migrations).
-- Only commander_worker may EXECUTE claim/register RPCs; commander_app must not.
-- Claim secrets issue only via register_worker (not register_worker_claim_secret).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'claim_next_step'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION claim_next_step(text, bigint, integer, jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION claim_next_step(text, bigint, integer, jsonb) FROM commander_app;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
    BEGIN
      REVOKE ALL ON FUNCTION claim_next_step(text, bigint, integer, text, jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION claim_next_step(text, bigint, integer, text, jsonb) FROM commander_app;
      GRANT EXECUTE ON FUNCTION claim_next_step(text, bigint, integer, text, jsonb) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'claim_reconcile_effects'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer) FROM PUBLIC;
      REVOKE ALL ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer) FROM commander_app;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
    BEGIN
      REVOKE ALL ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) FROM commander_app;
      GRANT EXECUTE ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'claim_outbox_by_topic'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) FROM commander_app;
      GRANT EXECUTE ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'register_worker'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb) FROM PUBLIC;
      REVOKE ALL ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb) FROM commander_app;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
    BEGIN
      REVOKE ALL ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) FROM commander_app;
      GRANT EXECUTE ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'heartbeat_worker'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION heartbeat_worker(text, bigint, integer) FROM PUBLIC;
      REVOKE ALL ON FUNCTION heartbeat_worker(text, bigint, integer) FROM commander_app;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
    BEGIN
      REVOKE ALL ON FUNCTION heartbeat_worker(text, bigint, integer, text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION heartbeat_worker(text, bigint, integer, text) FROM commander_app;
      GRANT EXECUTE ON FUNCTION heartbeat_worker(text, bigint, integer, text) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'drain_worker'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION drain_worker(text, bigint) FROM PUBLIC;
      REVOKE ALL ON FUNCTION drain_worker(text, bigint) FROM commander_app;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
    BEGIN
      REVOKE ALL ON FUNCTION drain_worker(text, bigint, text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION drain_worker(text, bigint, text) FROM commander_app;
      GRANT EXECUTE ON FUNCTION drain_worker(text, bigint, text) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'claim_outbox_by_topic'
  ) THEN
    BEGIN
      REVOKE ALL ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) FROM PUBLIC;
      REVOKE ALL ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) FROM commander_app;
      GRANT EXECUTE ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) TO commander_worker;
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'register_worker_claim_secret'
  ) THEN
    REVOKE ALL ON FUNCTION register_worker_claim_secret(text, bigint, bytea) FROM PUBLIC;
    REVOKE ALL ON FUNCTION register_worker_claim_secret(text, bigint, bytea) FROM commander_app;
    REVOKE ALL ON FUNCTION register_worker_claim_secret(text, bigint, bytea) FROM commander_worker;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'commander_worker_claim_secrets'
  ) THEN
    REVOKE ALL ON TABLE commander_worker_claim_secrets FROM PUBLIC;
    REVOKE ALL ON TABLE commander_worker_claim_secrets FROM commander_app;
    REVOKE ALL ON TABLE commander_worker_claim_secrets FROM commander_worker;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_scheduler') THEN
      REVOKE ALL ON TABLE commander_worker_claim_secrets FROM commander_scheduler;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'commander_workers'
  ) THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE commander_workers FROM commander_worker;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'commander_outbox'
  ) THEN
    REVOKE DELETE ON TABLE commander_outbox FROM commander_worker;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'commander_runs'
  ) THEN
    REVOKE DELETE ON TABLE commander_runs FROM commander_worker;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'commander_events'
  ) THEN
    REVOKE DELETE ON TABLE commander_events FROM commander_worker;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'commander_action_kill_switches'
  ) THEN
    REVOKE DELETE ON TABLE commander_action_kill_switches FROM commander_worker;
  END IF;
END $$;

-- Demo seed: allow local cell tenant for register_worker (table may not exist until migrations).
-- Operators / Helm migration job seed cell tenants from worker.tenants after migrations.
