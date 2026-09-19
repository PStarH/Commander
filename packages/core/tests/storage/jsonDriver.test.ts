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
  it('returns a copy from insert so the stored row cannot be mutated through it', () => {
    const driver = new JsonDriver({ backend: 'json', path: tmpDir });
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    const returned = t.insert({ id: 'alias', tag: 'a', num: 1, flag: true });
    returned.num = 99;
    expect(t.get('alias')?.num).toBe(1);
    driver.close();
  });

  it('does not discard an acknowledged write made by a second instance (S6)', () => {
    const a = new JsonDriver({ backend: 'json', path: tmpDir });
    const ta = a.getTable<ProbeRow>('probe', probeSchema);
    // `b` opens the same file *before* `a` writes, so its snapshot is stale and
    // empty. A blind whole-file rewrite from `b` would drop `a`'s acknowledged
    // row; the read-modify-write must merge it back.
    const b = new JsonDriver({ backend: 'json', path: tmpDir });
    const tb = b.getTable<ProbeRow>('probe', probeSchema);

    ta.insert({ id: 'ack', tag: 'first', num: 1, flag: true });
    tb.insert({ id: 'second', tag: 'second', num: 2, flag: false });

    const fresh = new JsonDriver({ backend: 'json', path: tmpDir });
    const tf = fresh.getTable<ProbeRow>('probe', probeSchema);
    expect(tf.get('ack')).not.toBeNull();
    expect(tf.get('second')).not.toBeNull();
    expect(tf.count()).toBe(2);
    a.close();
    b.close();
    fresh.close();
  });

  it('does not resurrect a row an earlier instance deleted (S6)', () => {
    const a = new JsonDriver({ backend: 'json', path: tmpDir });
    const ta = a.getTable<ProbeRow>('probe', probeSchema);
    ta.insert({ id: 'keep', tag: 'k', num: 1, flag: true });
    ta.insert({ id: 'gone', tag: 'g', num: 2, flag: true });

    const b = new JsonDriver({ backend: 'json', path: tmpDir });
    const tb = b.getTable<ProbeRow>('probe', probeSchema);
    ta.delete('gone');
    tb.insert({ id: 'added', tag: 'a', num: 3, flag: false });

    const fresh = new JsonDriver({ backend: 'json', path: tmpDir });
    const tf = fresh.getTable<ProbeRow>('probe', probeSchema);
    expect(tf.get('gone')).toBeNull();
    expect(tf.get('keep')).not.toBeNull();
    expect(tf.get('added')).not.toBeNull();
    a.close();
    b.close();
    fresh.close();
  });

  it('rolls back tables first opened inside a rejected transaction', async () => {
    const driver = new JsonDriver({ backend: 'json', path: tmpDir });
    const outer = driver.getTable<ProbeRow>('probe', probeSchema);
    outer.insert({ id: 'kept', tag: 'pre', num: 0, flag: true });

    let leakedHandle: ReturnType<typeof driver.getTable<ProbeRow>> | undefined;
    await expect(
      driver.transaction(() => {
        leakedHandle = driver.getTable<ProbeRow>('late', probeSchema);
        leakedHandle.insert({ id: 'leaked', tag: 'x', num: 1, flag: true });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(leakedHandle?.get('leaked')).toBeNull();
    const reopened = driver.getTable<ProbeRow>('late', probeSchema);
    expect(reopened.count()).toBe(0);
    driver.close();

    // Nothing leaked to disk either.
    const fresh = new JsonDriver({ backend: 'json', path: tmpDir });
    const freshLate = fresh.getTable<ProbeRow>('late', probeSchema);
    expect(freshLate.get('leaked')).toBeNull();
    fresh.close();
  });
});
