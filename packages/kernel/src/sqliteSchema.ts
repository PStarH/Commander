/**
 * SQLite schema for the Commander execution kernel.
 *
 * Mirrors `schema.ts` table semantics. JSON columns use TEXT.
 * Default synchronous mode: NORMAL (WAL + busy_timeout=5000 per repository bootstrap).
 */
/** Align with PG `KERNEL_SCHEMA_VERSION` claim-era label (workers.tenant_ids / durable claim authz). */
export const SQLITE_KERNEL_SCHEMA_VERSION = '2026-07-24.18';
export const SQLITE_KERNEL_PREVIOUS_SCHEMA_VERSION = '2026-07-23.17';

export const SQLITE_KERNEL_STEPS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS commander_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','WAITING_FOR_HUMAN','WAITING_FOR_RECONCILIATION','RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
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
);`;

export const SQLITE_KERNEL_EFFECTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS commander_effects (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES commander_steps(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  policy_decision_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  lease_worker_id TEXT NOT NULL,
  lease_worker_generation INTEGER NOT NULL DEFAULT 0,
  lease_fencing_epoch INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('ADMITTED','COMPLETION_UNKNOWN','CONFIRMED_NOT_APPLIED','COMPLETED','FAILED')),
  request TEXT NOT NULL DEFAULT '{}',
  response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  governed_action_deadline_at TEXT,
  reconcile_max_attempts INTEGER NOT NULL DEFAULT 8,
  reconcile_initial_delay_ms INTEGER NOT NULL DEFAULT 30000,
  reconcile_max_delay_ms INTEGER NOT NULL DEFAULT 900000,
  reconcile_deadline_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours')),
  reconcile_disposition TEXT CHECK (reconcile_disposition IN ('PENDING','CONFIRMED_APPLIED','CONFIRMED_NOT_APPLIED','ESCALATED')),
  reconcile_after TEXT,
  reconcile_observed_at TEXT,
  reconcile_claim_token TEXT,
  reconcile_claim_expires_at TEXT,
  reconcile_claimed_at TEXT,
  reconcile_claim_worker_id TEXT,
  reconcile_claim_worker_generation INTEGER,
  reconcile_last_error TEXT,
  reconcile_escalated_at TEXT,
  reconcile_escalation_code TEXT,
  completion_unknown_worker_id TEXT,
  completion_unknown_worker_generation INTEGER,
  completion_unknown_lease_token_hash TEXT,
  completion_unknown_fencing_epoch INTEGER,
  reconcile_last_claim_token_hash TEXT,
  reconcile_last_claim_worker_id TEXT,
  reconcile_last_claim_worker_generation INTEGER,
  reconcile_last_request_fingerprint TEXT,
  reconcile_last_result TEXT,
  CHECK (
    reconcile_max_attempts = 8
    OR (
      reconcile_max_attempts = 0
      AND reconcile_disposition = 'ESCALATED'
      AND reconcile_escalation_code = 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
    )
  ),
  CHECK (reconcile_initial_delay_ms > 0),
  CHECK (reconcile_max_delay_ms > 0),
  CHECK (reconcile_initial_delay_ms <= reconcile_max_delay_ms),
  CHECK (julianday(reconcile_deadline_at) IS NOT NULL),
  CHECK (
    governed_action_deadline_at IS NULL
    OR (
      julianday(governed_action_deadline_at) IS NOT NULL
      AND julianday(reconcile_deadline_at) <= julianday(governed_action_deadline_at)
    )
  ),
  CHECK (reconcile_attempts BETWEEN 0 AND 8),
  CHECK (
    (reconcile_claim_token IS NULL AND reconcile_claim_expires_at IS NULL
      AND reconcile_claimed_at IS NULL AND reconcile_claim_worker_id IS NULL
      AND reconcile_claim_worker_generation IS NULL)
    OR (reconcile_claim_token IS NOT NULL AND reconcile_claim_expires_at IS NOT NULL
      AND reconcile_claimed_at IS NOT NULL AND reconcile_claim_worker_id IS NOT NULL
      AND reconcile_claim_worker_generation > 0)
  ),
  UNIQUE (tenant_id, idempotency_key)
);`;

/** Forward-only, transactional file migration from the Task 1 SQLite layout. */
export const SQLITE_KERNEL_17_TO_18_MIGRATION_SQL = `
DROP INDEX IF EXISTS commander_steps_claim_idx;
DROP INDEX IF EXISTS commander_steps_run_idx;
DROP INDEX IF EXISTS commander_effects_reconcile_ready_idx;

ALTER TABLE commander_effects RENAME TO commander_effects_2026072317;
ALTER TABLE commander_steps RENAME TO commander_steps_2026072317;

${SQLITE_KERNEL_STEPS_TABLE_SQL}
${SQLITE_KERNEL_EFFECTS_TABLE_SQL}

INSERT INTO commander_steps (
  id, run_id, tenant_id, kind, state, version, attempt, max_attempts, priority,
  dependencies, input, output, error, scheduled_at, lease_worker_id,
  lease_worker_generation, lease_token, fencing_epoch, lease_expires_at, created_at, updated_at
)
SELECT
  s.id, s.run_id, s.tenant_id, s.kind,
  CASE WHEN EXISTS (
    SELECT 1 FROM commander_effects_2026072317 e
    WHERE e.step_id = s.id AND e.tenant_id = s.tenant_id AND e.state = 'COMPLETION_UNKNOWN'
  ) THEN 'WAITING_FOR_HUMAN' ELSE s.state END,
  s.version + CASE WHEN EXISTS (
    SELECT 1 FROM commander_effects_2026072317 e
    WHERE e.step_id = s.id AND e.tenant_id = s.tenant_id AND e.state = 'COMPLETION_UNKNOWN'
  ) THEN 1 ELSE 0 END,
  s.attempt, s.max_attempts, s.priority, s.dependencies, s.input, s.output, s.error,
  s.scheduled_at,
  CASE WHEN EXISTS (
    SELECT 1 FROM commander_effects_2026072317 e
    WHERE e.step_id = s.id AND e.tenant_id = s.tenant_id AND e.state = 'COMPLETION_UNKNOWN'
  ) THEN NULL ELSE s.lease_worker_id END,
  s.lease_worker_generation,
  CASE WHEN EXISTS (
    SELECT 1 FROM commander_effects_2026072317 e
    WHERE e.step_id = s.id AND e.tenant_id = s.tenant_id AND e.state = 'COMPLETION_UNKNOWN'
  ) THEN NULL ELSE s.lease_token END,
  s.fencing_epoch,
  CASE WHEN EXISTS (
    SELECT 1 FROM commander_effects_2026072317 e
    WHERE e.step_id = s.id AND e.tenant_id = s.tenant_id AND e.state = 'COMPLETION_UNKNOWN'
  ) THEN NULL ELSE s.lease_expires_at END,
  s.created_at, s.updated_at
FROM commander_steps_2026072317 s;

INSERT INTO commander_effects (
  id, run_id, step_id, tenant_id, type, idempotency_key, request_hash,
  policy_decision_id, policy_snapshot_id, action_digest, lease_worker_id,
  lease_worker_generation, lease_fencing_epoch, state, request, response, created_at,
  completed_at, reconcile_attempts, governed_action_deadline_at,
  reconcile_max_attempts, reconcile_initial_delay_ms, reconcile_max_delay_ms,
  reconcile_deadline_at, reconcile_disposition, reconcile_after, reconcile_observed_at,
  reconcile_claim_token, reconcile_claim_expires_at, reconcile_claimed_at,
  reconcile_claim_worker_id, reconcile_claim_worker_generation, reconcile_last_error,
  reconcile_escalated_at, reconcile_escalation_code, completion_unknown_worker_id,
  completion_unknown_worker_generation, completion_unknown_lease_token_hash,
  completion_unknown_fencing_epoch, reconcile_last_claim_token_hash,
  reconcile_last_claim_worker_id, reconcile_last_claim_worker_generation,
  reconcile_last_request_fingerprint, reconcile_last_result
)
SELECT
  id, run_id, step_id, tenant_id, type, idempotency_key, request_hash,
  policy_decision_id, policy_snapshot_id, action_digest, lease_worker_id,
  lease_worker_generation, lease_fencing_epoch, state, request, response, created_at,
  completed_at, reconcile_attempts, NULL,
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN 0 ELSE 8 END,
  30000, 900000, datetime(created_at, '+24 hours'),
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN 'ESCALATED' ELSE NULL END,
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN NULL ELSE reconcile_after END,
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
  NULL, NULL, NULL, NULL, NULL, reconcile_last_error,
  CASE WHEN state = 'COMPLETION_UNKNOWN'
    THEN COALESCE(reconcile_escalated_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ELSE reconcile_escalated_at END,
  CASE WHEN state = 'COMPLETION_UNKNOWN'
    THEN 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED' ELSE NULL END,
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN lease_worker_id ELSE NULL END,
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN lease_worker_generation ELSE NULL END,
  NULL,
  CASE WHEN state = 'COMPLETION_UNKNOWN' THEN lease_fencing_epoch ELSE NULL END,
  NULL, NULL, NULL, NULL, NULL
FROM commander_effects_2026072317;

DROP TABLE commander_effects_2026072317;
DROP TABLE commander_steps_2026072317;

CREATE INDEX commander_steps_claim_idx
  ON commander_steps (tenant_id, state, scheduled_at, priority DESC);
CREATE INDEX commander_steps_run_idx ON commander_steps (run_id, tenant_id);
CREATE INDEX commander_effects_reconcile_ready_idx
  ON commander_effects (reconcile_after)
  WHERE state = 'COMPLETION_UNKNOWN' AND reconcile_disposition = 'PENDING';
`;

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

${SQLITE_KERNEL_STEPS_TABLE_SQL}
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

${SQLITE_KERNEL_EFFECTS_TABLE_SQL}
CREATE INDEX IF NOT EXISTS commander_effects_reconcile_ready_idx
  ON commander_effects (reconcile_after)
  WHERE state = 'COMPLETION_UNKNOWN' AND reconcile_disposition = 'PENDING';

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

CREATE TABLE IF NOT EXISTS commander_worker_claim_secrets (
  worker_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  secret_hash BLOB NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS commander_compensation_mutation_receipts (
  message_id TEXT PRIMARY KEY REFERENCES commander_outbox(id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL,
  compensation_effect_id TEXT NOT NULL,
  claim_token_hash TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('COMPLETED','HANDOFF_UNKNOWN','ESCALATED')),
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_compensation_authorizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  original_run_id TEXT NOT NULL REFERENCES commander_runs(id) ON DELETE RESTRICT,
  original_effect_id TEXT NOT NULL REFERENCES commander_effects(id) ON DELETE RESTRICT,
  compensation_effect_type TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  compensation_patch TEXT NOT NULL,
  forward_receipt_hash TEXT NOT NULL,
  policy_decision_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','require_approval','deny')),
  action_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approval_interaction_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_compensation_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  original_run_id TEXT NOT NULL,
  original_effect_id TEXT NOT NULL,
  compensation_run_id TEXT NOT NULL,
  compensation_step_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  compensation_effect_type TEXT NOT NULL,
  compensation_patch TEXT NOT NULL,
  forward_receipt_hash TEXT NOT NULL,
  authorization_id TEXT NOT NULL UNIQUE REFERENCES commander_compensation_authorizations(id) ON DELETE RESTRICT,
  reconcile_policy TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('AUTHORIZED','CLAIMED','COMPLETION_UNKNOWN','COMPLETED','CONFIRMED_NOT_APPLIED','ESCALATED')),
  claim_worker_id TEXT,
  claim_worker_generation INTEGER,
  claim_token TEXT,
  claim_expires_at TEXT,
  compensation_effect_id TEXT,
  escalation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commander_compensation_finalization_receipts (
  outbox_message_id TEXT PRIMARY KEY REFERENCES commander_outbox(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL REFERENCES commander_compensation_requests(id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  tenant_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (tenant_id, jti)
);
CREATE INDEX IF NOT EXISTS commander_capability_revocations_exp_idx ON commander_capability_revocations (expires_at);

CREATE TABLE IF NOT EXISTS commander_capability_replays (
  tenant_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, jti, nonce)
);
CREATE INDEX IF NOT EXISTS commander_capability_replays_exp_idx ON commander_capability_replays (expires_at);

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

CREATE TABLE IF NOT EXISTS commander_action_requests (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED')),
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  PRIMARY KEY (tenant_id, idempotency_key),
  CHECK (
    (state = 'IN_PROGRESS' AND response_status IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND response_status BETWEEN 100 AND 599 AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS commander_evidence_receipts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anchored_at TEXT,
  retention_until TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bundle_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES commander_runs(id, tenant_id) ON DELETE RESTRICT,
  CHECK (julianday(retention_until) > julianday(created_at))
);
CREATE INDEX IF NOT EXISTS commander_evidence_tenant_run_idx
  ON commander_evidence_receipts (tenant_id, run_id, created_at DESC);

DROP TRIGGER IF EXISTS commander_runs_terminal_evidence_v1;
CREATE TRIGGER commander_runs_terminal_evidence_v1
BEFORE UPDATE OF state ON commander_runs
FOR EACH ROW
WHEN NEW.state IN ('SUCCEEDED','FAILED','CANCELLED','COMPENSATED')
 AND OLD.state IS NOT NEW.state
 AND EXISTS (
   SELECT 1
     FROM commander_effects AS effect
    WHERE effect.tenant_id = NEW.tenant_id
      AND effect.run_id = NEW.id
      AND (
        instr('.' || lower(trim(effect.type)) || '.', '.crm.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.connector.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.compensate.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.http.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.saas.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.write.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.mutate.') > 0
        OR instr('.' || lower(trim(effect.type)) || '.', '.egress.') > 0
        OR lower(trim(effect.type)) NOT LIKE 'llm.%'
          AND lower(trim(effect.type)) NOT LIKE 'retrieve.%'
          AND lower(trim(effect.type)) NOT LIKE 'read.%'
          AND lower(trim(effect.type)) NOT LIKE 'budget.%'
          AND lower(trim(effect.type)) NOT LIKE 'local.%'
          AND lower(trim(effect.type)) NOT LIKE 'compute.%'
      )
      AND NOT EXISTS (
        SELECT 1
          FROM commander_evidence_receipts AS receipt
         WHERE receipt.tenant_id = effect.tenant_id
           AND receipt.run_id = effect.run_id
           AND receipt.bundle_id = 'evidence_' || effect.id
           AND receipt.action_digest = effect.action_digest
           AND receipt.anchored_at IS NOT NULL
           AND json_extract(receipt.body, '$.scope.tenantId') = effect.tenant_id
           AND json_extract(receipt.body, '$.scope.runId') = effect.run_id
           AND json_extract(receipt.body, '$.scope.effectId') = effect.id
           AND json_extract(receipt.body, '$.terminalDisposition') = CASE
             WHEN effect.state = 'COMPLETED' THEN 'SUCCEEDED'
             WHEN effect.state IN ('FAILED','CONFIRMED_NOT_APPLIED') THEN 'FAILED'
             WHEN effect.state = 'COMPLETION_UNKNOWN'
               AND effect.reconcile_disposition = 'ESCALATED' THEN 'ESCALATED'
             ELSE NULL
           END
           AND EXISTS (
             SELECT 1 FROM json_each(receipt.body, '$.effects') AS item
              WHERE json_extract(item.value, '$.effectId') = effect.id
                AND json_extract(item.value, '$.state') = effect.state
           )
      )
 )
BEGIN
  SELECT RAISE(IGNORE);
END;
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
  'commander_worker_claim_secrets',
  'commander_outbox',
  'commander_outbox_deliveries',
  'commander_timers',
  'commander_interactions',
  'commander_outbox_dlq',
  'commander_effect_allowlist',
  'commander_effect_quota',
  'commander_capability_revocations',
  'commander_capability_replays',
  'commander_action_kill_switches',
  'commander_action_requests',
  'commander_evidence_receipts',
] as const;
