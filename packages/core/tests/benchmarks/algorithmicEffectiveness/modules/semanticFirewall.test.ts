import { describe, it, expect } from 'vitest';
import { semanticFirewallModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/semanticFirewall';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('semanticFirewall module', () => {
  it('has required shape', () => {
    expect(semanticFirewallModule.id).toBe('semanticFirewall');
    expect(semanticFirewallModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats the allow-all baseline in scripted mode', async () => {
    const result = await runComparison(
      { moduleId: 'semanticFirewall', mode: 'scripted', n: 30, seed: 42 },
      semanticFirewallModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
