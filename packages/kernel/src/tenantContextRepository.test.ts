import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PostgresKernelRepository,
  PostgresTenantContextAuthority,
  type SqlClient,
  type SqlPool,
  type SqlQueryResult,
  type TenantContextAuthority,
} from './postgres.js';

class RecordingClient implements SqlClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly releases: Array<Error | boolean | undefined> = [];
  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, values });
    if (/session_user::text AS login_role/i.test(sql)) {
      return { rows: [{ login_role: 'commander_app' } as T], rowCount: 1 };
    }
    if (/pg_current_xact_id\(\)::text AS xid/i.test(sql)) {
      return { rows: [{ database_oid: 16384, backend_pid: 42, xid: '91' } as T], rowCount: 1 };
    }
    if (/bind_app_tenant_context/i.test(sql)) {
      return { rows: [{ tenant_id: 'tenant-a', replayed: false } as T], rowCount: 1 };
    }
    if (/get_api_operations_readiness/i.test(sql)) {
      return {
        rows: [
          {
            reconciliation_workers: '2',
            compensation_workers: '1',
            checked_at: '2026-08-01T00:00:00.000Z',
          } as T,
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
  release(error?: Error | boolean): void {
    this.releases.push(error);
  }
}

class Pool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

class Authority implements TenantContextAuthority {
  calls: unknown[] = [];
  async issue(tenantId: string, target: { databaseOid: number; backendPid: number; xid: string }) {
    this.calls.push({ tenantId, target });
    return { contextId: '00000000-0000-4000-8000-000000000001', expiresAt: new Date() };
  }
}

describe('PostgresKernelRepository tenant context protocol', () => {
  it('rejects a malformed authority response and always releases its client', async () => {
    const client = new RecordingClient();
    client.query = async <T>(sql: string, values: readonly unknown[] = []) => {
      client.queries.push({ sql, values });
      return {
        rows: [{ context_id: 'caller-controlled', expires_at: 'not-a-timestamp' } as T],
        rowCount: 1,
      };
    };
    const authority = new PostgresTenantContextAuthority(new Pool(client));

    await assert.rejects(
      () => authority.issue('tenant-a', { databaseOid: 16384, backendPid: 42, xid: '91' }),
      /TENANT_CONTEXT_INVALID/,
    );
    assert.equal(client.releases.length, 1);
    assert.ok(client.releases[0] instanceof Error);
    assert.equal(client.queries.length, 1);
  });

  it('rejects reusing the app pool as the authority pool', () => {
    const pool = new Pool(new RecordingClient());
    assert.throws(
      () =>
        new PostgresKernelRepository(pool, {
          tenantContextAuthority: new PostgresTenantContextAuthority(pool),
          tenantContextPhase: 'enforce',
        }),
      /TENANT_CONTEXT_AUTHORITY_POOL_MUST_BE_SEPARATE/,
    );
  });

  it('issues, binds, verifies, scopes expand compatibility, closes, then commits', async () => {
    const client = new RecordingClient();
    const authority = new Authority();
    const repository = new PostgresKernelRepository(new Pool(client), {
      tenantContextAuthority: authority,
      tenantContextPhase: 'expand',
    });

    assert.equal(await repository.getRun('run-a', 'tenant-a'), null);
    assert.deepEqual(authority.calls, [
      {
        tenantId: 'tenant-a',
        target: { databaseOid: 16384, backendPid: 42, xid: '91' },
      },
    ]);
    const sql = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    assert.ok(sql.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED') >= 0);
    assert.ok(
      sql.findIndex((value) => /pg_current_xact_id\(\)::text AS xid/i.test(value)) <
        sql.findIndex((value) => /bind_app_tenant_context/i.test(value)),
    );
    assert.ok(sql.some((value) => /set_config\('app\.tenant_scope'/i.test(value)));
    assert.ok(
      sql.findIndex((value) => /close_app_tenant_context/i.test(value)) < sql.indexOf('COMMIT'),
    );
    assert.deepEqual(client.releases, [undefined]);
  });

  it('does not write the legacy scope in enforce phase and rolls back on tenant mismatch', async () => {
    const client = new RecordingClient();
    const original = client.query.bind(client);
    client.query = async <T>(sql: string, values: readonly unknown[] = []) => {
      if (/bind_app_tenant_context/i.test(sql)) {
        client.queries.push({ sql, values });
        return { rows: [{ tenant_id: 'tenant-b', replayed: false } as T], rowCount: 1 };
      }
      return original<T>(sql, values);
    };
    const repository = new PostgresKernelRepository(new Pool(client), {
      tenantContextAuthority: new Authority(),
      tenantContextPhase: 'enforce',
    });

    await assert.rejects(() => repository.getRun('run-a', 'tenant-a'), /TENANT_CONTEXT_INVALID/);
    const sql = client.queries.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
    assert.equal(
      sql.some((value) => /set_config\('app\.tenant_scope'/i.test(value)),
      false,
    );
    assert.ok(sql.includes('ROLLBACK'));
    assert.equal(sql.includes('COMMIT'), false);
    assert.equal(client.releases.length, 1);
    assert.ok(client.releases[0] instanceof Error);
  });

  it('reads operations readiness through the tenant-bound app RPC in enforce phase', async () => {
    const client = new RecordingClient();
    const repository = new PostgresKernelRepository(new Pool(client), {
      tenantContextAuthority: new Authority(),
      tenantContextPhase: 'enforce',
    });

    assert.deepEqual(await repository.getOperationsReadiness('tenant-a'), {
      ready: true,
      reconciliationWorkers: 2,
      compensationWorkers: 1,
      checkedAt: '2026-08-01T00:00:00.000Z',
    });

    const statements = client.queries.map(({ sql, values }) => ({
      sql: sql.replace(/\s+/g, ' ').trim(),
      values,
    }));
    const bindIndex = statements.findIndex(({ sql }) => /bind_app_tenant_context/i.test(sql));
    const readinessIndex = statements.findIndex(({ sql }) =>
      /get_api_operations_readiness/i.test(sql),
    );
    const closeIndex = statements.findIndex(({ sql }) => /close_app_tenant_context/i.test(sql));
    assert.ok(bindIndex >= 0 && bindIndex < readinessIndex);
    assert.ok(closeIndex > readinessIndex);
    assert.deepEqual(statements[readinessIndex]?.values, ['tenant-a']);
    assert.equal(
      statements.some(({ sql }) => /FROM (?:public\.)?commander_workers/i.test(sql)),
      false,
    );
  });

  it('destroys the app client when rollback also fails', async () => {
    const client = new RecordingClient();
    const original = client.query.bind(client);
    client.query = async <T>(sql: string, values: readonly unknown[] = []) => {
      if (sql === 'ROLLBACK') {
        client.queries.push({ sql, values });
        throw new Error('rollback failed');
      }
      if (/bind_app_tenant_context/i.test(sql)) {
        client.queries.push({ sql, values });
        throw new Error('bind failed');
      }
      return original<T>(sql, values);
    };
    const repository = new PostgresKernelRepository(new Pool(client), {
      tenantContextAuthority: new Authority(),
      tenantContextPhase: 'enforce',
    });

    await assert.rejects(() => repository.getRun('run-a', 'tenant-a'), /bind failed/);
    assert.equal(client.queries.at(-1)?.sql, 'ROLLBACK');
    assert.equal(client.releases.length, 1);
    assert.ok(client.releases[0] instanceof Error);
  });
});
