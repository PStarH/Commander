import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    expect(nodes.map((n) => n.id)).toEqual(['root', 'child', 'grandchild']);
  });
});

describe('UltimateOrchestrator facade', () => {
  beforeEach(() => {
    resetArtifactSystem();
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

function makeSubtask(id: string, goal: string): TaskTreeNode {
  return {
    id,
    parentId: 'root',
    goal,
    role: 'EXECUTOR',
    isAtomic: true,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: [],
  };
}

function makeTopologyTree(topology: string): TaskTreeNode {
  const count = topology === 'HANDOFF' || topology === 'CONSENSUS' ? 2 : 3;
  return {
    id: 'root',
    parentId: null,
    goal: 'Root',
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: Array.from({ length: count }, (_, i) => makeSubtask(`sub-${i + 1}`, `task-${i + 1}`)),
  };
}

function mockExecutor(): {
  executeNode: ReturnType<typeof vi.fn>;
  callOrder: string[];
  callSnapshots: Array<{ id: string; goal: string; systemPrompt: string }>;
} {
  const callOrder: string[] = [];
  const callSnapshots: Array<{ id: string; goal: string; systemPrompt: string }> = [];
  const executeNode = vi.fn(async (sub: TaskTreeNode) => {
    callOrder.push(sub.id);
    callSnapshots.push({
      id: sub.id,
      goal: sub.goal,
      systemPrompt: sub.context.systemPrompt,
    });
    if (sub.goal.includes('FAIL')) {
      sub.status = 'FAILED';
      sub.result = `failed:${sub.id}`;
    } else {
      sub.status = 'COMPLETED';
      sub.result = `result:${sub.id}`;
    }
  });
  return { executeNode, callOrder, callSnapshots };
}

describe('UltimateOrchestrator topology execution loops', () => {
  beforeEach(() => {
    resetArtifactSystem();
    resetTeamManager();
    resetTokenSentinel();
    resetProviderPool();
  });

  function setupOrchestrator() {
    const runtime = makeRuntime();
    const telos = new TELOSOrchestrator(runtime);
    const orch = new UltimateOrchestrator(telos, runtime);
    const { executeNode, callOrder, callSnapshots } = mockExecutor();
    (orch as unknown as Record<string, unknown>).subAgentExecutor = { executeNode };
    return { orch, executeNode, callOrder, callSnapshots };
  }

  it('HANDOFF runs subtasks serially and forwards context', async () => {
    const { orch, callOrder, callSnapshots } = setupOrchestrator();
    const tree = makeTopologyTree('HANDOFF');
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeHandoffLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    expect(callOrder).toEqual(['sub-1', 'sub-2']);
    expect(tree.subtasks[0].status).toBe('COMPLETED');
    expect(tree.subtasks[1].status).toBe('COMPLETED');
    const secondCall = callSnapshots.find((s) => s.id === 'sub-2');
    expect(secondCall?.goal).toContain('result:sub-1');
    expect(tree.status).toBe('COMPLETED');
    expect(tree.result).toBe('result:sub-2');
    expect(reasoning.some((r) => r.includes('HANDOFF'))).toBe(true);
  });

  it('HANDOFF stops when a subtask fails', async () => {
    const { orch } = setupOrchestrator();
    const tree = makeTopologyTree('HANDOFF');
    tree.subtasks[0].goal = 'FAIL';
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeHandoffLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    expect(tree.subtasks[0].status).toBe('FAILED');
    expect(tree.subtasks[1].status).toBe('PENDING');
    expect(reasoning.some((r) => r.includes('failed, stopping handoff'))).toBe(true);
  });

  it('DEBATE runs debaters in parallel then a judge', async () => {
    const { orch, callOrder, callSnapshots } = setupOrchestrator();
    const tree = makeTopologyTree('DEBATE');
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeDebateLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    const debaterCalls = callOrder.slice(0, -1);
    const judgeCall = callOrder[callOrder.length - 1];
    expect(new Set(debaterCalls)).toEqual(new Set(['sub-1', 'sub-2']));
    expect(judgeCall).toBe('sub-3');
    const judgeSnapshot = callSnapshots.find((s) => s.id === 'sub-3');
    expect(judgeSnapshot?.goal).toContain('result:sub-1');
    expect(tree.status).toBe('COMPLETED');
    expect(tree.result).toBe('result:sub-3');
  });

  it('DEBATE short-circuits when all debaters fail', async () => {
    const { orch, callOrder } = setupOrchestrator();
    const tree = makeTopologyTree('DEBATE');
    tree.subtasks[0].goal = 'FAIL';
    tree.subtasks[1].goal = 'FAIL';
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeDebateLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    expect(callOrder).toEqual(['sub-1', 'sub-2']);
    expect(callOrder).not.toContain('sub-3');
    expect(reasoning.some((r) => r.includes('all debaters failed'))).toBe(true);
  });

  it('ENSEMBLE runs voters in parallel then an aggregator', async () => {
    const { orch, callOrder, callSnapshots } = setupOrchestrator();
    const tree = makeTopologyTree('ENSEMBLE');
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeEnsembleLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    const voterCalls = callOrder.slice(0, -1);
    const aggregatorCall = callOrder[callOrder.length - 1];
    expect(new Set(voterCalls)).toEqual(new Set(['sub-1', 'sub-2']));
    expect(aggregatorCall).toBe('sub-3');
    const voterSnapshot = callSnapshots.find((s) => s.id === 'sub-1');
    expect(voterSnapshot?.systemPrompt).toContain('pragmatic engineer');
    const aggregatorSnapshot = callSnapshots.find((s) => s.id === 'sub-3');
    expect(aggregatorSnapshot?.goal).toContain('result:sub-1');
    expect(tree.status).toBe('COMPLETED');
    expect(tree.result).toBe('result:sub-3');
  });

  it('ENSEMBLE short-circuits when all voters fail', async () => {
    const { orch, callOrder } = setupOrchestrator();
    const tree = makeTopologyTree('ENSEMBLE');
    tree.subtasks[0].goal = 'FAIL';
    tree.subtasks[1].goal = 'FAIL';
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeEnsembleLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    expect(callOrder).toEqual(['sub-1', 'sub-2']);
    expect(callOrder).not.toContain('sub-3');
    expect(reasoning.some((r) => r.includes('all voters failed'))).toBe(true);
  });

  it('CONSENSUS runs multiple rounds with shared context', async () => {
    const { orch, callOrder } = setupOrchestrator();
    const tree = makeTopologyTree('CONSENSUS');
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeConsensusLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    expect(callOrder.length).toBeGreaterThanOrEqual(2);
    expect(tree.subtasks.every((s) => s.status === 'COMPLETED')).toBe(true);
    expect(tree.status).toBe('COMPLETED');
    expect(tree.result).toBe('result:sub-1');
    expect(reasoning.some((r) => r.includes('CONSENSUS'))).toBe(true);
  });

  it('CONSENSUS handles all-agent failure gracefully', async () => {
    const { orch } = setupOrchestrator();
    const tree = makeTopologyTree('CONSENSUS');
    tree.subtasks.forEach((s) => (s.goal = 'FAIL'));
    const reasoning: string[] = [];
    const errors: unknown[] = [];

    await (
      orch as unknown as Record<
        string,
        (
          tree: TaskTreeNode,
          execId: string,
          params: unknown,
          errors: unknown[],
          reasoning: string[],
        ) => Promise<void>
      >
    ).executeConsensusLoop(tree, 'exec-1', { projectId: 'test' }, errors, reasoning);

    expect(tree.subtasks.every((s) => s.status === 'FAILED')).toBe(true);
    expect(tree.status).toBe('FAILED');
    expect(tree.result).toBe('');
  });
});
