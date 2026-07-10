import { describe, it, expect } from 'vitest';
import { qualityGatesModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/qualityGates';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('qualityGates module', () => {
  it('has required shape', () => {
    expect(qualityGatesModule.id).toBe('qualityGates');
    expect(qualityGatesModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats no-gate baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'qualityGates', mode: 'scripted', n: 30, seed: 42 },
      qualityGatesModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
