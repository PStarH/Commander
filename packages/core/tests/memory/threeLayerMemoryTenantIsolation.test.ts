import { describe, it, expect, beforeEach } from 'vitest';
import { ThreeLayerMemory } from '../../src/threeLayerMemory';

/**
 * ET-05 (`.internal/audit-2026-09-10/batchE-core-top.md`): the class header
 * claims class-level defence in depth — "a buggy caller also cannot read
 * another tenant's data" — and every *read* path (`get`, `querySync`,
 * `searchRelated`, `promoteToLongTerm`, `archiveToEpisodic`) calls
 * `filterByTenant`. But `delete`, `clearLayer`, `getAll`, `getStats` and the
 * empty-query branch of `searchRelated` walked the raw `memories` map.
 *
 * These tests pin the invariant on the write paths, where a miss is
 * destructive rather than merely a disclosure.
 */
describe('ThreeLayerMemory cross-tenant isolation (ET-05)', () => {
  let memory: ThreeLayerMemory;

  beforeEach(() => {
    memory = new ThreeLayerMemory();
  });

  const seed = (tenantId: string, content: string, layer: 'working' | 'episodic' = 'episodic') => {
    memory.setTenantContext(tenantId);
    const entry = memory.add(content, layer, `ctx-${tenantId}`);
    return entry.id;
  };

  it('delete() refuses an entry owned by another tenant and does not remove it', () => {
    const alphaId = seed('alpha', 'alpha secret');

    memory.setTenantContext('beta');
    expect(memory.delete(alphaId)).toBe(false);

    memory.setTenantContext('alpha');
    expect(memory.get(alphaId)?.content).toBe('alpha secret');
  });

  it('delete() still removes an entry owned by the active tenant', () => {
    const alphaId = seed('alpha', 'alpha own');
    memory.setTenantContext('alpha');
    expect(memory.delete(alphaId)).toBe(true);
    expect(memory.get(alphaId)).toBeUndefined();
  });

  it('clearLayer() clears only the active tenant layer', () => {
    seed('alpha', 'alpha episodic', 'episodic');
    seed('alpha', 'alpha working', 'working');
    seed('beta', 'beta episodic', 'episodic');

    memory.setTenantContext('beta');
    const removed = memory.clearLayer('episodic');
    expect(removed).toBe(1);

    memory.setTenantContext('alpha');
    expect(memory.getByLayer('episodic').map((e) => e.content)).toEqual(['alpha episodic']);
    expect(memory.getByLayer('working').map((e) => e.content)).toEqual(['alpha working']);
  });

  it('getAll() never returns another tenant entries', () => {
    seed('alpha', 'alpha entry');
    seed('beta', 'beta entry');

    memory.setTenantContext('alpha');
    expect(memory.getAll().map((e) => e.content)).toEqual(['alpha entry']);

    memory.setTenantContext('beta');
    expect(memory.getAll().map((e) => e.content)).toEqual(['beta entry']);
  });

  it('getStats() counts only the active tenant entries', () => {
    seed('alpha', 'alpha 1');
    seed('alpha', 'alpha 2');
    seed('beta', 'beta 1');

    memory.setTenantContext('alpha');
    expect(memory.getStats().totalEntries).toBe(2);

    memory.setTenantContext('beta');
    expect(memory.getStats().totalEntries).toBe(1);
  });

  it('searchRelated() with an empty query filters by tenant', () => {
    seed('alpha', 'alpha searchable');
    seed('beta', 'beta searchable');

    memory.setTenantContext('alpha');
    expect(memory.searchRelated('').map((e) => e.content)).toEqual(['alpha searchable']);
  });

  it('a no-context caller sees only untagged entries, on every path', () => {
    memory.setTenantContext(null);
    memory.add('legacy global', 'episodic');

    seed('alpha', 'alpha scoped');

    memory.setTenantContext(null);
    expect(memory.getAll().map((e) => e.content)).toEqual(['legacy global']);
    expect(memory.getStats().totalEntries).toBe(1);
    expect(memory.searchRelated('').map((e) => e.content)).toEqual(['legacy global']);
    expect(memory.clearLayer('episodic')).toBe(1);
  });
});
