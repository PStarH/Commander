import { describe, it, expect } from 'vitest';
import { contextCompactorModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/contextCompactor';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('contextCompactor module', () => {
  it('has required shape', () => {
    expect(contextCompactorModule.id).toBe('contextCompactor');
    expect(contextCompactorModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats simple truncation in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'contextCompactor', mode: 'scripted', n: 30, seed: 42 },
      contextCompactorModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });

  it('returns runtime-shaped token usage from the scripted provider', async () => {
    const treatment = contextCompactorModule.treatmentFactory({
      llm: createScriptedLLM({ responses: {} }),
    }) as { compact: (messages: unknown[]) => unknown };
    const task = contextCompactorModule.taskSuite[0];
    const result = (await contextCompactorModule.runTrial({
      implementation: treatment,
      task,
      llm: createScriptedLLM({ responses: {} }),
    })) as { tokenUsage: { promptTokens?: number; input?: number } };
    expect(result.tokenUsage.promptTokens ?? result.tokenUsage.input).toBeGreaterThanOrEqual(0);
  });
});
