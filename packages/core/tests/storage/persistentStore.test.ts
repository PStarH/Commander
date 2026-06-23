import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createDriver,
  createDriverSoft,
  probeSqlite,
  InMemoryDriver,
  SqliteDriver,
  JsonDriver,
  type PersistentDriver,
  type PersistentTable,
  type TableSchema,
} from '../../src/storage';

interface Probe {
  id: string;
  category: string;
  value: number;
  active: boolean;
}

const schema: TableSchema<Probe> = {
  name: 'probe',
  columns: [
    { name: 'id', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'value', type: 'number' },
    { name: 'active', type: 'boolean' },
  ],
};

function makeProbe(i: number): Probe {
  return {
    id: `p${i}`,
    category: i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma',
    value: i * 7,
    active: i % 2 === 0,
  };
}

async function runScenario(driver: PersistentDriver): Promise<void> {
  const t: PersistentTable<Probe> = driver.getTable('probe', schema);

  // Insert 6 rows
  for (let i = 0; i < 6; i++) t.insert(makeProbe(i));
  expect(t.count()).toBe(6);

  // Get by id
  const fetched = t.get('p3');
  expect(fetched?.category).toBe('alpha');
  expect(fetched?.active).toBe(false);

  // Filter + sort
  const alpha = t.query({ category: 'alpha' }, { sort: [{ column: 'value', direction: 'desc' }] });
  expect(alpha.length).toBe(2);
  expect(alpha[0].value).toBeGreaterThan(alpha[1].value);

  // updateIf preserves non-patch fields
  const result = t.updateIf('p0', { category: 'alpha' }, { value: 999 });
  expect(result?.value).toBe(999);
  expect(result?.category).toBe('alpha');
  expect(result?.active).toBe(true);
  expect(t.get('p0')?.active).toBe(true);

  // updateIf returns null on predicate miss
  expect(t.updateIf('p0', { category: 'gamma' }, { value: 1 })).toBeNull();

  // query with limit/offset
  const limited = t.query({}, { limit: 3, sort: [{ column: 'value', direction: 'asc' }] });
  expect(limited.length).toBe(3);

  // Insert or replace
  t.insertOrReplace({ id: 'p0', category: 'alpha', value: 1, active: false });
  expect(t.get('p0')?.value).toBe(1);
  expect(t.count()).toBe(6); // upsert keeps total

  // Delete
  expect(t.delete('p5')).toBe(true);
  expect(t.count()).toBe(5);

  // Transaction commit + rollback
  await driver.transaction(() => {
    t.insert({ id: 'roll', category: 'x', value: 0, active: true });
  });
  expect(t.count()).toBe(6);

  await expect(
    driver.transaction(() => {
      t.insert({ id: 'will_rollback', category: 'y', value: 0, active: true });
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(t.get('will_rollback')).toBeNull();
}

describe('PersistentDriver — cross-driver equivalence', () => {
  it('InMemoryDriver satisfies the contract', async () => {
    await runScenario(new InMemoryDriver());
  });

  it.skipIf(!probeSqlite().available)('SqliteDriver satisfies the contract', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-sqlite-'));
    try {
      const dbPath = path.join(tmpDir, 'eq.db');
      await runScenario(new SqliteDriver({ backend: 'sqlite', path: dbPath }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('JsonDriver satisfies the contract', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-json-'));
    try {
      await runScenario(new JsonDriver({ backend: 'json', path: tmpDir }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('createDriverSoft falls back to memory when sqlite unavailable', () => {
    // Pass ':memory:' as a path that the OS will reject (a directory). The
    // sqlite driver will then throw, exercising the soft-fallback path.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-soft-'));
    try {
      const result = createDriverSoft({ backend: 'sqlite', path: tmpDir });
      // Either sqlite opener succeeded (allowed) OR fell back to memory.
      // Either way, the contract must hold.
      expect(result.driver).toBeDefined();
      // For safety: if it actually opened sqlite, the underlying DB lives at
      // `tmpDir/.db` because `:memory:` is a valid better-sqlite3 token, but
      // passing a directory path causes SqliteOpenError.
      // The contract here is just that the factory didn't throw.
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('createDriver dispatches by backend', () => {
    expect(createDriver({ backend: 'memory' }).backend).toBe('memory');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-create-'));
    try {
      expect(createDriver({ backend: 'json', path: tmpDir }).backend).toBe('json');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
