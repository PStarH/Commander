import { describe, it, expect } from 'vitest';
import { trajectoryAnalyzerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/trajectoryAnalyzer';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('trajectoryAnalyzer module', () => {
  it('has required shape', () => {
    expect(trajectoryAnalyzerModule.id).toBe('trajectoryAnalyzer');
    expect(trajectoryAnalyzerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats heuristic light-mode baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'trajectoryAnalyzer', mode: 'scripted', n: 30, seed: 42 },
      trajectoryAnalyzerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
