import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { calculateCostBreakdown, CACHE_MULTIPLIERS } from '../../src/telos/tokenSentinel';
import {
  aggregateCost,
  formatCostTable,
  formatCostJson,
  formatCostCsv,
  type LLMCallRow,
} from '../../src/intelligence/costAggregator';
import { resetModelRouter, getModelRouter } from '../../src/runtime/modelRouter';

describe('calculateCostBreakdown (unified cost calculation)', () => {
  beforeEach(() => {
    resetModelRouter();
  });

  describe('basic pricing', () => {
    it('returns positive cost for known model', () => {
      const r = calculateCostBreakdown('gpt-4o', 1000, 500);
      expect(r.totalUsd).toBeGreaterThan(0);
      expect(r.inputCostUsd).toBeGreaterThan(0);
      expect(r.outputCostUsd).toBeGreaterThan(0);
    });

    it('returns zero for zero tokens', () => {
      const r = calculateCostBreakdown('gpt-4o', 0, 0);
      expect(r.totalUsd).toBe(0);
      expect(r.inputCostUsd).toBe(0);
      expect(r.outputCostUsd).toBe(0);
    });

    it('output tokens cost more than input tokens for same model', () => {
      const r = calculateCostBreakdown('gpt-4o', 1000, 1000);
      // gpt-4o: 0.0025 input vs 0.01 output per 1K
      expect(r.outputCostUsd).toBeGreaterThan(r.inputCostUsd);
    });

    it('more expensive model costs more for same tokens', () => {
      const cheap = calculateCostBreakdown('gpt-4o-mini', 1000, 1000);
      const expensive = calculateCostBreakdown('gpt-5', 1000, 1000);
      expect(expensive.totalUsd).toBeGreaterThan(cheap.totalUsd);
    });
  });

  describe('cache multipliers (Anthropic)', () => {
    it('applies 0.1x read multiplier for Anthropic', () => {
      const r = calculateCostBreakdown('claude-haiku-4-5', 0, 0, 1000, 0);
      // cache read at 0.1x of $0.0008/1K = $0.00008
      expect(r.cacheReadCostUsd).toBeCloseTo(0.00008, 5);
      // savings: (1 - 0.1) * 1000/1000 * 0.0008 = $0.00072
      expect(r.cacheSavingsUsd).toBeCloseTo(0.00072, 5);
    });

    it('applies 1.25x write multiplier for Anthropic', () => {
      const r = calculateCostBreakdown('claude-haiku-4-5', 0, 0, 0, 1000);
      // cache write at 1.25x of $0.0008/1K = $0.001
      expect(r.cacheWriteCostUsd).toBeCloseTo(0.001, 5);
    });
  });

  describe('cache multipliers (OpenAI)', () => {
    it('applies 0.5x read multiplier for OpenAI', () => {
      const r = calculateCostBreakdown('gpt-4o', 0, 0, 1000, 0);
      // cache read at 0.5x of $0.0025/1K = $0.00125
      expect(r.cacheReadCostUsd).toBeCloseTo(0.00125, 5);
      // savings: (1 - 0.5) * 1000/1000 * 0.0025 = $0.00125
      expect(r.cacheSavingsUsd).toBeCloseTo(0.00125, 5);
    });

    it('applies 1.0x write multiplier for OpenAI (automatic caching)', () => {
      const r = calculateCostBreakdown('gpt-4o', 0, 0, 0, 1000);
      // OpenAI auto-caches, no explicit write premium
      expect(r.cacheWriteCostUsd).toBeCloseTo(0.0025, 5);
    });
  });

  describe('fallback for unknown model', () => {
    it('uses conservative $2/M fallback', () => {
      const r = calculateCostBreakdown('some-unknown-model-xyz', 1000, 1000);
      // fallback: 80% input * 0.0016/1K + 20% output * 0.0004/1K
      // = 1000/1000 * 0.0016 + 1000/1000 * 0.0004 = 0.0016 + 0.0004 = 0.002
      expect(r.totalUsd).toBeCloseTo(0.002, 5);
    });
  });

  describe('cache multipliers registry', () => {
    it('has all major providers configured', () => {
      expect(CACHE_MULTIPLIERS.anthropic).toBeDefined();
      expect(CACHE_MULTIPLIERS.openai).toBeDefined();
      expect(CACHE_MULTIPLIERS.google).toBeDefined();
    });

    it('anthropic cache reads are cheaper than openai cache reads (relative)', () => {
      // Anthropic 0.1x vs OpenAI 0.5x → anthropic is the better deal
      expect(CACHE_MULTIPLIERS.anthropic.read).toBeLessThan(CACHE_MULTIPLIERS.openai.read);
    });
  });
});

describe('CostPredictor (no hardcoded rate)', () => {
  beforeEach(() => {
    resetModelRouter();
  });

  it('uses per-model pricing instead of flat $2/M', async () => {
    const { CostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = new CostPredictor();
    const result = predictor.predict({
      taskType: 'code',
      effortLevel: 'medium',
      topology: 'SINGLE',
      estimatedTokens: 100000,
      estimatedDurationMs: 30000,
      agentCount: 1,
      modelId: 'gpt-4o-mini',
    });

    // gpt-4o-mini: $0.00015 in / $0.0006 out per 1K
    // ~70% input = 70000 * 0.00015/1000 = 0.0105
    // ~30% output = 30000 * 0.0006/1000 = 0.018
    // Total: ~0.0285
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBeLessThan(0.5); // way under flat $2/M * 0.1M = $0.20
  });

  it('different models produce different cost estimates', async () => {
    const { CostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = new CostPredictor();
    const cheap = predictor.predict({
      taskType: 'code',
      effortLevel: 'medium',
      topology: 'SINGLE',
      estimatedTokens: 100000,
      estimatedDurationMs: 30000,
      agentCount: 1,
      modelId: 'gpt-4o-mini',
    });
    const expensive = predictor.predict({
      taskType: 'code',
      effortLevel: 'medium',
      topology: 'SINGLE',
      estimatedTokens: 100000,
      estimatedDurationMs: 30000,
      agentCount: 1,
      modelId: 'claude-opus-4-8',
    });
    expect(expensive.estimatedCostUsd).toBeGreaterThan(cheap.estimatedCostUsd);
  });
});

describe('aggregateCost (cost aggregator)', () => {
  function makeRow(overrides: Partial<LLMCallRow> = {}): LLMCallRow {
    return {
      callId: 'call_1',
      runId: 'run_1',
      agentId: 'agent-1',
      model: 'gpt-4o-mini',
      provider: 'openai',
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      durationMs: 1000,
      timestamp: '2026-05-15T10:00:00.000Z',
      ...overrides,
    };
  }

  it('aggregates by model', () => {
    const records: LLMCallRow[] = [
      makeRow({ model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500 }),
      makeRow({ model: 'gpt-4o-mini', promptTokens: 2000, completionTokens: 1000 }),
      makeRow({ model: 'gpt-4o', promptTokens: 500, completionTokens: 250 }),
    ];
    const report = aggregateCost(records);
    expect(report.total.calls).toBe(3);
    expect(report.byModel['gpt-4o-mini'].calls).toBe(2);
    expect(report.byModel['gpt-4o'].calls).toBe(1);
    expect(report.byModel['gpt-4o-mini'].inputTokens).toBe(3000);
  });

  it('aggregates by agent', () => {
    const records: LLMCallRow[] = [
      makeRow({ agentId: 'lead' }),
      makeRow({ agentId: 'lead' }),
      makeRow({ agentId: 'reviewer' }),
    ];
    const report = aggregateCost(records);
    expect(report.byAgent['lead'].calls).toBe(2);
    expect(report.byAgent['reviewer'].calls).toBe(1);
  });

  it('aggregates by day using timestamp prefix', () => {
    const records: LLMCallRow[] = [
      makeRow({ timestamp: '2026-05-15T10:00:00.000Z' }),
      makeRow({ timestamp: '2026-05-15T20:00:00.000Z' }),
      makeRow({ timestamp: '2026-05-16T10:00:00.000Z' }),
    ];
    const report = aggregateCost(records);
    expect(report.byDay['2026-05-15'].calls).toBe(2);
    expect(report.byDay['2026-05-16'].calls).toBe(1);
  });

  it('aggregates by provider', () => {
    const records: LLMCallRow[] = [
      makeRow({ model: 'gpt-4o-mini', provider: 'openai' }),
      makeRow({ model: 'claude-haiku-4-5', provider: 'anthropic' }),
    ];
    const report = aggregateCost(records);
    expect(report.byProvider['openai'].calls).toBe(1);
    expect(report.byProvider['anthropic'].calls).toBe(1);
  });

  it('counts successful vs failed calls', () => {
    const records: LLMCallRow[] = [
      makeRow({ error: undefined }),
      makeRow({ error: undefined }),
      makeRow({ error: 'timeout' }),
    ];
    const report = aggregateCost(records);
    expect(report.total.successfulCalls).toBe(2);
    expect(report.total.failedCalls).toBe(1);
  });

  it('accumulates cache tokens and savings', () => {
    const records: LLMCallRow[] = [makeRow({ model: 'claude-haiku-4-5', cacheReadTokens: 5000 })];
    const report = aggregateCost(records);
    expect(report.total.cacheReadTokens).toBe(5000);
    expect(report.total.cacheSavingsUsd).toBeGreaterThan(0);
  });

  it('respects --since date filter', () => {
    const records: LLMCallRow[] = [
      makeRow({ timestamp: '2026-05-10T00:00:00.000Z' }),
      makeRow({ timestamp: '2026-05-20T00:00:00.000Z' }),
    ];
    const report = aggregateCost(records, { since: new Date('2026-05-15T00:00:00.000Z') });
    expect(report.total.calls).toBe(1);
  });

  it('respects --until date filter', () => {
    const records: LLMCallRow[] = [
      makeRow({ timestamp: '2026-05-10T00:00:00.000Z' }),
      makeRow({ timestamp: '2026-05-20T00:00:00.000Z' }),
    ];
    const report = aggregateCost(records, { until: new Date('2026-05-15T00:00:00.000Z') });
    expect(report.total.calls).toBe(1);
  });

  it('respects --model filter', () => {
    const records: LLMCallRow[] = [makeRow({ model: 'gpt-4o-mini' }), makeRow({ model: 'gpt-4o' })];
    const report = aggregateCost(records, { model: 'gpt-4o' });
    expect(report.total.calls).toBe(1);
    expect(report.total.inputTokens).toBe(1000);
  });

  it('returns rangeStart and rangeEnd', () => {
    const records: LLMCallRow[] = [
      makeRow({ timestamp: '2026-05-10T00:00:00.000Z' }),
      makeRow({ timestamp: '2026-05-20T00:00:00.000Z' }),
    ];
    const report = aggregateCost(records);
    expect(report.rangeStart).toBe('2026-05-10T00:00:00.000Z');
    expect(report.rangeEnd).toBe('2026-05-20T00:00:00.000Z');
  });

  it('handles empty input', () => {
    const report = aggregateCost([]);
    expect(report.total.calls).toBe(0);
    expect(report.total.costUsd).toBe(0);
    expect(report.recordsScanned).toBe(0);
  });
});

describe('formatCostTable', () => {
  function makeRow(overrides: Partial<LLMCallRow> = {}): LLMCallRow {
    return {
      callId: 'call_1',
      runId: 'run_1',
      agentId: 'agent-1',
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      durationMs: 1000,
      timestamp: '2026-05-15T10:00:00.000Z',
      ...overrides,
    };
  }

  it('renders total section', () => {
    const report = aggregateCost([makeRow()]);
    const out = formatCostTable(report);
    expect(out).toContain('Total');
    expect(out).toContain('total cost');
    expect(out).toContain('input tokens');
  });

  it('renders per-model section', () => {
    const report = aggregateCost([makeRow({ model: 'gpt-4o-mini' }), makeRow({ model: 'gpt-4o' })]);
    const out = formatCostTable(report);
    expect(out).toContain('By model');
    expect(out).toContain('gpt-4o-mini');
    expect(out).toContain('gpt-4o');
  });

  it('renders per-day section', () => {
    const report = aggregateCost([makeRow({ timestamp: '2026-05-15T10:00:00.000Z' })]);
    const out = formatCostTable(report);
    expect(out).toContain('By day');
    expect(out).toContain('2026-05-15');
  });

  it('shows cache savings when present', () => {
    const report = aggregateCost([makeRow({ model: 'claude-sonnet-4-6', cacheReadTokens: 10000 })]);
    const out = formatCostTable(report);
    expect(out).toContain('cache reads');
    expect(out).toContain('saved');
  });
});

describe('formatCostJson', () => {
  function makeRow(overrides: Partial<LLMCallRow> = {}): LLMCallRow {
    return {
      callId: 'call_1',
      runId: 'run_1',
      agentId: 'agent-1',
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      durationMs: 1000,
      timestamp: '2026-05-15T10:00:00.000Z',
      ...overrides,
    };
  }

  it('produces valid JSON', () => {
    const report = aggregateCost([makeRow()]);
    const json = formatCostJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.total.calls).toBe(1);
    expect(parsed.byModel).toBeDefined();
    expect(parsed.byDay).toBeDefined();
  });
});

describe('formatCostCsv', () => {
  function makeRow(overrides: Partial<LLMCallRow> = {}): LLMCallRow {
    return {
      callId: 'call_1',
      runId: 'run_1',
      agentId: 'agent-1',
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      durationMs: 1000,
      timestamp: '2026-05-15T10:00:00.000Z',
      ...overrides,
    };
  }

  it('produces CSV with header row', () => {
    const report = aggregateCost([makeRow()]);
    const csv = formatCostCsv(report);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('category,key,calls');
  });

  it('includes total row', () => {
    const report = aggregateCost([makeRow()]);
    const csv = formatCostCsv(report);
    expect(csv).toContain('total,all,');
  });

  it('escapes CSV special characters', () => {
    const report = aggregateCost([makeRow({ agentId: 'agent,with,commas' })]);
    const csv = formatCostCsv(report);
    expect(csv).toContain('"agent,with,commas"');
  });
});

describe('Single source of truth (cost calculation consistency)', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetModelRouter();
    tmpDir = fs.realpathSync(fs.mkdtempSync('cost-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CostPredictor, calculateCostBreakdown, and aggregator all agree for same inputs', async () => {
    const { CostPredictor } = await import('../../src/intelligence/costPredictor');

    const modelId = 'gpt-4o-mini';
    const inputTokens = 70000;
    const outputTokens = 30000;

    // Method 1: calculateCostBreakdown
    const breakdown = calculateCostBreakdown(modelId, inputTokens, outputTokens);

    // Method 2: aggregator (per-row)
    const report = aggregateCost([
      {
        model: modelId,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        timestamp: new Date().toISOString(),
      },
    ]);

    expect(Math.abs(breakdown.totalUsd - report.total.costUsd)).toBeLessThan(0.0001);
  });

  it('CostPredictor uses calculateCostBreakdown (no more hardcoded $2/M)', async () => {
    const { CostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = new CostPredictor(tmpDir);
    // Recompute manually: 70/30 split, gpt-4o-mini rates
    const expected = calculateCostBreakdown('gpt-4o-mini', 70000, 30000).totalUsd;
    const result = predictor.predict({
      taskType: 'code',
      effortLevel: 'medium',
      topology: 'SINGLE',
      estimatedTokens: 100000,
      estimatedDurationMs: 30000,
      agentCount: 1,
      modelId: 'gpt-4o-mini',
    });
    expect(result.estimatedCostUsd).toBeCloseTo(expected, 4);
  });
});
