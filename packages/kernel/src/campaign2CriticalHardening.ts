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
