import { describe, it, expect } from 'vitest';
import { providerFallbackChainModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/providerFallbackChain';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('providerFallbackChain module', () => {
  it('has required shape', () => {
    expect(providerFallbackChainModule.id).toBe('providerFallbackChain');
    expect(providerFallbackChainModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats single-provider baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'providerFallbackChain', mode: 'scripted', n: 30, seed: 42 },
      providerFallbackChainModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
