import { describe, it, expect } from 'vitest';
import { swarmOrchestratorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/swarmOrchestrator';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('swarmOrchestrator module', () => {
  it('has required shape', () => {
    expect(swarmOrchestratorModule.id).toBe('swarmOrchestrator');
    expect(swarmOrchestratorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats single-turn baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'swarmOrchestrator', mode: 'scripted', n: 30, seed: 42 },
      swarmOrchestratorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
