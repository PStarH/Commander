import { describe, it, expect } from 'vitest';
import { adaptiveStoppingModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/adaptiveStopping';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('adaptiveStopping module', () => {
  it('has required shape', () => {
    expect(adaptiveStoppingModule.id).toBe('adaptiveStopping');
    expect(adaptiveStoppingModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed-round baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'adaptiveStopping', mode: 'scripted', n: 30, seed: 42 },
      adaptiveStoppingModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
