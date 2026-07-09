import { describe, it, expect } from 'vitest';
import { tokenSentinelModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/tokenSentinel';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('tokenSentinel module', () => {
  it('has required shape', () => {
    expect(tokenSentinelModule.id).toBe('tokenSentinel');
    expect(tokenSentinelModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats the naive char/4 baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'tokenSentinel', mode: 'scripted', n: 30, seed: 42 },
      tokenSentinelModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
    expect(result.treatment.mean).toBeGreaterThan(result.baseline.mean);
  });
});
