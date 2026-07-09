import { describe, it, expect } from 'vitest';
import { metaLearnerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/metaLearner';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('metaLearner module', () => {
  it('has required shape', () => {
    expect(metaLearnerModule.id).toBe('metaLearner');
    expect(metaLearnerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed strategy baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'metaLearner', mode: 'scripted', n: 30, seed: 42 },
      metaLearnerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
