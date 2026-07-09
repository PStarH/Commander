import { describe, it, expect } from 'vitest';
import { modelRouterModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/modelRouter';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('modelRouter module', () => {
  it('has required shape', () => {
    expect(modelRouterModule.id).toBe('modelRouter');
    expect(modelRouterModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats single cheapest-model baseline with cascade in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'modelRouter', mode: 'scripted', n: 30, seed: 42 },
      modelRouterModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
