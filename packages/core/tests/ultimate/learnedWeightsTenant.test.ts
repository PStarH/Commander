/**
 * Unit tests for P2 cross-tenant learned-weight isolation.
 *
 * Verifies that:
 *  - recordSignal with a tenantId never bleeds into another tenant's state
 *  - getAdjustedWeights scopes the blend to the requested tenant
 *  - DEFAULT_TENANT_ID absorbs un-scoped traffic so single-tenant
 *    deployments behave identically to P10
 *  - PheromoneRouter and LearnedWeights stay in sync (single source of truth)
 *  - listTenants / reset(tenantId) / size(tenantId) work for observability
 *  - Integration with TopologyRouter.route() passes tenantId through
 */
import { describe, it, expect } from 'vitest';
import { PheromoneRouter, DEFAULT_TENANT_ID } from '../../src/ultimate/pheromoneRouter';
import { LearnedWeights, DEFAULT_TENANT_ID as LW_DEFAULT } from '../../src/ultimate/learnedWeights';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import type { OrchestrationTopology, DeliberationPlan } from '../../src/ultimate/types';

const BASE_WEIGHTS = { research: 0, parallel: 2, sequential: 0, complex: 0 };

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

describe('P2: LearnedWeights tenant isolation', () => {
  describe('key + state isolation', () => {
    it('uses DEFAULT_TENANT_ID when no tenantId is passed', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      lw.recordSignal('CODING', 'PARALLEL', true, 1.0);
      expect(lw.listTenants()).toEqual([DEFAULT_TENANT_ID]);
      expect(lw.getState('CODING', 'PARALLEL')).toBeDefined();
      expect(lw.getState('CODING', 'PARALLEL', undefined)).toBeDefined();
      // Both should be the same record (both → default tenant).
      expect(lw.getState('CODING', 'PARALLEL')).toBe(lw.getState('CODING', 'PARALLEL', undefined));
    });

    it('exports the same DEFAULT_TENANT_ID from PheromoneRouter and LearnedWeights', () => {
      expect(LW_DEFAULT).toBe(DEFAULT_TENANT_ID);
    });

    it('isolates state across tenants — cross-tenant signal does not leak', () => {
      const pr = new PheromoneRouter();
      // α=0.5 + 30 outcomes per tenant converges the EMA close to the
      // signal asymptote (signal saturates near ±0.44 for q=0/1).
      const lw = new LearnedWeights(pr, { smoothingFactor: 0.5 });
      // Tenant A: 30 successes → EMA near +0.43
      for (let i = 0; i < 30; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
      // Tenant B: 30 failures → EMA near -0.43
      for (let i = 0; i < 30; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0, 'tenant-B');

      const a = lw.getState('CODING', 'PARALLEL', 'tenant-A');
      const b = lw.getState('CODING', 'PARALLEL', 'tenant-B');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.ema).toBeGreaterThan(0.3);
      expect(b!.ema).toBeLessThan(-0.3);
    });

    it('routes omitted tenantId and explicit DEFAULT_TENANT_ID to the same bucket', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      for (let i = 0; i < 5; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0); // no tenantId
      for (let i = 0; i < 5; i++)
        lw.recordSignal('CODING', 'SEQUENTIAL', true, 1.0, DEFAULT_TENANT_ID);
      // Both writes land in the default bucket — total 2 triples, both in default.
      expect(lw.listTenants()).toEqual([DEFAULT_TENANT_ID]);
      expect(lw.size()).toBe(2);
      expect(lw.size(DEFAULT_TENANT_ID)).toBe(2);
    });
  });

  describe('getAdjustedWeights is tenant-scoped', () => {
    it('returns the base unchanged for a tenant with no signal', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      // Train tenant-A only.
      for (let i = 0; i < 10; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
      // tenant-B has no signal.
      const b = lw.getAdjustedWeights('CODING', BASE_WEIGHTS, 'tenant-B');
      expect(b.adjusted).toEqual(BASE_WEIGHTS);
      expect(b.maturePairs).toBe(0);
      expect(b.tenantId).toBe('tenant-B');
    });

    it('returns different adjustments for two tenants with opposite signals', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr, { smoothingFactor: 0.5, minSamplesBeforeAdjust: 3 });
      // tenant-A: reinforce PARALLEL (15 successes)
      for (let i = 0; i < 15; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
      // tenant-B: penalize PARALLEL (15 failures)
      for (let i = 0; i < 15; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0, 'tenant-B');

      const a = lw.getAdjustedWeights('CODING', BASE_WEIGHTS, 'tenant-A');
      const b = lw.getAdjustedWeights('CODING', BASE_WEIGHTS, 'tenant-B');
      expect(a.tenantId).toBe('tenant-A');
      expect(b.tenantId).toBe('tenant-B');
      // tenant-A's parallel dimension is boosted; tenant-B's is reduced.
      expect(a.adjusted.parallel).toBeGreaterThan(BASE_WEIGHTS.parallel);
      expect(b.adjusted.parallel).toBeLessThan(BASE_WEIGHTS.parallel);
      expect(a.adjustments.PARALLEL).toBeGreaterThan(0);
      expect(b.adjustments.PARALLEL).toBeLessThan(0);
      // Mature pair count is identical (both have 1 mature pair).
      expect(a.maturePairs).toBe(b.maturePairs);
    });

    it('getStats filters by tenantId', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      for (let i = 0; i < 3; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
      for (let i = 0; i < 3; i++) lw.recordSignal('CODING', 'SEQUENTIAL', false, 0.0, 'tenant-B');
      const all = lw.getStats();
      const aOnly = lw.getStats('tenant-A');
      const bOnly = lw.getStats('tenant-B');
      expect(all.length).toBe(2);
      expect(aOnly.length).toBe(1);
      expect(bOnly.length).toBe(1);
      expect(aOnly[0].tenantId).toBe('tenant-A');
      expect(bOnly[0].tenantId).toBe('tenant-B');
      expect(aOnly[0].topology).toBe('PARALLEL');
      expect(bOnly[0].topology).toBe('SEQUENTIAL');
    });
  });

  describe('reset(tenantId) scopes cleanup', () => {
    it('reset(tenantId) clears only that tenant', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
      lw.recordSignal('CODING', 'SEQUENTIAL', false, 0.0, 'tenant-B');
      expect(lw.size()).toBe(2);
      lw.reset('tenant-A');
      expect(lw.size('tenant-A')).toBe(0);
      expect(lw.size('tenant-B')).toBe(1);
      expect(lw.getState('CODING', 'PARALLEL', 'tenant-A')).toBeUndefined();
      expect(lw.getState('CODING', 'SEQUENTIAL', 'tenant-B')).toBeDefined();
    });

    it('reset() with no arg clears every tenant', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
      lw.recordSignal('CODING', 'SEQUENTIAL', false, 0.0, 'tenant-B');
      expect(lw.size()).toBe(2);
      lw.reset();
      expect(lw.size()).toBe(0);
      expect(lw.listTenants()).toEqual([]);
    });
  });

  describe('composition with PheromoneRouter (single source of truth)', () => {
    it('recordSignal also feeds the underlying pheromone with the same tenantId', () => {
      const pr = new PheromoneRouter();
      const lw = new LearnedWeights(pr);
      for (let i = 0; i < 10; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-X');
      // Pheromone for tenant-X should be high
      expect(pr.getConfidenceFor('tenant-X', 'CODING', 'PARALLEL')).toBeGreaterThan(0.9);
      // Pheromone for tenant-Y should still be at the uninformative prior
      expect(pr.getConfidenceFor('tenant-Y', 'CODING', 'PARALLEL')).toBe(0.5);
    });
  });
});

describe('P2: PheromoneRouter tenant isolation', () => {
  it('recordOutcomeFor / getConfidenceFor use tenant-scoped state', () => {
    const pr = new PheromoneRouter();
    // 6 successes at q=1.0 → alpha=1+6*1.5=10, beta=1, conf=10/11=0.909 (>0.9).
    for (let i = 0; i < 6; i++) pr.recordOutcomeFor('a', 'CODING', 'PARALLEL', true, 1.0);
    // 6 failures at q=0.0 → alpha=1, beta=1+6*0.5=4, conf=1/5=0.2 (<0.1 fails,
    // so use 10 failures → beta=6, conf=1/7=0.143).
    for (let i = 0; i < 10; i++) pr.recordOutcomeFor('b', 'CODING', 'PARALLEL', false, 0.0);
    expect(pr.getConfidenceFor('a', 'CODING', 'PARALLEL')).toBeGreaterThan(0.9);
    expect(pr.getConfidenceFor('b', 'CODING', 'PARALLEL')).toBeLessThan(0.2);
  });

  it('biasFor produces different biases for two tenants with opposite signals', () => {
    const pr = new PheromoneRouter();
    for (let i = 0; i < 10; i++) pr.recordOutcomeFor('a', 'CODING', 'PARALLEL', true, 1.0);
    for (let i = 0; i < 10; i++) pr.recordOutcomeFor('b', 'CODING', 'PARALLEL', false, 0.0);
    const scores = [
      { topology: 'PARALLEL' as OrchestrationTopology, score: 0 },
      { topology: 'SEQUENTIAL' as OrchestrationTopology, score: 0 },
    ];
    const aBiased = pr.biasFor('a', 'CODING', scores);
    const bBiased = pr.biasFor('b', 'CODING', scores);
    const aP = aBiased.find((s) => s.topology === 'PARALLEL')!;
    const bP = bBiased.find((s) => s.topology === 'PARALLEL')!;
    expect(aP.pheromoneBias).toBeGreaterThan(0);
    expect(bP.pheromoneBias).toBeLessThan(0);
  });

  it('legacy single-tenant recordOutcome signature still works (backward compat)', () => {
    const pr = new PheromoneRouter();
    // P1 signature: recordOutcome(taskType, topology, success, qualityScore?).
    // Use 6 successes so confidence = 10/11 = 0.909 > 0.9.
    for (let i = 0; i < 6; i++) pr.recordOutcome('CODING', 'PARALLEL', true, 1.0);
    expect(pr.getConfidence('CODING', 'PARALLEL')).toBeGreaterThan(0.9);
    // Legacy call should route to DEFAULT_TENANT_ID.
    expect(pr.listTenants()).toEqual([DEFAULT_TENANT_ID]);
  });
});

describe('P2: TopologyRouter routes per-tenant pheromone + learned weights', () => {
  it('route(plan, dag, budget, tenantId) applies tenant-scoped adjustments', () => {
    const pr = new PheromoneRouter();
    const tr = new TopologyRouter(pr);
    const lw = tr.getLearnedWeights();

    // tenant-A: reinforce PARALLEL, penalize SINGLE
    for (let i = 0; i < 15; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
    for (let i = 0; i < 15; i++) lw.recordSignal('CODING', 'SINGLE', false, 0.0, 'tenant-A');

    const aResult = tr.route(makePlan('CODING'), undefined, undefined, 'tenant-A');
    // The same router with no tenantId sees no signal at all.
    const noTenantResult = tr.route(makePlan('CODING'), undefined, undefined, undefined);

    expect(aResult.adjustedWeights).toBeDefined();
    expect(aResult.adjustedWeights!.tenantId).toBe('tenant-A');
    expect(aResult.adjustedWeights!.maturePairs).toBeGreaterThan(0);
    // No-tenant route has no signal.
    expect(noTenantResult.adjustedWeights!.maturePairs).toBe(0);
    // The matured adjustments differ between the two.
    expect(aResult.adjustedWeights!.adjustments.PARALLEL).toBeGreaterThan(0);
    expect(aResult.adjustedWeights!.adjustments.SINGLE).toBeLessThan(0);
  });

  it('two tenants with opposite signals see different scores for the same plan', () => {
    const pr = new PheromoneRouter();
    const tr = new TopologyRouter(pr);
    const lw = tr.getLearnedWeights();

    // tenant-A: 20 PARALLEL successes
    for (let i = 0; i < 20; i++) lw.recordSignal('CODING', 'PARALLEL', true, 1.0, 'tenant-A');
    // tenant-B: 20 PARALLEL failures
    for (let i = 0; i < 20; i++) lw.recordSignal('CODING', 'PARALLEL', false, 0.0, 'tenant-B');

    const aResult = tr.route(makePlan('CODING'), undefined, undefined, 'tenant-A');
    const bResult = tr.route(makePlan('CODING'), undefined, undefined, 'tenant-B');
    // The PARALLEL adjustment is positive for A, negative for B.
    expect(aResult.adjustedWeights!.adjustments.PARALLEL!).toBeGreaterThan(0);
    expect(bResult.adjustedWeights!.adjustments.PARALLEL!).toBeLessThan(0);
  });
});
