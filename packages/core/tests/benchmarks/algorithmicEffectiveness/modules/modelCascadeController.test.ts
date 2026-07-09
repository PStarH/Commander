import { describe, it, expect } from 'vitest';
import { modelCascadeControllerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/modelCascadeController';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('modelCascadeController module', () => {
  it('has required shape', () => {
    expect(modelCascadeControllerModule.id).toBe('modelCascadeController');
    expect(modelCascadeControllerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats always-strong baseline with a FrugalGPT-style cascade in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'modelCascadeController', mode: 'scripted', n: 30, seed: 42 },
      modelCascadeControllerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
