import { describe, it, expect } from 'vitest';
import { deliberationModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/deliberation';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('deliberation module', () => {
  it('has required shape', () => {
    expect(deliberationModule.id).toBe('deliberation');
    expect(deliberationModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed-topology baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'deliberation', mode: 'scripted', n: 30, seed: 42 },
      deliberationModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
