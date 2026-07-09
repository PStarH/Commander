import { describe, it, expect } from 'vitest';
import { speculativeExecutorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/speculativeExecutor';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('speculativeExecutor module', () => {
  it('has required shape', () => {
    expect(speculativeExecutorModule.id).toBe('speculativeExecutor');
    expect(speculativeExecutorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats no-speculation baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'speculativeExecutor', mode: 'scripted', n: 30, seed: 42 },
      speculativeExecutorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
