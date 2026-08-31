import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SqlClient, SqlPool } from '@commander/kernel';
import {
  PostgresRefreshTokenRepository,
  createRefreshTokenRepositoryFromEnvironment,
} from '../src/refreshTokenStore';

const CONSUME_SQL =
  'UPDATE commander_auth_refresh_tokens SET revoked_at = clock_timestamp() WHERE jti = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING jti';

interface StoredToken {
  userId: string;
  expiresAt: Date;
  revoked: boolean;
}

function createPoolHarness(connectionLimit = Number.POSITIVE_INFINITY): {
  pool: SqlPool;
  records: Map<string, StoredToken>;
  queries: Array<{ sql: string; values: readonly unknown[] }>;
  connectionCount: () => number;
} {
  const records = new Map<string, StoredToken>();
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  let activeConnections = 0;
  let connectionCount = 0;
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql.startsWith('INSERT INTO commander_auth_refresh_tokens')) {
        records.set(String(values[0]), {
          userId: String(values[1]),
          expiresAt: values[2] as Date,
          revoked: false,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql === CONSUME_SQL) {
        const jti = String(values[0]);
        const record = records.get(jti);
        if (!record || record.revoked || record.expiresAt.getTime() <= Date.now()) {
          return { rows: [], rowCount: 0 };
        }
        record.revoked = true;
        return { rows: [{ jti }] as T[], rowCount: 1 };
      }
      if (
        sql === 'SELECT pg_advisory_lock(hashtext($1))' ||
        sql === 'SELECT pg_advisory_unlock(hashtext($1))'
      ) {
        return { rows: [] as T[], rowCount: 1 };
      }
      if (
        sql ===
        'UPDATE commander_auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1'
      ) {
        const userId = String(values[0]);
        for (const record of records.values()) {
          if (record.userId === userId) record.revoked = true;
        }
        return { rows: [] as T[], rowCount: 1 };
      }
      throw new Error('unexpected query: ' + sql);
    },
    release() {
      activeConnections -= 1;
    },
  };
  return {
    records,
    queries,
    connectionCount: () => connectionCount,
    pool: {
      async connect() {
        if (activeConnections === connectionLimit) return new Promise<SqlClient>(() => undefined);
        activeConnections += 1;
        connectionCount += 1;
        return client;
      },
    },
  };
}

async function completesWithin<T>(operation: Promise<T>, timeoutMs = 100): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('refresh session operation timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('PostgreSQL refresh-token repository', () => {
  it('inserts a new unrevoked refresh-token authority record', async () => {
    const harness = createPoolHarness();
    const repository = new PostgresRefreshTokenRepository(harness.pool);
    const expiresAt = new Date(Date.now() + 60_000);

    await repository.insert({ jti: 'jti-1', userId: 'user-1', expiresAt });

    assert.deepEqual(harness.records.get('jti-1'), {
      userId: 'user-1',
      expiresAt,
      revoked: false,
    });
  });

  it('atomically allows exactly one concurrent consumer', async () => {
    const harness = createPoolHarness();
    const repository = new PostgresRefreshTokenRepository(harness.pool);
    await repository.insert({
      jti: 'jti-race',
      userId: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all([
      repository.consume('jti-race'),
      repository.consume('jti-race'),
    ]);

    assert.deepEqual(results.sort(), [false, true]);
    const consumeQueries = harness.queries.filter((query) => query.sql.startsWith('UPDATE'));
    assert.equal(consumeQueries.length, 2);
    assert.ok(consumeQueries.every((query) => query.sql === CONSUME_SQL));
  });

  it('revokes every active refresh token for one user without affecting other users', async () => {
    const harness = createPoolHarness();
    const repository = new PostgresRefreshTokenRepository(harness.pool);
    const expiresAt = new Date(Date.now() + 60_000);
    await repository.insert({ jti: 'jti-user-a-1', userId: 'user-a', expiresAt });
    await repository.insert({ jti: 'jti-user-a-2', userId: 'user-a', expiresAt });
    await repository.insert({ jti: 'jti-user-b-1', userId: 'user-b', expiresAt });

    await repository.revokeAllForUser('user-a');

    assert.equal(harness.records.get('jti-user-a-1')?.revoked, true);
    assert.equal(harness.records.get('jti-user-a-2')?.revoked, true);
    assert.equal(harness.records.get('jti-user-b-1')?.revoked, false);
  });

  it('holds a PostgreSQL user-session advisory lock through the supplied operation', async () => {
    const harness = createPoolHarness();
    const repository = new PostgresRefreshTokenRepository(harness.pool);
    let lockWasHeld = false;

    const result = await repository.withUserSessionLock('user-1', async () => {
      lockWasHeld = harness.queries.some(
        (query) => query.sql === 'SELECT pg_advisory_lock(hashtext($1))',
      );
      return 'locked-result';
    });

    assert.equal(result, 'locked-result');
    assert.equal(lockWasHeld, true);
    assert.deepEqual(
      harness.queries.map((query) => query.sql),
      ['SELECT pg_advisory_lock(hashtext($1))', 'SELECT pg_advisory_unlock(hashtext($1))'],
    );
  });

  it('executes every session-scoped token mutation on the locked connection', async () => {
    const harness = createPoolHarness(1);
    const repository = new PostgresRefreshTokenRepository(harness.pool);
    const expiresAt = new Date(Date.now() + 60_000);

    const result = await completesWithin(
      repository.withUserSessionLock(
        'user-1',
        async (
          session: Pick<
            RefreshTokenRepository,
            'consume' | 'insert' | 'revokeAllForUser'
          > = repository,
        ) => {
          await session.insert({ jti: 'jti-session', userId: 'user-1', expiresAt });
          const consumed = await session.consume('jti-session');
          await session.revokeAllForUser('user-1');
          return consumed;
        },
      ),
    );

    assert.equal(result, true);
    assert.equal(harness.connectionCount(), 1);
    assert.equal(harness.records.get('jti-session')?.revoked, true);
  });

  it('requires DATABASE_URL with the commander_app role and verified pool factory', () => {
    const pool = createPoolHarness().pool;
    let factoryInput: { connectionString: string } | undefined;
    let factoryEnv: NodeJS.ProcessEnv | undefined;
    const env = {
      DATABASE_URL: 'postgresql://commander_app:secret@db.example.test/commander',
      COMMANDER_DATABASE_CA_PEM: 'test-ca',
      COMMANDER_DATABASE_SERVER_SPKI_SHA256: 'test-pin',
    };

    const repository = createRefreshTokenRepositoryFromEnvironment(env, (input, receivedEnv) => {
      factoryInput = input;
      factoryEnv = receivedEnv;
      return pool;
    });

    assert.ok(repository instanceof PostgresRefreshTokenRepository);
    assert.deepEqual(factoryInput, { connectionString: env.DATABASE_URL });
    assert.equal(factoryEnv, env);
    assert.throws(
      () => createRefreshTokenRepositoryFromEnvironment({}, () => pool),
      /AUTH_REFRESH_DATABASE_URL_REQUIRED/,
    );
    assert.throws(
      () =>
        createRefreshTokenRepositoryFromEnvironment(
          { DATABASE_URL: 'postgresql://postgres:secret@db.example.test/commander' },
          () => pool,
        ),
      /AUTH_REFRESH_DATABASE_ROLE_INVALID/,
    );
  });
});
