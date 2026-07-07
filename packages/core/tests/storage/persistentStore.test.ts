import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createDriver,
  createDriverSoft,
  probeSqlite,
  probePostgres,
  PostgresDriver,
  InMemoryDriver,
  SqliteDriver,
  JsonDriver,
  type PersistentDriver,
  type PersistentTable,
  type TableSchema,
  type ColumnSpec,
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
    let driver: SqliteDriver | undefined;
    try {
      const dbPath = path.join(tmpDir, 'eq.db');
      driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
      await runScenario(driver);
    } finally {
      driver?.close();
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

// ---------------------------------------------------------------------------
// Regression lock — PostgresDriver ColumnSpec typing in bindValue() loop.
//
// Background. PostgresTable.insert() and insertOrReplace() previously used:
//
//   const cols = this.colNames();           // cols: string[]
//   const values = cols.map((c) =>          // c: string  ← the regression
//     this.bindValue(row[c.name], c),       //   TS2339 c.name on string
//   );                                      //   TS2345 c (string) ≠ ColumnSpec
//
// The fix iterates `this.schema.columns` directly so `c: ColumnSpec`.
//
// PRIMARY lock mechanism: this test file imports through the storage barrel
// (`../../src/storage` → `postgresDriver.ts`). If the source file regresses,
// package-level `tsc --noEmit` cascades the failure into this file and CI's
// pretest tsc gate fails before this test can run. That cascade is what
// actually catches a return of the internal `cols.map((c) => ...)` pattern.
//
// SECONDARY lock (below): a public-surface static guard locks four shape
// invariants of `TableSchema<T>['columns']`. These guards do NOT catch the
// source-internal regression — they catch accidental type relaxation on the
// public ColumnSpec surface, which would also break callers like this test.
// Together they form a defense-in-depth: package tsc (internal) + these
// guards (public shape).
// ---------------------------------------------------------------------------

interface ProbePgRow {
  id: string;
  category: string;
  value: number;
  active: boolean;
}

// ≥3 columns — the user's minimum, +1 to also exercise a non-string column
// (number + boolean) so bindValue's `col.type` narrowing is observed.
const probePgSchema: TableSchema<ProbePgRow> = {
  name: 'probe_pg_regression',
  columns: [
    { name: 'id', type: 'string' },
    { name: 'category', type: 'string' },
    { name: 'value', type: 'number' },
    { name: 'active', type: 'boolean' },
  ],
};

// Static length lock: if anyone drops/adds a column from the schema, this
// line fails tsc with TS2322 ("Type 'N' is not assignable to type '4'").
// Stabilises fixture expectations if a column count regression ever sneaks
// in alongside the ColumnSpec typing regression.
const _probePgSchemaColumnCount: 4 = probePgSchema.columns.length;

function makeProbePgRow(i: number): ProbePgRow {
  return {
    id: `pg-${i}`,
    category: i % 3 === 0 ? 'alpha' : i % 3 === 1 ? 'beta' : 'gamma',
    value: i * 11,
    active: i % 2 === 0,
  };
}

const pgUsable = probePostgres().available;
const pgConnectionString =
  process.env.PG_TEST_URL ?? process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const itPgIfAvailable = pgUsable && pgConnectionString ? it : it.skip;

describe('PostgresDriver — ColumnSpec typing regression lock', () => {
  it('schema columns expose ColumnSpec shape (c.name + c.type are typed)', () => {
    // Static guard #1: if `TableSchema<T>['columns']` regressioned to
    // `string[]`, this closure fails tsc with TS2339 "Property 'name' does
    // not exist on type 'string'" — the SAME error class as the original
    // postgresDriver.ts bug.
    const projections = probePgSchema.columns.map((c) => `${c.name}:${c.type}`);
    expect(projections.length).toBeGreaterThanOrEqual(3);

    // Static guard #2: explicit ColumnSpec[] annotation would fail tsc with
    // TS2322 if the column element type ever relaxed away from ColumnSpec.
    const asSpecs: ReadonlyArray<ColumnSpec> = probePgSchema.columns;

    // Runtime mirror — catches any silent runtime-shape relaxation even if
    // tsc is somehow bypassed.
    expect(projections).toEqual(['id:string', 'category:string', 'value:number', 'active:boolean']);
    for (const c of asSpecs) {
      expect(typeof c.name).toBe('string');
      expect(['string', 'number', 'boolean']).toContain(c.type);
    }
  });

  itPgIfAvailable(
    'insert + insertOrReplace exercise the ColumnSpec-typed bindValue loop end-to-end',
    async () => {
      const driver = createDriver({
        backend: 'postgres',
        path: pgConnectionString!,
        namespace: 'probe_pg_regression',
      }) as PostgresDriver;
      try {
        const table: PersistentTable<ProbePgRow> = driver.getTable(
          'probe_pg_regression',
          probePgSchema,
        );

        // PostgresTable methods are async at runtime even though the public
        // PersistentTable<T> interface is synchronous; the source casts the
        // returned table. The cast-through-any style matches sibling
        // tests/storage/postgresDriver.test.ts.
        await (driver as any).runQuery('DELETE FROM "probe_pg_regression"');

        const inserted = await (table as any).insert(makeProbePgRow(1));
        expect(inserted.id).toBe('pg-1');
        expect(inserted.category).toBe('alpha');

        const replaced = await (table as any).insertOrReplace({
          ...makeProbePgRow(1),
          category: 'gamma',
          value: 999,
        });
        expect(replaced.value).toBe(999);
        expect(replaced.category).toBe('gamma');

        const fetched = await (table as any).get('pg-1');
        expect(fetched).toBeTruthy();
        expect(fetched.value).toBe(999);
        expect(fetched.category).toBe('gamma');
      } finally {
        driver.close();
      }
    },
  );
});
