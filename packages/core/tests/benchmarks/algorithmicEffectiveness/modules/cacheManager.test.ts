import { describe, it, expect } from 'vitest';
import {
  cacheManagerModule,
  SCRIPTED_RESPONSES,
} from '../../../../src/benchmarks/algorithmicEffectiveness/modules/cacheManager';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('cacheManager module', () => {
  it('has required shape', () => {
    expect(cacheManagerModule.id).toBe('cacheManager');
    expect(cacheManagerModule.taskSuite.length).toBeGreaterThan(0);
    expect(cacheManagerModule.metrics).toContain('cost');
    expect(cacheManagerModule.metrics).toContain('latency');
  });

  it('is significantly better than the no-cache baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'cacheManager', mode: 'scripted', n: 30, seed: 42 },
      cacheManagerModule,
      () => createScriptedLLM({ responses: SCRIPTED_RESPONSES }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
