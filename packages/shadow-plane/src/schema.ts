export const SHADOW_SCHEMA_VERSION = 2;

export const SHADOW_SCHEMA_SQL = `
CREATE SCHEMA commander_shadow;
REVOKE ALL ON SCHEMA commander_shadow FROM PUBLIC;
CREATE EXTENSION pgcrypto WITH SCHEMA commander_shadow;

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

CREATE TABLE commander_shadow.tenant_role_bindings (
  role_name name PRIMARY KEY,
  tenant_id text NOT NULL
);

CREATE TABLE commander_shadow.ingestion_attestation_keys (
  role_name name PRIMARY KEY REFERENCES commander_shadow.tenant_role_bindings(role_name),
  key_bytes bytea NOT NULL CHECK (octet_length(key_bytes) = 32)
);
REVOKE ALL ON commander_shadow.ingestion_attestation_keys FROM PUBLIC;

-- Only owner-executed mutation functions can read this key or invoke this verifier.
CREATE FUNCTION commander_shadow.verify_ingestion_attestation(
  p_operation text, p_fields text[], p_attestation text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_key bytea;
  v_message bytea := ''::bytea;
  v_field text;
  v_bytes bytea;
BEGIN
  SELECT k.key_bytes INTO v_key
    FROM commander_shadow.ingestion_attestation_keys k
    JOIN commander_shadow.tenant_role_bindings b USING (role_name)
   WHERE k.role_name = session_user AND b.tenant_id = p_fields[1];
  IF v_key IS NULL OR p_attestation IS NULL OR p_attestation !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SHADOW_INGESTION_ATTESTATION_INVALID' USING ERRCODE = '42501';
  END IF;
  FOREACH v_field IN ARRAY ARRAY['commander.shadow-ingestion/v1', p_operation, session_user::text] || p_fields LOOP
    IF v_field IS NULL THEN
      v_message := v_message || int4send(-1);
    ELSE
      v_bytes := convert_to(v_field, 'UTF8');
      v_message := v_message || int4send(octet_length(v_bytes)) || v_bytes;
    END IF;
  END LOOP;
  IF commander_shadow.hmac(v_message, v_key, 'sha256') <> decode(p_attestation, 'hex') THEN
    RAISE EXCEPTION 'SHADOW_INGESTION_ATTESTATION_INVALID' USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE FUNCTION commander_shadow.tenant_access_allowed(p_tenant_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p_tenant_id = current_setting('commander_shadow.tenant_id', true)
     AND EXISTS (
       SELECT 1
         FROM commander_shadow.tenant_role_bindings
        WHERE role_name = session_user
          AND tenant_id = p_tenant_id
     )
$$;

ALTER TABLE commander_shadow.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_shadow.campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY campaigns_tenant_isolation ON commander_shadow.campaigns
  USING (commander_shadow.tenant_access_allowed(tenant_id))
  WITH CHECK (commander_shadow.tenant_access_allowed(tenant_id));

ALTER TABLE commander_shadow.batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_shadow.batches FORCE ROW LEVEL SECURITY;
CREATE POLICY batches_tenant_isolation ON commander_shadow.batches
  USING (commander_shadow.tenant_access_allowed(tenant_id))
  WITH CHECK (commander_shadow.tenant_access_allowed(tenant_id));

ALTER TABLE commander_shadow.expected_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_shadow.expected_records FORCE ROW LEVEL SECURITY;
CREATE POLICY expected_records_tenant_isolation ON commander_shadow.expected_records
  USING (commander_shadow.tenant_access_allowed(tenant_id))
  WITH CHECK (commander_shadow.tenant_access_allowed(tenant_id));

ALTER TABLE commander_shadow.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_shadow.observations FORCE ROW LEVEL SECURITY;
CREATE POLICY observations_tenant_isolation ON commander_shadow.observations
  USING (commander_shadow.tenant_access_allowed(tenant_id))
  WITH CHECK (commander_shadow.tenant_access_allowed(tenant_id));

ALTER TABLE commander_shadow.cleanup_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_shadow.cleanup_state FORCE ROW LEVEL SECURITY;
CREATE POLICY cleanup_state_tenant_isolation ON commander_shadow.cleanup_state
  USING (commander_shadow.tenant_access_allowed(tenant_id))
  WITH CHECK (commander_shadow.tenant_access_allowed(tenant_id));

ALTER TABLE commander_shadow.deletion_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_shadow.deletion_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_audit_tenant_isolation ON commander_shadow.deletion_audit
  WITH CHECK (
    commander_shadow.tenant_access_allowed(current_setting('commander_shadow.tenant_id', true))
    AND tenant_id_hash = encode(sha256(convert_to(current_setting('commander_shadow.tenant_id', true), 'UTF8')), 'hex')
  );

CREATE FUNCTION commander_shadow.register_manifest(
  p_tenant_id text,
  p_campaign_id text,
  p_producer_id text,
  p_policy_id text,
  p_policy_digest text,
  p_batch_id text,
  p_manifest_text text,
  p_manifest_digest text,
  p_closes_at timestamptz,
  p_retention_until timestamptz,
  p_attestation text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_campaign commander_shadow.campaigns%ROWTYPE;
  v_batch_digest text;
  v_inserted integer;
  v_record jsonb;
  p_manifest jsonb;
BEGIN
  PERFORM commander_shadow.verify_ingestion_attestation('register_manifest', ARRAY[
    p_tenant_id, p_campaign_id, p_producer_id, p_policy_id, p_policy_digest,
    p_batch_id, p_manifest_text, p_manifest_digest,
    to_char(p_closes_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(p_retention_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ], p_attestation);
  p_manifest := p_manifest_text::jsonb;
  IF (commander_shadow.tenant_access_allowed(p_tenant_id) IS NOT TRUE
     OR p_campaign_id = '' OR p_producer_id = '' OR p_policy_id = '' OR p_batch_id = ''
     OR p_policy_digest !~ '^[0-9a-f]{64}$'
     OR p_manifest_digest !~ '^[0-9a-f]{64}$'
     OR p_manifest_digest <> encode(sha256(convert_to(p_manifest_text, 'UTF8')), 'hex')
     OR p_retention_until < p_closes_at
     OR p_closes_at IS DISTINCT FROM date_trunc('milliseconds', p_closes_at)
     OR p_retention_until IS DISTINCT FROM date_trunc('milliseconds', p_retention_until)
     OR COALESCE(p_manifest->>'schema', '') <> 'commander.shadow-manifest/v1'
     OR p_manifest->>'tenantId' <> p_tenant_id
     OR p_manifest->>'campaignId' <> p_campaign_id
     OR p_manifest->>'producerId' <> p_producer_id
     OR p_manifest->>'policyId' <> p_policy_id
     OR p_manifest->>'policyDigest' <> p_policy_digest
     OR p_manifest->>'batchId' <> p_batch_id
     OR (p_manifest->>'closesAt')::timestamptz <> p_closes_at
     OR jsonb_typeof(p_manifest->'records') <> 'array'
     OR jsonb_array_length(p_manifest->'records') NOT BETWEEN 1 AND 10000) IS NOT FALSE THEN
    RAISE EXCEPTION 'SHADOW_MANIFEST_DATABASE_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO commander_shadow.campaigns
    (tenant_id, campaign_id, producer_id, policy_id, policy_digest, state, retention_until)
  VALUES
    (p_tenant_id, p_campaign_id, p_producer_id, p_policy_id, p_policy_digest, 'open', p_retention_until)
  ON CONFLICT (tenant_id, campaign_id) DO NOTHING;

  SELECT * INTO v_campaign
    FROM commander_shadow.campaigns
   WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHADOW_CAMPAIGN_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_campaign.state = 'withdrawn' THEN
    RAISE EXCEPTION 'SHADOW_CAMPAIGN_WITHDRAWN' USING ERRCODE = 'P0001';
  END IF;
  IF v_campaign.producer_id <> p_producer_id
     OR v_campaign.policy_id <> p_policy_id
     OR v_campaign.policy_digest <> p_policy_digest THEN
    RAISE EXCEPTION 'SHADOW_CAMPAIGN_CONFLICT' USING ERRCODE = '23505';
  END IF;

  INSERT INTO commander_shadow.batches
    (tenant_id, campaign_id, batch_id, manifest, manifest_digest, closes_at, state)
  VALUES
    (p_tenant_id, p_campaign_id, p_batch_id, p_manifest, p_manifest_digest, p_closes_at, 'open')
  ON CONFLICT (tenant_id, campaign_id, batch_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT manifest_digest INTO v_batch_digest
      FROM commander_shadow.batches
     WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id AND batch_id = p_batch_id
     FOR UPDATE;
    IF v_batch_digest IS NULL OR v_batch_digest <> p_manifest_digest THEN
      RAISE EXCEPTION 'SHADOW_MANIFEST_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN true;
  END IF;

  FOR v_record IN SELECT value FROM jsonb_array_elements(p_manifest->'records') LOOP
    IF (jsonb_typeof(v_record->'index') <> 'number'
       OR (v_record->>'index')::integer < 0
       OR COALESCE(v_record->>'observationId', '') = ''
       OR COALESCE(v_record->>'digest', '') !~ '^[0-9a-f]{64}$') IS NOT FALSE THEN
      RAISE EXCEPTION 'SHADOW_MANIFEST_RECORD_DATABASE_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO commander_shadow.expected_records
      (tenant_id, campaign_id, batch_id, record_index, observation_id, digest, status)
    VALUES
      (p_tenant_id, p_campaign_id, p_batch_id, (v_record->>'index')::integer,
       v_record->>'observationId', v_record->>'digest', 'pending');
  END LOOP;

  UPDATE commander_shadow.campaigns
     SET retention_until = GREATEST(retention_until, p_retention_until)
   WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id;
  RETURN false;
END
$$;

CREATE FUNCTION commander_shadow.record_attempt(
  p_tenant_id text,
  p_campaign_id text,
  p_batch_id text,
  p_record_index integer,
  p_attempt_digest text,
  p_attempt_code text,
  p_status text,
  p_attestation text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_updated integer;
BEGIN
  PERFORM commander_shadow.verify_ingestion_attestation('record_attempt', ARRAY[
    p_tenant_id, p_campaign_id, p_batch_id, p_record_index::text,
    p_attempt_digest, p_attempt_code, p_status
  ], p_attestation);
  IF (commander_shadow.tenant_access_allowed(p_tenant_id) IS NOT TRUE
     OR p_record_index < 0
     OR p_attempt_digest !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_attempt_code, '') = ''
     OR p_status NOT IN ('rejected', 'failed')) IS NOT FALSE THEN
    RAISE EXCEPTION 'SHADOW_ATTEMPT_DATABASE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE commander_shadow.expected_records e
     SET status = p_status,
         attempt_digest = p_attempt_digest,
         attempt_code = p_attempt_code,
         attempted_at = clock_timestamp()
   WHERE e.tenant_id = p_tenant_id
     AND e.campaign_id = p_campaign_id
     AND e.batch_id = p_batch_id
     AND e.record_index = p_record_index
     AND e.digest = p_attempt_digest
     AND e.status = 'pending'
     AND NOT EXISTS (
       SELECT 1 FROM commander_shadow.observations o
        WHERE o.tenant_id = e.tenant_id AND o.campaign_id = e.campaign_id
          AND o.batch_id = e.batch_id AND o.record_index = e.record_index
     )
     AND EXISTS (
       SELECT 1 FROM commander_shadow.batches b
        WHERE b.tenant_id = e.tenant_id AND b.campaign_id = e.campaign_id
          AND b.batch_id = e.batch_id AND b.state = 'open'
          AND b.closes_at > clock_timestamp()
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    IF EXISTS (
      SELECT 1 FROM commander_shadow.expected_records
       WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id
         AND batch_id = p_batch_id AND record_index = p_record_index
         AND status = p_status AND attempt_digest = p_attempt_digest
         AND attempt_code = p_attempt_code
    ) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'SHADOW_ATTEMPT_NOT_WRITABLE' USING ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE FUNCTION commander_shadow.record_observation(
  p_tenant_id text,
  p_campaign_id text,
  p_batch_id text,
  p_record_index integer,
  p_observation_id text,
  p_digest text,
  p_canonical_observation text,
  p_hypothetical_decision text,
  p_hypothetical_decision_id text,
  p_hypothetical_reason_code text,
  p_production_decision text,
  p_production_reason_code text,
  p_comparison text,
  p_attestation text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_observation jsonb;
  v_expected_digest text;
  v_expected_observation_id text;
  v_status text;
BEGIN
  PERFORM commander_shadow.verify_ingestion_attestation('record_observation', ARRAY[
    p_tenant_id, p_campaign_id, p_batch_id, p_record_index::text, p_observation_id,
    p_digest, p_canonical_observation, p_hypothetical_decision,
    p_hypothetical_decision_id, p_hypothetical_reason_code,
    p_production_decision, p_production_reason_code, p_comparison
  ], p_attestation);
  v_observation := p_canonical_observation::jsonb;
  v_status := CASE WHEN p_comparison = 'uncomparable' THEN 'uncomparable' ELSE 'compared' END;
  IF (commander_shadow.tenant_access_allowed(p_tenant_id) IS NOT TRUE
     OR p_record_index < 0
     OR p_digest !~ '^[0-9a-f]{64}$'
     OR p_digest <> encode(sha256(convert_to(p_canonical_observation, 'UTF8')), 'hex')
     OR p_hypothetical_decision NOT IN ('allow', 'deny', 'require_approval', 'insufficient_evidence')
     OR COALESCE(p_hypothetical_decision_id, '') = ''
     OR COALESCE(p_hypothetical_reason_code, '') = ''
     OR p_production_decision NOT IN ('allow', 'deny', 'require_approval', 'unknown')
     OR p_comparison NOT IN ('match', 'mismatch', 'uncomparable')
     OR v_observation->>'schema' <> 'commander.shadow-observation/v1'
     OR v_observation->>'tenantId' <> p_tenant_id
     OR v_observation->>'campaignId' <> p_campaign_id
     OR v_observation->>'batchId' <> p_batch_id
     OR (v_observation->>'index')::integer <> p_record_index
     OR v_observation->>'observationId' <> p_observation_id
     OR v_observation->>'productionDecision' <> p_production_decision
     OR (v_observation->>'productionReasonCode') IS DISTINCT FROM p_production_reason_code) IS NOT FALSE THEN
    RAISE EXCEPTION 'SHADOW_OBSERVATION_DATABASE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT e.digest, e.observation_id
    INTO v_expected_digest, v_expected_observation_id
    FROM commander_shadow.expected_records e
    JOIN commander_shadow.batches b USING (tenant_id, campaign_id, batch_id)
   WHERE e.tenant_id = p_tenant_id AND e.campaign_id = p_campaign_id
     AND e.batch_id = p_batch_id AND e.record_index = p_record_index
     AND b.state = 'open' AND b.closes_at > clock_timestamp() AND e.status <> 'rejected'
   FOR UPDATE OF e, b;
  IF NOT FOUND OR v_expected_digest <> p_digest OR v_expected_observation_id <> p_observation_id THEN
    RAISE EXCEPTION 'SHADOW_OBSERVATION_NOT_WRITABLE' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO commander_shadow.observations
    (tenant_id, campaign_id, batch_id, record_index, observation_id, digest,
     canonical_observation, hypothetical_decision, hypothetical_decision_id,
     hypothetical_reason_code, production_decision, production_reason_code, comparison)
  VALUES
    (p_tenant_id, p_campaign_id, p_batch_id, p_record_index, p_observation_id, p_digest,
     v_observation, p_hypothetical_decision, p_hypothetical_decision_id,
     p_hypothetical_reason_code, p_production_decision, p_production_reason_code, p_comparison);

  UPDATE commander_shadow.expected_records
     SET status = v_status, attempt_digest = NULL, attempt_code = NULL, attempted_at = NULL
   WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id
     AND batch_id = p_batch_id AND record_index = p_record_index;
END
$$;

CREATE FUNCTION commander_shadow.close_batch(
  p_tenant_id text,
  p_campaign_id text,
  p_batch_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_state text;
  v_closes_at timestamptz;
BEGIN
  IF commander_shadow.tenant_access_allowed(p_tenant_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'SHADOW_TENANT_NOT_BOUND' USING ERRCODE = '42501';
  END IF;
  SELECT state, closes_at INTO v_state, v_closes_at
    FROM commander_shadow.batches
   WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id AND batch_id = p_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHADOW_BATCH_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_closes_at > clock_timestamp() THEN
    RAISE EXCEPTION 'SHADOW_BATCH_NOT_DUE' USING ERRCODE = 'P0001';
  END IF;
  IF v_state = 'closed' THEN
    RETURN;
  END IF;
  UPDATE commander_shadow.expected_records
     SET status = 'missing'
   WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id
     AND batch_id = p_batch_id AND status = 'pending';
  UPDATE commander_shadow.batches
     SET state = 'closed', closed_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id AND campaign_id = p_campaign_id AND batch_id = p_batch_id;
END
$$;

GRANT USAGE ON SCHEMA commander_shadow TO commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
GRANT SELECT ON commander_shadow.schema_version TO commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
GRANT SELECT ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.expected_records, commander_shadow.observations TO commander_shadow_ingestion;
GRANT SELECT ON commander_shadow.cleanup_state TO commander_shadow_ingestion, commander_shadow_reader;
GRANT SELECT ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.expected_records, commander_shadow.observations TO commander_shadow_reader;
GRANT SELECT ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.expected_records, commander_shadow.observations TO commander_shadow_retention;
GRANT UPDATE (state, withdrawn_at, producer_id, policy_id, policy_digest)
  ON commander_shadow.campaigns TO commander_shadow_retention;
GRANT DELETE ON commander_shadow.campaigns, commander_shadow.batches,
  commander_shadow.observations TO commander_shadow_retention;
GRANT INSERT ON commander_shadow.deletion_audit TO commander_shadow_retention;
GRANT SELECT, INSERT ON commander_shadow.cleanup_state TO commander_shadow_retention;
GRANT UPDATE (last_completed_at) ON commander_shadow.cleanup_state TO commander_shadow_retention;
REVOKE ALL ON FUNCTION commander_shadow.tenant_access_allowed(text),
  commander_shadow.verify_ingestion_attestation(text, text[], text),
  commander_shadow.register_manifest(text, text, text, text, text, text, text, text, timestamptz, timestamptz, text),
  commander_shadow.record_attempt(text, text, text, integer, text, text, text, text),
  commander_shadow.record_observation(text, text, text, integer, text, text, text, text, text, text, text, text, text, text),
  commander_shadow.close_batch(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commander_shadow.tenant_access_allowed(text)
  TO commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
GRANT EXECUTE ON FUNCTION commander_shadow.register_manifest(text, text, text, text, text, text, text, text, timestamptz, timestamptz, text)
  TO commander_shadow_ingestion;
GRANT EXECUTE ON FUNCTION commander_shadow.record_attempt(text, text, text, integer, text, text, text, text)
  TO commander_shadow_ingestion;
GRANT EXECUTE ON FUNCTION commander_shadow.record_observation(text, text, text, integer, text, text, text, text, text, text, text, text, text, text)
  TO commander_shadow_ingestion;
GRANT EXECUTE ON FUNCTION commander_shadow.close_batch(text, text, text)
  TO commander_shadow_ingestion;
REVOKE CREATE ON SCHEMA commander_shadow FROM commander_shadow_ingestion, commander_shadow_reader, commander_shadow_retention;
`;
