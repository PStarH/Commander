import { describe, it, expect } from 'vitest';
import { generateMarkdownReport, generateJsonReport } from '../../../src/benchmarks/algorithmicEffectiveness/reporter';
import type { ComparisonResult } from '../../../src/benchmarks/algorithmicEffectiveness/types';

const mockResult: ComparisonResult = {
  moduleId: 'thompsonMemory',
  mode: 'scripted',
  n: 30,
  baseline: { mean: 0.6, median: 0.6, p95: 1, stdDev: 0.1, raw: [] },
  treatment: { mean: 0.8, median: 0.8, p95: 1, stdDev: 0.1, raw: [] },
  pValues: { successRate: 0.01, cost: 1, latency: 1, llmScore: 1 },
  effectSizes: { successRate: 0.4, cost: 0, latency: 0, llmScore: 0 },
  conclusion: 'SIGNIFICANTLY_BETTER',
  errors: [],
};

describe('reporter', () => {
  it('generates markdown with conclusion', () => {
    const md = generateMarkdownReport([mockResult]);
    expect(md).toContain('ThompsonMemory');
    expect(md).toContain('SIGNIFICANTLY_BETTER');
    expect(md).toContain('Success Rate');
  });

  it('generates JSON with modules array', () => {
    const json = generateJsonReport([mockResult]);
    expect(json.modules[0].moduleId).toBe('thompsonMemory');
  });
});
