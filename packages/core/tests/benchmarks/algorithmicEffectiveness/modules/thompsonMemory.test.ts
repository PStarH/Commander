import { describe, it, expect } from 'vitest';
import { thompsonMemoryModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/thompsonMemory';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('thompsonMemory module', () => {
  it('has required shape', () => {
    expect(thompsonMemoryModule.id).toBe('thompsonMemory');
    expect(thompsonMemoryModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed top-k baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'thompsonMemory', mode: 'scripted', n: 30, seed: 42 },
      thompsonMemoryModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
