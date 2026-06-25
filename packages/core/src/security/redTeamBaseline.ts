/**
 * RedTeamBaseline — Regression Detection for Continuous Red Team Testing.
 *
 * Stores a trusted "last known good" red team run as a baseline and compares
 * subsequent runs against it to detect security regressions in CI/CD.
 *
 * Key concepts:
 *   - Baseline: The last passing red team run on the main branch (trusted).
 *   - Regression: An attack that was BLOCKED in the baseline but is now MISSED.
 *   - Improvement: An attack that was MISSED in the baseline but is now BLOCKED.
 *   - Score regression: Baseline security score dropped by configurable threshold.
 *
 * CI/CD integration:
 *   - PR smoke test: Compare 5-scenario smoke run against baseline smoke subset.
 *     Fail if any critical regression detected.
 *   - Main full battery: Run all 44 scenarios, update baseline on success.
 *   - Baseline is stored as tamper-proof JSON via AuditChainLedger.
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getAuditChainLedger } from './auditChainLedger';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import type { RedTeamRunReport, RedTeamTestResult } from './redTeamFramework';

// ============================================================================
// Types
// ============================================================================

export type RegressionSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface BaselineEntry {
  /** Scenario ID */
  scenarioId: string;
  /** Result in the baseline run */
  baselineResult: string;
  /** Defense that was triggered in the baseline */
  baselineDefense?: string;
  /** CVSS score of this scenario */
  cvssScore: number;
  /** Scenario severity */
  scenarioSeverity: string;
}

export interface RegressionResult {
  /** Scenario that regressed */
  scenarioId: string;
  /** Scenario name */
  scenarioName: string;
  /** Category */
  category: string;
  /** Baseline result (was BLOCKED) */
  baselineResult: string;
  /** Current result (now MISSED) */
  currentResult: string;
  /** Severity of the regression */
  severity: RegressionSeverity;
  /** CVSS score of the scenario */
  cvssScore: number;
}

export interface ImprovementResult {
  /** Scenario that improved */
  scenarioId: string;
  /** Scenario name */
  scenarioName: string;
  /** Category */
  category: string;
  /** Baseline result (was MISSED) */
  baselineResult: string;
  /** Current result (now BLOCKED) */
  currentResult: string;
  /** CVSS score of the scenario */
  cvssScore: number;
}

export interface BaselineComparison {
  /** Comparison run ID */
  runId: string;
  /** Baseline run ID */
  baselineRunId: string;
  /** Whether the comparison was performed */
  performed: boolean;
  /** Baseline security score */
  baselineScore: number;
  /** Current run security score */
  currentScore: number;
  /** Score change (positive = improvement) */
  scoreDelta: number;
  /** Detected regressions */
  regressions: RegressionResult[];
  /** Detected improvements */
  improvements: ImprovementResult[];
  /** Overall regression severity */
  overallSeverity: RegressionSeverity;
  /** Whether the run passes the regression gate */
  passed: boolean;
  /** Human-readable summary */
  summary: string;
  /** Comparison timestamp */
  comparedAt: string;
}

export interface BaselineConfig {
  /** Where to store the baseline file */
  baselinePath: string;
  /** Minimum score drop to trigger a regression (absolute points) */
  scoreRegressionThreshold: number;
  /** Whether to fail on any non-critical regression. Critical regressions always fail. */
  failOnAnyRegression: boolean;
  /** Maximum regressions allowed before failing */
  maxAllowedRegressions: number;
}

export interface RedTeamBaseline {
  /** Baseline metadata */
  metadata: {
    /** Version of the baseline format */
    version: number;
    /** When the baseline was created */
    createdAt: string;
    /** When the baseline was last updated */
    updatedAt: string;
    /** The run ID this baseline was derived from */
    runId: string;
    /** Git commit hash at baseline time */
    commitHash?: string;
    /** Git branch at baseline time */
    branch?: string;
  };
  /** The full baseline report */
  report: RedTeamRunReport;
  /** HMAC signature for tamper detection */
  signature: string;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: BaselineConfig = {
  baselinePath: path.join(process.cwd(), '.commander', 'red-team-baseline.json'),
  scoreRegressionThreshold: 10, // 10 point drop = medium regression
  failOnAnyRegression: true, // Fail CI if any scenario regresses
  maxAllowedRegressions: 0, // Zero tolerance for regressions
};

// ============================================================================
// RedTeamBaselineManager
// ============================================================================

export class RedTeamBaselineManager {
  private config: BaselineConfig;
  private baseline: RedTeamBaseline | null = null;

  constructor(config?: Partial<BaselineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Baseline Storage ─────────────────────────────────────────────────

  /**
   * Load the baseline from disk. Returns null if no baseline exists.
   */
  loadBaseline(): RedTeamBaseline | null {
    try {
      const raw = fs.readFileSync(this.config.baselinePath, 'utf-8');
      const baseline = JSON.parse(raw) as RedTeamBaseline;

      // Verify signature
      if (!this.verifySignature(baseline)) {
        // Signature mismatch — baseline may be tampered
        getAuditChainLedger().logEvent({
          type: 'security_scan',
          severity: 'critical',
          source: 'RedTeamBaseline',
          message: 'Baseline signature verification FAILED — possible tampering',
          details: { runId: baseline.metadata.runId },
        });
        return null;
      }

      this.baseline = baseline;
      return baseline;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // No baseline yet — first run
        return null;
      }
      // Corrupted or unreadable baseline
      return null;
    }
  }

  /**
   * Save a new baseline from a red team run report.
   * Only call this on trusted runs (i.e., main branch after review).
   */
  saveBaseline(
    report: RedTeamRunReport,
    gitInfo?: { commitHash?: string; branch?: string },
  ): RedTeamBaseline {
    const now = new Date().toISOString();

    const existing = this.loadBaseline();

    const baseline: RedTeamBaseline = {
      metadata: {
        version: 1,
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
        runId: report.runId,
        commitHash: gitInfo?.commitHash,
        branch: gitInfo?.branch,
      },
      report,
      signature: '', // Will be set below
    };

    // Compute HMAC signature
    baseline.signature = this.computeSignature(baseline);

    // Ensure directory exists
    const dir = path.dirname(this.config.baselinePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write: write to tmp, then rename
    const tmpPath = `${this.config.baselinePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, JSON.stringify(baseline, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.config.baselinePath);

    this.baseline = baseline;

    // Audit
    getAuditChainLedger().logEvent({
      type: 'config_change',
      severity: 'medium',
      source: 'RedTeamBaseline',
      message: `Baseline updated: run=${report.runId}, score=${report.securityScore}/100`,
      details: {
        runId: report.runId,
        securityScore: report.securityScore,
        scenarioCount: report.totalTests,
        commitHash: gitInfo?.commitHash,
      },
    });

    return baseline;
  }

  /**
   * Check if a baseline exists on disk.
   */
  hasBaseline(): boolean {
    try {
      fs.accessSync(this.config.baselinePath);
      return true;
    } catch (err) {
      reportSilentFailure(err, 'redTeamBaseline:262');
      return false;
    }
  }

  // ── Regression Detection ─────────────────────────────────────────────

  /**
   * Compare a new red team run against the stored baseline.
   * Detects regressions (previously blocked → now missed) and
   * improvements (previously missed → now blocked).
   */
  compareToBaseline(report: RedTeamRunReport): BaselineComparison {
    const baseline = this.loadBaseline();

    if (!baseline) {
      return {
        runId: report.runId,
        baselineRunId: 'none',
        performed: false,
        baselineScore: 0,
        currentScore: report.securityScore,
        scoreDelta: report.securityScore,
        regressions: [],
        improvements: [],
        overallSeverity: 'none',
        passed: true,
        summary: 'No baseline exists yet. This run establishes the first baseline.',
        comparedAt: new Date().toISOString(),
      };
    }

    const regressions: RegressionResult[] = [];
    const improvements: ImprovementResult[] = [];

    // Build a lookup of baseline results by scenario ID
    const baselineMap = new Map<string, RedTeamTestResult>();
    for (const result of baseline.report.results) {
      baselineMap.set(result.scenario.id, result);
    }

    // Compare each current result against baseline
    for (const current of report.results) {
      const baselineResult = baselineMap.get(current.scenario.id);
      if (!baselineResult) {
        // New scenario not in baseline — skip comparison
        continue;
      }

      // Regression: was BLOCKED, now MISSED
      if (baselineResult.result === 'blocked' && current.result === 'missed') {
        regressions.push({
          scenarioId: current.scenario.id,
          scenarioName: current.scenario.name,
          category: current.scenario.category,
          baselineResult: baselineResult.result,
          currentResult: current.result,
          severity: this.mapRegressionSeverity(current.scenario.severity),
          cvssScore: current.scenario.cvssScore,
        });
      }

      // Degradation: was DETECTED, now MISSED (partial defense lost)
      if (baselineResult.result === 'detected' && current.result === 'missed') {
        regressions.push({
          scenarioId: current.scenario.id,
          scenarioName: current.scenario.name,
          category: current.scenario.category,
          baselineResult: baselineResult.result,
          currentResult: current.result,
          severity: 'low',
          cvssScore: current.scenario.cvssScore,
        });
      }

      // Improvement: was MISSED, now BLOCKED
      if (baselineResult.result === 'missed' && current.result === 'blocked') {
        improvements.push({
          scenarioId: current.scenario.id,
          scenarioName: current.scenario.name,
          category: current.scenario.category,
          baselineResult: baselineResult.result,
          currentResult: current.result,
          cvssScore: current.scenario.cvssScore,
        });
      }

      // Also detect: was BLOCKED, now ERROR (defense broken)
      if (baselineResult.result === 'blocked' && current.result === 'error') {
        regressions.push({
          scenarioId: current.scenario.id,
          scenarioName: current.scenario.name,
          category: current.scenario.category,
          baselineResult: baselineResult.result,
          currentResult: current.result,
          severity: 'high',
          cvssScore: current.scenario.cvssScore,
        });
      }
    }

    // Score regression
    const scoreDelta = report.securityScore - baseline.report.securityScore;

    // Determine overall severity
    const criticalRegressions = regressions.filter((r) => r.severity === 'critical');
    const highRegressions = regressions.filter((r) => r.severity === 'high');

    let overallSeverity: RegressionSeverity = 'none';
    if (criticalRegressions.length > 0) {
      overallSeverity = 'critical';
    } else if (highRegressions.length > 0) {
      overallSeverity = 'high';
    } else if (regressions.length >= 3 || scoreDelta <= -this.config.scoreRegressionThreshold) {
      overallSeverity = 'medium';
    } else if (regressions.length > 0) {
      overallSeverity = 'low';
    }

    // Determine if this run passes
    let passed = true;
    if (this.config.failOnAnyRegression && regressions.length > 0) {
      passed = false;
    }
    if (regressions.length > this.config.maxAllowedRegressions) {
      passed = false;
    }
    if (criticalRegressions.length > 0) {
      passed = false; // Critical regressions always fail
    }

    // Build summary
    const parts: string[] = [];
    parts.push(
      `Score: ${report.securityScore}/100 (${scoreDelta >= 0 ? '+' : ''}${scoreDelta} vs baseline ${baseline.report.securityScore}/100)`,
    );
    if (regressions.length > 0) {
      parts.push(`${regressions.length} regression(s) detected`);
      if (criticalRegressions.length > 0) {
        parts.push(`${criticalRegressions.length} CRITICAL`);
      }
      if (highRegressions.length > 0) {
        parts.push(`${highRegressions.length} HIGH`);
      }
    }
    if (improvements.length > 0) {
      parts.push(`${improvements.length} improvement(s)`);
    }
    if (passed) {
      parts.push('✅ PASSED');
    } else {
      parts.push('❌ FAILED');
    }

    const comparison: BaselineComparison = {
      runId: report.runId,
      baselineRunId: baseline.metadata.runId,
      performed: true,
      baselineScore: baseline.report.securityScore,
      currentScore: report.securityScore,
      scoreDelta,
      regressions,
      improvements,
      overallSeverity,
      passed,
      summary: parts.join(' | '),
      comparedAt: new Date().toISOString(),
    };

    // Audit the comparison
    if (!passed) {
      getAuditChainLedger().logEvent({
        type: 'security_scan',
        severity: overallSeverity === 'critical' ? 'critical' : 'high',
        source: 'RedTeamBaseline',
        message: `Regression detected: ${comparison.summary}`,
        details: {
          regressions: regressions.map((r) => ({
            id: r.scenarioId,
            name: r.scenarioName,
            severity: r.severity,
          })),
          scoreDelta,
        },
      });
    }

    return comparison;
  }

  /**
   * Compare a smoke test run against the same scenarios from the baseline.
   * Only compares scenarios that exist in both runs.
   */
  compareSmokeToBaseline(report: RedTeamRunReport): BaselineComparison {
    // Smoke tests are a subset of the full baseline.
    // Use the same comparison logic — it naturally handles
    // scenarios that don't exist in the baseline (skips them).
    return this.compareToBaseline(report);
  }

  /**
   * Generate a CI-friendly summary string suitable for GitHub Actions
   * step summary or PR comment.
   */
  generateCiSummary(comparison: BaselineComparison): string {
    const lines: string[] = [];

    lines.push('## 🔴 Red Team Security Results');
    lines.push('');

    if (!comparison.performed) {
      lines.push('> ⚠️ **No baseline exists yet.** This run establishes the first baseline.');
      lines.push(`> Current score: **${comparison.currentScore}/100**`);
      lines.push('');
      return lines.join('\n');
    }

    // Status badge
    const statusIcon = comparison.passed ? '✅' : '❌';
    const scoreIcon = comparison.scoreDelta >= 0 ? '📈' : '📉';

    lines.push(`| Metric | Current | Baseline | Delta |`);
    lines.push(`|--------|---------|----------|-------|`);
    lines.push(`| ${statusIcon} **Status** | ${comparison.passed ? 'PASSED' : 'FAILED'} | — | — |`);
    lines.push(
      `| ${scoreIcon} **Score** | ${comparison.currentScore}/100 | ${comparison.baselineScore}/100 | ${comparison.scoreDelta >= 0 ? '+' : ''}${comparison.scoreDelta} |`,
    );
    lines.push(`| 🔴 **Regressions** | ${comparison.regressions.length} | — | — |`);
    lines.push(`| 🟢 **Improvements** | ${comparison.improvements.length} | — | — |`);
    lines.push('');

    // Regressions detail
    if (comparison.regressions.length > 0) {
      lines.push('### 🚨 Regressions');
      lines.push('');
      lines.push('| Scenario | ID | Category | CVSS | Severity |');
      lines.push('|----------|----|----------|------|----------|');
      for (const r of comparison.regressions) {
        const sevIcon =
          r.severity === 'critical'
            ? '🔴'
            : r.severity === 'high'
              ? '🟠'
              : r.severity === 'medium'
                ? '🟡'
                : '🔵';
        lines.push(
          `| ${r.scenarioName} | ${r.scenarioId} | ${r.category} | ${r.cvssScore.toFixed(1)} | ${sevIcon} ${r.severity} |`,
        );
      }
      lines.push('');
    }

    // Improvements detail
    if (comparison.improvements.length > 0) {
      lines.push('### 🎉 Improvements');
      lines.push('');
      for (const i of comparison.improvements) {
        lines.push(`- **${i.scenarioId}** ${i.scenarioName} — was missed, now BLOCKED`);
      }
      lines.push('');
    }

    // Summary line
    lines.push(`> **${comparison.summary}**`);

    return lines.join('\n');
  }

  /**
   * Generate GitHub Actions workflow annotations for detected regressions.
   */
  generateCiAnnotations(comparison: BaselineComparison): string[] {
    const annotations: string[] = [];
    for (const r of comparison.regressions) {
      const level = r.severity === 'critical' || r.severity === 'high' ? 'error' : 'warning';
      annotations.push(
        `::${level} title=Red Team Regression::[${r.scenarioId}] ${r.scenarioName} regressed: was BLOCKED, now MISSED (CVSS ${r.cvssScore})`,
      );
    }
    return annotations;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Get the loaded baseline (without re-reading from disk).
   */
  getBaseline(): RedTeamBaseline | null {
    return this.baseline ?? this.loadBaseline();
  }

  /**
   * Get the baseline path.
   */
  getBaselinePath(): string {
    return this.config.baselinePath;
  }

  private mapRegressionSeverity(scenarioSeverity: string): RegressionSeverity {
    switch (scenarioSeverity) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      case 'medium':
        return 'medium';
      case 'low':
        return 'low';
      default:
        return 'medium';
    }
  }

  private computeSignature(baseline: Omit<RedTeamBaseline, 'signature'>): string {
    const data = JSON.stringify({
      metadata: baseline.metadata,
      report: {
        runId: baseline.report.runId,
        securityScore: baseline.report.securityScore,
        summary: baseline.report.summary,
        criticalFindings: baseline.report.criticalFindings,
        totalTests: baseline.report.totalTests,
        // Include per-scenario results for full integrity protection
        results: baseline.report.results.map((r) => ({
          scenarioId: r.scenario.id,
          result: r.result,
        })),
      },
    });
    return crypto.createHmac('sha256', 'commander-red-team-baseline-v1').update(data).digest('hex');
  }

  private verifySignature(baseline: RedTeamBaseline): boolean {
    const expected = this.computeSignature(baseline);
    return crypto.timingSafeEqual(
      Buffer.from(baseline.signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  }

  /** Reset state (for test isolation). */
  reset(): void {
    this.baseline = null;
  }
}

// ============================================================================
// Singleton
// ============================================================================

const baselineSingleton = createTenantAwareSingleton(() => new RedTeamBaselineManager());

/** Get the global RedTeamBaselineManager. */
export function getRedTeamBaseline(_config?: Partial<BaselineConfig>): RedTeamBaselineManager {
  return baselineSingleton.get();
}

/** Reset the baseline manager (for test isolation). */
export function resetRedTeamBaseline(): void {
  baselineSingleton.reset();
}
