import { describe, it, expect } from 'vitest';
import { strategyPerformanceTrackerModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/strategyPerformanceTracker';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('strategyPerformanceTracker module', () => {
  it('has required shape', () => {
    expect(strategyPerformanceTrackerModule.id).toBe('strategyPerformanceTracker');
    expect(strategyPerformanceTrackerModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats success-rate-only baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'strategyPerformanceTracker', mode: 'scripted', n: 30, seed: 42 },
      strategyPerformanceTrackerModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
