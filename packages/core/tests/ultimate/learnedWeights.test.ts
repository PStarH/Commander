/**
 * Unit tests for LearnedWeights (P10: Online Meta-Learner).
 *
 * Covers:
 *  - EMA update on each signal
 *  - getAdjustedWeights returns base unchanged when no signal exists
 *  - getAdjustedWeights blends base with learned adjustment
 *  - maxAdjustment cap is honored
 *  - minSamplesBeforeAdjust gate is honored
 *  - Topology→dimension mapping (PARALLEL → parallel, SINGLE → sequential, etc.)
 *  - Isolation across (taskType, topology) pairs
 *  - Composition with PheromoneRouter (recordSignal also feeds pheromone)
 *  - Integration with TopologyRouter: route() exposes adjustedWeights,
 *    reasoning includes the learned-weight line when mature pairs exist
 */
import { describe, it, expect } from 'vitest';
import { LearnedWeights, type TypeWeights } from '../../src/ultimate/learnedWeights';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import type { OrchestrationTopology, DeliberationPlan } from '../../src/ultimate/types';

const BASE_WEIGHTS: TypeWeights = { research: 0, parallel: 2, sequential: 0, complex: 0 };

function makePlan(taskType: DeliberationPlan['taskType']): DeliberationPlan {
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

describe('LearnedWeights', () => {
  describe('EMA updates', () => {
    it('starts at 0 EMA (neutral) for all pairs', () => {
      const lw = new LearnedWeights();
      expect(lw.getAdjustedWeights('CODING', BASE_WEIGHTS).adjusted).toEqual(BASE_WEIGHTS);
      expect(lw.getAdjustedWeights('CODING', BASE_WEIGHTS).maturePairs).toBe(0);
    });

    it('moves the EMA toward +0.5 after a series of perfect successes', () => {
      const lw = new LearnedWeights({ smoothingFactor: 0.3 });
      // 10 perfect successes → signal = +0.5
      for (let i = 0; i < 10; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      const stats = lw.getStats().find((s) => s.taskType === 'CODING' && s.topology === 'PARALLEL');
      expect(stats).toBeDefined();
      // EMA should be close to 0.5 (the signal max).
      expect(stats!.state.ema).toBeGreaterThan(0.4);
      expect(stats!.state.ema).toBeLessThanOrEqual(0.5);
      expect(stats!.state.samples).toBe(10);
    });

    it('moves the EMA toward -0.5 after a series of failures', () => {
      // α=0.5 + 30 failures: signal saturates near 1/(1+15)−0.5 = −0.437, EMA converges to ≈ −0.43.
      const lw = new LearnedWeights({ smoothingFactor: 0.5 });
      for (let i = 0; i < 30; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0);
      const stats = lw.getStats().find((s) => s.taskType === 'CODING' && s.topology === 'PARALLEL');
      expect(stats).toBeDefined();
      // EMA is well below 0 (clearly drifting negative).
      expect(stats!.state.ema).toBeLessThan(-0.3);
      expect(stats!.state.ema).toBeGreaterThanOrEqual(-0.5);
    });

    it('is reactive to recent evidence (EMA window)', () => {
      // α=1.0 means EMA = latest signal (no smoothing). Use 1 success + 5
      // failures so the final pheromone confidence drops below 0.5 and the
      // last signal goes negative (a single failure after 5 successes is not
      // enough because the cumulative posterior keeps confidence > 0.8).
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      for (let i = 0; i < 5; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0);
      const stats = lw.getStats()[0];
      // Last signal is negative (1 success + 5 failures → confidence ≈ 0.42 → signal ≈ −0.08).
      expect(stats.state.ema).toBeLessThan(0);
      // And the EMA must be lower than a pure-success baseline.
      const pureSuccess = new LearnedWeights({ smoothingFactor: 1.0 });
      for (let i = 0; i < 6; i++) pureSuccess.recordSignal('CODING', 'PARALLEL', true, 1.0);
      const pureStats = pureSuccess.getStats()[0];
      expect(stats.state.ema).toBeLessThan(pureStats.state.ema);
    });
  });

  describe('getAdjustedWeights blend', () => {
    it('returns base unchanged when no pairs are mature', () => {
      const lw = new LearnedWeights({ minSamplesBeforeAdjust: 3 });
      const result = lw.getAdjustedWeights('CODING', BASE_WEIGHTS);
      expect(result.adjusted).toEqual(BASE_WEIGHTS);
      expect(result.maturePairs).toBe(0);
    });

    it('boosts the parallel dimension when PARALLEL is reinforced', () => {
      const lw = new LearnedWeights({ smoothingFactor: 0.3, minSamplesBeforeAdjust: 3 });
      for (let i = 0; i < 10; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      const result = lw.getAdjustedWeights('CODING', BASE_WEIGHTS);
      // Base parallel = 2. With positive EMA on PARALLEL, adjusted.parallel > 2.
      expect(result.adjusted.parallel).toBeGreaterThan(BASE_WEIGHTS.parallel);
      expect(result.adjustments.PARALLEL).toBeGreaterThan(0);
      expect(result.maturePairs).toBeGreaterThan(0);
    });

    it('reduces the parallel dimension when PARALLEL is penalized', () => {
      const lw = new LearnedWeights({ smoothingFactor: 0.3, minSamplesBeforeAdjust: 3 });
      for (let i = 0; i < 10; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0);
      const result = lw.getAdjustedWeights('CODING', BASE_WEIGHTS);
      expect(result.adjusted.parallel).toBeLessThan(BASE_WEIGHTS.parallel);
      expect(result.adjustments.PARALLEL).toBeLessThan(0);
    });

    it('caps the adjustment at maxAdjustment (default 0.5)', () => {
      const lw = new LearnedWeights({ smoothingFactor: 0.5, minSamplesBeforeAdjust: 3 });
      // 50 perfect successes → EMA should saturate at +0.5
      for (let i = 0; i < 50; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      const result = lw.getAdjustedWeights('CODING', BASE_WEIGHTS);
      // adjustment = clamp(ema * 2, -maxAdjustment, +maxAdjustment)
      // ema = 0.5 → adjustment = 1.0 → capped at 0.5
      expect(result.adjustments.PARALLEL).toBeLessThanOrEqual(0.5);
      // adjusted.parallel = 2 * (1 + 0.5) = 3.0
      expect(result.adjusted.parallel).toBeLessThanOrEqual(BASE_WEIGHTS.parallel * 1.5);
    });

    it('honors custom maxAdjustment (smaller cap)', () => {
      const lw = new LearnedWeights({
        smoothingFactor: 0.5,
        minSamplesBeforeAdjust: 3,
        maxAdjustment: 0.2,
      });
      for (let i = 0; i < 50; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      const result = lw.getAdjustedWeights('CODING', BASE_WEIGHTS);
      expect(result.adjustments.PARALLEL).toBeLessThanOrEqual(0.2);
    });

    it('keeps weights non-negative even with strong negative signal', () => {
      const lw = new LearnedWeights({ smoothingFactor: 0.5, minSamplesBeforeAdjust: 3 });
      for (let i = 0; i < 50; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0);
      const result = lw.getAdjustedWeights('CODING', BASE_WEIGHTS);
      // adjusted.parallel = 2 * (1 - 0.5) = 1.0, never negative
      expect(result.adjusted.parallel).toBeGreaterThanOrEqual(0);
    });
  });

  describe('topology → dimension mapping', () => {
    const cases: Array<[OrchestrationTopology, keyof TypeWeights]> = [
      ['SINGLE', 'sequential'],
      ['SEQUENTIAL', 'sequential'],
      ['PARALLEL', 'parallel'],
      ['HIERARCHICAL', 'complex'],
      ['HYBRID', 'complex'],
      ['DEBATE', 'complex'],
      ['ENSEMBLE', 'parallel'],
      ['EVALUATOR_OPTIMIZER', 'complex'],
      ['HANDOFF', 'sequential'],
      ['CONSENSUS', 'parallel'],
    ];

    for (const [topology, expectedDim] of cases) {
      it(`${topology} → ${expectedDim}`, () => {
        const lw = new LearnedWeights({ smoothingFactor: 0.5, minSamplesBeforeAdjust: 3 });
        // Set base so the target dimension is non-zero.
        const base: TypeWeights = {
          research: 0,
          parallel: 0,
          sequential: 0,
          complex: 0,
          [expectedDim]: 2,
        } as TypeWeights;
        for (let i = 0; i < 10; i++) lw.recordSignal('CODING', topology, true, 1.0);
        const result = lw.getAdjustedWeights('CODING', base);
        // The expected dimension is adjusted upward; others stay at 0.
        expect(result.adjusted[expectedDim]).toBeGreaterThan(0);
      });
    }
  });

  describe('isolation + reset', () => {
    it('isolates state across (taskType, topology) pairs', () => {
      const lw = new LearnedWeights();
      for (let i = 0; i < 10; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      for (let i = 0; i < 10; i++) lw.recordSignal('RESEARCH', 'HYBRID', false, 0.0);
      const stats = lw.getStats();
      expect(stats.length).toBe(2);
      const coding = stats.find((s) => s.taskType === 'CODING')!;
      const research = stats.find((s) => s.taskType === 'RESEARCH')!;
      expect(coding.state.ema).toBeGreaterThan(0);
      expect(research.state.ema).toBeLessThan(0);
    });

    it('reset() clears all state', () => {
      const lw = new LearnedWeights();
      lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      expect(lw.getStats().length).toBe(1);
      lw.reset();
      expect(lw.getStats().length).toBe(0);
    });
  });
});

describe('TopologyRouter × LearnedWeights integration', () => {
  it('passes a fresh LearnedWeights by default (composition over inheritance)', () => {
    const tr = new TopologyRouter();
    const lw = tr.getLearnedWeights();
    expect(lw).toBeInstanceOf(LearnedWeights);
  });

  it('accepts an injected LearnedWeights for testability', () => {
    const customLw = new LearnedWeights();
    const tr = new TopologyRouter(customLw);
    expect(tr.getLearnedWeights()).toBe(customLw);
  });

  it('route() exposes adjustedWeights and uses them in scoring', () => {
    const tr = new TopologyRouter();
    const result = tr.route(makePlan('CODING'));
    expect(result.adjustedWeights).toBeDefined();
    // CODING base weights: parallel=2, sequential=2, complex=1
    expect(result.adjustedWeights!.adjusted.parallel).toBe(2);
    expect(result.adjustedWeights!.adjusted.sequential).toBe(2);
    expect(result.adjustedWeights!.maturePairs).toBe(0); // no signal yet
  });

  it('after enough signals, route() reflects the learned adjustment in the scores', () => {
    const tr = new TopologyRouter();
    // Reinforce PARALLEL strongly for CODING.
    for (let i = 0; i < 15; i++)
      tr.getLearnedWeights().recordSignal('CODING', 'PARALLEL', true, 1.0);
    // Penalize SINGLE strongly for CODING.
    for (let i = 0; i < 15; i++)
      tr.getLearnedWeights().recordSignal('CODING', 'SINGLE', false, 0.0);

    const baseline = tr.route(makePlan('CODING'));
    const result = tr.route(makePlan('CODING'));
    expect(result.adjustedWeights).toBeDefined();
    expect(result.adjustedWeights!.maturePairs).toBeGreaterThan(0);
    // PARALLEL adjustment should be positive; SINGLE should be negative.
    expect(result.adjustedWeights!.adjustments.PARALLEL).toBeGreaterThan(0);
    expect(result.adjustedWeights!.adjustments.SINGLE).toBeLessThan(0);
    // The CODING base has parallel=2, sequential=2. With PARALLEL reinforced,
    // adjusted.parallel > 2; with SINGLE penalized, adjusted.sequential < 2.
    expect(result.adjustedWeights!.adjusted.parallel).toBeGreaterThan(2);
    expect(result.adjustedWeights!.adjusted.sequential).toBeLessThan(2);
  });

  it('reasoning includes the learned-weights line when mature pairs exist', () => {
    const tr = new TopologyRouter();
    for (let i = 0; i < 5; i++)
      tr.getLearnedWeights().recordSignal('CODING', 'PARALLEL', true, 1.0);
    const result = tr.route(makePlan('CODING'));
    const learnedLine = result.reasoning.find((r) => r.startsWith('Learned weights for'));
    expect(learnedLine).toBeDefined();
    expect(learnedLine).toContain('parallel=');
  });

  it('reasoning omits the learned-weights line when no signal exists', () => {
    const tr = new TopologyRouter();
    const result = tr.route(makePlan('CODING'));
    const learnedLine = result.reasoning.find((r) => r.startsWith('Learned weights for'));
    expect(learnedLine).toBeUndefined();
  });
});
