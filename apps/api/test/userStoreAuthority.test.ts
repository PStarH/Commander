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

  assert.match(client.calls[0]!.sql, /SET password_hash = \$2, auth_version = auth_version \+ 1/);
  assert.equal(client.calls[0]!.values?.[0], 'user-1');
});

test('role mutation atomically advances the access-token authority version', async () => {
  const client = new RecordingClient();

  await repository(client).updateUserRole('user-1', 'viewer');

  assert.match(client.calls[0]!.sql, /SET role = \$2, auth_version = auth_version \+ 1/);
  assert.deepEqual(client.calls[0]!.values, ['user-1', 'viewer']);
});
