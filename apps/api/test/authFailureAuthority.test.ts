import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SqlClient, SqlPool, SqlQueryResult } from '@commander/kernel';
import {
  createAuthFailureStore,
  PostgresAuthFailureStore,
  type AuthFailureEntry,
} from '../src/authFailureStore.js';

class RecordingClient implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  rows: Record<string, unknown>[] = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>> {
    this.calls.push({ sql, values });
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }

  async release(): Promise<void> {}
}

function recordingPool(client: RecordingClient): SqlPool {
  return { connect: async () => client };
}

describe('authentication-failure authority', () => {
  test('fails closed without DATABASE_URL even when a Redis URL is configured', () => {
    assert.throws(
      () =>
        createAuthFailureStore({
          environment: { AUTH_FAILURE_REDIS_URL: 'redis://forbidden' },
        }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  test('constructs only from a commander_app PostgreSQL connection', () => {
    const client = new RecordingClient();
    const store = createAuthFailureStore({
      environment: { DATABASE_URL: 'postgres://commander_app:password@db.example/commander' },
      createPool: () => recordingPool(client),
    });

    assert.ok(store instanceof PostgresAuthFailureStore);
  });

  test('records a lockout decision with one parameterized PostgreSQL upsert', async () => {
    const client = new RecordingClient();
    client.rows = [
      {
        count: 3,
        firstFailureAt: 1000,
        lastFailureAt: 2000,
        lockedUntil: 62_000,
      },
    ];
    const store = new PostgresAuthFailureStore(recordingPool(client));

    const entry = await store.recordFailure('203.0.113.9', 2000, 3, 60_000, 60_000);

    assert.deepEqual(entry, {
      count: 3,
      firstFailureAt: 1000,
      lastFailureAt: 2000,
      lockedUntil: 62_000,
    } satisfies AuthFailureEntry);
    assert.match(client.calls[0]!.sql, /^INSERT INTO commander_auth_failures/);
    assert.deepEqual(client.calls[0]!.values, ['203.0.113.9', 2000, 60_000, 3, 60_000]);
  });

  test('cleans up expired unlocked failures with parameterized PostgreSQL SQL', async () => {
    const client = new RecordingClient();
    const store = new PostgresAuthFailureStore(recordingPool(client));

    await store.cleanup(120_000, 60_000);

    assert.deepEqual(client.calls, [
      {
        sql:
          'DELETE FROM commander_auth_failures WHERE locked_until IS NULL AND last_failure_at < to_timestamp(($1 - $2) / 1000.0)',
        values: [120_000, 60_000],
      },
    ]);
  });
});
