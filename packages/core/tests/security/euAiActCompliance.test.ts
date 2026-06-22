/**
 * EU AI Act Compliance Reporter Tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  EuAiActComplianceReporter,
  resetEuAiActComplianceReporter,
  getEuAiActComplianceReporter,
} from '../../src/security/euAiActCompliance';
import { resetAuditChainLedger } from '../../src/security/auditChainLedger';
import type {
  EuAiActReport,
  Article12Report,
  Article13Report,
  Article14Report,
  ComplianceSummary,
} from '../../src/security/euAiActCompliance';

describe('EuAiActComplianceReporter', () => {
  beforeEach(() => {
    resetEuAiActComplianceReporter();
    resetAuditChainLedger();
  });

  // ── Report Generation ───────────────────────────────────────────

  describe('report generation', () => {
    it('generates a complete report with all articles', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.meta.reportId).toBeDefined();
      expect(report.meta.reportId).toMatch(/^EUAIA-/);
      expect(report.meta.generatedAt).toBeDefined();
      expect(report.meta.hmacSignature).toBeTruthy();
      expect(report.meta.format).toBe('markdown');

      // All articles present
      expect(report.article12).toBeDefined();
      expect(report.article13).toBeDefined();
      expect(report.article14).toBeDefined();
      expect(report.complianceSummary).toBeDefined();
    });

    it('signs the report with HMAC', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.meta.hmacSignature).toBeTruthy();
      expect(report.meta.hmacSignature.length).toBeGreaterThan(32);
    });

    it('links to previous report', () => {
      const reporter = new EuAiActComplianceReporter();
      const report1 = reporter.generateReport();

      const report2 = reporter.generateReport({
        previousReportId: report1.meta.reportId,
      });

      expect(report2.meta.previousReportId).toBe(report1.meta.reportId);
    });
  });

  // ── Article 12: Transparency ────────────────────────────────────

  describe('Article 12: Transparency', () => {
    it('includes system description', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article12.systemDescription.length).toBeGreaterThan(50);
    });

    it('includes capabilities', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article12.capabilities.length).toBeGreaterThan(5);
      expect(report.article12.capabilities.some((c) => c.includes('orchestration'))).toBe(true);
    });

    it('includes limitations', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article12.limitations.length).toBeGreaterThan(3);
      expect(report.article12.limitations.some((l) => l.toLowerCase().includes('hallucinat'))).toBe(
        true,
      );
    });

    it('includes data sources', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article12.dataSources.length).toBeGreaterThan(3);
    });

    it('includes performance metrics', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(
        Object.keys(report.article12.performanceMetrics.benchmarkResults).length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('includes transparency measures and user disclosures', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article12.transparencyMeasures.length).toBeGreaterThan(3);
      expect(report.article12.userDisclosures.length).toBeGreaterThan(3);
    });

    it('accepts custom system description', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport({
        systemDescription: 'Custom AI system for internal document processing.',
      });

      expect(report.article12.systemDescription).toBe(
        'Custom AI system for internal document processing.',
      );
    });
  });

  // ── Article 13: Human Oversight ─────────────────────────────────

  describe('Article 13: Human Oversight', () => {
    it('includes oversight design', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article13.oversightDesign.length).toBeGreaterThan(30);
    });

    it('includes HITL mechanisms', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article13.hitlMechanisms.length).toBeGreaterThanOrEqual(4);
      const types = report.article13.hitlMechanisms.map((m) => m.type);
      expect(types).toContain('approval');
      expect(types).toContain('monitoring');
      expect(types).toContain('override');
    });

    it('includes override capabilities', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article13.overrideCapabilities.length).toBeGreaterThan(3);
    });

    it('includes monitoring tools', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article13.monitoringTools.length).toBeGreaterThan(3);
    });

    it('includes operator training requirements', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article13.operatorTraining.length).toBeGreaterThan(3);
    });

    it('reports audit trail completeness', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article13.auditTrailCompleteness.tamperProof).toBe(true);
      expect(report.article13.auditTrailCompleteness.coverage).toBe(1.0);
    });
  });

  // ── Article 14: Risk Assessment ─────────────────────────────────

  describe('Article 14: Risk Assessment', () => {
    it('includes risk methodology', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article14.methodology.length).toBeGreaterThan(30);
    });

    it('includes high-risk categories', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article14.highRiskCategories.length).toBeGreaterThanOrEqual(5);
    });

    it('all high-risk categories have mitigations', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      for (const risk of report.article14.highRiskCategories) {
        expect(risk.mitigationMeasures.length).toBeGreaterThan(0);
        expect(risk.residualRisk).not.toBe('unacceptable');
      }
    });

    it('includes security controls', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article14.securityControls.length).toBeGreaterThanOrEqual(8);
    });

    it('includes incident response metrics', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article14.incidentResponse.mttd).toBeDefined();
      expect(report.article14.incidentResponse.mttr).toBeDefined();
    });

    it('includes testing and validation', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article14.testingAndValidation.redTeamScenarios).toBe(47);
      expect(report.article14.testingAndValidation.securityScore).toBeGreaterThanOrEqual(0);
    });

    it('includes residual risk statement', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.article14.residualRiskStatement.length).toBeGreaterThan(50);
    });
  });

  // ── Compliance Summary ──────────────────────────────────────────

  describe('compliance summary', () => {
    it('computes overall compliance score', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.complianceSummary.overallComplianceScore).toBeGreaterThanOrEqual(0);
      expect(report.complianceSummary.overallComplianceScore).toBeLessThanOrEqual(100);
    });

    it('computes per-article scores', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.complianceSummary.articleScores.article12).toBeGreaterThanOrEqual(0);
      expect(report.complianceSummary.articleScores.article13).toBeGreaterThanOrEqual(0);
      expect(report.complianceSummary.articleScores.article14).toBeGreaterThanOrEqual(0);
    });

    it('sets next audit due date', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(report.complianceSummary.nextAuditDue).toBeDefined();
      expect(new Date(report.complianceSummary.nextAuditDue).getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ── Report Formatting ───────────────────────────────────────────

  describe('report formatting', () => {
    it('generates valid Markdown', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();
      const markdown = reporter.formatMarkdown(report);

      expect(markdown).toContain('# EU AI Act Compliance Report');
      expect(markdown).toContain('## Article 12');
      expect(markdown).toContain('## Article 13');
      expect(markdown).toContain('## Article 14');
      expect(markdown).toContain('## Compliance Summary');
      expect(markdown).toContain(report.meta.reportId);
    });

    it('generates valid JSON', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport({ format: 'json' });
      const json = reporter.formatJson(report);

      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed.meta.reportId).toBe(report.meta.reportId);
      expect(parsed.article12).toBeDefined();
      expect(parsed.article13).toBeDefined();
      expect(parsed.article14).toBeDefined();
    });
  });

  // ── Report History ──────────────────────────────────────────────

  describe('report history', () => {
    it('stores report history', () => {
      const reporter = new EuAiActComplianceReporter();
      reporter.generateReport();
      reporter.generateReport();

      const history = reporter.getReportHistory();
      expect(history.length).toBe(2);
    });

    it('returns last report', () => {
      const reporter = new EuAiActComplianceReporter();
      const report1 = reporter.generateReport();
      const report2 = reporter.generateReport();

      const last = reporter.getLastReport();
      expect(last!.meta.reportId).toBe(report2.meta.reportId);
    });

    it('caps history', () => {
      const reporter = new EuAiActComplianceReporter();

      for (let i = 0; i < 60; i++) {
        reporter.generateReport();
      }

      const history = reporter.getReportHistory(60);
      expect(history.length).toBeLessThanOrEqual(50);
    });
  });

  // ── Report Comparison ───────────────────────────────────────────

  describe('report comparison', () => {
    it('compares two reports for compliance drift', () => {
      const reporter = new EuAiActComplianceReporter();
      const report1 = reporter.generateReport();
      const report2 = reporter.generateReport();

      const comparison = reporter.compareReports(report1, report2);

      expect(comparison.scoreDelta).toBeDefined();
      expect(comparison.articleDeltas.article12).toBeDefined();
      expect(comparison.articleDeltas.article13).toBeDefined();
      expect(comparison.articleDeltas.article14).toBeDefined();
      expect(comparison.summary).toBeTruthy();
    });
  });

  // ── Benchmark toggle ────────────────────────────────────────────

  describe('benchmark configuration', () => {
    it('includes benchmarks by default', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport();

      expect(
        Object.keys(report.article12.performanceMetrics.benchmarkResults).length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('can exclude benchmarks', () => {
      const reporter = new EuAiActComplianceReporter();
      const report = reporter.generateReport({ includeBenchmarks: false });

      expect(Object.keys(report.article12.performanceMetrics.benchmarkResults).length).toBe(0);
    });
  });
});
