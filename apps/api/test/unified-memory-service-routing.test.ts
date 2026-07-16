import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryMemoryService } from '../../../packages/core/src/memory/inMemoryMemoryService';
import { MemoryStoreFacade } from '../../../packages/core/src/memory/memoryStoreFacade';
import { ProjectMemoryStoreAdapter } from '../src/memoryStoreAdapter';

test('API memory routes use the canonical service adapter', async () => {
    const service = new InMemoryMemoryService();
    const adapter = new ProjectMemoryStoreAdapter(new MemoryStoreFacade(service, 'tenant-a'));

    await adapter.append({
      projectId: 'project-a',
      kind: 'LESSON',
      duration: 'EPISODIC',
      title: 'canonical',
      content: 'stored in the service',
      tags: ['migration'],
    });

    const search = await adapter.search('project-a', { query: 'canonical' });
    assert.equal(search.length, 1);
    assert.equal(search[0]?.title, 'canonical');
    assert.equal((await adapter.list('project-a')).length, 1);
});
