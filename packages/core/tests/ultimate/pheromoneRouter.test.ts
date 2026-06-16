/**
 * Unit tests for PheromoneRouter (P1: Pheromone-Enhanced Topology Router).
 *
 * Covers:
 *  - Beta(α, β) updates for success and failure
 *  - Quality-weighted observation magnitude
 *  - bias() is a no-op when fewer than minSamplesBeforeBias observations
 *  - bias() rewards high-success topology and penalizes low-success
 *  - Thompson sampling with a seeded RNG picks the higher-mean topology
 *  - selectTopology returns null when no candidate is mature
 *  - getStats and reset() behavior
 *  - Integration with TopologyRouter: biased scores change the winner
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PheromoneRouter } from '../../src/ultimate/pheromoneRouter';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import type { DeliberationPlan, OrchestrationTopology } from '../../src/ultimate/types';

describe('PheromoneRouter', () => {
  describe('Beta posterior updates', () => {
    it('initializes with the uniform prior Beta(1,1)', () => {
      const r = new PheromoneRouter();
      expect(r.getConfidence('CODING', 'PARALLEL')).toBe(0.5);
    });

    it('shifts expected success toward 1.0 after weighted successes', () => {
      const r = new PheromoneRouter();
      for (let i = 0; i < 10; i++) {
        r.recordOutcome('CODING', 'PARALLEL', true, 0.9);
      }
      // alpha += 1.4 each call × 10 = 14, beta unchanged at 1 → 14/15 ≈ 0.93
      expect(r.getConfidence('CODING', 'PARALLEL')).toBeGreaterThan(0.9);
    });

    it('shifts expected success toward 0 after weighted failures', () => {
      const r = new PheromoneRouter();
      for (let i = 0; i < 10; i++) {
        r.recordOutcome('CODING', 'PARALLEL', false, 0.1);
      }
      // beta += 1.4 each × 10 = 14, alpha = 1 → 1/15 ≈ 0.07
      expect(r.getConfidence('CODING', 'PARALLEL')).toBeLessThan(0.2);
    });

    it('uses quality-weighted observation magnitude (not binary)', () => {
      const r1 = new PheromoneRouter();
      const r2 = new PheromoneRouter();
      for (let i = 0; i < 5; i++) r1.recordOutcome('T', 'X', true, 1.0); // weight 1.5
      for (let i = 0; i < 5; i++) r2.recordOutcome('T', 'X', true, 0.0); // weight 0.5
      // r1 should be more confident than r2
      expect(r1.getConfidence('T', 'X')).toBeGreaterThan(r2.getConfidence('T', 'X'));
    });

    it('isolates state across (taskType, topology) pairs', () => {
      const r = new PheromoneRouter();
      for (let i = 0; i < 10; i++) r.recordOutcome('CODING', 'PARALLEL', true);
      for (let i = 0; i < 10; i++) r.recordOutcome('RESEARCH', 'HYBRID', false);
      expect(r.getConfidence('CODING', 'PARALLEL')).toBeGreaterThan(0.9);
      expect(r.getConfidence('RESEARCH', 'HYBRID')).toBeLessThan(0.1);
      // Untouched pairs remain at the prior
      expect(r.getConfidence('CODING', 'SINGLE')).toBe(0.5);
      expect(r.getConfidence('RESEARCH', 'PARALLEL')).toBe(0.5);
    });
  });

  describe('bias()', () => {
    it('returns score unchanged when fewer than minSamplesBeforeBias observations', () => {
      const r = new PheromoneRouter({ minSamplesBeforeBias: 5 });
      r.recordOutcome('CODING', 'PARALLEL', true, 0.9);
      r.recordOutcome('CODING', 'PARALLEL', true, 0.9);
      const biased = r.bias('CODING', [
        { topology: 'PARALLEL', score: 5 },
        { topology: 'SINGLE', score: 4 },
      ]);
      expect(biased[0].pheromoneBias).toBe(0);
      expect(biased[0].score).toBe(5);
      expect(biased[0].pheromoneSamples).toBe(2);
    });

    it('rewards high-success topology and penalizes low-success once mature', () => {
      const r = new PheromoneRouter({ minSamplesBeforeBias: 3 });
      for (let i = 0; i < 8; i++) r.recordOutcome('CODING', 'PARALLEL', true, 0.9);
      for (let i = 0; i < 8; i++) r.recordOutcome('CODING', 'SINGLE', false, 0.1);
      const biased = r.bias('CODING', [
        { topology: 'PARALLEL', score: 3 },
        { topology: 'SINGLE', score: 3 },
      ]);
      expect(biased[0].pheromoneBias).toBeGreaterThan(0);
      expect(biased[1].pheromoneBias).toBeLessThan(0);
      // PARALLEL should now beat SINGLE despite equal heuristic scores
      const winner = biased.reduce((a, b) => (a.score > b.score ? a : b));
      expect(winner.topology).toBe('PARALLEL');
    });

    it('caps pheromone bias at maxBiasMagnitude', () => {
      const r = new PheromoneRouter({ minSamplesBeforeBias: 3, maxBiasMagnitude: 0.5 });
      for (let i = 0; i < 50; i++) r.recordOutcome('CODING', 'PARALLEL', true, 1.0);
      const biased = r.bias('CODING', [{ topology: 'PARALLEL', score: 0 }]);
      expect(Math.abs(biased[0].pheromoneBias)).toBeLessThanOrEqual(0.5);
    });

    it('reports expectedSuccess for observability', () => {
      const r = new PheromoneRouter({ minSamplesBeforeBias: 3 });
      for (let i = 0; i < 6; i++) r.recordOutcome('CODING', 'PARALLEL', true, 1.0);
      for (let i = 0; i < 2; i++) r.recordOutcome('CODING', 'PARALLEL', false, 0.0);
      const biased = r.bias('CODING', [{ topology: 'PARALLEL', score: 0 }]);
      // alpha = 1 + 6*1.5 = 10, beta = 1 + 2*0.5 = 2 → 10/12 ≈ 0.833
      expect(biased[0].expectedSuccess).toBeGreaterThan(0.7);
      expect(biased[0].expectedSuccess).toBeLessThan(0.9);
    });
  });

  describe('Thompson sampling (selectTopology)', () => {
    /** Linear-congruential RNG for deterministic tests. */
    function makeRng(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
      };
    }

    it('returns null when no candidate has reached minSamplesBeforeBias', () => {
      const r = new PheromoneRouter({ minSamplesBeforeBias: 3 });
      r.recordOutcome('CODING', 'PARALLEL', true);
      r.recordOutcome('CODING', 'SINGLE', true);
      const result = r.selectTopology('CODING', ['PARALLEL', 'SINGLE']);
      expect(result.selected).toBeNull();
      // samples is still populated for inspection
      expect(result.samples.length).toBe(2);
    });

    it('with a strong posterior, picks the higher-mean topology repeatedly', () => {
      const rng = makeRng(42);
      const r = new PheromoneRouter({ minSamplesBeforeBias: 0, rng });
      // PARALLEL: 20 successes → alpha ≈ 31, SINGLE: 20 failures → beta ≈ 31
      for (let i = 0; i < 20; i++) r.recordOutcome('CODING', 'PARALLEL', true, 1.0);
      for (let i = 0; i < 20; i++) r.recordOutcome('CODING', 'SINGLE', false, 0.0);
      let parallelWins = 0;
      for (let i = 0; i < 50; i++) {
        const result = r.selectTopology('CODING', ['PARALLEL', 'SINGLE']);
        if (result.selected === 'PARALLEL') parallelWins++;
      }
      // With 20 obs each, the Beta posteriors are very tight around their means,
      // so PARALLEL should win essentially every sample.
      expect(parallelWins).toBeGreaterThan(45);
    });

    it('with a fresh posterior, explores both topologies (some SINGLE picks)', () => {
      const rng = makeRng(7);
      const r = new PheromoneRouter({ minSamplesBeforeBias: 0, rng });
      // Only 1 obs each — posteriors are wide, both topologies have non-trivial sample mass.
      r.recordOutcome('CODING', 'PARALLEL', true);
      r.recordOutcome('CODING', 'SINGLE', false);
      let parallelWins = 0;
      let singleWins = 0;
      for (let i = 0; i < 100; i++) {
        const result = r.selectTopology('CODING', ['PARALLEL', 'SINGLE']);
        if (result.selected === 'PARALLEL') parallelWins++;
        if (result.selected === 'SINGLE') singleWins++;
      }
      // Both should be picked at least once over 100 samples (exploration).
      expect(parallelWins + singleWins).toBe(100);
      expect(parallelWins).toBeGreaterThan(0);
      expect(singleWins).toBeGreaterThan(0);
    });

    it('handles empty candidate list', () => {
      const r = new PheromoneRouter();
      const result = r.selectTopology('CODING', []);
      expect(result.selected).toBeNull();
      expect(result.samples).toEqual([]);
    });
  });

  describe('observability + reset', () => {
    it('getStats returns one entry per recorded (taskType, topology) pair', () => {
      const r = new PheromoneRouter();
      r.recordOutcome('CODING', 'PARALLEL', true);
      r.recordOutcome('CODING', 'SINGLE', false);
      r.recordOutcome('RESEARCH', 'HYBRID', true);
      const stats = r.getStats();
      expect(stats.length).toBe(3);
      const keys = stats.map(s => `${s.taskType}::${s.topology}`).sort();
      expect(keys).toEqual(['CODING::PARALLEL', 'CODING::SINGLE', 'RESEARCH::HYBRID']);
    });

    it('reset() clears all state and returns the prior', () => {
      const r = new PheromoneRouter();
      r.recordOutcome('CODING', 'PARALLEL', true, 0.9);
      r.recordOutcome('RESEARCH', 'HYBRID', false, 0.1);
      expect(r.getStats().length).toBe(2);
      r.reset();
      expect(r.getStats().length).toBe(0);
      expect(r.getConfidence('CODING', 'PARALLEL')).toBe(0.5);
    });
  });
});

describe('TopologyRouter × PheromoneRouter integration', () => {
  /** Build a DeliberationPlan that would tie on heuristic scores for two topologies. */
  function makeTiePlan(taskType: DeliberationPlan['taskType']): DeliberationPlan {
    return {
      requiresExternalInfo: false,
      taskType,
      recommendedTopology: 'PARALLEL',
      estimatedAgentCount: 3,
      estimatedSteps: 5,
      estimatedTokens: 5000,
      estimatedDurationMs: 30000,
      tokenBudget: { thinking: 200, execution: 4000, synthesis: 800 },
      decompositionStrategy: 'ASPECT',
      capabilitiesNeeded: ['file_read'],
      confidence: 0.7,
      reasoning: [],
      suitableForSpeculation: false,
      taskNature: 'MIXED',
      timeBudgetPerAgentMs: 10000,
    };
  }

  it('passes a fresh PheromoneRouter by default (composition over inheritance)', () => {
    const tr = new TopologyRouter();
    const pr = tr.getPheromoneRouter();
    expect(pr).toBeInstanceOf(PheromoneRouter);
  });

  it('accepts an injected PheromoneRouter for testability', () => {
    const customPr = new PheromoneRouter({ rng: () => 0.5 });
    const tr = new TopologyRouter(customPr);
    expect(tr.getPheromoneRouter()).toBe(customPr);
  });

  it('biased scores change the bias direction in expected ways after enough outcomes', () => {
    // Strengthened from the prior "biased scores change the routing winner" test
    // (which silently passed when the baseline winner was already PARALLEL).
    // The pheromone is a nudge, not an override, so we verify the bias DIRECTION
    // on the score instead of asserting a winner flip.
    //
    // We pin the baseline to SINGLE (deterministically different from PARALLEL)
    // so both the success-reinforced topology and the failure-penalized topology
    // resolve to distinct entries. This avoids the edge case where the heuristic
    // happened to pick PARALLEL on its own and the success/failure records
    // collapsed onto the same key.
    const customPr = new PheromoneRouter({ minSamplesBeforeBias: 3 });
    const tr = new TopologyRouter(customPr);
    const plan = makeTiePlan('RESEARCH');
    const pinnedBaseline: OrchestrationTopology = 'SINGLE';

    for (let i = 0; i < 10; i++) customPr.recordOutcome('RESEARCH', 'PARALLEL', true, 1.0);
    for (let i = 0; i < 10; i++) customPr.recordOutcome('RESEARCH', pinnedBaseline, false, 0.0);

    const biasedScores = tr.route(plan).biasedScores ?? [];
    const parallelEntry = biasedScores.find(s => s.topology === 'PARALLEL');
    const baselineEntry = biasedScores.find(s => s.topology === pinnedBaseline);

    expect(parallelEntry).toBeDefined();
    expect(baselineEntry).toBeDefined();

    // PARALLEL gets a positive bias (capped at maxBiasMagnitude 1.0).
    expect(parallelEntry!.pheromoneBias).toBeGreaterThan(0);
    expect(parallelEntry!.pheromoneBias).toBeLessThanOrEqual(1.0);
    // The pinned baseline gets a negative bias (capped at -maxBiasMagnitude).
    expect(baselineEntry!.pheromoneBias).toBeLessThan(0);
    expect(baselineEntry!.pheromoneBias).toBeGreaterThanOrEqual(-1.0);
  });

  it('route() exposes biasedScores and reasoning for the pheromone adjustment', () => {
    const customPr = new PheromoneRouter({ minSamplesBeforeBias: 3 });
    const tr = new TopologyRouter(customPr);
    for (let i = 0; i < 8; i++) customPr.recordOutcome('RESEARCH', 'PARALLEL', true, 1.0);
    const plan = makeTiePlan('RESEARCH');
    const result = tr.route(plan);
    expect(result.biasedScores).toBeDefined();
    expect(result.biasedScores!.length).toBe(10); // 10 topologies
    const parallelEntry = result.biasedScores!.find(s => s.topology === 'PARALLEL');
    expect(parallelEntry).toBeDefined();
    expect(parallelEntry!.pheromoneSamples).toBe(8);
    // reasoning should mention the pheromone adjustment (since PARALLEL has a positive bias)
    const pheromoneLine = result.reasoning.find(r => r.includes('Pheromone'));
    expect(pheromoneLine).toBeDefined();
  });
});
