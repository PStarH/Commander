export const KILL_SWITCH_MIGRATION_ID = '2026-08-12.1.kill_switches';

export const KILL_SWITCH_SQL = `
CREATE TABLE IF NOT EXISTS commander_action_kill_switches (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  value TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  reason TEXT,
  actor TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, value)
);

ALTER TABLE commander_action_kill_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_action_kill_switches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commander_tenant_isolation ON commander_action_kill_switches;
CREATE POLICY commander_tenant_isolation ON commander_action_kill_switches
  FOR ALL TO PUBLIC
  USING (
    tenant_id = ANY(string_to_array(current_setting('app.tenant_scope', true), ','))
    AND (
      current_user IS DISTINCT FROM 'commander_worker'
      OR EXISTS (
        SELECT 1 FROM commander_worker_allowed_tenants allowed
        WHERE allowed.tenant_id = commander_action_kill_switches.tenant_id
      )
    )
  )
  WITH CHECK (
    tenant_id = ANY(string_to_array(current_setting('app.tenant_scope', true), ','))
    AND (
      current_user IS DISTINCT FROM 'commander_worker'
      OR EXISTS (
        SELECT 1 FROM commander_worker_allowed_tenants allowed
        WHERE allowed.tenant_id = commander_action_kill_switches.tenant_id
      )
    )
  );

REVOKE ALL ON TABLE commander_action_kill_switches FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commander_action_kill_switches TO commander_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commander_worker') THEN
    GRANT SELECT ON TABLE commander_action_kill_switches TO commander_worker;
  END IF;
END $$;
`;
