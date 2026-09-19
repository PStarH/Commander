import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PostgresKernelRepository } from './postgres.js';
import type { SqlClient, SqlPool, SqlQueryResult } from './postgres.js';

/**
 * KC-02: every failure after a successful `pool.connect()` must return the slot
 * to the pool exactly once. Identity lookup and SET ROLE failures used to leak
 * the client, so repeated failures could exhaust the application pool while the
 * caller's transaction never saw the underlying handle.
 */
describe('PostgresKernelRepository role setup client lifecycle', () => {
  function fakePool(
    handler: (sql: string) => SqlQueryResult | Promise<SqlQueryResult>,
    state: { releases: number; releaseErrors: Array<Error | undefined> },
  ): SqlPool {
    const client: SqlClient = {
      async query<T = Record<string, unknown>>(sql: string): Promise<SqlQueryResult<T>> {
        return (await handler(sql)) as SqlQueryResult<T>;
      },
      release(error?: Error | boolean) {
        state.releases += 1;
        state.releaseErrors.push(typeof error === 'object' ? error : undefined);
      },
    };
    return { connect: async () => client };
  }

  it('releases the client and preserves the error when identity lookup fails', async () => {
    const state = { releases: 0, releaseErrors: [] as Array<Error | undefined> };
    const repository = new PostgresKernelRepository(
      fakePool((sql) => {
        if (sql.includes('session_user')) throw new Error('identity unavailable');
        return { rows: [], rowCount: 0 };
      }, state),
    );

    await assert.rejects(() => repository.getRun('run-1', 'tenant-a'), /identity unavailable/);
    assert.equal(state.releases, 1, 'the checked-out client must be released exactly once');
  });

  it('releases the client and preserves the error when SET ROLE fails', async () => {
    const state = { releases: 0, releaseErrors: [] as Array<Error | undefined> };
    const repository = new PostgresKernelRepository(
      fakePool((sql) => {
        if (sql.includes('session_user')) {
          return { rows: [{ login_role: 'commander_owner' }], rowCount: 1 };
        }
        if (sql.includes("rolname = 'commander_app'")) {
          return { rows: [{ exists: true }], rowCount: 1 };
        }
        if (sql === 'SET ROLE commander_app') throw new Error('set role rejected');
        return { rows: [], rowCount: 0 };
      }, state),
    );

    await assert.rejects(
      () => repository.getRun('run-1', 'tenant-a'),
      /failed to SET ROLE commander_app: set role rejected/,
    );
    assert.equal(state.releases, 1, 'the checked-out client must be released exactly once');
  });

  it('does not release during a successful identity-preserving connection', async () => {
    const state = { releases: 0, releaseErrors: [] as Array<Error | undefined> };
    const repository = new PostgresKernelRepository(
      fakePool((sql) => {
        if (sql.includes('session_user')) {
          return { rows: [{ login_role: 'commander_app' }], rowCount: 1 };
        }
        if (/^BEGIN/i.test(sql) || /^COMMIT/i.test(sql) || /^ROLLBACK/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      }, state),
    );

    assert.equal(await repository.getRun('run-1', 'tenant-a'), null);
    assert.equal(state.releases, 1, 'a completed transaction releases its client once');
  });
});
