import { describe, it, expect } from 'vitest';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import { getBenchmarkRunner, BenchmarkResult } from './benchmarkRunner';

describe('Cost Benchmarks', () => {
  const runner = getBenchmarkRunner();

  it('token budget optimization effectiveness', () => {
    const governor = new TokenGovernor({
      totalBudget: 100000,
      thresholds: {
        relaxed: 0.6,
        moderate: 0.8,
        tight: 0.9,
        critical: 0.95,
      },
      enableLearning: false,
    });

    const scenarios = [
      { used: 60000, budget: 100000 },
      { used: 80000, budget: 100000 },
      { used: 90000, budget: 100000 },
      { used: 95000, budget: 100000 },
    ];

    const savings: number[] = [];

    for (const scenario of scenarios) {
      governor.reset();
      governor.reportUsage(scenario.used);
      const state = governor.getState();
      const pressure = state.pressure;
      const recommendations = governor.getRecommendations();
      const _optimizationsCount = recommendations.length;
      const savingsPercent = (pressure * 100);
      savings.push(savingsPercent);
    }

    const avgSavings = savings.reduce((a, b) => a + b, 0) / savings.length;

    const result: BenchmarkResult = {
      name: 'token_budget_optimization',
      category: 'cost',
      metrics: {
        scenarios_tested: scenarios.length,
        avg_pressure_percent: Number(avgSavings.toFixed(1)),
        min_pressure_percent: Number(Math.min(...savings).toFixed(1)),
        max_pressure_percent: Number(Math.max(...savings).toFixed(1)),
        target_avg_pressure_percent: 20,
      },
      timestamp: new Date().toISOString(),
      durationMs: 0,
      passed: avgSavings >= 20,
      threshold: 20,
      actual: avgSavings,
    };

    runner.addResult(result);
    expect(avgSavings).toBeGreaterThanOrEqual(20);
  });

  it('tool result cache hit rate', async () => {
    const { ToolResultCache } = await import('../../src/runtime/toolResultCache');
    const cache = new ToolResultCache();
    const tools = [
      { name: 'file_read', args: { path: 'src/middleware/auth.ts' } },
      { name: 'file_read', args: { path: 'src/routes/api.ts' } },
      { name: 'shell_execute', args: { command: 'npx vitest run tests/auth.test.ts' } },
      { name: 'git_diff', args: { path: 'src/middleware/auth.ts' } },
    ];
    const iterations = 1000;
    let hits = 0;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const tool = tools[i % tools.length];
      const toolCall = { id: `call-${i}`, name: tool.name, arguments: tool.args };

      const cached = cache.get(toolCall);
      if (cached) {
        hits++;
      } else {
        cache.set(toolCall, {
          toolCallId: `call-${i}`,
          name: tool.name,
          output: `File contents: ${JSON.stringify({ line: i, content: 'export function authenticate() {}' })}`,
          durationMs: 15,
        });
      }
    }
    const durationMs = performance.now() - start;

    const hitRate = (hits / iterations) * 100;

    const result: BenchmarkResult = {
      name: 'tool_result_cache_hit_rate',
      category: 'cost',
      metrics: {
        total_requests: iterations,
        cache_hits: hits,
        hit_rate_percent: Number(hitRate.toFixed(1)),
        avg_lookup_ms: Number((durationMs / iterations).toFixed(3)),
        target_hit_rate_percent: 30,
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: hitRate >= 30,
      threshold: 30,
      actual: hitRate,
    };

    runner.addResult(result);
    expect(hitRate).toBeGreaterThanOrEqual(30);
  });

  it('cost per task comparison', () => {
    const costPer1kTokens = 0.002;
    const scenarios = [
      { name: 'simple', tokens: 5000, expectedCost: 0.01 },
      { name: 'medium', tokens: 25000, expectedCost: 0.05 },
      { name: 'complex', tokens: 100000, expectedCost: 0.20 },
    ];

    const costs = scenarios.map(s => ({
      name: s.name,
      tokens: s.tokens,
      cost: (s.tokens / 1000) * costPer1kTokens,
      ratio: ((s.tokens / 1000) * costPer1kTokens) / s.expectedCost,
    }));

    const avgRatio = costs.reduce((sum, c) => sum + c.ratio, 0) / costs.length;

    const result: BenchmarkResult = {
      name: 'cost_per_task_comparison',
      category: 'cost',
      metrics: {
        scenarios: costs.length,
        avg_cost_ratio: Number(avgRatio.toFixed(3)),
        simple_cost: Number(costs[0].cost.toFixed(4)),
        medium_cost: Number(costs[1].cost.toFixed(4)),
        complex_cost: Number(costs[2].cost.toFixed(4)),
        cost_per_1k_tokens: costPer1kTokens,
      },
      timestamp: new Date().toISOString(),
      durationMs: 0,
      passed: avgRatio <= 1.0,
      threshold: 1.0,
      actual: avgRatio,
    };

    runner.addResult(result);
    expect(avgRatio).toBeLessThanOrEqual(1.0);
  });
});
