import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PostgresDriver,
  probePostgres,
  createDriver,
  createDriverSoft,
  listAvailableBackends,
} from '../../src/storage';
import type { PersistentTable, TableSchema } from '../../src/storage/types';

interface TestRow {
  id: string;
  name: string;
  count: number;
  active: boolean;
}

const schema: TableSchema<TestRow> = {
  columns: [
    { name: 'id', type: 'string' },
    { name: 'name', type: 'string' },
    { name: 'count', type: 'number' },
    { name: 'active', type: 'boolean' },
  ],
};

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

const pgAvailable = probePostgres().available;
const describeIf = pgAvailable && connectionString ? describe : describe.skip;

describe('PostgresDriver availability', () => {
  it('reports availability consistently', () => {
    const status = probePostgres();
    expect(typeof status.available).toBe('boolean');
    if (!status.available) {
      expect(status.reason).toBeTruthy();
    }
  });

  it('throws when pg is unavailable', () => {
    if (pgAvailable) {
      // pg is installed; we cannot test the unavailable path without heavy
      // mocking, so just verify the probe is truthful.
      expect(probePostgres().available).toBe(true);
      return;
    }
    expect(() => createDriver({ backend: 'postgres', path: 'postgres://localhost/test' })).toThrow(
      /PostgresDriver unavailable/,
    );
  });

  it('soft factory falls back to memory when pg is unavailable', () => {
    if (pgAvailable) return;
    const result = createDriverSoft({
      backend: 'postgres',
      path: 'postgres://localhost/test',
    });
    expect(result.fellBack).toBe(true);
    expect(result.driver.backend).toBe('memory');
  });
});

describeIf('PostgresDriver integration', () => {
  let driver: PostgresDriver;
  let table: PersistentTable<TestRow>;

  beforeAll(async () => {
    driver = createDriver({
      backend: 'postgres',
      path: connectionString!,
      namespace: 'test_pg_driver',
    }) as PostgresDriver;
    table = driver.getTable('test_rows', schema);

    // Clean slate for the test table.
    await (driver as any).runQuery('DELETE FROM "test_rows"');
  });

  afterAll(async () => {
    // Drain the pool so the test process can exit cleanly.
    await (driver as any).pool.end();
  });

  it('lists postgres in available backends', () => {
    expect(listAvailableBackends()).toContain('postgres');
  });

  it('inserts and retrieves rows', async () => {
    const inserted = await (table as any).insert({
      id: 'row-1',
      name: 'alpha',
      count: 1,
      active: true,
    });
    expect(inserted.id).toBe('row-1');

    const got = await (table as any).get('row-1');
    expect(got).toBeTruthy();
    expect(got.name).toBe('alpha');
    expect(got.count).toBe(1);
    expect(got.active).toBe(true);
  });

  it('throws on duplicate insert', async () => {
    await expect(
      (table as any).insert({ id: 'row-1', name: 'alpha', count: 1, active: true }),
    ).rejects.toThrow(/already exists/);
  });

  it('upserts via insertOrReplace', async () => {
    const replaced = await (table as any).insertOrReplace({
      id: 'row-1',
      name: 'alpha-updated',
      count: 2,
      active: false,
    });
    expect(replaced.name).toBe('alpha-updated');

    const got = await (table as any).get('row-1');
    expect(got.count).toBe(2);
    expect(got.active).toBe(false);
  });

  it('updates rows', async () => {
    await (table as any).insert({
      id: 'row-2',
      name: 'beta',
      count: 5,
      active: false,
    });

    const updated = await (table as any).update('row-2', { count: 10 });
    expect(updated).toBe(true);

    const got = await (table as any).get('row-2');
    expect(got.count).toBe(10);
  });

  it('updateIf only updates when the predicate matches', async () => {
    await (table as any).insert({
      id: 'row-3',
      name: 'gamma',
      count: 7,
      active: true,
    });

    const noMatch = await (table as any).updateIf('row-3', { active: false }, { count: 99 });
    expect(noMatch).toBeNull();

    const matched = await (table as any).updateIf('row-3', { active: true }, { count: 99 });
    expect(matched).toBeTruthy();
    expect(matched.count).toBe(99);
  });

  it('queries and counts rows', async () => {
    await (driver as any).runQuery('DELETE FROM "test_rows"');
    await (table as any).insert({ id: 'q-1', name: 'alice', count: 1, active: true });
    await (table as any).insert({ id: 'q-2', name: 'bob', count: 2, active: false });
    await (table as any).insert({ id: 'q-3', name: 'alice', count: 3, active: true });

    const all = await (table as any).query();
    expect(all.length).toBe(3);

    const active = await (table as any).query({ active: true });
    expect(active.length).toBe(2);

    const alices = await (table as any).query(
      { name: 'alice' },
      { sort: [{ column: 'count', direction: 'asc' }] },
    );
    expect(alices.map((r: TestRow) => r.id)).toEqual(['q-1', 'q-3']);

    const limited = await (table as any).query({}, { limit: 2 });
    expect(limited.length).toBe(2);

    expect(await (table as any).count()).toBe(3);
    expect(await (table as any).count({ active: false })).toBe(1);
  });

  it('deletes rows', async () => {
    await (table as any).insert({ id: 'del-1', name: 'tmp', count: 0, active: true });
    expect(await (table as any).delete('del-1')).toBe(true);
    expect(await (table as any).get('del-1')).toBeNull();
    expect(await (table as any).delete('del-1')).toBe(false);
  });

  it('rolls back a failed transaction', async () => {
    await (driver as any).runQuery('DELETE FROM "test_rows"');

    try {
      await (driver as any).transaction(async () => {
        await (table as any).insert({ id: 'tx-1', name: 'in-tx', count: 1, active: true });
        throw new Error('boom');
      });
    } catch (err) {
      expect((err as Error).message).toBe('boom');
    }

    const got = await (table as any).get('tx-1');
    expect(got).toBeNull();
  });

  it('commits a successful transaction', async () => {
    await (driver as any).transaction(async () => {
      await (table as any).insert({ id: 'tx-2', name: 'committed', count: 1, active: true });
    });

    const got = await (table as any).get('tx-2');
    expect(got).toBeTruthy();
    expect(got.name).toBe('committed');
  });

  it('describe reports the backend and tables', () => {
    const desc = driver.describe();
    expect(desc.backend).toBe('postgres');
    expect(desc.path).toBe(connectionString);
    expect(desc.namespace).toBe('test_pg_driver');
    expect(desc.tables).toContain('test_rows');
    expect(desc.fellBack).toBe(false);
  });
});
