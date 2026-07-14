import { describe, expect, it } from 'vitest';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';
import { reversibilityGateModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/reversibilityGate';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';

describe('algorithmicEffectiveness: reversibilityGate', () => {
  it('has required shape', () => {
    expect(reversibilityGateModule.id).toBe('reversibilityGate');
    expect(reversibilityGateModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('blocks irreversible tools while allowing reversible ones', async () => {
    const result = await runComparison(
      { moduleId: 'reversibilityGate', mode: 'scripted', n: 30, seed: 42 },
      reversibilityGateModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  }, 30_000);
});
