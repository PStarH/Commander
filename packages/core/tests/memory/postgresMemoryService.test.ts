import { describe, expect, it } from 'vitest';
import { PostgresMemoryService } from '../../src/memory/postgresMemoryService';

type QueryCall = { sql: string; values?: unknown[] };

class RecordingClient {
  readonly calls: QueryCall[] = [];

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    if (sql.includes('INSERT INTO memory_items')) {
      return {
        rowCount: 1,
        rows: [
          {
            id: 'memory-1',
            tenant_id: 'tenant-a',
            project_id: 'project-a',
            kind: 'LESSON',
            duration: 'EPISODIC',
            title: 'Postgres memory',
            content: 'tenant scoped content',
            tags: ['database'],
            priority: 50,
            confidence: 0.8,
            created_at: '2026-01-01T00:00:00.000Z',
            last_accessed_at: '2026-01-01T00:00:00.000Z',
          },
        ] as T[],
      };
    }
    return { rowCount: 0, rows: [] as T[] };
  }

  release(): void {}
}

class RecordingPool {
  readonly calls: QueryCall[] = [];
  readonly client = new RecordingClient();

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]) {
    this.calls.push({ sql, values });
    return { rowCount: 0, rows: [] as T[] };
  }

  async connect(): Promise<RecordingClient> {
    return this.client;
  }

  async end(): Promise<void> {}
}

describe('PostgresMemoryService', () => {
  it('creates the base schema and RLS without requiring pgvector', async () => {
    const pool = new RecordingPool();
    const service = new PostgresMemoryService({ pool });

    await service.initialize();

    const sql = pool.calls.map((call) => call.sql).join('\n');
    expect(sql).toContain('tenant_id TEXT NOT NULL');
    expect(sql).toContain('ALTER TABLE memory_items ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_audit_events');
    expect(sql).not.toMatch(/embedding\s+vector\(/i);
  });

  it('sets the tenant scope and includes tenant/project predicates for writes', async () => {
    const pool = new RecordingPool();
    const service = new PostgresMemoryService({ pool });

    await service.store({
      scope: { tenantId: 'tenant-a', projectId: 'project-a' },
      id: 'memory-1',
      kind: 'LESSON',
      title: 'Postgres memory',
      content: 'tenant scoped content',
      tags: ['database'],
    });

    const transactionSql = pool.client.calls.map((call) => call.sql).join('\n');
    expect(transactionSql).toContain("set_config('app.tenant_scope'");
    expect(transactionSql).toContain('tenant_id');
    expect(transactionSql).toContain('project_id');
    expect(pool.client.calls.some((call) => call.values?.includes('tenant-a'))).toBe(true);
    expect(pool.client.calls.some((call) => call.values?.includes('project-a'))).toBe(true);
  });

  it('falls back to full-text search when semantic vectors are unavailable', async () => {
    const pool = new RecordingPool();
    const service = new PostgresMemoryService({ pool });

    await expect(
      service.search({
        scope: { tenantId: 'tenant-a', projectId: 'project-a' },
        mode: 'semantic',
        query: 'postgres',
      }),
    ).resolves.toMatchObject({ items: [], total: 0 });
    expect(pool.client.calls.some((call) => call.sql.includes('to_tsvector'))).toBe(true);
  });

  it('queryAudit tolerates malformed string tags without throwing', async () => {
    const pool = new RecordingPool();
    const originalQuery = pool.client.query.bind(pool.client);
    pool.client.query = async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
      if (sql.includes('FROM memory_audit_events')) {
        pool.client.calls.push({ sql, values });
        return {
          rowCount: 1,
          rows: [
            {
              id: 'a1',
              tenant_id: 'tenant-a',
              project_id: 'project-a',
              memory_id: null,
              action: 'store',
              actor_id: null,
              success: true,
              created_at: '2026-01-01T00:00:00.000Z',
              tags: '{not-json',
            },
          ] as T[],
        };
      }
      return originalQuery<T>(sql, values);
    };
    const service = new PostgresMemoryService({ pool });
    await expect(
      service.queryAudit({
        scope: { tenantId: 'tenant-a', projectId: 'project-a' },
        limit: 10,
      }),
    ).resolves.toMatchObject({
      count: 1,
      entries: [{ id: 'a1', tags: [] }],
    });
  });

  it('snapshots tags into forget audit rows for namespace queries', async () => {
    const pool = new RecordingPool();
    const originalQuery = pool.client.query.bind(pool.client);
    pool.client.query = async <T = Record<string, unknown>>(sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT tags FROM memory_items')) {
        pool.client.calls.push({ sql, values });
        return {
          rowCount: 1,
          rows: [{ tags: ['namespace:alpha', 'other'] }] as T[],
        };
      }
      if (sql.includes('DELETE FROM memory_items')) {
        pool.client.calls.push({ sql, values });
        return { rowCount: 1, rows: [] as T[] };
      }
      return originalQuery<T>(sql, values);
    };

    const service = new PostgresMemoryService({ pool });
    await expect(
      service.forget({
        scope: { tenantId: 'tenant-a', projectId: 'project-a' },
        id: 'memory-1',
      }),
    ).resolves.toBe(true);

    const auditInsert = pool.client.calls.find((call) =>
      call.sql.includes('INSERT INTO memory_audit_events'),
    );
    expect(auditInsert?.values).toEqual(
      expect.arrayContaining([
        'forget',
        'memory-1',
        JSON.stringify(['namespace:alpha', 'other']),
      ]),
    );
  });
});
