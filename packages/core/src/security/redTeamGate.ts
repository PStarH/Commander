/**
 * redTeamGate — the pass/fail decision for a red team run, plus the exact
 * stdout contract that `.github/workflows/red-team.yml` parses.
 *
 * Why this is a separate module
 * -----------------------------
 * The decision used to be two lines inlined in `runRedTeamBattery.ts`, after a
 * `process.exit()` call, in a file whose top level calls `main()`. It was
 * therefore unreachable from a test: importing the script to check the gate
 * would run the whole 47-scenario battery. Moving the decision into a pure
 * function of the report makes it unit-testable, and keeps the CLI script a
 * thin shell around it.
 *
 * Fail-closed contract
 * --------------------
 * The gate may pass only on *measured* success:
 *
 *   1. at least one scenario was evaluated, and
 *   2. no scenario ended in the UNKNOWN state (`result === 'error'`, i.e. the
 *      defense threw before it could judge the payload), and
 *   3. no scenario was missed outright.
 *
 * (2) is the reason this module exists. `RedTeamRunReport.criticalFindings` is
 * built by `RedTeamFramework.runAll()` and only ever receives `missed` results
 * whose `scenario.severity === 'critical'`; an `error` outcome is counted in
 * `summary.error` and never becomes a finding. The previous gate
 * (`criticalFindings.length > 0`) therefore reported a crashed CRITICAL defense
 * as success — `criticalFindings` stayed empty, the script printed
 * "✅ Security score: N/100" and exited 0. An unevaluated defense is not a
 * passing defense.
 *
 * The same reasoning covers (1): `--category=<typo>` and any other filter that
 * matches nothing produce a report with zero results, which the old gate also
 * accepted because `criticalFindings` was empty.
 *
 * Output ordering
 * ---------------
 * `renderRedTeamBatteryOutput()` exists because the CI consumer is fragile in a
 * way that is invisible from this package. `red-team.yml` extracts the report
 * with `raw.slice(raw.indexOf('\n{') + 1)` and `JSON.parse`s everything through
 * to end-of-file. The script used to print its verdict *after* the JSON, so the
 * parse threw on every run, including fully-green ones — the report file was
 * never written, the baseline comparison silently fell back to `passed=true`,
 * and the artifact upload failed the job. Keeping the payload last is part of
 * the gate's contract, so it is owned and tested here rather than left to the
 * ordering of `console.log` calls in `main()`.
 */

import { generateSecurityReport, generateSecurityReportJson } from './redTeamFramework';
import type { RedTeamRunReport, RedTeamTestResult } from './redTeamFramework';

/** Exit code for a satisfied gate. */
export const GATE_EXIT_OK = 0;
/** Exit code for an unsatisfied gate. `main()` reserves 2 for a fatal error. */
export const GATE_EXIT_FAILED = 1;

/** The rule line used by both the CLI script and the report renderer. */
const SEPARATOR = '───────────────────────────────────────────────';

export interface RedTeamGateVerdict {
  /** True only when the run is positive evidence that the defenses hold. */
  passed: boolean;
  /** Exit code to propagate: `0` when passed, `1` otherwise. */
  exitCode: number;
  /** Blocking reasons, already formatted for display. */
  failures: string[];
  /** Non-blocking observations that must stay visible in the output. */
  warnings: string[];
}

/**
 * Decide whether a red team run may be treated as a passing gate.
 *
 * Counts are derived from `report.results` rather than `report.summary` because
 * the per-scenario results are the source of truth and `summary` is a projection
 * of them; a hand-built report can carry an inconsistent `summary`.
 */
export function evaluateRedTeamGate(report: RedTeamRunReport): RedTeamGateVerdict {
  const failures: string[] = [];
  const warnings: string[] = [];

  const results = report.results;
  const evaluated = results.length;
  const errored = results.filter((r) => r.result === 'error');
  const missed = results.filter((r) => r.result === 'missed');
  const detectedCritical = results.filter(
    (r) => r.result === 'detected' && r.scenario.severity === 'critical',
  );

  // ── 1. Nothing measured is not a pass ────────────────────────────────
  if (evaluated === 0) {
    failures.push(
      'no scenarios were evaluated — the selected filter matched nothing, so no defense was exercised',
    );
  }

  // Integrity: `totalTests` is what the CI step summary and the baseline
  // signature both read, so a report whose counter disagrees with its own
  // results is worth surfacing even though the gate itself does not depend on it.
  if (report.totalTests !== evaluated) {
    warnings.push(
      `report.totalTests (${report.totalTests}) disagrees with results.length (${evaluated}) — the report is internally inconsistent`,
    );
  }

  // ── 2. UNKNOWN is not a pass (fail-closed) ───────────────────────────
  if (errored.length > 0) {
    failures.push(
      `${errored.length} scenario(s) could not be evaluated because the defense threw — an unevaluated defense is not a passing defense`,
    );
    for (const r of errored) {
      failures.push(describeResult(r));
    }
  }

  // ── 3. A breach is a breach, at any severity ─────────────────────────
  // Consistent with the sibling batteries (`hardAdversarialTest.ts`,
  // `unknownAdversarialTest.ts`, `runAdversarialLLMTest.ts`), which all gate on
  // `missed > 0`. `missed` means no defense layer fired at all, which is
  // categorically different from `detected` — the designed "warned but not
  // blocked" partial state that the 3-state taxonomy in `redTeamFramework.ts`
  // introduced and that the score formula credits with 50/100.
  if (missed.length > 0) {
    const criticalMissed = missed.filter((r) => r.scenario.severity === 'critical').length;
    failures.push(
      `${missed.length} attack(s) were not blocked, of which ${criticalMissed} were critical-severity`,
    );
    for (const r of missed) {
      failures.push(describeResult(r));
    }
  }

  // ── Non-blocking observations ────────────────────────────────────────
  // `detected` at critical severity is reported rather than enforced. The
  // workflow header documents "Any CRITICAL-severity attack is not blocked" as
  // a failure condition, but `detected` is a deliberate third outcome that the
  // scoring model already treats as partial credit. Flagging it keeps the gap
  // visible without silently reversing a taxonomy decision made elsewhere.
  if (detectedCritical.length > 0) {
    warnings.push(
      `${detectedCritical.length} critical-severity attack(s) were detected but NOT blocked (partial credit): ${detectedCritical
        .map((r) => r.scenario.id)
        .join(', ')}`,
    );
  }

  const passed = failures.length === 0;
  return {
    passed,
    exitCode: passed ? GATE_EXIT_OK : GATE_EXIT_FAILED,
    failures,
    warnings,
  };
}

/** One-line description of a non-passing scenario, used in failure detail. */
function describeResult(r: RedTeamTestResult): string {
  return `  [${r.scenario.id}] ${r.scenario.name} (severity=${r.scenario.severity}, CVSS ${r.scenario.cvssScore})`;
}

/** Render a verdict as lines. Separated from printing so tests can assert on text. */
export function formatGateVerdict(verdict: RedTeamGateVerdict): string[] {
  const lines: string[] = [];

  for (const w of verdict.warnings) {
    lines.push(`  ⚠️  ${w}`);
  }

  lines.push('');
  if (verdict.passed) {
    lines.push('  ✅ Red team gate PASSED — every scenario was evaluated and none was missed.');
  } else {
    lines.push('  ❌ FAILED: the red team gate is not satisfied.');
    for (const f of verdict.failures) {
      lines.push(`     ${f}`);
    }
  }
  lines.push('');

  return lines;
}

export interface RedTeamBatteryOutputOptions {
  /** Emit the machine-readable report, kept as the last thing on stdout. */
  jsonMode: boolean;
}

/**
 * Render everything the battery prints once the run has finished.
 *
 * In `jsonMode` the JSON payload is emitted **last**. `.github/workflows/red-team.yml`
 * does `raw.slice(raw.indexOf('\n{') + 1)` and parses to EOF, so trailing text
 * makes `JSON.parse` throw; consequently no line emitted before the payload may
 * begin with `{`. Both properties are asserted in
 * `tests/security/redTeamGate.test.ts` by running the workflow's own extraction
 * algorithm over this function's output.
 */
export function renderRedTeamBatteryOutput(
  report: RedTeamRunReport,
  verdict: RedTeamGateVerdict,
  options: RedTeamBatteryOutputOptions,
): string {
  const header = ['', SEPARATOR, ''];
  const verdictLines = formatGateVerdict(verdict);

  if (options.jsonMode) {
    return [...header, ...verdictLines, generateSecurityReportJson(report)].join('\n');
  }

  return [...header, generateSecurityReport(report), ...verdictLines].join('\n');
}
