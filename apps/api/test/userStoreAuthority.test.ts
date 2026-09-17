import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlClient, SqlPool, SqlQueryResult } from '@commander/kernel';
import { PostgresUserRepository } from '../src/userStore.js';

class RecordingClient implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];

  async query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<T>> {
    this.calls.push({ sql, values });
    return { rows: [], rowCount: 0 };
  }

  async release(): Promise<void> {}
}

function repository(client: RecordingClient): PostgresUserRepository {
  return new PostgresUserRepository({ connect: async () => client } satisfies SqlPool);
}

test('password reset atomically advances the access-token authority version', async () => {
  const client = new RecordingClient();

  await repository(client).resetUserPassword('user-1', 'replacement-password');

  // AUDIT F-B-26: pin the full statement, not just a substring — a single
  // atomic UPDATE ... RETURNING (no read-modify-write) is the property that
  // makes the version bump race-free. The behavioural consequence (an old
  // access token actually being rejected) is covered end-to-end by
  // apps/api/test/accessTokenRevocation.test.ts against the real jwtMiddleware.
  assert.match(
    client.calls[0]!.sql,
    /UPDATE commander_auth_users\s+SET password_hash = \$2, auth_version = auth_version \+ 1\s+WHERE id = \$1 RETURNING/,
  );
  assert.equal(client.calls[0]!.values?.[0], 'user-1');
  assert.notEqual(client.calls[0]!.values?.[1], 'replacement-password');
  assert.match(String(client.calls[0]!.values?.[1]), /^\$2[aby]\$/, 'a bcrypt hash must be bound');
  assert.equal(
    client.calls.some((c) => /SELECT/i.test(c.sql)),
    false,
    'the bump must not be a read-modify-write',
  );
});

test('role mutation atomically advances the access-token authority version', async () => {
  const client = new RecordingClient();

  await repository(client).updateUserRole('user-1', 'viewer');

  assert.match(
    client.calls[0]!.sql,
    /UPDATE commander_auth_users\s+SET role = \$2, auth_version = auth_version \+ 1\s+WHERE id = \$1 RETURNING/,
  );
  assert.deepEqual(client.calls[0]!.values, ['user-1', 'viewer']);
  assert.equal(
    client.calls.some((c) => /SELECT/i.test(c.sql)),
    false,
    'the bump must not be a read-modify-write',
  );
});
