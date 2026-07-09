import { describe, it, expect } from 'vitest';
import { strategySelectorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/strategySelector';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('strategySelector module', () => {
  it('has required shape', () => {
    expect(strategySelectorModule.id).toBe('strategySelector');
    expect(strategySelectorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed strategy baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'strategySelector', mode: 'scripted', n: 30, seed: 42 },
      strategySelectorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
