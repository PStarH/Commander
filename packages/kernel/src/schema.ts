/** PostgreSQL schema for the Commander execution kernel. */
export const KERNEL_SCHEMA_VERSION = '2026-07-21.1';

export const KERNEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commander_kernel_schema (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commander_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  work_graph_hash TEXT NOT NULL,
  work_graph_version TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED','COMPENSATING','COMPENSATED')),
  version BIGINT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS commander_runs_tenant_state_idx ON commander_runs (tenant_id, state, created_at);

CREATE TABLE IF NOT EXISTS commander_tenant_execution_limits (
  tenant_id TEXT PRIMARY KEY,
  max_concurrent_steps INTEGER NOT NULL CHECK (max_concurrent_steps > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A shared tenant usage row is locked during claims, making quotas global to
-- all schedulers rather than merely local to an individual worker pod.
CREATE TABLE IF NOT EXISTS commander_tenant_execution_usage (
  tenant_id TEXT PRIMARY KEY,
  running_steps INTEGER NOT NULL DEFAULT 0 CHECK (running_steps >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commander_tenant_execution_control (
  tenant_id TEXT PRIMARY KEY,
  paused BOOLEAN NOT NULL DEFAULT false,
  generation BIGINT NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  reason TEXT,
  paused_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO commander_tenant_execution_control (tenant_id, actor)
SELECT DISTINCT tenant_id, 'kernel.migration'
FROM commander_runs
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS commander_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','WAITING_FOR_HUMAN','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
  version BIGINT NOT NULL DEFAULT 1,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  dependencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error JSONB,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_worker_id TEXT,
  lease_worker_generation BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  fencing_epoch BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES commander_runs(id, tenant_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS commander_steps_claim_idx ON commander_steps (tenant_id, state, scheduled_at, priority DESC);
CREATE INDEX IF NOT EXISTS commander_steps_run_idx ON commander_steps (run_id, tenant_id);
ALTER TABLE commander_steps ADD COLUMN IF NOT EXISTS lease_worker_generation BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS commander_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT,
  causation_id TEXT,
  correlation_id TEXT,
  actor TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, sequence)
);
CREATE INDEX IF NOT EXISTS commander_events_run_idx ON commander_events (run_id, tenant_id, occurred_at, sequence);

CREATE TABLE IF NOT EXISTS commander_effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  policy_decision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ADMITTED','COMPLETION_UNKNOWN','COMPLETED','FAILED')),
  request JSONB NOT NULL DEFAULT '{}'::jsonb,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key)
);
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS request_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE commander_effects DROP CONSTRAINT IF EXISTS commander_effects_state_check;
ALTER TABLE commander_effects ADD CONSTRAINT commander_effects_state_check CHECK (state IN ('ADMITTED','COMPLETION_UNKNOWN','COMPLETED','FAILED'));
-- L3-08a / L4 reconcile scheduling (aligned with sqliteSchema)
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_after TIMESTAMPTZ;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_claim_token TEXT;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_claim_expires_at TIMESTAMPTZ;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_error TEXT;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_escalated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS commander_effects_reconcile_ready_idx
  ON commander_effects (reconcile_after)
  WHERE state = 'COMPLETION_UNKNOWN';

-- The worker registry is part of the kernel's fencing authority. The worker
-- plane also creates this table defensively, but kernel claims must validate
-- the generation in the same shared database.
CREATE TABLE IF NOT EXISTS commander_workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DRAINING','OFFLINE')),
  generation BIGINT NOT NULL DEFAULT 0,
  active_steps INTEGER NOT NULL DEFAULT 0 CHECK (active_steps >= 0),
  identity_subject TEXT NOT NULL,
  tenant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commander_workers_active_idx ON commander_workers (status, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS commander_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES commander_events(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commander_outbox_ready_idx ON commander_outbox (available_at, created_at) WHERE published_at IS NULL;
ALTER TABLE commander_outbox ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
UPDATE commander_outbox SET tenant_id = COALESCE(payload->>'tenantId', 'system') WHERE tenant_id = 'system';

CREATE TABLE IF NOT EXISTS commander_outbox_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumer_id TEXT,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  last_error JSONB,
  moved_to_dlq_at TIMESTAMPTZ,
  dlq_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commander_outbox_deliveries_ready_idx
  ON commander_outbox_deliveries (available_at, created_at)
  WHERE acknowledged_at IS NULL AND moved_to_dlq_at IS NULL;

-- ── Durable timers ─────────────────────────────────────────────────────────
-- Durable timers allow steps to enter WAITING_FOR_HUMAN or schedule a delayed
-- retry. A background wakeup worker scans for expired timers and transitions
-- the associated step back to PENDING or RETRY_WAIT.
CREATE TABLE IF NOT EXISTS commander_timers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  fires_at TIMESTAMPTZ NOT NULL,
  timer_type TEXT NOT NULL CHECK (timer_type IN ('INTERACTION_TIMEOUT','RETRY_DELAY','STEP_DEADLINE')),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','FIRED','CANCELLED')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at TIMESTAMPTZ,
  claim_token TEXT,
  claimed_at TIMESTAMPTZ
);
ALTER TABLE commander_timers ADD COLUMN IF NOT EXISTS claim_token TEXT;
ALTER TABLE commander_timers ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE commander_timers DROP CONSTRAINT IF EXISTS commander_timers_state_check;
ALTER TABLE commander_timers ADD CONSTRAINT commander_timers_state_check
  CHECK (state IN ('PENDING','PROCESSING','FIRED','CANCELLED'));
CREATE INDEX IF NOT EXISTS commander_timers_fire_idx ON commander_timers (fires_at, state) WHERE state = 'PENDING';

-- ── Interactions ───────────────────────────────────────────────────────────
-- Interactions represent human-agent collaboration points. A step enters
-- WAITING_FOR_HUMAN and an interaction record is created. When the human
-- responds (or the interaction times out), the step resumes.
CREATE TABLE IF NOT EXISTS commander_interactions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','expired','cancelled')),
  prompt TEXT NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commander_interactions_run_idx ON commander_interactions (run_id, tenant_id);
CREATE INDEX IF NOT EXISTS commander_interactions_pending_idx ON commander_interactions (tenant_id, status) WHERE status = 'pending';

-- ── Outbox DLQ ─────────────────────────────────────────────────────────────
-- Messages that exceed max_attempts are moved to the dead-letter queue for
-- manual inspection and replay. Exponential backoff is applied to available_at
-- on each retry: available_at = now() + (2^attempts * base_delay).
ALTER TABLE commander_outbox ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 10;
ALTER TABLE commander_outbox ADD COLUMN IF NOT EXISTS dlq_reason TEXT;
ALTER TABLE commander_outbox ADD COLUMN IF NOT EXISTS moved_to_dlq_at TIMESTAMPTZ;
ALTER TABLE commander_outbox ADD COLUMN IF NOT EXISTS last_error JSONB;

CREATE TABLE IF NOT EXISTS commander_outbox_dlq (
  id TEXT PRIMARY KEY,
  original_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts INTEGER NOT NULL,
  dlq_reason TEXT,
  original_created_at TIMESTAMPTZ NOT NULL,
  moved_to_dlq_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DELETE FROM commander_outbox_dlq newer
USING commander_outbox_dlq older
WHERE newer.original_id = older.original_id
  AND (newer.moved_to_dlq_at, newer.id) > (older.moved_to_dlq_at, older.id);
CREATE UNIQUE INDEX IF NOT EXISTS commander_outbox_dlq_original_idx
  ON commander_outbox_dlq (original_id);
CREATE INDEX IF NOT EXISTS commander_outbox_dlq_topic_idx ON commander_outbox_dlq (topic, moved_to_dlq_at);
ALTER TABLE commander_outbox_dlq ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

-- ── WS2 EffectBroker monopoly: effect ledger extensions + policy tables ─────
-- Track the policy snapshot and lease fencing on each effect so the broker
-- can verify pin consistency and lease authority after admit().
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS policy_snapshot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS lease_worker_id TEXT;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS lease_fencing_epoch INTEGER;

-- Operation allowlist. Per-tenant, per-action-pattern. Wildcards supported
-- (e.g. 'http.*', 'compensate.*'). admit() rejects actions not in this list.
CREATE TABLE IF NOT EXISTS commander_effect_allowlist (
  tenant_id TEXT NOT NULL,
  action_pattern TEXT NOT NULL,
  allowed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, action_pattern)
);

-- Daily tenant quota per action class (http/llm/compensate/tool/connector).
-- The broker increments count_used (and tokens_used for llm) on each admitted effect.
CREATE TABLE IF NOT EXISTS commander_effect_quota (
  tenant_id TEXT NOT NULL,
  action_class TEXT NOT NULL,
  day DATE NOT NULL,
  count_used INTEGER NOT NULL DEFAULT 0,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, action_class, day)
);

-- Capability token revocations. The broker's CapabilityTokenVerifier
-- queries this on every admit(). Rows expire at expires_at and may be swept.
CREATE TABLE IF NOT EXISTS commander_capability_revocations (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx ON commander_capability_revocations (expires_at);

-- L4-04 six-dimensional kill-switch matrix. enabled=false records intent without blocking.
CREATE TABLE IF NOT EXISTS commander_action_kill_switches (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  actor TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, value)
);
`;

/**
 * Tenant isolation policies for deployments where the kernel DB role is not a
 * superuser/table owner. The application sets app.tenant_scope for each
 * request/transaction; '*' is reserved for trusted scheduler/recovery roles.
 *
 * Design:
 *   - FORCE ROW LEVEL SECURITY: even the table owner must pass the policy.
 *   - USING + WITH CHECK: reads and writes are both filtered by tenant scope.
 *   - commander_scheduler role has BYPASSRLS attribute and is used only by the
 *     scheduler/recovery job, not by API request handlers.
 *   - commander_app role is the least-privilege role used by API replicas.
 *   - No '*'-scope bypass in the policy: cross-tenant access is granted only
 *     through the BYPASSRLS scheduler role, not through a magic string.
 */
export const KERNEL_RLS_SQL = `
DO $$
DECLARE
  table_name TEXT;
BEGIN
  -- Tenant-scoped tables: isolation by tenant_id column.
  FOREACH table_name IN ARRAY ARRAY[
    'commander_runs', 'commander_steps', 'commander_events',
    'commander_effects', 'commander_tenant_execution_limits',
    'commander_tenant_execution_usage', 'commander_tenant_execution_control', 'commander_timers',
    'commander_interactions', 'commander_outbox', 'commander_outbox_deliveries', 'commander_outbox_dlq',
    'commander_effect_allowlist', 'commander_effect_quota',
    'commander_capability_revocations', 'commander_action_kill_switches'
  ] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS commander_tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY commander_tenant_isolation ON %I '
      'FOR ALL '
      'TO PUBLIC '
      'USING (tenant_id = ANY(string_to_array(current_setting(''app.tenant_scope'', true), '',''))) '
      'WITH CHECK (tenant_id = ANY(string_to_array(current_setting(''app.tenant_scope'', true), '','')))',
      table_name
    );
  END LOOP;

  -- Workers table: isolation by tenant_ids JSONB array (a worker may serve many tenants).
  ALTER TABLE commander_workers FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS commander_tenant_isolation ON commander_workers;
  CREATE POLICY commander_tenant_isolation ON commander_workers
    FOR ALL TO PUBLIC
    USING (tenant_ids ?| string_to_array(current_setting('app.tenant_scope', true), ','))
    WITH CHECK (tenant_ids ?| string_to_array(current_setting('app.tenant_scope', true), ','));
END $$;
`;

/**
 * Role definitions for least-privilege kernel access.
 *
 * - commander_owner (migration owner): creates/owns tables, runs migrations.
 * - commander_app: least-privilege role for API replicas; subject to RLS.
 * - commander_scheduler: used by scheduler/recovery jobs; has BYPASSRLS
 *   but is still restricted at the application layer to a controlled tenant set.
 */
export const KERNEL_ROLES_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    CREATE ROLE commander_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_scheduler') THEN
    CREATE ROLE commander_scheduler NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    CREATE ROLE commander_app NOLOGIN;
  END IF;
END $$;

-- Owner role: runs migrations, owns tables, can read the migrations table.
-- In production this is a dedicated superuser/owner account, not used by API replicas.
-- The BYPASSRLS bit is only settable by superusers; in Docker deployments the
-- bootstrap init script already grants it, so we skip the statement otherwise.
DO $$
BEGIN
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    ALTER ROLE commander_owner BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO commander_owner;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO commander_owner;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO commander_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO commander_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO commander_owner;
GRANT commander_app TO commander_owner;
GRANT commander_scheduler TO commander_owner;

-- App role: least-privilege DML only. Cannot alter schema or bypass RLS.
GRANT USAGE ON SCHEMA public TO commander_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO commander_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO commander_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commander_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO commander_app;

-- Scheduler role: can bypass RLS for cross-tenant recovery and scanning.
-- It must still be explicitly opted into via PostgresKernelRepositoryOptions.schedulerMode.
DO $$
BEGIN
  IF (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
    ALTER ROLE commander_scheduler BYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO commander_scheduler;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO commander_scheduler;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO commander_scheduler;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commander_scheduler;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO commander_scheduler;
`;
