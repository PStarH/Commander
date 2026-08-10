import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KERNEL_CAPABILITY_DURABLE_ACCESS_SQL } from './capabilityPersistence.js';
import {
  PostgresKernelRepository,
  type SqlClient,
  type SqlPool,
  type SqlQueryResult,
} from './postgres.js';

function result<T>(rows: T[] = []): SqlQueryResult<T> {
  return { rows, rowCount: rows.length };
}

class RecordingClient implements SqlClient {
  readonly queries: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, values });
    if (/session_user::text AS login_role/i.test(sql)) {
      return result([{ login_role: 'commander_adapter_ops' } as T]);
    }
    if (/read_capability_revocation_v1/i.test(sql)) {
      return result([{ read_capability_revocation_v1: true } as T]);
    }
    if (/consume_capability_replay_v1/i.test(sql)) {
      return result([{ consume_capability_replay_v1: false } as T]);
    }
    return result<T>();
  }

  release(): void {}
}

class Pool implements SqlPool {
  constructor(readonly client: RecordingClient) {}

  async connect(): Promise<SqlClient> {
    return this.client;
  }
}

describe('adapter-ops capability persistence boundary', () => {
  it('publishes only tenant-scoped owner RPC execution to adapter-ops', () => {
    assert.match(
      KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
      /CREATE OR REPLACE FUNCTION public\.read_capability_revocation_v1\([\s\S]*SECURITY DEFINER/i,
    );
    assert.match(
      KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
      /CREATE OR REPLACE FUNCTION public\.consume_capability_replay_v1\([\s\S]*SECURITY DEFINER/i,
    );
    assert.match(
      KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
      /session_user IS DISTINCT FROM 'commander_adapter_ops'/i,
    );
    assert.match(
      KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
      /current_setting\('app\.tenant_scope', true\)/i,
    );
    assert.doesNotMatch(KERNEL_CAPABILITY_DURABLE_ACCESS_SQL, /GRANT\s+SELECT\s+ON\s+TABLE/i);
    assert.match(
      KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
      /GRANT EXECUTE ON FUNCTION public\.read_capability_revocation_v1\(text, text\)\s+TO commander_adapter_ops/i,
    );
    assert.match(
      KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
      /GRANT EXECUTE ON FUNCTION public\.consume_capability_replay_v1\(text, text, text, timestamptz\)\s+TO commander_adapter_ops/i,
    );
  });

  it('uses owner RPCs instead of direct capability table access', async () => {
    const client = new RecordingClient();
    const repository = new PostgresKernelRepository(new Pool(client), { adapterOpsMode: true });

    assert.equal(await repository.isCapabilityRevoked('jti-a', 'tenant-a'), true);
    assert.equal(
      await repository.consumeCapabilityReplay({
        tenantId: 'tenant-a',
        jti: 'jti-a',
        nonce: 'nonce-a',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      false,
    );
    const capabilityQueries = client.queries.filter(({ sql }) =>
      /capability_(?:revocation|replay)/i.test(sql),
    );
    assert.equal(capabilityQueries.length, 2);
    assert.ok(capabilityQueries.every(({ sql }) => /_v1\(/i.test(sql)));
    assert.ok(
      capabilityQueries.every(
        ({ sql }) =>
          !/FROM\s+commander_capability_|INSERT\s+INTO\s+commander_capability_/i.test(sql),
      ),
    );
  });
});
