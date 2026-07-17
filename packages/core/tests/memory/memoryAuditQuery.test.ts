/**
 * WS6 — MemoryService.queryAudit wiring (InMemory ring + interface contract).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runWithTenant } from '../../src/runtime/tenantContext';
import { InMemoryMemoryService } from '../../src/memory/inMemoryMemoryService';
import { MemoryStoreFacade } from '../../src/memory/memoryStoreFacade';
import type { MemoryServiceAudit } from '../../src/memory/memoryService';

describe('WS6 memory audit query', () => {
  it('InMemoryMemoryService records and returns audit events for store', async () => {
    const service = new InMemoryMemoryService();
    const scope = { tenantId: 'tenant-a', projectId: 'proj-1' };
    await service.store({
      scope,
      kind: 'LESSON',
      title: 't',
      content: 'c',
      tags: ['namespace:alpha'],
      agentId: 'agent-1',
    });
    const audit = service as InMemoryMemoryService & MemoryServiceAudit;
    assert.equal(typeof audit.queryAudit, 'function');
    const page = await audit.queryAudit!({ scope, limit: 10 });
    assert.ok(page.entries.length >= 1);
    assert.equal(page.entries[0]?.action, 'store');
    assert.equal(page.entries[0]?.tenantId, 'tenant-a');
    assert.ok(page.entries[0]?.tags?.includes('namespace:alpha'));
  });

  it('InMemory forget-by-missionId records tags on audit (namespace query)', async () => {
    const service = new InMemoryMemoryService();
    const scope = { tenantId: 'tenant-a', projectId: 'proj-1' };
    await service.store({
      scope,
      kind: 'LESSON',
      title: 'm1',
      content: 'c',
      tags: ['namespace:alpha'],
      missionId: 'mission-1',
      agentId: 'a1',
    });
    await service.forget({ scope, missionId: 'mission-1' });
    const page = await service.queryAudit!({ scope, namespace: 'alpha', limit: 20 });
    assert.ok(page.entries.some((e) => e.action === 'forget'));
    assert.ok(
      page.entries.some(
        (e) => e.action === 'forget' && e.tags?.includes('namespace:alpha'),
      ),
    );
  });

  it('MemoryStoreFacade.queryAudit filters by namespace tag and requires tenant ALS', async () => {
    const service = new InMemoryMemoryService();
    const store = new MemoryStoreFacade(service);
    await runWithTenant('tenant-a', async () => {
      await store.write({
        projectId: 'proj-1',
        kind: 'LESSON',
        title: 'ns-a',
        content: 'body',
        tags: ['namespace:alpha'],
        agentId: 'a1',
      });
      await store.write({
        projectId: 'proj-1',
        kind: 'LESSON',
        title: 'ns-b',
        content: 'body',
        tags: ['namespace:beta'],
        agentId: 'a1',
      });
      const alpha = await store.queryAudit!({
        projectId: 'proj-1',
        namespace: 'alpha',
        limit: 50,
      });
      assert.equal(alpha.unavailable, false);
      assert.ok(alpha.entries.every((e) => e.tags?.includes('namespace:alpha')));
      assert.ok(alpha.entries.length >= 1);
    });

    await assert.rejects(
      () => store.queryAudit!({ projectId: 'proj-1', namespace: 'alpha' }),
      /tenant context/i,
    );
  });
});
