import { describe, it, expect, vi } from 'vitest';
import { MemorySystem } from '../../src/memory/memorySystem';
import type { UnifiedMemory } from '../../src/memory/unifiedMemory';

// Minimal stub — MemorySystem only calls unified.remember() and
// unified.getWorkingMemory() in the methods we exercise.
function makeStubUnified(): UnifiedMemory {
  return {
    remember: vi.fn().mockResolvedValue(undefined),
    getWorkingMemory: vi.fn().mockReturnValue({ add: vi.fn(), getWorkingContext: vi.fn().mockReturnValue([]) }),
    // ... other methods stubbed as needed
  } as unknown as UnifiedMemory;
}

describe('MemorySystem.assertNamespaced', () => {
  it('allows writes to the writer agent\'s own namespace', () => {
    const ms = new MemorySystem({ unified: makeStubUnified() });
    expect(() => ms.assertNamespaced('agent-1', 'agents/agent-1/episodic/abc')).not.toThrow();
  });

  it('blocks writes to another agent\'s namespace', () => {
    const ms = new MemorySystem({ unified: makeStubUnified() });
    expect(() => ms.assertNamespaced('agent-1', 'agents/agent-2/episodic/abc')).toThrow(/MEMORY-001/);
  });

  it('allows cross-namespace writes when ACL grants the namespace', () => {
    const ms = new MemorySystem({ unified: makeStubUnified() });
    expect(() => ms.assertNamespaced('agent-1', 'agents/agent-2/episodic/abc', {
      role: 'collaborator',
      namespaces: ['agents/agent-2'],
    })).not.toThrow();
  });

  it('allows writes to shared tasks/ namespace when ACL grants tasks', () => {
    const ms = new MemorySystem({ unified: makeStubUnified() });
    expect(() => ms.assertNamespaced('agent-1', 'tasks/T-42/logs', {
      role: 'task-member',
      namespaces: ['tasks'],
    })).not.toThrow();
  });

  it('blocks writes to tasks/ namespace when ACL does not grant tasks', () => {
    const ms = new MemorySystem({ unified: makeStubUnified() });
    expect(() => ms.assertNamespaced('agent-1', 'tasks/T-42/logs', {
      role: 'observer',
      namespaces: [],
    })).toThrow(/MEMORY-001/);
  });

  it('fail-closed: empty ACL namespaces blocks all cross-namespace writes', () => {
    const ms = new MemorySystem({ unified: makeStubUnified() });
    expect(() => ms.assertNamespaced('agent-1', 'agents/agent-2/x', {
      role: 'restricted',
      namespaces: [],
    })).toThrow(/MEMORY-001/);
  });
});
