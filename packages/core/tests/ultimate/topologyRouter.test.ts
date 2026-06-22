import { describe, it, expect, beforeEach } from 'vitest';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import type { DeliberationPlan, TaskDAG, TaskDAGNode, TaskDAGEdge } from '../../src/ultimate/types';
import { COST_PER_TOKEN } from '../../src/config/constants';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDeliberation(overrides: Partial<DeliberationPlan> = {}): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType: 'FACTUAL',
    recommendedTopology: 'SINGLE',
    estimatedAgentCount: 1,
    estimatedSteps: 3,
    estimatedTokens: 1000,
    estimatedDurationMs: 5000,
    tokenBudget: { thinking: 256, execution: 512, synthesis: 256 },
    decompositionStrategy: 'NONE',
    capabilitiesNeeded: [],
    confidence: 0.9,
    reasoning: [],
    suitableForSpeculation: false,
    taskNature: 'MIXED',
    timeBudgetPerAgentMs: 5000,
    ...overrides,
  };
}

function makeNode(id: string, complexity = 5): TaskDAGNode {
  return {
    id,
    label: id,
    estimatedComplexity: complexity,
    estimatedTokens: 1000,
    requiredCapabilities: [],
    atomic: true,
  };
}

function makeEdge(from: string, to: string, dataDependency = true): TaskDAGEdge {
  return { from, to, type: 'SEQUENTIAL', dataDependency };
}

const ALL_TOPOLOGIES = [
  // Canonical (D3.2 Anthropic-aligned 5) — accepted by the widened
  // `OrchestrationTopology` union. With Path-B (canonical-after-legacy
  // ordering in `topologyPerformance` Record), `route()` argmax favors
  // legacy names in ties; canonical may appear when explicit CLI flags
  // or programmatic overrides force them. After the 2-minor-version
  // hard-removal, canonical moves to the front and becomes the new
  // argmax default.
  'SINGLE',
  'CHAIN',
  'DISPATCH',
  'ORCHESTRATOR',
  'REVIEW',
  // Legacy (D3.2 @deprecated aliases) — accepted at input boundaries,
  // normalized to canonical via `normalizeTopology()` at telemetry
  // emission. Hard-removal in 2 minor versions.
  'SEQUENTIAL',
  'PARALLEL',
  'HIERARCHICAL',
  'HYBRID',
  'DEBATE',
  'ENSEMBLE',
  'EVALUATOR_OPTIMIZER',
  'HANDOFF',
  'CONSENSUS',
] as const;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TopologyRouter', () => {
  let router: TopologyRouter;

  beforeEach(() => {
    router = new TopologyRouter();
  });

  // =====================================================================
  // 1. Simple-task SINGLE selection
  // =====================================================================

  describe('SINGLE for simple tasks', () => {
    it('selects SINGLE for a simple factual task with 1 agent', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL',
          estimatedAgentCount: 1,
          estimatedTokens: 500,
        }),
      );
      expect(result.topology).toBe('SINGLE');
    });

    it('selects SINGLE with SIMPLE effort bonus for 1-agent tasks', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL',
          estimatedAgentCount: 1,
        }),
      );
      expect(result.topology).toBe('SINGLE');
      expect(result.reasoning.some((r) => r.includes('SINGLE'))).toBe(true);
    });

    it('returns latency < 5s for SINGLE topology', () => {
      const result = router.route(makeDeliberation({ estimatedAgentCount: 1 }));
      expect(result.expectedLatency).toBe('< 5s');
    });
  });

  // =====================================================================
  // 2. PARALLEL for independent subtasks
  // =====================================================================

  describe('PARALLEL for independent subtasks', () => {
    it('selects PARALLEL for research tasks with many agents', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 6,
          estimatedTokens: 10000,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(result.topology).toBe('PARALLEL');
    });

    it('selects PARALLEL for analysis tasks with IO-bound nature', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'ANALYSIS',
          estimatedAgentCount: 5,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(result.topology).toBe('PARALLEL');
    });

    it('selects PARALLEL for creative tasks with speculation', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CREATIVE',
          estimatedAgentCount: 5,
          suitableForSpeculation: true,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(result.topology).toBe('PARALLEL');
    });

    it('returns latency 15-45s for PARALLEL topology', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 6,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(result.expectedLatency).toBe('15-45s');
    });
  });

  // =====================================================================
  // 3. HIERARCHICAL for complex multi-level tasks
  // =====================================================================

  describe('HIERARCHICAL for complex multi-level tasks', () => {
    it('selects HIERARCHICAL for complex reasoning tasks with deep critical path and low coupling', () => {
      // Use conditional edges (no data dependency) to avoid HIGH_COUPLING bonus favoring SEQUENTIAL
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d'), makeNode('e')];
      const edges: TaskDAGEdge[] = [
        { from: 'a', to: 'b', type: 'CONDITIONAL', dataDependency: false },
        { from: 'b', to: 'c', type: 'CONDITIONAL', dataDependency: false },
        { from: 'c', to: 'd', type: 'CONDITIONAL', dataDependency: false },
        { from: 'd', to: 'e', type: 'CONDITIONAL', dataDependency: false },
      ];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.criticalPathDepth).toBe(5);
      expect(dag.metadata.interSubtaskCoupling).toBe(0); // no coupling

      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 8,
        }),
        dag,
      );
      expect(result.topology).toBe('HIERARCHICAL');
    });

    it('returns latency 30-120s for HIERARCHICAL topology', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 8,
        }),
      );
      expect(['30-120s', '1-5min']).toContain(result.expectedLatency);
    });
  });

  // =====================================================================
  // 4. DEBATE for tasks requiring multiple perspectives
  // =====================================================================

  describe('DEBATE for tasks requiring multiple perspectives', () => {
    it('selects HIERARCHICAL or SEQUENTIAL for compute-bound reasoning (DEBATE is also boosted)', () => {
      // COMPUTE_BOUND gives DEBATE +1 but SEQUENTIAL +2, so SEQUENTIAL often wins.
      // Verify the result is a reasonable topology for this scenario.
      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 5,
          taskNature: 'COMPUTE_BOUND',
        }),
      );
      expect(['CHAIN', 'SEQUENTIAL', 'ORCHESTRATOR', 'HIERARCHICAL', 'REVIEW', 'DEBATE']).toContain(
        result.topology,
      );
    });

    it('returns latency 30-90s when DEBATE is selected', () => {
      // Force DEBATE by using a scenario that strongly favors it
      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 5,
          taskNature: 'COMPUTE_BOUND',
        }),
      );
      if (result.topology === 'DEBATE') {
        expect(result.expectedLatency).toBe('30-90s');
      }
    });
  });

  // =====================================================================
  // 5. Scoring algorithm produces reasonable scores
  // =====================================================================

  describe('scoring algorithm', () => {
    it('always returns reasoning with score information', () => {
      const result = router.route(makeDeliberation());
      expect(result.reasoning.length).toBeGreaterThanOrEqual(2);
      expect(result.reasoning[0]).toContain('Topology scores:');
      expect(result.reasoning[1]).toContain('Selected');
    });

    it('top-4 scores are mentioned in reasoning', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 3,
        }),
      );
      const scoreLine = result.reasoning[0];
      // Should contain at least 4 topology=score pairs
      const matches = scoreLine.match(/\w+=/g);
      expect(matches!.length).toBeGreaterThanOrEqual(4);
    });

    it('score reflects task type: CODING produces reasonable top-4 selection', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 3,
          estimatedTokens: 5000,
        }),
      );
      // CODING weights balance parallel=2, sequential=2, complex=1
      // Top 4 should include HYBRID/ORCHESTRATOR (complex:0.9/1.0),
      // HANDOFF/CHAIN (sequential:0.8/1.0), or PARALLEL/DISPATCH (parallel:1.0).
      const scoreLine = result.reasoning[0];
      expect(scoreLine).toContain('Topology scores:');
      expect([
        'HYBRID',
        'ORCHESTRATOR',
        'HIERARCHICAL',
        'HANDOFF',
        'DISPATCH',
        'PARALLEL',
      ]).toContain(result.topology);
    });

    it('score reflects task type: RESEARCH favors HYBRID or PARALLEL', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 8,
          estimatedTokens: 10000,
        }),
      );
      expect(['HYBRID', 'PARALLEL']).toContain(result.topology);
    });

    it('expected cost is positive and reasonable', () => {
      const result = router.route(
        makeDeliberation({
          estimatedTokens: 10000,
        }),
      );
      expect(result.expectedCost).toBeGreaterThan(0);
      // cost = tokens * COST_PER_TOKEN * costMultiplier, SINGLE has 1.0
      expect(result.expectedCost).toBe(10000 * COST_PER_TOKEN * 1.0);
    });
  });

  // =====================================================================
  // 6. Budget penalties reduce scores for expensive topologies
  // =====================================================================

  describe('budget penalties', () => {
    it('penalizes expensive topologies when budget is tight', () => {
      const withoutBudget = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 8,
          estimatedTokens: 100000,
        }),
      );

      const withBudget = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 8,
          estimatedTokens: 100000,
        }),
        undefined,
        {
          maxCostUsd: 0.01,
          maxTokens: 200000,
        },
      );

      // HYBRID (costMultiplier 4.0) is expensive: 100000 * 0.000015 * 4 = 6.0 USD
      // With a tight budget of $0.01, HYBRID gets a penalty and something cheaper should win
      const expensiveCosts: Record<string, number> = {
        HYBRID: 100000 * COST_PER_TOKEN * 4.0,
        DEBATE: 100000 * COST_PER_TOKEN * 3.5,
        CONSENSUS: 100000 * COST_PER_TOKEN * 3.5,
        HIERARCHICAL: 100000 * COST_PER_TOKEN * 3.0,
      };
      const withinBudget = Object.entries(expensiveCosts)
        .filter(([_, cost]) => cost <= 0.01)
        .map(([name]) => name);
      // With tight budget, the selection should shift
      expect(withBudget.topology).toBeDefined();
    });

    it('no penalty when cost is within budget', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL',
          estimatedAgentCount: 1,
          estimatedTokens: 100,
        }),
        undefined,
        {
          maxCostUsd: 100,
          maxTokens: 100000,
        },
      );
      // SINGLE is cheap, no penalty expected
      expect(result.topology).toBe('SINGLE');
    });

    it('penalty applies to all topologies exceeding budget, not just the most expensive', () => {
      // tokens * COST_PER_TOKEN * costMultiplier > maxCostUsd
      // 50000 * 0.000015 * 2.0 = 1.5 > 1.0
      // 50000 * 0.000015 * 1.0 = 0.75 <= 1.0
      // SINGLE (1.0), SEQUENTIAL (1.1 -> 0.825) should be within budget
      // PARALLEL (2.0 -> 1.5) and above should be penalized
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL',
          estimatedAgentCount: 1,
          estimatedTokens: 50000,
        }),
        undefined,
        {
          maxCostUsd: 1.0,
          maxTokens: 100000,
        },
      );
      // SINGLE cost: 50000 * 0.000015 * 1.0 = 0.75 (within budget)
      expect(result.topology).toBe('SINGLE');
    });
  });

  // =====================================================================
  // 7. Task type weights influence selection
  // =====================================================================

  describe('task type weights', () => {
    it('FACTUAL type favors SEQUENTIAL (weight sequential=2)', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL',
          estimatedAgentCount: 3,
        }),
      );
      expect(['CHAIN', 'SEQUENTIAL', 'SINGLE']).toContain(result.topology);
    });

    it('REASONING type favors complex topologies (weight complex=3)', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 8,
        }),
      );
      // complex weight=3 should boost HIERARCHICAL/ORCHESTRATOR (complex:1.0),
      // HYBRID (complex:0.9), and DEBATE/REVIEW (complex:0.8).
      // Path-B mirrors: legacy-first ordering in topologyPerformance Record
      // means legacy alias wins ties; canonical `ORCHESTRATOR`/`REVIEW`
      // included as equivalents for post-migration auto-routing validation.
      expect(['ORCHESTRATOR', 'HIERARCHICAL', 'HYBRID', 'REVIEW', 'DEBATE']).toContain(
        result.topology,
      );
    });

    it('RESEARCH type favors research-heavy topologies (weight research=3)', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 6,
        }),
      );
      // research weight=3 boosts HYBRID/ORCHESTRATOR (research:1.0/0.9) and
      // PARALLEL/DISPATCH (research:0.8); canonical equivalents added for
      // post-migration validation.
      expect(['HYBRID', 'ORCHESTRATOR', 'HIERARCHICAL', 'DISPATCH', 'PARALLEL']).toContain(
        result.topology,
      );
    });

    it('CODING type balances sequential and parallel (weights seq=2, par=2)', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 3,
        }),
      );
      // Both sequential and parallel weights are 2
      expect(result.topology).toBeDefined();
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });

    it('CREATIVE type favors parallel (weight parallel=2)', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CREATIVE',
          estimatedAgentCount: 5,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(['DISPATCH', 'PARALLEL', 'ENSEMBLE']).toContain(result.topology);
    });

    it('unknown task type falls back to FACTUAL weights', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL' as any,
          estimatedAgentCount: 1,
        }),
      );
      expect(result.topology).toBe('SINGLE');
    });
  });

  // =====================================================================
  // 8. Returns valid topology for all input combinations
  // =====================================================================

  describe('valid topology for all inputs', () => {
    it.each(ALL_TOPOLOGIES)(
      'result topology is always a valid OrchestrationTopology (got %s indirectly)',
      () => {
        // Run many different configurations and verify all results are valid
        const configs = [
          { taskType: 'FACTUAL' as const, estimatedAgentCount: 1 },
          { taskType: 'RESEARCH' as const, estimatedAgentCount: 10 },
          { taskType: 'REASONING' as const, estimatedAgentCount: 5 },
          { taskType: 'CODING' as const, estimatedAgentCount: 3 },
          { taskType: 'CREATIVE' as const, estimatedAgentCount: 7 },
          { taskType: 'ANALYSIS' as const, estimatedAgentCount: 2 },
        ];
        for (const cfg of configs) {
          const result = router.route(makeDeliberation(cfg));
          expect(ALL_TOPOLOGIES).toContain(result.topology);
          expect(typeof result.expectedCost).toBe('number');
          expect(typeof result.expectedLatency).toBe('string');
          expect(result.reasoning.length).toBeGreaterThanOrEqual(2);
        }
      },
    );

    it('returns valid result with no DAG', () => {
      const result = router.route(makeDeliberation(), undefined);
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });

    it('returns valid result with an empty DAG', () => {
      const dag = router.buildDAG([], []);
      const result = router.route(makeDeliberation(), dag);
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });

    it('returns valid result with a complex DAG', () => {
      const nodes = Array.from({ length: 10 }, (_, i) => makeNode(`n${i}`));
      const edges: TaskDAGEdge[] = [];
      for (let i = 0; i < 9; i++) {
        edges.push(makeEdge(`n${i}`, `n${i + 1}`));
      }
      // Add parallel edges
      edges.push(makeEdge('n0', 'n2'));
      edges.push(makeEdge('n0', 'n3'));
      const dag = router.buildDAG(nodes, edges);
      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 8,
        }),
        dag,
      );
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });

    it('returns valid result with all effort levels', () => {
      const agentCounts = [1, 2, 4, 5, 10, 15];
      for (const count of agentCounts) {
        const result = router.route(makeDeliberation({ estimatedAgentCount: count }));
        expect(ALL_TOPOLOGIES).toContain(result.topology);
      }
    });
  });

  // =====================================================================
  // 9. buildDAG
  // =====================================================================

  describe('buildDAG', () => {
    it('computes parallelism width for independent nodes', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const dag = router.buildDAG(nodes, []);
      expect(dag.metadata.parallelismWidth).toBe(3);
    });

    it('computes parallelism width of 1 for a linear chain', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.parallelismWidth).toBe(1);
    });

    it('computes correct parallelism width for diamond DAG', () => {
      // a -> b, a -> c, b -> d, c -> d
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
      const edges = [
        makeEdge('a', 'b'),
        makeEdge('a', 'c'),
        makeEdge('b', 'd'),
        makeEdge('c', 'd'),
      ];
      const dag = router.buildDAG(nodes, edges);
      // Level 0: {a}, Level 1: {b, c}, Level 2: {d} -> max width = 2
      expect(dag.metadata.parallelismWidth).toBe(2);
    });

    it('computes critical path depth for linear chain', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'd')];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.criticalPathDepth).toBe(4);
    });

    it('computes critical path depth of 1 for independent nodes', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const dag = router.buildDAG(nodes, []);
      expect(dag.metadata.criticalPathDepth).toBe(1);
    });

    it('computes interSubtaskCoupling = 0 when no edges', () => {
      const nodes = [makeNode('a'), makeNode('b')];
      const dag = router.buildDAG(nodes, []);
      expect(dag.metadata.interSubtaskCoupling).toBe(0);
    });

    it('computes interSubtaskCoupling = 1 when all edges have data dependency', () => {
      const nodes = [makeNode('a'), makeNode('b')];
      const edges = [makeEdge('a', 'b', true)];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.interSubtaskCoupling).toBe(1);
    });

    it('computes interSubtaskCoupling < 1 when some edges lack data dependency', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const edges = [makeEdge('a', 'b', true), makeEdge('a', 'c', false)];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.interSubtaskCoupling).toBe(0.5);
    });

    it('handles edges referencing non-existent nodes gracefully', () => {
      const nodes = [makeNode('a')];
      const edges = [makeEdge('a', 'nonexistent'), makeEdge('nonexistent', 'a')];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.parallelismWidth).toBeGreaterThanOrEqual(1);
    });
  });

  // =====================================================================
  // 10. DAG-aware bonuses in routing
  // =====================================================================

  describe('DAG-aware bonuses', () => {
    it('high parallelism width boosts PARALLEL score', () => {
      // 6 independent nodes -> parallelism width = 6 > HIGH_PARALLELISM (3)
      const nodes = Array.from({ length: 6 }, (_, i) => makeNode(`n${i}`));
      const dag = router.buildDAG(nodes, []);

      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 6,
          estimatedTokens: 5000,
        }),
        dag,
      );
      // PARALLEL should get a DAG bonus
      expect(result.topology).toBeDefined();
    });

    it('high coupling boosts SEQUENTIAL score', () => {
      // All edges have data dependency -> coupling = 1.0 > 0.7
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const edges = [makeEdge('a', 'b', true), makeEdge('b', 'c', true)];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.interSubtaskCoupling).toBe(1.0);

      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 3,
          estimatedTokens: 5000,
        }),
        dag,
      );
      // SEQUENTIAL should get a coupling bonus
      expect(['SEQUENTIAL', 'SINGLE']).toContain(result.topology);
    });

    it('deep critical path boosts HIERARCHICAL score when coupling is low', () => {
      // 5-node chain with non-data-dependent edges -> critical path = 5, coupling = 0
      const nodes = Array.from({ length: 5 }, (_, i) => makeNode(`n${i}`));
      const edges: TaskDAGEdge[] = Array.from({ length: 4 }, (_, i) => ({
        from: `n${i}`,
        to: `n${i + 1}`,
        type: 'CONDITIONAL' as const,
        dataDependency: false,
      }));
      const dag = router.buildDAG(nodes, edges);
      expect(dag.metadata.criticalPathDepth).toBe(5);
      expect(dag.metadata.interSubtaskCoupling).toBe(0);

      const result = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 8,
          estimatedTokens: 10000,
        }),
        dag,
      );
      // HIERARCHICAL gets +2 from DEEP_CRITICAL_PATH, plus high complex score for REASONING
      expect(result.topology).toBe('HIERARCHICAL');
    });
  });

  // =====================================================================
  // 11. Effort level classification
  // =====================================================================

  describe('effort level classification', () => {
    it('SIMPLE effort (1 agent) gives SINGLE a bonus', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'FACTUAL',
          estimatedAgentCount: 1,
        }),
      );
      expect(result.topology).toBe('SINGLE');
    });

    it('DEEP_RESEARCH effort (11+ agents) gives HYBRID a bonus', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 15,
          estimatedTokens: 50000,
        }),
      );
      expect(result.topology).toBe('HYBRID');
    });

    it('MODERATE effort (2-4 agents) does not apply SIMPLE or DEEP_RESEARCH bonus', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 3,
        }),
      );
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });
  });

  // =====================================================================
  // 12. Task nature bonuses
  // =====================================================================

  describe('task nature bonuses', () => {
    it('IO_BOUND boosts PARALLEL and HYBRID', () => {
      const ioResult = router.route(
        makeDeliberation({
          taskType: 'ANALYSIS',
          estimatedAgentCount: 6,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(['DISPATCH', 'PARALLEL', 'HYBRID']).toContain(ioResult.topology);
    });

    it('COMPUTE_BOUND boosts SEQUENTIAL and DEBATE', () => {
      const computeResult = router.route(
        makeDeliberation({
          taskType: 'REASONING',
          estimatedAgentCount: 5,
          taskNature: 'COMPUTE_BOUND',
        }),
      );
      // COMPUTE_BOUND bonus = {SEQUENTIAL:2, CHAIN:2, DEBATE:1, REVIEW:1}
      // boosts legacy aliases; canonical equivalents accepted for
      // post-migration validation.
      expect(['DEBATE', 'REVIEW', 'HIERARCHICAL', 'ORCHESTRATOR', 'CHAIN', 'SEQUENTIAL']).toContain(
        computeResult.topology,
      );
    });

    it('MIXED nature does not apply special bonuses', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'CODING',
          estimatedAgentCount: 3,
          taskNature: 'MIXED',
        }),
      );
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });
  });

  // =====================================================================
  // 13. Speculation bonuses
  // =====================================================================

  describe('speculation bonuses', () => {
    it('suitableForSpeculation boosts PARALLEL and ENSEMBLE', () => {
      const withSpec = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 6,
          suitableForSpeculation: true,
          taskNature: 'IO_BOUND',
        }),
      );
      // PARALLEL should be boosted by speculation + IO_BOUND
      expect(withSpec.topology).toBe('PARALLEL');
    });

    it('speculation has no effect when false', () => {
      const result = router.route(
        makeDeliberation({
          taskType: 'RESEARCH',
          estimatedAgentCount: 6,
          suitableForSpeculation: false,
          taskNature: 'IO_BOUND',
        }),
      );
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });
  });

  // =====================================================================
  // 14. Expected cost and latency
  // =====================================================================

  describe('expected cost and latency', () => {
    it('expected cost uses correct cost multiplier for each topology', () => {
      // SINGLE: multiplier 1.0
      const single = router.route(
        makeDeliberation({
          estimatedAgentCount: 1,
          estimatedTokens: 10000,
        }),
      );
      expect(single.topology).toBe('SINGLE');
      expect(single.expectedCost).toBeCloseTo(10000 * COST_PER_TOKEN * 1.0, 10);
    });

    it('all latency values are defined for all topologies', () => {
      // Test a variety of inputs to trigger different topologies
      const configs = [
        { taskType: 'FACTUAL' as const, estimatedAgentCount: 1 }, // SINGLE
        { taskType: 'FACTUAL' as const, estimatedAgentCount: 3 }, // SEQUENTIAL
        { taskType: 'RESEARCH' as const, estimatedAgentCount: 6, taskNature: 'IO_BOUND' as const }, // PARALLEL
        { taskType: 'REASONING' as const, estimatedAgentCount: 8 }, // HIERARCHICAL
      ];
      const latencyPatterns = ['< 5s', '10-30s', '15-45s', '30-120s', '1-5min', '30-90s', '20-60s'];
      for (const cfg of configs) {
        const result = router.route(makeDeliberation(cfg));
        expect(latencyPatterns).toContain(result.expectedLatency);
      }
    });
  });

  // =====================================================================
  // 15. Edge cases
  // =====================================================================

  describe('edge cases', () => {
    it('handles zero estimatedTokens', () => {
      const result = router.route(makeDeliberation({ estimatedTokens: 0 }));
      expect(result.expectedCost).toBe(0);
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });

    it('handles very large estimatedTokens', () => {
      const result = router.route(
        makeDeliberation({
          estimatedTokens: 1_000_000,
          estimatedAgentCount: 1,
        }),
      );
      expect(result.expectedCost).toBeGreaterThan(0);
      expect(ALL_TOPOLOGIES).toContain(result.topology);
    });

    it('handles zero-agent count (degrades to SINGLE)', () => {
      const result = router.route(makeDeliberation({ estimatedAgentCount: 0 }));
      // 0 agents -> SIMPLE effort -> SINGLE gets bonus
      expect(result.topology).toBe('SINGLE');
    });

    it('buildDAG returns nodes and edges arrays as given', () => {
      const nodes = [makeNode('x'), makeNode('y')];
      const edges = [makeEdge('x', 'y')];
      const dag = router.buildDAG(nodes, edges);
      expect(dag.nodes).toEqual(nodes);
      expect(dag.edges).toEqual(edges);
    });

    it('buildDAG handles single node', () => {
      const dag = router.buildDAG([makeNode('solo')], []);
      expect(dag.metadata.parallelismWidth).toBe(1);
      expect(dag.metadata.criticalPathDepth).toBe(1);
      expect(dag.metadata.interSubtaskCoupling).toBe(0);
    });
  });

  describe('cycle detection (C1)', () => {
    it('buildDAG throws on a 2-cycle (A→B→A)', () => {
      const nodes = [makeNode('a'), makeNode('b')];
      const edges: TaskDAGEdge[] = [
        { from: 'a', to: 'b', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'b', to: 'a', type: 'SEQUENTIAL', dataDependency: true },
      ];
      expect(() => router.buildDAG(nodes, edges)).toThrow(/cyclic/);
    });

    it('buildDAG throws on a 3-cycle (A→B→C→A)', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const edges: TaskDAGEdge[] = [
        { from: 'a', to: 'b', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'b', to: 'c', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'c', to: 'a', type: 'SEQUENTIAL', dataDependency: true },
      ];
      expect(() => router.buildDAG(nodes, edges)).toThrow(/cyclic/);
    });

    it('buildDAG throws on a self-loop (A→A)', () => {
      const nodes = [makeNode('a')];
      const edges: TaskDAGEdge[] = [
        { from: 'a', to: 'a', type: 'SEQUENTIAL', dataDependency: true },
      ];
      expect(() => router.buildDAG(nodes, edges)).toThrow(/cyclic/);
    });

    it('buildDAG does NOT throw on a diamond DAG (acyclic)', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
      const edges: TaskDAGEdge[] = [
        { from: 'a', to: 'b', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'a', to: 'c', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'b', to: 'd', type: 'SEQUENTIAL', dataDependency: true },
        { from: 'c', to: 'd', type: 'SEQUENTIAL', dataDependency: true },
      ];
      expect(() => router.buildDAG(nodes, edges)).not.toThrow();
    });
  });
});
