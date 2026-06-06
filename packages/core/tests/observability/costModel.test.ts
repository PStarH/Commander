import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { CostModel, getCostModel, resetCostModel } from '../../src/observability/costModel';

describe('CostModel', () => {
  beforeEach(() => resetCostModel());

  it('calculates cost for exact model match', () => {
    const m = new CostModel();
    const r = m.calculate('openai', 'gpt-4o', { input: 1000, output: 500, cached: 0, reasoning: 0, total: 1500 });
    assert.strictEqual(r.inputCostUsd, 0.0025);
    assert.strictEqual(r.outputCostUsd, 0.005);
    assert.strictEqual(r.totalCostUsd, 0.0075);
  });

  it('applies cached input discount when cached tokens are positive', () => {
    const m = new CostModel();
    const r = m.calculate('openai', 'gpt-4o', { input: 1000, output: 0, cached: 1000, reasoning: 0, total: 1000 });
    assert.strictEqual(r.cachedCostUsd, 0.00125);
    assert.strictEqual(r.inputCostUsd, 0);
  });

  it('charges reasoning tokens for o1/o3', () => {
    const m = new CostModel();
    const r = m.calculate('openai', 'o1', { input: 100, output: 100, cached: 0, reasoning: 200, total: 400 });
    assert.strictEqual(r.reasoningCostUsd, 0.012);
  });

  it('falls back to default pricing for unknown models', () => {
    const m = new CostModel();
    const r = m.calculate('mystery', 'gpt-99', { input: 1000, output: 1000, cached: 0, reasoning: 0, total: 2000 });
    assert.strictEqual(r.inputCostUsd, 0.001);
    assert.strictEqual(r.outputCostUsd, 0.002);
  });

  it('prefix-matches for date-stamped model variants', () => {
    const m = new CostModel();
    const r = m.calculate('anthropic', 'claude-3-5-sonnet-20251001', { input: 1000, output: 0, cached: 0, reasoning: 0, total: 1000 });
    assert.ok(r.inputCostUsd > 0, 'should match claude-3.5-sonnet prefix');
  });

  it('aggregates costs with addCost/addTokens', () => {
    const m = new CostModel();
    const t1 = { input: 100, output: 50, cached: 0, reasoning: 0, total: 150 };
    const t2 = { input: 200, output: 100, cached: 0, reasoning: 0, total: 300 };
    const c1 = m.calculate('openai', 'gpt-4o', t1);
    const c2 = m.calculate('openai', 'gpt-4o', t2);
    const sumTokens = m.addTokens(m.emptyTokens(), m.addTokens(t1, t2));
    const sumCost = m.addCost(m.emptyCost(), m.addCost(c1, c2));
    assert.strictEqual(sumTokens.total, 450);
    assert.strictEqual(sumCost.totalCostUsd, c1.totalCostUsd + c2.totalCostUsd);
  });

  it('uses singleton getCostModel', () => {
    const a = getCostModel();
    const b = getCostModel();
    assert.strictEqual(a, b);
    resetCostModel();
    const c = getCostModel();
    assert.notStrictEqual(a, c);
  });
});
