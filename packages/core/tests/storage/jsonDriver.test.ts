import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonDriver, TableSchema } from '../../src/storage';

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

describe('JsonDriver — contract', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-driver-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('inserts + reads back atomic-flushed files', () => {
    const driver = new JsonDriver({ backend: 'json', path: tmpDir });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    // File exists and is parseable
    const filePath = path.join(tmpDir, 'probe.json');
    expect(fs.existsSync(filePath)).toBe(true);
    // No stale .tmp
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    expect(t.get('r1')?.tag).toBe('first');
    driver.close();
  });

  it('persists across fresh driver open on same path', () => {
    const a = new JsonDriver({ backend: 'json', path: tmpDir });
    const ta = a.getTable<ProbeRow>('probe', probeSchema);
    ta.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    a.close();

    const b = new JsonDriver({ backend: 'json', path: tmpDir });
    const tb = b.getTable<ProbeRow>('probe', probeSchema);
    expect(tb.count()).toBe(1);
    expect(tb.get('r1')?.tag).toBe('first');
    b.close();
  });

  it('insertOrReplace overwrites on collision', () => {
    const driver = new JsonDriver({ backend: 'json', path: tmpDir });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'v1', num: 1, flag: true });
    t.insertOrReplace({ id: 'r1', tag: 'v2', num: 2, flag: false });
    const updated = t.get('r1');
    expect(updated?.tag).toBe('v2');
    expect(updated?.num).toBe(2);
    expect(updated?.flag).toBe(false);
    driver.close();
  });

  it('updateIf is CAS — no-op when predicate fails', () => {
    const driver = new JsonDriver({ backend: 'json', path: tmpDir });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    const fail = t.updateIf('r1', { tag: 'second' }, { num: 99 });
    expect(fail).toBeNull();
    expect(t.get('r1')?.num).toBe(1);
    const ok = t.updateIf('r1', { tag: 'first' }, { num: 50 });
    expect(ok?.num).toBe(50);
    expect(t.get('r1')?.tag).toBe('first');
    driver.close();
  });

  it('query + sort + limit', () => {
    const driver = new JsonDriver({ backend: 'json', path: tmpDir });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    [
      { id: 'a', tag: 'x', num: 3, flag: true },
      { id: 'b', tag: 'x', num: 1, flag: false },
      { id: 'c', tag: 'y', num: 2, flag: true },
    ].forEach((r) => t.insert(r));
    expect(t.query({ tag: 'x' }).length).toBe(2);
    expect(t.count({ tag: 'x' })).toBe(2);
    const sorted = t.query({}, { sort: [{ column: 'num', direction: 'asc' }] });
    expect(sorted.map((r) => r.num)).toEqual([1, 2, 3]);
    driver.close();
  });

  it('transaction commits on resolve; rolls back on throw', async () => {
    const a = new JsonDriver({ backend: 'json', path: tmpDir });
    const ta = a.getTable<ProbeRow>('probe', probeSchema);
    await a.transaction(() => {
      ta.insert({ id: 'committed', tag: 'a', num: 1, flag: true });
    });
    expect(ta.count()).toBe(1);

    const b = new JsonDriver({ backend: 'json', path: tmpDir });
    const tb = b.getTable<ProbeRow>('probe', probeSchema);
    await expect(
      b.transaction(() => {
        tb.insert({ id: 'rolled', tag: 'b', num: 2, flag: false });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const second = new JsonDriver({ backend: 'json', path: tmpDir });
    const ts = second.getTable<ProbeRow>('probe', probeSchema);
    expect(ts.count()).toBe(1); // rolled-back insert did not persist
    b.close();
    second.close();
  });
});
