import { describe, it, expect } from 'vitest';
import { InMemoryDriver, TableSchema } from '../../src/storage';

interface ProbeRow {
  id: string;
  tag: string;
  num: number;
  flag: boolean;
}

const probeSchema: TableSchema<ProbeRow> = {
  name: 'probe_table',
  columns: [
    { name: 'id', type: 'string' },
    { name: 'tag', type: 'string' },
    { name: 'num', type: 'number' },
    { name: 'flag', type: 'boolean' },
  ],
};

describe('InMemoryDriver — contract', () => {
  it('inserts/reads/updates/deletes basic rows', () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    expect(t.get('r1')?.flag).toBe(true);
    expect(t.update('r1', { num: 2 })).toBe(true);
    expect(t.get('r1')?.num).toBe(2);
    expect(t.delete('r1')).toBe(true);
    expect(t.get('r1')).toBeNull();
    driver.close();
  });

  it('insertOrReplace upserts on collision', () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'v1', num: 1, flag: true });
    t.insertOrReplace({ id: 'r1', tag: 'v2', num: 2, flag: false });
    expect(t.count()).toBe(1);
    expect(t.get('r1')?.tag).toBe('v2');
    expect(t.get('r1')?.num).toBe(2);
    expect(t.get('r1')?.flag).toBe(false);
    driver.close();
  });

  it('updateIf returns null on predicate miss', () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });

    // Wrong tag → predicate fails
    const fail = t.updateIf('r1', { tag: 'second' }, { num: 99 });
    expect(fail).toBeNull();
    expect(t.get('r1')?.num).toBe(1); // unchanged

    // Matching tag → succeeds + only updates listed keys
    const ok = t.updateIf('r1', { tag: 'first' }, { num: 99 });
    expect(ok).not.toBeNull();
    expect(ok?.num).toBe(99);
    expect(t.get('r1')?.tag).toBe('first'); // not in patch → preserved
    driver.close();
  });

  it('updateIf with empty where plus empty patch returns current row or null', () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r1', tag: 'first', num: 1, flag: true });
    expect(t.updateIf('r1', {}, {})?.id).toBe('r1');
    expect(t.updateIf('nope', {}, {})).toBeNull();
    driver.close();
  });

  it('updateIf handles null predicate as IS-NULL', () => {
    interface Nullable {
      id: string;
      label: string;
      detail: string | null;
    }
    const schema: TableSchema<Nullable> = {
      name: 'n',
      columns: [
        { name: 'id', type: 'string' },
        { name: 'label', type: 'string' },
        { name: 'detail', type: 'string' },
      ],
    };
    const driver = new InMemoryDriver();
    const t = driver.getTable<Nullable>('n', schema);
    t.insert({ id: 'a', label: 'a', detail: null });
    t.insert({ id: 'b', label: 'b', detail: 'set' });

    // null → match row a only
    const updated = t.updateIf('a', { detail: null }, { detail: 'now-set' });
    expect(updated?.detail).toBe('now-set');
    expect(t.updateIf('b', { detail: null }, { detail: 'should-not-apply' })).toBeNull();
    driver.close();
  });

  it('query filter and sort and limit', () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    [
      { id: 'r1', tag: 'a', num: 3, flag: true },
      { id: 'r2', tag: 'a', num: 1, flag: false },
      { id: 'r3', tag: 'b', num: 2, flag: true },
    ].forEach((r) => t.insert(r));

    const filtered = t.query({ tag: 'a' });
    expect(filtered.map((r) => r.id)).toEqual(['r1', 'r2']);

    const sorted = t.query({}, { sort: [{ column: 'num', direction: 'asc' }] });
    expect(sorted.map((r) => r.num)).toEqual([1, 2, 3]);

    const limited = t.query({}, { limit: 2 });
    expect(limited.length).toBe(2);
    driver.close();
  });

  it('count with and without filter', () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    [
      { id: 'r1', tag: 'a', num: 1, flag: true },
      { id: 'r2', tag: 'a', num: 2, flag: false },
      { id: 'r3', tag: 'b', num: 3, flag: true },
    ].forEach((r) => t.insert(r));
    expect(t.count()).toBe(3);
    expect(t.count({ tag: 'a' })).toBe(2);
    driver.close();
  });

  it('transaction commits on resolve', async () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    await driver.transaction(() => {
      t.insert({ id: 'r1', tag: 'a', num: 1, flag: true });
      t.insert({ id: 'r2', tag: 'b', num: 2, flag: false });
    });
    expect(t.count()).toBe(2);
    driver.close();
  });

  it('transaction rolls back on throw', async () => {
    const driver = new InMemoryDriver();
    const t = driver.getTable<ProbeRow>('probe', probeSchema);
    t.insert({ id: 'r0', tag: 'pre', num: 0, flag: false });
    await expect(
      driver.transaction(() => {
        t.insert({ id: 'r1', tag: 'a', num: 1, flag: true });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(t.count()).toBe(1);
    expect(t.get('r0')?.tag).toBe('pre'); // preserved
    driver.close();
  });

  it('schema mismatch on re-registration throws', () => {
    const driver = new InMemoryDriver();
    driver.getTable<ProbeRow>('probe', probeSchema);
    const mismatched: TableSchema<{ id: string; other: string }> = {
      name: 'probe',
      columns: [
        { name: 'id', type: 'string' },
        { name: 'other', type: 'string' },
      ],
    };
    expect(() => driver.getTable('probe', mismatched)).toThrow(/schema mismatch/);
    driver.close();
  });
});
