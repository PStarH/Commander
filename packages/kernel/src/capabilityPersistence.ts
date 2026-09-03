/** Owner-owned capability persistence RPCs for the tableless adapter-ops role. */
export const KERNEL_CAPABILITY_DURABLE_ACCESS_SQL = String.raw`
CREATE OR REPLACE FUNCTION public.read_capability_revocation_v1(
  p_tenant_id text,
  p_jti text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF session_user IS DISTINCT FROM 'commander_adapter_ops'
     OR NULLIF(trim(p_tenant_id), '') IS NULL
     OR NULLIF(trim(p_jti), '') IS NULL
     OR NOT p_tenant_id = ANY(
       string_to_array(COALESCE(current_setting('app.tenant_scope', true), ''), ',')
     ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.commander_capability_revocations
     WHERE tenant_id = p_tenant_id
       AND jti = p_jti
       AND expires_at > clock_timestamp()
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.consume_capability_replay_v1(
  p_tenant_id text,
  p_jti text,
  p_nonce text,
  p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_inserted integer;
BEGIN
  -- Invalid or out-of-scope requests fail closed as an already-consumed token.
  IF session_user IS DISTINCT FROM 'commander_adapter_ops'
     OR NULLIF(trim(p_tenant_id), '') IS NULL
     OR NULLIF(trim(p_jti), '') IS NULL
     OR NULLIF(trim(p_nonce), '') IS NULL
     OR p_expires_at IS NULL
     OR NOT p_tenant_id = ANY(
       string_to_array(COALESCE(current_setting('app.tenant_scope', true), ''), ',')
     ) THEN
    RETURN true;
  END IF;

  INSERT INTO public.commander_capability_replays (tenant_id, jti, nonce, expires_at)
  VALUES (p_tenant_id, p_jti, p_nonce, p_expires_at)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 0;
END
$fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_owner') THEN
    ALTER FUNCTION public.read_capability_revocation_v1(text, text) OWNER TO commander_owner;
    ALTER FUNCTION public.consume_capability_replay_v1(text, text, text, timestamptz)
      OWNER TO commander_owner;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.read_capability_revocation_v1(text, text)
  FROM PUBLIC, commander_app, commander_worker, commander_scheduler, commander_adapter_ops;
REVOKE ALL ON FUNCTION public.consume_capability_replay_v1(text, text, text, timestamptz)
  FROM PUBLIC, commander_app, commander_worker, commander_scheduler, commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.read_capability_revocation_v1(text, text)
  TO commander_adapter_ops;
GRANT EXECUTE ON FUNCTION public.consume_capability_replay_v1(text, text, text, timestamptz)
  TO commander_adapter_ops;
`;
