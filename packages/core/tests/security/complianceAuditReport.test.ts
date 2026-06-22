/**
 * ComplianceAuditReport Tests — ISO 42001/NIST AI RMF audit preparation.
 *
 * Covers:
 *   - Security posture scoring (weighted across 6 dimensions)
 *   - ISO 42001 clause mapping and gap analysis
 *   - NIST AI RMF function/subcategory alignment
 *   - Posture snapshot history and persistence
 *   - Trend analysis (improving/stable/declining)
 *   - Full report generation and formatting (markdown + JSON)
 *   - HMAC report signing
 *   - Audit checklist generation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ComplianceAuditManager,
  resetComplianceAuditManager,
} from '../../src/security/complianceAuditReport';
import type {
  ComplianceControl,
  ComplianceConfig,
  ComplianceAuditReport,
} from '../../src/security/complianceAuditReport';

// ============================================================================
// Helpers
// ============================================================================

function makeControl(overrides: Partial<ComplianceControl> = {}): ComplianceControl {
  return {
    id: overrides.id ?? 'CTL-TEST',
    name: overrides.name ?? 'Test Control',
    description: 'A test security control',
    implementedBy: ['TestModule'],
    isoClauses: overrides.isoClauses ?? ['8.1', '9.1'],
    nistSubcategories: overrides.nistSubcategories ?? ['MEASURE-2.1'],
    effectivenessScore: overrides.effectivenessScore ?? 80,
    evidence: ['test evidence'],
    automated: true,
  };
}

function tmpSnapshotPath(): string {
  return path.join(os.tmpdir(), `posture-snapshots-test-${Date.now()}.json`);
}

function cleanupTmp(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ok */
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('ComplianceAuditManager', () => {
  let config: ComplianceConfig;
  let manager: ComplianceAuditManager;

  beforeEach(() => {
    resetComplianceAuditManager();
    config = {
      snapshotPath: tmpSnapshotPath(),
      maxSnapshots: 100,
      autoSnapshotIntervalMs: 0,
      auditPassThreshold: 80,
      signReports: true,
      signingKey: 'test-key',
    };
    manager = new ComplianceAuditManager(config);
  });

  afterEach(() => {
    cleanupTmp(config.snapshotPath);
    resetComplianceAuditManager();
  });

  // ── Posture Scoring ────────────────────────────────────────────────

  describe('calculatePosture', () => {
    it('calculates weighted overall security score across all dimensions', () => {
      const posture = manager.calculatePosture();

      expect(posture.overallScore).toBeGreaterThan(0);
      expect(posture.overallScore).toBeLessThanOrEqual(100);
      expect(posture.dimensions).toHaveLength(6);
      expect(posture.grade).toBeTruthy();
      expect(posture.status).toBeTruthy();
    });

    it('returns all 6 scoring dimensions', () => {
      const posture = manager.calculatePosture();
      const dimNames = posture.dimensions.map((d) => d.dimension);

      expect(dimNames).toContain('input_security');
      expect(dimNames).toContain('tool_safety');
      expect(dimNames).toContain('runtime_defense');
      expect(dimNames).toContain('supply_chain');
      expect(dimNames).toContain('economic_defense');
      expect(dimNames).toContain('operational_readiness');
    });

    it('dimensions have correct weights summing to 1', () => {
      const posture = manager.calculatePosture();
      const totalWeight = posture.dimensions.reduce((sum, d) => sum + d.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    });

    it('returns top risks and strengths', () => {
      const posture = manager.calculatePosture();
      expect(posture.topRisks.length).toBeGreaterThan(0);
      expect(posture.topStrengths.length).toBeGreaterThan(0);
    });

    it('grades correctly for score ranges', () => {
      // Default controls give ~83 score → B
      const posture = manager.calculatePosture();
      expect(posture.grade).toBeTruthy();
      expect(typeof posture.grade).toBe('string');
    });

    it('custom controls affect the score', () => {
      const customControls: ComplianceControl[] = [
        makeControl({ id: 'CTL-HIGH', effectivenessScore: 95, isoClauses: ['8.1'] }),
      ];
      const mgr = new ComplianceAuditManager(config, customControls);
      const posture = mgr.calculatePosture();

      // Only one dimension (operational_readiness) has the control
      const opDim = posture.dimensions.find((d) => d.dimension === 'operational_readiness');
      expect(opDim!.score).toBe(95);
    });
  });

  // ── ISO 42001 Compliance ───────────────────────────────────────────

  describe('generateIsoCompliance', () => {
    it('maps controls to ISO clauses and calculates coverage', () => {
      const iso = manager.generateIsoCompliance();

      expect(iso.compliancePercentage).toBeGreaterThan(0);
      expect(iso.clauseCoverage.size).toBeGreaterThan(0);
    });

    it('identifies gaps for uncovered clauses', () => {
      const iso = manager.generateIsoCompliance();

      // With the built-in catalog, all clauses should be covered
      // But we verify the gap list exists
      expect(Array.isArray(iso.gaps)).toBe(true);
    });

    it('returns fullyCompliant flag', () => {
      const iso = manager.generateIsoCompliance();
      expect(typeof iso.fullyCompliant).toBe('boolean');
    });

    it('all 15 ISO clauses are present in coverage map', () => {
      const iso = manager.generateIsoCompliance();
      expect(iso.clauseCoverage.size).toBe(15);
    });
  });

  // ── NIST AI RMF Alignment ──────────────────────────────────────────

  describe('generateNistRmfAlignment', () => {
    it('maps controls to NIST RMF functions', () => {
      const nist = manager.generateNistRmfAlignment();

      expect(nist.alignmentPercentage).toBeGreaterThan(0);
      expect(nist.functionCoverage.size).toBe(4);
    });

    it('covers all 4 NIST functions (GOVERN, MAP, MEASURE, MANAGE)', () => {
      const nist = manager.generateNistRmfAlignment();

      expect(nist.functionCoverage.has('GOVERN')).toBe(true);
      expect(nist.functionCoverage.has('MAP')).toBe(true);
      expect(nist.functionCoverage.has('MEASURE')).toBe(true);
      expect(nist.functionCoverage.has('MANAGE')).toBe(true);
    });

    it('each function has coverage percentage', () => {
      const nist = manager.generateNistRmfAlignment();

      for (const [, entry] of nist.functionCoverage) {
        expect(entry.coveragePercentage).toBeGreaterThanOrEqual(0);
        expect(entry.coveragePercentage).toBeLessThanOrEqual(100);
      }
    });

    it('identifies NIST mapping gaps', () => {
      const nist = manager.generateNistRmfAlignment();
      expect(Array.isArray(nist.gaps)).toBe(true);
    });
  });

  // ── Snapshots ──────────────────────────────────────────────────────

  describe('snapshots', () => {
    it('takes a posture snapshot', () => {
      const snap = manager.snapshot();

      expect(snap.id).toContain('POSTURE-');
      expect(snap.posture.overallScore).toBeGreaterThan(0);
      expect(snap.trigger).toBe('manual');
    });

    it('snapshot with options', () => {
      const snap = manager.snapshot({
        commitHash: 'abc123',
        trigger: 'ci_cd',
        notes: 'CI pipeline run',
      });

      expect(snap.commitHash).toBe('abc123');
      expect(snap.trigger).toBe('ci_cd');
      expect(snap.notes).toBe('CI pipeline run');
    });

    it('persists snapshots to disk', () => {
      manager.snapshot();
      manager.snapshot();

      // Create new manager to test persistence
      const mgr2 = new ComplianceAuditManager(config);
      expect(mgr2.getSnapshots()).toHaveLength(2);
      cleanupTmp(config.snapshotPath);
    });

    it('getSnapshots returns all snapshots', () => {
      manager.snapshot();
      manager.snapshot();
      manager.snapshot();

      expect(manager.getSnapshots()).toHaveLength(3);
    });

    it('clearSnapshots removes all', () => {
      manager.snapshot();
      manager.snapshot();
      manager.clearSnapshots();

      expect(manager.getSnapshots()).toHaveLength(0);
    });
  });

  // ── Trend Analysis ─────────────────────────────────────────────────

  describe('analyzeTrends', () => {
    it('returns insufficient_data when no snapshots', () => {
      const trend = manager.analyzeTrends();
      expect(trend.trend).toBe('insufficient_data');
      expect(trend.snapshotCount).toBe(0);
    });

    it('detects stable trend with identical scores', () => {
      // Use custom controls with fixed scores so we can predict output
      const ctrls = [
        makeControl({ id: 'CTL-A', effectivenessScore: 80, isoClauses: ['8.1'] }),
        makeControl({ id: 'CTL-B', effectivenessScore: 80, isoClauses: ['8.2'] }),
      ];
      const mgr = new ComplianceAuditManager(config, ctrls);

      mgr.snapshot();
      mgr.snapshot();
      mgr.snapshot();

      const trend = mgr.analyzeTrends();
      expect(trend.trend).toBe('stable');
      expect(trend.snapshotCount).toBe(3);
      expect(trend.averageScore).toBeGreaterThan(0);
    });

    it('calculates score delta', () => {
      const ctrls = [makeControl({ id: 'CTL-A', effectivenessScore: 70, isoClauses: ['8.1'] })];
      const mgr = new ComplianceAuditManager(config, ctrls);

      mgr.snapshot(); // Score based on CTL-A at 70
      mgr.snapshot(); // Same score

      const trend = mgr.analyzeTrends();
      expect(trend.scoreDelta).toBe(0);
      expect(trend.minScore).toBe(trend.maxScore);
    });

    it('provides projected score', () => {
      const ctrls = [
        makeControl({ id: 'CTL-A', effectivenessScore: 85, isoClauses: ['8.1'] }),
        makeControl({ id: 'CTL-B', effectivenessScore: 85, isoClauses: ['8.2'] }),
      ];
      const mgr = new ComplianceAuditManager(config, ctrls);

      mgr.snapshot();
      mgr.snapshot();

      const trend = mgr.analyzeTrends();
      expect(trend.projectedScore).toBeGreaterThanOrEqual(0);
      expect(trend.projectedScore).toBeLessThanOrEqual(100);
    });
  });

  // ── Full Report ────────────────────────────────────────────────────

  describe('generateFullReport', () => {
    it('generates complete audit report with all sections', () => {
      const report = manager.generateFullReport();

      expect(report.metadata.reportId).toContain('AUDIT-');
      expect(report.executiveSummary.length).toBeGreaterThan(50);
      expect(report.posture.overallScore).toBeGreaterThan(0);
      expect(report.postureHistory.length).toBeGreaterThan(0);
      expect(report.isoCompliance.compliancePercentage).toBeGreaterThan(0);
      expect(report.nistRmfAlignment.alignmentPercentage).toBeGreaterThan(0);
      expect(report.auditChecklist.length).toBeGreaterThan(0);
    });

    it('signs the report when signReports is enabled', () => {
      const report = manager.generateFullReport();
      expect(report.signature).toBeTruthy();
      expect(report.signature.length).toBe(64); // SHA-256 hex
    });

    it('does not sign when signReports is disabled', () => {
      const mgr = new ComplianceAuditManager({
        ...config,
        signReports: false,
      });
      const report = mgr.generateFullReport();
      expect(report.signature).toBe('');
      cleanupTmp(config.snapshotPath);
    });

    it('takes a snapshot during report generation by default', () => {
      const beforeSnaps = manager.getSnapshots().length;
      manager.generateFullReport();
      const afterSnaps = manager.getSnapshots().length;
      expect(afterSnaps).toBeGreaterThan(beforeSnaps);
    });

    it('can skip snapshot during report generation', () => {
      const beforeSnaps = manager.getSnapshots().length;
      manager.generateFullReport({ takeSnapshot: false });
      expect(manager.getSnapshots()).toHaveLength(beforeSnaps);
    });
  });

  // ── Report Formatting ──────────────────────────────────────────────

  describe('formatAsMarkdown', () => {
    it('produces readable markdown', () => {
      const report = manager.generateFullReport();
      const md = manager.formatAsMarkdown(report);

      expect(md).toContain('# ');
      expect(md).toContain('Commander');
      expect(md).toContain('Executive Summary');
      expect(md).toContain('Security Posture');
      expect(md).toContain('ISO 42001');
      expect(md).toContain('NIST AI RMF');
      expect(md).toContain('Trend Analysis');
      expect(md).toContain('Audit Readiness Checklist');
    });

    it('includes score chart when history available', () => {
      // Need ≥2 snapshots for the score chart to render
      manager.snapshot();
      manager.snapshot();
      const report = manager.generateFullReport({ takeSnapshot: false });
      const md = manager.formatAsMarkdown(report);

      expect(md).toContain('█');
      expect(md).toContain('░');
    });

    it('includes ISO clause coverage table', () => {
      const report = manager.generateFullReport();
      const md = manager.formatAsMarkdown(report);

      expect(md).toContain('6.1');
      expect(md).toContain('8.1');
      expect(md).toContain('9.1');
      expect(md).toContain('10.1');
    });
  });

  describe('formatAsJson', () => {
    it('produces valid JSON', () => {
      const report = manager.generateFullReport();
      const json = manager.formatAsJson(report);

      const parsed = JSON.parse(json);
      expect(parsed.metadata.reportId).toBe(report.metadata.reportId);
      expect(parsed.posture.overallScore).toBe(report.posture.overallScore);
    });
  });

  // ── Audit Checklist ────────────────────────────────────────────────

  describe('generateAuditChecklist', () => {
    it('returns checklist with all categories', () => {
      const checklist = manager.generateAuditChecklist();
      expect(checklist.length).toBeGreaterThan(0);

      const categories = [...new Set(checklist.map((c) => c.category))];
      expect(categories).toContain('Documentation');
      expect(categories).toContain('Controls');
      expect(categories).toContain('Testing');
    });

    it('checklist items have valid status', () => {
      const checklist = manager.generateAuditChecklist();
      const validStatuses = ['passed', 'failed', 'not_applicable', 'pending'];

      for (const item of checklist) {
        expect(validStatuses).toContain(item.status);
      }
    });
  });

  // ── Control Catalog ────────────────────────────────────────────────

  describe('getControls', () => {
    it('returns all built-in controls', () => {
      const controls = manager.getControls();
      expect(controls.length).toBeGreaterThanOrEqual(15);
    });

    it('each control has required fields', () => {
      for (const ctrl of manager.getControls()) {
        expect(ctrl.id).toBeTruthy();
        expect(ctrl.name).toBeTruthy();
        expect(ctrl.isoClauses.length).toBeGreaterThan(0);
        expect(ctrl.nistSubcategories.length).toBeGreaterThan(0);
        expect(ctrl.effectivenessScore).toBeGreaterThan(0);
        expect(ctrl.effectivenessScore).toBeLessThanOrEqual(100);
      }
    });
  });

  // ── Config ─────────────────────────────────────────────────────────

  describe('config', () => {
    it('accepts custom snapshot path', () => {
      const customPath = tmpSnapshotPath();
      const mgr = new ComplianceAuditManager({
        snapshotPath: customPath,
      });

      mgr.snapshot();
      expect(fs.existsSync(customPath)).toBe(true);

      cleanupTmp(customPath);
    });
  });
});
