import { describe, it, expect } from 'vitest';
import { smartModelRouterModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/smartModelRouter';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('smartModelRouter module', () => {
  it('has required shape', () => {
    expect(smartModelRouterModule.id).toBe('smartModelRouter');
    expect(smartModelRouterModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('learns the best model per task type and beats manual mode in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'smartModelRouter', mode: 'scripted', n: 30, seed: 42 },
      smartModelRouterModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
