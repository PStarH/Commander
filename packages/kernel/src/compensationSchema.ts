/** Forward-only governed compensation persistence and least-privilege RPCs. */
const KERNEL_COMPENSATION_REQUEST_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.commander_compensation_canonical_json_v1(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $fn$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'object' THEN (
      SELECT '{' || COALESCE(string_agg(to_jsonb(entry.key)::text || ':' ||
        public.commander_compensation_canonical_json_v1(entry.value), ',' ORDER BY entry.key), '') || '}'
      FROM jsonb_each(p_value) AS entry
    )
    WHEN 'array' THEN (
      SELECT '[' || COALESCE(string_agg(
        public.commander_compensation_canonical_json_v1(entry.value), ',' ORDER BY entry.ordinality), '') || ']'
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality)
    )
    ELSE p_value::text
  END
$fn$;

CREATE OR REPLACE FUNCTION public.commander_compensation_hash_v1(p_value jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $fn$
  SELECT encode(sha256(convert_to(public.commander_compensation_canonical_json_v1(p_value), 'UTF8')), 'hex')
$fn$;

CREATE OR REPLACE FUNCTION public.commander_compensation_timestamp_v1(p_value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
BEGIN
  RETURN p_value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$fn$;

CREATE TABLE IF NOT EXISTS public.commander_compensation_mutation_receipts (
  message_id text PRIMARY KEY REFERENCES public.commander_outbox(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  compensation_effect_id text NOT NULL,
  claim_token_hash bytea NOT NULL,
  request_fingerprint bytea NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('COMPLETED','HANDOFF_UNKNOWN','ESCALATED')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.request_governed_compensation_v1(
  p_authorization jsonb,
  p_requested_action_digest text,
  p_actor text,
  p_requested_approval_binding jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_original_run public.commander_runs%ROWTYPE;
  v_original_effect public.commander_effects%ROWTYPE;
  v_identity jsonb;
  v_expected_request jsonb;
  v_expected_approval jsonb;
  v_expected_digest_projection jsonb;
  v_expected_authorization jsonb;
  v_authorization_expires_at timestamptz;
  v_approval_expires_at timestamptz;
  v_forward_receipt_hash text;
  v_request_hash text;
  v_action_digest text;
  v_authorization_id text;
  v_request_id text;
  v_compensation_run_id text;
  v_compensation_step_id text;
  v_compensation_effect_id text;
  v_idempotency_key text;
  v_reason text;
  v_event_id text;
  v_outbox_id text;
  v_existing_metadata jsonb;
BEGIN
  IF session_user <> 'commander_app'
     OR jsonb_typeof(p_authorization) <> 'object'
     OR NULLIF(p_requested_action_digest, '') IS NULL
     OR NULLIF(p_actor, '') IS NULL
     OR (SELECT count(*) FROM jsonb_object_keys(p_authorization)) <> 23
     OR NOT p_authorization ?& ARRAY[
       'schema','authorizationId','requestId','tenantId','originalRunId','originalEffectId',
       'originalRunStateAtRequest','compensationRunId','compensationStepId','compensationEffectId',
       'compensationEffectType','compensationRequest','idempotencyKey','forwardReceipt',
       'forwardReceiptHash','requestHash','adapterVersion','policyDecisionId','policySnapshotId',
       'actionDigest','decisionEffect','authorizationExpiresAt','approvalBinding'
     ] THEN
    RETURN NULL;
  END IF;
  IF p_authorization->>'schema' <> 'commander.compensation/v1'
     OR p_authorization->>'decisionEffect' NOT IN ('allow','deny','require_approval')
     OR jsonb_typeof(p_authorization->'compensationRequest') <> 'object'
     OR jsonb_typeof(p_authorization->'forwardReceipt') <> 'object'
     OR NULLIF(p_authorization->>'tenantId', '') IS NULL
     OR NULLIF(p_authorization->>'originalRunId', '') IS NULL
     OR NULLIF(p_authorization->>'originalEffectId', '') IS NULL
     OR NULLIF(p_authorization->>'compensationEffectType', '') IS NULL
     OR p_authorization->>'compensationEffectType' NOT LIKE 'compensate.%' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_original_run
    FROM public.commander_runs
   WHERE id = p_authorization->>'originalRunId'
     AND tenant_id = p_authorization->>'tenantId'
   FOR UPDATE;
  IF NOT FOUND OR v_original_run.state NOT IN
    ('SUCCEEDED','FAILED','CANCELLED','COMPENSATING','COMPENSATED') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_original_effect
    FROM public.commander_effects
   WHERE id = p_authorization->>'originalEffectId'
     AND run_id = v_original_run.id
     AND tenant_id = v_original_run.tenant_id
     AND state = 'COMPLETED'
     AND type NOT LIKE 'compensate.%'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_identity := jsonb_build_object(
    'protocol','commander.compensation/v1', 'tenantId',v_original_run.tenant_id,
    'originalRunId',v_original_run.id, 'originalEffectId',v_original_effect.id,
    'adapterVersion',p_authorization->>'adapterVersion'
  );
  v_authorization_id := 'authorization_' || substr(public.commander_compensation_hash_v1(v_identity),1,40);
  v_request_id := 'request_' || substr(public.commander_compensation_hash_v1(
    v_identity || jsonb_build_object('authorizationId',v_authorization_id)),1,40);
  v_compensation_run_id := 'run_' || substr(public.commander_compensation_hash_v1(
    v_identity || jsonb_build_object('purpose','compensation-run')),1,40);
  v_compensation_step_id := 'step_' || substr(public.commander_compensation_hash_v1(
    jsonb_build_object('compensationRunId',v_compensation_run_id,'kind','tool')),1,32);
  v_idempotency_key := 'cmp:' || v_original_effect.id || ':' || (p_authorization->>'adapterVersion');
  v_compensation_effect_id := 'effect_' || substr(public.commander_compensation_hash_v1(
    jsonb_build_object('compensationRunId',v_compensation_run_id,'idempotencyKey',v_idempotency_key)),1,40);
  v_expected_request := jsonb_build_object(
    'originalEffectId',v_original_effect.id,
    'destination',v_original_effect.request->'destination',
    'forwardResponse',p_authorization->'forwardReceipt',
    'compensationPatch',p_authorization->'compensationRequest'->'compensationPatch'
  );
  v_forward_receipt_hash := public.commander_compensation_hash_v1(p_authorization->'forwardReceipt');
  v_request_hash := public.commander_compensation_hash_v1(v_expected_request);
  v_expected_approval := CASE WHEN p_requested_approval_binding IS NULL OR p_requested_approval_binding = 'null'::jsonb
    THEN 'null'::jsonb
    ELSE jsonb_build_object(
      'approvalId',p_requested_approval_binding->>'approvalId',
      'approverPrincipalId',p_requested_approval_binding->>'approverPrincipalId',
      'policySnapshotId',p_requested_approval_binding->>'policySnapshotId',
      'expiresAt',p_requested_approval_binding->>'expiresAt'
    )
  END;
  v_expected_digest_projection := jsonb_build_object(
    'protocol','commander.compensation/v1','canonicalization','jcs-v1',
    'authorizationId',v_authorization_id,'requestId',v_request_id,
    'tenantId',v_original_run.tenant_id,'originalRunId',v_original_run.id,
    'originalEffectId',v_original_effect.id,'originalRunStateAtRequest',v_original_run.state,
    'compensationRunId',v_compensation_run_id,'compensationStepId',v_compensation_step_id,
    'compensationEffectId',v_compensation_effect_id,
    'compensationEffectType',p_authorization->>'compensationEffectType',
    'idempotencyKey',v_idempotency_key,'forwardReceiptHash',v_forward_receipt_hash,
    'requestHash',v_request_hash,'adapterVersion',p_authorization->>'adapterVersion',
    'policyDecisionId',p_authorization->>'policyDecisionId',
    'policySnapshotId',p_authorization->>'policySnapshotId',
    'decisionEffect',p_authorization->>'decisionEffect',
    'authorizationExpiresAt',p_authorization->>'authorizationExpiresAt',
    'approvalBinding',v_expected_approval
  );
  v_action_digest := public.commander_compensation_hash_v1(v_expected_digest_projection);
  v_expected_approval := CASE WHEN v_expected_approval = 'null'::jsonb THEN v_expected_approval
    ELSE v_expected_approval || jsonb_build_object('actionDigest',v_action_digest) END;
  v_expected_authorization := jsonb_build_object(
    'schema','commander.compensation/v1','authorizationId',v_authorization_id,
    'requestId',v_request_id,'tenantId',v_original_run.tenant_id,
    'originalRunId',v_original_run.id,'originalEffectId',v_original_effect.id,
    'originalRunStateAtRequest',v_original_run.state,'compensationRunId',v_compensation_run_id,
    'compensationStepId',v_compensation_step_id,'compensationEffectId',v_compensation_effect_id,
    'compensationEffectType',p_authorization->>'compensationEffectType',
    'compensationRequest',v_expected_request,'idempotencyKey',v_idempotency_key,
    'forwardReceipt',p_authorization->'forwardReceipt','forwardReceiptHash',v_forward_receipt_hash,
    'requestHash',v_request_hash,'adapterVersion',p_authorization->>'adapterVersion',
    'policyDecisionId',p_authorization->>'policyDecisionId',
    'policySnapshotId',p_authorization->>'policySnapshotId','actionDigest',v_action_digest,
    'decisionEffect',p_authorization->>'decisionEffect',
    'authorizationExpiresAt',p_authorization->>'authorizationExpiresAt',
    'approvalBinding',v_expected_approval
  );
  v_authorization_expires_at := public.commander_compensation_timestamp_v1(
    p_authorization->>'authorizationExpiresAt');
  v_approval_expires_at := public.commander_compensation_timestamp_v1(
    p_requested_approval_binding->>'expiresAt');

  IF COALESCE(v_original_effect.response, '{}'::jsonb) IS DISTINCT FROM p_authorization->'forwardReceipt' THEN
    v_reason := 'FORWARD_RECEIPT_MISMATCH';
  ELSIF p_authorization->>'decisionEffect' = 'deny' THEN
    v_reason := 'POLICY_DENIED';
  ELSIF v_authorization_expires_at IS NULL OR v_authorization_expires_at <= v_now THEN
    v_reason := 'AUTHORIZATION_EXPIRED';
  ELSIF p_authorization->>'decisionEffect' = 'require_approval'
        AND (p_requested_approval_binding IS NULL OR p_requested_approval_binding = 'null'::jsonb) THEN
    v_reason := 'APPROVAL_REQUIRED';
  ELSIF (p_authorization->>'decisionEffect' = 'allow'
         AND p_requested_approval_binding IS DISTINCT FROM 'null'::jsonb)
     OR (p_requested_approval_binding IS DISTINCT FROM 'null'::jsonb AND (
       jsonb_typeof(p_requested_approval_binding) <> 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(p_requested_approval_binding)) <> 5
       OR p_requested_approval_binding->>'policySnapshotId' <> p_authorization->>'policySnapshotId'
       OR p_requested_approval_binding->>'actionDigest' <> p_requested_action_digest
       OR v_approval_expires_at IS NULL OR v_approval_expires_at <= v_now
     )) THEN
    v_reason := 'APPROVAL_BINDING_INVALID';
  ELSIF p_requested_action_digest <> v_action_digest
     OR p_authorization IS DISTINCT FROM v_expected_authorization THEN
    v_reason := 'ACTION_DIGEST_MISMATCH';
  END IF;

  SELECT metadata INTO v_existing_metadata FROM public.commander_runs
   WHERE id=v_compensation_run_id AND tenant_id=v_original_run.tenant_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing_metadata #> '{compensation,authorization}' IS DISTINCT FROM v_expected_authorization THEN
      RETURN NULL;
    END IF;
    IF v_existing_metadata #>> '{compensation,escalationReason}' IS NOT NULL THEN
      RETURN jsonb_build_object('status','ESCALATED','compensationRunId',v_compensation_run_id,
        'compensationStepId',v_compensation_step_id,'compensationEffectId',v_compensation_effect_id,
        'originalEffectId',v_original_effect.id,'originalRunId',v_original_run.id,
        'reason',v_existing_metadata #>> '{compensation,escalationReason}');
    END IF;
    SELECT id INTO v_outbox_id FROM public.commander_outbox
     WHERE tenant_id=v_original_run.tenant_id AND topic='commander.kernel.compensation.requested'
       AND payload=v_expected_authorization;
    IF v_outbox_id IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('status','SCHEDULED','compensationRunId',v_compensation_run_id,
      'compensationStepId',v_compensation_step_id,'compensationEffectId',v_compensation_effect_id,
      'originalEffectId',v_original_effect.id,'originalRunId',v_original_run.id,
      'outboxMessageId',v_outbox_id);
  END IF;

  INSERT INTO public.commander_tenant_execution_usage(tenant_id) VALUES(v_original_run.tenant_id)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.commander_runs(
    id,tenant_id,intent_hash,work_graph_hash,work_graph_version,policy_snapshot_id,state,metadata,
    terminal_at,updated_at
  ) VALUES (
    v_compensation_run_id,v_original_run.tenant_id,
    encode(sha256(convert_to('compensate:'||v_original_effect.id,'UTF8')),'hex'),
    encode(sha256(convert_to(v_compensation_step_id,'UTF8')),'hex'),
    'action-gateway-compensation/v1',p_authorization->>'policySnapshotId',
    CASE WHEN v_reason IS NULL THEN 'PENDING' ELSE 'FAILED' END,
    jsonb_build_object('compensation',jsonb_build_object(
      'authorization',v_expected_authorization,'disposition',CASE WHEN v_reason IS NULL THEN 'PENDING' ELSE 'ESCALATED' END,
      'escalationReason',v_reason,'requestedActionDigest',p_requested_action_digest)),
    CASE WHEN v_reason IS NULL THEN NULL ELSE v_now END,v_now
  );
  INSERT INTO public.commander_steps(
    id,run_id,tenant_id,kind,state,max_attempts,priority,dependencies,input,scheduled_at,updated_at
  ) VALUES (
    v_compensation_step_id,v_compensation_run_id,v_original_run.tenant_id,'tool',
    CASE WHEN v_reason IS NULL THEN 'PENDING' ELSE 'FAILED' END,1,0,'[]'::jsonb,
    jsonb_build_object('authorization',v_expected_authorization),v_now,v_now
  );
  v_event_id := gen_random_uuid()::text;
  INSERT INTO public.commander_events(
    id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,actor,schema_version,payload
  ) VALUES (
    v_event_id,CASE WHEN v_reason IS NULL THEN 'effect' ELSE 'run' END,
    CASE WHEN v_reason IS NULL THEN v_compensation_effect_id ELSE v_compensation_run_id END,1,
    CASE WHEN v_reason IS NULL THEN 'kernel.compensation.requested' ELSE 'compensation.authorization_escalated' END,
    v_original_run.tenant_id,v_compensation_run_id,v_compensation_step_id,p_actor,'v2',
    CASE WHEN v_reason IS NULL THEN v_expected_authorization ELSE jsonb_build_object(
      'reason',v_reason,'originalRunId',v_original_run.id,'originalEffectId',v_original_effect.id,
      'compensationEffectId',v_compensation_effect_id) END
  );
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('status','ESCALATED','compensationRunId',v_compensation_run_id,
      'compensationStepId',v_compensation_step_id,'compensationEffectId',v_compensation_effect_id,
      'originalEffectId',v_original_effect.id,'originalRunId',v_original_run.id,'reason',v_reason);
  END IF;
  v_outbox_id := gen_random_uuid()::text;
  INSERT INTO public.commander_outbox(id,event_id,tenant_id,topic,key,payload)
  VALUES(v_outbox_id,v_event_id,v_original_run.tenant_id,'commander.kernel.compensation.requested',
    v_original_run.tenant_id||'/'||v_compensation_run_id||'/'||v_original_effect.id,v_expected_authorization);
  RETURN jsonb_build_object('status','SCHEDULED','compensationRunId',v_compensation_run_id,
    'compensationStepId',v_compensation_step_id,'compensationEffectId',v_compensation_effect_id,
    'originalEffectId',v_original_effect.id,'originalRunId',v_original_run.id,
    'outboxMessageId',v_outbox_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.commander_compensation_canonical_json_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commander_compensation_hash_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commander_compensation_timestamp_v1(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_governed_compensation_v1(jsonb,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_governed_compensation_v1(jsonb,text,text,jsonb) TO commander_app;
REVOKE ALL PRIVILEGES ON TABLE public.commander_compensation_mutation_receipts FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops;
`;

const KERNEL_COMPENSATION_ADAPTER_OPS_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.claim_compensation_work_v1(
  p_worker_id text,
  p_worker_generation bigint,
  p_claim_secret text,
  p_limit integer,
  p_now timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_worker_tenants jsonb;
  v_now timestamptz := COALESCE(p_now, clock_timestamp());
  v_message public.commander_outbox%ROWTYPE;
  v_run public.commander_runs%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_outbox public.commander_outbox%ROWTYPE;
  v_authorization jsonb;
  v_claim_token text;
  v_fencing_epoch bigint;
  v_lease_expires_at timestamptz;
  v_claimed jsonb := '[]'::jsonb;
BEGIN
  IF session_user <> 'commander_adapter_ops' OR NULLIF(p_worker_id,'') IS NULL
     OR p_worker_generation <= 0 OR NULLIF(p_claim_secret,'') IS NULL
     OR p_limit IS NULL OR p_limit <= 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT w.tenant_ids INTO v_worker_tenants
    FROM public.commander_workers AS w
    JOIN public.commander_worker_claim_secrets AS secret
      ON secret.worker_id=w.id AND secret.generation=w.generation
   WHERE w.id=p_worker_id AND w.generation=p_worker_generation AND w.status='ACTIVE'
     AND w.identity_subject='db:commander_adapter_ops'
     AND w.capabilities='["effect.compensate"]'::jsonb
     AND secret.secret_hash=sha256(convert_to(p_claim_secret,'UTF8'));
  IF NOT FOUND OR v_worker_tenants ? '*' OR jsonb_array_length(v_worker_tenants)=0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR v_message IN
    SELECT outbox.* FROM public.commander_outbox AS outbox
     WHERE outbox.topic='commander.kernel.compensation.requested'
       AND outbox.tenant_id IN (SELECT jsonb_array_elements_text(v_worker_tenants))
       AND outbox.published_at IS NULL AND outbox.moved_to_dlq_at IS NULL
       AND outbox.attempts < outbox.max_attempts AND outbox.available_at <= v_now
       AND (outbox.claimed_at IS NULL OR outbox.claimed_at <= v_now - interval '60 seconds')
     ORDER BY outbox.created_at,outbox.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    v_authorization := v_message.payload;
    SELECT * INTO v_run FROM public.commander_runs
     WHERE id=v_authorization->>'compensationRunId' AND tenant_id=v_message.tenant_id FOR UPDATE;
    SELECT * INTO v_step FROM public.commander_steps
     WHERE id=v_authorization->>'compensationStepId'
       AND run_id=v_authorization->>'compensationRunId' AND tenant_id=v_message.tenant_id FOR UPDATE;
    IF jsonb_typeof(v_authorization) <> 'object'
       OR v_authorization->>'tenantId' IS DISTINCT FROM v_message.tenant_id
       OR v_run.id IS NULL OR v_step.id IS NULL
       OR v_run.state <> 'PENDING' OR v_step.state <> 'PENDING'
       OR v_run.metadata #> '{compensation,authorization}' IS DISTINCT FROM v_authorization
       OR v_step.input->'authorization' IS DISTINCT FROM v_authorization
       OR public.commander_compensation_timestamp_v1(v_authorization->>'authorizationExpiresAt') IS NULL
       OR public.commander_compensation_timestamp_v1(v_authorization->>'authorizationExpiresAt') <= v_now THEN
      UPDATE public.commander_outbox SET published_at=v_now,claimed_at=NULL,claim_token=NULL
       WHERE id=v_message.id;
      IF v_run.id IS NOT NULL THEN
        UPDATE public.commander_runs SET state='FAILED',version=version+1,updated_at=v_now,
          terminal_at=v_now,metadata=jsonb_set(jsonb_set(metadata,'{compensation,disposition}',
          '"ESCALATED"'::jsonb,true),'{compensation,escalationReason}',
          '"COMPENSATION_AUTHORIZATION_REQUIRED"'::jsonb,true)
         WHERE id=v_run.id AND tenant_id=v_message.tenant_id AND state IN ('PENDING','RUNNING');
      END IF;
      IF v_step.id IS NOT NULL THEN
        UPDATE public.commander_steps SET state='FAILED',version=version+1,updated_at=v_now,
          error=jsonb_build_object('code','COMPENSATION_AUTHORIZATION_REQUIRED',
            'message','Governed compensation authorization is missing or stale','retryable',false)
         WHERE id=v_step.id AND tenant_id=v_message.tenant_id
           AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SKIPPED');
      END IF;
      CONTINUE;
    END IF;
    v_claim_token := gen_random_uuid()::text;
    v_fencing_epoch := v_step.fencing_epoch + 1;
    v_lease_expires_at := LEAST(v_now + interval '60 seconds',
      public.commander_compensation_timestamp_v1(v_authorization->>'authorizationExpiresAt'));
    UPDATE public.commander_outbox SET claimed_at=v_now,claim_token=v_claim_token,
      attempts=attempts+1 WHERE id=v_message.id;
    UPDATE public.commander_runs SET state='RUNNING',version=version+1,updated_at=v_now
     WHERE id=v_run.id AND tenant_id=v_message.tenant_id AND state='PENDING';
    UPDATE public.commander_steps SET state='RUNNING',version=version+1,attempt=attempt+1,
      lease_worker_id=p_worker_id,lease_worker_generation=p_worker_generation,
      lease_token=v_claim_token,fencing_epoch=v_fencing_epoch,
      lease_expires_at=v_lease_expires_at,updated_at=v_now
     WHERE id=v_step.id AND tenant_id=v_message.tenant_id AND state='PENDING';
    UPDATE public.commander_tenant_execution_usage SET running_steps=running_steps+1,updated_at=v_now
     WHERE tenant_id=v_message.tenant_id;
    v_claimed := v_claimed || jsonb_build_array(jsonb_build_object(
      'messageId',v_message.id,'tenantId',v_message.tenant_id,'claimToken',v_claim_token,
      'authorization',v_authorization,'lease',jsonb_build_object(
        'workerId',p_worker_id,'workerGeneration',p_worker_generation,
        'token',v_claim_token,'fencingEpoch',v_fencing_epoch)
    ));
  END LOOP;
  RETURN v_claimed;
END
$fn$;

CREATE OR REPLACE FUNCTION public.admit_compensation_effect_v1(p_admission jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_worker public.commander_workers%ROWTYPE;
  v_run public.commander_runs%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_outbox public.commander_outbox%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_authorization jsonb;
  v_request_hash text;
BEGIN
  IF session_user <> 'commander_adapter_ops' OR jsonb_typeof(p_admission) <> 'object' THEN
    RETURN jsonb_build_object('admitted',false,'reason','COMPENSATION_ADMISSION_UNAVAILABLE');
  END IF;
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id=p_admission->>'stepId' AND run_id=p_admission->>'runId'
     AND tenant_id=p_admission->>'tenantId' FOR UPDATE;
  SELECT * INTO v_run FROM public.commander_runs
   WHERE id=p_admission->>'runId' AND tenant_id=p_admission->>'tenantId' FOR UPDATE;
  v_authorization := v_run.metadata #> '{compensation,authorization}';
  SELECT * INTO v_worker FROM public.commander_workers
   WHERE id=p_admission #>> '{lease,workerId}'
     AND generation=(p_admission #>> '{lease,workerGeneration}')::bigint
     AND status='ACTIVE' AND identity_subject='db:commander_adapter_ops'
     AND capabilities='["effect.compensate"]'::jsonb
     AND tenant_ids ? (p_admission->>'tenantId') FOR UPDATE;
  SELECT * INTO v_outbox FROM public.commander_outbox
   WHERE tenant_id=p_admission->>'tenantId'
     AND topic='commander.kernel.compensation.requested'
     AND claim_token=p_admission #>> '{compensationBinding,claimToken}'
     AND published_at IS NULL FOR UPDATE;
  IF v_run.id IS NULL OR v_step.id IS NULL OR v_worker.id IS NULL OR v_outbox.id IS NULL
     OR v_run.state <> 'RUNNING' OR v_step.state <> 'RUNNING'
     OR v_step.input->'authorization' IS DISTINCT FROM v_authorization
     OR v_outbox.payload IS DISTINCT FROM v_authorization
     OR v_step.lease_worker_id IS DISTINCT FROM p_admission #>> '{lease,workerId}'
     OR v_step.lease_worker_generation <> (p_admission #>> '{lease,workerGeneration}')::bigint
     OR v_step.lease_token IS DISTINCT FROM p_admission #>> '{lease,token}'
     OR v_step.fencing_epoch <> (p_admission #>> '{lease,fencingEpoch}')::bigint
     OR v_step.lease_expires_at <= clock_timestamp()
     OR p_admission #>> '{compensationBinding,authorizationId}' IS DISTINCT FROM v_authorization->>'authorizationId'
     OR p_admission #>> '{compensationBinding,requestId}' IS DISTINCT FROM v_authorization->>'requestId'
     OR p_admission->>'id' IS DISTINCT FROM v_authorization->>'compensationEffectId'
     OR p_admission->>'type' IS DISTINCT FROM v_authorization->>'compensationEffectType'
     OR p_admission->>'idempotencyKey' IS DISTINCT FROM v_authorization->>'idempotencyKey'
     OR p_admission->>'policyDecisionId' IS DISTINCT FROM v_authorization->>'policyDecisionId'
     OR p_admission->>'policySnapshotId' IS DISTINCT FROM v_authorization->>'policySnapshotId'
     OR p_admission->>'actionDigest' IS DISTINCT FROM v_authorization->>'actionDigest'
     OR p_admission->'request' IS DISTINCT FROM v_authorization->'compensationRequest' THEN
    RETURN jsonb_build_object('admitted',false,'reason','COMPENSATION_ADMISSION_UNAVAILABLE');
  END IF;
  v_request_hash := public.commander_compensation_hash_v1(p_admission->'request');
  IF v_request_hash IS DISTINCT FROM v_authorization->>'requestHash' THEN
    RETURN jsonb_build_object('admitted',false,'reason','COMPENSATION_ADMISSION_UNAVAILABLE');
  END IF;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE tenant_id=p_admission->>'tenantId' AND idempotency_key=p_admission->>'idempotencyKey'
   FOR UPDATE;
  IF FOUND THEN
    IF v_effect.id=p_admission->>'id' AND v_effect.run_id=p_admission->>'runId'
       AND v_effect.step_id=p_admission->>'stepId' AND v_effect.type=p_admission->>'type'
       AND v_effect.request_hash=v_request_hash
       AND v_effect.policy_decision_id=p_admission->>'policyDecisionId'
       AND v_effect.policy_snapshot_id=p_admission->>'policySnapshotId'
       AND v_effect.action_digest=p_admission->>'actionDigest' THEN
      RETURN jsonb_build_object('admitted',true,'replayed',true,'effect',to_jsonb(v_effect));
    END IF;
    RETURN jsonb_build_object('admitted',false,'reason','IDEMPOTENCY_CONFLICT');
  END IF;
  INSERT INTO public.commander_effects(
    id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,
    policy_snapshot_id,action_digest,lease_worker_id,lease_worker_generation,
    lease_fencing_epoch,state,request
  ) VALUES (
    p_admission->>'id',p_admission->>'runId',p_admission->>'stepId',p_admission->>'tenantId',
    p_admission->>'type',p_admission->>'idempotencyKey',v_request_hash,
    p_admission->>'policyDecisionId',p_admission->>'policySnapshotId',p_admission->>'actionDigest',
    p_admission #>> '{lease,workerId}',(p_admission #>> '{lease,workerGeneration}')::bigint,
    (p_admission #>> '{lease,fencingEpoch}')::bigint,'ADMITTED',p_admission->'request'
  ) RETURNING * INTO v_effect;
  RETURN jsonb_build_object('admitted',true,'replayed',false,'effect',to_jsonb(v_effect));
END
$fn$;

CREATE OR REPLACE FUNCTION public.apply_compensation_work_disposition_v1(
  p_disposition text,p_tenant_id text,p_message_id text,p_outbox_claim_token text,
  p_compensation_effect_id text,p_worker_id text,p_worker_generation bigint,
  p_claim_secret text,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_worker_tenants jsonb;
  v_outbox public.commander_outbox%ROWTYPE;
  v_run public.commander_runs%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_original_run public.commander_runs%ROWTYPE;
  v_authorization jsonb;
  v_token_hash bytea := sha256(convert_to(p_outbox_claim_token,'UTF8'));
  v_fingerprint bytea;
  v_receipt public.commander_compensation_mutation_receipts%ROWTYPE;
  v_result jsonb;
  v_event_id text;
  v_sequence bigint;
BEGIN
  IF session_user <> 'commander_adapter_ops'
     OR p_disposition NOT IN ('COMPLETED','HANDOFF_UNKNOWN','ESCALATED')
     OR NULLIF(p_tenant_id,'') IS NULL OR NULLIF(p_message_id,'') IS NULL
     OR NULLIF(p_outbox_claim_token,'') IS NULL OR NULLIF(p_compensation_effect_id,'') IS NULL
     OR NULLIF(p_worker_id,'') IS NULL OR p_worker_generation <= 0
     OR NULLIF(p_claim_secret,'') IS NULL OR p_payload IS NULL THEN
    RETURN jsonb_build_object('applied',false,'reason','WORKER_FENCED');
  END IF;
  v_fingerprint := sha256(convert_to(public.commander_compensation_canonical_json_v1(
    jsonb_build_object('disposition',p_disposition,'payload',p_payload)),'UTF8'));
  SELECT * INTO v_receipt FROM public.commander_compensation_mutation_receipts
   WHERE message_id=p_message_id FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.tenant_id=p_tenant_id AND v_receipt.compensation_effect_id=p_compensation_effect_id
       AND v_receipt.claim_token_hash=v_token_hash AND v_receipt.request_fingerprint=v_fingerprint
       AND v_receipt.disposition=p_disposition THEN
      RETURN v_receipt.result || jsonb_build_object('replayed',true);
    END IF;
    RETURN jsonb_build_object('applied',false,'reason','CLAIM_REPLAY_CONFLICT');
  END IF;
  SELECT w.tenant_ids INTO v_worker_tenants FROM public.commander_workers AS w
    JOIN public.commander_worker_claim_secrets AS secret
      ON secret.worker_id=w.id AND secret.generation=w.generation
   WHERE w.id=p_worker_id AND w.generation=p_worker_generation AND w.status='ACTIVE'
     AND w.identity_subject='db:commander_adapter_ops'
     AND w.capabilities='["effect.compensate"]'::jsonb
     AND secret.secret_hash=sha256(convert_to(p_claim_secret,'UTF8'));
  IF NOT FOUND OR v_worker_tenants ? '*' OR NOT (v_worker_tenants ? p_tenant_id) THEN
    RETURN jsonb_build_object('applied',false,'reason','WORKER_FENCED');
  END IF;
  SELECT * INTO v_outbox FROM public.commander_outbox
   WHERE id=p_message_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR v_outbox.published_at IS NOT NULL
     OR v_outbox.claim_token IS DISTINCT FROM p_outbox_claim_token THEN
    RETURN jsonb_build_object('applied',false,'reason','CLAIM_NOT_OWNED');
  END IF;
  v_authorization := v_outbox.payload;
  IF v_authorization->>'compensationEffectId' IS DISTINCT FROM p_compensation_effect_id THEN
    RETURN jsonb_build_object('applied',false,'reason','NOT_FOUND');
  END IF;
  SELECT * INTO v_run FROM public.commander_runs
   WHERE id=v_authorization->>'compensationRunId' AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id=v_authorization->>'compensationStepId'
     AND run_id=v_authorization->>'compensationRunId' AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT * INTO v_original_run FROM public.commander_runs
   WHERE id=v_authorization->>'originalRunId' AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id=p_compensation_effect_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF v_run.id IS NULL OR v_step.id IS NULL OR v_original_run.id IS NULL
     OR v_run.metadata #> '{compensation,authorization}' IS DISTINCT FROM v_authorization
     OR v_step.input->'authorization' IS DISTINCT FROM v_authorization
     OR NOT (
       (v_step.lease_worker_id=p_worker_id
        AND v_step.lease_worker_generation=p_worker_generation
        AND v_step.lease_token=p_outbox_claim_token
        AND v_step.lease_expires_at > v_now)
       OR
       (v_effect.id IS NOT NULL
        AND v_effect.lease_worker_id=p_worker_id
        AND v_effect.lease_worker_generation=p_worker_generation
        AND v_effect.lease_fencing_epoch=v_step.fencing_epoch)
     ) THEN
    RETURN jsonb_build_object('applied',false,'reason','CLAIM_NOT_OWNED');
  END IF;

  IF p_disposition='COMPLETED' THEN
    IF v_effect.id IS NULL OR v_effect.state <> 'COMPLETED' THEN
      RETURN jsonb_build_object('applied',false,'reason','EFFECT_NOT_COMPLETED');
    END IF;
    UPDATE public.commander_steps SET state='SUCCEEDED',output=p_payload,error=NULL,
      version=version+1,lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,
      lease_expires_at=NULL,updated_at=v_now WHERE id=v_step.id AND tenant_id=p_tenant_id;
    UPDATE public.commander_runs SET state='SUCCEEDED',version=version+1,updated_at=v_now,
      terminal_at=v_now,metadata=jsonb_set(metadata,'{compensation,disposition}','"COMPLETED"'::jsonb,true)
     WHERE id=v_run.id AND tenant_id=p_tenant_id;
    UPDATE public.commander_runs SET state='COMPENSATED',version=version+1,updated_at=v_now,terminal_at=v_now
     WHERE id=v_original_run.id AND tenant_id=p_tenant_id AND state='COMPENSATING';
  ELSIF p_disposition='HANDOFF_UNKNOWN' THEN
    IF v_effect.id IS NULL OR v_effect.state <> 'COMPLETION_UNKNOWN' THEN
      RETURN jsonb_build_object('applied',false,'reason','EFFECT_NOT_UNKNOWN');
    END IF;
    UPDATE public.commander_steps SET state='WAITING_FOR_RECONCILIATION',version=version+1,
      lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL,
      updated_at=v_now WHERE id=v_step.id AND tenant_id=p_tenant_id;
    UPDATE public.commander_runs SET metadata=jsonb_set(metadata,'{compensation,disposition}',
      '"HANDOFF_UNKNOWN"'::jsonb,true),version=version+1,updated_at=v_now
     WHERE id=v_run.id AND tenant_id=p_tenant_id;
  ELSE
    IF v_effect.id IS NOT NULL AND v_effect.state='ADMITTED' THEN
      UPDATE public.commander_effects SET state='FAILED',response=jsonb_build_object('reason',p_payload),
        completed_at=v_now WHERE id=v_effect.id AND tenant_id=p_tenant_id;
    END IF;
    UPDATE public.commander_steps SET state='FAILED',error=jsonb_build_object(
      'code',trim(both '"' from p_payload::text),'message','Governed compensation was escalated',
      'retryable',false),version=version+1,lease_worker_id=NULL,lease_worker_generation=0,
      lease_token=NULL,lease_expires_at=NULL,updated_at=v_now
     WHERE id=v_step.id AND tenant_id=p_tenant_id;
    UPDATE public.commander_runs SET state='FAILED',version=version+1,updated_at=v_now,terminal_at=v_now,
      metadata=jsonb_set(jsonb_set(metadata,'{compensation,disposition}','"ESCALATED"'::jsonb,true),
        '{compensation,escalationReason}',p_payload,true)
     WHERE id=v_run.id AND tenant_id=p_tenant_id;
    UPDATE public.commander_runs SET state='FAILED',version=version+1,updated_at=v_now,terminal_at=v_now
     WHERE id=v_original_run.id AND tenant_id=p_tenant_id AND state='COMPENSATING';
  END IF;
  UPDATE public.commander_tenant_execution_usage SET running_steps=GREATEST(0,running_steps-1),updated_at=v_now
   WHERE tenant_id=p_tenant_id;
  UPDATE public.commander_outbox SET published_at=v_now,claimed_at=NULL,claim_token=NULL
   WHERE id=p_message_id;
  SELECT COALESCE(max(sequence),0)+1 INTO v_sequence FROM public.commander_events
   WHERE aggregate_type='effect' AND aggregate_id=p_compensation_effect_id;
  v_event_id := gen_random_uuid()::text;
  INSERT INTO public.commander_events(
    id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,actor,schema_version,payload
  ) VALUES (
    v_event_id,'effect',p_compensation_effect_id,v_sequence,
    CASE p_disposition WHEN 'COMPLETED' THEN 'compensation.completed'
      WHEN 'HANDOFF_UNKNOWN' THEN 'compensation.handed_off_unknown' ELSE 'compensation.escalated' END,
    p_tenant_id,v_run.id,v_step.id,p_worker_id,'v2',jsonb_build_object(
      'disposition',p_disposition,'originalRunId',v_original_run.id,'originalEffectId',
      v_authorization->>'originalEffectId','compensationRunId',v_run.id,
      'compensationEffectId',p_compensation_effect_id,'payload',p_payload)
  );
  v_result := jsonb_build_object('applied',true,'disposition',p_disposition,'replayed',false);
  INSERT INTO public.commander_compensation_mutation_receipts(
    message_id,tenant_id,compensation_effect_id,claim_token_hash,request_fingerprint,disposition,result
  ) VALUES(p_message_id,p_tenant_id,p_compensation_effect_id,v_token_hash,v_fingerprint,p_disposition,v_result);
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.complete_compensation_work_v1(
  p_tenant_id text,p_message_id text,p_outbox_claim_token text,p_compensation_effect_id text,
  p_worker_id text,p_worker_generation bigint,p_claim_secret text,p_response jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.apply_compensation_work_disposition_v1('COMPLETED',p_tenant_id,p_message_id,
    p_outbox_claim_token,p_compensation_effect_id,p_worker_id,p_worker_generation,p_claim_secret,p_response)
$fn$;
CREATE OR REPLACE FUNCTION public.handoff_compensation_unknown_v1(
  p_tenant_id text,p_message_id text,p_outbox_claim_token text,p_compensation_effect_id text,
  p_worker_id text,p_worker_generation bigint,p_claim_secret text,p_error jsonb
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.apply_compensation_work_disposition_v1('HANDOFF_UNKNOWN',p_tenant_id,p_message_id,
    p_outbox_claim_token,p_compensation_effect_id,p_worker_id,p_worker_generation,p_claim_secret,p_error)
$fn$;
CREATE OR REPLACE FUNCTION public.escalate_compensation_work_v1(
  p_tenant_id text,p_message_id text,p_outbox_claim_token text,p_compensation_effect_id text,
  p_worker_id text,p_worker_generation bigint,p_claim_secret text,p_reason text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.apply_compensation_work_disposition_v1('ESCALATED',p_tenant_id,p_message_id,
    p_outbox_claim_token,p_compensation_effect_id,p_worker_id,p_worker_generation,p_claim_secret,to_jsonb(p_reason))
$fn$;

REVOKE ALL ON FUNCTION public.claim_compensation_work_v1(text,bigint,text,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_compensation_effect_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_compensation_work_disposition_v1(text,text,text,text,text,text,bigint,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_compensation_work_v1(text,text,text,text,text,bigint,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handoff_compensation_unknown_v1(text,text,text,text,text,bigint,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.escalate_compensation_work_v1(text,text,text,text,text,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_compensation_work_v1(text,bigint,text,integer,timestamptz) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.admit_compensation_effect_v1(jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.complete_compensation_work_v1(text,text,text,text,text,bigint,text,jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.handoff_compensation_unknown_v1(text,text,text,text,text,bigint,text,jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.escalate_compensation_work_v1(text,text,text,text,text,bigint,text,text) TO commander_adapter_ops;
`;

const KERNEL_COMPENSATION_AUTHORITY_V2_SQL = String.raw`
CREATE TABLE IF NOT EXISTS public.commander_compensation_authorizations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  original_run_id text NOT NULL REFERENCES public.commander_runs(id) ON DELETE RESTRICT,
  original_effect_id text NOT NULL REFERENCES public.commander_effects(id) ON DELETE RESTRICT,
  compensation_effect_type text NOT NULL CHECK (compensation_effect_type LIKE 'compensate.%'),
  adapter_version text NOT NULL,
  compensation_patch jsonb NOT NULL,
  forward_receipt_hash text NOT NULL CHECK (forward_receipt_hash ~ '^[a-f0-9]{64}$'),
  policy_decision_id text NOT NULL,
  policy_snapshot_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','require_approval','deny')),
  action_digest text NOT NULL CHECK (action_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  approval_interaction_id text REFERENCES public.commander_interactions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, original_effect_id, adapter_version, action_digest)
);

CREATE TABLE IF NOT EXISTS public.commander_compensation_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  original_run_id text NOT NULL REFERENCES public.commander_runs(id) ON DELETE RESTRICT,
  original_effect_id text NOT NULL REFERENCES public.commander_effects(id) ON DELETE RESTRICT,
  compensation_run_id text NOT NULL REFERENCES public.commander_runs(id) ON DELETE RESTRICT,
  compensation_step_id text NOT NULL REFERENCES public.commander_steps(id) ON DELETE RESTRICT,
  adapter_version text NOT NULL,
  compensation_effect_type text NOT NULL,
  compensation_patch jsonb NOT NULL,
  forward_receipt_hash text NOT NULL,
  authorization_id text NOT NULL REFERENCES public.commander_compensation_authorizations(id) ON DELETE RESTRICT,
  reconcile_policy jsonb NOT NULL,
  state text NOT NULL CHECK (state IN (
    'AUTHORIZED','CLAIMED','COMPLETION_UNKNOWN','COMPLETED','CONFIRMED_NOT_APPLIED','ESCALATED'
  )),
  claim_worker_id text,
  claim_worker_generation bigint,
  claim_token text,
  claim_expires_at timestamptz,
  compensation_effect_id text,
  escalation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (authorization_id)
);

CREATE OR REPLACE FUNCTION public.create_compensation_authorization(p_authorization jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_existing public.commander_compensation_authorizations%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_expected_digest text;
BEGIN
  IF session_user <> 'commander_app' OR jsonb_typeof(p_authorization) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_authorization)) NOT IN (13,14)
     OR NOT p_authorization ?& ARRAY[
       'id','tenantId','originalRunId','originalEffectId','compensationEffectType','adapterVersion',
       'compensationPatch','forwardReceiptHash','policyDecisionId','policySnapshotId','decision',
       'actionDigest','expiresAt'
     ] THEN
    RAISE EXCEPTION 'COMPENSATION_AUTHORIZATION_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id=p_authorization->>'originalEffectId'
     AND run_id=p_authorization->>'originalRunId'
     AND tenant_id=p_authorization->>'tenantId'
     AND state='COMPLETED' AND type NOT LIKE 'compensate.%';
  IF NOT FOUND THEN RAISE EXCEPTION 'FORWARD_EFFECT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF public.commander_compensation_hash_v1(COALESCE(v_effect.response,'{}'::jsonb))
       IS DISTINCT FROM p_authorization->>'forwardReceiptHash' THEN
    RAISE EXCEPTION 'FORWARD_RECEIPT_MISMATCH' USING ERRCODE='22023';
  END IF;
  v_expected_digest := public.commander_compensation_hash_v1(jsonb_build_object(
    'type',p_authorization->>'compensationEffectType',
    'originalEffectId',p_authorization->>'originalEffectId',
    'adapterVersion',p_authorization->>'adapterVersion',
    'forwardResponse',COALESCE(v_effect.response,'{}'::jsonb),
    'compensationPatch',p_authorization->'compensationPatch'
  ));
  IF v_expected_digest IS DISTINCT FROM p_authorization->>'actionDigest' THEN
    RAISE EXCEPTION 'ACTION_DIGEST_MISMATCH' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM public.commander_compensation_authorizations
   WHERE id=p_authorization->>'id' FOR UPDATE;
  IF FOUND THEN
    IF to_jsonb(v_existing)-'created_at' IS DISTINCT FROM jsonb_build_object(
      'id',p_authorization->>'id','tenant_id',p_authorization->>'tenantId',
      'original_run_id',p_authorization->>'originalRunId','original_effect_id',p_authorization->>'originalEffectId',
      'compensation_effect_type',p_authorization->>'compensationEffectType','adapter_version',p_authorization->>'adapterVersion',
      'compensation_patch',p_authorization->'compensationPatch','forward_receipt_hash',p_authorization->>'forwardReceiptHash',
      'policy_decision_id',p_authorization->>'policyDecisionId','policy_snapshot_id',p_authorization->>'policySnapshotId',
      'decision',p_authorization->>'decision','action_digest',p_authorization->>'actionDigest',
      'expires_at',(p_authorization->>'expiresAt')::timestamptz,
      'approval_interaction_id',NULLIF(p_authorization->>'approvalInteractionId','')
    ) THEN
      RAISE EXCEPTION 'COMPENSATION_AUTHORIZATION_CONFLICT' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('authorization',p_authorization,'replayed',true);
  END IF;
  INSERT INTO public.commander_compensation_authorizations(
    id,tenant_id,original_run_id,original_effect_id,compensation_effect_type,adapter_version,
    compensation_patch,forward_receipt_hash,policy_decision_id,policy_snapshot_id,decision,
    action_digest,expires_at,approval_interaction_id
  ) VALUES (
    p_authorization->>'id',p_authorization->>'tenantId',p_authorization->>'originalRunId',
    p_authorization->>'originalEffectId',p_authorization->>'compensationEffectType',
    p_authorization->>'adapterVersion',p_authorization->'compensationPatch',
    p_authorization->>'forwardReceiptHash',p_authorization->>'policyDecisionId',
    p_authorization->>'policySnapshotId',p_authorization->>'decision',p_authorization->>'actionDigest',
    (p_authorization->>'expiresAt')::timestamptz,NULLIF(p_authorization->>'approvalInteractionId','')
  );
  RETURN jsonb_build_object('authorization',p_authorization,'replayed',false);
END
$fn$;

CREATE OR REPLACE FUNCTION public.request_compensation(p_tenant_id text,p_authorization_id text,p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_auth public.commander_compensation_authorizations%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_approval public.commander_interactions%ROWTYPE;
  v_request public.commander_compensation_requests%ROWTYPE;
  v_request_id text;
  v_run_id text;
  v_step_id text;
  v_event_id text;
  v_outbox_id text;
  v_reason text;
  v_reconcile_policy jsonb;
BEGIN
  IF session_user <> 'commander_app' OR NULLIF(p_tenant_id,'') IS NULL
     OR NULLIF(p_authorization_id,'') IS NULL OR NULLIF(p_actor,'') IS NULL THEN
    RETURN jsonb_build_object('accepted',false,'requestId','request_invalid','reason','AUTHORIZATION_NOT_FOUND');
  END IF;
  SELECT * INTO v_auth FROM public.commander_compensation_authorizations
   WHERE id=p_authorization_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN
    v_request_id := 'request_'||substr(public.commander_compensation_hash_v1(
      jsonb_build_object('tenantId',p_tenant_id,'authorizationId',p_authorization_id)),1,40);
    RETURN jsonb_build_object('accepted',false,'requestId',v_request_id,'reason','AUTHORIZATION_NOT_FOUND');
  END IF;
  v_request_id := 'request_'||substr(public.commander_compensation_hash_v1(jsonb_build_object(
    'tenantId',v_auth.tenant_id,'originalEffectId',v_auth.original_effect_id,
    'adapterVersion',v_auth.adapter_version,'actionDigest',v_auth.action_digest)),1,40);
  SELECT * INTO v_request FROM public.commander_compensation_requests WHERE id=v_request_id;
  IF FOUND THEN
    IF v_request.authorization_id<>v_auth.id THEN
      RETURN jsonb_build_object('accepted',false,'requestId',v_request_id,'reason','ACTION_DIGEST_MISMATCH');
    END IF;
    RETURN jsonb_build_object('accepted',v_request.state<>'ESCALATED','request',to_jsonb(v_request),'replayed',true,
      'requestId',v_request_id,'reason',v_request.escalation_reason);
  END IF;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id=v_auth.original_effect_id AND run_id=v_auth.original_run_id AND tenant_id=v_auth.tenant_id
     AND state='COMPLETED' AND type NOT LIKE 'compensate.%';
  IF NOT FOUND THEN v_reason := 'FORWARD_EFFECT_NOT_FOUND';
  ELSIF public.commander_compensation_hash_v1(COALESCE(v_effect.response,'{}'::jsonb))<>v_auth.forward_receipt_hash
    THEN v_reason := 'FORWARD_RECEIPT_MISMATCH';
  ELSIF public.commander_compensation_hash_v1(jsonb_build_object(
      'type',v_auth.compensation_effect_type,'originalEffectId',v_auth.original_effect_id,
      'adapterVersion',v_auth.adapter_version,'forwardResponse',COALESCE(v_effect.response,'{}'::jsonb),
      'compensationPatch',v_auth.compensation_patch))<>v_auth.action_digest
    THEN v_reason := 'ACTION_DIGEST_MISMATCH';
  ELSIF v_auth.decision='deny' THEN v_reason := 'POLICY_DENIED';
  ELSIF v_auth.expires_at<=v_now THEN v_reason := 'AUTHORIZATION_EXPIRED';
  ELSIF v_auth.decision='require_approval' AND v_auth.approval_interaction_id IS NULL
    THEN v_reason := 'APPROVAL_REQUIRED';
  ELSIF v_auth.decision='require_approval' THEN
    SELECT * INTO v_approval FROM public.commander_interactions
     WHERE id=v_auth.approval_interaction_id AND tenant_id=v_auth.tenant_id
       AND run_id=v_auth.original_run_id AND status='answered' AND expires_at>v_now;
    IF NOT FOUND OR v_approval.response->>'approved'<>'true'
       OR v_approval.response->>'authorizationId'<>v_auth.id
       OR v_approval.response->>'originalEffectId'<>v_auth.original_effect_id
       OR v_approval.response->>'actionDigest'<>v_auth.action_digest
       OR v_approval.response->>'policyDecisionId'<>v_auth.policy_decision_id
       OR v_approval.response->>'policySnapshotId'<>v_auth.policy_snapshot_id THEN
      v_reason := 'APPROVAL_BINDING_MISMATCH';
    END IF;
  END IF;
  v_run_id := 'run_'||substr(public.commander_compensation_hash_v1(
    jsonb_build_object('requestId',v_request_id,'purpose','compensation')),1,40);
  v_step_id := 'step_'||substr(public.commander_compensation_hash_v1(
    jsonb_build_object('requestId',v_request_id,'purpose','compensation')),1,32);
  v_reconcile_policy := jsonb_build_object('maxAttempts',8,'initialDelayMs',30000,
    'maxDelayMs',900000,'deadlineAt',(v_now+interval '24 hours')::text);
  IF v_reason IS NOT NULL THEN
    INSERT INTO public.commander_runs(
      id,tenant_id,intent_hash,work_graph_hash,work_graph_version,policy_snapshot_id,state,metadata,terminal_at
    ) VALUES (
      v_run_id,v_auth.tenant_id,public.commander_compensation_hash_v1(jsonb_build_object('requestId',v_request_id,'purpose','intent')),
      public.commander_compensation_hash_v1(jsonb_build_object('stepId',v_step_id)),'action-gateway-compensation/v2',
      v_auth.policy_snapshot_id,'FAILED',jsonb_build_object('compensationRequestId',v_request_id,
        'authorizationId',v_auth.id,'escalationReason',v_reason),v_now
    );
    INSERT INTO public.commander_steps(id,run_id,tenant_id,kind,state,input,error)
      VALUES(v_step_id,v_run_id,v_auth.tenant_id,'tool','FAILED',jsonb_build_object('requestId',v_request_id),
        jsonb_build_object('code',v_reason,'message','Compensation authorization is not executable','retryable',false));
    INSERT INTO public.commander_compensation_requests(
      id,tenant_id,original_run_id,original_effect_id,compensation_run_id,compensation_step_id,
      adapter_version,compensation_effect_type,compensation_patch,forward_receipt_hash,
      authorization_id,reconcile_policy,state,escalation_reason
    ) VALUES (
      v_request_id,v_auth.tenant_id,v_auth.original_run_id,v_auth.original_effect_id,v_run_id,v_step_id,
      v_auth.adapter_version,v_auth.compensation_effect_type,v_auth.compensation_patch,v_auth.forward_receipt_hash,
      v_auth.id,v_reconcile_policy,'ESCALATED',v_reason
    );
    v_event_id:=gen_random_uuid()::text;
    INSERT INTO public.commander_events(
      id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,actor,schema_version,payload
    ) VALUES(v_event_id,'effect',v_request_id,1,'compensation.authorization_escalated',v_auth.tenant_id,
      v_run_id,v_step_id,p_actor,'v2',jsonb_build_object('requestId',v_request_id,'authorizationId',v_auth.id,'reason',v_reason));
    RETURN jsonb_build_object('accepted',false,'requestId',v_request_id,'reason',v_reason);
  END IF;
  INSERT INTO public.commander_runs(
    id,tenant_id,intent_hash,work_graph_hash,work_graph_version,policy_snapshot_id,state,metadata
  ) VALUES (
    v_run_id,v_auth.tenant_id,public.commander_compensation_hash_v1(jsonb_build_object('requestId',v_request_id,'purpose','intent')),
    public.commander_compensation_hash_v1(jsonb_build_object('stepId',v_step_id)),'action-gateway-compensation/v2',
    v_auth.policy_snapshot_id,'PENDING',jsonb_build_object('compensationRequestId',v_request_id,'authorizationId',v_auth.id)
  );
  INSERT INTO public.commander_steps(id,run_id,tenant_id,kind,state,input)
    VALUES(v_step_id,v_run_id,v_auth.tenant_id,'tool','PENDING',jsonb_build_object('requestId',v_request_id));
  INSERT INTO public.commander_compensation_requests(
    id,tenant_id,original_run_id,original_effect_id,compensation_run_id,compensation_step_id,
    adapter_version,compensation_effect_type,compensation_patch,forward_receipt_hash,
    authorization_id,reconcile_policy,state
  ) VALUES (
    v_request_id,v_auth.tenant_id,v_auth.original_run_id,v_auth.original_effect_id,v_run_id,v_step_id,
    v_auth.adapter_version,v_auth.compensation_effect_type,v_auth.compensation_patch,v_auth.forward_receipt_hash,
    v_auth.id,v_reconcile_policy,'AUTHORIZED'
  ) RETURNING * INTO v_request;
  v_event_id := gen_random_uuid()::text;
  INSERT INTO public.commander_events(
    id,aggregate_type,aggregate_id,sequence,type,tenant_id,run_id,step_id,actor,schema_version,payload
  ) VALUES (
    v_event_id,'effect',v_request_id,1,'kernel.compensation.requested',v_auth.tenant_id,v_run_id,v_step_id,
    p_actor,'v2',jsonb_build_object('requestId',v_request_id,'authorizationId',v_auth.id,'actionDigest',v_auth.action_digest)
  );
  v_outbox_id := gen_random_uuid()::text;
  INSERT INTO public.commander_outbox(id,event_id,tenant_id,topic,key,payload)
    VALUES(v_outbox_id,v_event_id,v_auth.tenant_id,'commander.kernel.compensation.requested',v_request_id,
      jsonb_build_object('requestId',v_request_id,'authorizationId',v_auth.id,'tenantId',v_auth.tenant_id,'actionDigest',v_auth.action_digest));
  RETURN jsonb_build_object('accepted',true,'request',to_jsonb(v_request),'replayed',false);
END
$fn$;

CREATE OR REPLACE FUNCTION public.claim_compensation_request(
  p_request_id text,p_outbox_message_id text,p_worker_id text,p_worker_generation bigint,
  p_claim_secret text,p_lease_ttl_ms integer DEFAULT 60000,p_now timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_request public.commander_compensation_requests%ROWTYPE;
  v_auth public.commander_compensation_authorizations%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_outbox public.commander_outbox%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_claim_token text := gen_random_uuid()::text;
  v_fencing_epoch bigint;
  v_expires_at timestamptz;
BEGIN
  IF session_user<>'commander_adapter_ops' OR p_lease_ttl_ms<=0 THEN RETURN NULL; END IF;
  SELECT r.* INTO v_request FROM public.commander_compensation_requests r
    JOIN public.commander_workers w ON w.id=p_worker_id AND w.generation=p_worker_generation
      AND w.status='ACTIVE' AND w.identity_subject='db:commander_adapter_ops'
      AND w.capabilities='["effect.compensate"]'::jsonb AND w.tenant_ids ? r.tenant_id AND NOT (w.tenant_ids ? '*')
    JOIN public.commander_worker_claim_secrets s ON s.worker_id=w.id AND s.generation=w.generation
      AND s.secret_hash=sha256(convert_to(p_claim_secret,'UTF8'))
   WHERE (NULLIF(p_request_id,'') IS NULL OR r.id=p_request_id)
     AND (NULLIF(p_request_id,'') IS NOT NULL OR r.state='AUTHORIZED' OR r.claim_expires_at<=p_now)
   ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1;
  IF NOT FOUND OR v_request.state NOT IN ('AUTHORIZED','CLAIMED')
     OR (v_request.state='CLAIMED' AND v_request.claim_expires_at>p_now AND v_request.claim_worker_id<>p_worker_id)
    THEN RETURN NULL; END IF;
  SELECT * INTO v_auth FROM public.commander_compensation_authorizations
   WHERE id=v_request.authorization_id AND tenant_id=v_request.tenant_id;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id=v_request.original_effect_id AND tenant_id=v_request.tenant_id AND state='COMPLETED';
  SELECT * INTO v_outbox FROM public.commander_outbox
   WHERE (NULLIF(p_outbox_message_id,'') IS NULL OR id=p_outbox_message_id)
     AND tenant_id=v_request.tenant_id
     AND topic='commander.kernel.compensation.requested' AND published_at IS NULL FOR UPDATE;
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id=v_request.compensation_step_id AND tenant_id=v_request.tenant_id FOR UPDATE;
  IF v_auth.id IS NULL OR v_effect.id IS NULL OR v_outbox.id IS NULL OR v_step.id IS NULL
     OR v_outbox.payload<>jsonb_build_object('requestId',v_request.id,'authorizationId',v_auth.id,
       'tenantId',v_auth.tenant_id,'actionDigest',v_auth.action_digest)
     OR public.commander_compensation_hash_v1(COALESCE(v_effect.response,'{}'::jsonb))<>v_auth.forward_receipt_hash
    THEN RETURN NULL; END IF;
  v_fencing_epoch := v_step.fencing_epoch+1;
  v_expires_at := p_now+(p_lease_ttl_ms||' milliseconds')::interval;
  UPDATE public.commander_outbox SET claimed_at=p_now,claim_token=v_claim_token,attempts=attempts+1
   WHERE id=v_outbox.id;
  UPDATE public.commander_compensation_requests SET state='CLAIMED',claim_worker_id=p_worker_id,
    claim_worker_generation=p_worker_generation,claim_token=v_claim_token,claim_expires_at=v_expires_at,
    compensation_effect_id=COALESCE(compensation_effect_id,'effect_'||substr(public.commander_compensation_hash_v1(
      jsonb_build_object('requestId',id,'originalEffectId',original_effect_id)),1,40)),updated_at=p_now
   WHERE id=v_request.id RETURNING * INTO v_request;
  UPDATE public.commander_runs SET state='COMPENSATING',updated_at=p_now
   WHERE id=v_request.compensation_run_id AND tenant_id=v_request.tenant_id AND state IN ('PENDING','COMPENSATING');
  UPDATE public.commander_steps SET state='RUNNING',version=version+1,lease_worker_id=p_worker_id,
    lease_worker_generation=p_worker_generation,lease_token=v_claim_token,fencing_epoch=v_fencing_epoch,
    lease_expires_at=v_expires_at,updated_at=p_now WHERE id=v_step.id;
  RETURN jsonb_build_object('request',jsonb_build_object(
      'id',v_request.id,'tenantId',v_request.tenant_id,'originalRunId',v_request.original_run_id,
      'originalEffectId',v_request.original_effect_id,'compensationRunId',v_request.compensation_run_id,
      'compensationStepId',v_request.compensation_step_id,'adapterVersion',v_request.adapter_version,
      'compensationEffectType',v_request.compensation_effect_type,'compensationPatch',v_request.compensation_patch,
      'forwardReceiptHash',v_request.forward_receipt_hash,'authorizationId',v_request.authorization_id,
      'reconcilePolicy',v_request.reconcile_policy,'state',v_request.state,'claimWorkerId',v_request.claim_worker_id,
      'claimWorkerGeneration',v_request.claim_worker_generation,'claimToken',v_request.claim_token,
      'claimExpiresAt',v_request.claim_expires_at,'compensationEffectId',v_request.compensation_effect_id),
    'authorization',jsonb_strip_nulls(jsonb_build_object(
      'id',v_auth.id,'tenantId',v_auth.tenant_id,'originalRunId',v_auth.original_run_id,
      'originalEffectId',v_auth.original_effect_id,'compensationEffectType',v_auth.compensation_effect_type,
      'adapterVersion',v_auth.adapter_version,'compensationPatch',v_auth.compensation_patch,
      'forwardReceiptHash',v_auth.forward_receipt_hash,'policyDecisionId',v_auth.policy_decision_id,
      'policySnapshotId',v_auth.policy_snapshot_id,'decision',v_auth.decision,'actionDigest',v_auth.action_digest,
      'expiresAt',v_auth.expires_at,'approvalInteractionId',v_auth.approval_interaction_id)),
    'forwardResponse',COALESCE(v_effect.response,'{}'::jsonb),'outboxMessageId',v_outbox.id,
    'outboxClaimToken',v_claim_token,'lease',jsonb_build_object('workerId',p_worker_id,
      'workerGeneration',p_worker_generation,'token',v_claim_token,'fencingEpoch',v_fencing_epoch,
      'expiresAt',v_expires_at));
END
$fn$;

CREATE TABLE IF NOT EXISTS public.commander_compensation_finalization_receipts (
  outbox_message_id text PRIMARY KEY REFERENCES public.commander_outbox(id) ON DELETE RESTRICT,
  request_id text NOT NULL REFERENCES public.commander_compensation_requests(id) ON DELETE RESTRICT,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.admit_compensation_effect(p_admission jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_request public.commander_compensation_requests%ROWTYPE;
  v_auth public.commander_compensation_authorizations%ROWTYPE;
  v_original public.commander_effects%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_outbox public.commander_outbox%ROWTYPE;
  v_request_payload jsonb;
  v_request_hash text;
BEGIN
  IF session_user<>'commander_adapter_ops' OR jsonb_typeof(p_admission)<>'object' THEN
    RETURN jsonb_build_object('admitted',false,'reason','COMPENSATION_ADMISSION_UNAVAILABLE');
  END IF;
  SELECT * INTO v_request FROM public.commander_compensation_requests
   WHERE id=p_admission->>'requestId' AND tenant_id=p_admission->>'tenantId' FOR UPDATE;
  SELECT * INTO v_auth FROM public.commander_compensation_authorizations
   WHERE id=v_request.authorization_id AND tenant_id=v_request.tenant_id;
  SELECT * INTO v_original FROM public.commander_effects
   WHERE id=v_request.original_effect_id AND tenant_id=v_request.tenant_id AND state='COMPLETED';
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id=v_request.compensation_step_id AND tenant_id=v_request.tenant_id FOR UPDATE;
  SELECT * INTO v_outbox FROM public.commander_outbox
   WHERE tenant_id=v_request.tenant_id AND topic='commander.kernel.compensation.requested'
     AND claim_token=p_admission->>'outboxClaimToken' AND published_at IS NULL FOR UPDATE;
  v_request_payload := jsonb_build_object('originalEffectId',v_request.original_effect_id,
    'forwardResponse',COALESCE(v_original.response,'{}'::jsonb),'compensationPatch',v_auth.compensation_patch);
  IF v_request.id IS NULL OR v_auth.id IS NULL OR v_original.id IS NULL OR v_step.id IS NULL OR v_outbox.id IS NULL
     OR v_outbox.payload->>'requestId'<>v_request.id OR v_outbox.payload->>'authorizationId'<>v_auth.id
     OR v_request.state<>'CLAIMED' OR v_request.compensation_effect_id<>p_admission->>'id'
     OR v_request.compensation_run_id<>p_admission->>'runId'
     OR v_request.compensation_step_id<>p_admission->>'stepId'
     OR v_request.claim_token<>p_admission->>'outboxClaimToken'
     OR v_step.state<>'RUNNING' OR v_step.lease_worker_id<>p_admission #>> '{lease,workerId}'
     OR v_step.lease_worker_generation<>(p_admission #>> '{lease,workerGeneration}')::bigint
     OR v_step.lease_token<>p_admission #>> '{lease,token}'
     OR v_step.fencing_epoch<>(p_admission #>> '{lease,fencingEpoch}')::bigint
     OR v_step.lease_expires_at<=clock_timestamp()
     OR p_admission->>'type'<>v_auth.compensation_effect_type
     OR p_admission->>'policyDecisionId'<>v_auth.policy_decision_id
     OR p_admission->>'policySnapshotId'<>v_auth.policy_snapshot_id
     OR p_admission->>'actionDigest'<>v_auth.action_digest
     OR p_admission->'request'<>v_request_payload THEN
    RETURN jsonb_build_object('admitted',false,'reason','COMPENSATION_ADMISSION_UNAVAILABLE');
  END IF;
  v_request_hash := public.commander_compensation_hash_v1(v_request_payload);
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE tenant_id=v_request.tenant_id AND idempotency_key=p_admission->>'idempotencyKey' FOR UPDATE;
  IF FOUND THEN
    IF v_effect.id=v_request.compensation_effect_id AND v_effect.request_hash=v_request_hash
      THEN RETURN jsonb_build_object('admitted',true,'replayed',true,'effect',to_jsonb(v_effect)); END IF;
    RETURN jsonb_build_object('admitted',false,'reason','IDEMPOTENCY_CONFLICT');
  END IF;
  INSERT INTO public.commander_effects(
    id,run_id,step_id,tenant_id,type,idempotency_key,request_hash,policy_decision_id,
    policy_snapshot_id,action_digest,lease_worker_id,lease_worker_generation,lease_fencing_epoch,state,request
  ) VALUES (
    v_request.compensation_effect_id,v_request.compensation_run_id,v_request.compensation_step_id,v_request.tenant_id,
    v_auth.compensation_effect_type,p_admission->>'idempotencyKey',v_request_hash,v_auth.policy_decision_id,
    v_auth.policy_snapshot_id,v_auth.action_digest,v_step.lease_worker_id,v_step.lease_worker_generation,
    v_step.fencing_epoch,'ADMITTED',v_request_payload
  ) RETURNING * INTO v_effect;
  RETURN jsonb_build_object('admitted',true,'replayed',false,'effect',to_jsonb(v_effect));
END
$fn$;

CREATE OR REPLACE FUNCTION public.apply_task3_compensation_mutation(p_input jsonb,p_disposition text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_now timestamptz:=clock_timestamp();
  v_request public.commander_compensation_requests%ROWTYPE;
  v_effect public.commander_effects%ROWTYPE;
  v_step public.commander_steps%ROWTYPE;
  v_outbox public.commander_outbox%ROWTYPE;
  v_receipt public.commander_compensation_finalization_receipts%ROWTYPE;
  v_fingerprint text:=public.commander_compensation_hash_v1(jsonb_build_object('input',p_input,'disposition',p_disposition));
  v_result jsonb;
BEGIN
  IF session_user<>'commander_adapter_ops' OR p_disposition NOT IN
    ('COMPLETED','CONFIRMED_NOT_APPLIED','COMPLETION_UNKNOWN','ESCALATED') THEN
    RETURN jsonb_build_object('applied',false,'reason','WORKER_FENCED');
  END IF;
  SELECT * INTO v_receipt FROM public.commander_compensation_finalization_receipts
   WHERE outbox_message_id=p_input->>'outboxMessageId';
  IF FOUND THEN
    RETURN CASE WHEN v_receipt.fingerprint=v_fingerprint
      THEN v_receipt.result||jsonb_build_object('replayed',true)
      ELSE jsonb_build_object('applied',false,'reason','CLAIM_REPLAY_CONFLICT') END;
  END IF;
  SELECT r.* INTO v_request FROM public.commander_compensation_requests r
    JOIN public.commander_workers w ON w.id=p_input->>'workerId'
      AND w.generation=(p_input->>'workerGeneration')::bigint AND w.status='ACTIVE'
      AND w.identity_subject='db:commander_adapter_ops' AND w.capabilities='["effect.compensate"]'::jsonb
      AND w.tenant_ids ? r.tenant_id AND NOT (w.tenant_ids ? '*')
    JOIN public.commander_worker_claim_secrets s ON s.worker_id=w.id AND s.generation=w.generation
      AND s.secret_hash=sha256(convert_to(p_input->>'claimSecret','UTF8'))
   WHERE r.id=p_input->>'requestId' AND r.tenant_id=p_input->>'tenantId' FOR UPDATE OF r;
  SELECT * INTO v_outbox FROM public.commander_outbox
   WHERE id=p_input->>'outboxMessageId' AND tenant_id=p_input->>'tenantId' FOR UPDATE;
  SELECT * INTO v_step FROM public.commander_steps
   WHERE id=v_request.compensation_step_id AND tenant_id=v_request.tenant_id FOR UPDATE;
  SELECT * INTO v_effect FROM public.commander_effects
   WHERE id=p_input->>'effectId' AND tenant_id=p_input->>'tenantId' FOR UPDATE;
  IF v_request.id IS NULL OR v_outbox.id IS NULL OR v_step.id IS NULL
     OR v_request.compensation_effect_id<>p_input->>'effectId'
     OR v_request.claim_worker_id<>p_input->>'workerId'
     OR v_request.claim_worker_generation<>(p_input->>'workerGeneration')::bigint
     OR v_request.claim_token<>p_input->>'outboxClaimToken'
     OR v_outbox.claim_token<>p_input->>'outboxClaimToken'
     OR NOT ((v_step.lease_token=p_input->>'outboxClaimToken' AND v_step.lease_expires_at>v_now)
       OR (v_effect.id IS NOT NULL
         AND v_effect.lease_worker_id=p_input->>'workerId'
         AND v_effect.lease_worker_generation=(p_input->>'workerGeneration')::bigint
         AND v_effect.lease_fencing_epoch=v_step.fencing_epoch)) THEN
    RETURN jsonb_build_object('applied',false,'reason','CLAIM_NOT_OWNED');
  END IF;
  IF v_effect.id IS NULL THEN
    IF p_disposition<>'ESCALATED' THEN
      RETURN jsonb_build_object('applied',false,'reason','PRE_ADMISSION_ESCALATION_ONLY');
    END IF;
    UPDATE public.commander_compensation_requests SET state='ESCALATED',updated_at=v_now WHERE id=v_request.id;
    UPDATE public.commander_steps SET state='WAITING_FOR_HUMAN',lease_worker_id=NULL,
      lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=v_step.id;
    UPDATE public.commander_runs SET state='COMPENSATING',terminal_at=NULL,updated_at=v_now
      WHERE id=v_request.compensation_run_id;
    UPDATE public.commander_outbox SET published_at=v_now,claimed_at=NULL,claim_token=NULL WHERE id=v_outbox.id;
    v_result:=jsonb_build_object('applied',true,'disposition','ESCALATED','replayed',false);
    INSERT INTO public.commander_compensation_finalization_receipts(outbox_message_id,request_id,fingerprint,result)
      VALUES(v_outbox.id,v_request.id,v_fingerprint,v_result);
    RETURN v_result;
  END IF;
  IF v_request.compensation_effect_id<>v_effect.id THEN
    RETURN jsonb_build_object('applied',false,'reason','CLAIM_NOT_OWNED');
  END IF;
  IF p_disposition='COMPLETION_UNKNOWN' THEN
    IF v_effect.state NOT IN ('ADMITTED','COMPLETION_UNKNOWN') THEN
      RETURN jsonb_build_object('applied',false,'reason','EFFECT_NOT_ADMITTED_OR_UNKNOWN'); END IF;
    UPDATE public.commander_effects SET state='COMPLETION_UNKNOWN',response=p_input->'error',
      reconcile_policy=v_request.reconcile_policy,reconcile_disposition='PENDING',reconcile_after=v_now
     WHERE id=v_effect.id;
    UPDATE public.commander_compensation_requests SET state='COMPLETION_UNKNOWN',updated_at=v_now WHERE id=v_request.id;
    UPDATE public.commander_steps SET state='WAITING_FOR_RECONCILIATION',lease_worker_id=NULL,
      lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=v_step.id;
  ELSIF p_disposition='COMPLETED' THEN
    IF v_effect.state<>'COMPLETED' THEN RETURN jsonb_build_object('applied',false,'reason','EFFECT_NOT_COMPLETED'); END IF;
    UPDATE public.commander_compensation_requests SET state='COMPLETED',updated_at=v_now WHERE id=v_request.id;
    UPDATE public.commander_steps SET state='SUCCEEDED',output=COALESCE(p_input->'response','{}'::jsonb),
      lease_worker_id=NULL,lease_worker_generation=0,lease_token=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=v_step.id;
    UPDATE public.commander_runs SET state='SUCCEEDED',terminal_at=v_now,updated_at=v_now WHERE id=v_request.compensation_run_id;
    UPDATE public.commander_runs SET state='COMPENSATED',terminal_at=v_now,updated_at=v_now
      WHERE id=v_request.original_run_id AND state='COMPENSATING';
  ELSIF p_disposition='CONFIRMED_NOT_APPLIED' THEN
    IF v_effect.state NOT IN ('COMPLETION_UNKNOWN','CONFIRMED_NOT_APPLIED') THEN
      RETURN jsonb_build_object('applied',false,'reason','EFFECT_NOT_UNKNOWN'); END IF;
    UPDATE public.commander_effects SET state='CONFIRMED_NOT_APPLIED',response=COALESCE(p_input->'response','{}'::jsonb),
      completed_at=v_now WHERE id=v_effect.id;
    UPDATE public.commander_compensation_requests SET state='CONFIRMED_NOT_APPLIED',updated_at=v_now WHERE id=v_request.id;
    UPDATE public.commander_steps SET state='FAILED',lease_worker_id=NULL,lease_worker_generation=0,
      lease_token=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=v_step.id;
    UPDATE public.commander_runs SET state='FAILED',terminal_at=v_now,updated_at=v_now WHERE id=v_request.compensation_run_id;
  ELSE
    IF v_effect.state<>'COMPLETION_UNKNOWN' THEN RETURN jsonb_build_object('applied',false,'reason','EFFECT_NOT_UNKNOWN'); END IF;
    UPDATE public.commander_compensation_requests SET state='ESCALATED',updated_at=v_now WHERE id=v_request.id;
    UPDATE public.commander_steps SET state='WAITING_FOR_HUMAN',lease_worker_id=NULL,lease_worker_generation=0,
      lease_token=NULL,lease_expires_at=NULL,updated_at=v_now WHERE id=v_step.id;
    UPDATE public.commander_runs SET state='COMPENSATING',terminal_at=NULL,updated_at=v_now WHERE id=v_request.compensation_run_id;
  END IF;
  UPDATE public.commander_outbox SET published_at=v_now,claimed_at=NULL,claim_token=NULL WHERE id=v_outbox.id;
  v_result:=jsonb_build_object('applied',true,'disposition',p_disposition,'replayed',false);
  INSERT INTO public.commander_compensation_finalization_receipts(outbox_message_id,request_id,fingerprint,result)
    VALUES(v_outbox.id,v_request.id,v_fingerprint,v_result);
  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.park_compensation_unknown(p_input jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $fn$
  SELECT public.apply_task3_compensation_mutation(p_input,'COMPLETION_UNKNOWN')
$fn$;

CREATE OR REPLACE FUNCTION public.finalize_compensation(p_input jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public AS $fn$
  SELECT public.apply_task3_compensation_mutation(p_input,p_input->>'disposition')
$fn$;

-- Task 3 closes the old full-payload authority paths before granting the narrow RPCs.
REVOKE ALL ON FUNCTION public.request_governed_compensation_v1(jsonb,text,text,jsonb) FROM commander_app;
REVOKE ALL ON FUNCTION public.claim_compensation_work_v1(text,bigint,text,integer,timestamptz) FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.admit_compensation_effect_v1(jsonb) FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.complete_compensation_work_v1(text,text,text,text,text,bigint,text,jsonb) FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.handoff_compensation_unknown_v1(text,text,text,text,text,bigint,text,jsonb) FROM commander_adapter_ops;
REVOKE ALL ON FUNCTION public.escalate_compensation_work_v1(text,text,text,text,text,bigint,text,text) FROM commander_adapter_ops;

REVOKE ALL PRIVILEGES ON TABLE public.commander_compensation_authorizations,
  public.commander_compensation_requests,public.commander_compensation_finalization_receipts
  FROM PUBLIC,commander_app,commander_worker,commander_adapter_ops;
REVOKE ALL ON FUNCTION public.create_compensation_authorization(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_compensation(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_compensation_request(text,text,text,bigint,text,integer,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_compensation_effect(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_task3_compensation_mutation(jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.park_compensation_unknown(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_compensation(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_compensation_authorization(jsonb) TO commander_app;
GRANT EXECUTE ON FUNCTION public.request_compensation(text,text,text) TO commander_app;
GRANT EXECUTE ON FUNCTION public.claim_compensation_request(text,text,text,bigint,text,integer,timestamptz) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.admit_compensation_effect(jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.park_compensation_unknown(jsonb) TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.finalize_compensation(jsonb) TO commander_adapter_ops;
`;

export const KERNEL_COMPENSATION_PERSISTENCE_SQL =
  KERNEL_COMPENSATION_REQUEST_SQL +
  KERNEL_COMPENSATION_ADAPTER_OPS_SQL +
  KERNEL_COMPENSATION_AUTHORITY_V2_SQL;
