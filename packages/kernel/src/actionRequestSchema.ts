export const KERNEL_ACTION_REQUEST_IDEMPOTENCY_SQL = `
CREATE TABLE IF NOT EXISTS public.commander_action_requests (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETED')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, idempotency_key),
  CHECK (
    (state = 'IN_PROGRESS' AND response_status IS NULL AND completed_at IS NULL)
    OR (
      state = 'COMPLETED'
      AND response_status BETWEEN 100 AND 599
      AND completed_at IS NOT NULL
    )
  )
);

ALTER TABLE public.commander_action_requests OWNER TO commander_owner;
ALTER TABLE public.commander_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commander_action_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commander_tenant_isolation ON public.commander_action_requests;
DROP POLICY IF EXISTS commander_app_authenticated_tenant ON public.commander_action_requests;
CREATE POLICY commander_app_authenticated_tenant ON public.commander_action_requests
  FOR ALL TO commander_app
  USING (tenant_id = public.commander_authenticated_app_tenant())
  WITH CHECK (tenant_id = public.commander_authenticated_app_tenant());

REVOKE ALL ON TABLE public.commander_action_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.commander_action_requests
  FROM commander_worker, commander_scheduler, commander_adapter_ops, commander_tenant_authority;
GRANT SELECT, INSERT, UPDATE ON TABLE public.commander_action_requests TO commander_app;
`;

export const KERNEL_ACTION_REQUEST_RECOVERY_SQL = `
ALTER TABLE public.commander_action_requests
  ADD COLUMN IF NOT EXISTS attempt_token text;
ALTER TABLE public.commander_action_requests
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE public.commander_action_requests
SET attempt_token = COALESCE(attempt_token, 'legacy:' || idempotency_key),
    lease_expires_at = COALESCE(lease_expires_at, created_at)
WHERE attempt_token IS NULL OR lease_expires_at IS NULL;

ALTER TABLE public.commander_action_requests
  ALTER COLUMN attempt_token SET NOT NULL;
ALTER TABLE public.commander_action_requests
  ALTER COLUMN lease_expires_at SET NOT NULL;
`;
