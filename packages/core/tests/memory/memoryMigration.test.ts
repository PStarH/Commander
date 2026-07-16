import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../src/memory/memoryService';
import {
  MemoryMigrationRunner,
  type LegacyMemoryRecord,
  type MemoryMigrationCheckpointStore,
  type MemoryMigrationSource,
} from '../../src/memory/memoryMigration';

function source(records: LegacyMemoryRecord[]): MemoryMigrationSource {
  return {
    sourceName: 'legacy-json',
    async *listRecords() {
      yield* records;
    },
  };
}

function checkpointStore(state: { value?: string }): MemoryMigrationCheckpointStore {
  return {
    async load() {
      return state.value;
    },
    async save(_sourceName, sourceId) {
      state.value = sourceId;
    },
  };
}

describe('MemoryMigrationRunner', () => {
  it('preserves source ids, requires explicit tenant mapping, and resumes from a checkpoint', async () => {
    const stored: unknown[] = [];
    const service = {
      store: async (input: unknown) => {
        stored.push(input);
        return {};
      },
    } as Pick<MemoryService, 'store'>;
    const state: { value?: string } = {};
    const runner = new MemoryMigrationRunner(
      service,
      source([
        { sourceId: 'one', projectId: 'project', kind: 'LESSON', title: 'one', content: 'one' },
        { sourceId: 'two', projectId: 'project', kind: 'LESSON', title: 'two', content: 'two' },
      ]),
      checkpointStore(state),
      (record) => (record.sourceId === 'one' || record.sourceId === 'two' ? 'tenant-a' : undefined),
    );

    await expect(runner.run()).resolves.toMatchObject({ imported: 2, skipped: 0, failed: 0 });
    await expect(runner.run()).resolves.toMatchObject({ imported: 0, skipped: 2, failed: 0 });
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      id: 'one',
      scope: { tenantId: 'tenant-a', projectId: 'project' },
      meta: { source: 'legacy-json', sourceId: 'one' },
    });
  });

  it('fails rather than assigning an unknown source to a default tenant', async () => {
    const service = { store: async () => ({}) } as Pick<MemoryService, 'store'>;
    const runner = new MemoryMigrationRunner(
      service,
      source([
        { sourceId: 'one', projectId: 'project', kind: 'LESSON', title: 'one', content: 'one' },
      ]),
      checkpointStore({}),
      () => undefined,
    );

    await expect(runner.run()).rejects.toThrow(/tenant mapping/i);
  });
});
