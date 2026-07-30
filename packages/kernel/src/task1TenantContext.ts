export const APP_TENANT_CONTEXT_VERSION = 'commander.app-tenant-context/v1' as const;

export interface AppTenantTransactionTarget {
  databaseOid: number;
  backendPid: number;
  /** PostgreSQL xid8 values are transported as decimal strings to avoid JS precision loss. */
  xid: string;
}

export interface TenantContextSqlQuery {
  text: string;
  values: readonly unknown[];
}

export const BEGIN_APP_TENANT_TRANSACTION_SQL = 'BEGIN ISOLATION LEVEL READ COMMITTED';

export const READ_APP_TENANT_TRANSACTION_TARGET_SQL = `
SELECT
  (
    SELECT d.oid
    FROM pg_catalog.pg_database AS d
    WHERE d.datname = pg_catalog.current_database()
  ) AS database_oid,
  pg_catalog.pg_backend_pid() AS backend_pid,
  pg_catalog.pg_current_xact_id()::text AS xid
`.trim();

export function buildIssueAppTenantContextQuery(
  tenantId: string,
  target: AppTenantTransactionTarget,
): TenantContextSqlQuery {
  return {
    text: 'SELECT context_id::text, expires_at FROM public.issue_app_tenant_context($1, $2::oid, $3, $4::xid8)',
    values: [tenantId, target.databaseOid, target.backendPid, target.xid],
  };
}

export function buildBindAppTenantContextQuery(contextId: string): TenantContextSqlQuery {
  return {
    text: 'SELECT tenant_id, replayed, expires_at FROM public.bind_app_tenant_context($1::uuid)',
    values: [contextId],
  };
}

/** Expand-only compatibility scope. The caller must pass the tenant returned by bind. */
export function buildSetLegacyTenantScopeQuery(authenticatedTenantId: string): TenantContextSqlQuery {
  return {
    text: "SELECT pg_catalog.set_config('app.tenant_scope', $1, true)",
    values: [authenticatedTenantId],
  };
}

export function buildCloseAppTenantContextQuery(contextId: string): TenantContextSqlQuery {
  return {
    text: 'SELECT public.close_app_tenant_context($1::uuid)',
    values: [contextId],
  };
}

/** Use verbatim in every product tenant CHECK, trigger, RPC, and policy predicate. */
export const KERNEL_TASK1_PRODUCT_TENANT_PREDICATE_SQL =
  "tenant_id ~ '^[a-zA-Z0-9._:-]{1,128}$' AND tenant_id <> 'commander/readiness/v1'";

export const KERNEL_TASK1_ENFORCED_TENANT_RELATIONS = [
  'commander_action_kill_switches',
  'commander_capability_replays',
  'commander_capability_revocations',
  'commander_effect_allowlist',
  'commander_effect_quota',
  'commander_effects',
  'commander_events',
  'commander_interactions',
  'commander_outbox',
  'commander_outbox_deliveries',
  'commander_outbox_dlq',
  'commander_runs',
  'commander_steps',
  'commander_tenant_execution_control',
  'commander_tenant_execution_limits',
  'commander_tenant_execution_usage',
  'commander_timers',
] as const;

const KERNEL_TASK1_ENFORCED_TENANT_POLICY_SQL = KERNEL_TASK1_ENFORCED_TENANT_RELATIONS.map(
  (relation) => `
ALTER TABLE public.${relation} ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.${relation} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commander_tenant_isolation ON public.${relation};
DROP POLICY IF EXISTS commander_app_authenticated_tenant ON public.${relation};
DROP POLICY IF EXISTS commander_worker_tenant_scope ON public.${relation};
CREATE POLICY commander_app_authenticated_tenant ON public.${relation}
  FOR ALL TO commander_app
  USING (tenant_id = public.commander_authenticated_app_tenant())
  WITH CHECK (tenant_id = public.commander_authenticated_app_tenant());
CREATE POLICY commander_worker_tenant_scope ON public.${relation}
  FOR ALL TO commander_worker
  USING (
    tenant_id = ANY(pg_catalog.string_to_array(pg_catalog.current_setting('app.tenant_scope', true), ','))
    AND EXISTS (
      SELECT 1 FROM public.commander_worker_allowed_tenants AS allowed
       WHERE allowed.tenant_id = ${relation}.tenant_id
    )
  )
  WITH CHECK (
    tenant_id = ANY(pg_catalog.string_to_array(pg_catalog.current_setting('app.tenant_scope', true), ','))
    AND EXISTS (
      SELECT 1 FROM public.commander_worker_allowed_tenants AS allowed
       WHERE allowed.tenant_id = ${relation}.tenant_id
    )
  );`,
).join('\n');

/** Immutable enforcement descriptor generated only from the closed committed relation inventory. */
export const KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_ENFORCE_SQL = `
CREATE OR REPLACE FUNCTION public.commander_runtime_effect_tenant_authorized(p_tenant_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF session_user = 'commander_app' THEN
    RETURN p_tenant_id = public.commander_authenticated_app_tenant();
  END IF;
  IF session_user = 'commander_worker' THEN
    RETURN p_tenant_id = ANY(
      pg_catalog.string_to_array(pg_catalog.current_setting('app.tenant_scope', true), ',')
    ) AND EXISTS (
      SELECT 1
        FROM public.commander_worker_allowed_tenants AS allowed
       WHERE allowed.tenant_id = p_tenant_id
    );
  END IF;
  RETURN false;
END
$function$;

ALTER FUNCTION public.commander_runtime_effect_tenant_authorized(text) OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.commander_runtime_effect_tenant_authorized(text)
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler;

ALTER FUNCTION public.admit_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) RENAME TO commander_admit_class_a_effect_implementation;
ALTER FUNCTION public.admit_non_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) RENAME TO commander_admit_non_class_a_effect_implementation;
REVOKE ALL ON FUNCTION public.commander_admit_class_a_effect_implementation(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler;
REVOKE ALL ON FUNCTION public.commander_admit_non_class_a_effect_implementation(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler;

CREATE OR REPLACE FUNCTION public.admit_class_a_effect(
  p_id text, p_run_id text, p_step_id text, p_tenant_id text, p_type text,
  p_idempotency_key text, p_request_hash text, p_policy_decision_id text,
  p_policy_snapshot_id text, p_action_digest text, p_lease_worker_id text,
  p_lease_worker_generation bigint, p_lease_token text,
  p_lease_fencing_epoch bigint, p_request jsonb
) RETURNS TABLE(admitted boolean, reason text, replayed boolean, effect jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT public.commander_runtime_effect_tenant_authorized(p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_SCOPE_MISMATCH';
  END IF;
  IF session_user = 'commander_app' THEN
    PERFORM pg_catalog.set_config('app.tenant_scope', p_tenant_id, true);
  END IF;
  RETURN QUERY SELECT * FROM public.commander_admit_class_a_effect_implementation(
    p_id,p_run_id,p_step_id,p_tenant_id,p_type,p_idempotency_key,p_request_hash,
    p_policy_decision_id,p_policy_snapshot_id,p_action_digest,p_lease_worker_id,
    p_lease_worker_generation,p_lease_token,p_lease_fencing_epoch,p_request
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.admit_non_class_a_effect(
  p_id text, p_run_id text, p_step_id text, p_tenant_id text, p_type text,
  p_idempotency_key text, p_request_hash text, p_policy_decision_id text,
  p_policy_snapshot_id text, p_action_digest text, p_lease_worker_id text,
  p_lease_worker_generation bigint, p_lease_token text,
  p_lease_fencing_epoch bigint, p_request jsonb
) RETURNS TABLE(admitted boolean, reason text, replayed boolean, effect jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT public.commander_runtime_effect_tenant_authorized(p_tenant_id) THEN
    RAISE EXCEPTION 'TENANT_SCOPE_MISMATCH';
  END IF;
  IF session_user = 'commander_app' THEN
    PERFORM pg_catalog.set_config('app.tenant_scope', p_tenant_id, true);
  END IF;
  RETURN QUERY SELECT * FROM public.commander_admit_non_class_a_effect_implementation(
    p_id,p_run_id,p_step_id,p_tenant_id,p_type,p_idempotency_key,p_request_hash,
    p_policy_decision_id,p_policy_snapshot_id,p_action_digest,p_lease_worker_id,
    p_lease_worker_generation,p_lease_token,p_lease_fencing_epoch,p_request
  );
END
$function$;

ALTER FUNCTION public.admit_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) OWNER TO commander_owner;
ALTER FUNCTION public.admit_non_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.admit_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admit_non_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admit_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) TO commander_app, commander_worker;
GRANT EXECUTE ON FUNCTION public.admit_non_class_a_effect(
  text,text,text,text,text,text,text,text,text,text,text,bigint,text,bigint,jsonb
) TO commander_app, commander_worker;

CREATE OR REPLACE FUNCTION public.enforce_runtime_effect_tenant_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF session_user IN ('commander_app', 'commander_worker')
     AND NOT public.commander_runtime_effect_tenant_authorized(NEW.tenant_id) THEN
    RAISE EXCEPTION 'TENANT_SCOPE_MISMATCH';
  END IF;
  IF session_user = 'commander_worker' AND NOT EXISTS (
    SELECT 1
      FROM public.commander_workers AS worker
     WHERE worker.id = NEW.lease_worker_id
       AND worker.generation = NEW.lease_worker_generation
       AND worker.status = 'ACTIVE'
       AND worker.identity_subject = 'db:commander_worker'
       AND worker.tenant_ids ? NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'WORKER_TENANT_AUTHORIZATION_REQUIRED';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_runtime_effect_tenant_scope() OWNER TO commander_owner;
REVOKE ALL ON FUNCTION public.enforce_runtime_effect_tenant_scope() FROM PUBLIC;

${KERNEL_TASK1_ENFORCED_TENANT_POLICY_SQL}

ALTER TABLE public.commander_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commander_workers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commander_tenant_isolation ON public.commander_workers;
DROP POLICY IF EXISTS commander_app_authenticated_tenant ON public.commander_workers;
DROP POLICY IF EXISTS commander_worker_tenant_scope ON public.commander_workers;
CREATE POLICY commander_app_authenticated_tenant ON public.commander_workers
  FOR SELECT TO commander_app
  USING (
    public.commander_authenticated_app_tenant() = ANY(
      ARRAY(SELECT pg_catalog.jsonb_array_elements_text(tenant_ids))
    )
  );
CREATE POLICY commander_worker_tenant_scope ON public.commander_workers
  FOR SELECT TO commander_worker
  USING (
    tenant_ids ?| pg_catalog.string_to_array(pg_catalog.current_setting('app.tenant_scope', true), ',')
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(tenant_ids) AS tenant(tenant_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.commander_worker_allowed_tenants AS allowed
          WHERE allowed.tenant_id = tenant.tenant_id
       )
    )
  );

REVOKE SELECT ON TABLE public.commander_workers FROM commander_app;
REVOKE ALL ON TABLE public.commander_tenant_cutover_state,
  public.commander_tenant_cutover_operations FROM commander_app;
`;

/**
 * Expand-phase tenant authority objects. Enforcement consumes the exported product predicate when
 * replacing product RLS/RPC authority; the readiness tenant remains valid only in these owner tables.
 */
export const KERNEL_TASK1_TENANT_CONTEXT_SQL = `
DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'commander_tenant_authority'
  ) THEN
    CREATE ROLE commander_tenant_authority NOLOGIN NOBYPASSRLS NOCREATEROLE;
  END IF;
END
$role$;

CREATE TABLE public.commander_tenant_authority_allowed_tenants (
  tenant_id text PRIMARY KEY CHECK (
    tenant_id = 'commander/readiness/v1'
    OR tenant_id ~ '^[a-zA-Z0-9._:-]{1,128}$'
  ),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.commander_app_tenant_contexts (
  context_id uuid PRIMARY KEY,
  tenant_id text NOT NULL
    REFERENCES public.commander_tenant_authority_allowed_tenants(tenant_id),
  issuer_subject text NOT NULL
    CHECK (issuer_subject = 'db:commander_tenant_authority'),
  target_database_oid oid NOT NULL,
  target_backend_pid integer NOT NULL CHECK (target_backend_pid > 0),
  target_xid xid8 NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  bound_at timestamptz,
  closed_at timestamptz,
  CHECK (bound_at IS NULL OR bound_at >= issued_at),
  CHECK (closed_at IS NULL OR (bound_at IS NOT NULL AND closed_at >= bound_at)),
  UNIQUE (target_database_oid, target_backend_pid, target_xid)
);

CREATE INDEX commander_app_tenant_contexts_expiry_idx
  ON public.commander_app_tenant_contexts (expires_at);

CREATE OR REPLACE FUNCTION public.issue_app_tenant_context(
  p_tenant_id text,
  p_target_database_oid oid,
  p_target_backend_pid integer,
  p_target_xid xid8
)
RETURNS TABLE(context_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_current_database_oid oid;
  v_existing public.commander_app_tenant_contexts%ROWTYPE;
  v_context_id uuid;
  v_issued_at timestamptz;
BEGIN
  IF session_user <> 'commander_tenant_authority' THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_tenant_id IS NULL OR p_tenant_id = ''
     OR p_target_database_oid IS NULL
     OR p_target_backend_pid IS NULL OR p_target_backend_pid <= 0
     OR p_target_xid IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT d.oid
    INTO v_current_database_oid
    FROM pg_catalog.pg_database AS d
   WHERE d.datname = pg_catalog.current_database();
  IF p_target_database_oid <> v_current_database_oid THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.commander_tenant_authority_allowed_tenants AS allowed
     WHERE allowed.tenant_id = p_tenant_id
       AND allowed.enabled = true
  ) THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;

  WITH cleanup_candidates AS (
    SELECT stale.context_id
      FROM public.commander_app_tenant_contexts AS stale
     WHERE stale.expires_at <= pg_catalog.statement_timestamp()
     ORDER BY stale.expires_at, stale.context_id
     LIMIT 100
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.commander_app_tenant_contexts AS stale
   USING cleanup_candidates AS candidate
   WHERE stale.context_id = candidate.context_id;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_target_database_oid::text || ':' || p_target_backend_pid::text || ':' || p_target_xid::text,
      0
    )
  );

  SELECT existing.*
    INTO v_existing
    FROM public.commander_app_tenant_contexts AS existing
   WHERE existing.target_database_oid = p_target_database_oid
     AND existing.target_backend_pid = p_target_backend_pid
     AND existing.target_xid = p_target_xid
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.tenant_id = p_tenant_id
       AND v_existing.bound_at IS NULL
       AND v_existing.closed_at IS NULL
       AND v_existing.expires_at > pg_catalog.statement_timestamp() THEN
      RETURN QUERY SELECT v_existing.context_id, v_existing.expires_at;
      RETURN;
    END IF;
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_context_id := pg_catalog.gen_random_uuid();
  v_issued_at := pg_catalog.clock_timestamp();
  INSERT INTO public.commander_app_tenant_contexts (
    context_id,
    tenant_id,
    issuer_subject,
    target_database_oid,
    target_backend_pid,
    target_xid,
    issued_at,
    expires_at
  ) VALUES (
    v_context_id,
    p_tenant_id,
    'db:commander_tenant_authority',
    p_target_database_oid,
    p_target_backend_pid,
    p_target_xid,
    v_issued_at,
    v_issued_at + interval '60 seconds'
  );

  RETURN QUERY SELECT v_context_id, v_issued_at + interval '60 seconds';
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_app_tenant_context(p_context_id uuid)
RETURNS TABLE(tenant_id text, replayed boolean, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_context public.commander_app_tenant_contexts%ROWTYPE;
  v_database_oid oid;
  v_xid xid8;
  v_replayed boolean;
BEGIN
  IF session_user <> 'commander_app' OR p_context_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_xid := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xid IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT d.oid
    INTO v_database_oid
    FROM pg_catalog.pg_database AS d
   WHERE d.datname = pg_catalog.current_database();

  SELECT candidate.*
    INTO v_context
    FROM public.commander_app_tenant_contexts AS candidate
   WHERE candidate.context_id = p_context_id
     AND candidate.target_database_oid = v_database_oid
     AND candidate.target_backend_pid = pg_catalog.pg_backend_pid()
     AND candidate.target_xid = v_xid
     AND candidate.closed_at IS NULL
     AND candidate.expires_at > pg_catalog.statement_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_replayed := v_context.bound_at IS NOT NULL;
  IF NOT v_replayed THEN
    UPDATE public.commander_app_tenant_contexts AS context
       SET bound_at = pg_catalog.clock_timestamp()
     WHERE context.context_id = p_context_id;
  END IF;
  PERFORM pg_catalog.set_config(
    'app.authenticated_tenant_context_id',
    p_context_id::text,
    true
  );
  RETURN QUERY SELECT v_context.tenant_id, v_replayed, v_context.expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION public.commander_authenticated_app_tenant()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_context_id uuid;
  v_tenant_id text;
  v_database_oid oid;
  v_xid xid8;
BEGIN
  IF session_user <> 'commander_app' THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_context_id := NULLIF(
      pg_catalog.current_setting('app.authenticated_tenant_context_id', true),
      ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END;
  v_xid := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_context_id IS NULL OR v_xid IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT d.oid
    INTO v_database_oid
    FROM pg_catalog.pg_database AS d
   WHERE d.datname = pg_catalog.current_database();

  SELECT context.tenant_id
    INTO v_tenant_id
    FROM public.commander_app_tenant_contexts AS context
   WHERE context.context_id = v_context_id
     AND context.target_database_oid = v_database_oid
     AND context.target_backend_pid = pg_catalog.pg_backend_pid()
     AND context.target_xid = v_xid
     AND context.bound_at IS NOT NULL
     AND context.closed_at IS NULL
     AND context.expires_at > pg_catalog.statement_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN v_tenant_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.close_app_tenant_context(p_context_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_database_oid oid;
  v_xid xid8;
BEGIN
  IF session_user <> 'commander_app' OR p_context_id IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_xid := pg_catalog.pg_current_xact_id_if_assigned();
  IF v_xid IS NULL THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT d.oid
    INTO v_database_oid
    FROM pg_catalog.pg_database AS d
   WHERE d.datname = pg_catalog.current_database();

  UPDATE public.commander_app_tenant_contexts AS context
     SET closed_at = pg_catalog.clock_timestamp()
   WHERE context.context_id = p_context_id
     AND context.target_database_oid = v_database_oid
     AND context.target_backend_pid = pg_catalog.pg_backend_pid()
     AND context.target_xid = v_xid
     AND context.bound_at IS NOT NULL
     AND context.closed_at IS NULL
     AND context.expires_at > pg_catalog.statement_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('app.authenticated_tenant_context_id', '', true);
END
$function$;

ALTER FUNCTION public.issue_app_tenant_context(text, oid, integer, xid8) OWNER TO commander_owner;
ALTER FUNCTION public.bind_app_tenant_context(uuid) OWNER TO commander_owner;
ALTER FUNCTION public.commander_authenticated_app_tenant() OWNER TO commander_owner;
ALTER FUNCTION public.close_app_tenant_context(uuid) OWNER TO commander_owner;
ALTER TABLE public.commander_tenant_authority_allowed_tenants OWNER TO commander_owner;
ALTER TABLE public.commander_app_tenant_contexts OWNER TO commander_owner;

REVOKE ALL ON TABLE public.commander_tenant_authority_allowed_tenants,
  public.commander_app_tenant_contexts
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler, commander_tenant_authority;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM commander_tenant_authority;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM commander_tenant_authority;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM commander_tenant_authority;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM commander_tenant_authority;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS FROM commander_tenant_authority;

REVOKE ALL ON FUNCTION public.issue_app_tenant_context(text, oid, integer, xid8),
  public.bind_app_tenant_context(uuid),
  public.commander_authenticated_app_tenant(),
  public.close_app_tenant_context(uuid)
  FROM PUBLIC, commander_app, commander_worker, commander_adapter_ops, commander_scheduler, commander_tenant_authority;
GRANT EXECUTE ON FUNCTION public.issue_app_tenant_context(text, oid, integer, xid8) TO commander_tenant_authority;
GRANT EXECUTE ON FUNCTION public.bind_app_tenant_context(uuid),
  public.commander_authenticated_app_tenant(),
  public.close_app_tenant_context(uuid)
  TO commander_app;
GRANT EXECUTE ON FUNCTION public.commander_database_identity(),
  public.commander_runtime_configuration_identity()
  TO commander_tenant_authority;

DO $block$
DECLARE
  v_role text;
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
    pg_catalog.current_database()
  );
  FOREACH v_role IN ARRAY ARRAY[
    'commander_app',
    'commander_worker',
    'commander_adapter_ops',
    'commander_scheduler',
    'commander_tenant_authority'
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE TEMPORARY ON DATABASE %I FROM %I',
      pg_catalog.current_database(),
      v_role
    );
  END LOOP;
END
$block$;

ALTER ROLE commander_app SET statement_timeout = '55s';
ALTER ROLE commander_app SET idle_in_transaction_session_timeout = '10s';
`;

/** Immutable expand descriptor; the context SQL is intentionally applied before enforcement. */
export const KERNEL_TASK1_AUTHENTICATED_TENANT_AUTHORITY_EXPAND_SQL =
  KERNEL_TASK1_TENANT_CONTEXT_SQL;
