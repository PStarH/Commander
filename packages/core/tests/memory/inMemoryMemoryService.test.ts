import { describe, expect, it } from 'vitest';
import { InMemoryMemoryService } from '../../src/memory/inMemoryMemoryService';

const scope = (tenantId: string, projectId = 'project-a') => ({ tenantId, projectId });

describe('InMemoryMemoryService', () => {
  it('isolates retrieve, search, list, and forget by tenant and project', async () => {
    const service = new InMemoryMemoryService();

    await service.store({
      scope: scope('tenant-a'),
      id: 'shared-id',
      kind: 'LESSON',
      title: 'tenant A title',
      content: 'tenant A content',
    });
    await service.store({
      scope: scope('tenant-b'),
      id: 'shared-id',
      kind: 'LESSON',
      title: 'tenant B title',
      content: 'tenant B content',
    });

    await expect(
      service.retrieve({ scope: scope('tenant-a'), id: 'shared-id' }),
    ).resolves.toMatchObject({
      tenantId: 'tenant-a',
      title: 'tenant A title',
    });
    await expect(
      service.search({ scope: scope('tenant-a'), query: 'tenant B' }),
    ).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(service.list({ scope: scope('tenant-a') })).resolves.toMatchObject({
      items: [expect.objectContaining({ tenantId: 'tenant-a' })],
      total: 1,
    });
    await expect(service.forget({ scope: scope('tenant-a'), id: 'shared-id' })).resolves.toBe(true);
    await expect(
      service.retrieve({ scope: scope('tenant-b'), id: 'shared-id' }),
    ).resolves.toMatchObject({
      tenantId: 'tenant-b',
    });
  });

  it('searches title, content, and tags while applying filters', async () => {
    const service = new InMemoryMemoryService();
    await service.store({
      scope: scope('tenant-a'),
      kind: 'DECISION',
      title: 'Deploy Postgres',
      content: 'Use the shared memory service',
      tags: ['database', 'migration'],
      priority: 90,
    });
    await service.store({
      scope: scope('tenant-a'),
      kind: 'ISSUE',
      title: 'SQLite fallback',
      content: 'Remove the legacy path',
      tags: ['migration'],
      priority: 20,
    });

    await expect(
      service.search({
        scope: scope('tenant-a'),
        query: 'postgres',
        kind: 'DECISION',
        tags: ['database'],
        minPriority: 80,
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ title: 'Deploy Postgres' })],
    });
  });

  it('hides expired records and evicts lowest priority records within one scope', async () => {
    let currentTime = new Date('2026-01-01T00:00:00.000Z');
    const service = new InMemoryMemoryService({
      now: () => currentTime,
      retention: { defaultTtlMs: 1_000, maxEntriesPerTenantProject: 2 },
    });

    await service.store({
      scope: scope('tenant-a'),
      id: 'low',
      kind: 'LESSON',
      title: 'low',
      content: 'low',
      priority: 10,
    });
    await service.store({
      scope: scope('tenant-a'),
      id: 'high',
      kind: 'LESSON',
      title: 'high',
      content: 'high',
      priority: 90,
    });
    await service.store({
      scope: scope('tenant-a'),
      id: 'new',
      kind: 'LESSON',
      title: 'new',
      content: 'new',
      priority: 50,
    });

    await expect(service.retrieve({ scope: scope('tenant-a'), id: 'low' })).resolves.toBeNull();
    await expect(service.retrieve({ scope: scope('tenant-a'), id: 'high' })).resolves.toMatchObject(
      {
        id: 'high',
      },
    );

    currentTime = new Date('2026-01-01T00:00:01.001Z');
    await expect(service.list({ scope: scope('tenant-a') })).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    await expect(service.purgeExpired()).resolves.toBe(2);
  });
});
