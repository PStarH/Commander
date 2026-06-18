/**
 * Dynamic Topology Router - AdaptOrch-inspired topology selection.
 *
 * AdaptOrch research shows topology-aware orchestration achieves 12-23%
 * improvement over fixed-topology baselines. The router analyzes task
 * dependency DAGs and selects the optimal topology in O(|V|+|E|) time.
 */
import type { OrchestrationTopology, TaskDAG, TaskDAGNode, TaskDAGEdge, DeliberationPlan } from './types';
import { type CoordinationDecision } from './coordinationPolicy';
import { PheromoneRouter } from './pheromoneRouter';
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
export declare class TopologyRouter {
    /** ε-greedy exploration rate in [0, 1]. */
    private epsilon;
    /** Boltzmann temperature for exploration draws. */
    private readonly explorationTemperature;
    /** Random number generator (seeded for deterministic tests). */
    private readonly rng;
    /** Total routing calls made through this router. */
    private routingCount;
    /** Number of times the ε-greedy draw actually diverged from argmax. */
    private explorationCount;
    /** Pheromone router for experience-based score biasing. */
    private readonly pheromoneRouter;
    /** Learned weights for online meta-learning. */
    private readonly learnedWeights;
    /** Per-tenant epsilon override store. */
    private readonly epsilonStore?;
    constructor(pheromoneRouter?: PheromoneRouter, learnedWeights?: LearnedWeights, config?: EpsilonGreedyConfig & {
        epsilonStore?: import('./epsilonStore').EpsilonStore;
    });
    /** Expose the internal PheromoneRouter for tests and observability. */
    getPheromoneRouter(): PheromoneRouter;
    /** Expose the internal LearnedWeights for tests and observability. */
    getLearnedWeights(): LearnedWeights;
    private readonly topologyPerformance;
    route(deliberation: DeliberationPlan, dag?: TaskDAG, budgetConstraint?: {
        maxCostUsd: number;
        maxTokens: number;
    }, _tenantId?: string, perCallConfig?: EpsilonGreedyConfig): {
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
            pheromoneBias: number;
            pheromoneSamples: number;
            expectedSuccess: number;
        }>;
        adjustedWeights?: {
            adjusted: TypeWeights;
            adjustments: Record<string, number>;
            maturePairs: number;
        };
    };
    /**
     * Return exploration statistics (routing count, exploration count, rate).
     */
    getExplorationStats(): ExplorationStats;
    /**
     * Reset exploration counters without affecting pheromone or learned weight state.
     */
    resetExplorationCounters(): void;
    /**
     * Build a TaskDAG from nodes and edges, with cycle detection.
     *
     * Throws on cyclic task graphs — a task DAG with cycles is a logic bug
     * that would silently produce incorrect critical-path / parallelism metrics.
     * Surface it instead of returning garbage.
     */
    buildDAG(nodes: TaskDAGNode[], edges: TaskDAGEdge[]): TaskDAG;
    /**
     * Compute the maximum number of nodes that can execute simultaneously
     * (max width of any topological level). This is the true parallelism width.
     */
    private computeMaxLevelWidth;
    private calculateCriticalPath;
    private assertAcyclic;
    private classifyEffort;
    /**
     * Resolve the effective epsilon for a given tenant.
     * Priority: per-tenant override > constructor default.
     */
    private resolveEpsilon;
}
//# sourceMappingURL=topologyRouter.d.ts.map