import { describe, it, expect } from 'vitest';
import { tokenGovernorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/tokenGovernor';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('tokenGovernor module', () => {
  it('has required shape', () => {
    expect(tokenGovernorModule.id).toBe('tokenGovernor');
    expect(tokenGovernorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('keeps more runs within budget than the ungoverned baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'tokenGovernor', mode: 'scripted', n: 30, seed: 42 },
      tokenGovernorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
    expect(result.treatment.mean).toBeGreaterThan(result.baseline.mean);
  });
});
