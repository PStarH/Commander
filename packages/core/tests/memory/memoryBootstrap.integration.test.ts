import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootstrapMemoryPersistence, resolveMemoryStoreType } from '../../src/memory/utils';
import { getUnifiedMemory, resetUnifiedMemory } from '../../src/memory/unifiedMemory';
import {
  getGlobalThreeLayerMemory,
  resetGlobalThreeLayerMemory,
  wireGlobalThreeLayerMemory,
} from '../../src/threeLayerMemory';

describe('memory bootstrap integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'commander-mem-'));
    resetGlobalThreeLayerMemory();
    resetUnifiedMemory();
    wireGlobalThreeLayerMemory(null);
  });

  afterEach(() => {
    resetGlobalThreeLayerMemory();
    resetUnifiedMemory();
    wireGlobalThreeLayerMemory(null);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolveMemoryStoreType prefers explicit config', () => {
    expect(resolveMemoryStoreType({ memoryStoreType: 'sqlite' })).toBe('sqlite');
  });

  it('resolveMemoryStoreType uses in-memory under vitest', () => {
    expect(resolveMemoryStoreType({})).toBe('in-memory');
  });

  it('bootstrap wires ThreeLayerMemory and UnifiedMemory to the same store', async () => {
    const store = await bootstrapMemoryPersistence('json', { basePath: tempDir });

    const memory = getGlobalThreeLayerMemory();
    memory.add('bootstrap integration entry', 'episodic', 'test', 0.6);

    await new Promise((resolve) => setImmediate(resolve));

    const recalled = await getUnifiedMemory().remember({
      projectId: 'default',
      content: 'unified write path',
      importance: 0.8,
      tags: ['integration'],
    });
    expect(recalled).toBeTruthy();

    const search = await store.search({ projectId: 'default', limit: 20 });
    expect(search.items.length).toBeGreaterThanOrEqual(1);
    expect(search.items.some((item) => item.content.includes('bootstrap integration'))).toBe(true);
  });

  it('json store persists episodic rows across new store instances', async () => {
    const { JsonMemoryStore } = await import('../../src/memory/jsonStore');
    const store1 = new JsonMemoryStore(tempDir);
    await store1.write({
      projectId: 'default',
      kind: 'SUMMARY',
      duration: 'EPISODIC',
      title: 'restart',
      content: 'survives restart',
      tags: [],
    });

    const store2 = new JsonMemoryStore(tempDir);
    const search = await store2.search({ projectId: 'default', limit: 20 });
    expect(search.items.some((item) => item.content.includes('survives restart'))).toBe(true);
  });
});
