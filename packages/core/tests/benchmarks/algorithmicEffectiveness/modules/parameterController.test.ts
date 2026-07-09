import { describe, it, expect } from 'vitest';
import { parameterControllerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/parameterController';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('parameterController module', () => {
  it('has required shape', () => {
    expect(parameterControllerModule.id).toBe('parameterController');
    expect(parameterControllerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed sampling baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'parameterController', mode: 'scripted', n: 30, seed: 42 },
      parameterControllerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
