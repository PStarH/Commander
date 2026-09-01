/** Owner-run schema for the API's durable memory service. */
export const KERNEL_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS public.memory_items (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  mission_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  duration TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority INTEGER NOT NULL DEFAULT 50,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  evidence_refs JSONB,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  last_accessed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project_created
  ON public.memory_items (tenant_id, project_id, created_at DESC, id ASC);
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project_kind
  ON public.memory_items (tenant_id, project_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project_expiry
  ON public.memory_items (tenant_id, project_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_items_search
  ON public.memory_items USING GIN (
    to_tsvector('simple', title || ' ' || content || ' ' || tags::text)
  );
CREATE TABLE IF NOT EXISTS public.memory_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  memory_id TEXT,
  action TEXT NOT NULL,
  actor_id TEXT,
  success BOOLEAN NOT NULL,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  tags JSONB
);
ALTER TABLE public.memory_audit_events ADD COLUMN IF NOT EXISTS tags JSONB;
CREATE INDEX IF NOT EXISTS idx_memory_audit_tenant_project_created
  ON public.memory_audit_events (tenant_id, project_id, created_at DESC);
ALTER TABLE public.memory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_audit_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'memory_items'
      AND policyname = 'memory_items_tenant_isolation'
  ) THEN
    CREATE POLICY memory_items_tenant_isolation ON public.memory_items
      USING (tenant_id = current_setting('app.tenant_scope', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_scope', true));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'memory_audit_events'
      AND policyname = 'memory_audit_tenant_isolation'
  ) THEN
    CREATE POLICY memory_audit_tenant_isolation ON public.memory_audit_events
      USING (tenant_id = current_setting('app.tenant_scope', true))
      WITH CHECK (tenant_id = current_setting('app.tenant_scope', true));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_items TO commander_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_audit_events TO commander_app;
CREATE TABLE IF NOT EXISTS public.api_tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  agent_id TEXT,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'pending',
  input_json TEXT NOT NULL DEFAULT '{}',
  artifact_id TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  messages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public.api_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public.api_governance_checkpoints (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'LOW',
  required_approvals_json TEXT NOT NULL DEFAULT '[]',
  current_approvals_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  approved_at TEXT,
  fallback_action TEXT NOT NULL DEFAULT 'abort',
  context_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS public.api_governance_configs (
  mission_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  risk_threshold INTEGER,
  approvers_json TEXT NOT NULL DEFAULT '[]',
  timeout INTEGER,
  fallback_on_timeout TEXT NOT NULL DEFAULT 'abort'
);
CREATE INDEX IF NOT EXISTS idx_api_tasks_status ON public.api_tasks(status);
CREATE INDEX IF NOT EXISTS idx_api_tasks_client ON public.api_tasks(client_id);
CREATE INDEX IF NOT EXISTS idx_api_tasks_agent ON public.api_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_api_artifacts_task ON public.api_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_api_ck_mission ON public.api_governance_checkpoints(mission_id);
CREATE INDEX IF NOT EXISTS idx_api_ck_status ON public.api_governance_checkpoints(status);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_tasks TO commander_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_artifacts TO commander_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_governance_checkpoints TO commander_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_governance_configs TO commander_app;
`;
