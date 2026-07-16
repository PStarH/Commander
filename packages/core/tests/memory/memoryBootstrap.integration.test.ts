import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bootstrapMemoryPersistence,
  createMemoryStore,
  resolveMemoryStoreType,
} from '../../src/memory/utils';
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
    expect(resolveMemoryStoreType({ memoryStoreType: 'postgres' })).toBe('postgres');
  });

  it('resolveMemoryStoreType uses in-memory under vitest', () => {
    expect(resolveMemoryStoreType({})).toBe('in-memory');
  });

  it('supports postgres as the explicit production backend', () => {
    expect(resolveMemoryStoreType({ memoryStoreType: 'postgres' })).toBe('postgres');
  });

  it('falls back to in-memory (Local-First) outside tests without Postgres', () => {
    const previousVitest = process.env.VITEST;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousCommanderUrl = process.env.COMMANDER_POSTGRES_URL;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      delete process.env.COMMANDER_POSTGRES_URL;
      delete process.env.DATABASE_URL;
      expect(resolveMemoryStoreType({})).toBe('in-memory');
    } finally {
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousCommanderUrl === undefined) delete process.env.COMMANDER_POSTGRES_URL;
      else process.env.COMMANDER_POSTGRES_URL = previousCommanderUrl;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('creates the new in-memory service behind the legacy facade for tests', async () => {
    const store = await createMemoryStore('in-memory');
    expect(store.constructor.name).toBe('MemoryStoreFacade');
    await store.close();
  });

  it('bootstrap wires ThreeLayerMemory and UnifiedMemory to the same store', async () => {
    const store = await bootstrapMemoryPersistence('in-memory', { tenantId: '__default__' });

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
});
