export const KERNEL_SIGNED_EVIDENCE_MIGRATION_ID = '2026-08-11.1.signed_evidence';

export const KERNEL_SIGNED_EVIDENCE_SQL = `
CREATE TABLE IF NOT EXISTS commander_evidence_receipts (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  receipt JSONB NOT NULL,
  anchored_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, bundle_id),
  FOREIGN KEY (run_id, tenant_id) REFERENCES commander_runs(id, tenant_id) ON DELETE RESTRICT,
  CHECK (bundle_id = 'evidence_' || (receipt #>> '{scope,effectId}')),
  CHECK (tenant_id = receipt #>> '{scope,tenantId}'),
  CHECK (run_id = receipt #>> '{scope,runId}'),
  CHECK (action_digest = receipt->>'actionDigest'),
  CHECK (receipt->>'bodyVersion' = 'commander.evidence-body/v1'),
  CHECK (receipt ? 'signature'),
  CHECK (retention_until > anchored_at)
);
CREATE INDEX IF NOT EXISTS commander_evidence_exact_lookup_idx
  ON commander_evidence_receipts (tenant_id, run_id, bundle_id, action_digest);

ALTER TABLE commander_evidence_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commander_evidence_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commander_tenant_isolation ON commander_evidence_receipts;
CREATE POLICY commander_tenant_isolation ON commander_evidence_receipts
  FOR ALL TO PUBLIC
  USING (tenant_id = ANY(string_to_array(current_setting('app.tenant_scope', true), ',')))
  WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.tenant_scope', true), ',')));

REVOKE ALL ON TABLE commander_evidence_receipts FROM PUBLIC;
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
