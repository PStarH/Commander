/** PostgreSQL schema for the Commander execution kernel. */
export const KERNEL_SCHEMA_VERSION = '2026-07-21.16';

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
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_error JSONB;
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
-- Track the policy snapshot, action digest, and lease fencing on each effect
-- so the broker can verify pin consistency and lease authority after admit().
-- Task 2: required NOT NULL columns + safe backfill for legacy rows.
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS policy_snapshot_id TEXT NOT NULL DEFAULT '';
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS lease_worker_id TEXT;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS lease_fencing_epoch INTEGER;
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS action_digest TEXT NOT NULL DEFAULT '';
ALTER TABLE commander_effects ADD COLUMN IF NOT EXISTS lease_worker_generation BIGINT NOT NULL DEFAULT 0;

-- Align sibling lease columns with required KernelEffect fields (same task)
UPDATE commander_effects
SET lease_worker_id = COALESCE(lease_worker_id, 'legacy-unbound'),
    lease_fencing_epoch = COALESCE(lease_fencing_epoch, 0),
    lease_worker_generation = COALESCE(lease_worker_generation, 0)
WHERE lease_worker_id IS NULL
   OR lease_fencing_epoch IS NULL;

ALTER TABLE commander_effects ALTER COLUMN lease_worker_id SET DEFAULT 'legacy-unbound';
ALTER TABLE commander_effects ALTER COLUMN lease_worker_id SET NOT NULL;
ALTER TABLE commander_effects ALTER COLUMN lease_fencing_epoch SET DEFAULT 0;
ALTER TABLE commander_effects ALTER COLUMN lease_fencing_epoch SET NOT NULL;
-- lease_worker_generation already NOT NULL DEFAULT 0 from ADD COLUMN

UPDATE commander_effects
SET policy_snapshot_id = 'legacy-unbound',
    action_digest = CASE WHEN action_digest = '' THEN request_hash ELSE action_digest END
WHERE policy_snapshot_id = '' OR action_digest = '';

ALTER TABLE commander_effects ALTER COLUMN policy_snapshot_id DROP DEFAULT;
ALTER TABLE commander_effects ALTER COLUMN action_digest DROP DEFAULT;
-- Drop the lease_worker_id default too (mirrors policy_snapshot_id above): the
-- backfill above already bound every legacy NULL row; admitEffect() always
-- supplies a real lease.workerId, so no NEW admit may ever silently invent
-- 'legacy-unbound' by omitting the column.
ALTER TABLE commander_effects ALTER COLUMN lease_worker_id DROP DEFAULT;

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
-- PK is tenant-scoped (tenant_id, jti): same jti may exist across tenants without
-- colliding, and RLS policies isolate revoke observe by tenant_id.
CREATE TABLE IF NOT EXISTS commander_capability_revocations (
  tenant_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  PRIMARY KEY (tenant_id, jti)
);
CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx ON commander_capability_revocations (expires_at);

-- Migrate legacy global-jti PK → tenant-scoped composite PK (idempotent).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'commander_capability_revocations'
      AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (jti)'
  ) THEN
    ALTER TABLE commander_capability_revocations DROP CONSTRAINT commander_capability_revocations_pkey;
    DELETE FROM commander_capability_revocations a
      USING commander_capability_revocations b
     WHERE a.ctid < b.ctid
       AND a.tenant_id = b.tenant_id
       AND a.jti = b.jti;
    ALTER TABLE commander_capability_revocations
      ADD CONSTRAINT commander_capability_revocations_pkey PRIMARY KEY (tenant_id, jti);
  END IF;
END $$;

-- Capability (jti, nonce) replay consumption. Atomic INSERT under tenant RLS;
-- conflict means the token identity was already consumed (cross-process durable).
CREATE TABLE IF NOT EXISTS commander_capability_replays (
  tenant_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, jti, nonce)
);
CREATE INDEX IF NOT EXISTS commander_capability_replays_exp_idx ON commander_capability_replays (expires_at);

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
/**
 * Tenant-scoped tables isolated by a `tenant_id` column. These all receive the
 * same tenant_id-based RLS policy.
 */
export const TENANT_ID_TABLES = [
  'commander_runs',
  'commander_steps',
  'commander_events',
  'commander_effects',
  'commander_tenant_execution_limits',
  'commander_tenant_execution_usage',
  'commander_tenant_execution_control',
  'commander_timers',
  'commander_interactions',
  'commander_outbox',
  'commander_outbox_deliveries',
  'commander_outbox_dlq',
  'commander_effect_allowlist',
  'commander_effect_quota',
  'commander_capability_revocations',
  'commander_capability_replays',
  'commander_action_kill_switches',
] as const;

/**
 * Every table that must have RLS both ENABLED and FORCED. `commander_workers`
 * uses a JSONB tenant_ids policy but still requires row security to be active.
 * Catalog assertions iterate this list to prove no tenant table ships without RLS.
 */
export const TENANT_TABLES = [...TENANT_ID_TABLES, 'commander_workers'] as const;

const TENANT_ID_TABLES_SQL_ARRAY = TENANT_ID_TABLES.map((name) => `'${name}'`).join(', ');

export const KERNEL_RLS_SQL = `
-- Allowlist must exist before worker-scoped RLS policies reference it.
CREATE TABLE IF NOT EXISTS commander_worker_allowed_tenants (
  tenant_id TEXT PRIMARY KEY CHECK (tenant_id <> '' AND tenant_id <> '*'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  -- Tenant-scoped tables: isolation by tenant_id column.
  -- commander_worker LOGIN: tenant_scope alone is insufficient — each tenant_id
  -- must also appear in commander_worker_allowed_tenants (cell allowlist).
  -- App LOGIN keeps tenant_scope-only. SECURITY DEFINER RPCs run as owner
  -- (BYPASSRLS) and are unaffected.
  FOREACH table_name IN ARRAY ARRAY[
    ${TENANT_ID_TABLES_SQL_ARRAY}
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS commander_tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY commander_tenant_isolation ON %I '
      'FOR ALL '
      'TO PUBLIC '
      'USING ('
      '  tenant_id = ANY(string_to_array(current_setting(''app.tenant_scope'', true), '','')) '
      '  AND ('
      '    current_user IS DISTINCT FROM ''commander_worker'' '
      '    OR EXISTS (SELECT 1 FROM commander_worker_allowed_tenants a WHERE a.tenant_id = %I.tenant_id)'
      '  )'
      ') '
      'WITH CHECK ('
      '  tenant_id = ANY(string_to_array(current_setting(''app.tenant_scope'', true), '','')) '
      '  AND ('
      '    current_user IS DISTINCT FROM ''commander_worker'' '
      '    OR EXISTS (SELECT 1 FROM commander_worker_allowed_tenants a WHERE a.tenant_id = %I.tenant_id)'
      '  )'
      ')',
      table_name, table_name, table_name
    );
  END LOOP;

  -- Workers table: isolation by tenant_ids JSONB array (a worker may serve many tenants).
  -- Worker LOGIN still cannot DML this table (REVOKE); policy kept for SELECT consistency.
  ALTER TABLE commander_workers ENABLE ROW LEVEL SECURITY;
  ALTER TABLE commander_workers FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS commander_tenant_isolation ON commander_workers;
  CREATE POLICY commander_tenant_isolation ON commander_workers
    FOR ALL TO PUBLIC
    USING (
      tenant_ids ?| string_to_array(current_setting('app.tenant_scope', true), ',')
      AND (
        current_user IS DISTINCT FROM 'commander_worker'
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(tenant_ids) AS t(tenant_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM commander_worker_allowed_tenants a WHERE a.tenant_id = t.tenant_id
          )
        )
      )
    )
    WITH CHECK (
      tenant_ids ?| string_to_array(current_setting('app.tenant_scope', true), ',')
      AND (
        current_user IS DISTINCT FROM 'commander_worker'
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(tenant_ids) AS t(tenant_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM commander_worker_allowed_tenants a WHERE a.tenant_id = t.tenant_id
          )
        )
      )
    );
END $$;
`;

/**
 * Role definitions for least-privilege kernel access.
 *
 * - commander_owner (migration owner): creates/owns tables, runs migrations.
 * - commander_app: least-privilege role for API replicas; subject to RLS.
 * - commander_scheduler: used by scheduler/recovery jobs; has BYPASSRLS
 *   but is still restricted at the application layer to a controlled tenant set.
 * - commander_worker: least-privilege runtime role for workers/adapter-ops;
 *   subject to RLS (no BYPASSRLS), minimum DML for claims/effects/heartbeats/
 *   interactions, and no DDL/role-management/migration authority.
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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    CREATE ROLE commander_worker NOLOGIN;
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
GRANT commander_worker TO commander_owner;

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

-- Worker role: least-privilege DML only, subject to RLS. Used by workers and
-- adapter-ops for claims, effects, heartbeats, and interactions. It must never
-- bypass RLS, own tables, manage roles, or run migrations.
-- Durable worker authz rows are mutated only via SECURITY DEFINER RPCs
-- (register_worker / heartbeat_worker / drain_worker) — not direct DML.
GRANT USAGE ON SCHEMA public TO commander_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO commander_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO commander_worker;
-- Future tables: no blind DELETE (narrow default write surface).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO commander_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO commander_worker;

-- P0: worker LOGIN must not self-mint durable claim authority.
REVOKE INSERT, UPDATE, DELETE ON TABLE commander_workers FROM commander_worker;
-- Keep SELECT for RLS-scoped reads (get); writes go through DEFINER RPCs.

-- Capability revoke/replay — no DELETE (tombstones via INSERT only).
REVOKE DELETE ON TABLE commander_capability_revocations FROM commander_worker;
REVOKE DELETE ON TABLE commander_capability_replays FROM commander_worker;
-- Worker LOGIN must not erase audit / control / outbox rows (UPDATE-only lifecycle).
REVOKE DELETE ON TABLE commander_runs FROM commander_worker;
REVOKE DELETE ON TABLE commander_steps FROM commander_worker;
REVOKE DELETE ON TABLE commander_events FROM commander_worker;
REVOKE DELETE ON TABLE commander_effects FROM commander_worker;
REVOKE DELETE ON TABLE commander_timers FROM commander_worker;
REVOKE DELETE ON TABLE commander_interactions FROM commander_worker;
REVOKE DELETE ON TABLE commander_outbox FROM commander_worker;
REVOKE DELETE ON TABLE commander_outbox_deliveries FROM commander_worker;
REVOKE DELETE ON TABLE commander_outbox_dlq FROM commander_worker;
REVOKE DELETE ON TABLE commander_effect_allowlist FROM commander_worker;
REVOKE DELETE ON TABLE commander_effect_quota FROM commander_worker;
REVOKE DELETE ON TABLE commander_action_kill_switches FROM commander_worker;
REVOKE DELETE ON TABLE commander_tenant_execution_control FROM commander_worker;
REVOKE DELETE ON TABLE commander_tenant_execution_usage FROM commander_worker;
REVOKE DELETE ON TABLE commander_tenant_execution_limits FROM commander_worker;
`;

/**
 * Unforgeable claim-secret + worker registration authority (P0 / P1-A).
 *
 * - Hash only in commander_worker_claim_secrets — plaintext never persisted.
 * - Secrets table has NO SELECT/DML for app/worker/scheduler.
 * - commander_worker_allowed_tenants is owner/migration-written only; register_worker
 *   rejects any tenant_id not present (and rejects '*').
 * - Worker LOGIN cannot INSERT/UPDATE workers; must call register_worker /
 *   heartbeat_worker / drain_worker (SECURITY DEFINER, owner-owned).
 * - register_worker issues the claim secret server-side and returns plaintext once.
 */
export const KERNEL_CLAIM_SECRET_SQL = `
CREATE TABLE IF NOT EXISTS commander_worker_claim_secrets (
  worker_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL,
  secret_hash BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cell-scoped allowlist: only these tenant_ids may appear on durable worker rows.
CREATE TABLE IF NOT EXISTS commander_worker_allowed_tenants (
  tenant_id TEXT PRIMARY KEY CHECK (tenant_id <> '' AND tenant_id <> '*'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defense in depth: revoke even if DEFAULT PRIVILEGES already granted DML.
REVOKE ALL ON TABLE commander_worker_claim_secrets FROM PUBLIC;
REVOKE ALL ON TABLE commander_worker_allowed_tenants FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    REVOKE ALL ON TABLE commander_worker_claim_secrets FROM commander_app;
    REVOKE INSERT, UPDATE, DELETE ON TABLE commander_worker_allowed_tenants FROM commander_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    REVOKE ALL ON TABLE commander_worker_claim_secrets FROM commander_worker;
    REVOKE INSERT, UPDATE, DELETE ON TABLE commander_worker_allowed_tenants FROM commander_worker;
    -- Idempotent with roles migration: workers write only via DEFINER RPCs.
    REVOKE INSERT, UPDATE, DELETE ON TABLE commander_workers FROM commander_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_scheduler') THEN
    REVOKE ALL ON TABLE commander_worker_claim_secrets FROM commander_scheduler;
    REVOKE INSERT, UPDATE, DELETE ON TABLE commander_worker_allowed_tenants FROM commander_scheduler;
  END IF;
END $$;
-- Optional SELECT on allowlist (introspection); writes remain owner-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    GRANT SELECT ON TABLE commander_worker_allowed_tenants TO commander_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    GRANT SELECT ON TABLE commander_worker_allowed_tenants TO commander_app;
  END IF;
END $$;

-- Internal helper: store hash for (worker_id, generation). Not granted to worker LOGIN.
CREATE OR REPLACE FUNCTION register_worker_claim_secret(
  p_worker_id text,
  p_generation bigint,
  p_secret_hash bytea
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_status text;
  v_generation bigint;
  v_existing_generation bigint;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RETURN false;
  END IF;
  IF p_generation IS NULL OR p_generation < 0 THEN
    RETURN false;
  END IF;
  IF p_secret_hash IS NULL OR octet_length(p_secret_hash) <> 32 THEN
    RETURN false;
  END IF;

  -- Serialize first-write / generation rotation per worker_id (shared LOGIN race).
  PERFORM pg_advisory_xact_lock(hashtext('commander_worker_claim_secret:' || p_worker_id));

  SELECT w.status, w.generation
    INTO v_status, v_generation
  FROM commander_workers w
  WHERE w.id = p_worker_id;

  IF NOT FOUND
     OR v_status IS DISTINCT FROM 'ACTIVE'
     OR v_generation IS DISTINCT FROM p_generation THEN
    RETURN false;
  END IF;

  SELECT s.generation INTO v_existing_generation
  FROM commander_worker_claim_secrets s
  WHERE s.worker_id = p_worker_id
  FOR UPDATE;

  IF FOUND AND v_existing_generation IS NOT DISTINCT FROM p_generation THEN
    -- Same generation already has a secret — refuse overwrite (peer steal).
    RETURN false;
  END IF;

  INSERT INTO commander_worker_claim_secrets (worker_id, generation, secret_hash, updated_at)
  VALUES (p_worker_id, p_generation, p_secret_hash, now())
  ON CONFLICT (worker_id) DO UPDATE
    SET generation = EXCLUDED.generation,
        secret_hash = EXCLUDED.secret_hash,
        updated_at = now()
  WHERE commander_worker_claim_secrets.generation IS DISTINCT FROM EXCLUDED.generation;

  RETURN EXISTS (
    SELECT 1 FROM commander_worker_claim_secrets s
    WHERE s.worker_id = p_worker_id
      AND s.generation = p_generation
      AND s.secret_hash = p_secret_hash
  );
END;
$fn$;

-- Drop pre-auth overloads so shared LOGIN cannot bypass previous-secret / claim-secret.
DROP FUNCTION IF EXISTS register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb);
DROP FUNCTION IF EXISTS heartbeat_worker(text, bigint, integer);
DROP FUNCTION IF EXISTS drain_worker(text, bigint);

-- Re-register of an ACTIVE worker always requires p_previous_claim_secret (blocks peer
-- takeover via heartbeat starvation). DRAINING / OFFLINE may re-register without secret
-- (graceful drain handoff + scheduler markStale recovery). Heartbeat/drain always need secret.
CREATE OR REPLACE FUNCTION register_worker(
  p_id text,
  p_kind text,
  p_version text,
  p_capabilities jsonb,
  p_labels jsonb,
  p_max_concurrency integer,
  p_identity_subject text,
  p_tenant_ids jsonb,
  p_previous_claim_secret text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tenant text;
  v_cap text;
  v_secret text;
  v_secret_hash bytea;
  v_row commander_workers%ROWTYPE;
  v_existing commander_workers%ROWTYPE;
  v_ok boolean;
  v_secret_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('commander_worker_register:' || COALESCE(p_id, '')));

  IF p_id IS NULL OR length(p_id) = 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: id required';
  END IF;
  IF p_kind IS NULL OR length(p_kind) = 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: kind required';
  END IF;
  IF p_version IS NULL OR length(p_version) = 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: version required';
  END IF;
  IF p_identity_subject IS NULL OR length(p_identity_subject) = 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: identity_subject required';
  END IF;
  IF p_max_concurrency IS NULL OR p_max_concurrency <= 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: max_concurrency must be > 0';
  END IF;
  IF p_tenant_ids IS NULL OR jsonb_typeof(p_tenant_ids) <> 'array'
     OR jsonb_array_length(p_tenant_ids) = 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: tenant_ids must be a non-empty array';
  END IF;
  IF p_capabilities IS NULL OR jsonb_typeof(p_capabilities) <> 'array'
     OR jsonb_array_length(p_capabilities) = 0 THEN
    RAISE EXCEPTION 'WORKER_REGISTER_INVALID: capabilities must be a non-empty array';
  END IF;

  FOR v_cap IN SELECT jsonb_array_elements_text(p_capabilities)
  LOOP
    IF v_cap IS NULL OR length(trim(v_cap)) = 0 OR v_cap = '*' THEN
      RAISE EXCEPTION 'WORKER_REGISTER_INVALID: capability entries must be non-empty and not *';
    END IF;
  END LOOP;

  FOR v_tenant IN SELECT jsonb_array_elements_text(p_tenant_ids)
  LOOP
    IF v_tenant IS NULL OR length(v_tenant) = 0 THEN
      RAISE EXCEPTION 'WORKER_REGISTER_INVALID: empty tenant_id';
    END IF;
    IF v_tenant = '*' THEN
      RAISE EXCEPTION 'WORKER_OPEN_ENDED_TENANTS_FORBIDDEN: durable tenant_ids must not contain *';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM commander_worker_allowed_tenants a WHERE a.tenant_id = v_tenant
    ) THEN
      RAISE EXCEPTION 'WORKER_TENANT_NOT_ALLOWED: %', v_tenant;
    END IF;
  END LOOP;

  SELECT * INTO v_existing FROM commander_workers WHERE id = p_id FOR UPDATE;
  IF FOUND THEN
    -- Only drained/offline rows may be claimed without the previous secret.
    -- ACTIVE (even with a stale heartbeat) always requires proof of possession —
    -- otherwise a shared LOGIN can starve heartbeats and steal the identity.
    IF v_existing.status = 'ACTIVE' THEN
      IF p_previous_claim_secret IS NULL OR length(p_previous_claim_secret) = 0 THEN
        RAISE EXCEPTION
          'WORKER_REREGISTER_REQUIRES_SECRET: active worker % (gen %) requires previous claim secret (drain first or pass COMMANDER_WORKER_CLAIM_SECRET)',
          p_id, v_existing.generation;
      END IF;
      SELECT EXISTS (
        SELECT 1
        FROM commander_worker_claim_secrets s
        WHERE s.worker_id = p_id
          AND s.generation = v_existing.generation
          AND s.secret_hash = sha256(convert_to(p_previous_claim_secret, 'UTF8'))
      ) INTO v_secret_ok;
      IF NOT v_secret_ok THEN
        RAISE EXCEPTION 'WORKER_REREGISTER_SECRET_MISMATCH: id=% generation=%',
          p_id, v_existing.generation;
      END IF;
    END IF;
  END IF;

  INSERT INTO commander_workers (
    id, kind, version, capabilities, labels, max_concurrency, status, generation,
    active_steps, identity_subject, tenant_ids, registered_at, last_heartbeat_at
  ) VALUES (
    p_id, p_kind, p_version,
    p_capabilities,
    COALESCE(p_labels, '{}'::jsonb),
    p_max_concurrency, 'ACTIVE', 1, 0, p_identity_subject, p_tenant_ids, now(), now()
  )
  ON CONFLICT (id) DO UPDATE SET
    kind = EXCLUDED.kind,
    version = EXCLUDED.version,
    capabilities = EXCLUDED.capabilities,
    labels = EXCLUDED.labels,
    max_concurrency = EXCLUDED.max_concurrency,
    status = 'ACTIVE',
    generation = commander_workers.generation + 1,
    active_steps = 0,
    identity_subject = EXCLUDED.identity_subject,
    tenant_ids = EXCLUDED.tenant_ids,
    registered_at = now(),
    last_heartbeat_at = now()
  RETURNING * INTO v_row;

  -- 32-byte entropy as base64url (matches Node randomBytes(32).toString('base64url')).
  v_secret := rtrim(translate(
    encode(
      decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'),
      'base64'
    ),
    '+/',
    '-_'
  ), '=');
  v_secret_hash := sha256(convert_to(v_secret, 'UTF8'));

  v_ok := register_worker_claim_secret(v_row.id, v_row.generation, v_secret_hash);
  IF NOT v_ok THEN
    RAISE EXCEPTION 'WORKER_CLAIM_SECRET_REGISTER_FAILED: id=% generation=%',
      v_row.id, v_row.generation;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'kind', v_row.kind,
    'version', v_row.version,
    'capabilities', v_row.capabilities,
    'labels', v_row.labels,
    'max_concurrency', v_row.max_concurrency,
    'status', v_row.status,
    'generation', v_row.generation,
    'active_steps', v_row.active_steps,
    'identity_subject', v_row.identity_subject,
    'tenant_ids', v_row.tenant_ids,
    'registered_at', v_row.registered_at,
    'last_heartbeat_at', v_row.last_heartbeat_at,
    'claim_secret', v_secret
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION heartbeat_worker(
  p_worker_id text,
  p_generation bigint,
  p_active_steps integer,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row commander_workers%ROWTYPE;
  v_secret_ok boolean := false;
BEGIN
  IF p_active_steps IS NULL OR p_active_steps < 0 THEN
    RETURN NULL;
  END IF;
  IF p_claim_secret IS NULL OR length(p_claim_secret) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM commander_worker_claim_secrets s
    WHERE s.worker_id = p_worker_id
      AND s.generation = p_generation
      AND s.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'))
  ) INTO v_secret_ok;
  IF NOT v_secret_ok THEN
    RETURN NULL;
  END IF;

  UPDATE commander_workers
     SET active_steps = p_active_steps,
         last_heartbeat_at = now()
   WHERE id = p_worker_id
     AND generation = p_generation
     AND status = 'ACTIVE'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'id', v_row.id,
    'kind', v_row.kind,
    'version', v_row.version,
    'capabilities', v_row.capabilities,
    'labels', v_row.labels,
    'max_concurrency', v_row.max_concurrency,
    'status', v_row.status,
    'generation', v_row.generation,
    'active_steps', v_row.active_steps,
    'identity_subject', v_row.identity_subject,
    'tenant_ids', v_row.tenant_ids,
    'registered_at', v_row.registered_at,
    'last_heartbeat_at', v_row.last_heartbeat_at
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION drain_worker(
  p_worker_id text,
  p_generation bigint,
  p_claim_secret text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_secret_ok boolean := false;
BEGIN
  IF p_claim_secret IS NULL OR length(p_claim_secret) = 0 THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM commander_worker_claim_secrets s
    WHERE s.worker_id = p_worker_id
      AND s.generation = p_generation
      AND s.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'))
  ) INTO v_secret_ok;
  IF NOT v_secret_ok THEN
    RETURN false;
  END IF;

  UPDATE commander_workers
     SET status = 'DRAINING',
         last_heartbeat_at = now()
   WHERE id = p_worker_id
     AND generation = p_generation
     AND status = 'ACTIVE';
  RETURN FOUND;
END;
$fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    ALTER TABLE commander_worker_claim_secrets OWNER TO commander_owner;
    ALTER TABLE commander_worker_allowed_tenants OWNER TO commander_owner;
    ALTER FUNCTION register_worker_claim_secret(text, bigint, bytea) OWNER TO commander_owner;
    ALTER FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) OWNER TO commander_owner;
    ALTER FUNCTION heartbeat_worker(text, bigint, integer, text) OWNER TO commander_owner;
    ALTER FUNCTION drain_worker(text, bigint, text) OWNER TO commander_owner;
  END IF;
END $$;

REVOKE ALL ON FUNCTION register_worker_claim_secret(text, bigint, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION heartbeat_worker(text, bigint, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION drain_worker(text, bigint, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    REVOKE ALL ON FUNCTION register_worker_claim_secret(text, bigint, bytea) FROM commander_app;
    REVOKE ALL ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) FROM commander_app;
    REVOKE ALL ON FUNCTION heartbeat_worker(text, bigint, integer, text) FROM commander_app;
    REVOKE ALL ON FUNCTION drain_worker(text, bigint, text) FROM commander_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    -- Worker must not call the low-level hash writer; secrets issue only via register_worker.
    REVOKE ALL ON FUNCTION register_worker_claim_secret(text, bigint, bytea) FROM commander_worker;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION register_worker(text, text, text, jsonb, jsonb, integer, text, jsonb, text) TO commander_worker;
GRANT EXECUTE ON FUNCTION heartbeat_worker(text, bigint, integer, text) TO commander_worker;
GRANT EXECUTE ON FUNCTION drain_worker(text, bigint, text) TO commander_worker;
`;

/**
 * DB-owned atomic claim RPC (Task 3 Step 6 / 2B-FIX:B closure).
 *
 * Invoker: commander_worker EXECUTE only (not commander_app) — no BYPASSRLS,
 * never sets app.tenant_scope='*'. Authz is read from commander_workers.tenant_ids
 * under SECURITY DEFINER; the function sets app.tenant_scope per candidate tenant
 * while locking one eligible step.
 *
 * Product decision: durable tenant_ids must NOT contain open-ended '*'.
 * If a legacy/handwritten row has '*', fail closed (RETURN NULL) — do not expand.
 *
 * P1-A: requires p_claim_secret matching commander_worker_claim_secrets hash.
 */
export const KERNEL_CLAIM_SQL = `
-- Drop pre-secret overload so callers cannot bypass p_claim_secret.
DROP FUNCTION IF EXISTS claim_next_step(text, bigint, integer, jsonb);

CREATE OR REPLACE FUNCTION claim_next_step(
  p_worker_id text,
  p_worker_generation bigint,
  p_lease_ttl_ms integer,
  p_claim_secret text,
  p_capabilities jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_worker_status text;
  v_worker_generation bigint;
  v_worker_capabilities jsonb;
  v_tenants text[];
  v_tenant text;
  v_now timestamptz := clock_timestamp();
  v_expiry timestamptz;
  v_token text;
  v_caps text[];
  v_db_caps text[];
  v_caller_caps text[];
  v_step_id text;
  v_previous_state text;
  v_claimed commander_steps%ROWTYPE;
  v_event_id text;
  v_outbox_id text;
  v_secret_ok boolean := false;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RETURN NULL;
  END IF;
  IF p_lease_ttl_ms IS NULL OR p_lease_ttl_ms <= 0 THEN
    RETURN NULL;
  END IF;
  IF p_claim_secret IS NULL OR length(p_claim_secret) = 0 THEN
    RETURN NULL;
  END IF;

  v_expiry := v_now + make_interval(secs => (p_lease_ttl_ms::double precision / 1000.0));
  v_token := gen_random_uuid()::text;
  v_caller_caps := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_capabilities, '[]'::jsonb)));

  -- Unforgeable claim secret (hash only; table not SELECT-able by worker LOGIN).
  SELECT EXISTS (
    SELECT 1
    FROM commander_worker_claim_secrets s
    WHERE s.worker_id = p_worker_id
      AND s.generation = p_worker_generation
      AND s.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'))
  ) INTO v_secret_ok;
  IF NOT v_secret_ok THEN
    RETURN NULL;
  END IF;

  -- Durable worker authz (definer path). Fail-closed on missing/inactive/stale generation.
  SELECT w.tenant_ids, w.status, w.generation, w.capabilities
    INTO v_worker_tenants, v_worker_status, v_worker_generation, v_worker_capabilities
  FROM commander_workers w
  WHERE w.id = p_worker_id;

  IF NOT FOUND
     OR v_worker_status IS DISTINCT FROM 'ACTIVE'
     OR v_worker_generation IS DISTINCT FROM p_worker_generation THEN
    RETURN NULL;
  END IF;

  v_db_caps := ARRAY(
    SELECT c FROM jsonb_array_elements_text(COALESCE(v_worker_capabilities, '[]'::jsonb)) AS c
    WHERE c IS NOT NULL AND length(trim(c)) > 0 AND c <> '*'
  );
  IF v_db_caps IS NULL OR cardinality(v_db_caps) = 0 THEN
    -- Empty durable capabilities: fail closed (never treat as "all kinds").
    RETURN NULL;
  END IF;
  IF cardinality(v_caller_caps) = 0 THEN
    v_caps := v_db_caps;
  ELSE
    SELECT COALESCE(array_agg(c), ARRAY[]::text[])
      INTO v_caps
    FROM unnest(v_caller_caps) AS c
    WHERE c = ANY (v_db_caps);
    IF v_caps IS NULL OR cardinality(v_caps) = 0 THEN
      RETURN NULL;
    END IF;
  END IF;

  IF v_worker_tenants ? '*' THEN
    -- Open-ended durable '*' is forbidden (register + env fail-closed).
    -- Legacy handwritten rows must not expand to all tenants.
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(t), ARRAY[]::text[])
    INTO v_tenants
  FROM jsonb_array_elements_text(v_worker_tenants) AS t
  WHERE t IS NOT NULL AND length(t) > 0 AND t <> '*';

  IF v_tenants IS NULL OR cardinality(v_tenants) = 0 THEN
    RETURN NULL;
  END IF;

  -- Prefer less-loaded tenants first (fairness across durable authz set).
  SELECT COALESCE(array_agg(x.tenant_id ORDER BY COALESCE(u.running_steps, 0) ASC, x.tenant_id ASC), ARRAY[]::text[])
    INTO v_tenants
  FROM unnest(v_tenants) AS x(tenant_id)
  LEFT JOIN commander_tenant_execution_usage u ON u.tenant_id = x.tenant_id;

  FOREACH v_tenant IN ARRAY v_tenants
  LOOP
    v_step_id := NULL;
    v_previous_state := NULL;
    -- Single-tenant GUC inside the definer — never '*'.
    PERFORM set_config('app.tenant_scope', v_tenant, true);

    SELECT c.id, c.previous_state
      INTO v_step_id, v_previous_state
    FROM (
      SELECT s.id, s.state AS previous_state
      FROM commander_steps s
      JOIN commander_runs r ON r.id = s.run_id AND r.tenant_id = s.tenant_id
      JOIN commander_tenant_execution_usage u ON u.tenant_id = s.tenant_id
      JOIN commander_tenant_execution_control c ON c.tenant_id = s.tenant_id
      LEFT JOIN commander_tenant_execution_limits l ON l.tenant_id = s.tenant_id
      WHERE s.tenant_id = v_tenant
        AND s.state IN ('PENDING', 'RETRY_WAIT')
        AND s.scheduled_at <= v_now
        AND r.state IN ('PENDING', 'RUNNING')
        AND c.paused = false
        AND s.kind = ANY (v_caps)
        AND u.running_steps < COALESCE(l.max_concurrent_steps, 2147483647)
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(s.dependencies) d
          JOIN commander_steps prerequisite
            ON prerequisite.id = d.value AND prerequisite.tenant_id = s.tenant_id
          WHERE prerequisite.state NOT IN ('SUCCEEDED', 'SKIPPED')
        )
      ORDER BY u.running_steps ASC,
               GREATEST(s.priority + FLOOR(EXTRACT(EPOCH FROM (v_now - s.scheduled_at)) / 60), 1000) DESC,
               s.scheduled_at ASC,
               s.created_at ASC
      FOR UPDATE OF s, u, c SKIP LOCKED
      LIMIT 1
    ) c;

    IF v_step_id IS NULL THEN
      CONTINUE;
    END IF;

    UPDATE commander_steps s
    SET state = 'RUNNING',
        attempt = s.attempt + 1,
        version = s.version + 1,
        lease_worker_id = p_worker_id,
        lease_worker_generation = p_worker_generation,
        lease_token = v_token,
        fencing_epoch = s.fencing_epoch + 1,
        lease_expires_at = v_expiry,
        updated_at = v_now
    WHERE s.id = v_step_id AND s.tenant_id = v_tenant
    RETURNING * INTO v_claimed;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    UPDATE commander_tenant_execution_usage
    SET running_steps = running_steps + 1, updated_at = v_now
    WHERE tenant_id = v_tenant;

    UPDATE commander_runs
    SET state = 'RUNNING', version = version + 1, updated_at = v_now
    WHERE id = v_claimed.run_id AND tenant_id = v_tenant AND state = 'PENDING';

    v_event_id := gen_random_uuid()::text;
    v_outbox_id := gen_random_uuid()::text;
    INSERT INTO commander_events (
      id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, step_id,
      causation_id, correlation_id, actor, schema_version, payload
    ) VALUES (
      v_event_id, 'step', v_claimed.id, v_claimed.version, 'step.claimed', v_tenant,
      v_claimed.run_id, v_claimed.id, NULL, NULL, p_worker_id, 'v2',
      jsonb_build_object('attempt', v_claimed.attempt, 'fencingEpoch', v_claimed.fencing_epoch)
    );
    INSERT INTO commander_outbox (id, event_id, tenant_id, topic, key, payload)
    VALUES (
      v_outbox_id, v_event_id, v_tenant, 'commander.step.claimed', v_claimed.run_id,
      jsonb_build_object(
        'attempt', v_claimed.attempt,
        'fencingEpoch', v_claimed.fencing_epoch,
        'eventId', v_event_id,
        'type', 'step.claimed',
        'runId', v_claimed.run_id,
        'stepId', v_claimed.id,
        'tenantId', v_tenant
      )
    );

    RETURN to_jsonb(v_claimed);
  END LOOP;

  RETURN NULL;
END;
$fn$;

-- Prefer owner/migration role as definer when present (BYPASSRLS for worker-row read).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    ALTER FUNCTION claim_next_step(text, bigint, integer, text, jsonb) OWNER TO commander_owner;
  END IF;
END $$;

REVOKE ALL ON FUNCTION claim_next_step(text, bigint, integer, text, jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    REVOKE ALL ON FUNCTION claim_next_step(text, bigint, integer, text, jsonb) FROM commander_app;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION claim_next_step(text, bigint, integer, text, jsonb) TO commander_worker;
`;

/**
 * Worker-only SECURITY DEFINER reconcile claim (adapter-ops LOGIN path).
 * Same durable-authz rules as claim_next_step: never sets app.tenant_scope='*',
 * never accepts caller tenant lists, GRANT EXECUTE only to commander_worker.
 * Open-ended durable '*' fail-closes (empty result) — do not expand.
 * P1-A: requires p_claim_secret matching commander_worker_claim_secrets hash.
 *
 * Follow-up: GRANT EXECUTE only to commander_adapter_ops LOGIN (split from worker).
 */
export const KERNEL_CLAIM_RECONCILE_SQL = `
DROP FUNCTION IF EXISTS claim_reconcile_effects(text, bigint, integer, timestamptz, integer);

CREATE OR REPLACE FUNCTION claim_reconcile_effects(
  p_worker_id text,
  p_worker_generation bigint,
  p_limit integer,
  p_now timestamptz,
  p_claim_ttl_ms integer,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_worker_status text;
  v_worker_generation bigint;
  v_tenants text[];
  v_tenant text;
  v_now timestamptz := COALESCE(p_now, clock_timestamp());
  v_claim_ttl_ms integer := COALESCE(p_claim_ttl_ms, 60000);
  v_limit integer := COALESCE(p_limit, 0);
  v_token text;
  v_expiry timestamptz;
  v_remaining integer;
  v_claimed jsonb := '[]'::jsonb;
  v_batch jsonb;
  v_secret_ok boolean := false;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF v_limit IS NULL OR v_limit <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF v_claim_ttl_ms IS NULL OR v_claim_ttl_ms <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF p_claim_secret IS NULL OR length(p_claim_secret) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  v_token := gen_random_uuid()::text;
  v_expiry := v_now + make_interval(secs => (v_claim_ttl_ms::double precision / 1000.0));

  SELECT EXISTS (
    SELECT 1
    FROM commander_worker_claim_secrets s
    WHERE s.worker_id = p_worker_id
      AND s.generation = p_worker_generation
      AND s.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'))
  ) INTO v_secret_ok;
  IF NOT v_secret_ok THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT w.tenant_ids, w.status, w.generation
    INTO v_worker_tenants, v_worker_status, v_worker_generation
  FROM commander_workers w
  WHERE w.id = p_worker_id;

  IF NOT FOUND
     OR v_worker_status IS DISTINCT FROM 'ACTIVE'
     OR v_worker_generation IS DISTINCT FROM p_worker_generation THEN
    RETURN '[]'::jsonb;
  END IF;

  IF v_worker_tenants ? '*' THEN
    -- Open-ended durable '*' forbidden — fail closed, do not expand.
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(array_agg(t), ARRAY[]::text[])
    INTO v_tenants
  FROM jsonb_array_elements_text(v_worker_tenants) AS t
  WHERE t IS NOT NULL AND length(t) > 0 AND t <> '*';

  IF v_tenants IS NULL OR cardinality(v_tenants) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOREACH v_tenant IN ARRAY v_tenants
  LOOP
    v_remaining := v_limit - COALESCE(jsonb_array_length(v_claimed), 0);
    EXIT WHEN v_remaining <= 0;

    -- Single-tenant GUC inside the definer — never '*'.
    PERFORM set_config('app.tenant_scope', v_tenant, true);

    WITH candidate AS (
      SELECT id FROM commander_effects
      WHERE tenant_id = v_tenant
        AND state = 'COMPLETION_UNKNOWN'
        AND reconcile_escalated_at IS NULL
        AND reconcile_after IS NOT NULL
        AND reconcile_after <= v_now
        AND (reconcile_claim_expires_at IS NULL OR reconcile_claim_expires_at < v_now)
      ORDER BY reconcile_after ASC
      FOR UPDATE SKIP LOCKED
      LIMIT v_remaining
    ), claimed AS (
      UPDATE commander_effects e
      SET reconcile_claim_token = v_token,
          reconcile_claim_expires_at = v_expiry
      FROM candidate
      WHERE e.id = candidate.id AND e.tenant_id = v_tenant
      RETURNING to_jsonb(e) AS effect_row
    )
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('effect', effect_row, 'claimToken', v_token)
      ORDER BY (effect_row->>'reconcile_after')
    ), '[]'::jsonb)
      INTO v_batch
    FROM claimed;

    v_claimed := v_claimed || COALESCE(v_batch, '[]'::jsonb);
  END LOOP;

  RETURN v_claimed;
END;
$fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    ALTER FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) OWNER TO commander_owner;
  END IF;
END $$;

REVOKE ALL ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    REVOKE ALL ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) FROM commander_app;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) TO commander_worker;

-- Worker-only SECURITY DEFINER compensation/outbox claim (adapter-ops LOGIN).
-- Same durable-authz + claim-secret rules as claim_reconcile_effects.
CREATE OR REPLACE FUNCTION claim_outbox_by_topic(
  p_worker_id text,
  p_worker_generation bigint,
  p_topic text,
  p_limit integer,
  p_now timestamptz,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_worker_status text;
  v_worker_generation bigint;
  v_tenants text[];
  v_tenant text;
  v_now timestamptz := COALESCE(p_now, clock_timestamp());
  v_limit integer := COALESCE(p_limit, 0);
  v_token text;
  v_remaining integer;
  v_claimed jsonb := '[]'::jsonb;
  v_batch jsonb;
  v_secret_ok boolean := false;
  v_stale_before timestamptz;
BEGIN
  IF p_worker_id IS NULL OR length(p_worker_id) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF p_topic IS NULL OR length(p_topic) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF v_limit IS NULL OR v_limit <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF p_claim_secret IS NULL OR length(p_claim_secret) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  v_token := gen_random_uuid()::text;
  v_stale_before := v_now - interval '60 seconds';

  SELECT EXISTS (
    SELECT 1
    FROM commander_worker_claim_secrets s
    WHERE s.worker_id = p_worker_id
      AND s.generation = p_worker_generation
      AND s.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'))
  ) INTO v_secret_ok;
  IF NOT v_secret_ok THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT w.tenant_ids, w.status, w.generation
    INTO v_worker_tenants, v_worker_status, v_worker_generation
  FROM commander_workers w
  WHERE w.id = p_worker_id;

  IF NOT FOUND
     OR v_worker_status IS DISTINCT FROM 'ACTIVE'
     OR v_worker_generation IS DISTINCT FROM p_worker_generation THEN
    RETURN '[]'::jsonb;
  END IF;

  IF v_worker_tenants ? '*' THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(array_agg(t), ARRAY[]::text[])
    INTO v_tenants
  FROM jsonb_array_elements_text(v_worker_tenants) AS t
  WHERE t IS NOT NULL AND length(t) > 0 AND t <> '*';

  IF v_tenants IS NULL OR cardinality(v_tenants) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOREACH v_tenant IN ARRAY v_tenants
  LOOP
    v_remaining := v_limit - COALESCE(jsonb_array_length(v_claimed), 0);
    EXIT WHEN v_remaining <= 0;

    PERFORM set_config('app.tenant_scope', v_tenant, true);

    WITH candidate AS (
      SELECT id FROM commander_outbox
      WHERE tenant_id = v_tenant
        AND topic = p_topic
        AND published_at IS NULL
        AND moved_to_dlq_at IS NULL
        AND attempts < max_attempts
        AND available_at <= v_now
        AND (claimed_at IS NULL OR claimed_at < v_stale_before)
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT v_remaining
    ), claimed AS (
      UPDATE commander_outbox o
      SET claimed_at = v_now,
          claim_token = v_token,
          attempts = o.attempts + 1
      FROM candidate
      WHERE o.id = candidate.id AND o.tenant_id = v_tenant
      RETURNING to_jsonb(o) AS row_json
    )
    SELECT COALESCE(jsonb_agg(row_json ORDER BY (row_json->>'created_at')), '[]'::jsonb)
      INTO v_batch
    FROM claimed;

    v_claimed := v_claimed || COALESCE(v_batch, '[]'::jsonb);
  END LOOP;

  RETURN jsonb_build_object('claimToken', v_token, 'rows', v_claimed);
END;
$fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    ALTER FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) OWNER TO commander_owner;
  END IF;
END $$;

REVOKE ALL ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    REVOKE ALL ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) FROM commander_app;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION claim_outbox_by_topic(text, bigint, text, integer, timestamptz, text) TO commander_worker;
`;
