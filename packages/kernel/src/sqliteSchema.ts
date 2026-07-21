/**
 * SQLite schema for the Commander execution kernel.
 *
 * Mirrors `schema.ts` table semantics. JSON columns use TEXT.
 * Default synchronous mode: NORMAL (WAL + busy_timeout=5000 per repository bootstrap).
 */
export const SQLITE_KERNEL_SCHEMA_VERSION = '2026-07-19.1';

export const SQLITE_KERNEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commander_kernel_schema (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  work_graph_hash TEXT NOT NULL,
  work_graph_version TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED','COMPENSATING','COMPENSATED')),
  version INTEGER NOT NULL DEFAULT 1,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paused_at TEXT,
  terminal_at TEXT,
  UNIQUE (id, tenant_id)
);
CREATE INDEX IF NOT EXISTS commander_runs_tenant_state_idx ON commander_runs (tenant_id, state, created_at);

CREATE TABLE IF NOT EXISTS commander_tenant_execution_limits (
  tenant_id TEXT PRIMARY KEY,
  max_concurrent_steps INTEGER NOT NULL CHECK (max_concurrent_steps > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_tenant_execution_usage (
  tenant_id TEXT PRIMARY KEY,
  running_steps INTEGER NOT NULL DEFAULT 0 CHECK (running_steps >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_tenant_execution_control (
  tenant_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  reason TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','WAITING_FOR_HUMAN','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
  version INTEGER NOT NULL DEFAULT 1,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  dependencies TEXT NOT NULL DEFAULT '[]',
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT,
  error TEXT,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_worker_id TEXT,
  lease_worker_generation INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES commander_runs(id, tenant_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS commander_steps_claim_idx ON commander_steps (tenant_id, state, scheduled_at, priority DESC);
CREATE INDEX IF NOT EXISTS commander_steps_run_idx ON commander_steps (run_id, tenant_id);

CREATE TABLE IF NOT EXISTS commander_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT,
  causation_id TEXT,
  correlation_id TEXT,
  actor TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  policy_snapshot_id TEXT NOT NULL DEFAULT '',
  lease_worker_id TEXT,
  lease_fencing_epoch INTEGER,
  state TEXT NOT NULL CHECK (state IN ('ADMITTED','COMPLETION_UNKNOWN','COMPLETED','FAILED')),
  request TEXT NOT NULL DEFAULT '{}',
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  reconcile_after TEXT,
  reconcile_claim_token TEXT,
  reconcile_claim_expires_at TEXT,
  reconcile_last_error TEXT,
  reconcile_escalated_at TEXT,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS commander_effects_reconcile_ready_idx
  ON commander_effects (reconcile_after)
  WHERE state = 'COMPLETION_UNKNOWN';

CREATE TABLE IF NOT EXISTS commander_workers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  labels TEXT NOT NULL DEFAULT '{}',
  max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','DRAINING','OFFLINE')),
  generation INTEGER NOT NULL DEFAULT 0,
  active_steps INTEGER NOT NULL DEFAULT 0 CHECK (active_steps >= 0),
  identity_subject TEXT NOT NULL,
  tenant_ids TEXT NOT NULL DEFAULT '[]',
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS commander_workers_active_idx ON commander_workers (status, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS commander_outbox (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES commander_events(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  claimed_at TEXT,
  claim_token TEXT,
  dlq_reason TEXT,
  moved_to_dlq_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS commander_outbox_ready_idx ON commander_outbox (available_at, created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS commander_outbox_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  tenant_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumer_id TEXT,
  claim_token TEXT,
  claimed_at TEXT,
  acknowledged_at TEXT,
  last_error TEXT,
  moved_to_dlq_at TEXT,
  dlq_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS commander_outbox_deliveries_ready_idx
  ON commander_outbox_deliveries (available_at, created_at)
  WHERE acknowledged_at IS NULL AND moved_to_dlq_at IS NULL;

CREATE TABLE IF NOT EXISTS commander_timers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  fires_at TEXT NOT NULL,
  timer_type TEXT NOT NULL CHECK (timer_type IN ('INTERACTION_TIMEOUT','RETRY_DELAY','STEP_DEADLINE')),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','PROCESSING','FIRED','CANCELLED')),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at TEXT,
  claim_token TEXT,
  claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS commander_timers_fire_idx ON commander_timers (fires_at, state) WHERE state = 'PENDING';

CREATE TABLE IF NOT EXISTS commander_interactions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','expired','cancelled')),
  prompt TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS commander_interactions_run_idx ON commander_interactions (run_id, tenant_id);
CREATE INDEX IF NOT EXISTS commander_interactions_pending_idx ON commander_interactions (tenant_id, status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS commander_outbox_dlq (
  id TEXT PRIMARY KEY,
  original_id TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'system',
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL,
  dlq_reason TEXT,
  original_created_at TEXT NOT NULL,
  moved_to_dlq_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS commander_outbox_dlq_topic_idx ON commander_outbox_dlq (topic, moved_to_dlq_at);

CREATE TABLE IF NOT EXISTS commander_effect_allowlist (
  tenant_id TEXT NOT NULL,
  action_pattern TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, action_pattern)
);

CREATE TABLE IF NOT EXISTS commander_effect_quota (
  tenant_id TEXT NOT NULL,
  action_class TEXT NOT NULL,
  day TEXT NOT NULL,
  count_used INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, action_class, day)
);

CREATE TABLE IF NOT EXISTS commander_capability_revocations (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx ON commander_capability_revocations (expires_at);

CREATE TABLE IF NOT EXISTS commander_action_kill_switches (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  actor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, scope, value)
);
`;

/** Table names that must exist in SQLite kernel schema (parity audit). */
export const SQLITE_KERNEL_TABLES = [
  'commander_kernel_schema',
  'commander_runs',
  'commander_tenant_execution_limits',
  'commander_tenant_execution_usage',
  'commander_tenant_execution_control',
  'commander_steps',
  'commander_events',
  'commander_effects',
  'commander_workers',
  'commander_outbox',
  'commander_outbox_deliveries',
  'commander_timers',
  'commander_interactions',
  'commander_outbox_dlq',
  'commander_effect_allowlist',
  'commander_effect_quota',
  'commander_capability_revocations',
  'commander_action_kill_switches',
] as const;
