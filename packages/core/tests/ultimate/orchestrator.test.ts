import { describe, it, expect, beforeEach } from 'vitest';
import {
  UltimateOrchestrator,
  countNodes,
  measureDepth,
  flattenTree,
} from '../../src/ultimate/orchestrator';
import type { TaskTreeNode } from '../../src/ultimate/types';
import type { AgentRuntimeInterface } from '../../src/runtime';
import { TELOSOrchestrator } from '../../src/telos/telosOrchestrator';
import { resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { resetCapabilityRegistry } from '../../src/ultimate/capabilityRegistry';
import { resetTeamManager } from '../../src/ultimate/agentTeamManager';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetProviderPool } from '../../src/telos/providerPool';

function makeTree(): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root',
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: [
      {
        id: 'child',
        parentId: 'root',
        goal: 'Child',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'PENDING',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [
          {
            id: 'grandchild',
            parentId: 'child',
            goal: 'Grandchild',
            role: 'EXECUTOR',
            isAtomic: true,
            status: 'PENDING',
            dependencies: [],
            context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
            subtasks: [],
          },
        ],
      },
    ],
  };
}

function makeRuntime(): AgentRuntimeInterface {
  return {
    execute: async () => ({
      runId: 'run-1',
      agentId: 'agent-1',
      status: 'success',
      summary: '',
      steps: [],
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      totalDurationMs: 0,
    }),
    getCompensationRegistry: () => ({
      compensateAll: async () => ({ errors: [] }),
    }),
  } as unknown as AgentRuntimeInterface;
}

describe('UltimateOrchestrator tree helpers', () => {
  it('countNodes returns total node count', () => {
    expect(countNodes(makeTree())).toBe(3);
  });

  it('measureDepth returns maximum depth', () => {
    expect(measureDepth(makeTree())).toBe(2);
  });

  it('flattenTree returns all nodes', () => {
    const nodes = flattenTree(makeTree());
    expect(nodes).toHaveLength(3);
    expect(nodes.map(n => n.id)).toEqual(['root', 'child', 'grandchild']);
  });
});

describe('UltimateOrchestrator facade', () => {
  beforeEach(() => {
    resetArtifactSystem();
    resetCapabilityRegistry();
    resetTeamManager();
    resetTokenSentinel();
    resetProviderPool();
  });

  it('constructs with defaults and exposes config', () => {
    const runtime = makeRuntime();
    const telos = new TELOSOrchestrator(runtime);
    const orch = new UltimateOrchestrator(telos, runtime);

    const config = orch.getConfig();
    expect(config).toBeDefined();
    expect(config.defaultEffortLevel).toBeDefined();
  });

  it('tracks active executions and disposes cleanly', () => {
    const runtime = makeRuntime();
    const telos = new TELOSOrchestrator(runtime);
    const orch = new UltimateOrchestrator(telos, runtime);

    expect(orch.listExecutions()).toEqual([]);
    expect(() => orch.dispose()).not.toThrow();
  });
});
