import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CheckpointManager } from '../../src/ultimate/checkpointManager';
import { resetCheckpointWriter } from '../../src/runtime/checkpointWriter';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetGlobalLogger, getGlobalLogger } from '../../src/logging';
import type {
  TaskTreeNode,
  ExecutionError,
  UltimateOrchestratorConfig,
} from '../../src/ultimate/types';
import type { AgentRuntimeInterface } from '../../src/runtime';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<UltimateOrchestratorConfig>): UltimateOrchestratorConfig {
  return {
    defaultBudget: { hardCapTokens: 128000, softCapTokens: 96000, costCapUsd: 5.0 },
    defaultThinkingBudget: { enabled: false, budgetTokens: 0 },
    defaultSynthesisConfig: {
      qualityGates: [],
      consensusThreshold: 0.7,
      maxIterations: 3,
    },
    defaultEffortLevel: 'MODERATE',
    maxRecursiveDepth: 3,
    maxParallelSubAgents: 10,
    enableDeliberation: true,
    enableArtifactSystem: true,
    enableTeams: true,
    enableCapabilityRouting: true,
    enableCircuitBreaker: true,
    qualityGates: [],
    modelTierMapping: {
      SIMPLE: 'eco',
      MODERATE: 'standard',
      COMPLEX: 'power',
      DEEP_RESEARCH: 'consensus',
    },
    ...overrides,
  } as unknown as UltimateOrchestratorConfig;
}

function makeRuntime(): AgentRuntimeInterface {
  return {
    getProvider: vi.fn(() => undefined),
  } as unknown as AgentRuntimeInterface;
}

function makeTaskTree(overrides?: Partial<TaskTreeNode>): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root goal',
    role: 'PLANNER',
    isAtomic: false,
    status: 'COMPLETED',
    result: 'Root result',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: [
      {
        id: 'child-1',
        parentId: 'root',
        goal: 'Child 1',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'COMPLETED',
        result: 'result-1',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
      {
        id: 'child-2',
        parentId: 'root',
        goal: 'Child 2',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'PENDING',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
      },
    ],
    ...overrides,
  } as TaskTreeNode;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CheckpointManager', () => {
  beforeEach(() => {
    resetCheckpointWriter();
    resetMessageBus();
    resetGlobalLogger();
  });

  it('constructs with deps', () => {
    const mgr = new CheckpointManager({
      config: makeConfig(),
      runtime: makeRuntime(),
      sumTokenUsage: () => 0,
    });
    expect(mgr).toBeDefined();
  });

  it('skips checkpoint when hardCapTokens is 0', async () => {
    const config = makeConfig({
      defaultBudget: { hardCapTokens: 0, softCapTokens: 0, costCapUsd: 0 },
    } as Partial<UltimateOrchestratorConfig>);
    const mgr = new CheckpointManager({
      config,
      runtime: makeRuntime(),
      sumTokenUsage: vi.fn(() => 50000),
    });

    const reasoning: string[] = [];
    await mgr.maybeCheckpoint('exec-1', makeTaskTree(), { goal: 'test' }, [], reasoning);

    // No reasoning pushed because we returned early
    expect(reasoning).toHaveLength(0);
  });

  it('skips checkpoint when shouldTrigger returns null', async () => {
    const mgr = new CheckpointManager({
      config: makeConfig(),
      runtime: makeRuntime(),
      sumTokenUsage: vi.fn(() => 1000),
    });

    const reasoning: string[] = [];
    await mgr.maybeCheckpoint('exec-1', makeTaskTree(), { goal: 'test' }, [], reasoning);

    // Tokens used (1000) < 20% of 128000, so shouldTrigger returns null
    expect(reasoning).toHaveLength(0);
  });

  it('writes checkpoint and pushes reasoning when trigger fires', async () => {
    // We need to mock getCheckpointWriter to return a controlled writer.
    // Since getCheckpointWriter is a singleton, we use the real one but
    // manipulate state to force a trigger.
    const config = makeConfig();
    const tree = makeTaskTree();

    const mgr = new CheckpointManager({
      config,
      runtime: makeRuntime(),
      sumTokenUsage: vi.fn(() => 100000), // 100000 / 128000 ≈ 78% > 70% trigger
    });

    const reasoning: string[] = ['Topology: CHAIN', 'Effort level: MODERATE'];
    const errors: ExecutionError[] = [
      { nodeId: 'child-2', message: 'timeout error', recovered: true },
    ];

    await mgr.maybeCheckpoint('exec-trigger', tree, { goal: 'test goal' }, errors, reasoning);

    // Should have pushed a checkpoint reasoning line
    const ckptLine = reasoning.find((r) => r.includes('Checkpoint v'));
    expect(ckptLine).toBeDefined();
    expect(ckptLine).toContain('% budget');
  });

  it('extracts key decisions from reasoning', async () => {
    const mgr = new CheckpointManager({
      config: makeConfig(),
      runtime: makeRuntime(),
      sumTokenUsage: vi.fn(() => 100000),
    });

    const reasoning = [
      'Topology: DEBATE',
      'Effort level: COMPLEX',
      'Confidence: 0.85',
      'Budget: 128000 tokens',
      'Some unrelated reasoning',
      'Synthesis quality: 0.9',
      'Shadow model detected',
    ];

    await mgr.maybeCheckpoint('exec-decisions', makeTaskTree(), { goal: 'test' }, [], reasoning);

    // The checkpoint line should be appended
    expect(reasoning.length).toBeGreaterThan(7);
  });

  it('handles errors gracefully without throwing', async () => {
    const mgr = new CheckpointManager({
      config: makeConfig(),
      runtime: {
        getProvider: vi.fn(() => {
          throw new Error('provider lookup failed');
        }),
      } as unknown as AgentRuntimeInterface,
      sumTokenUsage: vi.fn(() => 100000),
    });

    // Should not throw — error is caught internally
    const reasoning: string[] = [];
    await expect(
      mgr.maybeCheckpoint('exec-err', makeTaskTree(), { goal: 'test' }, [], reasoning),
    ).resolves.toBeUndefined();
  });

  it('extracts file paths from contextData when available', async () => {
    const mgr = new CheckpointManager({
      config: makeConfig(),
      runtime: makeRuntime(),
      sumTokenUsage: vi.fn(() => 100000),
    });

    const reasoning: string[] = [];
    await mgr.maybeCheckpoint(
      'exec-files',
      makeTaskTree(),
      {
        goal: 'test',
        contextData: {
          availableTools: ['read_file', 'write_file'],
          filesRead: ['/src/a.ts', '/src/b.ts'],
          filesModified: ['/src/a.ts'],
        },
      },
      [],
      reasoning,
    );

    // Checkpoint should still be written successfully
    expect(reasoning.some((r) => r.includes('Checkpoint v'))).toBe(true);
  });

  it('handles empty task tree gracefully', async () => {
    const mgr = new CheckpointManager({
      config: makeConfig(),
      runtime: makeRuntime(),
      sumTokenUsage: vi.fn(() => 100000),
    });

    const emptyTree: TaskTreeNode = {
      id: 'root',
      parentId: null,
      goal: 'Empty',
      role: 'PLANNER',
      isAtomic: true,
      status: 'PENDING',
      dependencies: [],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
      subtasks: [],
    };

    const reasoning: string[] = [];
    await mgr.maybeCheckpoint('exec-empty', emptyTree, { goal: 'test' }, [], reasoning);

    // Should complete without error
    expect(reasoning.some((r) => r.includes('Checkpoint v'))).toBe(true);
  });
});
