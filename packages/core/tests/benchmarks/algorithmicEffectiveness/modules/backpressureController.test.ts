import { describe, it, expect } from 'vitest';
import { backpressureControllerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/backpressureController';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('backpressureController module', () => {
  it('has required shape', () => {
    expect(backpressureControllerModule.id).toBe('backpressureController');
    expect(backpressureControllerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats unbounded-queue baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'backpressureController', mode: 'scripted', n: 30, seed: 42 },
      backpressureControllerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
