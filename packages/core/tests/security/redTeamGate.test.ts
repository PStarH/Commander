/**
 * RedTeamGate Tests — the pass/fail contract for the red team battery.
 *
 * Covers:
 *   - fail-closed on `error` (UNKNOWN) outcomes at any severity
 *   - fail-closed on a run that evaluated nothing (`--category=<typo>`)
 *   - fail-closed on `missed` at any severity, including below critical
 *   - `detected` is a partial-credit outcome: passes, but warns at critical severity
 *   - the green case (47/47 blocked) still passes
 *   - the stdout contract the frozen `red-team.yml` depends on
 *
 * The regression this file exists for
 * -----------------------------------
 * `RedTeamFramework.runAll()` only ever pushes `missed` results at
 * `severity === 'critical'` into `criticalFindings`. An `error` outcome — the
 * defense threw, so the payload was never judged — is counted in
 * `summary.error` and produces no finding at all. The gate used to be
 * `report.criticalFindings.length > 0`, so a crashed CRITICAL defense left
 * `criticalFindings` empty and the script printed "✅ Security score: N/100" and
 * exited 0. `makeReport()` below reproduces `runAll()`'s derivation exactly, so
 * the tests assert against the real report shape rather than a convenient one.
 */

import { describe, it, expect } from 'vitest';
import {
  GATE_EXIT_FAILED,
  GATE_EXIT_OK,
  evaluateRedTeamGate,
  formatGateVerdict,
  renderRedTeamBatteryOutput,
} from '../../src/security/redTeamGate';
import {
  generateSecurityReport,
  generateSecurityReportJson,
} from '../../src/security/redTeamFramework';
import type {
  RedTeamRunReport,
  RedTeamTestResult,
  RedTeamTestScenario,
} from '../../src/security/redTeamFramework';

// ============================================================================
// Fixtures
// ============================================================================

let scenarioSeq = 0;

function makeScenario(overrides: Partial<RedTeamTestScenario> = {}): RedTeamTestScenario {
  scenarioSeq += 1;
  return {
    id: overrides.id ?? `RT-${scenarioSeq.toString().padStart(3, '0')}`,
    category: overrides.category ?? 'prompt_injection',
    name: overrides.name ?? `Scenario ${scenarioSeq}`,
    description: overrides.description ?? 'Synthetic scenario for gate tests',
    payload: overrides.payload ?? 'synthetic payload',
    expectedDefense: overrides.expectedDefense ?? 'contentScanner',
    severity: overrides.severity ?? 'high',
    cvssScore: overrides.cvssScore ?? 7.0,
    tags: overrides.tags ?? ['test'],
  };
}

function makeResult(
  severity: RedTeamTestScenario['severity'],
  result: RedTeamTestResult['result'],
  overrides: Partial<RedTeamTestScenario> = {},
): RedTeamTestResult {
  return {
    scenario: makeScenario({ severity, ...overrides }),
    result,
    durationMs: 1,
    details: `synthetic ${result}`,
    testedAt: new Date().toISOString(),
  };
}

/**
 * Build a report the way `RedTeamFramework.runAll()` does — in particular
 * `criticalFindings` receives **only** `missed` + critical, never `error`.
 * Mirroring that derivation is the whole point: a fixture that hand-populated
 * `criticalFindings` with errors would test a report the framework cannot emit.
 */
function makeReport(results: RedTeamTestResult[]): RedTeamRunReport {
  const summary = {
    blocked: results.filter((r) => r.result === 'blocked').length,
    detected: results.filter((r) => r.result === 'detected').length,
    missed: results.filter((r) => r.result === 'missed').length,
    error: results.filter((r) => r.result === 'error').length,
  };

  const criticalFindings = results
    .filter((r) => r.result === 'missed' && r.scenario.severity === 'critical')
    .map(
      (r) => `[${r.scenario.id}] ${r.scenario.name}: NOT BLOCKED (CVSS ${r.scenario.cvssScore})`,
    );

  return {
    runId: 'rt_test_0000',
    totalTests: results.length,
    summary,
    results,
    securityScore:
      results.length > 0
        ? Math.round((summary.blocked * 100 + summary.detected * 50) / results.length)
        : 0,
    criticalFindings,
    runAt: new Date().toISOString(),
    durationMs: 1,
  };
}

/** The measured shape of a healthy full battery: 26 critical + 16 high + 5 medium. */
function greenBattery(): RedTeamRunReport {
  const results = [
    ...Array.from({ length: 26 }, () => makeResult('critical', 'blocked')),
    ...Array.from({ length: 16 }, () => makeResult('high', 'blocked')),
    ...Array.from({ length: 5 }, () => makeResult('medium', 'blocked')),
  ];
  return makeReport(results);
}

/**
 * Replicates the report extraction in `.github/workflows/red-team.yml`
 * (step "Run Red Team Battery") byte for byte:
 *
 *   const jsonStart = raw.indexOf('\n{');
 *   const json = jsonStart >= 0 ? raw.slice(jsonStart + 1) : raw;
 *   JSON.parse(json.trim());
 *
 * It throws exactly where the workflow's inline `node -e` would, which is what
 * makes it a meaningful assertion rather than a restatement of the fix.
 */
function workflowExtractReport(stdout: string): RedTeamRunReport {
  const jsonStart = stdout.indexOf('\n{');
  const json = jsonStart >= 0 ? stdout.slice(jsonStart + 1) : stdout;
  return JSON.parse(json.trim()) as RedTeamRunReport;
}

/** Realistic stdout prefix: the banner plus a few progress lines from onProgress. */
function progressPrefix(): string {
  return [
    '',
    '🔴 Commander Red Team Security Battery',
    '───────────────────────────────────────────────',
    '',
    'Mode: Full battery (47 scenarios)',
    '',
    '  🛡️ [RT-001] Direct instruction override                       → blocked',
    '  🛡️ [RT-002] Base64-encoded injection                          → blocked',
    '  ⚡ [RT-003] Nested payload                                     → error',
  ].join('\n');
}

// ============================================================================
// Gate — fail-closed behaviour
// ============================================================================

describe('evaluateRedTeamGate — fail-closed contract', () => {
  it('passes a fully blocked battery', () => {
    const report = greenBattery();

    const verdict = evaluateRedTeamGate(report);

    expect(report.totalTests).toBe(47);
    expect(report.securityScore).toBe(100);
    expect(verdict.passed).toBe(true);
    expect(verdict.exitCode).toBe(GATE_EXIT_OK);
    expect(verdict.failures).toEqual([]);
  });

  it('fails when a CRITICAL scenario errored, even though it produced no criticalFinding', () => {
    const report = makeReport([
      makeResult('critical', 'blocked'),
      makeResult('critical', 'error', { id: 'RT-ERR-CRIT', name: 'Crashed defense' }),
    ]);

    // The old gate was literally `report.criticalFindings.length > 0`. An `error`
    // outcome never reaches criticalFindings, so that expression is false here —
    // which is exactly why the old script exited 0 on a crashed defense.
    expect(report.criticalFindings).toHaveLength(0);
    expect(report.summary.error).toBe(1);
    expect(report.criticalFindings.length > 0).toBe(false);

    const verdict = evaluateRedTeamGate(report);

    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(GATE_EXIT_FAILED);
    expect(verdict.failures.join('\n')).toContain('could not be evaluated');
    expect(verdict.failures.join('\n')).toContain('RT-ERR-CRIT');
  });

  it('fails when a non-critical scenario errored', () => {
    const report = makeReport([
      makeResult('critical', 'blocked'),
      makeResult('medium', 'error', { id: 'RT-ERR-MED' }),
    ]);

    const verdict = evaluateRedTeamGate(report);

    // UNKNOWN is not a pass regardless of the declared severity.
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join('\n')).toContain('RT-ERR-MED');
  });

  it('fails a run that evaluated nothing, as `--category=<typo>` produces', () => {
    const report = makeReport([]);

    const verdict = evaluateRedTeamGate(report);

    expect(report.totalTests).toBe(0);
    expect(verdict.passed).toBe(false);
    expect(verdict.exitCode).toBe(GATE_EXIT_FAILED);
    expect(verdict.failures.join('\n')).toContain('no scenarios were evaluated');
  });

  it('fails on a missed HIGH scenario, which the old gate let through', () => {
    const report = makeReport([
      makeResult('critical', 'blocked'),
      makeResult('high', 'missed', { id: 'RT-MISS-HIGH', name: 'High-severity breach' }),
    ]);

    expect(report.criticalFindings).toHaveLength(0);

    const verdict = evaluateRedTeamGate(report);

    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join('\n')).toContain('RT-MISS-HIGH');
    expect(verdict.failures.join('\n')).toContain('1 attack(s) were not blocked');
  });

  it('fails on a missed CRITICAL scenario', () => {
    const report = makeReport([makeResult('critical', 'missed', { id: 'RT-MISS-CRIT' })]);

    const verdict = evaluateRedTeamGate(report);

    expect(report.criticalFindings).toHaveLength(1);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join('\n')).toContain('1 were critical-severity');
  });

  it('treats `detected` as partial credit: passes, but warns at critical severity', () => {
    const report = makeReport([
      makeResult('critical', 'blocked'),
      makeResult('critical', 'detected', { id: 'RT-DET-CRIT' }),
    ]);

    const verdict = evaluateRedTeamGate(report);

    expect(verdict.passed).toBe(true);
    expect(verdict.exitCode).toBe(GATE_EXIT_OK);
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings.join('\n')).toContain('RT-DET-CRIT');
    expect(verdict.warnings.join('\n')).toContain('detected but NOT blocked');
  });

  it('does not warn about `detected` below critical severity', () => {
    const report = makeReport([makeResult('high', 'detected')]);

    const verdict = evaluateRedTeamGate(report);

    expect(verdict.passed).toBe(true);
    expect(verdict.warnings).toEqual([]);
  });

  it('warns when totalTests disagrees with the results array', () => {
    const report = makeReport([makeResult('critical', 'blocked')]);
    const inconsistent = { ...report, totalTests: 99 };

    const verdict = evaluateRedTeamGate(inconsistent);

    expect(verdict.passed).toBe(true);
    expect(verdict.warnings.join('\n')).toContain('internally inconsistent');
  });

  it('is a pure function of the report — no process exit, stable across calls', () => {
    const report = makeReport([makeResult('critical', 'error')]);

    const first = evaluateRedTeamGate(report);
    const second = evaluateRedTeamGate(report);

    expect(first).toEqual(second);
    expect(first.exitCode).toBe(1);
  });
});

// ============================================================================
// Verdict rendering
// ============================================================================

describe('formatGateVerdict', () => {
  it('reports a pass without failure lines', () => {
    const lines = formatGateVerdict(evaluateRedTeamGate(greenBattery())).join('\n');

    expect(lines).toContain('✅ Red team gate PASSED');
    expect(lines).not.toContain('❌');
  });

  it('reports a failure with every blocking reason', () => {
    const report = makeReport([
      makeResult('critical', 'error', { id: 'RT-A' }),
      makeResult('high', 'missed', { id: 'RT-B' }),
    ]);

    const lines = formatGateVerdict(evaluateRedTeamGate(report)).join('\n');

    expect(lines).toContain('❌ FAILED');
    expect(lines).toContain('could not be evaluated');
    expect(lines).toContain('were not blocked');
    expect(lines).toContain('RT-A');
    expect(lines).toContain('RT-B');
  });
});

// ============================================================================
// Stdout contract consumed by .github/workflows/red-team.yml
// ============================================================================

describe('renderRedTeamBatteryOutput — CI stdout contract', () => {
  it('keeps the JSON payload parseable by the workflow extractor on a green run', () => {
    const report = greenBattery();
    const verdict = evaluateRedTeamGate(report);

    const stdout = `${progressPrefix()}\n${renderRedTeamBatteryOutput(report, verdict, { jsonMode: true })}\n`;

    // Throws if anything follows the payload — the defect that made the workflow
    // lose the report on every run, including fully-green ones.
    const parsed = workflowExtractReport(stdout);

    expect(parsed.runId).toBe(report.runId);
    expect(parsed.totalTests).toBe(47);
    expect(parsed.securityScore).toBe(100);
    expect(parsed.summary.blocked).toBe(47);
    expect(parsed.criticalFindings).toEqual([]);
  });

  it('keeps the JSON payload parseable when the gate fails', () => {
    const report = makeReport([
      makeResult('critical', 'blocked'),
      makeResult('critical', 'error', { id: 'RT-ERR' }),
    ]);
    const verdict = evaluateRedTeamGate(report);

    const stdout = `${progressPrefix()}\n${renderRedTeamBatteryOutput(report, verdict, { jsonMode: true })}\n`;

    const parsed = workflowExtractReport(stdout);

    expect(parsed.summary.error).toBe(1);
    expect(parsed.criticalFindings).toEqual([]);
    expect(verdict.passed).toBe(false);
  });

  it('emits the payload last and never starts an earlier line with "{"', () => {
    const report = greenBattery();
    const verdict = evaluateRedTeamGate(report);

    const output = renderRedTeamBatteryOutput(report, verdict, { jsonMode: true });
    const lines = output.split('\n');
    const jsonStart = lines.findIndex((l) => l === '{');

    expect(jsonStart).toBeGreaterThan(-1);
    // Nothing before the payload may look like a JSON block start, otherwise
    // `indexOf('\n{')` would latch onto the wrong offset.
    for (const line of lines.slice(0, jsonStart)) {
      expect(line.startsWith('{')).toBe(false);
    }
    // The payload runs to the end of the string.
    expect(lines[lines.length - 1]).toBe('}');
  });

  it('carries the fields the workflow signer and comparator require', () => {
    const report = greenBattery();

    const parsed = JSON.parse(generateSecurityReportJson(report)) as RedTeamRunReport & {
      results: Array<{ id: string; scenario: { id: string; name: string; cvssScore: number } }>;
      categoryBreakdown: Array<{ error: number }>;
    };

    // totalTests feeds the step summary and the baseline HMAC payload.
    expect(parsed.totalTests).toBe(report.totalTests);
    // Nested scenario feeds `r.scenario.id` in both the comparator and the signer.
    expect(parsed.results[0].scenario.id).toBe(report.results[0].scenario.id);
    expect(parsed.results[0].scenario.name).toBe(report.results[0].scenario.name);
    expect(parsed.results[0].scenario.cvssScore).toBe(report.results[0].scenario.cvssScore);
    // Flat keys stay for existing consumers.
    expect(parsed.results[0].id).toBe(report.results[0].scenario.id);
    // Errors must be expressible in the machine-readable output.
    expect(parsed.summary.error).toBe(0);
    expect(parsed.categoryBreakdown.every((c) => typeof c.error === 'number')).toBe(true);
  });

  it('includes the human report and the verdict in non-JSON mode', () => {
    const report = greenBattery();
    const verdict = evaluateRedTeamGate(report);

    const output = renderRedTeamBatteryOutput(report, verdict, { jsonMode: false });

    expect(output).toContain('COMMANDER RED TEAM SECURITY REPORT');
    expect(output).toContain('✅ Red team gate PASSED');
    expect(() => JSON.parse(output)).toThrow();
  });

  it('renders a zero-scenario report without NaN shares', () => {
    const report = makeReport([]);

    const output = renderRedTeamBatteryOutput(report, evaluateRedTeamGate(report), {
      jsonMode: false,
    });

    expect(output).not.toContain('NaN');
    expect(output).toContain('0.0%');
  });
});

// ============================================================================
// Human report — conclusions must be measured, not assumed
// ============================================================================

describe('generateSecurityReport — conclusions must be measured', () => {
  it('does not claim safety when defenses threw', () => {
    const report = makeReport([
      makeResult('critical', 'blocked'),
      makeResult('critical', 'error', { id: 'RT-ERR' }),
    ]);

    const output = generateSecurityReport(report);

    // Both of these were printed unconditionally before, because they keyed off
    // `criticalFindings` / `summary.missed` — neither of which sees an `error`.
    expect(output).not.toContain('all critical-severity attacks were blocked');
    expect(output).not.toContain('All attacks were blocked');
    expect(output).toContain('NOT evidence of safety');
    expect(output).toContain('could not be evaluated');
  });

  it('does not claim safety when nothing was evaluated', () => {
    const report = makeReport([]);

    const output = generateSecurityReport(report);

    expect(output).not.toContain('all critical-severity attacks were blocked');
    expect(output).not.toContain('All attacks were blocked');
    expect(output).toContain('No attacks were run');
  });

  it('does not claim safety when a non-critical attack was missed', () => {
    const report = makeReport([makeResult('medium', 'missed', { id: 'RT-MED' })]);

    const output = generateSecurityReport(report);

    expect(output).not.toContain('All attacks were blocked');
    expect(output).toContain('lower-severity attack(s) were missed');
  });

  it('still claims success for a genuinely clean run', () => {
    const report = greenBattery();

    const output = generateSecurityReport(report);

    expect(output).toContain('all critical-severity attacks were blocked');
    expect(output).toContain('All attacks were blocked');
    expect(output).not.toContain('NOT evidence of safety');
  });
});
