import { describe, it, expect, beforeEach } from 'vitest';
import { SubAgentExecutor } from '../../src/ultimate/subAgentExecutor';
import type { TaskTreeNode, ExecutionError } from '../../src/ultimate/types';
import type { AgentRuntimeInterface } from '../../src/runtime';
import type { AgentExecutionResult } from '../../src/runtime/types';
import { getArtifactSystem, resetArtifactSystem } from '../../src/ultimate/artifactSystem';
import { resetWorkCoordinator } from '../../src/ultimate/workCoordinator';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { resetIntentLog } from '../../src/runtime/intentLog';

function makeAgentResult(overrides: Partial<AgentExecutionResult> = {}): AgentExecutionResult {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    status: 'success',
    summary: 'done',
    steps: [],
    totalTokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    totalDurationMs: 100,
    ...overrides,
  };
}

function makeRuntime(result: AgentExecutionResult = makeAgentResult()): AgentRuntimeInterface {
  return {
    execute: async () => result,
    getCompensationRegistry: () => ({
      compensateAll: async () => ({ errors: [] }),
    }),
  } as unknown as AgentRuntimeInterface;
}

function makeLeaf(id: string): TaskTreeNode {
  return {
    id,
    parentId: 'root',
    goal: `Goal ${id}`,
    role: 'EXECUTOR',
    isAtomic: true,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 500 },
    subtasks: [],
  };
}

function makeParent(): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Parent goal',
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 500 },
    subtasks: [makeLeaf('leaf-1'), makeLeaf('leaf-2')],
  };
}

describe('SubAgentExecutor', () => {
  beforeEach(() => {
    resetArtifactSystem();
    resetWorkCoordinator();
    resetMessageBus();
    resetMetricsCollector();
    resetIntentLog();
  });

  it('setters update internal state', () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime);

    executor.setTeam('team-1');
    executor.setRunId('run-1');
    executor.setRunHandle(null);
    executor.setCheckpointer(null);
    executor.setApprovalGate(null);
    executor.setEffortLevel('COMPLEX');

    expect(executor.getCurrentRunId()).toBe('run-1');
    expect(executor.getSkippedApprovals()).toEqual([]);
  });

  it('executes an atomic leaf node successfully', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-1');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(node.result).toBe('done');
    expect(node.tokenUsage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    expect(errors).toHaveLength(0);
  });

  it('propagates execution failure to the errors array', async () => {
    const runtime = makeRuntime(makeAgentResult({ status: 'failed', error: 'boom' }));
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeLeaf('leaf-1');
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('FAILED');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('boom');
  });

  it('executes a parent node by running subtasks and synthesizing', async () => {
    const runtime = makeRuntime();
    const executor = new SubAgentExecutor(runtime, getArtifactSystem());
    const node = makeParent();
    const errors: ExecutionError[] = [];

    await executor.executeNode(node, 'proj-1', {}, errors);

    expect(node.status).toBe('COMPLETED');
    expect(node.subtasks.every((s) => s.status === 'COMPLETED')).toBe(true);
    expect(errors).toHaveLength(0);
  });
});
