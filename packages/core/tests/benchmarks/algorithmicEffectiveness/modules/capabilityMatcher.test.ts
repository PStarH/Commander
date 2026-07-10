import { describe, it, expect } from 'vitest';
import { capabilityMatcherModule } from '../../../../src/benchmarks/algorithmicEffectiveness/modules/capabilityMatcher';
import { createScriptedLLM } from '../../../../src/benchmarks/algorithmicEffectiveness/scriptedLLM';
import { runComparison } from '../../../../src/benchmarks/algorithmicEffectiveness/runner';

describe('capabilityMatcher module', () => {
  it('has required shape', () => {
    expect(capabilityMatcherModule.id).toBe('capabilityMatcher');
    expect(capabilityMatcherModule.taskSuite.length).toBeGreaterThan(0);
  });

  it('beats first-available baseline in scripted mode', async () => {
    const responses: Record<string, string> = {
      'known CVEs': '["security","vulnerability_analysis","docker"]',
      'normalized schema': '["sql","database","data_modeling"]',
      'accessible React': '["react","accessibility","typescript"]',
      'PyTorch classifier': '["machine_learning","pytorch","python","data_analysis"]',
      'OAuth2 misconfiguration': '["security","api","devops"]',
    };

    const result = await runComparison(
      { moduleId: 'capabilityMatcher', mode: 'scripted', n: 30, seed: 42 },
      capabilityMatcherModule,
      () => createScriptedLLM({ responses, defaultResponse: '[]' }),
    );

    expect(result.conclusion).toBe('SIGNIFICANTLY_BETTER');
  });
});
