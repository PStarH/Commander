import { describe, expect, it } from 'vitest';
import { PostgresMemoryService } from '../../src/memory/postgresMemoryService';

const connectionString = process.env.COMMANDER_POSTGRES_URL ?? process.env.DATABASE_URL;

describe.skipIf(!connectionString)('PostgresMemoryService integration', () => {
  it('isolates tenants and removes expired records', async () => {
    const service = new PostgresMemoryService({
      connectionString: connectionString!,
      retention: { defaultTtlMs: 1 },
    });
    await service.initialize();
    await service.store({
      scope: { tenantId: 'ws6-test-a', projectId: 'memory-service' },
      id: 'shared-id',
      kind: 'LESSON',
      title: 'A',
      content: 'A',
    });
    await service.store({
      scope: { tenantId: 'ws6-test-b', projectId: 'memory-service' },
      id: 'shared-id',
      kind: 'LESSON',
      title: 'B',
      content: 'B',
    });

    await expect(
      service.retrieve({
        scope: { tenantId: 'ws6-test-a', projectId: 'memory-service' },
        id: 'shared-id',
      }),
    ).resolves.toMatchObject({ title: 'A' });
    await expect(
      service.retrieve({
        scope: { tenantId: 'ws6-test-b', projectId: 'memory-service' },
        id: 'shared-id',
      }),
    ).resolves.toMatchObject({ title: 'B' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      service.list({ scope: { tenantId: 'ws6-test-a', projectId: 'memory-service' } }),
    ).resolves.toMatchObject({ items: [], total: 0 });
    await service.close();
  });
});
