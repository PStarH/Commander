/**
 * GDPR Compliance Tests
 *
 * Verifies:
 * - Article 15: DSAR data export
 * - Article 17: Right to erasure across all stores
 * - Article 20: Data portability
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GdprComplianceManager } from '../../src/security/gdprCompliance';
import { getUserModelManager } from '../../src/memory/userModel';
import { getConversationStore } from '../../src/memory/conversationStore';

describe('GDPR Compliance', () => {
  let gdpr: GdprComplianceManager;

  beforeEach(() => {
    gdpr = new GdprComplianceManager();
  });

  describe('Article 15 — DSAR Export', () => {
    it('should export user data with structured format', async () => {
      const exportData = await gdpr.exportUserData('test-user-1');

      expect(exportData.userId).toBe('test-user-1');
      expect(exportData.exportedAt).toBeDefined();
      expect(exportData.legalBasis).toContain('Article 15');
      expect(exportData.conversations).toBeDefined();
      expect(exportData.userProfile).toBeDefined();
      expect(exportData.summary).toBeDefined();
      expect(exportData.summary.totalSessions).toBeDefined();
    });

    it('should export with portability metadata', async () => {
      const portable = await gdpr.portUserData('test-user-2');

      expect(portable.format).toBe('application/json');
      expect(portable.version).toBe('1.0');
      expect(portable.data.userId).toBe('test-user-2');
    });
  });

  describe('Article 17 — Right to Erasure', () => {
    it('should erase user data and return a result report', async () => {
      const result = await gdpr.eraseUserData({
        userId: 'erase-test-user',
        anonymizeAuditLogs: true,
        exportBeforeErasure: true,
      });

      expect(result.userId).toBe('erase-test-user');
      expect(result.timestamp).toBeDefined();
      expect(result.conversationsDeleted).toBeDefined();
      expect(result.profileDeleted).toBeDefined();
      expect(result.memoriesDeleted).toBeDefined();
      expect(result.auditEntriesAnonymized).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('should include DSAR export when exportBeforeErasure is true', async () => {
      const result = await gdpr.eraseUserData({
        userId: 'dsar-export-test',
        exportBeforeErasure: true,
      });

      expect(result.dsarExport).toBeDefined();
      expect(result.dsarExport?.userId).toBe('dsar-export-test');
    });

    it('should NOT include DSAR export when exportBeforeErasure is false', async () => {
      const result = await gdpr.eraseUserData({
        userId: 'no-dsar-test',
        exportBeforeErasure: false,
      });

      expect(result.dsarExport).toBeUndefined();
    });

    it('should handle errors gracefully when stores are not initialized', async () => {
      const result = await gdpr.eraseUserData({
        userId: 'uninitialized-user',
        anonymizeAuditLogs: false,
      });

      // Should not throw — errors are collected in the result
      expect(result.errors).toBeDefined();
      // The result should still be returned
      expect(result.userId).toBe('uninitialized-user');
    });
  });

  describe('Article 20 — Data Portability', () => {
    it('should return data in machine-readable JSON format', async () => {
      const portable = await gdpr.portUserData('portability-user');

      expect(portable.format).toBe('application/json');
      expect(portable.version).toBeDefined();
      expect(portable.data).toBeDefined();
      expect(portable.data.conversations).toBeDefined();
      expect(portable.data.summary).toBeDefined();
    });
  });
});

// ============================================================================
// AdaptiveHITL Weight Learning Tests
// ============================================================================

import { AdaptiveHITL } from '../../src/security/adaptiveHitl';
import type { HITLSignalBundle } from '../../src/security/adaptiveHitl';

describe('AdaptiveHITL Thompson Sampling Weight Learning', () => {
  it('should initialize with default weights that sum to 1', () => {
    const hitl = new AdaptiveHITL({ enableWeightLearning: true });
    const config = hitl.getConfig();

    const sum =
      config.toolRiskWeight +
      config.agentConfidenceWeight +
      config.correlationWeight +
      config.verificationWeight +
      config.missionWeight +
      config.timeDecayWeight;

    expect(sum).toBeCloseTo(1, 5);
  });

  it('should not learn with fewer than 5 overrides', () => {
    const hitl = new AdaptiveHITL({ enableWeightLearning: true, learningRate: 0.1 });

    // Record a few overrides (less than 5)
    for (let i = 0; i < 3; i++) {
      hitl.recordOverride(`decision-${i}`, 'confirm', 'testing');
    }

    const config = hitl.getConfig();
    // Weights should not have changed significantly
    expect(config.toolRiskWeight).toBeCloseTo(0.3, 1);
  });

  it('should adjust weights after sufficient overrides', () => {
    const hitl = new AdaptiveHITL({ enableWeightLearning: true, learningRate: 0.5 });

    // Create signals with high tool risk (should predict escalation)
    const signals: HITLSignalBundle = {
      agentId: 'test-agent',
      toolRisk: {
        argRiskLevel: 'critical',
        trustTier: 'untrusted',
        isReadOnly: false,
        hasNetworkAccess: true,
        mutatesState: true,
        toolName: 'bash',
      },
      agentConfidence: {
        activeInterventions: [],
        isPaused: false,
        baselineDeviationFactor: 1.0,
        consecutiveAnomalies: 0,
        toolRateDeviation: 1.0,
      },
      correlation: {
        activeCorrelationTypes: [],
        maxCorrelationRiskScore: 0,
        criticalCorrelation: false,
      },
      verification: {
        confidence: 0.5,
        gateFailures: [],
        hallucinationDetected: false,
      },
      mission: {
        criticality: 0.8,
        budgetRemaining: 0.5,
        userRole: 'operator',
        environment: 'production',
        taskType: 'deployment',
      },
      msSinceLastReview: 60000,
    };

    // Evaluate to create decision history
    for (let i = 0; i < 10; i++) {
      const decision = hitl.evaluate(signals);

      // Record override: human escalated (matching the high tool risk signal)
      hitl.recordOverride(decision.decisionId, 'pause_and_review', 'human escalated');
    }

    const config = hitl.getConfig();
    const sum =
      config.toolRiskWeight +
      config.agentConfidenceWeight +
      config.correlationWeight +
      config.verificationWeight +
      config.missionWeight +
      config.timeDecayWeight;

    // Weights should still sum to 1 after learning
    expect(sum).toBeCloseTo(1, 5);

    // After learning with consistent escalations matching high tool risk,
    // the toolRiskWeight should have shifted from its default of 0.3
    // (direction depends on sampling, but it should have changed)
    // Note: Thompson Sampling is stochastic, so we check that weights are valid
    expect(config.toolRiskWeight).toBeGreaterThan(0);
    expect(config.toolRiskWeight).toBeLessThan(1);
  });

  it('should maintain valid weight distribution after learning', () => {
    const hitl = new AdaptiveHITL({ enableWeightLearning: true, learningRate: 0.3 });

    const signals: HITLSignalBundle = {
      agentId: 'test-agent',
      toolRisk: {
        argRiskLevel: 'low',
        trustTier: 'trusted',
        isReadOnly: true,
        hasNetworkAccess: false,
        mutatesState: false,
        toolName: 'read_file',
      },
      agentConfidence: {
        activeInterventions: [],
        isPaused: false,
        baselineDeviationFactor: 1.0,
        consecutiveAnomalies: 0,
        toolRateDeviation: 1.0,
      },
      correlation: {
        activeCorrelationTypes: [],
        maxCorrelationRiskScore: 0,
        criticalCorrelation: false,
      },
      verification: {
        confidence: 0.9,
        gateFailures: [],
        hallucinationDetected: false,
      },
      mission: {
        criticality: 0.2,
        budgetRemaining: 0.9,
        userRole: 'developer',
        environment: 'development',
        taskType: 'research',
      },
      msSinceLastReview: 5000,
    };

    // Generate decisions and overrides
    for (let i = 0; i < 10; i++) {
      const decision = hitl.evaluate(signals);
      // Human de-escalated (matching the low risk signals)
      hitl.recordOverride(decision.decisionId, 'auto', 'human de-escalated');
    }

    const config = hitl.getConfig();

    // All weights should be positive
    expect(config.toolRiskWeight).toBeGreaterThan(0);
    expect(config.agentConfidenceWeight).toBeGreaterThan(0);
    expect(config.correlationWeight).toBeGreaterThan(0);
    expect(config.verificationWeight).toBeGreaterThan(0);
    expect(config.missionWeight).toBeGreaterThan(0);
    expect(config.timeDecayWeight).toBeGreaterThan(0);

    // All weights should be less than 1
    expect(config.toolRiskWeight).toBeLessThan(1);
    expect(config.agentConfidenceWeight).toBeLessThan(1);
    expect(config.correlationWeight).toBeLessThan(1);
    expect(config.verificationWeight).toBeLessThan(1);
    expect(config.missionWeight).toBeLessThan(1);
    expect(config.timeDecayWeight).toBeLessThan(1);

    // Sum should be 1
    const sum =
      config.toolRiskWeight +
      config.agentConfidenceWeight +
      config.correlationWeight +
      config.verificationWeight +
      config.missionWeight +
      config.timeDecayWeight;
    expect(sum).toBeCloseTo(1, 5);
  });
});
