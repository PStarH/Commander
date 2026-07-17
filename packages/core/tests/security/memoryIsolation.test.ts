import { describe, it, expect } from 'vitest';
import { assertNamespaced } from '../../src/memory/namespaceGuard';

describe('assertNamespaced (MEMORY-001)', () => {
  it("allows writes to the writer agent's own namespace", () => {
    expect(() => assertNamespaced('agent-1', 'agents/agent-1/episodic/abc')).not.toThrow();
  });
  it("blocks writes to another agent's namespace", () => {
    expect(() => assertNamespaced('agent-1', 'agents/agent-2/episodic/abc')).toThrow(/MEMORY-001/);
  });
  it('allows cross-namespace writes when ACL grants the namespace', () => {
    expect(() =>
      assertNamespaced('agent-1', 'agents/agent-2/episodic/abc', {
        role: 'collaborator',
        namespaces: ['agents/agent-2'],
      }),
    ).not.toThrow();
  });
  it('allows writes to shared tasks/ namespace when ACL grants tasks', () => {
    expect(() =>
      assertNamespaced('agent-1', 'tasks/T-42/logs', {
        role: 'task-member',
        namespaces: ['tasks'],
      }),
    ).not.toThrow();
  });
  it('blocks writes to tasks/ namespace when ACL does not grant tasks', () => {
    expect(() =>
      assertNamespaced('agent-1', 'tasks/T-42/logs', {
        role: 'observer',
        namespaces: [],
      }),
    ).toThrow(/MEMORY-001/);
  });
  it('fail-closed: empty ACL namespaces blocks all cross-namespace writes', () => {
    expect(() =>
      assertNamespaced('agent-1', 'agents/agent-2/x', {
        role: 'restricted',
        namespaces: [],
      }),
    ).toThrow(/MEMORY-001/);
  });
});
