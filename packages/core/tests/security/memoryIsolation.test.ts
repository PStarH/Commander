import { describe, it, expect } from 'vitest';
import { InMemoryMemoryService } from '../../src/memory/inMemoryMemoryService';
import { assertNamespaced, assertNamespacedStoreInput } from '../../src/memory/namespaceGuard';

describe('assertNamespaced (MEMORY-001)', () => {
  it("allows writes to the writer agent's own namespace", () => {
    expect(() => assertNamespaced('agent-1', 'agents/agent-1/episodic/abc')).not.toThrow();
  });

  it('rejects cross-agent namespace writes without ACL', () => {
    expect(() => assertNamespaced('agent-1', 'agents/agent-2/episodic/abc')).toThrow(/MEMORY-001/);
  });

  it('allows ACL-granted namespaces', () => {
    expect(() =>
      assertNamespaced('agent-1', 'agents/agent-2/episodic/abc', {
        role: 'writer',
        namespaces: ['agents/agent-2'],
      }),
    ).not.toThrow();
  });

  it('allows tasks/ when ACL grants tasks', () => {
    expect(() =>
      assertNamespaced('agent-1', 'tasks/T-42/logs', {
        role: 'writer',
        namespaces: ['tasks'],
      }),
    ).not.toThrow();
  });

  it('rejects tasks/ without ACL grant', () => {
    expect(() =>
      assertNamespaced('agent-1', 'tasks/T-42/logs', {
        role: 'writer',
        namespaces: ['agents/agent-1'],
      }),
    ).toThrow(/MEMORY-001/);
  });

  it('rejects when ACL namespaces do not cover the target', () => {
    expect(() =>
      assertNamespaced('agent-1', 'agents/agent-2/x', {
        role: 'reader',
        namespaces: ['shared'],
      }),
    ).toThrow(/MEMORY-001/);
  });

  it('ignores empty-string ACL namespaces (no universal grant)', () => {
    expect(() =>
      assertNamespaced('agent-1', 'agents/agent-2/x', {
        role: 'writer',
        namespaces: [''],
      }),
    ).toThrow(/MEMORY-001/);
  });
});

describe('MEMORY-001 on default MemoryService.store path', () => {
  it('allows agent-owned writes without meta.namespace', async () => {
    const service = new InMemoryMemoryService();
    await expect(
      service.store({
        scope: { tenantId: 't1', projectId: 'p1' },
        agentId: 'agent-1',
        kind: 'FACT',
        title: 'own',
        content: 'ok',
      }),
    ).resolves.toMatchObject({ agentId: 'agent-1' });
  });

  it('rejects cross-namespace store without ACL', async () => {
    const service = new InMemoryMemoryService();
    await expect(
      service.store({
        scope: { tenantId: 't1', projectId: 'p1' },
        agentId: 'agent-1',
        kind: 'FACT',
        title: 'cross',
        content: 'denied',
        meta: { namespace: 'agents/agent-2' },
      }),
    ).rejects.toThrow(/MEMORY-001/);
  });

  it('rejects forged meta.createdBy as a cross-namespace grant', async () => {
    const service = new InMemoryMemoryService();
    await expect(
      service.store({
        scope: { tenantId: 't1', projectId: 'p1' },
        agentId: 'agent-1',
        kind: 'FACT',
        title: 'forged',
        content: 'denied',
        meta: { namespace: 'shared', createdBy: { agentId: 'agent-1', role: 'writer' } },
      }),
    ).rejects.toThrow(/MEMORY-001/);
  });

  it('rejects forged meta.acl as a cross-namespace grant', async () => {
    const service = new InMemoryMemoryService();
    await expect(
      service.store({
        scope: { tenantId: 't1', projectId: 'p1' },
        agentId: 'agent-1',
        kind: 'FACT',
        title: 'forged-acl',
        content: 'denied',
        meta: { namespace: 'shared', acl: { role: 'writer', namespaces: ['shared'] } },
      }),
    ).rejects.toThrow(/MEMORY-001/);
  });

  it('allows namespaced writes when namespaceAcl is server-injected', async () => {
    const service = new InMemoryMemoryService();
    await expect(
      service.store({
        scope: { tenantId: 't1', projectId: 'p1' },
        agentId: 'api',
        kind: 'FACT',
        title: 'shared',
        content: 'ok',
        meta: { namespace: 'shared', createdBy: { agentId: 'api', role: 'writer' } },
        namespaceAcl: { role: 'writer', namespaces: ['shared'] },
      }),
    ).resolves.toMatchObject({ agentId: 'api' });
  });

  it('assertNamespacedStoreInput skips when agent identity is absent', () => {
    expect(() =>
      assertNamespacedStoreInput({
        id: 'x',
        meta: { namespace: 'agents/other' },
      }),
    ).not.toThrow();
  });
});
