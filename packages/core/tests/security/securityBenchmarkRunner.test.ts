import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecurityBenchmarkRunner,
  getSecurityBenchmarkRunner,
  resetSecurityBenchmarkRunner,
  ALL_BENCHMARK_CASES,
  getCasesForBenchmark,
} from '../../src/security/securityBenchmarkRunner';
import type {
  BenchmarkTestCase,
  BenchmarkRunReport,
  BenchmarkId,
  DefenderFn,
} from '../../src/security/securityBenchmarkRunner';

// ── Helper defender: always blocks ────────────────────────────────────

const blockingDefender: DefenderFn = async () => ({
  blocked: true,
  defense: 'test_contentScanner:prompt_injection',
  details: 'Blocked by test defender',
});

const missingDefender: DefenderFn = async (_tc: BenchmarkTestCase) => ({
  blocked: false,
  details: 'Test defender missed this attack',
});

// ── Helper defender: blocks selectively ───────────────────────────────

function selectiveDefender(blockedIds: string[]): DefenderFn {
  return async (tc: BenchmarkTestCase) => {
    if (blockedIds.includes(tc.id)) {
      return { blocked: true, defense: 'test_layer', details: 'Blocked selectively' };
    }
    return { blocked: false, details: 'Not blocked by selective defender' };
  };
}

describe('SecurityBenchmarkRunner', () => {
  let runner: SecurityBenchmarkRunner;

  beforeEach(() => {
    runner = new SecurityBenchmarkRunner({ enabled: true });
  });

  // ── Module Structure ─────────────────────────────────────────────

  it('should export a singleton via getSecurityBenchmarkRunner', () => {
    const instance = getSecurityBenchmarkRunner();
    expect(instance).toBeInstanceOf(SecurityBenchmarkRunner);
    resetSecurityBenchmarkRunner();
  });

  it('should have embedded test cases for all three benchmarks', () => {
    const adCases = getCasesForBenchmark('agentdojo');
    const asbCases = getCasesForBenchmark('agentsafetybench');
    const ahCases = getCasesForBenchmark('agentharm');

    expect(adCases.length).toBeGreaterThan(0);
    expect(asbCases.length).toBeGreaterThan(0);
    expect(ahCases.length).toBeGreaterThan(0);
    expect(ALL_BENCHMARK_CASES.length).toBe(adCases.length + asbCases.length + ahCases.length);
  });

  it('should return correct benchmark metadata', () => {
    const meta = runner.getBenchmarkMeta('agentdojo');
    expect(meta.name).toBe('AgentDojo');
    expect(meta.organization).toContain('ETH');
    expect(meta.totalEmbedded).toBeGreaterThan(0);
  });

  it('should support "all" benchmark for combined runs', () => {
    const allCases = runner.getTestCases('all');
    expect(allCases.length).toBe(ALL_BENCHMARK_CASES.length);
  });

  // ── Test Case Management ──────────────────────────────────────────

  it('should allow adding custom test cases', () => {
    runner.addTestCases([
      {
        id: 'CUSTOM-001',
        benchmark: 'agentdojo',
        category: 'custom_test',
        prompt: 'Custom malicious prompt',
        expectedRefusal: true,
        severity: 'high',
        cvssScore: 7.0,
      },
    ]);
    const cases = runner.getTestCases('agentdojo');
    expect(cases.some((c) => c.id === 'CUSTOM-001')).toBe(true);
  });

  // ── Benchmark Execution ───────────────────────────────────────────

  it('should run agentdojo benchmark with blocking defender', async () => {
    const report = await runner.runBenchmark('agentdojo', blockingDefender);

    expect(report.benchmark).toBe('agentdojo');
    expect(report.totalTests).toBeGreaterThan(0);
    expect(report.blocked).toBe(report.totalTests);
    expect(report.missed).toBe(0);
    expect(report.securityScore).toBe(100);
    expect(report.grade).toBe('A+');
    expect(report.results).toHaveLength(report.totalTests);
  });

  it('should run agentsafetybench benchmark with missing defender', async () => {
    const report = await runner.runBenchmark('agentsafetybench', missingDefender);

    expect(report.blocked).toBe(0);
    expect(report.missed).toBe(report.totalTests);
    // Severity-weighted scoring gives partial credit for non-critical misses
    expect(report.securityScore).toBeGreaterThanOrEqual(0);
    expect(report.securityScore).toBeLessThan(10);
    expect(report.grade).toBe('F');
    expect(report.criticalFindings.length).toBeGreaterThan(0);
  });

  it('should run agentharm benchmark with selective defender', async () => {
    const ahCases = getCasesForBenchmark('agentharm');
    const blockedIds = ahCases.slice(0, 3).map((c) => c.id);
    const report = await runner.runBenchmark('agentharm', selectiveDefender(blockedIds));

    expect(report.blocked).toBe(3);
    expect(report.missed).toBe(ahCases.length - 3);
    expect(report.securityScore).toBeGreaterThan(0);
    expect(report.securityScore).toBeLessThan(100);
  });

  it('should run all benchmarks together', async () => {
    const report = await runner.runBenchmark('all', blockingDefender);

    expect(report.benchmark).toBe('all');
    expect(report.totalTests).toBe(ALL_BENCHMARK_CASES.length);
    expect(report.securityScore).toBe(100);
  });

  it('should run smoke test (critical only)', async () => {
    const report = await runner.runSmokeTest('all', blockingDefender);

    expect(report.totalTests).toBeGreaterThan(0);
    // With blocking defender, all critical cases should be blocked
    expect(report.blocked).toBe(report.totalTests);
    expect(report.securityScore).toBe(100);
  });

  // ── Scoring ───────────────────────────────────────────────────────

  it('should compute per-benchmark scores correctly', async () => {
    // Block first half, miss second half
    const adCases = getCasesForBenchmark('agentdojo');
    const half = Math.ceil(adCases.length / 2);
    const blockedIds = adCases.slice(0, half).map((c) => c.id);

    const report = await runner.runBenchmark('agentdojo', selectiveDefender(blockedIds));
    expect(report.blocked).toBe(half);
    expect(report.missed).toBe(adCases.length - half);
  });

  it('should include category breakdown in reports', async () => {
    const report = await runner.runBenchmark('all', blockingDefender);
    expect(report.categoryBreakdown.length).toBeGreaterThan(0);

    for (const cat of report.categoryBreakdown) {
      expect(cat.score).toBe(100); // blocking defender blocks everything
    }
  });

  // ── CI/CD Gate ────────────────────────────────────────────────────

  it('should pass gate when score exceeds threshold', async () => {
    const report = await runner.runBenchmark('agentdojo', blockingDefender);
    expect(runner.passesGate(report)).toBe(true);

    const gateResult = runner.generateGateResult(report);
    expect(gateResult.passed).toBe(true);
    expect(gateResult.exitCode).toBe(0);
  });

  it('should fail gate when score below threshold', async () => {
    runner.updateConfig({ minScorePass: 95 });
    const report = await runner.runBenchmark('agentharm', missingDefender);
    expect(runner.passesGate(report)).toBe(false);

    const gateResult = runner.generateGateResult(report);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.exitCode).toBe(1);
  });

  it('should fail gate on critical missed findings', async () => {
    runner.updateConfig({ failOnCriticalMissed: true });
    const report = await runner.runBenchmark('agentsafetybench', missingDefender);
    // With missing defender, all critical cases missed
    expect(report.criticalFindings.length).toBeGreaterThan(0);
    expect(runner.passesGate(report)).toBe(false);
  });

  // ── Reporting ─────────────────────────────────────────────────────

  it('should generate markdown report', async () => {
    const report = await runner.runBenchmark('agentdojo', blockingDefender);
    const md = runner.generateMarkdownReport(report);

    expect(md).toContain('Security Benchmark Report');
    expect(md).toContain('AgentDojo');
    expect(md).toContain('Score: **100/100**');
    expect(md).toContain('A+');
    expect(md).toContain('Blocked');
    expect(md).toContain('No Critical Findings');
  });

  it('should generate JSON report', async () => {
    const report = await runner.runBenchmark('agentdojo', blockingDefender);
    const json = runner.generateJsonReport(report);
    const parsed = JSON.parse(json);

    expect(parsed.securityScore).toBe(100);
    expect(parsed.benchmark).toBe('agentdojo');
    expect(parsed.grade).toBe('A+');
  });

  it('should generate CI annotations for failures', async () => {
    const report = await runner.runBenchmark('agentharm', missingDefender);
    const annotations = runner.generateCiAnnotations(report);

    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations.some((a) => a.includes('error'))).toBe(true);
  });

  // ── Empty/Disabled ────────────────────────────────────────────────

  it('should return empty report when disabled', async () => {
    runner.updateConfig({ enabled: false });
    const report = await runner.runBenchmark('agentdojo', blockingDefender);

    expect(report.totalTests).toBe(0);
    expect(report.securityScore).toBe(0);
  });

  it('should return empty report when no defender configured', async () => {
    const bareRunner = new SecurityBenchmarkRunner({ enabled: true });
    // No defender set
    const report = await bareRunner.runBenchmark('agentdojo');
    expect(report.totalTests).toBe(0);
    expect(report.criticalFindings).toContain('No defender function configured.');
  });

  // ── Reset ─────────────────────────────────────────────────────────

  it('should reset custom test cases on reset', () => {
    runner.addTestCases([
      {
        id: 'RESET-001',
        benchmark: 'agentdojo',
        category: 'reset_test',
        prompt: 'test',
        expectedRefusal: true,
        severity: 'low',
        cvssScore: 1.0,
      },
    ]);
    expect(runner.getTestCases('agentdojo').some((c) => c.id === 'RESET-001')).toBe(true);

    runner.reset();
    expect(runner.getTestCases('agentdojo').some((c) => c.id === 'RESET-001')).toBe(false);
  });

  // ── Config ────────────────────────────────────────────────────────

  it('should allow runtime config updates', () => {
    runner.updateConfig({ minScorePass: 90 });
    expect(runner.getConfig().minScorePass).toBe(90);
  });

  // ── Test Case Content Verification ─────────────────────────────────

  it('should have valid test case structure', () => {
    for (const tc of ALL_BENCHMARK_CASES) {
      expect(tc.id).toBeDefined();
      expect(tc.benchmark).toBeDefined();
      expect(tc.category).toBeDefined();
      expect(tc.prompt.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high', 'critical']).toContain(tc.severity);
      expect(tc.cvssScore).toBeGreaterThan(0);
      expect(tc.cvssScore).toBeLessThanOrEqual(10);
      expect(tc.expectedRefusal).toBe(true); // All test cases should expect refusal
    }
  });

  it('should cover key categories across benchmarks', () => {
    const allCategories = new Set(ALL_BENCHMARK_CASES.map((c) => c.category));
    expect(allCategories.has('prompt_injection')).toBe(true);
    expect(allCategories.has('privacy')).toBe(true);
    expect(allCategories.has('fraud')).toBe(true);
    expect(allCategories.has('cybercrime')).toBe(true);
  });
});
