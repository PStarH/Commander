/**
 * Dynamic Topology Router - AdaptOrch-inspired topology selection.
 *
 * AdaptOrch research shows topology-aware orchestration achieves 12-23%
 * improvement over fixed-topology baselines. The router analyzes task
 * dependency DAGs and selects the optimal topology in O(|V|+|E|) time.
 */
import type {
  OrchestrationTopology,
  TaskDAG,
  TaskDAGNode,
  TaskDAGEdge,
  DeliberationPlan,
  EffortLevel,
} from './types';
import { COST_PER_TOKEN } from '../config/constants';

/** Weight multipliers for task type scoring */
const TASK_TYPE_WEIGHTS = {
  RESEARCH: { research: 3, parallel: 2, sequential: 0, complex: 0 },
  ANALYSIS: { research: 3, parallel: 2, sequential: 0, complex: 0 },
  CODING: { research: 0, parallel: 2, sequential: 2, complex: 1 },
  REASONING: { research: 0, parallel: 0, sequential: 1, complex: 3 },
  CREATIVE: { research: 0, parallel: 2, sequential: 1, complex: 0 },
  FACTUAL: { research: 0, parallel: 0, sequential: 2, complex: 0 },
} as const;

/** DAG metric thresholds for topology bonuses */
const DAG_THRESHOLDS = {
  HIGH_COUPLING: 0.7,
  HIGH_PARALLELISM: 3,
  DEEP_CRITICAL_PATH: 3,
} as const;

/** Bonus scores for DAG-aware topology selection */
const DAG_BONUSES = {
  HIGH_COUPLING: { SEQUENTIAL: 3, SINGLE: 2 },
  HIGH_PARALLELISM: { PARALLEL: 2, HIERARCHICAL: 2, HYBRID: 1 },
  DEEP_CRITICAL_PATH: { HIERARCHICAL: 2, HYBRID: 1, SEQUENTIAL: 1 },
} as const;

/** Effort level bonuses */
const EFFORT_BONUSES = {
  SIMPLE_SINGLE: 5,
  DEEP_RESEARCH_HYBRID: 3,
} as const;

/** Task nature bonuses (Astraea-inspired) */
const TASK_NATURE_BONUSES = {
  IO_BOUND: { PARALLEL: 3, HYBRID: 2, HIERARCHICAL: 1 },
  COMPUTE_BOUND: { SEQUENTIAL: 2, DEBATE: 1 },
} as const;

/** Speculation bonuses (SPAgent-inspired) */
const SPECULATION_BONUSES = { PARALLEL: 2, ENSEMBLE: 1 } as const;

/** Cost penalty for exceeding budget */
const BUDGET_PENALTY = 5;

export class TopologyRouter {
private readonly topologyPerformance: Record<OrchestrationTopology, {
     sequential: number;  // suitability for sequential tasks 0-1
     parallel: number;    // suitability for parallel tasks 0-1
     complex: number;     // suitability for complex tasks 0-1
     research: number;    // suitability for research tasks 0-1
     costMultiplier: number;
   }> = {
     SINGLE: { sequential: 1.0, parallel: 0.2, complex: 0.1, research: 0.1, costMultiplier: 1.0 },
     SEQUENTIAL: { sequential: 1.0, parallel: 0.3, complex: 0.3, research: 0.2, costMultiplier: 1.1 },
     PARALLEL: { sequential: 0.3, parallel: 1.0, complex: 0.6, research: 0.8, costMultiplier: 2.0 },
     HIERARCHICAL: { sequential: 0.4, parallel: 0.7, complex: 1.0, research: 0.9, costMultiplier: 3.0 },
     HYBRID: { sequential: 0.5, parallel: 0.8, complex: 0.9, research: 1.0, costMultiplier: 4.0 },
     DEBATE: { sequential: 0.3, parallel: 0.4, complex: 0.8, research: 0.5, costMultiplier: 3.5 },
     ENSEMBLE: { sequential: 0.2, parallel: 0.9, complex: 0.5, research: 0.4, costMultiplier: 3.0 },
     EVALUATOR_OPTIMIZER: { sequential: 0.6, parallel: 0.3, complex: 0.7, research: 0.3, costMultiplier: 2.5 },
     HANDOFF: { sequential: 0.8, parallel: 0.6, complex: 0.7, research: 0.6, costMultiplier: 2.0 },
     CONSENSUS: { sequential: 0.5, parallel: 0.7, complex: 0.8, research: 0.7, costMultiplier: 3.5 },
   };

  route(
    deliberation: DeliberationPlan,
    dag?: TaskDAG,
    budgetConstraint?: { maxCostUsd: number; maxTokens: number },
  ): {
    topology: OrchestrationTopology;
    reasoning: string[];
    expectedCost: number;
    expectedLatency: string;
  } {
    const reasoning: string[] = [];

    const dagMetrics = dag?.metadata;
    const taskType = deliberation.taskType;
    const effortLevel = this.classifyEffort(deliberation.estimatedAgentCount);

    const scores: Array<{ topology: OrchestrationTopology; score: number }> = [];

    const topologies = Object.keys(this.topologyPerformance) as OrchestrationTopology[];
    for (const topology of topologies) {
      const perf = this.topologyPerformance[topology];
      let score = 0;

      // Task type scoring using structured weights
      const typeWeights = TASK_TYPE_WEIGHTS[taskType] ?? TASK_TYPE_WEIGHTS.FACTUAL;
      score += perf.research * typeWeights.research;
      score += perf.parallel * typeWeights.parallel;
      score += perf.sequential * typeWeights.sequential;
      score += perf.complex * typeWeights.complex;

      // DAG-aware bonuses
      if (dagMetrics) {
        if (dagMetrics.interSubtaskCoupling > DAG_THRESHOLDS.HIGH_COUPLING) {
          score += DAG_BONUSES.HIGH_COUPLING[topology as keyof typeof DAG_BONUSES.HIGH_COUPLING] ?? 0;
        }
        if (dagMetrics.parallelismWidth > DAG_THRESHOLDS.HIGH_PARALLELISM) {
          score += DAG_BONUSES.HIGH_PARALLELISM[topology as keyof typeof DAG_BONUSES.HIGH_PARALLELISM] ?? 0;
        }
        if (dagMetrics.criticalPathDepth > DAG_THRESHOLDS.DEEP_CRITICAL_PATH) {
          score += DAG_BONUSES.DEEP_CRITICAL_PATH[topology as keyof typeof DAG_BONUSES.DEEP_CRITICAL_PATH] ?? 0;
        }
      }

      // Effort level bonuses
      if (effortLevel === 'SIMPLE' && topology === 'SINGLE') score += EFFORT_BONUSES.SIMPLE_SINGLE;
      if (effortLevel === 'DEEP_RESEARCH' && topology === 'HYBRID') score += EFFORT_BONUSES.DEEP_RESEARCH_HYBRID;

      // Astraea-inspired: IO-bound tasks benefit more from parallelism
      if (deliberation.taskNature === 'IO_BOUND') {
        score += TASK_NATURE_BONUSES.IO_BOUND[topology as keyof typeof TASK_NATURE_BONUSES.IO_BOUND] ?? 0;
      }
      // Compute-bound tasks benefit from sequential/debate for deep reasoning
      if (deliberation.taskNature === 'COMPUTE_BOUND') {
        score += TASK_NATURE_BONUSES.COMPUTE_BOUND[topology as keyof typeof TASK_NATURE_BONUSES.COMPUTE_BOUND] ?? 0;
      }

      // SPAgent-inspired: speculation-suitable tasks prefer faster topologies
      if (deliberation.suitableForSpeculation) {
        score += SPECULATION_BONUSES[topology as keyof typeof SPECULATION_BONUSES] ?? 0;
      }

      // Budget constraint penalty
      if (budgetConstraint) {
        const estimatedCost = deliberation.estimatedTokens * COST_PER_TOKEN * perf.costMultiplier;
        if (estimatedCost > budgetConstraint.maxCostUsd) {
          score -= BUDGET_PENALTY;
        }
      }

      scores.push({ topology, score });
    }

    scores.sort((a, b) => b.score - a.score);
    const selected = scores[0].topology;
    reasoning.push(`Topology scores: ${scores.slice(0, 4).map(s => `${s.topology}=${s.score}`).join(', ')}`);
    reasoning.push(`Selected ${selected} (score: ${scores[0].score})`);

    const costPerf = this.topologyPerformance[selected];
    const expectedCost = deliberation.estimatedTokens * COST_PER_TOKEN * costPerf.costMultiplier;

    const latencyMap: Record<OrchestrationTopology, string> = {
      SINGLE: '< 5s',
      SEQUENTIAL: '10-30s',
      PARALLEL: '15-45s',
      HIERARCHICAL: '30-120s',
      HYBRID: '1-5min',
      DEBATE: '30-90s',
      ENSEMBLE: '20-60s',
      EVALUATOR_OPTIMIZER: '30-120s',
      HANDOFF: '10-30s',
      CONSENSUS: '20-60s',
    };

    return {
      topology: selected,
      reasoning,
      expectedCost,
      expectedLatency: latencyMap[selected],
    };
  }

  /**
   * Build a TaskDAG from nodes and edges, with cycle detection.
   *
   * Throws on cyclic task graphs — a task DAG with cycles is a logic bug
   * that would silently produce incorrect critical-path / parallelism metrics.
   * Surface it instead of returning garbage.
   */
  buildDAG(
    nodes: TaskDAGNode[],
    edges: TaskDAGEdge[],
  ): TaskDAG {
    this.assertAcyclic(nodes, edges);
    const nodeSet = new Set(nodes.map(n => n.id));

    // Build adjacency list for topological sort
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    for (const node of nodes) {
      inDegree.set(node.id, 0);
      adjList.set(node.id, []);
    }
    for (const edge of edges) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
        adjList.get(edge.from)?.push(edge.to);
      }
    }

    // Compute parallelism width: max nodes at any topological level
    const parallelismWidth = this.computeMaxLevelWidth(nodes, inDegree, adjList);

    const criticalPathDepth = this.calculateCriticalPath(nodes, edges);

    const couplingEdges = edges.filter(e => e.dataDependency);
    const interSubtaskCoupling = edges.length > 0
      ? Math.min(1, couplingEdges.length / edges.length)
      : 0;

    return {
      nodes,
      edges,
      metadata: {
        parallelismWidth,
        criticalPathDepth,
        interSubtaskCoupling,
      },
    };
  }

  /**
   * Compute the maximum number of nodes that can execute simultaneously
   * (max width of any topological level). This is the true parallelism width.
   */
  private computeMaxLevelWidth(
    nodes: TaskDAGNode[],
    inDegree: Map<string, number>,
    adjList: Map<string, string[]>,
  ): number {
    const queue: string[] = [];
    const level = new Map<string, number>();

    for (const node of nodes) {
      if ((inDegree.get(node.id) ?? 0) === 0) {
        queue.push(node.id);
        level.set(node.id, 0);
      }
    }

    let qIdx = 0;
    while (qIdx < queue.length) {
      const current = queue[qIdx++];
      const currentLevel = level.get(current) ?? 0;
      for (const neighbor of (adjList.get(current) ?? [])) {
        const newLevel = currentLevel + 1;
        const existing = level.get(neighbor) ?? 0;
        level.set(neighbor, Math.max(existing, newLevel));
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    // Count nodes per level, return max
    const levelCounts = new Map<number, number>();
    for (const [, lvl] of level) {
      levelCounts.set(lvl, (levelCounts.get(lvl) ?? 0) + 1);
    }

    let maxWidth = 0;
    for (const [, count] of levelCounts) {
      maxWidth = Math.max(maxWidth, count);
    }

    return maxWidth || 1;
  }

  private calculateCriticalPath(nodes: TaskDAGNode[], edges: TaskDAGEdge[]): number {
    const adjList = new Map<string, string[]>();
    for (const node of nodes) {
      adjList.set(node.id, []);
    }
    for (const edge of edges) {
      adjList.get(edge.from)?.push(edge.to);
    }

    const memo = new Map<string, number>();
    const visiting = new Set<string>();
    const dfs = (nodeId: string): number => {
      if (memo.has(nodeId)) return memo.get(nodeId)!;
      if (visiting.has(nodeId)) return 0; // Cycle detected, break the loop
      visiting.add(nodeId);
      const neighbors = adjList.get(nodeId) ?? [];
      let maxDepth = 0;
      for (const neighbor of neighbors) {
        maxDepth = Math.max(maxDepth, dfs(neighbor));
      }
      visiting.delete(nodeId);
      memo.set(nodeId, maxDepth + 1);
      return maxDepth + 1;
    };

    let maxDepth = 0;
    for (const node of nodes) {
      maxDepth = Math.max(maxDepth, dfs(node.id));
    }
    return maxDepth;
  }

  private assertAcyclic(nodes: TaskDAGNode[], edges: TaskDAGEdge[]): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const n of nodes) color.set(n.id, WHITE);
    const adjList = new Map<string, string[]>();
    for (const n of nodes) adjList.set(n.id, []);
    for (const e of edges) {
      if (adjList.has(e.from) && adjList.has(e.to)) {
        adjList.get(e.from)!.push(e.to);
      }
    }
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const path: string[] = [];
    const visit = (nodeId: string): void => {
      const c = color.get(nodeId) ?? WHITE;
      if (c === BLACK) return;
      if (c === GRAY) {
        const startIdx = path.indexOf(nodeId);
        const cycleOnly = path.slice(startIdx);
        const named = cycleOnly.map(id => nodeMap.get(id)?.label ?? id).join(' → ');
        throw new Error(
          `TopologyRouter.buildDAG: cyclic task graph detected (${named}). ` +
          `Task DAGs must be acyclic — fix the dependency declarations.`,
        );
      }
      color.set(nodeId, GRAY);
      path.push(nodeId);
      for (const neighbor of adjList.get(nodeId) ?? []) {
        visit(neighbor);
      }
      path.pop();
      color.set(nodeId, BLACK);
    };
    for (const node of nodes) {
      if ((color.get(node.id) ?? WHITE) === WHITE) visit(node.id);
    }
  }

  private classifyEffort(estimatedAgentCount: number): EffortLevel {
    if (estimatedAgentCount <= 1) return 'SIMPLE';
    if (estimatedAgentCount <= 4) return 'MODERATE';
    if (estimatedAgentCount <= 10) return 'COMPLEX';
    return 'DEEP_RESEARCH';
  }
}
