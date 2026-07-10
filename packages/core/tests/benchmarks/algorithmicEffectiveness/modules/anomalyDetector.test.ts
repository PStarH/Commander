import { describe, it, expect } from 'vitest';
import { anomalyDetectorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/anomalyDetector';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('anomalyDetector module', () => {
  it('has required shape', () => {
    expect(anomalyDetectorModule.id).toBe('anomalyDetector');
    expect(anomalyDetectorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed 2x global-average baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'anomalyDetector', mode: 'scripted', n: 30, seed: 42 },
      anomalyDetectorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
    expect(result.treatment.mean).toBeGreaterThan(result.baseline.mean);
  });
});
