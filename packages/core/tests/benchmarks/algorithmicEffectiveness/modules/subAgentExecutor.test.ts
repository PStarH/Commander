import { describe, it, expect } from 'vitest';
import { subAgentExecutorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/subAgentExecutor';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('subAgentExecutor module', () => {
  it('has required shape', () => {
    expect(subAgentExecutorModule.id).toBe('subAgentExecutor');
    expect(subAgentExecutorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats single-agent baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'subAgentExecutor', mode: 'scripted', n: 10, seed: 42 },
      subAgentExecutorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
