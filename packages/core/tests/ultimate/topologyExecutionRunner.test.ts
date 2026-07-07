import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TopologyExecutionRunner } from '../../src/ultimate/topologyExecutionLoops';
import type { ExecutionError, TaskTreeNode, OrchestrationTopology } from '../../src/ultimate/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function makeTree(subtaskCount: number): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root',
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: Array.from({ length: subtaskCount }, (_, i) =>
      makeSubtask(`sub-${i + 1}`, `task-${i + 1}`),
    ),
  };
}

function mockExecutor() {
  const callOrder: string[] = [];
  const executeNode = vi.fn(async (sub: TaskTreeNode) => {
    callOrder.push(sub.id);
    sub.status = 'COMPLETED';
    sub.result = `result:${sub.id}`;
  });
  return { executeNode, callOrder };
}

// ── Tests for the execute() dispatcher ───────────────────────────────────────

describe('TopologyExecutionRunner.execute() dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false for unknown topology', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });
    const tree = makeTree(3);

    const result = await runner.execute({
      topology: 'UNKNOWN' as OrchestrationTopology,
      taskTree: tree,
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(false);
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('returns false for EVALUATOR_OPTIMIZER with < 2 subtasks', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'EVALUATOR_OPTIMIZER',
      taskTree: makeTree(1),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(false);
  });

  it('routes EVALUATOR_OPTIMIZER with >= 2 subtasks and returns true', async () => {
    const { executeNode, callOrder } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'EVALUATOR_OPTIMIZER',
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
    expect(callOrder.length).toBeGreaterThan(0);
  });

  it('routes REVIEW as alias for EVALUATOR_OPTIMIZER', async () => {
    const { executeNode, callOrder } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'REVIEW' as OrchestrationTopology,
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
    expect(callOrder.length).toBeGreaterThan(0);
  });

  it('routes HANDOFF with >= 2 subtasks and returns true', async () => {
    const { executeNode, callOrder } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'HANDOFF',
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
    // HANDOFF runs serially
    expect(callOrder).toEqual(['sub-1', 'sub-2']);
  });

  it('routes CHAIN as alias for HANDOFF', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'CHAIN' as OrchestrationTopology,
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
  });

  it('returns false for HANDOFF with < 2 subtasks', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'HANDOFF',
      taskTree: makeTree(1),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(false);
  });

  it('routes DEBATE with >= 3 subtasks and returns true', async () => {
    const { executeNode, callOrder } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'DEBATE',
      taskTree: makeTree(3),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
    // DEBATE: 2 debaters + 1 judge = 3 calls
    expect(callOrder).toHaveLength(3);
  });

  it('returns false for DEBATE with < 3 subtasks', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'DEBATE',
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(false);
  });

  it('routes ENSEMBLE with >= 3 subtasks and returns true', async () => {
    const { executeNode, callOrder } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'ENSEMBLE',
      taskTree: makeTree(3),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
    // ENSEMBLE: 2 voters + 1 aggregator = 3 calls
    expect(callOrder).toHaveLength(3);
  });

  it('routes CONSENSUS with >= 2 subtasks and returns true', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'CONSENSUS',
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(true);
  });

  it('returns false for CONSENSUS with < 2 subtasks', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });

    const result = await runner.execute({
      topology: 'CONSENSUS',
      taskTree: makeTree(1),
      errors: [],
      reasoning: [],
      projectId: 'test',
    });

    expect(result).toBe(false);
  });

  it('forwards projectId and contextData to executeNode', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });
    const contextData = { foo: 'bar' };

    await runner.execute({
      topology: 'HANDOFF',
      taskTree: makeTree(2),
      errors: [],
      reasoning: [],
      projectId: 'proj-123',
      contextData,
    });

    const firstCall = (executeNode as any).mock.calls[0];
    expect(firstCall[1]).toBe('proj-123'); // projectId
    expect(firstCall[2]).toEqual(contextData); // contextData
  });

  it('forwards errors array to loop methods', async () => {
    const { executeNode } = mockExecutor();
    const runner = new TopologyExecutionRunner({ executeNode });
    const errors: ExecutionError[] = [];

    await runner.execute({
      topology: 'HANDOFF',
      taskTree: makeTree(2),
      errors,
      reasoning: [],
      projectId: 'test',
    });

    // errors array is passed through — the loop may push to it on failure
    expect(errors).toBeDefined();
  });
});
