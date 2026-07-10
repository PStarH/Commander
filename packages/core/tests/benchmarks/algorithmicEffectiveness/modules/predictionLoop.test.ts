import { describe, it, expect } from 'vitest';
import { predictionLoopModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/predictionLoop';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('predictionLoop module', () => {
  it('has required shape', () => {
    expect(predictionLoopModule.id).toBe('predictionLoop');
    expect(predictionLoopModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats no-prediction baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'predictionLoop', mode: 'scripted', n: 30, seed: 42 },
      predictionLoopModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
