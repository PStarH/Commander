export const KERNEL_SIGNED_EVIDENCE_SQL = `
CREATE TABLE IF NOT EXISTS commander_evidence_receipts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  body JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  signature JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  anchored_at TIMESTAMPTZ,
  retention_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, bundle_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES commander_runs(id, tenant_id) ON DELETE RESTRICT,
  CHECK (retention_until > created_at)
);
CREATE INDEX IF NOT EXISTS commander_evidence_tenant_run_idx
  ON commander_evidence_receipts (tenant_id, run_id, created_at DESC);

CREATE OR REPLACE FUNCTION commander_terminal_evidence_ready_v1(
  p_tenant_id text,
  p_run_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.commander_effects AS effect
     WHERE effect.tenant_id = p_tenant_id
       AND effect.run_id = p_run_id
       AND public.commander_is_class_a_effect_type(effect.type)
       AND NOT EXISTS (
         SELECT 1
           FROM public.commander_evidence_receipts AS receipt
          WHERE receipt.tenant_id = effect.tenant_id
            AND receipt.run_id = effect.run_id
            AND receipt.bundle_id = 'evidence_' || effect.id
            AND receipt.action_digest = effect.action_digest
            AND receipt.anchored_at IS NOT NULL
            AND receipt.body #>> '{scope,tenantId}' = effect.tenant_id
            AND receipt.body #>> '{scope,runId}' = effect.run_id
            AND receipt.body #>> '{scope,effectId}' = effect.id
            AND receipt.body->>'terminalDisposition' = CASE
              WHEN effect.state = 'COMPLETED' THEN 'SUCCEEDED'
              WHEN effect.state IN ('FAILED','CONFIRMED_NOT_APPLIED') THEN 'FAILED'
              WHEN effect.state = 'COMPLETION_UNKNOWN'
                AND effect.reconcile_disposition = 'ESCALATED' THEN 'ESCALATED'
              ELSE NULL
            END
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(receipt.body->'effects', '[]'::jsonb)) AS item
               WHERE item->>'effectId' = effect.id
                 AND item->>'state' = effect.state
            )
       )
  )
$fn$;

CREATE OR REPLACE FUNCTION commander_enforce_terminal_evidence_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.state IN ('SUCCEEDED','FAILED','CANCELLED','COMPENSATED')
     AND OLD.state IS DISTINCT FROM NEW.state
     AND NOT public.commander_terminal_evidence_ready_v1(NEW.tenant_id, NEW.id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS commander_runs_terminal_evidence_v1 ON commander_runs;
CREATE TRIGGER commander_runs_terminal_evidence_v1
BEFORE UPDATE OF state ON commander_runs
FOR EACH ROW EXECUTE FUNCTION commander_enforce_terminal_evidence_v1();

ALTER TABLE commander_evidence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_evidence_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commander_tenant_isolation ON commander_evidence_receipts;
CREATE POLICY commander_tenant_isolation ON commander_evidence_receipts
  FOR ALL TO PUBLIC
  USING (
    tenant_id = ANY(string_to_array(current_setting('app.tenant_scope', true), ','))
    AND (
      current_user IS DISTINCT FROM 'commander_worker'
      OR EXISTS (
        SELECT 1 FROM commander_worker_allowed_tenants a
        WHERE a.tenant_id = commander_evidence_receipts.tenant_id
      )
    )
  )
  WITH CHECK (
    tenant_id = ANY(string_to_array(current_setting('app.tenant_scope', true), ','))
    AND (
      current_user IS DISTINCT FROM 'commander_worker'
      OR EXISTS (
        SELECT 1 FROM commander_worker_allowed_tenants a
        WHERE a.tenant_id = commander_evidence_receipts.tenant_id
      )
    )
  );

REVOKE ALL ON TABLE commander_evidence_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION commander_terminal_evidence_ready_v1(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION commander_enforce_terminal_evidence_v1() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    GRANT SELECT ON TABLE commander_evidence_receipts TO commander_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    GRANT SELECT, INSERT ON TABLE commander_evidence_receipts TO commander_worker;
  END IF;
END $$;
`;

/**
 * The baseline grants the app runtime broad table DML. Signed receipts are
 * append-only worker evidence, so close those inherited mutation privileges
 * without taking away worker INSERT.
 */
export const KERNEL_SIGNED_EVIDENCE_AUTHORITY_CLOSURE_SQL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE commander_evidence_receipts FROM commander_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    REVOKE UPDATE, DELETE ON TABLE commander_evidence_receipts FROM commander_worker;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.claim_reconcile_effects(
  p_worker_id text,
  p_worker_generation bigint,
  p_limit integer,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_now timestamptz := clock_timestamp();
  v_expiry timestamptz := v_now + interval '60 seconds';
  v_effect public.commander_effects%ROWTYPE;
  v_token text;
  v_claimed jsonb := '[]'::jsonb;
BEGIN
  IF session_user <> 'commander_adapter_ops'
     OR NULLIF(p_worker_id, '') IS NULL
     OR p_worker_generation <= 0
     OR p_limit IS NULL OR p_limit <= 0
     OR NULLIF(p_claim_secret, '') IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT w.tenant_ids INTO v_worker_tenants
    FROM public.commander_workers AS w
    JOIN public.commander_worker_claim_secrets AS secret
      ON secret.worker_id = w.id AND secret.generation = w.generation
   WHERE w.id = p_worker_id
     AND w.generation = p_worker_generation
     AND w.status = 'ACTIVE'
     AND w.identity_subject = 'db:commander_adapter_ops'
     AND w.capabilities = '["effect.reconcile"]'::jsonb
     AND secret.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'));
  IF NOT FOUND OR v_worker_tenants ? '*' OR jsonb_array_length(v_worker_tenants) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR v_effect IN
    SELECT effect.*
      FROM public.commander_effects AS effect
     WHERE effect.tenant_id IN (SELECT jsonb_array_elements_text(v_worker_tenants))
       AND effect.state = 'COMPLETION_UNKNOWN'
       AND effect.reconcile_disposition = 'PENDING'
       AND effect.reconcile_escalated_at IS NULL
       AND (
         effect.reconcile_max_attempts = 0
         OR effect.reconcile_deadline_at <= v_now
         OR effect.reconcile_attempts >= effect.reconcile_max_attempts
         OR (
           effect.reconcile_after IS NOT NULL
           AND effect.reconcile_after <= v_now
           AND (effect.reconcile_claim_expires_at IS NULL OR effect.reconcile_claim_expires_at <= v_now)
         )
       )
     ORDER BY effect.reconcile_after NULLS FIRST, effect.id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  LOOP
    v_token := gen_random_uuid()::text;
    UPDATE public.commander_effects
       SET reconcile_claim_token = v_token,
           reconcile_claim_expires_at = v_expiry,
           reconcile_claimed_at = v_now,
           reconcile_claim_worker_id = p_worker_id,
           reconcile_claim_worker_generation = p_worker_generation
     WHERE id = v_effect.id AND tenant_id = v_effect.tenant_id
     RETURNING * INTO v_effect;
    v_claimed := v_claimed || jsonb_build_array(jsonb_build_object(
      'effect', to_jsonb(v_effect), 'claimToken', v_token
    ));
  END LOOP;
  RETURN v_claimed;
END
$fn$;

CREATE FUNCTION public.commander_insert_reconcile_evidence_v1(
  p_tenant_id text,
  p_effect_id text,
  p_expected_state text,
  p_expected_disposition text,
  p_evidence jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_effect public.commander_effects%ROWTYPE;
  v_inserted integer;
  v_existing public.commander_evidence_receipts%ROWTYPE;
BEGIN
  IF session_user <> 'commander_adapter_ops' THEN
    RAISE EXCEPTION 'EVIDENCE_RECORD_BINDING_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_effect
    FROM public.commander_effects
   WHERE tenant_id = p_tenant_id AND id = p_effect_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVIDENCE_RECORD_BINDING_INVALID' USING ERRCODE = '22023';
  END IF;

  IF p_expected_state NOT IN ('COMPLETED','CONFIRMED_NOT_APPLIED','COMPLETION_UNKNOWN')
     OR p_expected_disposition NOT IN ('SUCCEEDED','FAILED','ESCALATED')
     OR p_evidence->>'tenantId' IS DISTINCT FROM v_effect.tenant_id
     OR p_evidence->>'runId' IS DISTINCT FROM v_effect.run_id
     OR p_evidence->>'bundleId' IS DISTINCT FROM 'evidence_' || v_effect.id
     OR p_evidence->>'actionDigest' IS DISTINCT FROM v_effect.action_digest
     OR p_evidence->>'anchoredAt' IS NULL
     OR p_evidence #>> '{body,scope,tenantId}' IS DISTINCT FROM v_effect.tenant_id
     OR p_evidence #>> '{body,scope,runId}' IS DISTINCT FROM v_effect.run_id
     OR p_evidence #>> '{body,scope,effectId}' IS DISTINCT FROM v_effect.id
     OR p_evidence #>> '{body,bundleId}' IS DISTINCT FROM p_evidence->>'bundleId'
     OR p_evidence #>> '{body,actionDigest}' IS DISTINCT FROM p_evidence->>'actionDigest'
     OR p_evidence #>> '{body,contentHash}' IS DISTINCT FROM p_evidence->>'contentHash'
     OR p_evidence #> '{body,signature}' IS DISTINCT FROM p_evidence->'signature'
     OR p_evidence #>> '{body,terminalDisposition}' IS DISTINCT FROM p_expected_disposition
     OR jsonb_typeof(p_evidence #> '{body,effects}') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(COALESCE(p_evidence #> '{body,effects}', '[]'::jsonb)) AS item
        WHERE item->>'effectId' = v_effect.id
          AND item->>'state' = p_expected_state
     ) THEN
    RAISE EXCEPTION 'EVIDENCE_RECORD_BINDING_INVALID' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.commander_evidence_receipts (
    tenant_id, run_id, bundle_id, action_digest, body, content_hash, signature,
    created_at, anchored_at, retention_until
  ) VALUES (
    p_evidence->>'tenantId', p_evidence->>'runId', p_evidence->>'bundleId',
    p_evidence->>'actionDigest', p_evidence->'body', p_evidence->>'contentHash',
    p_evidence->'signature', (p_evidence->>'createdAt')::timestamptz,
    (p_evidence->>'anchoredAt')::timestamptz,
    (p_evidence->>'retentionUntil')::timestamptz
  ) ON CONFLICT (tenant_id, bundle_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 1 THEN
    RETURN true;
  END IF;

  SELECT * INTO v_existing
    FROM public.commander_evidence_receipts
   WHERE tenant_id = p_evidence->>'tenantId'
     AND bundle_id = p_evidence->>'bundleId';
  IF NOT FOUND
     OR v_existing.run_id IS DISTINCT FROM p_evidence->>'runId'
     OR v_existing.action_digest IS DISTINCT FROM p_evidence->>'actionDigest'
     OR v_existing.body IS DISTINCT FROM p_evidence->'body'
     OR v_existing.content_hash IS DISTINCT FROM p_evidence->>'contentHash'
     OR v_existing.signature IS DISTINCT FROM p_evidence->'signature'
     OR v_existing.created_at IS DISTINCT FROM (p_evidence->>'createdAt')::timestamptz
     OR v_existing.anchored_at IS DISTINCT FROM (p_evidence->>'anchoredAt')::timestamptz
     OR v_existing.retention_until IS DISTINCT FROM (p_evidence->>'retentionUntil')::timestamptz THEN
    RAISE EXCEPTION 'EVIDENCE_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN false;
END
$fn$;

CREATE FUNCTION public.apply_reconcile_effect_with_evidence_v1(
  p_mutation text,
  p_tenant_id text,
  p_effect_id text,
  p_worker_id text,
  p_worker_generation bigint,
  p_claim_secret text,
  p_claim_token text,
  p_payload jsonb,
  p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_result jsonb;
  v_inserted boolean := false;
  v_expected_state text;
  v_expected_disposition text;
BEGIN
  IF p_mutation = 'COMPLETE' THEN
    v_expected_state := 'COMPLETED';
    v_expected_disposition := 'SUCCEEDED';
  ELSIF p_mutation = 'CONFIRM_NOT_APPLIED' THEN
    v_expected_state := 'CONFIRMED_NOT_APPLIED';
    v_expected_disposition := 'FAILED';
  END IF;

  IF v_expected_state IS NOT NULL THEN
    IF p_evidence IS NULL THEN
      RAISE EXCEPTION 'TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
    END IF;
    v_inserted := public.commander_insert_reconcile_evidence_v1(
      p_tenant_id, p_effect_id, v_expected_state, v_expected_disposition, p_evidence
    );
  END IF;

  v_result := public.apply_reconcile_effect_mutation_v1(
    p_mutation, p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_payload
  );
  IF COALESCE((v_result->>'applied')::boolean, false) = false THEN
    IF v_inserted THEN
      DELETE FROM public.commander_evidence_receipts
       WHERE tenant_id = p_tenant_id AND bundle_id = 'evidence_' || p_effect_id;
    END IF;
    RETURN v_result;
  END IF;

  IF v_result->>'disposition' = 'ESCALATED' THEN
    IF p_evidence IS NULL THEN
      RAISE EXCEPTION 'TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
    END IF;
    PERFORM public.commander_insert_reconcile_evidence_v1(
      p_tenant_id, p_effect_id, 'COMPLETION_UNKNOWN', 'ESCALATED', p_evidence
    );
  END IF;
  RETURN v_result;
END
$fn$;

CREATE FUNCTION public.complete_reconcile_effect(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_response jsonb, p_evidence jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_with_evidence_v1(
    'COMPLETE', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_response, p_evidence
  )
$fn$;

CREATE FUNCTION public.confirm_effect_not_applied(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_response jsonb, p_evidence jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_with_evidence_v1(
    'CONFIRM_NOT_APPLIED', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_response, p_evidence
  )
$fn$;

CREATE FUNCTION public.reschedule_reconcile_effect(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_last_error jsonb, p_evidence jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_with_evidence_v1(
    'RESCHEDULE', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_last_error, p_evidence
  )
$fn$;

CREATE FUNCTION public.escalate_reconcile_effect(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_reason jsonb, p_evidence jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_with_evidence_v1(
    'ESCALATE', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_reason, p_evidence
  )
$fn$;

CREATE OR REPLACE FUNCTION public.finalize_compensation(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  p_disposition text := p_input->>'disposition';
  v_expected_state text;
  v_expected_disposition text;
  v_inserted boolean := false;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_disposition = 'COMPLETED' THEN
    v_expected_state := 'COMPLETED';
    v_expected_disposition := 'SUCCEEDED';
  ELSIF p_disposition = 'CONFIRMED_NOT_APPLIED' THEN
    v_expected_state := 'CONFIRMED_NOT_APPLIED';
    v_expected_disposition := 'FAILED';
  ELSIF p_disposition = 'ESCALATED' THEN
    v_expected_state := 'COMPLETION_UNKNOWN';
    v_expected_disposition := 'ESCALATED';
  ELSE
    RETURN jsonb_build_object('applied', false, 'reason', 'WORKER_FENCED');
  END IF;
  PERFORM 1
    FROM public.commander_effects
   WHERE tenant_id = p_input->>'tenantId'
     AND id = p_input->>'effectId';
  IF NOT FOUND THEN
    IF p_disposition <> 'ESCALATED'
       OR p_input->'evidence' IS NOT NULL
       OR p_input->'evidence' = 'null'::jsonb THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'PRE_ADMISSION_ESCALATION_ONLY');
    END IF;
    RETURN public.apply_task3_compensation_mutation(p_input, p_disposition);
  END IF;
  IF p_input->'evidence' IS NULL OR p_input->'evidence' = 'null'::jsonb THEN
    RAISE EXCEPTION 'TERMINAL_EVIDENCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_inserted := public.commander_insert_reconcile_evidence_v1(
    p_input->>'tenantId', p_input->>'effectId', v_expected_state,
    v_expected_disposition, p_input->'evidence'
  );
  v_result := public.apply_task3_compensation_mutation(p_input - 'evidence', p_disposition);
  IF COALESCE((v_result->>'applied')::boolean, false) = false THEN
    IF v_inserted THEN
      DELETE FROM public.commander_evidence_receipts
       WHERE tenant_id = p_input->>'tenantId'
         AND bundle_id = 'evidence_' || (p_input->>'effectId');
    END IF;
    RETURN v_result;
  END IF;

  IF p_disposition='ESCALATED' THEN
    UPDATE public.commander_effects
       SET reconcile_disposition='ESCALATED',
           reconcile_escalated_at=COALESCE(reconcile_escalated_at, v_now),
           reconcile_escalation_code=COALESCE(
             p_input #>> '{response,reason}', 'COMPENSATION_RECONCILIATION_ESCALATED'
           ),
           reconcile_after=NULL
     WHERE id=p_input->>'effectId'
       AND tenant_id=p_input->>'tenantId'
       AND state='COMPLETION_UNKNOWN';
  END IF;
  RETURN v_result;
END
$fn$;

ALTER FUNCTION public.commander_insert_reconcile_evidence_v1(text,text,text,text,jsonb)
  OWNER TO commander_owner;
ALTER FUNCTION public.apply_reconcile_effect_with_evidence_v1(
  text,text,text,text,bigint,text,text,jsonb,jsonb
) OWNER TO commander_owner;
ALTER FUNCTION public.complete_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)
  OWNER TO commander_owner;
ALTER FUNCTION public.confirm_effect_not_applied(text,text,text,bigint,text,text,jsonb,jsonb)
  OWNER TO commander_owner;
ALTER FUNCTION public.reschedule_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)
  OWNER TO commander_owner;
ALTER FUNCTION public.escalate_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)
  OWNER TO commander_owner;
ALTER FUNCTION public.claim_reconcile_effects(text,bigint,integer,text) OWNER TO commander_owner;
ALTER FUNCTION public.finalize_compensation(jsonb) OWNER TO commander_owner;

REVOKE ALL ON FUNCTION public.commander_insert_reconcile_evidence_v1(text,text,text,text,jsonb)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler,
    commander_adapter_ops;
REVOKE ALL ON FUNCTION public.apply_reconcile_effect_with_evidence_v1(
  text,text,text,text,bigint,text,text,jsonb,jsonb
) FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler,
    commander_adapter_ops;
REVOKE ALL ON FUNCTION public.complete_reconcile_effect(text,text,text,bigint,text,text,jsonb)
  FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.confirm_effect_not_applied(text,text,text,bigint,text,text,jsonb)
  FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.reschedule_reconcile_effect(text,text,text,bigint,text,text,jsonb)
  FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.escalate_reconcile_effect(text,text,text,bigint,text,text,jsonb)
  FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.complete_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.confirm_effect_not_applied(text,text,text,bigint,text,text,jsonb,jsonb)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.reschedule_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.escalate_reconcile_effect(text,text,text,bigint,text,text,jsonb,jsonb)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.claim_reconcile_effects(text,bigint,integer,text)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.finalize_compensation(jsonb)
  FROM PUBLIC, commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
GRANT EXECUTE ON FUNCTION public.complete_reconcile_effect(
  text,text,text,bigint,text,text,jsonb,jsonb
) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.confirm_effect_not_applied(
  text,text,text,bigint,text,text,jsonb,jsonb
) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.reschedule_reconcile_effect(
  text,text,text,bigint,text,text,jsonb,jsonb
) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.escalate_reconcile_effect(
  text,text,text,bigint,text,text,jsonb,jsonb
) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.claim_reconcile_effects(text,bigint,integer,text)
  TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.finalize_compensation(jsonb) TO commander_adapter_ops;
`;
