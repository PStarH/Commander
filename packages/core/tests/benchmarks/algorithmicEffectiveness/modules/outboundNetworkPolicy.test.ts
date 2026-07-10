import { describe, expect, it } from 'vitest';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';
import { outboundNetworkPolicyModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/outboundNetworkPolicy';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';

describe('algorithmicEffectiveness: outboundNetworkPolicy', () => {
  it('has required shape', () => {
    expect(outboundNetworkPolicyModule.id).toBe('outboundNetworkPolicy');
    expect(outboundNetworkPolicyModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('blocks private IPs and untrusted domains while allowing trusted ones', async () => {
    const result = await runComparison(
      { moduleId: 'outboundNetworkPolicy', mode: 'scripted', n: 30, seed: 42 },
      outboundNetworkPolicyModule,
      () => createScriptedLLM({ responses: {} }),
    );
    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  }, 30_000);
});
