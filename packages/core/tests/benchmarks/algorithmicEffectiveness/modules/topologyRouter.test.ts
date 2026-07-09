import { describe, it, expect } from 'vitest';
import { topologyRouterModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/topologyRouter';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('topologyRouter module', () => {
  it('has required shape', () => {
    expect(topologyRouterModule.id).toBe('topologyRouter');
    expect(topologyRouterModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats epsilon=0 greedy baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'topologyRouter', mode: 'scripted', n: 30, seed: 42 },
      topologyRouterModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
