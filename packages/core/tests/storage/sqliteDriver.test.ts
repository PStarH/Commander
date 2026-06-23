import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteDriver,
  probeSqlite,
  _resetSqliteProbeForTesting,
  TableSchema,
} from '../../src/storage';

interface ProbeRow {
  id: string;
  tag: string;
  num: number;
  flag: boolean;
}

const probeSchema: TableSchema<ProbeRow> = {
  name: 'probe',
  columns: [
    { name: 'id', type: 'string' },
    { name: 'tag', type: 'string' },
    { name: 'num', type: 'number' },
    { name: 'flag', type: 'boolean' },
  ],
};

const hasSqlite = probeSqlite().available;

describe('SqliteDriver — contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetSqliteProbeForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-driver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(!hasSqlite)('insert + get + update + delete', () => {
    const dbPath = path.join(tmpDir, 'contract.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    expect(t.get('r1')?.flag).toBe(true);
    expect(t.update('r1', { num: 2 })).toBe(true);
    expect(t.get('r1')?.num).toBe(2);
    expect(t.delete('r1')).toBe(true);
    expect(t.get('r1')).toBeNull();
    driver.close();
  });

  it.skipIf(!hasSqlite)('persists across reopen (kill9 atomicity contract)', () => {
    const dbPath = path.join(tmpDir, 'persist.db');
    const d1 = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t1 = d1.getTable<ProbeRow>('probe', probeSchema);
    t1.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    t1.insert({ id: 'r2', tag: 'second', num: 2, flag: false });
    d1.close();

    const d2 = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t2 = d2.getTable<ProbeRow>('probe', probeSchema);
    expect(t2.count()).toBe(2);
    expect(t2.get('r1')?.tag).toBe('first');
    d2.close();
  });

  it.skipIf(!hasSqlite)('chmod sets 0o600 on DB file (filePermissions invariant)', () => {
    if (process.platform === 'win32') return; // chmod semantics different
    const dbPath = path.join(tmpDir, 'perms.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    driver.getTable<ProbeRow>('probe', probeSchema); // forces create + flush
    const mode = fs.statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);
    driver.close();
  });

  it.skipIf(!hasSqlite)('chmod sets 0o700 on parent directory', () => {
    if (process.platform === 'win32') return;
    const dbPath = path.join(tmpDir, 'subdir', 'perms.db'); // subdir doesn't exist; mk
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    driver.getTable<ProbeRow>('probe', probeSchema);
    const mode = fs.statSync(path.dirname(dbPath)).mode & 0o777;
    expect(mode).toBe(0o700);
    driver.close();
  });

  it.skipIf(!hasSqlite)('insertOrReplace upsert on collision', () => {
    const dbPath = path.join(tmpDir, 'upsert.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'v1', num: 1, flag: true });
    t.insertOrReplace({ id: 'r1', tag: 'v2', num: 2, flag: false });
    const updated = t.get('r1');
    expect(updated?.tag).toBe('v2');
    expect(updated?.num).toBe(2);
    expect(updated?.flag).toBe(false);
    driver.close();
  });

  it.skipIf(!hasSqlite)('updateIf — atomic CAS preserves non-patch columns (BLOCKER-fix)', () => {
    const dbPath = path.join(tmpDir, 'cas.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    // Predicate matches → only `num` updates, `tag`+`flag` preserved
    const ok = t.updateIf('r1', { tag: 'first', flag: true }, { num: 99 });
    expect(ok?.num).toBe(99);
    expect(ok?.tag).toBe('first');
    expect(ok?.flag).toBe(true);
    driver.close();
  });

  it.skipIf(!hasSqlite)('updateIf returns null on predicate mismatch', () => {
    const dbPath = path.join(tmpDir, 'cas-fail.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    const fail = t.updateIf('r1', { tag: 'second' }, { num: 99 });
    expect(fail).toBeNull();
    // Original `num` preserved
    expect(t.get('r1')?.num).toBe(1);
    driver.close();
  });

  it.skipIf(!hasSqlite)('count uses native SELECT COUNT(*) — O(1)', () => {
    const dbPath = path.join(tmpDir, 'count.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    for (let i = 0; i < 50; i++) {
      t.insert({ id: `r${i}`, tag: i % 2 === 0 ? 'a' : 'b', num: i, flag: i % 2 === 0 });
    }
    expect(t.count()).toBe(50);
    expect(t.count({ tag: 'a' })).toBe(25);
    driver.close();
  });

  it.skipIf(!hasSqlite)('transaction commits + rolls back', async () => {
    const dbPath = path.join(tmpDir, 'tx.db');
    const driver = new SqliteDriver({ backend: 'sqlite', path: dbPath });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);

    await driver.transaction(() => {
      t.insert({ id: 'r1', tag: 'a', num: 1, flag: true });
    });
    expect(t.count()).toBe(1);

    await driver.transaction(() => {
      t.insert({ id: 'r2', tag: 'b', num: 2, flag: false });
    });
    expect(t.count()).toBe(2);

    await expect(
      driver.transaction(() => {
        t.insert({ id: 'r3', tag: 'c', num: 3, flag: true });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Rolled back: count stays at 2
    expect(t.count()).toBe(2);
    driver.close();
  });
});
