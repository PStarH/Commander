import { describe, it, expect } from 'vitest';
import { circuitBreakerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/circuitBreaker';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('circuitBreaker module', () => {
  it('has required shape', () => {
    expect(circuitBreakerModule.id).toBe('circuitBreaker');
    expect(circuitBreakerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats unprotected baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'circuitBreaker', mode: 'scripted', n: 30, seed: 42 },
      circuitBreakerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
