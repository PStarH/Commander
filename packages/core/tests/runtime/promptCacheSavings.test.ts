/**
 * Prompt Cache Dollar Savings — convert provider-reported cache reads
 * into dollar figures, emitted as counters and surfaced on the cost dashboard.
 *
 * Tests the contract:
 *   1. `recordPromptCacheSavings` is a no-op when cacheReadTokens === 0
 *   2. Known model + known cachedInputPer1k produces the expected savings
 *   3. Unknown model on known provider falls through to FALLBACK_PRICING
 *   4. Provider over-reports cache reads; clamp to inputTokens
 *   5. Tenant + provider labels are present on emitted counters
 *   6. `recordPromptPrefixCache` public API is unchanged
 *   7. `CostDashboard.generateReport()` includes the new fields
 *
 * The math, end-to-end, is asserted in `tokenMeasurement.test.ts`
 * (the $0.027 figure for 10K tokens on claude-3-5-sonnet).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, getMetricsCollector, resetMetricsCollector } from '../../src/runtime/metricsCollector';
import { CostDashboard, resetCostDashboard } from '../../src/runtime/costDashboard';
import { CostModel, resetCostModel } from '../../src/observability/costModel';
import type { TokenUsage } from '../../src/runtime/types';

function usage(promptTokens: number, cacheReadTokens: number): TokenUsage {
  return {
    promptTokens,
    completionTokens: 100,
    totalTokens: promptTokens + 100,
    cacheReadTokens,
  };
}

describe('recordPromptCacheSavings', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    resetMetricsCollector();
    resetCostModel();
    resetCostDashboard();
    metrics = new MetricsCollector();
  });

  it('is a no-op when cacheReadTokens === 0', () => {
    metrics.recordPromptCacheSavings(usage(10_000, 0), 'anthropic', 'claude-3-5-sonnet', 'tenant-a');
    expect(metrics.getCounterTotal('prompt_cache_tokens_read_total')).toBe(0);
    expect(metrics.getCounterTotal('prompt_cache_dollars_uncached_equivalent_total')).toBe(0);
    expect(metrics.getCounterTotal('prompt_cache_cost_saved_usd_total')).toBe(0);
  });

  it('emits the expected savings on claude-3-5-sonnet with 10K cached tokens', () => {
    metrics.recordPromptCacheSavings(usage(12_000, 10_000), 'anthropic', 'claude-3-5-sonnet', 'tenant-a');
    // tokens_read: full 10K emitted
    expect(metrics.getCounterTotal('prompt_cache_tokens_read_total')).toBe(10_000);
    // uncached equivalent at inputPer1k=0.003 = (10_000/1000)*0.003 = 0.030
    expect(metrics.getCounterTotal('prompt_cache_dollars_uncached_equivalent_total')).toBeCloseTo(0.030, 6);
    // cached cost at cachedInputPer1k=0.0003 = 0.003; savings = 0.030 - 0.003 = 0.027
    expect(metrics.getCounterTotal('prompt_cache_cost_saved_usd_total')).toBeCloseTo(0.027, 6);
  });

  it('emits the expected savings on gpt-4o with 5K cached tokens', () => {
    // gpt-4o: inputPer1k=0.0025, cachedInputPer1k=0.00125 (50% off, not 90%)
    metrics.recordPromptCacheSavings(usage(8_000, 5_000), 'openai', 'gpt-4o', 'tenant-b');
    // uncached equivalent = (5_000/1000)*0.0025 = 0.0125
    expect(metrics.getCounterTotal('prompt_cache_dollars_uncached_equivalent_total')).toBeCloseTo(0.0125, 6);
    // cached cost = (5_000/1000)*0.00125 = 0.00625; savings = 0.0125 - 0.00625 = 0.00625
    expect(metrics.getCounterTotal('prompt_cache_cost_saved_usd_total')).toBeCloseTo(0.00625, 6);
  });

  it('falls through to FALLBACK_PRICING for unknown models on a known provider', () => {
    // FALLBACK_PRICING has no cachedInputPer1k, so cachedCost = 0 and
    // dollarsSaved = dollarsUncachedEquivalent (upper bound).
    metrics.recordPromptCacheSavings(usage(10_000, 10_000), 'anthropic', 'claude-99-future', 'tenant-a');
    // FALLBACK inputPer1k=0.001 → uncached = (10_000/1000)*0.001 = 0.010
    expect(metrics.getCounterTotal('prompt_cache_dollars_uncached_equivalent_total')).toBeCloseTo(0.010, 6);
    // savings == uncached when cachedInputPer1k is missing
    expect(metrics.getCounterTotal('prompt_cache_cost_saved_usd_total')).toBeCloseTo(0.010, 6);
  });

  it('clamps cacheReadTokens to promptTokens when the provider over-reports', () => {
    // Pathological case: cacheReadTokens > promptTokens
    metrics.recordPromptCacheSavings(usage(1_000, 9_999), 'anthropic', 'claude-3-5-sonnet', 'tenant-a');
    // Should clamp to 1_000 → uncached = (1_000/1000)*0.003 = 0.003, savings = 0.0027
    expect(metrics.getCounterTotal('prompt_cache_tokens_read_total')).toBe(1_000);
    expect(metrics.getCounterTotal('prompt_cache_dollars_uncached_equivalent_total')).toBeCloseTo(0.003, 6);
    expect(metrics.getCounterTotal('prompt_cache_cost_saved_usd_total')).toBeCloseTo(0.0027, 6);
  });

  it('strips the @tier suffix from modelId before looking up pricing', () => {
    metrics.recordPromptCacheSavings(usage(10_000, 5_000), 'anthropic', 'claude-3-5-sonnet@eco', 'tenant-a');
    // Same numbers as the known-model test (proves the strip works)
    expect(metrics.getCounterTotal('prompt_cache_cost_saved_usd_total')).toBeCloseTo(0.0135, 6); // (5/1000)*0.003 - (5/1000)*0.0003
  });

  it('omits the tenant label when tenantId is undefined', () => {
    metrics.recordPromptCacheSavings(usage(10_000, 5_000), 'anthropic', 'claude-3-5-sonnet');
    const lines = metrics.exportOpenMetrics().split('\n');
    const dollarLine = lines.find((l) => l.startsWith('prompt_cache_cost_saved_usd_total{'));
    expect(dollarLine).toBeDefined();
    expect(dollarLine).not.toContain('tenant=');
    expect(dollarLine).toContain('provider="anthropic"');
  });
});

describe('recordPromptPrefixCache (public API — unchanged)', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    resetMetricsCollector();
    metrics = new MetricsCollector();
  });

  it('still increments prompt_prefix_cache_total with outcome=hit|miss', () => {
    metrics.recordPromptPrefixCache(true, 'tenant-x');
    metrics.recordPromptPrefixCache(false, 'tenant-x');
    metrics.recordPromptPrefixCache(true, 'tenant-x');
    // hits
    expect(metrics.getCounter('prompt_prefix_cache_total', [{ name: 'outcome', value: 'hit' }])).toBe(2);
    // misses
    expect(metrics.getCounter('prompt_prefix_cache_total', [{ name: 'outcome', value: 'miss' }])).toBe(1);
  });

  it('works without a tenantId', () => {
    metrics.recordPromptPrefixCache(true);
    expect(metrics.getCounter('prompt_prefix_cache_total', [{ name: 'outcome', value: 'hit' }])).toBe(1);
  });
});

describe('CostDashboard surfaces the new fields', () => {
  let metrics: MetricsCollector;
  let dashboard: CostDashboard;

  beforeEach(() => {
    resetMetricsCollector();
    resetCostModel();
    resetCostDashboard();
    metrics = getMetricsCollector();
    // Seed both the local hash-key counter and the new provider-reported counters.
    metrics.recordPromptPrefixCache(true, 'tenant-a');
    metrics.recordPromptPrefixCache(true, 'tenant-a');
    metrics.recordPromptPrefixCache(false, 'tenant-a');
    metrics.incrementCounter('prompt_cache_tokens_read_total', 'seed', 12_345, [{ name: 'provider', value: 'anthropic' }]);
    metrics.incrementCounter('prompt_cache_dollars_uncached_equivalent_total', 'seed', 0.045, [{ name: 'provider', value: 'anthropic' }]);
    metrics.incrementCounter('prompt_cache_cost_saved_usd_total', 'seed', 0.0405, [{ name: 'provider', value: 'anthropic' }]);
    dashboard = new CostDashboard();
  });

  it('summary.promptCacheSavingsUsd reads the new counter', async () => {
    const report = await dashboard.generateReport();
    expect(report.summary.promptCacheSavingsUsd).toBeCloseTo(0.0405, 6);
  });

  it('summary.cacheSavingsUsd sums semantic + prompt-cache (semantic is 0 here)', async () => {
    const report = await dashboard.generateReport();
    expect(report.summary.cacheSavingsUsd).toBeCloseTo(0.0405, 6);
  });

  it('cachePerformance.promptCache has hits/misses/hitRate/tokensCached/dollarsSaved', async () => {
    const report = await dashboard.generateReport();
    const pc = report.cachePerformance.promptCache;
    expect(pc.hits).toBe(2);
    expect(pc.misses).toBe(1);
    expect(pc.hitRate).toBeCloseTo(2 / 3, 6);
    expect(pc.tokensCached).toBe(12_345);
    expect(pc.dollarsSaved).toBeCloseTo(0.0405, 6);
  });
});

describe('CostModel.getSavingsForCachedReads (pure)', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('returns all-zero shape when cachedTokens <= 0', () => {
    const cm = new CostModel();
    expect(cm.getSavingsForCachedReads('anthropic', 'claude-3-5-sonnet', 0, 1000)).toEqual({
      cachedClamped: 0,
      dollarsSaved: 0,
      dollarsUncachedEquivalent: 0,
    });
  });

  it('matches the documented 10x ratio for claude-3-5-sonnet at 10K tokens', () => {
    const cm = new CostModel();
    const r = cm.getSavingsForCachedReads('anthropic', 'claude-3-5-sonnet', 10_000, 12_000);
    expect(r.cachedClamped).toBe(10_000);
    expect(r.dollarsUncachedEquivalent).toBeCloseTo(0.030, 6);
    expect(r.dollarsSaved).toBeCloseTo(0.027, 6);
  });

  it('clamps cachedTokens to inputTokens', () => {
    const cm = new CostModel();
    const r = cm.getSavingsForCachedReads('anthropic', 'claude-3-5-sonnet', 9_999, 1_000);
    expect(r.cachedClamped).toBe(1_000);
  });
});
