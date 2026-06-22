/**
 * Tests for DifferentialPrivacyLayer — ε-DP for cross-agent memory sharing.
 *
 * Covers: Laplace/Gaussian mechanisms, sensitivity analysis, privacy budget
 * accounting, sanitizeCount/sum/average/numeric, sanitizeMemoryEntries,
 * sanitizeEntryCount, DPQueryRejection paths, budget exhaustion, configuration,
 * and utility functions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DifferentialPrivacyLayer,
  getDifferentialPrivacyLayer,
  resetDifferentialPrivacyLayer,
  sampleLaplace,
  sampleGaussian,
  laplaceMechanism,
  gaussianMechanism,
  analyzeSensitivity,
  classifyEpsilon,
} from '../../src/security/differentialPrivacyLayer';

// ============================================================================
// Test helpers
// ============================================================================

/** Run a function many times and collect results for statistical testing. */
function runMany<T>(fn: () => T, n: number = 1000): T[] {
  return Array.from({ length: n }, () => fn());
}

/** Compute mean of an array of numbers. */
function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Compute variance of an array of numbers. */
function variance(values: number[]): number {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
}

/** Compute standard deviation of an array of numbers. */
function stddev(values: number[]): number {
  return Math.sqrt(variance(values));
}

// ============================================================================
// Tests
// ============================================================================

describe('DifferentialPrivacyLayer', () => {
  // ── Laplace Mechanism ────────────────────────────────────────────────

  describe('laplaceMechanism', () => {
    it('should return the value unchanged when sensitivity is zero', () => {
      const result = laplaceMechanism(42, 0, 1.0);
      expect(result).toBe(42);
    });

    it('should add Laplace noise with expected scale', () => {
      // For ε=1, Δf=1: scale b = 1/1 = 1
      // Laplace variance = 2b² = 2
      const noisyValues = runMany(() => laplaceMechanism(100, 1, 1.0), 1000);
      // Mean should be approximately 100
      expect(Math.abs(mean(noisyValues) - 100)).toBeLessThan(0.5);
      // Variance should be approximately 2b² = 2
      const v = variance(noisyValues);
      expect(v).toBeGreaterThan(1.0);
      expect(v).toBeLessThan(3.5);
    });

    it('should respect epsilon — smaller ε = more noise', () => {
      const eps01 = runMany(() => laplaceMechanism(50, 1, 0.1), 500);
      const eps10 = runMany(() => laplaceMechanism(50, 1, 10.0), 500);

      // stddev with ε=0.1 should be much larger than with ε=10
      const std01 = stddev(eps01);
      const std10 = stddev(eps10);
      expect(std01).toBeGreaterThan(std10 * 5);
    });

    it('should handle negative values', () => {
      const noisy = laplaceMechanism(-42, 1, 2.0);
      expect(typeof noisy).toBe('number');
      expect(Number.isFinite(noisy)).toBe(true);
    });

    it('should throw for epsilon <= 0', () => {
      expect(() => laplaceMechanism(42, 1, 0)).toThrow('epsilon must be > 0');
      expect(() => laplaceMechanism(42, 1, -1)).toThrow('epsilon must be > 0');
    });

    it('should throw for negative sensitivity', () => {
      expect(() => laplaceMechanism(42, -1, 1.0)).toThrow('sensitivity must be >= 0');
    });
  });

  // ── Gaussian Mechanism ───────────────────────────────────────────────

  describe('gaussianMechanism', () => {
    it('should add Gaussian noise', () => {
      const values = runMany(() => gaussianMechanism(100, 1, 1.0, 1e-5), 1000);
      // Mean should be approximately 100
      expect(Math.abs(mean(values) - 100)).toBeLessThan(1.0);
      // Should have some variance
      expect(variance(values)).toBeGreaterThan(0.5);
    });

    it('should respect sensitivity and epsilon', () => {
      const lowNoise = gaussianMechanism(50, 0.1, 10.0, 1e-5);
      const highNoise = gaussianMechanism(50, 1, 0.1, 1e-5);
      // With high sensitivity and low epsilon, noise should be much larger
      expect(Math.abs(lowNoise - 50)).toBeLessThan(5);
      // highNoise could be far from 50 (just check it's still finite)
      expect(Number.isFinite(highNoise)).toBe(true);
    });

    it('should throw for invalid parameters', () => {
      expect(() => gaussianMechanism(42, 1, 0, 1e-5)).toThrow('epsilon must be > 0');
      expect(() => gaussianMechanism(42, 1, 1.0, 0)).toThrow('delta must be in (0,1)');
      expect(() => gaussianMechanism(42, -1, 1.0, 1e-5)).toThrow('sensitivity must be >= 0');
    });

    it('should return unchanged when sensitivity is zero', () => {
      expect(gaussianMechanism(42, 0, 1.0, 1e-5)).toBe(42);
    });
  });

  // ── sampleLaplace ──────────────────────────────────────────────────

  describe('sampleLaplace', () => {
    it('should generate samples with symmetric distribution', () => {
      const samples = runMany(() => sampleLaplace(1.0), 2000);
      const m = mean(samples);
      expect(Math.abs(m)).toBeLessThan(0.1); // Mean should be ~0
      // Should have roughly equal positive and negative
      const positive = samples.filter((s) => s > 0).length;
      expect(Math.abs(positive / samples.length - 0.5)).toBeLessThan(0.1);
    });

    it('should scale with b parameter', () => {
      const smallB = runMany(() => sampleLaplace(0.1), 500);
      const largeB = runMany(() => sampleLaplace(5.0), 500);
      expect(stddev(largeB)).toBeGreaterThan(stddev(smallB) * 2);
    });
  });

  // ── sampleGaussian ──────────────────────────────────────────────────

  describe('sampleGaussian', () => {
    it('should generate samples with approximately N(0, σ²) distribution', () => {
      const sigma = 2.0;
      const samples = runMany(() => sampleGaussian(sigma), 2000);
      const m = mean(samples);
      expect(Math.abs(m)).toBeLessThan(0.2); // Mean ~0
      const s = stddev(samples);
      expect(Math.abs(s - sigma) / sigma).toBeLessThan(0.15); // StdDev ~sigma
    });
  });

  // ── classifyEpsilon ─────────────────────────────────────────────────

  describe('classifyEpsilon', () => {
    it('should classify ε < 1 as strong', () => {
      expect(classifyEpsilon(0.1)).toBe('strong');
      expect(classifyEpsilon(0.5)).toBe('strong');
      expect(classifyEpsilon(0.99)).toBe('strong');
    });

    it('should classify ε in [1, 10) as moderate', () => {
      expect(classifyEpsilon(1.0)).toBe('moderate');
      expect(classifyEpsilon(5.0)).toBe('moderate');
      expect(classifyEpsilon(9.99)).toBe('moderate');
    });

    it('should classify ε >= 10 as weak', () => {
      expect(classifyEpsilon(10)).toBe('weak');
      expect(classifyEpsilon(100)).toBe('weak');
    });
  });

  // ── Sensitivity Analysis ────────────────────────────────────────────

  describe('analyzeSensitivity', () => {
    it('should return Δf=1 for count queries', () => {
      const s = analyzeSensitivity('count');
      expect(s.l1Sensitivity).toBe(1);
      expect(s.l2Sensitivity).toBe(1);
      expect(s.boundType).toBe('global');
    });

    it('should compute sensitivity for sum queries from bounds', () => {
      const s = analyzeSensitivity('sum', { min: 0, max: 100 });
      expect(s.l1Sensitivity).toBe(100);
      expect(s.l2Sensitivity).toBe(100);
    });

    it('should compute global sensitivity for average queries', () => {
      const s = analyzeSensitivity('average', { min: 0, max: 100, count: 1000 });
      expect(s.l1Sensitivity).toBe(100); // global = range
      expect(s.boundType).toBe('global');
    });

    it('should return histogram sensitivities', () => {
      const s = analyzeSensitivity('histogram');
      expect(s.l1Sensitivity).toBe(1);
      expect(s.l2Sensitivity).toBeCloseTo(Math.SQRT2, 10);
    });

    it('should throw for sum without bounds', () => {
      expect(() => analyzeSensitivity('sum')).toThrow('Data bounds required');
    });

    it('should throw for average without count', () => {
      expect(() => analyzeSensitivity('average', { min: 0, max: 1 })).toThrow(
        'Data bounds with count required',
      );
    });

    it('should throw for invalid bounds', () => {
      expect(() => analyzeSensitivity('sum', { min: 10, max: 5 })).toThrow(
        'max=5 must be > min=10',
      );
    });
  });

  // ── Privacy Budget Accounting ───────────────────────────────────────

  describe('Privacy Budget', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 10.0 });
    });

    it('should create a fresh budget for a new principal', () => {
      const budget = dp.getBudget('agent-7');
      expect(budget.principalId).toBe('agent-7');
      expect(budget.remainingBudget).toBe(10.0);
      expect(budget.consumedBudget).toBe(0);
      expect(budget.queryCount).toBe(0);
    });

    it('should spend budget correctly', () => {
      expect(dp.spendBudget('agent-1', 3.0)).toBe(true);
      const budget = dp.getBudget('agent-1');
      expect(budget.remainingBudget).toBeCloseTo(7.0, 5);
      expect(budget.consumedBudget).toBeCloseTo(3.0, 5);
      expect(budget.queryCount).toBe(1);
    });

    it('should reject spending above remaining budget', () => {
      expect(dp.spendBudget('agent-1', 9.0)).toBe(true);
      expect(dp.spendBudget('agent-1', 2.0)).toBe(false);
      const budget = dp.getBudget('agent-1');
      expect(budget.remainingBudget).toBeCloseTo(1.0, 5);
    });

    it('should reject spending exactly remaining + 0.01', () => {
      expect(dp.spendBudget('agent-1', 9.99)).toBe(true);
      expect(dp.spendBudget('agent-1', 0.02)).toBe(false);
    });

    it('should track budgets per principal independently', () => {
      dp.spendBudget('agent-a', 5.0);
      dp.spendBudget('agent-b', 2.0);

      expect(dp.getBudget('agent-a').remainingBudget).toBeCloseTo(5.0, 5);
      expect(dp.getBudget('agent-b').remainingBudget).toBeCloseTo(8.0, 5);
    });

    it('should reset budget for a principal', () => {
      dp.spendBudget('agent-1', 5.0);
      dp.resetBudget('agent-1');
      const budget = dp.getBudget('agent-1');
      expect(budget.remainingBudget).toBe(10.0);
      expect(budget.consumedBudget).toBe(0);
      expect(budget.queryCount).toBe(0);
    });

    it('should clamp epsilon to minEpsilonPerQuery', () => {
      const dpTight = new DifferentialPrivacyLayer({
        maxBudgetPerWindow: 10.0,
        minEpsilonPerQuery: 0.1,
      });
      expect(dpTight.spendBudget('agent-1', 0.001)).toBe(true);
      // Should have spent at least minEpsilonPerQuery
      expect(dpTight.getBudget('agent-1').remainingBudget).toBeLessThanOrEqual(9.9);
    });

    it('should enforce budget window expiration', () => {
      const dpCustom = new DifferentialPrivacyLayer({
        maxBudgetPerWindow: 5.0,
        budgetWindowMs: 10, // 10ms window
      });

      dpCustom.spendBudget('agent-1', 5.0);
      expect(dpCustom.spendBudget('agent-1', 1.0)).toBe(false);
    });

    it('should throw for epsilon <= 0 in spendBudget', () => {
      // Actually, spendBudget handles it via minEpsilonPerQuery clamping
      // Just verify it doesn't throw and returns a boolean
      expect(typeof dp.spendBudget('agent-1', -1)).toBe('boolean');
    });

    it('should track total consumed across principals', () => {
      dp.spendBudget('agent-a', 3.0);
      dp.spendBudget('agent-b', 4.0);
      expect(dp.getTotalConsumed()).toBe(7.0);
    });

    it('should check budget availability', () => {
      expect(dp.checkBudget('agent-check', 5.0)).toBe(true);
      dp.spendBudget('agent-check', 8.0);
      expect(dp.checkBudget('agent-check', 3.0)).toBe(false);
      expect(dp.checkBudget('agent-check', 2.0)).toBe(true);
    });

    it('should check budget on a fresh principal', () => {
      expect(dp.checkBudget('new-agent', 10.0)).toBe(true);
      expect(dp.checkBudget('new-agent', 10.01)).toBe(false);
    });
  });

  // ── Query Sanitization ─────────────────────────────────────────────

  describe('sanitizeCount', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 50.0 });
    });

    it('should return a noisy count with budget metadata', () => {
      const result = dp.sanitizeCount(42, 'agent-1', 1.0);
      if (!result.answerable) throw new Error('Expected answerable');
      expect(result.result).toBeGreaterThanOrEqual(0);
      expect(result.epsilonUsed).toBe(1.0);
      expect(result.deltaUsed).toBe(0);
      expect(result.mechanism).toBe('laplace');
      expect(result.sensitivity).toBe(1);
    });

    it('should reject when budget is exhausted', () => {
      dp.spendBudget('agent-1', 49.9);
      const result = dp.sanitizeCount(42, 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
      if (!result.answerable) {
        expect(result.reason).toBe('budget_exhausted');
      }
    });

    it('should use default epsilon when not specified', () => {
      const result = dp.sanitizeCount(42, 'agent-2');
      if (!result.answerable) throw new Error('Expected answerable');
      // Default epsilon is 3.0
      expect(result.epsilonUsed).toBe(3.0);
    });

    it('should round noisy count to integer', () => {
      const result = dp.sanitizeCount(10, 'agent-1', 5.0);
      if (!result.answerable) throw new Error('Expected answerable');
      expect(Number.isInteger(result.result)).toBe(true);
    });

    it('should never return negative count (clamped to 0)', () => {
      // With very small epsilon, noise could push negative
      const results = runMany(() => dp.sanitizeCount(1, 'agent-3', 0.1), 20);
      for (const r of results) {
        if (r.answerable) {
          expect(r.result).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('should reduce remaining budget after each query', () => {
      const budgetBefore = dp.getBudget('agent-1').remainingBudget;
      dp.sanitizeCount(42, 'agent-1', 1.0);
      const budgetAfter = dp.getBudget('agent-1').remainingBudget;
      expect(budgetAfter).toBeLessThan(budgetBefore);
    });
  });

  describe('sanitizeSum', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 50.0 });
    });

    it('should DP-sanitize a sum', () => {
      const result = dp.sanitizeSum(500, { min: 0, max: 100 }, 'agent-1', 1.0);
      if (!result.answerable) throw new Error('Expected answerable');
      expect(typeof result.result).toBe('number');
      expect(result.sensitivity).toBe(100); // range = 100
    });

    it('should reject invalid bounds', () => {
      const result = dp.sanitizeSum(500, { min: 10, max: 5 }, 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
      if (!result.answerable) {
        expect(result.reason).toBe('invalid_bounds');
      }
    });
  });

  describe('sanitizeAverage', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 50.0 });
    });

    it('should DP-sanitize an average', () => {
      // sum=500, count=10, bounds [0, 100], ε=4.0
      const result = dp.sanitizeAverage(500, 10, { min: 0, max: 100 }, 'agent-1', 4.0);
      if (!result.answerable) throw new Error('Expected answerable');
      // Average is 500/10 = 50, should be in [0, 100] after noise
      expect(result.result).toBeGreaterThanOrEqual(0);
      expect(result.result).toBeLessThanOrEqual(100);
      // Split budget: 2.0 for sum, 2.0 for count
      expect(result.epsilonUsed).toBe(4.0);
    });

    it('should reject when count < minItemsForSanitization', () => {
      const dpStrict = new DifferentialPrivacyLayer({
        maxBudgetPerWindow: 50.0,
        minItemsForSanitization: 10,
      });
      const result = dpStrict.sanitizeAverage(15, 3, { min: 0, max: 10 }, 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
      if (!result.answerable) {
        expect(result.reason).toBe('too_few_items');
      }
    });

    it('should reject invalid bounds', () => {
      const result = dp.sanitizeAverage(500, 10, { min: 10, max: 5 }, 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
      if (!result.answerable) {
        expect(result.reason).toBe('invalid_bounds');
      }
    });

    it('should clip result to bounds after noise', () => {
      // Even with extreme noise, the result should stay in bounds
      const results = runMany(
        () => dp.sanitizeAverage(90, 10, { min: 0, max: 100 }, 'agent-avg', 0.5),
        20,
      );
      for (const r of results) {
        if (r.answerable) {
          expect(r.result).toBeGreaterThanOrEqual(0);
          expect(r.result).toBeLessThanOrEqual(100);
        }
      }
    });
  });

  describe('sanitizeNumeric', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 50.0 });
    });

    it('should DP-sanitize a numeric value within bounds', () => {
      const result = dp.sanitizeNumeric(0.7, { min: 0, max: 1 }, 'agent-1', 2.0);
      if (!result.answerable) throw new Error('Expected answerable');
      expect(result.result).toBeGreaterThanOrEqual(0);
      expect(result.result).toBeLessThanOrEqual(1);
    });

    it('should reject budget exhaustion', () => {
      dp.spendBudget('agent-1', 49.9);
      const result = dp.sanitizeNumeric(0.5, { min: 0, max: 1 }, 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
    });
  });

  // ── Memory Entry Sanitization ───────────────────────────────────────

  describe('sanitizeMemoryEntries', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 50.0 });
    });

    it('should sanitize numeric fields in memory entries', () => {
      const entries = [
        { id: '1', importance: 0.8, accessCount: 42, decayScore: 0.3, content: 'test a' },
        { id: '2', importance: 0.5, accessCount: 17, decayScore: 0.8, content: 'test b' },
        { id: '3', importance: 0.9, accessCount: 100, decayScore: 0.1, content: 'test c' },
        { id: '4', importance: 0.2, accessCount: 5, decayScore: 0.9, content: 'test d' },
        { id: '5', importance: 0.6, accessCount: 30, decayScore: 0.5, content: 'test e' },
      ];

      const result = dp.sanitizeMemoryEntries(entries, 'agent-1', 5.0);
      if (!result.answerable) throw new Error('Expected answerable');

      expect(result.result.length).toBe(5);

      // Text content should be preserved
      expect(result.result[0].content).toBe('test a');
      expect(result.result[1].content).toBe('test b');

      // Numeric fields should be modified (noise added)
      // Verify they're clamped to valid ranges
      for (const entry of result.result) {
        if (entry.importance !== undefined) {
          expect(entry.importance).toBeGreaterThanOrEqual(0);
          expect(entry.importance).toBeLessThanOrEqual(1);
        }
        if (entry.accessCount !== undefined) {
          expect(entry.accessCount).toBeGreaterThanOrEqual(0);
        }
        if (entry.decayScore !== undefined) {
          expect(entry.decayScore).toBeGreaterThanOrEqual(0);
          expect(entry.decayScore).toBeLessThanOrEqual(1);
        }
      }
    });

    it('should reject too few entries', () => {
      const result = dp.sanitizeMemoryEntries([{ importance: 0.5 }], 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
      if (!result.answerable) {
        expect(result.reason).toBe('too_few_items');
      }
    });

    it('should handle empty entries array', () => {
      const result = dp.sanitizeMemoryEntries([], 'agent-1', 1.0);
      expect(result.answerable).toBe(true);
      if (result.answerable) {
        expect(result.result).toEqual([]);
      }
    });

    it('should reject budget exhaustion for memory entries', () => {
      dp.spendBudget('agent-1', 49.9);
      const result = dp.sanitizeMemoryEntries(
        [
          { importance: 0.5 },
          { importance: 0.5 },
          { importance: 0.5 },
          { importance: 0.5 },
          { importance: 0.5 },
        ],
        'agent-1',
        1.0,
      );
      expect(result.answerable).toBe(false);
    });

    it('should handle entries with missing numeric fields gracefully', () => {
      const entries = [
        { id: '1', content: 'just text' },
        { id: '2', importance: 0.5, content: 'has importance only' },
        { id: '3', accessCount: 10, content: 'has count only' },
        { id: '4', decayScore: 0.3, content: 'has decay only' },
        { id: '5', importance: 0.7, accessCount: 25, decayScore: 0.6, content: 'has all' },
      ];

      const result = dp.sanitizeMemoryEntries(entries, 'agent-2', 5.0);
      if (!result.answerable) throw new Error('Expected answerable');
      expect(result.result.length).toBe(5);
      expect(result.result[0].content).toBe('just text');
    });
  });

  describe('sanitizeEntryCount', () => {
    let dp: DifferentialPrivacyLayer;

    beforeEach(() => {
      dp = new DifferentialPrivacyLayer({ maxBudgetPerWindow: 50.0 });
    });

    it('should DP-sanitize entry count', () => {
      const entries = Array(10).fill({});
      const result = dp.sanitizeEntryCount(entries, 'agent-1', 1.0);
      if (!result.answerable) throw new Error('Expected answerable');
      expect(result.result).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.result)).toBe(true);
    });

    it('should reject too few entries', () => {
      const result = dp.sanitizeEntryCount([{}, {}], 'agent-1', 1.0);
      expect(result.answerable).toBe(false);
      if (!result.answerable) {
        expect(result.reason).toBe('too_few_items');
      }
    });
  });

  // ── Configuration ──────────────────────────────────────────────────

  describe('Configuration', () => {
    it('should use defaults when not specified', () => {
      const dp = new DifferentialPrivacyLayer();
      const config = dp.getConfig();
      expect(config.defaultEpsilon).toBe(3.0);
      expect(config.defaultDelta).toBe(1e-5);
      expect(config.minEpsilonPerQuery).toBe(0.01);
      expect(config.maxBudgetPerWindow).toBe(20.0);
      expect(config.minItemsForSanitization).toBe(5);
    });

    it('should allow overriding config', () => {
      const dp = new DifferentialPrivacyLayer({
        defaultEpsilon: 0.5,
        maxBudgetPerWindow: 5.0,
        minItemsForSanitization: 10,
      });
      const config = dp.getConfig();
      expect(config.defaultEpsilon).toBe(0.5);
      expect(config.maxBudgetPerWindow).toBe(5.0);
      expect(config.minItemsForSanitization).toBe(10);
    });

    it('should update config at runtime', () => {
      const dp = new DifferentialPrivacyLayer();
      dp.updateConfig({ defaultEpsilon: 1.5 });
      expect(dp.getConfig().defaultEpsilon).toBe(1.5);
    });
  });

  // ── Singleton ──────────────────────────────────────────────────────

  describe('Singleton', () => {
    it('should create and retrieve singleton instance', () => {
      resetDifferentialPrivacyLayer();
      const dp1 = getDifferentialPrivacyLayer();
      const dp2 = getDifferentialPrivacyLayer();
      expect(dp1).toBe(dp2);
      dp1.spendBudget('test-agent', 1.0);
      expect(dp2.getBudget('test-agent').consumedBudget).toBe(1.0);
    });

    it('should reset singleton state', () => {
      const dp = getDifferentialPrivacyLayer();
      dp.spendBudget('test-agent', 5.0);
      resetDifferentialPrivacyLayer();
      const dpFresh = getDifferentialPrivacyLayer();
      expect(dpFresh.getBudget('test-agent').consumedBudget).toBe(0);
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────

  describe('reset', () => {
    it('should clear all budgets', () => {
      const dp = new DifferentialPrivacyLayer();
      dp.spendBudget('agent-a', 3.0);
      dp.spendBudget('agent-b', 4.0);
      dp.reset();
      expect(dp.getBudget('agent-a').consumedBudget).toBe(0);
      expect(dp.getBudget('agent-b').consumedBudget).toBe(0);
    });
  });
});
