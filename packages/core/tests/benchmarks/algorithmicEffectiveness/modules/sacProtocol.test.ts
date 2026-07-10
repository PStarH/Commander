import { describe, it, expect } from 'vitest';
import { sacProtocolModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/sacProtocol';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('sacProtocol module', () => {
  it('has required shape', () => {
    expect(sacProtocolModule.id).toBe('sacProtocol');
    expect(sacProtocolModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats simple majority baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'sacProtocol', mode: 'scripted', n: 30, seed: 42 },
      sacProtocolModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
