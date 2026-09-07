export const SHADOW_SCHEMA_VERSION = 1;

export const SHADOW_SCHEMA_SQL = `
CREATE SCHEMA commander_shadow;
REVOKE ALL ON SCHEMA commander_shadow FROM PUBLIC;

CREATE TABLE commander_shadow.schema_version (
  version integer PRIMARY KEY CHECK (version = ${SHADOW_SCHEMA_VERSION}),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO commander_shadow.schema_version (version) VALUES (${SHADOW_SCHEMA_VERSION});

CREATE TABLE commander_shadow.campaigns (
  tenant_id text NOT NULL,
  campaign_id text NOT NULL,
  producer_id text,
  policy_id text,
  policy_digest text,
  state text NOT NULL CHECK (state IN ('open','withdrawn')),
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  PRIMARY KEY (tenant_id, campaign_id)
);

CREATE TABLE commander_shadow.batches (
  tenant_id text NOT NULL,
  campaign_id text NOT NULL,
  batch_id text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL,
  closes_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('open','closed')),
  closed_at timestamptz,
  PRIMARY KEY (tenant_id, campaign_id, batch_id),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES commander_shadow.campaigns ON DELETE CASCADE
);

CREATE TABLE commander_shadow.expected_records (
  tenant_id text NOT NULL,
  campaign_id text NOT NULL,
  batch_id text NOT NULL,
  record_index integer NOT NULL CHECK (record_index >= 0),
  observation_id text NOT NULL,
  digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','missing','compared','uncomparable','failed','rejected')),
  attempt_digest text,
  attempt_code text,
  attempted_at timestamptz,
  PRIMARY KEY (tenant_id, campaign_id, batch_id, record_index),
  UNIQUE (tenant_id, campaign_id, observation_id),
  FOREIGN KEY (tenant_id, campaign_id, batch_id) REFERENCES commander_shadow.batches ON DELETE CASCADE
);

CREATE TABLE commander_shadow.observations (
  tenant_id text NOT NULL,
  campaign_id text NOT NULL,
  batch_id text NOT NULL,
  record_index integer NOT NULL,
  observation_id text NOT NULL,
  digest text NOT NULL,
  canonical_observation jsonb NOT NULL,
  hypothetical_decision text NOT NULL CHECK (hypothetical_decision IN ('allow','deny','require_approval','insufficient_evidence')),
  hypothetical_decision_id text NOT NULL,
  hypothetical_reason_code text NOT NULL,
  production_decision text NOT NULL CHECK (production_decision IN ('allow','deny','require_approval','unknown')),
  production_reason_code text,
  comparison text NOT NULL CHECK (comparison IN ('match','mismatch','uncomparable')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, campaign_id, batch_id, record_index),
  UNIQUE (tenant_id, campaign_id, observation_id),
  FOREIGN KEY (tenant_id, campaign_id, batch_id, record_index)
    REFERENCES commander_shadow.expected_records ON DELETE CASCADE
);

CREATE TABLE commander_shadow.deletion_audit (
  tenant_id_hash text NOT NULL,
  campaign_id_hash text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('withdrawal','retention')),
  deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE commander_shadow.cleanup_state (
  tenant_id text PRIMARY KEY,
  last_completed_at timestamptz NOT NULL
);

GRANT USAGE ON SCHEMA commander_shadow TO commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
GRANT SELECT ON commander_shadow.schema_version TO commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
GRANT SELECT ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.expected_records, commander_shadow.observations TO commander_shadow_ingestion;
GRANT INSERT (tenant_id, campaign_id, producer_id, policy_id, policy_digest, state, retention_until)
  ON commander_shadow.campaigns TO commander_shadow_ingestion;
GRANT UPDATE (retention_until) ON commander_shadow.campaigns TO commander_shadow_ingestion;
GRANT INSERT (tenant_id, campaign_id, batch_id, manifest, manifest_digest, closes_at, state)
  ON commander_shadow.batches TO commander_shadow_ingestion;
GRANT UPDATE (state, closed_at) ON commander_shadow.batches TO commander_shadow_ingestion;
GRANT INSERT (tenant_id, campaign_id, batch_id, record_index, observation_id, digest, status)
  ON commander_shadow.expected_records TO commander_shadow_ingestion;
GRANT UPDATE (status, attempt_digest, attempt_code, attempted_at)
  ON commander_shadow.expected_records TO commander_shadow_ingestion;
GRANT INSERT (tenant_id, campaign_id, batch_id, record_index, observation_id, digest,
  canonical_observation, hypothetical_decision, hypothetical_decision_id,
  hypothetical_reason_code, production_decision, production_reason_code, comparison)
  ON commander_shadow.observations TO commander_shadow_ingestion;
GRANT SELECT ON commander_shadow.cleanup_state TO commander_shadow_ingestion;
GRANT SELECT ON ALL TABLES IN SCHEMA commander_shadow TO commander_shadow_reader;
GRANT SELECT ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.expected_records, commander_shadow.observations TO commander_shadow_retention;
GRANT UPDATE (state, withdrawn_at, producer_id, policy_id, policy_digest)
  ON commander_shadow.campaigns TO commander_shadow_retention;
GRANT DELETE ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.observations TO commander_shadow_retention;
GRANT SELECT, INSERT ON commander_shadow.deletion_audit TO commander_shadow_retention;
GRANT SELECT, INSERT ON commander_shadow.cleanup_state TO commander_shadow_retention;
GRANT UPDATE (last_completed_at) ON commander_shadow.cleanup_state TO commander_shadow_retention;
REVOKE CREATE ON SCHEMA commander_shadow FROM commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
`;
