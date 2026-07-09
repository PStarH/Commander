import { describe, it, expect } from 'vitest';
import { effortScalerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/effortScaler';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('effortScaler module', () => {
  it('has required shape', () => {
    expect(effortScalerModule.id).toBe('effortScaler');
    expect(effortScalerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats naive length/keyword heuristic in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'effortScaler', mode: 'scripted', n: 30, seed: 42 },
      effortScalerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
