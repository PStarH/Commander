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

    let scores: Array<{ topology: OrchestrationTopology; score: number }> = [];

    for (const [topology, perf] of Object.entries(this.topologyPerformance)) {
      let score = 0;

      if (taskType === 'RESEARCH' || taskType === 'ANALYSIS') {
        score += perf.research * 3;
        score += perf.parallel * 2;
      } else if (taskType === 'CODING') {
        score += perf.sequential * 2;
        score += perf.parallel * 2;
        score += perf.complex;
      } else if (taskType === 'REASONING') {
        score += perf.complex * 3;
        score += perf.sequential;
      } else if (taskType === 'CREATIVE') {
        score += perf.parallel * 2;
        score += perf.sequential;
      } else {
        score += perf.sequential * 2;
      }

      if (dagMetrics) {
        if (dagMetrics.interSubtaskCoupling > 0.7) {
          if (topology === 'SEQUENTIAL') score += 3;
          if (topology === 'SINGLE') score += 2;
        }
        if (dagMetrics.parallelismWidth > 3) {
          if (topology === 'PARALLEL') score += 2;
          if (topology === 'HIERARCHICAL') score += 2;
          if (topology === 'HYBRID') score += 1;
        }
        if (dagMetrics.criticalPathDepth > 3) {
          if (topology === 'HIERARCHICAL') score += 2;
          if (topology === 'HYBRID') score += 1;
          if (topology === 'SEQUENTIAL') score += 1;
        }
      }

      if (effortLevel === 'SIMPLE' && topology === 'SINGLE') score += 5;
      if (effortLevel === 'DEEP_RESEARCH' && topology === 'HYBRID') score += 3;

      if (budgetConstraint) {
        const costPerf = perf.costMultiplier;
        const estimatedCost = deliberation.estimatedTokens * 0.000015 * costPerf;
        if (estimatedCost > budgetConstraint.maxCostUsd) {
          score -= 5;
        }
      }

      scores.push({ topology: topology as OrchestrationTopology, score });
    }

    scores.sort((a, b) => b.score - a.score);
    const selected = scores[0].topology;
    reasoning.push(`Topology scores: ${scores.slice(0, 4).map(s => `${s.topology}=${s.score}`).join(', ')}`);
    reasoning.push(`Selected ${selected} (score: ${scores[0].score})`);

    const costPerf = this.topologyPerformance[selected];
    const expectedCost = deliberation.estimatedTokens * 0.000015 * costPerf.costMultiplier;

    const latencyMap: Record<OrchestrationTopology, string> = {
      SINGLE: '< 5s',
      SEQUENTIAL: '10-30s',
      PARALLEL: '15-45s',
      HIERARCHICAL: '30-120s',
      HYBRID: '1-5min',
      DEBATE: '30-90s',
      ENSEMBLE: '20-60s',
      EVALUATOR_OPTIMIZER: '30-120s',
    };

    return {
      topology: selected,
      reasoning,
      expectedCost,
      expectedLatency: latencyMap[selected],
    };
  }

  buildDAG(
    nodes: TaskDAGNode[],
    edges: TaskDAGEdge[],
  ): TaskDAG {
    const nodeSet = new Set(nodes.map(n => n.id));
    const incomingEdges = new Map<string, number>();
    const outgoingEdges = new Map<string, number>();

    for (const node of nodes) {
      incomingEdges.set(node.id, 0);
      outgoingEdges.set(node.id, 0);
    }

    for (const edge of edges) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        incomingEdges.set(edge.to, (incomingEdges.get(edge.to) ?? 0) + 1);
        outgoingEdges.set(edge.from, (outgoingEdges.get(edge.from) ?? 0) + 1);
      }
    }

    const parallelismWidth = Math.max(
      1,
      ...Array.from(outgoingEdges.values()),
      ...Array.from(incomingEdges.values()),
    );

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

  private calculateCriticalPath(nodes: TaskDAGNode[], edges: TaskDAGEdge[]): number {
    const adjList = new Map<string, string[]>();
    for (const node of nodes) {
      adjList.set(node.id, []);
    }
    for (const edge of edges) {
      adjList.get(edge.from)?.push(edge.to);
    }

    const memo = new Map<string, number>();
    const dfs = (nodeId: string): number => {
      if (memo.has(nodeId)) return memo.get(nodeId)!;
      const neighbors = adjList.get(nodeId) ?? [];
      let maxDepth = 0;
      for (const neighbor of neighbors) {
        maxDepth = Math.max(maxDepth, dfs(neighbor));
      }
      memo.set(nodeId, maxDepth + 1);
      return maxDepth + 1;
    };

    let maxDepth = 0;
    for (const node of nodes) {
      maxDepth = Math.max(maxDepth, dfs(node.id));
    }
    return maxDepth;
  }

  private classifyEffort(estimatedAgentCount: number): EffortLevel {
    if (estimatedAgentCount <= 1) return 'SIMPLE';
    if (estimatedAgentCount <= 4) return 'MODERATE';
    if (estimatedAgentCount <= 10) return 'COMPLEX';
    return 'DEEP_RESEARCH';
  }
}
