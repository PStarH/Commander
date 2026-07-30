import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createVerifiedPostgresPool } from '@commander/postgres-runtime';

const appUrl = process.env.COMMANDER_TASK1_APP_DATABASE_URL;
const authorityUrl = process.env.COMMANDER_TASK1_AUTHORITY_DATABASE_URL;

describe('Task 1 tenant context real PostgreSQL protocol', {
  skip: !appUrl || !authorityUrl,
}, () => {
  it('binds exactly one tenant to the target app xid and closes it', async () => {
    const appPool = createVerifiedPostgresPool({ connectionString: appUrl!, max: 1 });
    const authorityPool = createVerifiedPostgresPool({ connectionString: authorityUrl!, max: 1 });
    const app = await appPool.connect();
    try {
      await app.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const target = await app.query<{
        database_oid: number;
        backend_pid: number;
        xid: string;
      }>(`
        SELECT database.oid AS database_oid,
               pg_catalog.pg_backend_pid() AS backend_pid,
               pg_catalog.pg_current_xact_id()::text AS xid
          FROM pg_catalog.pg_database AS database
         WHERE database.datname = pg_catalog.current_database()
      `);
      const { database_oid, backend_pid, xid } = target.rows[0]!;
      const issued = await authorityPool.query<{ context_id: string }>(
        `SELECT context_id::text
           FROM public.issue_app_tenant_context($1, $2::oid, $3, $4::xid8)`,
        ['tenant-a', database_oid, backend_pid, xid],
      );
      const contextId = issued.rows[0]!.context_id;

      await assert.rejects(
        () => authorityPool.query(
          `SELECT context_id::text
             FROM public.issue_app_tenant_context($1, $2::oid, $3, $4::xid8)`,
          ['tenant-b', database_oid, backend_pid, xid],
        ),
        /TENANT_CONTEXT_INVALID/,
      );

      const first = await app.query<{ tenant_id: string; replayed: boolean }>(
        'SELECT tenant_id, replayed FROM public.bind_app_tenant_context($1::uuid)',
        [contextId],
      );
      assert.deepEqual(first.rows, [{ tenant_id: 'tenant-a', replayed: false }]);
      const replay = await app.query<{ tenant_id: string; replayed: boolean }>(
        'SELECT tenant_id, replayed FROM public.bind_app_tenant_context($1::uuid)',
        [contextId],
      );
      assert.deepEqual(replay.rows, [{ tenant_id: 'tenant-a', replayed: true }]);
      assert.equal(
        (await app.query<{ tenant_id: string }>(
          'SELECT public.commander_authenticated_app_tenant() AS tenant_id',
        )).rows[0]!.tenant_id,
        'tenant-a',
      );

      await app.query('SELECT public.close_app_tenant_context($1::uuid)', [contextId]);
      await assert.rejects(
        () => app.query('SELECT public.commander_authenticated_app_tenant()'),
        /TENANT_CONTEXT_INVALID/,
      );
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      app.release();
      await Promise.all([appPool.end(), authorityPool.end()]);
    }
  });
});
