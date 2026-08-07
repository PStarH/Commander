import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pool } from 'pg';

const ownerUrl = process.env.COMMANDER_TASK1_PG_URL;

describe('Task 1 lifecycle initializer PostgreSQL fixture', { skip: !ownerUrl }, () => {
  it('requires a live owner fixture before claiming initializer authority proof', async () => {
    const pool = new Pool({ connectionString: ownerUrl!, max: 1 });
    try {
      const result = await pool.query<{ major: string }>(
        "SELECT current_setting('server_version_num')::text AS major",
      );
      assert.match(result.rows[0]?.major ?? '', /^16/, 'TASK1_LIFECYCLE_POSTGRES_16_REQUIRED');
    } finally {
      await pool.end();
    }
  });

  it('serializes the legacy-compatible and database-scoped lifecycle session locks', async () => {
    const pool = new Pool({ connectionString: ownerUrl!, max: 2 });
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query(
        "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext('commander.kernel.migrations'))",
      );
      const legacyBlocked = await second.query<{ locked: boolean }>(
        "SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext('commander.kernel.migrations')) AS locked",
      );
      assert.equal(legacyBlocked.rows[0]?.locked, false);
      await first.query(
        "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('commander.kernel.migrations'))",
      );

      const lifecycleLock = `pg_catalog.hashtextextended(
        'commander.kernel.lifecycle/' || (
          SELECT oid::text FROM pg_catalog.pg_database
           WHERE datname = pg_catalog.current_database()
        ), 0)`;
      await first.query(`SELECT pg_catalog.pg_advisory_lock(${lifecycleLock})`);
      const lifecycleBlocked = await second.query<{ locked: boolean }>(
        `SELECT pg_catalog.pg_try_advisory_lock(${lifecycleLock}) AS locked`,
      );
      assert.equal(lifecycleBlocked.rows[0]?.locked, false);
      await first.query(`SELECT pg_catalog.pg_advisory_unlock(${lifecycleLock})`);
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
  });

  it('permits exactly one stale-version CAS while retaining separate origin and peer identities', async () => {
    const pool = new Pool({ connectionString: ownerUrl!, max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE task1_lifecycle_cas (
          state_version bigint NOT NULL,
          configuration_sha256 text NOT NULL,
          origin_binding_sha256 text NOT NULL,
          database_peer_binding_sha256 text NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query('INSERT INTO task1_lifecycle_cas VALUES (0,$1,$2,$3)', [
        'a'.repeat(64),
        'b'.repeat(64),
        'c'.repeat(64),
      ]);
      const first = await client.query(
        `
        UPDATE task1_lifecycle_cas
           SET state_version = 1
         WHERE state_version = 0
           AND configuration_sha256 = $1
           AND origin_binding_sha256 = $2
           AND database_peer_binding_sha256 = $3
      `,
        ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
      );
      const stale = await client.query(
        `
        UPDATE task1_lifecycle_cas
           SET state_version = 2
         WHERE state_version = 0
           AND configuration_sha256 = $1
           AND origin_binding_sha256 = $2
           AND database_peer_binding_sha256 = $3
      `,
        ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
      );
      const substitutedOrigin = await client.query(
        `
        UPDATE task1_lifecycle_cas
           SET state_version = 2
         WHERE state_version = 1
           AND configuration_sha256 = $1
           AND origin_binding_sha256 = $2
           AND database_peer_binding_sha256 = $3
      `,
        ['a'.repeat(64), 'd'.repeat(64), 'c'.repeat(64)],
      );
      assert.equal(first.rowCount, 1);
      assert.equal(stale.rowCount, 0);
      assert.equal(substitutedOrigin.rowCount, 0);
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  });
});
