/**
 * Extracted from UltimateOrchestrator to shrink the god object.
 *
 * Responsible for:
 *  - buildContext: constructing the initial UltimateExecutionContext from params + config
 *  - computeMetrics: aggregating execution metrics from the task tree
 *  - sumTokenUsage: summing token usage across all nodes in a task tree
 *  - estimateTotalCost: estimating USD cost from token usage and model router pricing
 *
 * All methods are pure (no side effects, no I/O) and depend only on config + task tree data.
 */
import type {
  UltimateOrchestratorConfig,
  UltimateExecutionContext,
  UltimateMetrics,
  EffortLevel,
  OrchestrationTopology,
  TaskTreeNode,
} from './types';
import { flattenTree, countNodes } from './taskTreeUtils';
import { createInitialSharedState } from './stateManager';
import { getEffortRules } from './effortScaler';
import { getModelRouter } from '../runtime/modelRouter';
import { COST_PER_TOKEN } from '../config/constants';
import { reportSilentFailure } from '../silentFailureReporter';

export interface MetricsHelperDeps {
  config: UltimateOrchestratorConfig;
}

export class MetricsHelper {
  constructor(private readonly deps: MetricsHelperDeps) {}

  /**
   * Build the initial execution context from orchestrator config and request params.
   */
  buildContext(
    execId: string,
    params: {
      projectId: string;
      goal: string;
      contextData?: Record<string, unknown>;
      tenantId?: string;
    },
  ): UltimateExecutionContext {
    return {
      id: execId,
      projectId: params.projectId,
      tenantId: params.tenantId,
      goal: params.goal,
      context: params.contextData ?? {},
      sharedState: createInitialSharedState(),
      effortLevel: this.deps.config.defaultEffortLevel,
      scalingRules: getEffortRules(this.deps.config.defaultEffortLevel),
      topology: 'SINGLE',
      artifacts: [],
      budget: { ...this.deps.config.defaultBudget },
      thinkingBudget: { ...this.deps.config.defaultThinkingBudget },
      synthesisConfig: { ...this.deps.config.defaultSynthesisConfig },
      governance: {
        requiresApproval: false,
        humanInTheLoop: false,
      },
      maxRetries: 3,
      circuitBreaker: {
        maxErrors: 5,
        cooldownMs: 30000,
        currentErrors: 0,
        tripped: false,
      },
    };
  }

  /**
   * Compute aggregate execution metrics from the task tree.
   */
  computeMetrics(
    taskTree: TaskTreeNode,
    startTime: number,
    topology: OrchestrationTopology,
    effortLevel: EffortLevel,
    qualityScore: number,
    artifactCount: number,
  ): UltimateMetrics {
    const allNodes = flattenTree(taskTree);
    let totalTokens = 0;
    let subAgentCount = 0;

    for (const node of allNodes) {
      if (node.tokenUsage) {
        totalTokens += node.tokenUsage.totalTokens;
      }
      if (node.isAtomic) subAgentCount++;
    }

    return {
      totalTokens,
      totalCostUsd: this.estimateTotalCost(taskTree),
      totalDurationMs: Date.now() - startTime,
      llmCalls: subAgentCount * 2,
      toolCalls: subAgentCount * 5,
      subAgentsSpawned: subAgentCount,
      artifactsCreated: artifactCount,
      qualityScore,
      topologyUsed: topology,
      effortLevelUsed: effortLevel,
    };
  }

  /**
   * Sum token usage across all nodes in the task tree.
   * Falls back to a heuristic estimate when actual token usage is unavailable.
   */
  sumTokenUsage(taskTree: TaskTreeNode): number {
    let total = 0;
    const nodes = flattenTree(taskTree);
    for (const node of nodes) {
      if (node.tokenUsage) {
        total += node.tokenUsage.totalTokens;
      }
    }
    return total || Math.ceil(taskTree.goal.length / 3.7) * countNodes(taskTree);
  }

  /**
   * Estimate total cost in USD using actual model pricing from ModelRouter.
   * Falls back to a conservative per-token rate when the router is unavailable.
   */
  estimateTotalCost(taskTree: TaskTreeNode): number {
    const totalTokens = this.sumTokenUsage(taskTree);
    if (totalTokens === 0) return 0;

    try {
      const router = getModelRouter();
      const models = router.listModels();
      if (models.length > 0) {
        const avgInputCost = models.reduce((sum, m) => sum + m.costPer1MInput, 0) / models.length;
        const avgOutputCost = models.reduce((sum, m) => sum + m.costPer1MOutput, 0) / models.length;
        const blendedCostPer1K = (avgInputCost + avgOutputCost) / 2;
        return (totalTokens / 1000) * blendedCostPer1K;
      }
    } catch (err) {
      reportSilentFailure(err, 'orchestrator:1507');
      // best-effort
    }

    return totalTokens * COST_PER_TOKEN;
  }
}
