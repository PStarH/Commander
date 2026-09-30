import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { KERNEL_CAPABILITY_DURABLE_ACCESS_SQL } from './capabilityPersistence.js';
import { KERNEL_MIGRATIONS } from './migrations.js';
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

  // F-K1-13: these were hard-coded, so the assertions only echoed the stub and no
  // revocation/replay logic was exercised. They are now inputs, and the test
  // checks both polarities plus the arguments actually bound into the RPC.
  constructor(
    private readonly revocation = true,
    private readonly replayConsumed = false,
  ) {}

  async query<T = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlQueryResult<T>> {
    this.queries.push({ sql, values });
    if (/session_user::text AS login_role/i.test(sql)) {
      return result([{ login_role: 'commander_adapter_ops' } as T]);
    }
    if (/read_capability_revocation_v1/i.test(sql)) {
      return result([{ read_capability_revocation_v1: this.revocation } as T]);
    }
    if (/consume_capability_replay_v1/i.test(sql)) {
      return result([{ consume_capability_replay_v1: this.replayConsumed } as T]);
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
  // F-K1-14: the regex assertions below would all pass on SQL text that is never
  // applied. Pin the body to the checksummed migration descriptor that executes it.
  it('applies the capability authority body through a checksummed migration', () => {
    const registered = KERNEL_MIGRATIONS.filter(
      (migration) => migration.sql === KERNEL_CAPABILITY_DURABLE_ACCESS_SQL,
    );
    assert.equal(registered.length, 1, 'the capability authority body must be applied once');
    assert.equal(
      registered[0]!.checksum,
      createHash('sha256').update(KERNEL_CAPABILITY_DURABLE_ACCESS_SQL).digest('hex'),
      'the migration checksum must pin this exact body',
    );
  });

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
    // F-K1-13: pin the identity actually bound into each owner RPC.
    const revocationCall = capabilityQueries.find(({ sql }) =>
      /read_capability_revocation_v1/i.test(sql),
    );
    assert.deepEqual(revocationCall?.values, ['tenant-a', 'jti-a']);
    const replayCall = capabilityQueries.find(({ sql }) =>
      /consume_capability_replay_v1/i.test(sql),
    );
    assert.deepEqual(replayCall?.values, [
      'tenant-a',
      'jti-a',
      'nonce-a',
      '2099-01-01T00:00:00.000Z',
    ]);
  });

  it('honours the RPC result in both polarities instead of a fixed answer', async () => {
    // F-K1-13: no revocation recorded and no replay consumed must read back as
    // false/false; a repository that hard-coded either answer fails here.
    const client = new RecordingClient(false, true);
    const repository = new PostgresKernelRepository(new Pool(client), { adapterOpsMode: true });

    assert.equal(await repository.isCapabilityRevoked('jti-b', 'tenant-b'), false);
    assert.equal(
      await repository.consumeCapabilityReplay({
        tenantId: 'tenant-b',
        jti: 'jti-b',
        nonce: 'nonce-b',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      true,
    );
  });
});
