import { describe, it, expect } from 'vitest';
import { executionRouterModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/executionRouter';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

const responses: Record<string, string> = {
  'Say hello to the user': 'SINGLE',
  'Write a single utility function': 'SINGLE',
  'Research five topics in parallel': 'MULTI',
  'Process three independent data files': 'MULTI',
  'Summarize this medical record': 'LOCAL',
};

describe('executionRouter module', () => {
  it('has required shape', () => {
    expect(executionRouterModule.id).toBe('executionRouter');
    expect(executionRouterModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats fixed single-agent baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'executionRouter', mode: 'scripted', n: 30, seed: 42 },
      executionRouterModule,
      () => createScriptedLLM({ responses, defaultResponse: 'SINGLE' }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
