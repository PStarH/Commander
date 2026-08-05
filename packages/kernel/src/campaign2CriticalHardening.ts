/** Campaign 2 authority closure: authenticated app tenancy and DB-owned claim clocks. */
export const KERNEL_CAMPAIGN2_CRITICAL_HARDENING_SQL = String.raw`
ALTER FUNCTION public.create_compensation_authorization(jsonb)
  RENAME TO create_compensation_authorization_internal_v1;
ALTER FUNCTION public.request_compensation(text,text,text)
  RENAME TO request_compensation_internal_v1;
ALTER FUNCTION public.claim_reconcile_effects(text,bigint,integer,timestamptz,integer,text)
  RENAME TO claim_reconcile_effects_internal_v1;
ALTER FUNCTION public.claim_compensation_request(text,text,text,bigint,text,integer,timestamptz)
  RENAME TO claim_compensation_request_internal_v1;

REVOKE ALL ON FUNCTION public.create_compensation_authorization_internal_v1(jsonb)
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler,
    commander_tenant_authority;
REVOKE ALL ON FUNCTION public.request_compensation_internal_v1(text,text,text)
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler,
    commander_tenant_authority;
REVOKE ALL ON FUNCTION public.claim_reconcile_effects_internal_v1(
  text,bigint,integer,timestamptz,integer,text
) FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler,
  commander_tenant_authority;
REVOKE ALL ON FUNCTION public.claim_compensation_request_internal_v1(
  text,text,text,bigint,text,integer,timestamptz
) FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler,
  commander_tenant_authority;

CREATE FUNCTION public.create_compensation_authorization(p_authorization jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_tenant text;
BEGIN
  IF session_user <> 'commander_app' OR jsonb_typeof(p_authorization) <> 'object' THEN
    RAISE EXCEPTION 'COMPENSATION_AUTHORIZATION_INVALID' USING ERRCODE = '22023';
  END IF;
  v_tenant := public.commander_authenticated_app_tenant();
  IF p_authorization->>'tenantId' IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN public.create_compensation_authorization_internal_v1(p_authorization);
END
$function$;

CREATE FUNCTION public.request_compensation(
  p_tenant_id text,
  p_authorization_id text,
  p_actor text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_tenant text;
BEGIN
  IF session_user <> 'commander_app' THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_tenant := public.commander_authenticated_app_tenant();
  IF p_tenant_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN public.request_compensation_internal_v1(v_tenant, p_authorization_id, p_actor);
END
$function$;

CREATE FUNCTION public.claim_reconcile_effects(
  p_worker_id text,
  p_worker_generation bigint,
  p_limit integer,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_claim_ttl interval := interval '60 seconds';
BEGIN
  RETURN public.claim_reconcile_effects_internal_v1(
    p_worker_id,
    p_worker_generation,
    p_limit,
    v_now,
    (extract(epoch FROM v_claim_ttl) * 1000)::integer,
    p_claim_secret
  );
END
$function$;

CREATE FUNCTION public.claim_compensation_request(
  p_request_id text,
  p_outbox_message_id text,
  p_worker_id text,
  p_worker_generation bigint,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_claim_ttl interval := interval '60 seconds';
BEGIN
  RETURN public.claim_compensation_request_internal_v1(
    p_request_id,
    p_outbox_message_id,
    p_worker_id,
    p_worker_generation,
    p_claim_secret,
    (extract(epoch FROM v_claim_ttl) * 1000)::integer,
    v_now
  );
END
$function$;

ALTER FUNCTION public.create_compensation_authorization(jsonb) OWNER TO commander_owner;
ALTER FUNCTION public.request_compensation(text,text,text) OWNER TO commander_owner;
ALTER FUNCTION public.claim_reconcile_effects(text,bigint,integer,text) OWNER TO commander_owner;
ALTER FUNCTION public.claim_compensation_request(text,text,text,bigint,text) OWNER TO commander_owner;

REVOKE ALL ON FUNCTION public.create_compensation_authorization(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_compensation(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_reconcile_effects(text,bigint,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_compensation_request(text,text,text,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_compensation_authorization(jsonb) TO commander_app;
GRANT EXECUTE ON FUNCTION public.request_compensation(text,text,text) TO commander_app;
GRANT EXECUTE ON FUNCTION public.claim_reconcile_effects(text,bigint,integer,text)
  TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.claim_compensation_request(text,text,text,bigint,text)
  TO commander_adapter_ops;
`;

/** Narrow app read authority for approval-bound compensation metadata. */
export const KERNEL_COMPENSATION_AUTHORIZATION_READ_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.get_compensation_authorization(
  p_tenant_id text,
  p_authorization_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_tenant text;
  v_authorization jsonb;
BEGIN
  IF session_user <> 'commander_app' OR NULLIF(p_authorization_id, '') IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_tenant := public.commander_authenticated_app_tenant();
  IF p_tenant_id IS DISTINCT FROM v_tenant THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'id', auth.id,
    'tenantId', auth.tenant_id,
    'originalRunId', auth.original_run_id,
    'originalEffectId', auth.original_effect_id,
    'compensationEffectType', auth.compensation_effect_type,
    'adapterVersion', auth.adapter_version,
    'compensationPatch', auth.compensation_patch,
    'forwardReceiptHash', auth.forward_receipt_hash,
    'policyDecisionId', auth.policy_decision_id,
    'policySnapshotId', auth.policy_snapshot_id,
    'decision', auth.decision,
    'actionDigest', auth.action_digest,
    'expiresAt', auth.expires_at,
    'approvalInteractionId', auth.approval_interaction_id
  ) INTO v_authorization
  FROM public.commander_compensation_authorizations AS auth
  WHERE auth.id = p_authorization_id
    AND auth.tenant_id = v_tenant;
  RETURN v_authorization;
END
$function$;

ALTER FUNCTION public.get_compensation_authorization(text,text) OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.get_compensation_authorization(text,text)
  FROM PUBLIC, commander_worker, commander_adapter_ops, commander_scheduler,
    commander_tenant_authority;
GRANT EXECUTE ON FUNCTION public.get_compensation_authorization(text,text) TO commander_app;
`;

/** Carries the persisted approval proof into the signed compensation grant. */
export const KERNEL_COMPENSATION_APPROVAL_CLAIM_BINDING_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.claim_compensation_request(
  p_request_id text,
  p_outbox_message_id text,
  p_worker_id text,
  p_worker_generation bigint,
  p_claim_secret text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_claim_ttl interval := interval '60 seconds';
  v_result jsonb;
  v_approval public.commander_interactions%ROWTYPE;
BEGIN
  IF session_user <> 'commander_adapter_ops' THEN
    RETURN NULL;
  END IF;
  v_result := public.claim_compensation_request_internal_v1(
    p_request_id,
    p_outbox_message_id,
    p_worker_id,
    p_worker_generation,
    p_claim_secret,
    (extract(epoch FROM v_claim_ttl) * 1000)::integer,
    v_now
  );
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_result #>> '{authorization,decision}' = 'require_approval' THEN
    SELECT * INTO v_approval
      FROM public.commander_interactions
     WHERE id = v_result #>> '{authorization,approvalInteractionId}'
       AND tenant_id = v_result #>> '{authorization,tenantId}'
       AND run_id = v_result #>> '{authorization,originalRunId}'
       AND status = 'answered';
    IF NOT FOUND
       OR v_approval.response->>'approved' <> 'true'
       OR NULLIF(v_approval.response->>'approvedBy', '') IS NULL
       OR v_approval.response->>'authorizationId' IS DISTINCT FROM v_result #>> '{authorization,id}'
       OR v_approval.response->>'originalEffectId' IS DISTINCT FROM v_result #>> '{authorization,originalEffectId}'
       OR v_approval.response->>'actionDigest' IS DISTINCT FROM v_result #>> '{authorization,actionDigest}'
       OR v_approval.response->>'policyDecisionId' IS DISTINCT FROM v_result #>> '{authorization,policyDecisionId}'
       OR v_approval.response->>'policySnapshotId' IS DISTINCT FROM v_result #>> '{authorization,policySnapshotId}'
       OR v_approval.expires_at <= v_now THEN
      RAISE EXCEPTION 'COMPENSATION_APPROVAL_BINDING_INVALID' USING ERRCODE = '22023';
    END IF;
    v_result := jsonb_set(
      v_result,
      '{authorization,approvalBinding}',
      jsonb_build_object(
        'approvalId', v_approval.id,
        'approverPrincipalId', v_approval.response->>'approvedBy',
        'actionDigest', v_result #>> '{authorization,actionDigest}',
        'policySnapshotId', v_result #>> '{authorization,policySnapshotId}',
        'expiresAt', LEAST(
          (v_result #>> '{authorization,expiresAt}')::timestamptz,
          v_approval.expires_at
        )
      ),
      true
    );
  ELSE
    v_result := jsonb_set(v_result, '{authorization,approvalBinding}', 'null'::jsonb, true);
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.claim_compensation_request(text,text,text,bigint,text)
  OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.claim_compensation_request(text,text,text,bigint,text)
  FROM PUBLIC, commander_app, commander_worker, commander_scheduler, commander_tenant_authority;
GRANT EXECUTE ON FUNCTION public.claim_compensation_request(text,text,text,bigint,text)
  TO commander_adapter_ops;
`;

/** Keeps durable capability verification on owner-owned RPCs for adapter-ops. */
export const KERNEL_ADAPTER_OPS_CAPABILITY_STORES_SQL = String.raw`
CREATE FUNCTION public.is_adapter_ops_capability_revoked(
  p_jti text,
  p_tenant_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF session_user <> 'commander_adapter_ops'
     OR NULLIF(p_jti, '') IS NULL
     OR NULLIF(p_tenant_id, '') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.commander_workers AS worker
        WHERE worker.identity_subject = 'db:commander_adapter_ops'
          AND worker.status = 'ACTIVE'
          AND worker.tenant_ids ? p_tenant_id
          AND worker.capabilities IN (
            '["effect.reconcile"]'::jsonb,
            '["effect.compensate"]'::jsonb
          )
     ) THEN
    RAISE EXCEPTION 'ADAPTER_OPS_CAPABILITY_AUTHORITY_REJECTED' USING ERRCODE = '42501';
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.commander_capability_revocations
     WHERE tenant_id = p_tenant_id
       AND jti = p_jti
       AND expires_at > clock_timestamp()
  );
END
$function$;

CREATE FUNCTION public.consume_adapter_ops_capability_replay(
  p_tenant_id text,
  p_jti text,
  p_nonce text,
  p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_inserted integer;
BEGIN
  IF session_user <> 'commander_adapter_ops'
     OR NULLIF(p_tenant_id, '') IS NULL
     OR NULLIF(p_jti, '') IS NULL
     OR NULLIF(p_nonce, '') IS NULL
     OR p_expires_at <= clock_timestamp()
     OR NOT EXISTS (
       SELECT 1
         FROM public.commander_workers AS worker
        WHERE worker.identity_subject = 'db:commander_adapter_ops'
          AND worker.status = 'ACTIVE'
          AND worker.tenant_ids ? p_tenant_id
          AND worker.capabilities IN (
            '["effect.reconcile"]'::jsonb,
            '["effect.compensate"]'::jsonb
          )
     ) THEN
    RAISE EXCEPTION 'ADAPTER_OPS_CAPABILITY_AUTHORITY_REJECTED' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.commander_capability_replays (tenant_id, jti, nonce, expires_at)
  VALUES (p_tenant_id, p_jti, p_nonce, p_expires_at)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 0;
END
$function$;

ALTER FUNCTION public.is_adapter_ops_capability_revoked(text,text) OWNER TO commander_owner;
ALTER FUNCTION public.consume_adapter_ops_capability_replay(text,text,text,timestamptz)
  OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.is_adapter_ops_capability_revoked(text,text)
  FROM PUBLIC, commander_app, commander_worker, commander_scheduler, commander_tenant_authority;
REVOKE ALL ON FUNCTION public.consume_adapter_ops_capability_replay(text,text,text,timestamptz)
  FROM PUBLIC, commander_app, commander_worker, commander_scheduler, commander_tenant_authority;
GRANT EXECUTE ON FUNCTION public.is_adapter_ops_capability_revoked(text,text)
  TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.consume_adapter_ops_capability_replay(text,text,text,timestamptz)
  TO commander_adapter_ops;
`;
