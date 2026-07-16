-- =============================================================================
-- WS9 live-fire PostgreSQL initialization.
-- File: deploy/docker/postgres-init.ws9-livefire.sql
--
-- Runs once as the bootstrap superuser (POSTGRES_USER=commander) via the
-- /docker-entrypoint-initdb.d/ mechanism. Provisions the isolated WS9
-- live-fire schema described in spec/ws9-tenant-livefire-compliance.md §3.1:
--   * commander_app — non-owner, non-superuser, non-createrole/createdb role
--     subject to RLS. This is the ONLY role the API and ws9-env-check may use.
--   * Test tables (runs, steps, memory_items, war_room_items, atr_run_ledger,
--     event_sourcing_log), each carrying tenant_id, owned by the bootstrap
--     role (NOT by commander_app) so RLS applies to commander_app.
--   * RLS enabled on every table with tenant_isolation policies carrying BOTH
--     USING and WITH CHECK (spec §3.1 rejection: "RLS 缺 WITH CHECK").
--   * Two real tenants (tenant-a, tenant-b) with sample rows.
--
-- Minimal grants only: CONNECT, USAGE on schema, SELECT/INSERT/UPDATE/DELETE
-- on tables. NO CREATE on schema. NO grants on pg_authid or system catalogs.
--
-- NOTE: This file is separate from the production deploy/docker/postgres-init.sql
-- so the WS9 live-fire test topology does not overwrite production role setup.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Roles
-- ---------------------------------------------------------------------------

-- commander_app: non-superuser, cannot create roles/DBs, RLS never bypassed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    CREATE ROLE commander_app
      WITH LOGIN PASSWORD 'commander_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    ALTER ROLE commander_app
      WITH LOGIN PASSWORD 'commander_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Minimal database + schema privileges. Explicitly NO CREATE on schema.
GRANT CONNECT ON DATABASE commander TO commander_app;
GRANT USAGE ON SCHEMA public TO commander_app;

-- ---------------------------------------------------------------------------
-- 2. Test tables (owned by the bootstrap superuser; commander_app is NOT owner)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  agent        TEXT,
  input        JSONB,
  output       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS steps (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  step_index   INTEGER NOT NULL,
  kind         TEXT,
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_items (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  run_id       TEXT,
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  embedding    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS war_room_items (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  run_id       TEXT,
  channel      TEXT NOT NULL,
  message      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS atr_run_ledger (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  state        TEXT NOT NULL,
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_sourcing_log (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  stream_id    TEXT NOT NULL,
  seq          BIGINT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Row Level Security: ENABLE + tenant_isolation policy (USING + WITH CHECK).
--    Fail-closed: if app.tenant_id is unset, current_setting(...,true) is NULL
--    and `tenant_id = NULL` yields NULL -> no rows visible/writable.
-- ---------------------------------------------------------------------------

ALTER TABLE runs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE steps              ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE war_room_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE atr_run_ledger     ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_sourcing_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON runs
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON steps
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON memory_items
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON war_room_items
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON atr_run_ledger
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON event_sourcing_log
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- 4. Minimal DML grants to commander_app (still subject to RLS).
--    No CREATE, no system-catalog grants, no pg_authid.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON
  runs, steps, memory_items, war_room_items, atr_run_ledger, event_sourcing_log
  TO commander_app;

-- Sequence usage so INSERT into event_sourcing_log (BIGSERIAL) works.
GRANT USAGE, SELECT ON SEQUENCE event_sourcing_log_id_seq TO commander_app;

-- ---------------------------------------------------------------------------
-- 5. Test tenants: tenant-a and tenant-b with sample data
-- ---------------------------------------------------------------------------

INSERT INTO runs (id, tenant_id, status, agent, input) VALUES
  ('run-a-1', 'tenant-a', 'completed', 'researcher', '{"q":"alpha"}'::jsonb),
  ('run-a-2', 'tenant-a', 'running',   'planner',    '{"q":"alpha2"}'::jsonb),
  ('run-b-1', 'tenant-b', 'completed', 'researcher', '{"q":"beta"}'::jsonb),
  ('run-b-2', 'tenant-b', 'failed',    'planner',    '{"q":"beta2"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO steps (id, tenant_id, run_id, step_index, kind) VALUES
  ('step-a-1', 'tenant-a', 'run-a-1', 0, 'tool'),
  ('step-a-2', 'tenant-a', 'run-a-1', 1, 'llm'),
  ('step-b-1', 'tenant-b', 'run-b-1', 0, 'tool'),
  ('step-b-2', 'tenant-b', 'run-b-1', 1, 'llm')
ON CONFLICT (id) DO NOTHING;

INSERT INTO memory_items (id, tenant_id, run_id, kind, content) VALUES
  ('mem-a-1', 'tenant-a', 'run-a-1', 'fact',       'tenant-a secret fact'),
  ('mem-a-2', 'tenant-a', 'run-a-1', 'preference', 'tenant-a prefers concise'),
  ('mem-b-1', 'tenant-b', 'run-b-1', 'fact',       'tenant-b secret fact'),
  ('mem-b-2', 'tenant-b', 'run-b-1', 'preference', 'tenant-b prefers verbose')
ON CONFLICT (id) DO NOTHING;

INSERT INTO war_room_items (id, tenant_id, run_id, channel, message) VALUES
  ('wr-a-1', 'tenant-a', 'run-a-1', 'ops', 'tenant-a ops event'),
  ('wr-b-1', 'tenant-b', 'run-b-1', 'ops', 'tenant-b ops event')
ON CONFLICT (id) DO NOTHING;

INSERT INTO atr_run_ledger (id, tenant_id, run_id, attempt, state) VALUES
  ('atr-a-1', 'tenant-a', 'run-a-1', 1, 'succeeded'),
  ('atr-b-1', 'tenant-b', 'run-b-1', 1, 'succeeded')
ON CONFLICT (id) DO NOTHING;

INSERT INTO event_sourcing_log (tenant_id, stream_id, seq, event_type, payload) VALUES
  ('tenant-a', 'run-a-1', 1, 'run.started',   '{"by":"tenant-a"}'::jsonb),
  ('tenant-a', 'run-a-1', 2, 'run.completed', '{"by":"tenant-a"}'::jsonb),
  ('tenant-b', 'run-b-1', 1, 'run.started',   '{"by":"tenant-b"}'::jsonb),
  ('tenant-b', 'run-b-1', 2, 'run.failed',    '{"by":"tenant-b"}'::jsonb);
