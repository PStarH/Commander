import { describe, expect, it, vi } from 'vitest';
import type { MemoryService } from '../../src/memory/memoryService';
import { MemoryStoreFacade } from '../../src/memory/memoryStoreFacade';
import { runWithTenant } from '../../src/runtime/tenantContext';

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-1',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    kind: 'LESSON' as const,
    duration: 'EPISODIC' as const,
    title: 'title',
    content: 'content',
    tags: [],
    priority: 50,
    confidence: 0.8,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MemoryStoreFacade', () => {
  it('injects the current tenant into legacy writes and reads', async () => {
    const service = {
      store: vi.fn().mockResolvedValue(record()),
      retrieve: vi.fn().mockResolvedValue(record()),
      search: vi.fn().mockResolvedValue({ items: [record()], total: 1 }),
      forget: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({ items: [record()], total: 1 }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;
    const facade = new MemoryStoreFacade(service);

    await runWithTenant('tenant-a', async () => {
      await facade.write({
        projectId: 'project-a',
        kind: 'LESSON',
        title: 'title',
        content: 'content',
      });
      await facade.read('memory-1', 'project-a');
    });

    expect(service.store).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { tenantId: 'tenant-a', projectId: 'project-a' } }),
    );
    expect(service.retrieve).toHaveBeenCalledWith({
      scope: { tenantId: 'tenant-a', projectId: 'project-a' },
      id: 'memory-1',
    });
  });

  it('maps legacy search and delete operations without widening scope', async () => {
    const service = {
      store: vi.fn().mockResolvedValue(record()),
      retrieve: vi.fn().mockResolvedValue(record()),
      search: vi.fn().mockResolvedValue({ items: [record()], total: 1 }),
      forget: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({ items: [record()], total: 1 }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MemoryService;
    const facade = new MemoryStoreFacade(service);

    await runWithTenant('tenant-a', async () => {
      const result = await facade.search({ projectId: 'project-a', query: 'content', limit: 5 });
      expect(result.items[0]?.projectId).toBe('project-a');
      await facade.delete('memory-1', 'project-a');
    });

    expect(service.search).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { tenantId: 'tenant-a', projectId: 'project-a' } }),
    );
    expect(service.forget).toHaveBeenCalledWith({
      scope: { tenantId: 'tenant-a', projectId: 'project-a' },
      id: 'memory-1',
    });
  });

  it('fails closed when a legacy caller has no tenant context', async () => {
    const service = {
      store: vi.fn(),
      retrieve: vi.fn(),
      search: vi.fn(),
      forget: vi.fn(),
      list: vi.fn(),
      close: vi.fn(),
    } as unknown as MemoryService;
    const facade = new MemoryStoreFacade(service);

    await expect(facade.read('memory-1', 'project-a')).rejects.toThrow(/tenant/i);
    expect(service.retrieve).not.toHaveBeenCalled();
  });
});
