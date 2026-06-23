import { describe, it, expect, beforeEach } from 'vitest';
import { ReflexionTopologicalOptimizer } from '../../src/ultimate/topologyOptimizer';
import type { TaskTreeNode, UltimateExecutionContext } from '../../src/ultimate/types';
import type { ExecutionExperience } from '../../src/runtime/types';
import { resetTraceRecorder } from '../../src/runtime/executionTrace';
import { resetReflectionEngine } from '../../src/reflectionEngine';
import { resetMetaLearner } from '../../src/selfEvolution/metaLearner';
import { resetMessageBus } from '../../src/runtime/messageBus';

function makeTree(): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Optimize this workflow',
    role: 'EXECUTOR',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
    subtasks: [
      {
        id: 'leaf-1',
        parentId: 'root',
        goal: 'Leaf one',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'PENDING',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
      },
      {
        id: 'leaf-2',
        parentId: 'root',
        goal: 'Leaf two',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'PENDING',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
      },
    ],
  };
}

function makeExperience(overrides: Partial<ExecutionExperience> = {}): ExecutionExperience {
  return {
    id: 'exp-1',
    runId: 'run-1',
    agentId: 'agent-1',
    taskType: 'coding',
    modelUsed: 'claude-sonnet-4-6',
    strategyUsed: 'PARALLEL',
    success: true,
    durationMs: 5000,
    tokenCost: 2000,
    lessons: ['lesson'],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(): UltimateExecutionContext {
  return {
    id: 'run-1',
    projectId: 'proj-1',
    goal: 'Optimize',
    context: {},
    sharedState: {
      findings: [],
      errors: [],
      messages: [],
      artifacts: [],
      costAccumulator: 0,
      currentStep: '',
    },
    topology: 'PARALLEL',
    effortLevel: 'MODERATE',
    scalingRules: {
      level: 'MODERATE',
      minSubAgents: 1,
      maxSubAgents: 4,
      minToolCallsPerAgent: 0,
      maxToolCallsPerAgent: 10,
      recommendedTopology: 'PARALLEL',
      thinkingTokens: 256,
      maxDepth: 3,
      leadModelTier: 'standard',
      specialistModelTier: 'eco',
    },
    artifacts: [],
    budget: {
      hardCapTokens: 10000,
      softCapTokens: 8000,
      costCapUsd: 1,
    },
    thinkingBudget: {
      enabled: false,
      maxThinkingTokens: 0,
      subAgentThinkingTokens: 0,
      minThinkingBeforeTools: 0,
    },
    synthesisConfig: {
      strategy: 'LEAD_SYNTHESIS',
      maxRounds: 1,
      consensusThreshold: 0.5,
      includeDissent: false,
      qualityGates: [],
    },
    governance: {
      requiresApproval: false,
      humanInTheLoop: false,
    },
    maxRetries: 2,
    circuitBreaker: {
      maxErrors: 3,
      cooldownMs: 1000,
      currentErrors: 0,
      tripped: false,
    },
  };
}

describe('ReflexionTopologicalOptimizer', () => {
  beforeEach(() => {
    resetTraceRecorder();
    resetReflectionEngine();
    resetMetaLearner();
    resetMessageBus();
  });

  it('optimize returns a result with a proposal and a new tree', async () => {
    const optimizer = new ReflexionTopologicalOptimizer();
    const tree = makeTree();
    const result = await optimizer.optimize(makeExperience(), tree, makeContext());

    expect(typeof result.applied).toBe('boolean');
    expect(result.applied).toBe(result.proposal.actions.length > 0);
    expect(result.proposal).toBeDefined();
    expect(result.proposal.actions).toBeInstanceOf(Array);
    expect(result.newTree.id).toBe('root');
  });

  it('getHistory returns recorded optimizations', async () => {
    const optimizer = new ReflexionTopologicalOptimizer();
    expect(optimizer.getHistory()).toHaveLength(0);

    await optimizer.optimize(makeExperience(), makeTree(), makeContext());
    expect(optimizer.getHistory()).toHaveLength(1);

    await optimizer.optimize(makeExperience(), makeTree(), makeContext());
    expect(optimizer.getHistory()).toHaveLength(2);
  });

  it('reset clears optimization history', async () => {
    const optimizer = new ReflexionTopologicalOptimizer();
    await optimizer.optimize(makeExperience(), makeTree(), makeContext());
    optimizer.reset();
    expect(optimizer.getHistory()).toHaveLength(0);
  });
});
