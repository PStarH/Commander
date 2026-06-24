import { describe, it, expect, beforeEach } from 'vitest';
import {
  CostModel,
  getCostModel,
  resetCostModel,
  DEFAULT_PRICING,
} from '../src/costModel';

describe('CostModel', () => {
  let model: CostModel;

  beforeEach(() => {
    resetCostModel();
    model = new CostModel();
  });

  describe('constructor + getPricing', () => {
    it('returns known pricing for openai gpt-4o', () => {
      const p = model.getPricing('openai', 'gpt-4o');
      expect(p.provider).toBe('openai');
      expect(p.model).toBe('gpt-4o');
      expect(p.inputPer1k).toBe(0.0025);
      expect(p.outputPer1k).toBe(0.01);
    });

    it('returns known pricing for anthropic claude-3-5-sonnet', () => {
      const p = model.getPricing('anthropic', 'claude-3-5-sonnet');
      expect(p.provider).toBe('anthropic');
      expect(p.inputPer1k).toBe(0.003);
    });

    it('falls back to prefix match for unknown model variants', () => {
      const p = model.getPricing('openai', 'gpt-4o-2024-08-06');
      expect(p.model).toBe('gpt-4o');
    });

    it('returns fallback pricing for completely unknown model', () => {
      const p = model.getPricing('unknown-provider', 'unknown-model');
      expect(p.provider).toBe('unknown');
      expect(p.inputPer1k).toBe(0.001);
    });
  });

  describe('calculate', () => {
    it('computes correct cost for a simple call', () => {
      const cost = model.calculate('openai', 'gpt-4o', {
        input: 1000,
        output: 500,
        cached: 0,
        reasoning: 0,
        total: 1500,
      });
      expect(cost.inputCostUsd).toBeCloseTo(0.0025);
      expect(cost.outputCostUsd).toBeCloseTo(0.005);
      expect(cost.totalCostUsd).toBeCloseTo(0.0075);
    });

    it('applies cached token discount', () => {
      const cost = model.calculate('openai', 'gpt-4o', {
        input: 1000,
        output: 0,
        cached: 500,
        reasoning: 0,
        total: 1000,
      });
      expect(cost.inputCostUsd).toBeCloseTo(0.00125);
      expect(cost.cachedCostUsd).toBeCloseTo(0.000625);
      expect(cost.totalCostUsd).toBeCloseTo(0.001875);
    });

    it('clamps cached tokens to input tokens', () => {
      const cost = model.calculate('openai', 'gpt-4o', {
        input: 100,
        output: 0,
        cached: 200,
        reasoning: 0,
        total: 100,
      });
      expect(cost.inputCostUsd).toBeCloseTo(0);
      expect(cost.cachedCostUsd).toBeCloseTo(0.000125);
    });

    it('handles reasoning tokens for o1 model', () => {
      const cost = model.calculate('openai', 'o1', {
        input: 1000,
        output: 500,
        cached: 0,
        reasoning: 2000,
        total: 3500,
      });
      expect(cost.reasoningCostUsd).toBeCloseTo(0.12);
      expect(cost.totalCostUsd).toBeGreaterThan(0.12);
    });
  });

  describe('addPricing', () => {
    it('adds custom pricing', () => {
      model.addPricing({
        provider: 'custom',
        model: 'my-model',
        inputPer1k: 0.01,
        outputPer1k: 0.02,
      });
      const p = model.getPricing('custom', 'my-model');
      expect(p.inputPer1k).toBe(0.01);
    });

    it('overrides existing pricing', () => {
      model.addPricing({
        provider: 'openai',
        model: 'gpt-4o',
        inputPer1k: 999,
        outputPer1k: 999,
      });
      const p = model.getPricing('openai', 'gpt-4o');
      expect(p.inputPer1k).toBe(999);
    });
  });

  describe('emptyCost / emptyTokens / addCost / addTokens', () => {
    it('emptyCost returns zeros', () => {
      const cost = model.emptyCost();
      expect(cost.totalCostUsd).toBe(0);
      expect(cost.inputCostUsd).toBe(0);
      expect(cost.outputCostUsd).toBe(0);
    });

    it('emptyTokens returns zeros', () => {
      const tokens = model.emptyTokens();
      expect(tokens.input).toBe(0);
      expect(tokens.output).toBe(0);
      expect(tokens.total).toBe(0);
    });

    it('addCost sums costs', () => {
      const a = { totalCostUsd: 0.1, inputCostUsd: 0.05, outputCostUsd: 0.05 };
      const b = { totalCostUsd: 0.2, inputCostUsd: 0.1, outputCostUsd: 0.1 };
      const result = model.addCost(a, b);
      expect(result.totalCostUsd).toBeCloseTo(0.3);
    });

    it('addTokens sums tokens', () => {
      const a = model.emptyTokens();
      const b = { input: 100, output: 50, cached: 10, reasoning: 20, total: 180 };
      const result = model.addTokens(a, b);
      expect(result.input).toBe(100);
      expect(result.total).toBe(180);
    });
  });

  describe('getSavingsForCachedReads', () => {
    it('returns zero for no cached tokens', () => {
      const savings = model.getSavingsForCachedReads('openai', 'gpt-4o', 0, 1000);
      expect(savings.cachedClamped).toBe(0);
      expect(savings.dollarsSaved).toBe(0);
    });

    it('computes savings correctly', () => {
      const savings = model.getSavingsForCachedReads('openai', 'gpt-4o', 500, 1000);
      expect(savings.cachedClamped).toBe(500);
      expect(savings.dollarsSaved).toBeGreaterThan(0);
    });

    it('clamps cached to input', () => {
      const savings = model.getSavingsForCachedReads('openai', 'gpt-4o', 2000, 1000);
      expect(savings.cachedClamped).toBe(1000);
    });

    it('strips @tier suffix from model', () => {
      const savings = model.getSavingsForCachedReads('anthropic', 'claude-3-5-sonnet@eco', 500, 1000);
      expect(savings.cachedClamped).toBe(500);
      expect(savings.dollarsSaved).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_PRICING', () => {
    it('has pricing for major providers', () => {
      const providers = new Set(DEFAULT_PRICING.map((p) => p.provider));
      expect(providers.has('openai')).toBe(true);
      expect(providers.has('anthropic')).toBe(true);
      expect(providers.has('google')).toBe(true);
      expect(providers.has('deepseek')).toBe(true);
    });
  });
});

describe('getCostModel / resetCostModel', () => {
  beforeEach(() => {
    resetCostModel();
  });

  it('returns the same instance on repeated calls', () => {
    const a = getCostModel();
    const b = getCostModel();
    expect(a).toBe(b);
  });

  it('returns a new instance after reset', () => {
    const a = getCostModel();
    resetCostModel();
    const b = getCostModel();
    expect(a).not.toBe(b);
  });
});
