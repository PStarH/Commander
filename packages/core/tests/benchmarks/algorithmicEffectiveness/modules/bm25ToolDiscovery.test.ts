import { describe, it, expect } from 'vitest';
import { bm25ToolDiscoveryModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/bm25ToolDiscovery';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('bm25ToolDiscovery module', () => {
  it('has required shape', () => {
    expect(bm25ToolDiscoveryModule.id).toBe('bm25ToolDiscovery');
    expect(bm25ToolDiscoveryModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('discovers relevant tools significantly better than fixed activation in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'bm25ToolDiscovery', mode: 'scripted', n: 30, seed: 42 },
      bm25ToolDiscoveryModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
    expect(result.treatment.mean).toBeGreaterThan(result.baseline.mean);
  });
});
