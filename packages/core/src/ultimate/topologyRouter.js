"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TopologyRouter = void 0;
const constants_1 = require("../config/constants");
const coordinationPolicy_1 = require("./coordinationPolicy");
const pheromoneRouter_1 = require("./pheromoneRouter");
const learnedWeights_1 = require("./learnedWeights");
/** Weight multipliers for task type scoring */
const TASK_TYPE_WEIGHTS = {
    RESEARCH: { research: 3, parallel: 2, sequential: 0, complex: 0 },
    ANALYSIS: { research: 3, parallel: 2, sequential: 0, complex: 0 },
    CODING: { research: 0, parallel: 2, sequential: 2, complex: 1 },
    REASONING: { research: 0, parallel: 0, sequential: 1, complex: 3 },
    CREATIVE: { research: 0, parallel: 2, sequential: 1, complex: 0 },
    FACTUAL: { research: 0, parallel: 0, sequential: 2, complex: 0 },
};
/** DAG metric thresholds for topology bonuses */
const DAG_THRESHOLDS = {
    HIGH_COUPLING: 0.7,
    HIGH_PARALLELISM: 3,
    DEEP_CRITICAL_PATH: 3,
};
/** Bonus scores for DAG-aware topology selection */
const DAG_BONUSES = {
    HIGH_COUPLING: { SEQUENTIAL: 3, SINGLE: 2 },
    HIGH_PARALLELISM: { PARALLEL: 2, HIERARCHICAL: 2, HYBRID: 1 },
    DEEP_CRITICAL_PATH: { HIERARCHICAL: 2, HYBRID: 1, SEQUENTIAL: 1 },
};
/** Effort level bonuses */
const EFFORT_BONUSES = {
    SIMPLE_SINGLE: 5,
    DEEP_RESEARCH_HYBRID: 3,
};
/** Task nature bonuses (Astraea-inspired) */
const TASK_NATURE_BONUSES = {
    IO_BOUND: { PARALLEL: 3, HYBRID: 2, HIERARCHICAL: 1 },
    COMPUTE_BOUND: { SEQUENTIAL: 2, DEBATE: 1 },
};
/** Speculation bonuses (SPAgent-inspired) */
const SPECULATION_BONUSES = { PARALLEL: 2, ENSEMBLE: 1 };
/** Cost penalty for exceeding budget */
const BUDGET_PENALTY = 5;
class TopologyRouter {
    constructor(pheromoneRouter, learnedWeights, config) {
        var _a, _b, _c;
        /** Total routing calls made through this router. */
        this.routingCount = 0;
        /** Number of times the ε-greedy draw actually diverged from argmax. */
        this.explorationCount = 0;
        this.topologyPerformance = {
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
        };
        const rawEpsilon = (_a = config === null || config === void 0 ? void 0 : config.epsilon) !== null && _a !== void 0 ? _a : 0;
        this.epsilon = Number.isNaN(rawEpsilon) ? 0 : Math.max(0, Math.min(1, rawEpsilon));
        this.explorationTemperature = (_b = config === null || config === void 0 ? void 0 : config.explorationTemperature) !== null && _b !== void 0 ? _b : 1.0;
        this.rng = (_c = config === null || config === void 0 ? void 0 : config.rng) !== null && _c !== void 0 ? _c : Math.random;
        this.epsilonStore = config === null || config === void 0 ? void 0 : config.epsilonStore;
        // Create or store pheromone router
        this.pheromoneRouter = pheromoneRouter !== null && pheromoneRouter !== void 0 ? pheromoneRouter : new pheromoneRouter_1.PheromoneRouter();
        // Create or store learned weights (shares the pheromone router by default)
        this.learnedWeights = learnedWeights !== null && learnedWeights !== void 0 ? learnedWeights : new learnedWeights_1.LearnedWeights(this.pheromoneRouter);
    }
    /** Expose the internal PheromoneRouter for tests and observability. */
    getPheromoneRouter() {
        return this.pheromoneRouter;
    }
    /** Expose the internal LearnedWeights for tests and observability. */
    getLearnedWeights() {
        return this.learnedWeights;
    }
    route(deliberation, dag, budgetConstraint, _tenantId, perCallConfig) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        const reasoning = [];
        const dagMetrics = dag === null || dag === void 0 ? void 0 : dag.metadata;
        const taskType = deliberation.taskType;
        const effortLevel = this.classifyEffort(deliberation.estimatedAgentCount);
        // Resolve epsilon: per-call > per-tenant > constructor default
        const perCallEpsilon = perCallConfig === null || perCallConfig === void 0 ? void 0 : perCallConfig.epsilon;
        const effectiveEpsilon = perCallEpsilon !== undefined
            ? Number.isNaN(perCallEpsilon)
                ? 0.05
                : Math.max(0, Math.min(1, perCallEpsilon))
            : this.resolveEpsilon(_tenantId);
        const scores = [];
        const topologies = Object.keys(this.topologyPerformance);
        // Get adjusted weights from learned weights (may be boosted/penalized by experience)
        const baseWeights = (_a = TASK_TYPE_WEIGHTS[taskType]) !== null && _a !== void 0 ? _a : TASK_TYPE_WEIGHTS.FACTUAL;
        const adjustedWeightsResult = this.learnedWeights.getAdjustedWeights(taskType, baseWeights, _tenantId);
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
                        (_b = DAG_BONUSES.HIGH_COUPLING[topology]) !== null && _b !== void 0 ? _b : 0;
                }
                if (dagMetrics.parallelismWidth > DAG_THRESHOLDS.HIGH_PARALLELISM) {
                    score +=
                        (_c = DAG_BONUSES.HIGH_PARALLELISM[topology]) !== null && _c !== void 0 ? _c : 0;
                }
                if (dagMetrics.criticalPathDepth > DAG_THRESHOLDS.DEEP_CRITICAL_PATH) {
                    score +=
                        (_d = DAG_BONUSES.DEEP_CRITICAL_PATH[topology]) !== null && _d !== void 0 ? _d : 0;
                }
            }
            // Effort level bonuses
            if (effortLevel === 'SIMPLE' && topology === 'SINGLE')
                score += EFFORT_BONUSES.SIMPLE_SINGLE;
            if (effortLevel === 'DEEP_RESEARCH' && topology === 'HYBRID')
                score += EFFORT_BONUSES.DEEP_RESEARCH_HYBRID;
            // Astraea-inspired: IO-bound tasks benefit more from parallelism
            if (deliberation.taskNature === 'IO_BOUND') {
                score +=
                    (_e = TASK_NATURE_BONUSES.IO_BOUND[topology]) !== null && _e !== void 0 ? _e : 0;
            }
            // Compute-bound tasks benefit from sequential/debate for deep reasoning
            if (deliberation.taskNature === 'COMPUTE_BOUND') {
                score +=
                    (_f = TASK_NATURE_BONUSES.COMPUTE_BOUND[topology]) !== null && _f !== void 0 ? _f : 0;
            }
            // SPAgent-inspired: speculation-suitable tasks prefer faster topologies
            if (deliberation.suitableForSpeculation) {
                score += (_g = SPECULATION_BONUSES[topology]) !== null && _g !== void 0 ? _g : 0;
            }
            // Budget constraint penalty
            if (budgetConstraint) {
                const estimatedCost = deliberation.estimatedTokens * constants_1.COST_PER_TOKEN * perf.costMultiplier;
                if (estimatedCost > budgetConstraint.maxCostUsd) {
                    score -= BUDGET_PENALTY;
                }
            }
            scores.push({ topology, score });
        }
        // Apply pheromone biasing if there's enough data
        let biasedScores;
        try {
            const biased = this.pheromoneRouter.bias(taskType, scores);
            if (biased && biased.length > 0) {
                biasedScores = biased.map((b) => ({
                    topology: b.topology,
                    score: b.score,
                    pheromoneBias: b.pheromoneBias,
                    pheromoneSamples: b.pheromoneSamples,
                    expectedSuccess: b.expectedSuccess,
                }));
                // Apply the biased scores in place
                for (const b of biased) {
                    const existing = scores.find((s) => s.topology === b.topology);
                    if (existing)
                        existing.score = b.score;
                }
                const positiveCount = biased.filter((b) => b.pheromoneBias > 0).length;
                if (positiveCount > 0) {
                    reasoning.push(`Pheromone bias applied: ${positiveCount} topologies boosted`);
                }
            }
        }
        catch {
            // Pheromone bias is best-effort; if the router isn't ready, continue unscored
        }
        scores.sort((a, b) => b.score - a.score);
        const argmaxTopology = scores[0].topology;
        const argmaxScore = scores[0].score;
        // ε-greedy exploration: with probability epsilon, draw from a
        // Boltzmann distribution over the scored candidates instead of
        // always picking the argmax.
        const effectiveTemp = (_h = perCallConfig === null || perCallConfig === void 0 ? void 0 : perCallConfig.explorationTemperature) !== null && _h !== void 0 ? _h : this.explorationTemperature;
        const activeRng = (_j = perCallConfig === null || perCallConfig === void 0 ? void 0 : perCallConfig.rng) !== null && _j !== void 0 ? _j : this.rng;
        this.routingCount++;
        let selected;
        let explorationTriggered = false;
        // ε-greedy gate: only explore when there are at least 2 candidates
        if (effectiveEpsilon > 0 && scores.length > 1 && activeRng() < effectiveEpsilon) {
            // Boltzmann draw over all candidates
            selected = boltzmannDraw(scores, effectiveTemp, activeRng);
            if (selected !== argmaxTopology) {
                explorationTriggered = true;
                this.explorationCount++;
                reasoning.push(`ε-greedy exploration (ε=${effectiveEpsilon}): chose ${selected} instead of argmax ${argmaxTopology} (score: ${argmaxScore})`);
            }
        }
        else {
            selected = argmaxTopology;
        }
        reasoning.push(`Topology scores: ${scores
            .slice(0, 4)
            .map((s) => `${s.topology}=${s.score}`)
            .join(', ')}`);
        if (!explorationTriggered) {
            reasoning.push(`Selected ${selected} (score: ${scores[0].score})`);
        }
        const costPerf = this.topologyPerformance[selected];
        const expectedCost = deliberation.estimatedTokens * constants_1.COST_PER_TOKEN * costPerf.costMultiplier;
        const latencyMap = {
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
        // Compute coordination decision
        const coordination = (0, coordinationPolicy_1.evaluateCoordinationPolicy)(deliberation, selected, dag, this.learnedWeights, _tenantId);
        reasoning.push(`Coordination ROI: ${coordination.gain.netRoi.toFixed(3)}`);
        return {
            topology: selected,
            reasoning,
            expectedCost,
            expectedLatency: latencyMap[selected],
            explorationTriggered,
            epsilonUsed: effectiveEpsilon,
            argmaxTopology,
            coordination,
            biasedScores,
            adjustedWeights: adjustedWeightsResult,
        };
    }
    /**
     * Return exploration statistics (routing count, exploration count, rate).
     */
    getExplorationStats() {
        return {
            routingCount: this.routingCount,
            explorationCount: this.explorationCount,
            explorationRate: this.routingCount > 0 ? this.explorationCount / this.routingCount : 0,
        };
    }
    /**
     * Reset exploration counters without affecting pheromone or learned weight state.
     */
    resetExplorationCounters() {
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
    buildDAG(nodes, edges) {
        var _a, _b;
        this.assertAcyclic(nodes, edges);
        const nodeSet = new Set(nodes.map((n) => n.id));
        // Build adjacency list for topological sort
        const inDegree = new Map();
        const adjList = new Map();
        for (const node of nodes) {
            inDegree.set(node.id, 0);
            adjList.set(node.id, []);
        }
        for (const edge of edges) {
            if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
                inDegree.set(edge.to, ((_a = inDegree.get(edge.to)) !== null && _a !== void 0 ? _a : 0) + 1);
                (_b = adjList.get(edge.from)) === null || _b === void 0 ? void 0 : _b.push(edge.to);
            }
        }
        // Compute parallelism width: max nodes at any topological level
        const parallelismWidth = this.computeMaxLevelWidth(nodes, inDegree, adjList);
        const criticalPathDepth = this.calculateCriticalPath(nodes, edges);
        const couplingEdges = edges.filter((e) => e.dataDependency);
        const interSubtaskCoupling = edges.length > 0 ? Math.min(1, couplingEdges.length / edges.length) : 0;
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
    computeMaxLevelWidth(nodes, inDegree, adjList) {
        var _a, _b, _c, _d, _e, _f;
        const queue = [];
        const level = new Map();
        for (const node of nodes) {
            if (((_a = inDegree.get(node.id)) !== null && _a !== void 0 ? _a : 0) === 0) {
                queue.push(node.id);
                level.set(node.id, 0);
            }
        }
        let qIdx = 0;
        while (qIdx < queue.length) {
            const current = queue[qIdx++];
            const currentLevel = (_b = level.get(current)) !== null && _b !== void 0 ? _b : 0;
            for (const neighbor of (_c = adjList.get(current)) !== null && _c !== void 0 ? _c : []) {
                const newLevel = currentLevel + 1;
                const existing = (_d = level.get(neighbor)) !== null && _d !== void 0 ? _d : 0;
                level.set(neighbor, Math.max(existing, newLevel));
                const newDegree = ((_e = inDegree.get(neighbor)) !== null && _e !== void 0 ? _e : 1) - 1;
                inDegree.set(neighbor, newDegree);
                if (newDegree === 0) {
                    queue.push(neighbor);
                }
            }
        }
        // Count nodes per level, return max
        const levelCounts = new Map();
        for (const [, lvl] of level) {
            levelCounts.set(lvl, ((_f = levelCounts.get(lvl)) !== null && _f !== void 0 ? _f : 0) + 1);
        }
        let maxWidth = 0;
        for (const [, count] of levelCounts) {
            maxWidth = Math.max(maxWidth, count);
        }
        return maxWidth || 1;
    }
    calculateCriticalPath(nodes, edges) {
        var _a;
        const adjList = new Map();
        for (const node of nodes) {
            adjList.set(node.id, []);
        }
        for (const edge of edges) {
            (_a = adjList.get(edge.from)) === null || _a === void 0 ? void 0 : _a.push(edge.to);
        }
        const memo = new Map();
        const visiting = new Set();
        const dfs = (nodeId) => {
            var _a;
            if (memo.has(nodeId))
                return memo.get(nodeId);
            if (visiting.has(nodeId))
                return 0; // Cycle detected, break the loop
            visiting.add(nodeId);
            const neighbors = (_a = adjList.get(nodeId)) !== null && _a !== void 0 ? _a : [];
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
    assertAcyclic(nodes, edges) {
        var _a;
        const WHITE = 0, GRAY = 1, BLACK = 2;
        const color = new Map();
        for (const n of nodes)
            color.set(n.id, WHITE);
        const adjList = new Map();
        for (const n of nodes)
            adjList.set(n.id, []);
        for (const e of edges) {
            if (adjList.has(e.from) && adjList.has(e.to)) {
                adjList.get(e.from).push(e.to);
            }
        }
        const nodeMap = new Map(nodes.map((n) => [n.id, n]));
        const path = [];
        const visit = (nodeId) => {
            var _a, _b;
            const c = (_a = color.get(nodeId)) !== null && _a !== void 0 ? _a : WHITE;
            if (c === BLACK)
                return;
            if (c === GRAY) {
                const startIdx = path.indexOf(nodeId);
                const cycleOnly = path.slice(startIdx);
                const named = cycleOnly.map((id) => { var _a, _b; return (_b = (_a = nodeMap.get(id)) === null || _a === void 0 ? void 0 : _a.label) !== null && _b !== void 0 ? _b : id; }).join(' → ');
                throw new Error(`TopologyRouter.buildDAG: cyclic task graph detected (${named}). ` +
                    `Task DAGs must be acyclic — fix the dependency declarations.`);
            }
            color.set(nodeId, GRAY);
            path.push(nodeId);
            for (const neighbor of (_b = adjList.get(nodeId)) !== null && _b !== void 0 ? _b : []) {
                visit(neighbor);
            }
            path.pop();
            color.set(nodeId, BLACK);
        };
        for (const node of nodes) {
            if (((_a = color.get(node.id)) !== null && _a !== void 0 ? _a : WHITE) === WHITE)
                visit(node.id);
        }
    }
    classifyEffort(estimatedAgentCount) {
        if (estimatedAgentCount <= 1)
            return 'SIMPLE';
        if (estimatedAgentCount <= 4)
            return 'MODERATE';
        if (estimatedAgentCount <= 10)
            return 'COMPLEX';
        return 'DEEP_RESEARCH';
    }
    /**
     * Resolve the effective epsilon for a given tenant.
     * Priority: per-tenant override > constructor default.
     */
    resolveEpsilon(tenantId) {
        if (this.epsilonStore && tenantId) {
            const stored = this.epsilonStore.get(tenantId);
            if (stored)
                return stored.epsilon;
        }
        return this.epsilon;
    }
}
exports.TopologyRouter = TopologyRouter;
/**
 * Boltzmann (softmax) draw over scored candidates.
 * Higher temperature → more uniform distribution.
 * Lower temperature → concentrates probability on top-scored candidates.
 */
function boltzmannDraw(scores, temperature, rng) {
    const maxScore = Math.max(...scores.map((s) => s.score));
    const shifted = scores.map((s) => Math.exp((s.score - maxScore) / Math.max(temperature, 0.001)));
    const sum = shifted.reduce((a, b) => a + b, 0);
    const target = rng() * sum;
    let cumulative = 0;
    for (let i = 0; i < shifted.length; i++) {
        cumulative += shifted[i];
        if (target <= cumulative)
            return scores[i].topology;
    }
    return scores[scores.length - 1].topology;
}
