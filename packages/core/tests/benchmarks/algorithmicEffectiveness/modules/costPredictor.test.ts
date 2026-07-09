import { describe, it, expect } from 'vitest';
import { costPredictorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/costPredictor';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('costPredictor module', () => {
  it('has required shape', () => {
    expect(costPredictorModule.id).toBe('costPredictor');
    expect(costPredictorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats flat-rate baseline with historical cost records in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'costPredictor', mode: 'scripted', n: 30, seed: 42 },
      costPredictorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
