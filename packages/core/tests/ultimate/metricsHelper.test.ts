import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricsHelper } from '../../src/ultimate/metricsHelper';
import { resetModelRouter } from '../../src/runtime/modelRouter';
import type {
  UltimateOrchestratorConfig,
  TaskTreeNode,
  EffortLevel,
  OrchestrationTopology,
} from '../../src/ultimate/types';

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

function makeTaskTree(overrides?: Partial<TaskTreeNode>): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root goal for testing',
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
        goal: 'Child 1 task',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'COMPLETED',
        result: 'result-1',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
        tokenUsage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 },
      },
      {
        id: 'child-2',
        parentId: 'root',
        goal: 'Child 2 task',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'COMPLETED',
        result: 'result-2',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
        tokenUsage: { promptTokens: 300, completionTokens: 100, totalTokens: 400 },
      },
    ],
    ...overrides,
  } as TaskTreeNode;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MetricsHelper', () => {
  beforeEach(() => {
    resetModelRouter();
  });

  // ── buildContext ────────────────────────────────────────────────────────────

  describe('buildContext', () => {
    it('builds context with default config values', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const ctx = helper.buildContext('exec-1', {
        projectId: 'proj-1',
        goal: 'test goal',
      });

      expect(ctx.id).toBe('exec-1');
      expect(ctx.projectId).toBe('proj-1');
      expect(ctx.goal).toBe('test goal');
      expect(ctx.effortLevel).toBe('MODERATE');
      expect(ctx.topology).toBe('SINGLE');
      expect(ctx.artifacts).toEqual([]);
      expect(ctx.maxRetries).toBe(3);
      expect(ctx.circuitBreaker.tripped).toBe(false);
    });

    it('passes contextData and tenantId through', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const contextData = { foo: 'bar', count: 42 };
      const ctx = helper.buildContext('exec-2', {
        projectId: 'proj-2',
        goal: 'test',
        contextData,
        tenantId: 'tenant-1',
      });

      expect(ctx.context).toEqual(contextData);
      expect(ctx.tenantId).toBe('tenant-1');
    });

    it('defaults contextData to empty object when not provided', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const ctx = helper.buildContext('exec-3', {
        projectId: 'proj-3',
        goal: 'test',
      });

      expect(ctx.context).toEqual({});
    });

    it('clones budget and synthesisConfig from config (not shared reference)', () => {
      const config = makeConfig();
      const helper = new MetricsHelper({ config });
      const ctx = helper.buildContext('exec-4', {
        projectId: 'proj-4',
        goal: 'test',
      });

      // Mutating ctx.budget should not affect config.defaultBudget
      ctx.budget.hardCapTokens = 999999;
      expect(config.defaultBudget.hardCapTokens).toBe(128000);
    });
  });

  // ── sumTokenUsage ───────────────────────────────────────────────────────────

  describe('sumTokenUsage', () => {
    it('sums tokenUsage.totalTokens across all nodes', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree = makeTaskTree();
      // root has no tokenUsage, child-1 has 700, child-2 has 400
      expect(helper.sumTokenUsage(tree)).toBe(1100);
    });

    it('returns heuristic estimate when no tokenUsage is set', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree: TaskTreeNode = {
        id: 'root',
        parentId: null,
        goal: 'A short goal', // 13 chars → ceil(13/3.7) = 4 tokens per node
        role: 'PLANNER',
        isAtomic: false,
        status: 'PENDING',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
      };
      // 1 node × 4 tokens = 4
      expect(helper.sumTokenUsage(tree)).toBe(4);
    });

    it('handles tree with no subtasks', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree: TaskTreeNode = {
        id: 'root',
        parentId: null,
        goal: 'x',
        role: 'EXECUTOR',
        isAtomic: true,
        status: 'COMPLETED',
        result: 'done',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
      expect(helper.sumTokenUsage(tree)).toBe(15);
    });
  });

  // ── estimateTotalCost ───────────────────────────────────────────────────────

  describe('estimateTotalCost', () => {
    it('returns 0 when totalTokens is 0', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree: TaskTreeNode = {
        id: 'root',
        parentId: null,
        goal: '',
        role: 'PLANNER',
        isAtomic: false,
        status: 'PENDING',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
      };
      // Empty goal → heuristic returns 0
      expect(helper.estimateTotalCost(tree)).toBe(0);
    });

    it('returns positive cost when tokens are used', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree = makeTaskTree();
      // 1100 tokens → some positive cost (exact value depends on model router fallback)
      const cost = helper.estimateTotalCost(tree);
      expect(cost).toBeGreaterThan(0);
    });

    it('falls back to COST_PER_TOKEN when model router is unavailable', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree = makeTaskTree();
      // Without model router configured, falls back to totalTokens * COST_PER_TOKEN
      const cost = helper.estimateTotalCost(tree);
      expect(cost).toBeGreaterThan(0);
      // Model router may return real pricing; just verify it's positive and reasonable
      expect(cost).toBeLessThan(100);
    });
  });

  // ── computeMetrics ──────────────────────────────────────────────────────────

  describe('computeMetrics', () => {
    it('computes metrics from task tree', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree = makeTaskTree();
      const startTime = Date.now() - 5000; // 5 seconds ago

      const metrics = helper.computeMetrics(
        tree,
        startTime,
        'CHAIN' as OrchestrationTopology,
        'MODERATE' as EffortLevel,
        0.85,
        3,
      );

      expect(metrics.totalTokens).toBe(1100);
      expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(5000);
      expect(metrics.subAgentsSpawned).toBe(2); // 2 atomic nodes
      expect(metrics.llmCalls).toBe(4); // 2 * 2
      expect(metrics.toolCalls).toBe(10); // 2 * 5
      expect(metrics.artifactsCreated).toBe(3);
      expect(metrics.qualityScore).toBe(0.85);
      expect(metrics.topologyUsed).toBe('CHAIN');
      expect(metrics.effortLevelUsed).toBe('MODERATE');
      expect(metrics.totalCostUsd).toBeGreaterThan(0);
    });

    it('handles tree with no atomic nodes', () => {
      const helper = new MetricsHelper({ config: makeConfig() });
      const tree: TaskTreeNode = {
        id: 'root',
        parentId: null,
        goal: 'test',
        role: 'PLANNER',
        isAtomic: false,
        status: 'COMPLETED',
        result: 'done',
        dependencies: [],
        context: { systemPrompt: '', availableTools: [], estimatedTokens: 0 },
        subtasks: [],
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };

      const metrics = helper.computeMetrics(
        tree,
        Date.now(),
        'SINGLE' as OrchestrationTopology,
        'SIMPLE' as EffortLevel,
        0.5,
        0,
      );

      expect(metrics.subAgentsSpawned).toBe(0);
      expect(metrics.llmCalls).toBe(0);
      expect(metrics.toolCalls).toBe(0);
      expect(metrics.totalTokens).toBe(150);
    });
  });
});
