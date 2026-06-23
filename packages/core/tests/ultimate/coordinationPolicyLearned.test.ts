import { describe, it, expect } from 'vitest';
import { LearnedWeights } from '../../src/ultimate/learnedWeights';
import { evaluateCoordinationPolicy } from '../../src/ultimate/coordinationPolicy';
import type { DeliberationPlan } from '../../src/ultimate/types';

function plan(overrides: Partial<DeliberationPlan> = {}): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType: 'RESEARCH',
    recommendedTopology: 'PARALLEL',
    estimatedAgentCount: 3,
    estimatedSteps: 5,
    estimatedTokens: 5000,
    estimatedDurationMs: 30000,
    tokenBudget: { thinking: 200, execution: 4000, synthesis: 800 },
    decompositionStrategy: 'ASPECT',
    capabilitiesNeeded: ['web_search'],
    confidence: 0.7,
    reasoning: [],
    suitableForSpeculation: false,
    taskNature: 'IO_BOUND',
    timeBudgetPerAgentMs: 10000,
    ...overrides,
  };
}

describe('CoordinationPolicy learned weights', () => {
  describe('LearnedWeights coordination weight storage', () => {
    it('returns default when no weight recorded', () => {
      const lw = new LearnedWeights();
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.25)).toBe(0.25);
    });

    it('stores and retrieves a coordination weight', () => {
      const lw = new LearnedWeights();
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.4);
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.25)).toBeCloseTo(0.4, 5);
    });

    it('EMA-smooths successive recordings', () => {
      const lw = new LearnedWeights({ smoothingFactor: 0.5 });
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.8);
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.2);
      const val = lw.getCoordinationWeight('coupling', 'RESEARCH', 0.25);
      expect(val).toBeGreaterThan(0.2);
      expect(val).toBeLessThan(0.8);
    });

    it('isolates by tenant', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.9, 'tenantA');
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.1, 'tenantB');
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.5, 'tenantA')).toBeCloseTo(0.9, 5);
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.5, 'tenantB')).toBeCloseTo(0.1, 5);
    });

    it('reset clears all coordination weights', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.9);
      lw.resetCoordinationWeights();
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.5)).toBe(0.5);
    });

    it('reset by tenant only clears that tenant', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.9, 'tenantA');
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.1, 'tenantB');
      lw.resetCoordinationWeights('tenantA');
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.5, 'tenantA')).toBe(0.5);
      expect(lw.getCoordinationWeight('coupling', 'RESEARCH', 0.5, 'tenantB')).toBeCloseTo(0.1, 5);
    });
  });

  describe('evaluateCoordinationPolicy with learned weights', () => {
    it('uses hardcoded coupling when no learned weights provided', () => {
      const decision = evaluateCoordinationPolicy(plan(), 'PARALLEL');
      expect(decision.overhead.coupling).toBe(0.25);
    });

    it('uses learned coupling when learned weights provided', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.8);
      const decision = evaluateCoordinationPolicy(plan(), 'PARALLEL', undefined, lw);
      expect(decision.overhead.coupling).toBeCloseTo(0.8, 5);
    });

    it('uses learned breadth_gain in gain estimation', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordCoordinationWeight('breadth_gain', 'RESEARCH', 0.25);
      const decisionNoLearned = evaluateCoordinationPolicy(plan(), 'PARALLEL');
      const decisionLearned = evaluateCoordinationPolicy(plan(), 'PARALLEL', undefined, lw);
      expect(decisionLearned.gain.coverageGain).toBeGreaterThan(
        decisionNoLearned.gain.coverageGain,
      );
      expect(decisionLearned.gain.netRoi).toBeGreaterThan(decisionNoLearned.gain.netRoi);
    });

    it('falls back to hardcoded when no learned weight recorded', () => {
      const lw = new LearnedWeights();
      const decisionDefault = evaluateCoordinationPolicy(plan(), 'PARALLEL');
      const decisionWithLW = evaluateCoordinationPolicy(plan(), 'PARALLEL', undefined, lw);
      expect(decisionWithLW.overhead.coupling).toBe(decisionDefault.overhead.coupling);
    });

    it('includes dynamic evidence from learned topology history', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordSignal('RESEARCH', 'PARALLEL', true, undefined, 'tenantA');
      const decision = evaluateCoordinationPolicy(plan(), 'PARALLEL', undefined, lw, 'tenantA');
      expect(decision.evidence.some((e) => e.includes('Tenant history'))).toBe(true);
      expect(decision.evidence.some((e) => e.includes('PARALLEL'))).toBe(true);
    });

    it('includes dynamic evidence from learned coordination weights', () => {
      const lw = new LearnedWeights({ smoothingFactor: 1.0 });
      lw.recordCoordinationWeight('coupling', 'RESEARCH', 0.33, 'tenantA');
      lw.recordCoordinationWeight('roi_threshold', 'RESEARCH', 0.12, 'tenantA');
      const decision = evaluateCoordinationPolicy(plan(), 'PARALLEL', undefined, lw, 'tenantA');
      expect(decision.evidence.some((e) => e.includes('Learned coupling estimate'))).toBe(true);
      expect(decision.evidence.some((e) => e.includes('Learned ROI threshold'))).toBe(true);
    });

    it('omits dynamic evidence when no learned weights are provided', () => {
      const decision = evaluateCoordinationPolicy(plan(), 'PARALLEL');
      expect(decision.evidence.some((e) => e.includes('Tenant history'))).toBe(false);
      expect(decision.evidence.some((e) => e.includes('Learned coupling'))).toBe(false);
    });
  });
});
