import { describe, expect, it } from 'vitest';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';
import { securityPrimitivesModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/securityPrimitives';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';

describe('algorithmicEffectiveness: securityPrimitives', () => {
  it('has required shape', () => {
    expect(securityPrimitivesModule.id).toBe('securityPrimitives');
    expect(securityPrimitivesModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('UniversalSanitizer is significantly better than no sanitization', async () => {
    const result = await runComparison(
      { moduleId: 'securityPrimitives', mode: 'scripted', n: 30, seed: 42 },
      securityPrimitivesModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  }, 30_000);
});
