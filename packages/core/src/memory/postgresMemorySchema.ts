const MAX_VECTOR_DIMENSION = 8192;

export function memorySchemaStatements(): readonly string[] {
  return [
    `
      CREATE TABLE IF NOT EXISTS memory_items (
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
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project_created
        ON memory_items (tenant_id, project_id, created_at DESC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project_kind
        ON memory_items (tenant_id, project_id, kind, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_memory_items_tenant_project_expiry
        ON memory_items (tenant_id, project_id, expires_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_memory_items_search
        ON memory_items USING GIN (
          to_tsvector('simple', title || ' ' || content || ' ' || tags::text)
        )
    `,
    `
      CREATE TABLE IF NOT EXISTS memory_audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        memory_id TEXT,
        action TEXT NOT NULL,
        actor_id TEXT,
        success BOOLEAN NOT NULL,
        error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_memory_audit_tenant_project_created
        ON memory_audit_events (tenant_id, project_id, created_at DESC)
    `,
    `ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE memory_audit_events ENABLE ROW LEVEL SECURITY`,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema()
            AND tablename = 'memory_items'
            AND policyname = 'memory_items_tenant_isolation'
        ) THEN
          CREATE POLICY memory_items_tenant_isolation ON memory_items
            USING (tenant_id = current_setting('app.tenant_scope', true))
            WITH CHECK (tenant_id = current_setting('app.tenant_scope', true));
        END IF;
      END $$
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE schemaname = current_schema()
            AND tablename = 'memory_audit_events'
            AND policyname = 'memory_audit_tenant_isolation'
        ) THEN
          CREATE POLICY memory_audit_tenant_isolation ON memory_audit_events
            USING (tenant_id = current_setting('app.tenant_scope', true))
            WITH CHECK (tenant_id = current_setting('app.tenant_scope', true));
        END IF;
      END $$
    `,
  ];
}

export function vectorSchemaStatements(dimension: number): readonly string[] {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_VECTOR_DIMENSION) {
    throw new Error(`embeddingDimension must be an integer between 1 and ${MAX_VECTOR_DIMENSION}`);
  }
  return [
    'CREATE EXTENSION IF NOT EXISTS vector',
    `ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS embedding vector(${dimension})`,
    `
      CREATE INDEX IF NOT EXISTS idx_memory_items_embedding
        ON memory_items USING hnsw (embedding vector_cosine_ops)
    `,
  ];
}
