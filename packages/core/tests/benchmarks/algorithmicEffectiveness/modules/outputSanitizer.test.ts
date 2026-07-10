import { describe, it, expect } from 'vitest';
import { outputSanitizerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/outputSanitizer';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('outputSanitizer module', () => {
  it('has required shape', () => {
    expect(outputSanitizerModule.id).toBe('outputSanitizer');
    expect(outputSanitizerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats the no-op baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'outputSanitizer', mode: 'scripted', n: 30, seed: 42 },
      outputSanitizerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
