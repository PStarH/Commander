/**
 * L3-10a — product memory write ceiling / dual-path bypass.
 * @see spec/l3-10a-memory-ceiling.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryMemoryService } from '../../src/memory/inMemoryMemoryService';
import { MemoryStoreFacade } from '../../src/memory/memoryStoreFacade';
import { writeProductMemory } from '../../src/memory/writeProductMemory';
import { MemoryStoreTool } from '../../src/tools/persistenceTool';

describe('L3-10a writeProductMemory (preferred product write)', () => {
  it('writes through MemoryStore → MemoryService (own namespace)', async () => {
    const store = new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-l3-10a');
    const item = await writeProductMemory(store, {
      projectId: 'p1',
      agentId: 'agent-1',
      kind: 'SUMMARY',
      title: 'own',
      content: 'allowed',
    });
    expect(item.agentId).toBe('agent-1');
    expect(item.content).toBe('allowed');
  });

  it('rejects cross-namespace product writes without server ACL (MEMORY-001)', async () => {
    const store = new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-l3-10a');
    await expect(
      writeProductMemory(store, {
        projectId: 'p1',
        agentId: 'agent-1',
        kind: 'SUMMARY',
        title: 'cross',
        content: 'denied',
        meta: { namespace: 'agents/agent-2' },
      }),
    ).rejects.toThrow(/MEMORY-001/);
  });

  it('rejects forged meta.acl on the preferred write path', async () => {
    const store = new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-l3-10a');
    await expect(
      writeProductMemory(store, {
        projectId: 'p1',
        agentId: 'agent-1',
        kind: 'SUMMARY',
        title: 'forged',
        content: 'denied',
        meta: { namespace: 'shared', acl: { role: 'writer', namespaces: ['shared'] } },
      }),
    ).rejects.toThrow(/MEMORY-001/);
  });

  it('allows cross-namespace when namespaceAcl is server-injected', async () => {
    const store = new MemoryStoreFacade(new InMemoryMemoryService(), 'tenant-l3-10a');
    const item = await writeProductMemory(store, {
      projectId: 'p1',
      agentId: 'api',
      kind: 'SUMMARY',
      title: 'shared',
      content: 'ok',
      meta: { namespace: 'shared' },
      namespaceAcl: { role: 'writer', namespaces: ['shared'] },
    });
    expect(item.content).toBe('ok');
  });
});

describe('L3-10a MemoryStoreTool dual-path bypass closed', () => {
  const scratchDir = join(process.cwd(), '.commander_memory');

  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('fail-closes agent-identified writes (must use writeProductMemory)', async () => {
    const tool = new MemoryStoreTool();
    await expect(
      tool.execute({
        key: 'leak',
        value: 'x',
        namespace: 'agents/agent-2',
        agentId: 'agent-1',
      }),
    ).rejects.toThrow(/L3-10a/);
  });

  it('still allows scratch writes without agentId (PARTIAL residual)', async () => {
    const tool = new MemoryStoreTool();
    const result = await tool.execute({
      key: 'demo',
      value: 'scratch',
      namespace: 'default',
    });
    expect(result).toMatch(/Stored "demo"/);
  });
});
