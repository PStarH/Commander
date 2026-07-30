export const KERNEL_TASK2_RECONCILIATION_SCHEMA_SQL = String.raw`
DO $task2_baseline$
DECLARE
  v_expected jsonb := jsonb_build_object(
    '2026-07-27.1.task1_helm_lifecycle_gate', '6b7e2bc0acd4ee28ad02f9c70924709bb6f9e00205247d87e752e2df5ff930f3',
    '2026-07-27.2.task1_authenticated_tenant_authority_expand', 'd9a70e13065a7eeb82fae265080530481bd644c0798e32bd88b67722cbdf6eb5',
    '2026-07-27.3.task1_authenticated_tenant_authority_enforce', 'fa9474d03f7f7adca4b32d9164c2510b6eb09ed5ad9929747d997272accb126e'
  );
  v_actual jsonb;
BEGIN
  SELECT COALESCE(jsonb_object_agg(id, checksum), '{}'::jsonb)
    INTO v_actual
    FROM public.commander_kernel_migrations
   WHERE id IN (SELECT jsonb_object_keys(v_expected));
  IF v_actual IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'TASK2_TASK1_ENFORCE_BASELINE_REQUIRED';
  END IF;
END
$task2_baseline$;

ALTER TABLE public.commander_steps DROP CONSTRAINT IF EXISTS commander_steps_state_check;
ALTER TABLE public.commander_steps
  ADD CONSTRAINT commander_steps_state_check
  CHECK (state IN (
    'PENDING','RUNNING','WAITING_FOR_HUMAN','WAITING_FOR_RECONCILIATION',
    'RETRY_WAIT','SUCCEEDED','FAILED','CANCELLED','SKIPPED'
  ));

ALTER TABLE public.commander_effects DROP CONSTRAINT IF EXISTS commander_effects_state_check;
ALTER TABLE public.commander_effects
  ADD CONSTRAINT commander_effects_state_check
  CHECK (state IN ('ADMITTED','COMPLETION_UNKNOWN','CONFIRMED_NOT_APPLIED','COMPLETED','FAILED'));
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS governed_action_deadline_at timestamptz;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_max_attempts integer;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_initial_delay_ms integer;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_max_delay_ms integer;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_deadline_at timestamptz;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_disposition text;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_observed_at timestamptz;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_claimed_at timestamptz;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_claim_worker_id text;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_claim_worker_generation bigint;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_escalation_code text;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS completion_unknown_fingerprint bytea;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS completion_unknown_worker_id text;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS completion_unknown_worker_generation bigint;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS completion_unknown_lease_token_hash bytea;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS completion_unknown_fencing_epoch bigint;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_claim_token_hash bytea;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_claim_worker_id text;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_claim_worker_generation bigint;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_request_fingerprint bytea;
ALTER TABLE public.commander_effects ADD COLUMN IF NOT EXISTS reconcile_last_result jsonb;

DO $task2_backfill$
DECLARE
  v_now timestamptz := clock_timestamp();
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.commander_effects
     WHERE type NOT LIKE 'compensate.%'
     GROUP BY tenant_id, run_id, step_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'TASK2_DUPLICATE_FORWARD_EFFECT_REPAIR_REQUIRED';
  END IF;

  UPDATE public.commander_effects AS effect
     SET reconcile_max_attempts = 0,
         reconcile_initial_delay_ms = 30000,
         reconcile_max_delay_ms = 900000,
         reconcile_deadline_at = v_now,
         reconcile_disposition = CASE
           WHEN step.state IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
             OR run.state IN ('SUCCEEDED','FAILED','CANCELLED','COMPENSATED')
             THEN 'ESCALATED'
           ELSE 'PENDING'
         END,
         reconcile_attempts = 0,
         reconcile_after = LEAST(COALESCE(effect.reconcile_after, v_now), v_now),
         reconcile_claim_token = NULL,
         reconcile_claim_expires_at = NULL,
         reconcile_claimed_at = NULL,
         reconcile_claim_worker_id = NULL,
         reconcile_claim_worker_generation = NULL,
         reconcile_escalated_at = CASE
           WHEN step.state IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
             OR run.state IN ('SUCCEEDED','FAILED','CANCELLED','COMPENSATED')
             THEN v_now
           ELSE effect.reconcile_escalated_at
         END,
         reconcile_escalation_code = CASE
           WHEN step.state IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
             OR run.state IN ('SUCCEEDED','FAILED','CANCELLED','COMPENSATED')
             THEN 'RECONCILE_LEGACY_TERMINAL_CONFLICT'
           ELSE 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
         END
    FROM public.commander_steps AS step
    JOIN public.commander_runs AS run
      ON run.id = step.run_id AND run.tenant_id = step.tenant_id
   WHERE effect.step_id = step.id
     AND effect.run_id = step.run_id
     AND effect.tenant_id = step.tenant_id
     AND effect.state = 'COMPLETION_UNKNOWN';

  UPDATE public.commander_steps AS step
     SET state = 'WAITING_FOR_RECONCILIATION',
         version = version + 1,
         lease_worker_id = NULL,
         lease_worker_generation = 0,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE step.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED')
     AND EXISTS (
       SELECT 1 FROM public.commander_effects AS effect
        WHERE effect.step_id = step.id
          AND effect.run_id = step.run_id
          AND effect.tenant_id = step.tenant_id
          AND effect.state = 'COMPLETION_UNKNOWN'
          AND effect.reconcile_disposition = 'PENDING'
     );

  UPDATE public.commander_effects AS effect
     SET reconcile_max_attempts = 8,
         reconcile_initial_delay_ms = 30000,
         reconcile_max_delay_ms = 900000,
         reconcile_deadline_at = effect.created_at + interval '24 hours'
   WHERE effect.state <> 'COMPLETION_UNKNOWN'
     AND (
       effect.reconcile_max_attempts IS NULL
       OR effect.reconcile_initial_delay_ms IS NULL
       OR effect.reconcile_max_delay_ms IS NULL
       OR effect.reconcile_deadline_at IS NULL
     );
END
$task2_backfill$;

ALTER TABLE public.commander_effects ALTER COLUMN reconcile_max_attempts SET NOT NULL;
ALTER TABLE public.commander_effects ALTER COLUMN reconcile_initial_delay_ms SET NOT NULL;
ALTER TABLE public.commander_effects ALTER COLUMN reconcile_max_delay_ms SET NOT NULL;
ALTER TABLE public.commander_effects ALTER COLUMN reconcile_deadline_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.commander_effect_reconcile_policy_defaults_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  NEW.reconcile_max_attempts := COALESCE(NEW.reconcile_max_attempts, 8);
  NEW.reconcile_initial_delay_ms := COALESCE(NEW.reconcile_initial_delay_ms, 30000);
  NEW.reconcile_max_delay_ms := COALESCE(NEW.reconcile_max_delay_ms, 900000);
  NEW.reconcile_deadline_at := COALESCE(
    NEW.reconcile_deadline_at,
    COALESCE(NEW.created_at, clock_timestamp()) + interval '24 hours'
  );
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS commander_effect_reconcile_policy_defaults_v1 ON public.commander_effects;
CREATE TRIGGER commander_effect_reconcile_policy_defaults_v1
BEFORE INSERT ON public.commander_effects
FOR EACH ROW EXECUTE FUNCTION public.commander_effect_reconcile_policy_defaults_v1();

ALTER TABLE public.commander_effects DROP CONSTRAINT IF EXISTS commander_effects_reconcile_policy_check;
ALTER TABLE public.commander_effects ADD CONSTRAINT commander_effects_reconcile_policy_check CHECK (
  (reconcile_disposition IS NULL
    AND reconcile_max_attempts = 8
    AND reconcile_initial_delay_ms = 30000
    AND reconcile_max_delay_ms = 900000
    AND reconcile_deadline_at IS NOT NULL)
  OR
  (reconcile_disposition IN ('PENDING','CONFIRMED_APPLIED','CONFIRMED_NOT_APPLIED','ESCALATED')
    AND reconcile_max_attempts IN (0, 8)
    AND reconcile_initial_delay_ms = 30000
    AND reconcile_max_delay_ms = 900000
    AND reconcile_deadline_at IS NOT NULL
    AND reconcile_attempts BETWEEN 0 AND 8)
);
ALTER TABLE public.commander_effects DROP CONSTRAINT IF EXISTS commander_effects_reconcile_claim_check;
ALTER TABLE public.commander_effects ADD CONSTRAINT commander_effects_reconcile_claim_check CHECK (
  (reconcile_claim_token IS NULL AND reconcile_claim_expires_at IS NULL
    AND reconcile_claimed_at IS NULL AND reconcile_claim_worker_id IS NULL
    AND reconcile_claim_worker_generation IS NULL)
  OR
  (reconcile_claim_token IS NOT NULL AND reconcile_claim_expires_at IS NOT NULL
    AND reconcile_claimed_at IS NOT NULL AND reconcile_claim_worker_id IS NOT NULL
    AND reconcile_claim_worker_generation > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS commander_effects_forward_step_unique_idx
  ON public.commander_effects (tenant_id, run_id, step_id)
  WHERE type NOT LIKE 'compensate.%';

CREATE TABLE IF NOT EXISTS public.commander_reconcile_protocol_config (
  protocol_version text PRIMARY KEY CHECK (protocol_version = 'commander.action/v1'),
  max_attempts integer NOT NULL CHECK (max_attempts = 8),
  initial_delay_ms integer NOT NULL CHECK (initial_delay_ms = 30000),
  max_delay_ms integer NOT NULL CHECK (max_delay_ms = 900000),
  claim_ttl_ms integer NOT NULL CHECK (claim_ttl_ms = 60000),
  deadline_window_ms bigint NOT NULL CHECK (deadline_window_ms > 0),
  updated_at timestamptz NOT NULL
);
INSERT INTO public.commander_reconcile_protocol_config (
  protocol_version, max_attempts, initial_delay_ms, max_delay_ms, claim_ttl_ms,
  deadline_window_ms, updated_at
) VALUES ('commander.action/v1', 8, 30000, 900000, 60000, 86400000, clock_timestamp())
ON CONFLICT (protocol_version) DO NOTHING;
`;

export const KERNEL_TASK2_RECONCILIATION_RPCS_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.configure_reconcile_protocol_v1(p_deadline_window_ms bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF session_user <> 'commander_owner' OR p_deadline_window_ms IS NULL OR p_deadline_window_ms <= 0 THEN
    RAISE EXCEPTION 'RECONCILE_PROTOCOL_CONFIGURATION_INVALID';
  END IF;
  INSERT INTO public.commander_reconcile_protocol_config (
    protocol_version, max_attempts, initial_delay_ms, max_delay_ms, claim_ttl_ms,
    deadline_window_ms, updated_at
  ) VALUES ('commander.action/v1', 8, 30000, 900000, 60000, p_deadline_window_ms, clock_timestamp())
  ON CONFLICT (protocol_version) DO UPDATE
    SET deadline_window_ms = EXCLUDED.deadline_window_ms,
        updated_at = EXCLUDED.updated_at;
END
$fn$;

CREATE OR REPLACE FUNCTION public.park_effect_completion_unknown_v1(
  p_tenant_id text,
  p_effect_id text,
  p_error jsonb,
  p_worker_id text,
  p_worker_generation bigint,
  p_claim_secret text,
  p_lease_token text,
  p_fencing_epoch bigint,
  p_governed_action_deadline_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_locator record;
  v_run public.commander_runs%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_config public.commander_reconcile_protocol_config%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_deadline timestamptz;
  v_fingerprint bytea;
  v_event_id text;
  v_sequence bigint;
  v_worker_tenants jsonb;
BEGIN
  IF session_user <> 'commander_worker'
     OR p_tenant_id IS NULL OR p_effect_id IS NULL
     OR p_error IS NULL OR jsonb_typeof(p_error) <> 'object'
     OR NULLIF(p_error->>'code', '') IS NULL OR NULLIF(p_error->>'message', '') IS NULL
     OR p_worker_id IS NULL OR p_worker_generation <= 0
     OR NULLIF(p_claim_secret, '') IS NULL
     OR p_lease_token IS NULL OR p_fencing_epoch IS NULL THEN
    RAISE EXCEPTION 'RECONCILE_PARK_AUTHORITY_INVALID';
  END IF;
  SELECT w.tenant_ids INTO v_worker_tenants
    FROM public.commander_workers AS w
    JOIN public.commander_worker_claim_secrets AS secret
      ON secret.worker_id = w.id AND secret.generation = w.generation
   WHERE w.id = p_worker_id
     AND w.generation = p_worker_generation
     AND w.status = 'ACTIVE'
     AND secret.secret_hash = sha256(convert_to(p_claim_secret, 'UTF8'));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'LEASE_FENCED');
  END IF;
  IF v_worker_tenants ? '*' OR NOT (v_worker_tenants ? p_tenant_id) THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'NOT_FOUND');
  END IF;
  SELECT run_id, step_id INTO v_locator
    FROM public.commander_effects
   WHERE id = p_effect_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'NOT_FOUND');
  END IF;
  SELECT * INTO v_run FROM public.commander_runs
   WHERE id = v_locator.run_id AND tenant_id = p_tenant_id FOR UPDATE;
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id = v_locator.step_id AND run_id = v_locator.run_id AND tenant_id = p_tenant_id FOR UPDATE;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id = p_effect_id AND run_id = v_locator.run_id AND step_id = v_locator.step_id
     AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'NOT_FOUND');
  END IF;
  IF v_step.state IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'STEP_TERMINAL_RACE');
  END IF;
  v_fingerprint := sha256(convert_to(jsonb_build_object(
    'format', 'completion-unknown-fingerprint/v1',
    'tenantId', p_tenant_id,
    'effectId', p_effect_id,
    'runId', v_effect.run_id,
    'stepId', v_effect.step_id,
    'workerId', p_worker_id,
    'workerGeneration', p_worker_generation,
    'leaseTokenSha256', encode(sha256(convert_to(p_lease_token, 'UTF8')), 'hex'),
    'fencingEpoch', p_fencing_epoch
  )::text, 'UTF8'));
  IF v_effect.state = 'COMPLETION_UNKNOWN' THEN
    IF v_effect.completion_unknown_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_effect.completion_unknown_worker_id IS DISTINCT FROM p_worker_id
       OR v_effect.completion_unknown_worker_generation IS DISTINCT FROM p_worker_generation
       OR v_effect.completion_unknown_lease_token_hash IS DISTINCT FROM sha256(convert_to(p_lease_token, 'UTF8'))
       OR v_effect.completion_unknown_fencing_epoch IS DISTINCT FROM p_fencing_epoch THEN
      RETURN jsonb_build_object('parked', false, 'reason', 'ADMISSION_BINDING_MISMATCH');
    END IF;
    RETURN jsonb_build_object('parked', true, 'replayed', true, 'effect', to_jsonb(v_effect));
  END IF;
  IF v_effect.state <> 'ADMITTED' THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'NOT_ADMITTED_OR_UNKNOWN');
  END IF;
  IF v_run.state <> 'RUNNING' OR v_step.state <> 'RUNNING'
     OR v_step.lease_worker_id IS DISTINCT FROM p_worker_id
     OR v_step.lease_worker_generation IS DISTINCT FROM p_worker_generation
     OR v_step.lease_token IS DISTINCT FROM p_lease_token
     OR v_step.fencing_epoch IS DISTINCT FROM p_fencing_epoch
     OR v_effect.lease_worker_id IS DISTINCT FROM p_worker_id
     OR v_effect.lease_worker_generation IS DISTINCT FROM p_worker_generation
     OR v_effect.lease_fencing_epoch IS DISTINCT FROM p_fencing_epoch THEN
    RETURN jsonb_build_object('parked', false, 'reason', 'ADMISSION_BINDING_MISMATCH');
  END IF;
  SELECT * INTO STRICT v_config FROM public.commander_reconcile_protocol_config
   WHERE protocol_version = 'commander.action/v1';
  v_deadline := LEAST(
    COALESCE(p_governed_action_deadline_at, 'infinity'::timestamptz),
    v_now + make_interval(secs => v_config.deadline_window_ms::double precision / 1000.0)
  );
  IF v_deadline <= v_now THEN RAISE EXCEPTION 'RECONCILE_DEADLINE_INVALID'; END IF;
  UPDATE public.commander_effects
     SET state = 'COMPLETION_UNKNOWN',
         response = jsonb_build_object('completionUnknownError', p_error),
         governed_action_deadline_at = p_governed_action_deadline_at,
         reconcile_max_attempts = 8,
         reconcile_initial_delay_ms = 30000,
         reconcile_max_delay_ms = 900000,
         reconcile_deadline_at = v_deadline,
         reconcile_disposition = 'PENDING',
         reconcile_attempts = 0,
         reconcile_after = v_now,
         reconcile_observed_at = NULL,
         reconcile_claim_token = NULL,
         reconcile_claim_expires_at = NULL,
         reconcile_claimed_at = NULL,
         reconcile_claim_worker_id = NULL,
         reconcile_claim_worker_generation = NULL,
         reconcile_last_error = p_error,
         reconcile_escalated_at = NULL,
         reconcile_escalation_code = NULL,
         completion_unknown_fingerprint = v_fingerprint,
         completion_unknown_worker_id = p_worker_id,
         completion_unknown_worker_generation = p_worker_generation,
         completion_unknown_lease_token_hash = sha256(convert_to(p_lease_token, 'UTF8')),
         completion_unknown_fencing_epoch = p_fencing_epoch
   WHERE id = v_effect.id AND tenant_id = p_tenant_id
   RETURNING * INTO v_effect;
  UPDATE public.commander_steps
     SET state = 'WAITING_FOR_RECONCILIATION',
         version = version + 1,
         lease_worker_id = NULL,
         lease_worker_generation = 0,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = v_now
   WHERE id = v_effect.step_id AND run_id = v_effect.run_id AND tenant_id = p_tenant_id;
  SELECT COALESCE(max(sequence), 0) + 1 INTO v_sequence
    FROM public.commander_events
   WHERE aggregate_type = 'effect' AND aggregate_id = v_effect.id;
  v_event_id := gen_random_uuid()::text;
  INSERT INTO public.commander_events (
    id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, step_id,
    actor, schema_version, payload
  ) VALUES (
    v_event_id, 'effect', v_effect.id, v_sequence, 'effect.completion_unknown',
    p_tenant_id, v_effect.run_id, v_effect.step_id, p_worker_id, 'v2',
    jsonb_build_object('error', p_error)
  );
  INSERT INTO public.commander_outbox (id, event_id, tenant_id, topic, key, payload)
  VALUES (
    gen_random_uuid()::text, v_event_id, p_tenant_id,
    'commander.effect.completion_unknown', v_effect.run_id,
    jsonb_build_object('eventId', v_event_id, 'type', 'effect.completion_unknown',
      'tenantId', p_tenant_id, 'runId', v_effect.run_id, 'stepId', v_effect.step_id,
      'error', p_error)
  );
  RETURN jsonb_build_object('parked', true, 'replayed', false, 'effect', to_jsonb(v_effect));
END
$fn$;

CREATE OR REPLACE FUNCTION public.request_reconcile_effect(
  p_tenant_id text,
  p_effect_id text,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_tenant text;
  v_effect public.commander_effects%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_already_scheduled boolean;
  v_event_id text;
  v_sequence bigint;
BEGIN
  IF session_user <> 'commander_app' OR NULLIF(p_actor, '') IS NULL THEN
    RAISE EXCEPTION 'RECONCILE_APP_AUTHORITY_REQUIRED';
  END IF;
  v_tenant := public.commander_authenticated_app_tenant();
  IF v_tenant IS NULL OR v_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'RECONCILE_TENANT_CONTEXT_INVALID';
  END IF;
  SELECT * INTO v_effect
    FROM public.commander_effects
   WHERE id = p_effect_id AND tenant_id = v_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('scheduled', false, 'reason', 'NOT_FOUND');
  END IF;
  IF v_effect.state <> 'COMPLETION_UNKNOWN' THEN
    RETURN jsonb_build_object('scheduled', false, 'reason', 'NOT_UNKNOWN');
  END IF;
  IF v_effect.reconcile_disposition = 'ESCALATED' OR v_effect.reconcile_escalated_at IS NOT NULL THEN
    RETURN jsonb_build_object('scheduled', false, 'reason', 'ESCALATED');
  END IF;
  IF v_effect.reconcile_deadline_at IS NULL OR v_effect.reconcile_deadline_at <= v_now THEN
    RETURN jsonb_build_object('scheduled', false, 'reason', 'DEADLINE_EXPIRED');
  END IF;
  v_already_scheduled := v_effect.reconcile_after IS NOT NULL AND v_effect.reconcile_after <= v_now;
  UPDATE public.commander_effects
     SET reconcile_after = LEAST(COALESCE(reconcile_after, v_now), v_now)
   WHERE id = v_effect.id AND tenant_id = v_tenant
   RETURNING * INTO v_effect;
  IF NOT v_already_scheduled THEN
    SELECT COALESCE(max(sequence), 0) + 1 INTO v_sequence
      FROM public.commander_events
     WHERE aggregate_type = 'effect' AND aggregate_id = v_effect.id;
    v_event_id := gen_random_uuid()::text;
    INSERT INTO public.commander_events (
      id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, step_id,
      actor, schema_version, payload
    ) VALUES (
      v_event_id, 'effect', v_effect.id, v_sequence, 'effect.reconcile_requested',
      v_tenant, v_effect.run_id, v_effect.step_id, p_actor, 'v2',
      jsonb_build_object('reconcileAfter', v_effect.reconcile_after)
    );
    INSERT INTO public.commander_outbox (id, event_id, tenant_id, topic, key, payload)
    VALUES (
      gen_random_uuid()::text, v_event_id, v_tenant,
      'commander.effect.reconcile_requested', v_effect.run_id,
      jsonb_build_object('eventId', v_event_id, 'type', 'effect.reconcile_requested',
        'tenantId', v_tenant, 'runId', v_effect.run_id, 'stepId', v_effect.step_id,
        'reconcileAfter', v_effect.reconcile_after)
    );
  END IF;
  RETURN jsonb_build_object(
    'scheduled', true,
    'effectId', v_effect.id,
    'state', 'COMPLETION_UNKNOWN',
    'reconcileAfter', v_effect.reconcile_after,
    'alreadyScheduled', v_already_scheduled
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.claim_reconcile_effects(
  p_worker_id text,
  p_worker_generation bigint,
  p_limit integer,
  p_now timestamptz,
  p_claim_ttl_ms integer,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_now timestamptz := COALESCE(p_now, clock_timestamp());
  v_expiry timestamptz;
  v_effect public.commander_effects%ROWTYPE;
  v_token text;
  v_claimed jsonb := '[]'::jsonb;
  v_code text;
  v_event_id text;
  v_sequence bigint;
BEGIN
  IF session_user <> 'commander_adapter_ops'
     OR NULLIF(p_worker_id, '') IS NULL
     OR p_worker_generation <= 0
     OR p_limit IS NULL OR p_limit <= 0
     OR p_claim_ttl_ms IS NULL OR p_claim_ttl_ms <= 0
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
  v_expiry := v_now + make_interval(secs => p_claim_ttl_ms::double precision / 1000.0);

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
    v_code := CASE
      WHEN v_effect.reconcile_max_attempts = 0
        THEN 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
      WHEN v_effect.reconcile_deadline_at <= v_now
        THEN 'RECONCILE_DEADLINE_EXPIRED'
      WHEN v_effect.reconcile_attempts >= v_effect.reconcile_max_attempts
        THEN 'RECONCILE_MAX_ATTEMPTS_EXHAUSTED'
      ELSE NULL
    END;
    IF v_code IS NOT NULL THEN
      UPDATE public.commander_effects
         SET reconcile_disposition = 'ESCALATED',
             reconcile_escalated_at = v_now,
             reconcile_escalation_code = v_code,
             reconcile_claim_token = NULL,
             reconcile_claim_expires_at = NULL,
             reconcile_claimed_at = NULL,
             reconcile_claim_worker_id = NULL,
             reconcile_claim_worker_generation = NULL
       WHERE id = v_effect.id AND tenant_id = v_effect.tenant_id;
      UPDATE public.commander_steps
         SET state = 'WAITING_FOR_HUMAN', version = version + 1, updated_at = v_now,
             lease_worker_id = NULL, lease_worker_generation = 0,
             lease_token = NULL, lease_expires_at = NULL
       WHERE id = v_effect.step_id AND run_id = v_effect.run_id
         AND tenant_id = v_effect.tenant_id
         AND state = 'WAITING_FOR_RECONCILIATION';
      SELECT COALESCE(max(sequence), 0) + 1 INTO v_sequence
        FROM public.commander_events
       WHERE aggregate_type = 'effect' AND aggregate_id = v_effect.id;
      v_event_id := gen_random_uuid()::text;
      INSERT INTO public.commander_events (
        id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, step_id,
        actor, schema_version, payload
      ) VALUES (
        v_event_id, 'effect', v_effect.id, v_sequence, 'effect.reconcile_escalated',
        v_effect.tenant_id, v_effect.run_id, v_effect.step_id, p_worker_id, 'v2',
        jsonb_build_object('reason', v_code)
      );
      INSERT INTO public.commander_outbox (id, event_id, tenant_id, topic, key, payload)
      VALUES (
        gen_random_uuid()::text, v_event_id, v_effect.tenant_id,
        'commander.effect.reconcile_escalated', v_effect.run_id,
        jsonb_build_object('eventId', v_event_id, 'type', 'effect.reconcile_escalated',
          'tenantId', v_effect.tenant_id, 'runId', v_effect.run_id,
          'stepId', v_effect.step_id, 'reason', v_code)
      );
      CONTINUE;
    END IF;
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

CREATE OR REPLACE FUNCTION public.apply_reconcile_effect_mutation_v1(
  p_mutation text,
  p_tenant_id text,
  p_effect_id text,
  p_worker_id text,
  p_worker_generation bigint,
  p_claim_secret text,
  p_claim_token text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_locator record;
  v_effect public.commander_effects%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_run public.commander_runs%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_token_hash bytea;
  v_fingerprint bytea;
  v_next_attempt integer;
  v_delay_ms bigint;
  v_next_after timestamptz;
  v_escalation_code text;
  v_disposition text;
  v_event_type text;
  v_event_id text;
  v_sequence bigint;
  v_receipt jsonb;
BEGIN
  IF session_user <> 'commander_adapter_ops'
     OR p_mutation NOT IN ('COMPLETE','CONFIRM_NOT_APPLIED','RESCHEDULE','ESCALATE')
     OR NULLIF(p_tenant_id, '') IS NULL OR NULLIF(p_effect_id, '') IS NULL
     OR NULLIF(p_worker_id, '') IS NULL OR p_worker_generation <= 0
     OR NULLIF(p_claim_secret, '') IS NULL OR NULLIF(p_claim_token, '') IS NULL
     OR p_payload IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'WORKER_FENCED');
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
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'WORKER_FENCED');
  END IF;
  IF v_worker_tenants ? '*' OR NOT (v_worker_tenants ? p_tenant_id) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'NOT_FOUND');
  END IF;
  SELECT run_id, step_id INTO v_locator
    FROM public.commander_effects
   WHERE id = p_effect_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'NOT_FOUND');
  END IF;
  SELECT * INTO v_run FROM public.commander_runs
   WHERE id = v_locator.run_id AND tenant_id = p_tenant_id FOR UPDATE;
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id = v_locator.step_id AND run_id = v_locator.run_id
     AND tenant_id = p_tenant_id FOR UPDATE;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id = p_effect_id AND run_id = v_locator.run_id AND step_id = v_locator.step_id
     AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'NOT_FOUND');
  END IF;
  v_token_hash := sha256(convert_to(p_claim_token, 'UTF8'));
  v_fingerprint := sha256(convert_to(jsonb_build_object(
    'mutation', p_mutation, 'tenantId', p_tenant_id, 'effectId', p_effect_id,
    'payload', p_payload
  )::text, 'UTF8'));

  IF v_effect.reconcile_claim_token IS NULL THEN
    IF v_effect.reconcile_last_claim_token_hash = v_token_hash
       AND v_effect.reconcile_last_claim_worker_id = p_worker_id
       AND v_effect.reconcile_last_claim_worker_generation = p_worker_generation THEN
      IF v_effect.reconcile_last_request_fingerprint = v_fingerprint THEN
        RETURN jsonb_set(v_effect.reconcile_last_result, '{replayed}', 'true'::jsonb, true);
      END IF;
      RETURN jsonb_build_object('applied', false, 'reason', 'CLAIM_REPLAY_CONFLICT');
    END IF;
    RETURN jsonb_build_object('applied', false, 'reason', 'CLAIM_NOT_OWNED');
  END IF;
  IF v_effect.reconcile_claim_token IS DISTINCT FROM p_claim_token
     OR v_effect.reconcile_claim_worker_id IS DISTINCT FROM p_worker_id
     OR v_effect.reconcile_claim_worker_generation IS DISTINCT FROM p_worker_generation THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'CLAIM_NOT_OWNED');
  END IF;
  IF v_effect.reconcile_claim_expires_at IS NULL OR v_effect.reconcile_claim_expires_at <= v_now THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'CLAIM_EXPIRED');
  END IF;
  IF v_effect.state <> 'COMPLETION_UNKNOWN' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'NOT_COMPLETION_UNKNOWN');
  END IF;
  IF v_step.state IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'STEP_TERMINAL_RACE',
      'stepState', v_step.state);
  END IF;
  IF v_run.state IN ('SUCCEEDED','FAILED','CANCELLED','COMPENSATED') THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'RUN_TERMINAL_RACE',
      'runState', v_run.state);
  END IF;

  IF p_mutation = 'COMPLETE' THEN
    UPDATE public.commander_effects
       SET state = 'COMPLETED', response = p_payload, completed_at = v_now,
           reconcile_disposition = 'CONFIRMED_APPLIED', reconcile_observed_at = v_now
     WHERE id = v_effect.id AND tenant_id = p_tenant_id;
    UPDATE public.commander_steps
       SET state = 'SUCCEEDED', output = p_payload, error = NULL,
           version = version + 1, updated_at = v_now
     WHERE id = v_effect.step_id AND run_id = v_effect.run_id AND tenant_id = p_tenant_id;
    v_disposition := 'COMPLETED';
    v_event_type := 'effect.reconciled_completed';
  ELSIF p_mutation = 'CONFIRM_NOT_APPLIED' THEN
    UPDATE public.commander_effects
       SET state = 'CONFIRMED_NOT_APPLIED', response = p_payload, completed_at = v_now,
           reconcile_disposition = 'CONFIRMED_NOT_APPLIED', reconcile_observed_at = v_now
     WHERE id = v_effect.id AND tenant_id = p_tenant_id;
    UPDATE public.commander_steps
       SET state = 'FAILED',
           error = jsonb_build_object('code', 'REMOTE_NOT_APPLIED',
             'message', 'Remote outcome confirmed the action was not applied',
             'retryable', false),
           version = version + 1, updated_at = v_now
     WHERE id = v_effect.step_id AND run_id = v_effect.run_id AND tenant_id = p_tenant_id;
    v_disposition := 'CONFIRMED_NOT_APPLIED';
    v_event_type := 'effect.confirmed_not_applied';
  ELSIF p_mutation = 'RESCHEDULE' THEN
    v_next_attempt := v_effect.reconcile_attempts + 1;
    v_delay_ms := LEAST(
      v_effect.reconcile_max_delay_ms::bigint,
      v_effect.reconcile_initial_delay_ms::bigint *
        power(2::numeric, GREATEST(0, v_next_attempt - 1))::bigint
    );
    v_next_after := v_now + make_interval(secs => v_delay_ms::double precision / 1000.0);
    v_escalation_code := CASE
      WHEN v_effect.reconcile_max_attempts = 0
        THEN 'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
      WHEN v_now >= v_effect.reconcile_deadline_at OR v_next_after >= v_effect.reconcile_deadline_at
        THEN 'RECONCILE_DEADLINE_EXPIRED'
      WHEN v_next_attempt >= v_effect.reconcile_max_attempts
        THEN 'RECONCILE_MAX_ATTEMPTS_EXHAUSTED'
      ELSE NULL
    END;
    IF v_escalation_code IS NULL THEN
      UPDATE public.commander_effects
         SET reconcile_attempts = v_next_attempt,
             reconcile_after = v_next_after,
             reconcile_observed_at = v_now,
             reconcile_last_error = p_payload
       WHERE id = v_effect.id AND tenant_id = p_tenant_id;
      v_disposition := 'RESCHEDULED';
      v_event_type := 'effect.reconcile_rescheduled';
    ELSE
      UPDATE public.commander_effects
         SET reconcile_attempts = v_next_attempt,
             reconcile_observed_at = v_now,
             reconcile_last_error = p_payload,
             reconcile_disposition = 'ESCALATED',
             reconcile_escalated_at = v_now,
             reconcile_escalation_code = v_escalation_code
       WHERE id = v_effect.id AND tenant_id = p_tenant_id;
      UPDATE public.commander_steps
         SET state = 'WAITING_FOR_HUMAN', version = version + 1, updated_at = v_now
       WHERE id = v_effect.step_id AND run_id = v_effect.run_id AND tenant_id = p_tenant_id;
      v_disposition := 'ESCALATED';
      v_event_type := 'effect.reconcile_escalated';
    END IF;
  ELSE
    v_escalation_code := p_payload #>> '{}';
    IF v_escalation_code NOT IN (
      'RECONCILE_ADAPTER_NOT_FOUND','RECONCILE_QUERY_UNSUPPORTED',
      'RECONCILE_POLICY_BACKFILL_REVIEW_REQUIRED'
    ) THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'CLAIM_REPLAY_CONFLICT');
    END IF;
    UPDATE public.commander_effects
       SET reconcile_disposition = 'ESCALATED', reconcile_escalated_at = v_now,
           reconcile_escalation_code = v_escalation_code
     WHERE id = v_effect.id AND tenant_id = p_tenant_id;
    UPDATE public.commander_steps
       SET state = 'WAITING_FOR_HUMAN', version = version + 1, updated_at = v_now
     WHERE id = v_effect.step_id AND run_id = v_effect.run_id AND tenant_id = p_tenant_id;
    v_disposition := 'ESCALATED';
    v_event_type := 'effect.reconcile_escalated';
  END IF;

  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id = p_effect_id AND tenant_id = p_tenant_id FOR UPDATE;
  SELECT COALESCE(max(sequence), 0) + 1 INTO v_sequence
    FROM public.commander_events
   WHERE aggregate_type = 'effect' AND aggregate_id = v_effect.id;
  v_event_id := gen_random_uuid()::text;
  INSERT INTO public.commander_events (
    id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, step_id,
    actor, schema_version, payload
  ) VALUES (
    v_event_id, 'effect', v_effect.id, v_sequence, v_event_type,
    p_tenant_id, v_effect.run_id, v_effect.step_id, p_worker_id, 'v2',
    jsonb_build_object('disposition', v_disposition, 'requestFingerprint', encode(v_fingerprint, 'hex'))
  );
  INSERT INTO public.commander_outbox (id, event_id, tenant_id, topic, key, payload)
  VALUES (
    gen_random_uuid()::text, v_event_id, p_tenant_id,
    'commander.' || v_event_type, v_effect.run_id,
    jsonb_build_object('eventId', v_event_id, 'type', v_event_type,
      'tenantId', p_tenant_id, 'runId', v_effect.run_id, 'stepId', v_effect.step_id,
      'disposition', v_disposition)
  );
  v_receipt := jsonb_build_object(
    'effectId', v_effect.id,
    'requestFingerprint', encode(v_fingerprint, 'hex'),
    'effectState', v_effect.state,
    'reconcileAttempts', v_effect.reconcile_attempts,
    'reconcileAfter', v_effect.reconcile_after,
    'reconcileEscalatedAt', v_effect.reconcile_escalated_at,
    'eventId', v_event_id
  );
  UPDATE public.commander_effects
     SET reconcile_claim_token = NULL,
         reconcile_claim_expires_at = NULL,
         reconcile_claimed_at = NULL,
         reconcile_claim_worker_id = NULL,
         reconcile_claim_worker_generation = NULL,
         reconcile_last_claim_token_hash = v_token_hash,
         reconcile_last_claim_worker_id = p_worker_id,
         reconcile_last_claim_worker_generation = p_worker_generation,
         reconcile_last_request_fingerprint = v_fingerprint,
         reconcile_last_result = jsonb_build_object(
           'applied', true, 'replayed', false, 'disposition', v_disposition,
           'receipt', v_receipt
         )
   WHERE id = v_effect.id AND tenant_id = p_tenant_id;

  IF p_mutation = 'COMPLETE' AND NOT EXISTS (
    SELECT 1 FROM public.commander_steps
     WHERE run_id = v_effect.run_id AND tenant_id = p_tenant_id
       AND state NOT IN ('SUCCEEDED','SKIPPED')
  ) THEN
    UPDATE public.commander_runs
       SET state = 'SUCCEEDED', version = version + 1, updated_at = v_now, terminal_at = v_now
     WHERE id = v_effect.run_id AND tenant_id = p_tenant_id AND state = 'RUNNING';
  ELSIF p_mutation = 'CONFIRM_NOT_APPLIED' AND NOT EXISTS (
    SELECT 1 FROM public.commander_steps
     WHERE run_id = v_effect.run_id AND tenant_id = p_tenant_id
       AND state IN ('PENDING','RUNNING','WAITING_FOR_HUMAN','WAITING_FOR_RECONCILIATION','RETRY_WAIT')
  ) THEN
    UPDATE public.commander_runs
       SET state = 'FAILED', version = version + 1, updated_at = v_now, terminal_at = v_now
     WHERE id = v_effect.run_id AND tenant_id = p_tenant_id AND state = 'RUNNING';
  END IF;
  RETURN jsonb_build_object(
    'applied', true, 'replayed', false, 'disposition', v_disposition,
    'receipt', v_receipt
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.complete_reconcile_effect(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_response jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_mutation_v1(
    'COMPLETE', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_response
  )
$fn$;

CREATE OR REPLACE FUNCTION public.confirm_effect_not_applied(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_response jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_mutation_v1(
    'CONFIRM_NOT_APPLIED', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_response
  )
$fn$;

CREATE OR REPLACE FUNCTION public.reschedule_reconcile_effect(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_last_error jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_mutation_v1(
    'RESCHEDULE', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_last_error
  )
$fn$;

CREATE OR REPLACE FUNCTION public.escalate_reconcile_effect(
  p_tenant_id text, p_effect_id text, p_worker_id text, p_worker_generation bigint,
  p_claim_secret text, p_claim_token text, p_reason jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT public.apply_reconcile_effect_mutation_v1(
    'ESCALATE', p_tenant_id, p_effect_id, p_worker_id, p_worker_generation,
    p_claim_secret, p_claim_token, p_reason
  )
$fn$;

ALTER FUNCTION public.configure_reconcile_protocol_v1(bigint) OWNER TO commander_owner;
ALTER FUNCTION public.commander_effect_reconcile_policy_defaults_v1() OWNER TO commander_owner;
ALTER FUNCTION public.request_reconcile_effect(text, text, text) OWNER TO commander_owner;
ALTER FUNCTION public.park_effect_completion_unknown_v1(text, text, jsonb, text, bigint, text, text, bigint, timestamptz) OWNER TO commander_owner;
ALTER FUNCTION public.claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) OWNER TO commander_owner;
ALTER FUNCTION public.apply_reconcile_effect_mutation_v1(text, text, text, text, bigint, text, text, jsonb) OWNER TO commander_owner;
ALTER FUNCTION public.complete_reconcile_effect(text, text, text, bigint, text, text, jsonb) OWNER TO commander_owner;
ALTER FUNCTION public.confirm_effect_not_applied(text, text, text, bigint, text, text, jsonb) OWNER TO commander_owner;
ALTER FUNCTION public.reschedule_reconcile_effect(text, text, text, bigint, text, text, jsonb) OWNER TO commander_owner;
ALTER FUNCTION public.escalate_reconcile_effect(text, text, text, bigint, text, text, jsonb) OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.configure_reconcile_protocol_v1(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commander_effect_reconcile_policy_defaults_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_reconcile_effect(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.park_effect_completion_unknown_v1(text, text, jsonb, text, bigint, text, text, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_reconcile_effect_mutation_v1(text, text, text, text, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_reconcile_effect(text, text, text, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_effect_not_applied(text, text, text, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reschedule_reconcile_effect(text, text, text, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.escalate_reconcile_effect(text, text, text, bigint, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.configure_reconcile_protocol_v1(bigint) TO commander_owner;
GRANT EXECUTE ON FUNCTION public.request_reconcile_effect(text, text, text) TO commander_app;
GRANT EXECUTE ON FUNCTION public.park_effect_completion_unknown_v1(text, text, jsonb, text, bigint, text, text, bigint, timestamptz) TO commander_worker;
GRANT EXECUTE ON FUNCTION public.claim_reconcile_effects(text, bigint, integer, timestamptz, integer, text) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.complete_reconcile_effect(text, text, text, bigint, text, text, jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.confirm_effect_not_applied(text, text, text, bigint, text, text, jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.reschedule_reconcile_effect(text, text, text, bigint, text, text, jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.escalate_reconcile_effect(text, text, text, bigint, text, text, jsonb) TO commander_adapter_ops;
`;

export const KERNEL_TASK2_ROLE_CLOSURE_SQL = String.raw`
REVOKE ALL ON TABLE public.commander_reconcile_protocol_config FROM PUBLIC;
REVOKE ALL ON TABLE public.commander_reconcile_protocol_config FROM commander_app, commander_worker, commander_adapter_ops;
GRANT SELECT ON TABLE public.commander_reconcile_protocol_config TO commander_scheduler;
REVOKE ALL ON FUNCTION public.request_reconcile_effect(text, text, text) FROM commander_tenant_authority, commander_worker, commander_scheduler, commander_adapter_ops;
REVOKE ALL ON FUNCTION public.apply_reconcile_effect_mutation_v1(text, text, text, text, bigint, text, text, jsonb) FROM commander_app, commander_tenant_authority, commander_worker, commander_scheduler, commander_adapter_ops;
REVOKE ALL ON FUNCTION public.complete_reconcile_effect(text, text, text, bigint, text, text, jsonb) FROM commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.confirm_effect_not_applied(text, text, text, bigint, text, text, jsonb) FROM commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.reschedule_reconcile_effect(text, text, text, bigint, text, text, jsonb) FROM commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
REVOKE ALL ON FUNCTION public.escalate_reconcile_effect(text, text, text, bigint, text, text, jsonb) FROM commander_app, commander_tenant_authority, commander_worker, commander_scheduler;
`;
