import { describe, it, expect } from 'vitest';
import { samplingPolicyModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/samplingPolicy';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('samplingPolicy module', () => {
  it('has required shape', () => {
    expect(samplingPolicyModule.id).toBe('samplingPolicy');
    expect(samplingPolicyModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('retains significantly more critical traces than fixed-probability head sampling', async () => {
    const result = await runComparison(
      { moduleId: 'samplingPolicy', mode: 'scripted', n: 30, seed: 42 },
      samplingPolicyModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
