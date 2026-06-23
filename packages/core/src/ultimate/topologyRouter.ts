/**
 * Dynamic Topology Router - hardcoded topology selection.
 *
 * Scores topologies using fixed heuristic tables and selects the highest-scoring
 * candidate. No learned weights are applied (epsilon defaults to 0, pheromone
 * biasing is a no-op). The "DAG analysis" is derived from deliberation estimates,
 * not actual task dependencies.
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
import { evaluateCoordinationPolicy, type CoordinationDecision } from './coordinationPolicy';
import { LearnedWeights, type TypeWeights } from './learnedWeights';

/**
 * Configuration for epsilon-greedy exploration in topology selection.
 */
export interface EpsilonGreedyConfig {
  /** Probability of exploring (non-argmax) in [0, 1]. Default 0.05. */
  epsilon?: number;
  /** Boltzmann temperature: higher = more uniform exploration. Default 1.0. */
  explorationTemperature?: number;
  /** Seeded PRNG for deterministic tests. Default Math.random. */
  rng?: () => number;
}

/** Exploration statistics exposed by getExplorationStats(). */
export interface ExplorationStats {
  routingCount: number;
  explorationCount: number;
  explorationRate: number;
}

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
  /** ε-greedy exploration rate in [0, 1]. */
  private epsilon: number;
  /** Boltzmann temperature for exploration draws. */
  private readonly explorationTemperature: number;
  /** Random number generator (seeded for deterministic tests). */
  private readonly rng: () => number;
  /** Total routing calls made through this router. */
  private routingCount = 0;
  /** Number of times the ε-greedy draw actually diverged from argmax. */
  private explorationCount = 0;
  /** Learned weights for online meta-learning. */
  private readonly learnedWeights: LearnedWeights;
  /** Per-tenant epsilon override store. */
  private readonly epsilonStore?: import('./epsilonStore').EpsilonStore;

  constructor(
    learnedWeights?: LearnedWeights,
    config?: EpsilonGreedyConfig & { epsilonStore?: import('./epsilonStore').EpsilonStore },
  ) {
    const rawEpsilon = config?.epsilon ?? 0;
    this.epsilon = Number.isNaN(rawEpsilon) ? 0 : Math.max(0, Math.min(1, rawEpsilon));
    this.explorationTemperature = config?.explorationTemperature ?? 1.0;
    this.rng = config?.rng ?? Math.random;
    this.epsilonStore = config?.epsilonStore;
    // Create or store learned weights
    this.learnedWeights = learnedWeights ?? new LearnedWeights();
  }

  /** Expose the internal LearnedWeights for tests and observability. */
  getLearnedWeights(): LearnedWeights {
    return this.learnedWeights;
  }

  private readonly topologyPerformance: Record<
    OrchestrationTopology,
    {
      sequential: number; // suitability for sequential tasks 0-1
      parallel: number; // suitability for parallel tasks 0-1
      complex: number; // suitability for complex tasks 0-1
      research: number; // suitability for research tasks 0-1
      costMultiplier: number;
    }
  > = {
    SINGLE: { sequential: 1.0, parallel: 0.2, complex: 0.1, research: 0.1, costMultiplier: 1.0 },
    SEQUENTIAL: {
      sequential: 1.0,
      parallel: 0.3,
      complex: 0.3,
      research: 0.2,
      costMultiplier: 1.1,
    },
    PARALLEL: { sequential: 0.3, parallel: 1.0, complex: 0.6, research: 0.8, costMultiplier: 2.0 },
    HIERARCHICAL: {
      sequential: 0.4,
      parallel: 0.7,
      complex: 1.0,
      research: 0.9,
      costMultiplier: 3.0,
    },
    HYBRID: { sequential: 0.5, parallel: 0.8, complex: 0.9, research: 1.0, costMultiplier: 4.0 },
    DEBATE: { sequential: 0.3, parallel: 0.4, complex: 0.8, research: 0.5, costMultiplier: 3.5 },
    ENSEMBLE: { sequential: 0.2, parallel: 0.9, complex: 0.5, research: 0.4, costMultiplier: 3.0 },
    EVALUATOR_OPTIMIZER: {
      sequential: 0.6,
      parallel: 0.3,
      complex: 0.7,
      research: 0.3,
      costMultiplier: 2.5,
    },
    HANDOFF: { sequential: 0.8, parallel: 0.6, complex: 0.7, research: 0.6, costMultiplier: 2.0 },
    CONSENSUS: { sequential: 0.5, parallel: 0.7, complex: 0.8, research: 0.7, costMultiplier: 3.5 },
    // Canonical (D3.2 migration window) — mirror each legacy alias so
    // canonical-name lookups return identical scores in any code path
    // that passes the new name explicitly (CLI `--topology=<canonical>`
    // flag, programmatic orchestrator override, or
    // `normalizeTopology()`-normalized input). Entries placed AFTER the
    // legacy 10 so `Object.keys(this.topologyPerformance)` iteration
    // resolves tied scores to legacy names — this preserves the existing
    // auto-routing behavior for callers who don't yet migrate (the user's
    // "全程不删任何 routing 行为，只改字符串" directive). After the
    // 2-minor-version hard-removal, these entries move to the front and
    // become the new argmax defaults.
    CHAIN: {
      // ← SEQUENTIAL
      sequential: 1.0,
      parallel: 0.3,
      complex: 0.3,
      research: 0.2,
      costMultiplier: 1.1,
    },
    DISPATCH: {
      // ← PARALLEL
      sequential: 0.3,
      parallel: 1.0,
      complex: 0.6,
      research: 0.8,
      costMultiplier: 2.0,
    },
    ORCHESTRATOR: {
      // ← HIERARCHICAL
      sequential: 0.4,
      parallel: 0.7,
      complex: 1.0,
      research: 0.9,
      costMultiplier: 3.0,
    },
    REVIEW: {
      // ← EVALUATOR_OPTIMIZER
      sequential: 0.6,
      parallel: 0.3,
      complex: 0.7,
      research: 0.3,
      costMultiplier: 2.5,
    },
  };

  route(
    deliberation: DeliberationPlan,
    dag?: TaskDAG,
    budgetConstraint?: { maxCostUsd: number; maxTokens: number },
    _tenantId?: string,
    perCallConfig?: EpsilonGreedyConfig,
  ): {
    topology: OrchestrationTopology;
    reasoning: string[];
    expectedCost: number;
    expectedLatency: string;
    explorationTriggered: boolean;
    epsilonUsed: number;
    argmaxTopology: OrchestrationTopology;
    coordination?: CoordinationDecision;
    biasedScores?: Array<{
      topology: OrchestrationTopology;
      score: number;
    }>;
    adjustedWeights?: {
      adjusted: TypeWeights;
      adjustments: Record<string, number>;
      maturePairs: number;
    };
  } {
    const reasoning: string[] = [];

    const dagMetrics = dag?.metadata;
    const taskType = deliberation.taskType;
    const effortLevel = this.classifyEffort(deliberation.estimatedAgentCount);

    // Resolve epsilon: per-call > per-tenant > constructor default
    const perCallEpsilon = perCallConfig?.epsilon;
    const effectiveEpsilon =
      perCallEpsilon !== undefined
        ? Number.isNaN(perCallEpsilon)
          ? 0.05
          : Math.max(0, Math.min(1, perCallEpsilon))
        : this.resolveEpsilon(_tenantId);

    const scores: Array<{ topology: OrchestrationTopology; score: number }> = [];

    const topologies = Object.keys(this.topologyPerformance) as OrchestrationTopology[];

    // Get adjusted weights from learned weights (may be boosted/penalized by experience)
    const baseWeights = TASK_TYPE_WEIGHTS[taskType] ?? TASK_TYPE_WEIGHTS.FACTUAL;
    const adjustedWeightsResult = this.learnedWeights.getAdjustedWeights(
      taskType,
      baseWeights,
      _tenantId,
    );
    const typeWeights = adjustedWeightsResult.adjusted;

    // If mature pairs exist, log the learned-weights line
    if (adjustedWeightsResult.maturePairs > 0) {
      const adjStr = Object.entries(adjustedWeightsResult.adjustments)
        .filter(([, v]) => v !== 0)
        .map(([t, v]) => `${t.toLowerCase()}=${v.toFixed(2)}`)
        .join(', ');
      reasoning.push(`Learned weights for ${taskType}: ${adjStr}`);
    }

    for (const topology of topologies) {
      const perf = this.topologyPerformance[topology];
      let score = 0;

      // Task type scoring using structured weights (may be learned-adjusted)

      score += perf.research * typeWeights.research;
      score += perf.parallel * typeWeights.parallel;
      score += perf.sequential * typeWeights.sequential;
      score += perf.complex * typeWeights.complex;

      // DAG-aware bonuses
      if (dagMetrics) {
        if (dagMetrics.interSubtaskCoupling > DAG_THRESHOLDS.HIGH_COUPLING) {
          score +=
            DAG_BONUSES.HIGH_COUPLING[topology as keyof typeof DAG_BONUSES.HIGH_COUPLING] ?? 0;
        }
        if (dagMetrics.parallelismWidth > DAG_THRESHOLDS.HIGH_PARALLELISM) {
          score +=
            DAG_BONUSES.HIGH_PARALLELISM[topology as keyof typeof DAG_BONUSES.HIGH_PARALLELISM] ??
            0;
        }
        if (dagMetrics.criticalPathDepth > DAG_THRESHOLDS.DEEP_CRITICAL_PATH) {
          score +=
            DAG_BONUSES.DEEP_CRITICAL_PATH[
              topology as keyof typeof DAG_BONUSES.DEEP_CRITICAL_PATH
            ] ?? 0;
        }
      }

      // Effort level bonuses
      if (effortLevel === 'SIMPLE' && topology === 'SINGLE') score += EFFORT_BONUSES.SIMPLE_SINGLE;
      if (effortLevel === 'DEEP_RESEARCH' && topology === 'HYBRID')
        score += EFFORT_BONUSES.DEEP_RESEARCH_HYBRID;

      // Astraea-inspired: IO-bound tasks benefit more from parallelism
      if (deliberation.taskNature === 'IO_BOUND') {
        score +=
          TASK_NATURE_BONUSES.IO_BOUND[topology as keyof typeof TASK_NATURE_BONUSES.IO_BOUND] ?? 0;
      }
      // Compute-bound tasks benefit from sequential/debate for deep reasoning
      if (deliberation.taskNature === 'COMPUTE_BOUND') {
        score +=
          TASK_NATURE_BONUSES.COMPUTE_BOUND[
            topology as keyof typeof TASK_NATURE_BONUSES.COMPUTE_BOUND
          ] ?? 0;
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
    const argmaxTopology = scores[0].topology;
    const argmaxScore = scores[0].score;

    // ε-greedy exploration: with probability epsilon, draw from a
    // Boltzmann distribution over the scored candidates instead of
    // always picking the argmax.
    const effectiveTemp = perCallConfig?.explorationTemperature ?? this.explorationTemperature;
    const activeRng = perCallConfig?.rng ?? this.rng;

    this.routingCount++;
    let selected: OrchestrationTopology;
    let explorationTriggered = false;

    // ε-greedy gate: only explore when there are at least 2 candidates
    if (effectiveEpsilon > 0 && scores.length > 1 && activeRng() < effectiveEpsilon) {
      // Boltzmann draw over all candidates
      selected = boltzmannDraw(scores, effectiveTemp, activeRng);
      if (selected !== argmaxTopology) {
        explorationTriggered = true;
        this.explorationCount++;
        reasoning.push(
          `ε-greedy exploration (ε=${effectiveEpsilon}): chose ${selected} instead of argmax ${argmaxTopology} (score: ${argmaxScore})`,
        );
      }
    } else {
      selected = argmaxTopology;
    }

    reasoning.push(
      `Topology scores: ${scores
        .slice(0, 4)
        .map((s) => `${s.topology}=${s.score}`)
        .join(', ')}`,
    );
    if (!explorationTriggered) {
      reasoning.push(`Selected ${selected} (score: ${scores[0].score})`);
    }

    const costPerf = this.topologyPerformance[selected];
    const expectedCost = deliberation.estimatedTokens * COST_PER_TOKEN * costPerf.costMultiplier;

    const latencyMap: Record<OrchestrationTopology, string> = {
      SINGLE: '< 5s',
      // Canonical (D3.2) — mirror the legacy alias latency bands so
      // canonical-name routing returns the same expected-latency text.
      CHAIN: '10-30s', // ← SEQUENTIAL
      DISPATCH: '15-45s', // ← PARALLEL
      ORCHESTRATOR: '30-120s', // ← HIERARCHICAL
      REVIEW: '30-120s', // ← EVALUATOR_OPTIMIZER
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

    // Allow tenant/provider-specific benchmark calibration to override the
    // static latency bands. Calibration is stored as observed p50 ms in
    // LearnedWeights coordination weights and formatted back into bands.
    const observedLatencyMap: Record<OrchestrationTopology, string> = { ...latencyMap };
    for (const topology of Object.keys(latencyMap) as OrchestrationTopology[]) {
      const observedMs = this.learnedWeights.getCoordinationWeight(
        `latency_band_ms_${topology}`,
        deliberation.taskType,
        0,
        _tenantId,
      );
      if (observedMs > 0) {
        observedLatencyMap[topology] = formatLatencyBand(observedMs);
      }
    }

    // Compute coordination decision
    const coordination = evaluateCoordinationPolicy(
      deliberation,
      selected,
      dag,
      this.learnedWeights,
      _tenantId,
    );
    reasoning.push(`Coordination ROI: ${coordination.gain.netRoi.toFixed(3)}`);

    return {
      topology: selected,
      reasoning,
      expectedCost,
      expectedLatency: observedLatencyMap[selected],
      explorationTriggered,
      epsilonUsed: effectiveEpsilon,
      argmaxTopology,
      coordination,
      biasedScores: scores,
      adjustedWeights: adjustedWeightsResult,
    };
  }

  /**
   * Return exploration statistics (routing count, exploration count, rate).
   */
  getExplorationStats(): ExplorationStats {
    return {
      routingCount: this.routingCount,
      explorationCount: this.explorationCount,
      explorationRate: this.routingCount > 0 ? this.explorationCount / this.routingCount : 0,
    };
  }

  /**
   * Reset exploration counters without affecting pheromone or learned weight state.
   */
  resetExplorationCounters(): void {
    this.routingCount = 0;
    this.explorationCount = 0;
  }

  /**
   * Build a TaskDAG from nodes and edges, with cycle detection.
   *
   * Throws on cyclic task graphs — a task DAG with cycles is a logic bug
   * that would silently produce incorrect critical-path / parallelism metrics.
   * Surface it instead of returning garbage.
   */
  buildDAG(nodes: TaskDAGNode[], edges: TaskDAGEdge[]): TaskDAG {
    this.assertAcyclic(nodes, edges);
    const nodeSet = new Set(nodes.map((n) => n.id));

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

    const couplingEdges = edges.filter((e) => e.dataDependency);
    const interSubtaskCoupling =
      edges.length > 0 ? Math.min(1, couplingEdges.length / edges.length) : 0;

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
      for (const neighbor of adjList.get(current) ?? []) {
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
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    for (const n of nodes) color.set(n.id, WHITE);
    const adjList = new Map<string, string[]>();
    for (const n of nodes) adjList.set(n.id, []);
    for (const e of edges) {
      if (adjList.has(e.from) && adjList.has(e.to)) {
        adjList.get(e.from)!.push(e.to);
      }
    }
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const path: string[] = [];
    const visit = (nodeId: string): void => {
      const c = color.get(nodeId) ?? WHITE;
      if (c === BLACK) return;
      if (c === GRAY) {
        const startIdx = path.indexOf(nodeId);
        const cycleOnly = path.slice(startIdx);
        const named = cycleOnly.map((id) => nodeMap.get(id)?.label ?? id).join(' → ');
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

  /**
   * Resolve the effective epsilon for a given tenant.
   * Priority: per-tenant override (via `epsilonStore`) > constructor default.
   */
  private resolveEpsilon(tenantId?: string): number {
    if (this.epsilonStore && tenantId) {
      const stored = this.epsilonStore.get(tenantId);
      if (stored) return stored.epsilon;
    }
    return this.epsilon;
  }
}

/**
 * Boltzmann (softmax) draw over scored candidates.
 * Higher temperature → more uniform distribution.
 * Lower temperature → concentrates probability on top-scored candidates.
 */
function boltzmannDraw(
  scores: Array<{ topology: OrchestrationTopology; score: number }>,
  temperature: number,
  rng: () => number,
): OrchestrationTopology {
  const maxScore = Math.max(...scores.map((s) => s.score));
  const shifted = scores.map((s) => Math.exp((s.score - maxScore) / Math.max(temperature, 0.001)));
  const sum = shifted.reduce((a, b) => a + b, 0);
  const target = rng() * sum;
  let cumulative = 0;
  for (let i = 0; i < shifted.length; i++) {
    cumulative += shifted[i];
    if (target <= cumulative) return scores[i].topology;
  }
  return scores[scores.length - 1].topology;
}

function formatLatencyBand(ms: number): string {
  if (ms < 5000) return '< 5s';
  if (ms < 15000) return '5-15s';
  if (ms < 30000) return '10-30s';
  if (ms < 60000) return '30-60s';
  if (ms < 120000) return '30-120s';
  if (ms < 300000) return '1-5min';
  return '> 5min';
}
