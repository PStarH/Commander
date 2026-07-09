import { describe, it, expect } from 'vitest';
import { dynamicCostGuardianModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/dynamicCostGuardian';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('dynamicCostGuardian module', () => {
  it('has required shape', () => {
    expect(dynamicCostGuardianModule.id).toBe('dynamicCostGuardian');
    expect(dynamicCostGuardianModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats static cost cap baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'dynamicCostGuardian', mode: 'scripted', n: 30, seed: 42 },
      dynamicCostGuardianModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
