import { describe, it, expect } from 'vitest';
import { fusionEngineModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/fusionEngine';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('fusionEngine module', () => {
  it('has required shape', () => {
    expect(fusionEngineModule.id).toBe('fusionEngine');
    expect(fusionEngineModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats naive first-node baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'fusionEngine', mode: 'scripted', n: 30, seed: 42 },
      fusionEngineModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
