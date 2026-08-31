import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SqlClient, SqlPool, SqlQueryResult } from '@commander/kernel';
import type { Request, Response } from 'express';
import express from 'express';
import {
  PostgresApiKeyStore,
  setApiKeyStoreForTesting,
  type ApiKeyStore,
} from '../src/apiKeyStore';
import { authMiddleware } from '../src/authMiddleware';
import {
  PostgresUserRepository,
  bootstrapDefaultAdmin,
  setUserRepositoryForTesting,
  type UserRepository,
} from '../src/userStore';
import { createUserAuthRouter } from '../src/userAuthEndpoints';
import type { RefreshTokenRepository } from '../src/refreshTokenStore';

type Query = { sql: string; values: readonly unknown[] | undefined };

class FakePool implements SqlPool {
  readonly queries: Query[] = [];
  private readonly users = new Map<string, Record<string, unknown>>();
  private readonly apiKeys = new Map<string, Record<string, unknown>>();

  async connect(): Promise<SqlClient> {
    return {
      query: async <T>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<T>> => {
        this.queries.push({ sql, values });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (sql.startsWith('INSERT INTO commander_auth_user_tenants')) {
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO commander_auth_users')) {
          const [id, username, email, passwordHash, role, issuer, subject] = values!;
          if (
            [...this.users.values()].some(
              (user) => String(user.username).toLowerCase() === String(username).toLowerCase(),
            )
          ) {
            const error = new Error('duplicate username') as Error & {
              code: string;
              constraint: string;
            };
            error.code = '23505';
            error.constraint = 'commander_auth_users_username_ci_uidx';
            throw error;
          }
          const row = {
            id,
            username,
            email,
            password_hash: passwordHash,
            role,
            oidc_issuer: issuer,
            oidc_subject: subject,
            created_at: '2026-08-21T00:00:00.000Z',
            last_login_at: null,
          };
          this.users.set(String(id), row);
          return { rows: [row as T], rowCount: 1 };
        }
        if (sql.includes('FROM commander_auth_users WHERE username')) {
          const username = String(values![0]).toLowerCase();
          const row = [...this.users.values()].find(
            (user) => String(user.username).toLowerCase() === username,
          );
          return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO commander_auth_api_keys')) {
          const [id, name, prefix, hash, scopes, tenantId] = values!;
          const row = {
            id,
            name,
            prefix,
            key_hash: hash,
            scopes,
            tenant_id: tenantId,
            enabled: true,
            created_at: '2026-08-21T00:00:00.000Z',
            revoked_at: null,
          };
          this.apiKeys.set(String(id), row);
          return { rows: [row as T], rowCount: 1 };
        }
        if (
          sql.startsWith('SELECT') &&
          sql.includes('commander_auth_api_keys') &&
          sql.includes('key_hash')
        ) {
          const row = [...this.apiKeys.values()].find(
            (key) => key.key_hash === values![0] && key.enabled === true,
          );
          return { rows: row ? [row as T] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.startsWith('UPDATE commander_auth_api_keys SET enabled = false')) {
          const row = this.apiKeys.get(String(values![0]));
          if (!row || row.enabled !== true) return { rows: [], rowCount: 0 };
          row.enabled = false;
          row.revoked_at = '2026-08-21T00:01:00.000Z';
          return { rows: [row as T], rowCount: 1 };
        }
        throw new Error('Unexpected SQL: ' + sql);
      },
      release: () => undefined,
    };
  }
}

class BootstrapPool implements SqlPool {
  readonly queries: Query[] = [];
  private hasUsers = false;

  async connect(): Promise<SqlClient> {
    return {
      query: async <T>(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult<T>> => {
        this.queries.push({ sql, values });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('pg_advisory_xact_lock')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT count(*)::text AS count FROM commander_auth_users')) {
          return { rows: [{ count: this.hasUsers ? '1' : '0' } as T], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO commander_auth_users')) {
          this.hasUsers = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO commander_auth_user_tenants')) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected SQL: ' + sql);
      },
      release: () => undefined,
    };
  }
}

describe('PostgreSQL auth authorities', () => {
  test('bootstraps the configured default admin exactly once under a PostgreSQL lock', async () => {
    const pool = new BootstrapPool();
    const repository = new PostgresUserRepository(pool);

    await bootstrapDefaultAdmin(
      {
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'operator-supplied-password',
        ADMIN_TENANT_ID: 'tenant-a',
      },
      repository,
    );
    await bootstrapDefaultAdmin(
      {
        NODE_ENV: 'production',
        ADMIN_PASSWORD: 'operator-supplied-password',
        ADMIN_TENANT_ID: 'tenant-a',
      },
      repository,
    );

    const inserts = pool.queries.filter((query) =>
      query.sql.startsWith('INSERT INTO commander_auth_users'),
    );
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0]?.values?.slice(1, 3), ['admin', 'admin@commander.local']);
    assert.equal(inserts[0]?.values?.[4], 'admin');
    assert.equal(inserts[0]?.values?.[3] === 'operator-supplied-password', false);
    const membership = pool.queries.find((query) =>
      query.sql.startsWith('INSERT INTO commander_auth_user_tenants'),
    );
    assert.deepEqual(membership?.values?.slice(1), ['tenant-a', 'admin']);
    assert.equal(
      pool.queries.filter((query) => query.sql.includes('pg_advisory_xact_lock')).length,
      2,
    );
  });

  test('refuses production bootstrap without an operator-supplied password', async () => {
    const pool = new BootstrapPool();
    await assert.rejects(
      () => bootstrapDefaultAdmin({ NODE_ENV: 'production' }, new PostgresUserRepository(pool)),
      /ADMIN_PASSWORD_REQUIRED/,
    );
    assert.equal(pool.queries.length, 0);
  });

  test('refuses bootstrap without an explicit operator tenant', async () => {
    const pool = new BootstrapPool();
    await assert.rejects(
      () =>
        bootstrapDefaultAdmin(
          { NODE_ENV: 'production', ADMIN_PASSWORD: 'operator-supplied-password' },
          new PostgresUserRepository(pool),
        ),
      /ADMIN_TENANT_REQUIRED/,
    );
    assert.equal(pool.queries.length, 0);
  });

  test('uses a database uniqueness constraint for usernames', async () => {
    const repository = new PostgresUserRepository(new FakePool());
    const testPassword = 'test-password';

    const first = await repository.createUser({
      username: 'Alice',
      email: 'alice@example.test',
      password: testPassword,
      tenantId: 'tenant-a',
    });
    const duplicate = await repository.createUser({
      username: 'alice',
      email: 'other@example.test',
      password: testPassword,
      tenantId: 'tenant-a',
    });

    assert.ok(!('error' in first));
    assert.deepEqual(duplicate, { error: 'Username already exists' });
  });

  test('reads API-key authorization from PostgreSQL after revocation', async () => {
    const pool = new FakePool();
    const store = new PostgresApiKeyStore(pool);
    const created = await store.create('automation', ['read'], 'tenant-a');

    assert.ok(await store.findByHash(created.record.hash));
    await store.revoke(created.record.id);
    assert.equal(await store.findByHash(created.record.hash), undefined);
    assert.equal(
      pool.queries.filter((query) => query.sql.includes('commander_auth_api_keys')).length,
      4,
    );
  });

  test('fails closed with a sanitized 503 when API-key authority is unavailable', async () => {
    const unavailableStore: ApiKeyStore = {
      list: async () => {
        throw new Error('postgres://commander_app:secret@db.example.test/auth');
      },
      findByHash: async () => {
        throw new Error('postgres://commander_app:secret@db.example.test/auth');
      },
      create: async () => {
        throw new Error('unavailable');
      },
      revoke: async () => {
        throw new Error('unavailable');
      },
      delete: async () => {
        throw new Error('unavailable');
      },
    };
    setApiKeyStoreForTesting(unavailableStore);
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      headersSent: false,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        this.headersSent = true;
        return this;
      },
    };
    try {
      let nextCalled = false;
      await authMiddleware(
        {
          path: '/api/protected',
          headers: { 'x-api-key': 'cmdr_test' },
          ip: '127.0.0.1',
          socket: { remoteAddress: '127.0.0.1' },
        } as unknown as Request,
        response as unknown as Response,
        () => {
          nextCalled = true;
        },
      );

      assert.equal(nextCalled, false);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.body, { error: 'Authentication service unavailable' });
      assert.equal(JSON.stringify(response.body).includes('secret'), false);
    } finally {
      setApiKeyStoreForTesting(undefined);
    }
  });

  test('does not create a user or issue credentials when user authority is unavailable', async () => {
    const unavailableUsers: UserRepository = {
      findUserById: async () => {
        throw new Error('unavailable');
      },
      findUserByUsername: async () => {
        throw new Error('unavailable');
      },
      findUserByEmail: async () => {
        throw new Error('unavailable');
      },
      findUserByOidcIdentity: async () => {
        throw new Error('unavailable');
      },
      findUserTenantMembership: async () => {
        throw new Error('unavailable');
      },
      listUsers: async () => {
        throw new Error('unavailable');
      },
      createUser: async () => {
        throw new Error('unavailable');
      },
      bindUserToOidcIdentity: async () => {
        throw new Error('unavailable');
      },
      updateLastLogin: async () => {
        throw new Error('unavailable');
      },
      updateUserRole: async () => {
        throw new Error('unavailable');
      },
      updateUser: async () => {
        throw new Error('unavailable');
      },
      resetUserPassword: async () => {
        throw new Error('unavailable');
      },
      deleteUser: async () => {
        throw new Error('unavailable');
      },
      countAdmins: async () => {
        throw new Error('unavailable');
      },
      bootstrapDefaultAdmin: async () => {
        throw new Error('unavailable');
      },
    };
    setUserRepositoryForTesting(unavailableUsers);
    try {
      const refreshTokens: RefreshTokenRepository = {
        insert: async () => undefined,
        consume: async () => false,
        revoke: async () => undefined,
        revokeAllForUser: async () => undefined,
        withUserSessionLock: async <T>(_userId: string, operation) => operation(refreshTokens),
      };
      const app = express();
      app.use(express.json());
      app.use(createUserAuthRouter({ refreshTokens }));
      const testPassword = 'test-password';
      const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
      });
      try {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const response = await fetch('http://127.0.0.1:' + port + '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username: 'alice',
            password: testPassword,
            tenantId: 'tenant-a',
          }),
        });
        const body = (await response.json()) as Record<string, unknown>;

        assert.equal(response.status, 503);
        assert.deepEqual(body, { error: 'Authentication service unavailable' });
        assert.equal(body.token, undefined);
        assert.equal(body.refreshToken, undefined);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      setUserRepositoryForTesting(undefined);
    }
  });
});
