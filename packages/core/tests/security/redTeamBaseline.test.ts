/**
 * RedTeamBaseline Tests — Regression detection for continuous red team CI/CD.
 *
 * Covers:
 *   - Save/load baseline with signature verification
 *   - Regression detection (blocked → missed, blocked → error)
 *   - Improvement detection (missed → blocked)
 *   - Score regression detection
 *   - Tamper detection (signature verification)
 *   - CI summary generation (markdown)
 *   - CI annotation generation (GitHub Actions format)
 *   - No-baseline case (first run)
 *   - New scenarios not in baseline
 *   - Config options (failOnAnyRegression, maxAllowedRegressions, scoreRegressionThreshold)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RedTeamBaselineManager,
  resetRedTeamBaseline,
} from '../../src/security/redTeamBaseline';
import type {
  RedTeamRunReport,
  RedTeamTestScenario,
  RedTeamTestResult,
} from '../../src/security/redTeamFramework';
import type { BaselineConfig } from '../../src/security/redTeamBaseline';

// ============================================================================
// Helpers
// ============================================================================

function makeScenario(overrides: Partial<RedTeamTestScenario> = {}): RedTeamTestScenario {
  return {
    id: overrides.id ?? 'TEST-001',
    category: overrides.category ?? 'prompt_injection',
    name: overrides.name ?? 'Test scenario',
    description: overrides.description ?? 'Test description',
    payload: overrides.payload ?? 'test payload',
    expectedDefense: overrides.expectedDefense ?? 'contentScanner',
    severity: overrides.severity ?? 'high',
    cvssScore: overrides.cvssScore ?? 7.0,
    tags: overrides.tags ?? ['test'],
  };
}

function makeResult(
  scenario: RedTeamTestScenario,
  result: 'blocked' | 'detected' | 'missed' | 'error' = 'blocked',
  defense?: string,
): RedTeamTestResult {
  return {
    scenario,
    result,
    triggeredDefense: defense ?? 'contentScanner:promptInjection',
    durationMs: 10,
    details: result === 'blocked' ? 'Blocked by defense' : 'Attack missed',
    testedAt: new Date().toISOString(),
  };
}

function makeReport(
  results: RedTeamTestResult[],
  overrides: Partial<RedTeamRunReport> = {},
): RedTeamRunReport {
  const blocked = results.filter((r) => r.result === 'blocked').length;
  const detected = results.filter((r) => r.result === 'detected').length;
  const missed = results.filter((r) => r.result === 'missed').length;
  const error = results.filter((r) => r.result === 'error').length;
  const total = results.length;

  const securityScore =
    total > 0 ? Math.round(((blocked * 100 + detected * 50) / total)) : 0;

  return {
    runId: overrides.runId ?? `test-run-${Date.now()}`,
    totalTests: overrides.totalTests ?? total,
    summary: overrides.summary ?? { blocked, detected, missed, error },
    results,
    securityScore: overrides.securityScore ?? securityScore,
    criticalFindings: overrides.criticalFindings ?? [],
    runAt: overrides.runAt ?? new Date().toISOString(),
    durationMs: overrides.durationMs ?? 1000,
  };
}

function tmpBaselinePath(): string {
  return path.join(os.tmpdir(), `rt-baseline-test-${Date.now()}.json`);
}

function cleanupTmp(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ok */ }
  try { fs.unlinkSync(`${p}.tmp`); } catch { /* ok */ }
}

// ============================================================================
// Tests
// ============================================================================

describe('RedTeamBaselineManager', () => {
  let config: BaselineConfig;
  let manager: RedTeamBaselineManager;

  beforeEach(() => {
    resetRedTeamBaseline();
    config = {
      baselinePath: tmpBaselinePath(),
      scoreRegressionThreshold: 10,
      failOnAnyRegression: true,
      maxAllowedRegressions: 0,
    };
    manager = new RedTeamBaselineManager(config);
  });

  afterEach(() => {
    cleanupTmp(config.baselinePath);
    resetRedTeamBaseline();
  });

  // ── Save / Load ─────────────────────────────────────────────────────

  describe('saveBaseline and loadBaseline', () => {
    it('saves a baseline to disk and loads it back', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const result = makeResult(scenario, 'blocked');
      const report = makeReport([result]);

      const baseline = manager.saveBaseline(report);
      expect(baseline.metadata.runId).toBe(report.runId);
      expect(baseline.signature).toBeTruthy();
      expect(baseline.signature.length).toBe(64); // SHA-256 hex

      const loaded = manager.loadBaseline();
      expect(loaded).not.toBeNull();
      expect(loaded!.metadata.runId).toBe(report.runId);
      expect(loaded!.report.securityScore).toBe(100);
    });

    it('hasBaseline returns true after save', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(report);
      expect(manager.hasBaseline()).toBe(true);
    });

    it('hasBaseline returns false when no baseline saved', () => {
      expect(manager.hasBaseline()).toBe(false);
    });

    it('saves with git metadata', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      const baseline = manager.saveBaseline(report, {
        commitHash: 'abc123',
        branch: 'main',
      });
      expect(baseline.metadata.commitHash).toBe('abc123');
      expect(baseline.metadata.branch).toBe('main');
    });

    it('updates updatedAt on re-save', async () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report1 = makeReport([makeResult(scenario, 'blocked')]);
      const b1 = manager.saveBaseline(report1);
      const createdAt = b1.metadata.createdAt;

      await new Promise((r) => setTimeout(r, 10));

      const report2 = makeReport([makeResult(scenario, 'blocked')], {
        runId: 'test-run-2',
      });
      const b2 = manager.saveBaseline(report2);
      expect(b2.metadata.createdAt).toBe(createdAt);
      expect(b2.metadata.updatedAt).not.toBe(createdAt);
    });
  });

  // ── Signature Verification ──────────────────────────────────────────

  describe('signature verification', () => {
    it('rejects tampered baseline (modified score)', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(report);

      // Tamper: modify the score on disk
      const raw = JSON.parse(fs.readFileSync(config.baselinePath, 'utf-8'));
      raw.report.securityScore = 0; // Tampered
      fs.writeFileSync(config.baselinePath, JSON.stringify(raw));

      const loaded = manager.loadBaseline();
      expect(loaded).toBeNull(); // Should reject tampered baseline
    });

    it('rejects tampered baseline (modified summary)', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(report);

      const raw = JSON.parse(fs.readFileSync(config.baselinePath, 'utf-8'));
      raw.report.summary.blocked = 0; // Tampered
      fs.writeFileSync(config.baselinePath, JSON.stringify(raw));

      const loaded = manager.loadBaseline();
      expect(loaded).toBeNull();
    });

    it('loads valid baseline with correct signature', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(report);

      // Should load without issues
      const loaded = manager.loadBaseline();
      expect(loaded).not.toBeNull();
      expect(loaded!.report.securityScore).toBe(100);
    });

    it('returns null for corrupted JSON', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(report);

      fs.writeFileSync(config.baselinePath, '{corrupted json!!!');

      const loaded = manager.loadBaseline();
      expect(loaded).toBeNull();
    });
  });

  // ── Regression Detection ────────────────────────────────────────────

  describe('compareToBaseline', () => {
    it('detects no regressions when all blocked in both runs', () => {
      const scenarios = [
        makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 }),
        makeScenario({ id: 'JB-001', severity: 'critical', cvssScore: 9.5 }),
        makeScenario({ id: 'TA-001', severity: 'critical', cvssScore: 9.0 }),
      ];
      const baselineReport = makeReport(scenarios.map((s) => makeResult(s, 'blocked')));
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(scenarios.map((s) => makeResult(s, 'blocked')), {
        runId: 'test-run-2',
      });

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.performed).toBe(true);
      expect(comparison.regressions).toHaveLength(0);
      expect(comparison.overallSeverity).toBe('none');
      expect(comparison.passed).toBe(true);
    });

    it('detects regression: blocked → missed', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'missed')],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(1);
      expect(comparison.regressions[0].scenarioId).toBe('PI-001');
      expect(comparison.regressions[0].severity).toBe('critical');
      expect(comparison.regressions[0].currentResult).toBe('missed');
      expect(comparison.overallSeverity).toBe('critical');
      expect(comparison.passed).toBe(false);
      expect(comparison.improvements).toHaveLength(0);
    });

    it('detects regression: blocked → error', () => {
      const scenario = makeScenario({ id: 'SC-001', severity: 'critical', cvssScore: 10.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'error')],
        { runId: 'test-run-3' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(1);
      expect(comparison.regressions[0].severity).toBe('high');
      expect(comparison.regressions[0].currentResult).toBe('error');
      expect(comparison.passed).toBe(false);
    });

    it('detects improvement: missed → blocked', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const baselineReport = makeReport([makeResult(scenario, 'missed')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'blocked')],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.improvements).toHaveLength(1);
      expect(comparison.improvements[0].scenarioId).toBe('PI-001');
      expect(comparison.regressions).toHaveLength(0);
      expect(comparison.passed).toBe(true);
    });

    it('detects mixed regressions and improvements', () => {
      const regressed = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const improved = makeScenario({ id: 'JB-001', severity: 'critical', cvssScore: 9.5 });
      const stable = makeScenario({ id: 'TA-001', severity: 'critical', cvssScore: 9.0 });

      const baselineReport = makeReport([
        makeResult(regressed, 'blocked'),
        makeResult(improved, 'missed'),
        makeResult(stable, 'blocked'),
      ]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [
          makeResult(regressed, 'missed'), // Regression
          makeResult(improved, 'blocked'), // Improvement
          makeResult(stable, 'blocked'),   // Stable
        ],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(1);
      expect(comparison.regressions[0].scenarioId).toBe('PI-001');
      expect(comparison.improvements).toHaveLength(1);
      expect(comparison.improvements[0].scenarioId).toBe('JB-001');
      expect(comparison.passed).toBe(false); // Regression always fails
    });

    it('new scenarios not in baseline are skipped', () => {
      const existing = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const newScen = makeScenario({ id: 'PI-999', severity: 'high', cvssScore: 7.0 });

      const baselineReport = makeReport([makeResult(existing, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(existing, 'blocked'), makeResult(newScen, 'missed')],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      // New scenario PI-999 missed but it was never in baseline → no regression
      expect(comparison.regressions).toHaveLength(0);
      expect(comparison.passed).toBe(true);
    });

    it('no baseline case: passes and reports no baseline', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const report = makeReport(
        [makeResult(scenario, 'blocked')],
        { runId: 'first-run' },
      );

      const comparison = manager.compareToBaseline(report);
      expect(comparison.performed).toBe(false);
      expect(comparison.baselineRunId).toBe('none');
      expect(comparison.passed).toBe(true);
      expect(comparison.regressions).toHaveLength(0);
      expect(comparison.summary).toContain('No baseline exists');
    });
  });

  // ── Score Regression ────────────────────────────────────────────────

  describe('score regression', () => {
    it('detects score drop below threshold', () => {
      const scenarios = [
        makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 }),
        makeScenario({ id: 'JB-001', severity: 'critical', cvssScore: 9.5 }),
      ];
      // Baseline: both blocked → score 100
      const baselineReport = makeReport(scenarios.map((s) => makeResult(s, 'blocked')));
      manager.saveBaseline(baselineReport);

      // Current: one missed → score 50, drop of 50 > threshold 10
      const currentReport = makeReport(
        [makeResult(scenarios[0], 'missed'), makeResult(scenarios[1], 'blocked')],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.scoreDelta).toBe(-50);
      expect(comparison.overallSeverity).toBe('critical'); // critical regression
      expect(comparison.passed).toBe(false);
    });

    it('small score drop below threshold is only medium severity (if no regressions)', () => {
      // Baseline: 0 blocked, 2 detected → score (0 + 2*50)/2 = 50
      const scenarios = [
        makeScenario({ id: 'DEP-001', severity: 'low', cvssScore: 4.0 }),
        makeScenario({ id: 'DEP-002', severity: 'low', cvssScore: 4.0 }),
      ];
      const baselineReport = makeReport(
        scenarios.map((s) => makeResult(s, 'detected')),
        { securityScore: 50 },
      );
      manager.saveBaseline(baselineReport);

      // Current: 0 blocked, 1 detected, 1 missed → score 25, drop of 25
      const currentReport = makeReport(
        [makeResult(scenarios[0], 'detected'), makeResult(scenarios[1], 'missed')],
        { runId: 'test-run-2', securityScore: 25 },
      );

      const comparison = manager.compareToBaseline(currentReport);
      // Since a previously-detected (not blocked) scenario became missed,
      // this isn't a traditional regression (only blocked→missed counts).
      // But score dropped 25 which is >= threshold 10 → medium severity.
      expect(comparison.scoreDelta).toBe(-25);
      // Check: the scenarios went from detected→missed and detected→missed
      // No blocked→missed regression, so no individual regressions
      // But score drop >= threshold → overall medium severity
      expect(comparison.overallSeverity).toBe('medium');
    });
  });

  // ── Config Options ──────────────────────────────────────────────────

  describe('config options', () => {
    it('failOnAnyRegression=false allows regressions', () => {
      const mgr = new RedTeamBaselineManager({
        ...config,
        failOnAnyRegression: false,
        maxAllowedRegressions: 5,
      });

      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      mgr.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'missed')],
        { runId: 'test-run-2' },
      );

      const comparison = mgr.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(1);
      // failOnAnyRegression=false → still fails because critical regression
      expect(comparison.passed).toBe(false);
      cleanupTmp(mgr.getBaselinePath());
    });

    it('maxAllowedRegressions allows some but fails beyond limit', () => {
      const mgr = new RedTeamBaselineManager({
        ...config,
        failOnAnyRegression: true,
        maxAllowedRegressions: 1,
      });

      const s1 = makeScenario({ id: 'PI-001', severity: 'high', cvssScore: 7.0 });
      const s2 = makeScenario({ id: 'JB-001', severity: 'high', cvssScore: 8.0 });
      const baselineReport = makeReport([
        makeResult(s1, 'blocked'),
        makeResult(s2, 'blocked'),
      ]);
      mgr.saveBaseline(baselineReport);

      // 2 regressions > maxAllowed (1) → fails
      const currentReport = makeReport(
        [makeResult(s1, 'missed'), makeResult(s2, 'missed')],
        { runId: 'test-run-3' },
      );

      const comparison = mgr.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(2);
      expect(comparison.passed).toBe(false);
      cleanupTmp(mgr.getBaselinePath());
    });

    it('scoreRegressionThreshold higher avoids false positives', () => {
      const mgr = new RedTeamBaselineManager({
        ...config,
        scoreRegressionThreshold: 50, // High threshold, won't trigger on small drops
      });

      const baselineReport = makeReport(
        [makeResult(makeScenario({ id: 'PI-001', severity: 'high', cvssScore: 7.0 }), 'blocked')],
        { securityScore: 100 },
      );
      mgr.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(makeScenario({ id: 'PI-001', severity: 'high', cvssScore: 7.0 }), 'missed')],
        { runId: 'test-run-2', securityScore: 0 },
      );

      const comparison = mgr.compareToBaseline(currentReport);
      // Regression detected (blocked→missed) so it still fails
      expect(comparison.regressions).toHaveLength(1);
      expect(comparison.passed).toBe(false);
      cleanupTmp(mgr.getBaselinePath());
    });
  });

  // ── CI Output ───────────────────────────────────────────────────────

  describe('generateCiSummary', () => {
    it('generates markdown summary for passing run', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'blocked')],
        { runId: 'test-run-2' },
      );
      const comparison = manager.compareToBaseline(currentReport);

      const summary = manager.generateCiSummary(comparison);
      expect(summary).toContain('## 🔴 Red Team Security Results');
      expect(summary).toContain('PASSED');
      expect(summary).toContain('100/100');
      expect(summary).toContain('**Score**');
    });

    it('generates markdown summary for failing run with regressions', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'missed')],
        { runId: 'test-run-2' },
      );
      const comparison = manager.compareToBaseline(currentReport);

      const summary = manager.generateCiSummary(comparison);
      expect(summary).toContain('FAILED');
      expect(summary).toContain('Regressions');
      expect(summary).toContain('PI-001');
      expect(summary).toContain('critical');
    });

    it('generates summary for no-baseline case', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const report = makeReport([makeResult(scenario, 'blocked')]);
      const comparison = manager.compareToBaseline(report);

      const summary = manager.generateCiSummary(comparison);
      expect(summary).toContain('No baseline exists');
    });
  });

  describe('generateCiAnnotations', () => {
    it('generates GitHub Actions annotations for regressions', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'missed')],
        { runId: 'test-run-2' },
      );
      const comparison = manager.compareToBaseline(currentReport);

      const annotations = manager.generateCiAnnotations(comparison);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toContain('::error');
      expect(annotations[0]).toContain('PI-001');
      expect(annotations[0]).toContain('regressed');
    });

    it('uses warning level for low-severity regressions', () => {
      const scenario = makeScenario({ id: 'MP-002', severity: 'medium', cvssScore: 5.5 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(scenario, 'missed')],
        { runId: 'test-run-2' },
      );
      const comparison = manager.compareToBaseline(currentReport);

      const annotations = manager.generateCiAnnotations(comparison);
      expect(annotations[0]).toContain('::warning');
    });

    it('returns empty array when no regressions', () => {
      const scenario = makeScenario({ id: 'PI-001' });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);
      const currentReport = makeReport([makeResult(scenario, 'blocked')]);

      const comparison = manager.compareToBaseline(currentReport);
      const annotations = manager.generateCiAnnotations(comparison);
      expect(annotations).toHaveLength(0);
    });
  });

  // ── compareSmokeToBaseline ──────────────────────────────────────────

  describe('compareSmokeToBaseline', () => {
    it('compares smoke test results against full baseline', () => {
      const full = [
        makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 }),
        makeScenario({ id: 'JB-001', severity: 'critical', cvssScore: 9.5 }),
        makeScenario({ id: 'TA-001', severity: 'critical', cvssScore: 9.0 }),
      ];
      const baselineReport = makeReport(full.map((s) => makeResult(s, 'blocked')));
      manager.saveBaseline(baselineReport);

      // Smoke: only 2 of 3 scenarios
      const smokeReport = makeReport(
        [makeResult(full[0], 'missed'), makeResult(full[1], 'blocked')],
        { runId: 'smoke-run' },
      );

      const comparison = manager.compareSmokeToBaseline(smokeReport);
      expect(comparison.performed).toBe(true);
      expect(comparison.regressions).toHaveLength(1);
      expect(comparison.regressions[0].scenarioId).toBe('PI-001');
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('multiple regressions across categories', () => {
      const s1 = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0, category: 'prompt_injection' });
      const s2 = makeScenario({ id: 'JB-001', severity: 'critical', cvssScore: 9.5, category: 'jailbreak' });
      const s3 = makeScenario({ id: 'TA-001', severity: 'high', cvssScore: 8.5, category: 'tool_abuse' });

      const baselineReport = makeReport([
        makeResult(s1, 'blocked'),
        makeResult(s2, 'blocked'),
        makeResult(s3, 'blocked'),
      ]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [
          makeResult(s1, 'missed'),
          makeResult(s2, 'missed'),
          makeResult(s3, 'missed'),
        ],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(3);
      expect(comparison.overallSeverity).toBe('critical');
      expect(comparison.passed).toBe(false);
    });

    it('score improvement (all missed→blocked) shows positive delta', () => {
      const s1 = makeScenario({ id: 'PI-001', severity: 'critical', cvssScore: 9.0 });
      const s2 = makeScenario({ id: 'JB-001', severity: 'critical', cvssScore: 9.5 });
      const baselineReport = makeReport([
        makeResult(s1, 'missed'),
        makeResult(s2, 'missed'),
      ]);
      manager.saveBaseline(baselineReport);

      const currentReport = makeReport(
        [makeResult(s1, 'blocked'), makeResult(s2, 'blocked')],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.scoreDelta).toBe(100);
      expect(comparison.improvements).toHaveLength(2);
      expect(comparison.regressions).toHaveLength(0);
      expect(comparison.passed).toBe(true);
    });

    it('detected results do not count as regression or improvement', () => {
      const scenario = makeScenario({ id: 'PI-001', severity: 'high', cvssScore: 7.0 });
      const baselineReport = makeReport([makeResult(scenario, 'blocked')]);
      manager.saveBaseline(baselineReport);

      // Current: detected (not blocked, not missed)
      const currentReport = makeReport(
        [makeResult(scenario, 'detected')],
        { runId: 'test-run-2' },
      );

      const comparison = manager.compareToBaseline(currentReport);
      expect(comparison.regressions).toHaveLength(0);
      expect(comparison.improvements).toHaveLength(0);
    });
  });
});
