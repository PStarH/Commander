import { describe, it, expect } from 'vitest';
import { llmRetryModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/llmRetry';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('llmRetry module', () => {
  it('has required shape', () => {
    expect(llmRetryModule.id).toBe('llmRetry');
    expect(llmRetryModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats naive fixed-delay baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'llmRetry', mode: 'scripted', n: 30, seed: 42 },
      llmRetryModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
