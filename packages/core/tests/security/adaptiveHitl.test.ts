import { describe, it, expect, beforeEach } from 'vitest';
import {
  AdaptiveHITL,
  getAdaptiveHitl,
  resetAdaptiveHitl,
  maxStrategy,
} from '../../src/security/adaptiveHitl';
import type {
  HITLStrategy,
  HITLSignalBundle,
  ToolRiskSignal,
  AgentConfidenceSignal,
  MissionSignal,
  HITLDecision,
  AgentBehaviorProfile,
} from '../../src/security/adaptiveHitl';

// ── Helpers ───────────────────────────────────────────────────────────

function nominalSignals(overrides?: Partial<HITLSignalBundle>): HITLSignalBundle {
  return {
    agentId: 'agent-1',
    toolRisk: {
      argRiskLevel: 'low',
      trustTier: 'trusted',
      isReadOnly: true,
      hasNetworkAccess: false,
      mutatesState: false,
      toolName: 'file_read',
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
      confidence: 0.95,
      gateFailures: [],
      hallucinationDetected: false,
    },
    mission: {
      criticality: 0.3,
      budgetRemaining: 0.8,
      userRole: 'admin',
      environment: 'development',
      taskType: 'unknown',
      stepsExecuted: 5,
    },
    msSinceLastReview: 0,
    ...overrides,
    agentId: overrides?.agentId ?? 'agent-1',
    toolRisk: {
      ...(overrides?.toolRisk ?? {
        argRiskLevel: 'low',
        trustTier: 'trusted',
        isReadOnly: true,
        hasNetworkAccess: false,
        mutatesState: false,
        toolName: 'file_read',
      }),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('AdaptiveHITL', () => {
  let hitl: AdaptiveHITL;

  beforeEach(() => {
    hitl = new AdaptiveHITL();
  });

  // ── Module Structure ─────────────────────────────────────────

  it('should export a singleton via getAdaptiveHitl', () => {
    const instance = getAdaptiveHitl();
    expect(instance).toBeInstanceOf(AdaptiveHITL);
    resetAdaptiveHitl();
  });

  it('should support maxStrategy for comparing strategies', () => {
    expect(maxStrategy('auto', 'suggest')).toBe('suggest');
    expect(maxStrategy('confirm', 'auto')).toBe('confirm');
    expect(maxStrategy('deny', 'auto')).toBe('deny');
    expect(maxStrategy('escalate', 'pause_and_review')).toBe('escalate');
    expect(maxStrategy('auto', 'auto')).toBe('auto');
  });

  it('should have 6 distinct strategies in increasing severity', () => {
    const strategies: HITLStrategy[] = [
      'auto',
      'suggest',
      'confirm',
      'pause_and_review',
      'escalate',
      'deny',
    ];
    const severityCheck = strategies.every((s, i) => {
      if (i === 0) return true;
      return maxStrategy(s, strategies[i - 1]) === s;
    });
    expect(severityCheck).toBe(true);
  });

  // ── Nominal (auto) ───────────────────────────────────────────

  it('should return auto for nominal signals', () => {
    const decision = hitl.evaluate(nominalSignals());
    expect(decision.strategy).toBe('auto');
    expect(decision.compositeRiskScore).toBeLessThanOrEqual(5);
    expect(decision.factors).toHaveLength(6);
  });

  it('should return auto when disabled', () => {
    hitl.updateConfig({ enabled: false });
    const decision = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'critical',
          trustTier: 'untrusted',
          isReadOnly: false,
          hasNetworkAccess: true,
          mutatesState: true,
          toolName: 'shell_execute',
        },
      }),
    );
    expect(decision.strategy).toBe('auto');
  });

  // ── Tool Risk Scoring ────────────────────────────────────────

  it('should escalate on high-risk tool (shell_execute + critical args)', () => {
    const decision = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'critical',
          trustTier: 'untrusted',
          isReadOnly: false,
          hasNetworkAccess: true,
          mutatesState: true,
          toolName: 'shell_execute',
        },
      }),
    );
    expect(STRATEGY_SEVERITY[decision.strategy]).toBeGreaterThanOrEqual(STRATEGY_SEVERITY.confirm);
  });

  it('should treat untrusted tools as riskier', () => {
    const trusted = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'medium',
          trustTier: 'trusted',
          isReadOnly: false,
          hasNetworkAccess: false,
          mutatesState: true,
          toolName: 'file_write',
        },
      }),
    );
    const untrusted = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'medium',
          trustTier: 'untrusted',
          isReadOnly: false,
          hasNetworkAccess: false,
          mutatesState: true,
          toolName: 'file_write',
        },
      }),
    );
    expect(untrusted.compositeRiskScore).toBeGreaterThan(trusted.compositeRiskScore);
  });

  it('should reduce risk for read-only tools', () => {
    const readWrite = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'low',
          trustTier: 'trusted',
          isReadOnly: false,
          hasNetworkAccess: false,
          mutatesState: true,
          toolName: 'file_write',
        },
      }),
    );
    const readOnly = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'low',
          trustTier: 'trusted',
          isReadOnly: true,
          hasNetworkAccess: false,
          mutatesState: false,
          toolName: 'file_read',
        },
      }),
    );
    expect(readOnly.compositeRiskScore).toBeLessThan(readWrite.compositeRiskScore);
  });

  // ── Agent Confidence Scoring ─────────────────────────────────

  it('should increase risk on active safety violations', () => {
    const nominal = hitl.evaluate(nominalSignals());
    const withViolations = hitl.evaluate(
      nominalSignals({
        agentConfidence: {
          activeInterventions: ['safety_violation', 'goal_hijack'],
          isPaused: false,
          baselineDeviationFactor: 1.0,
          consecutiveAnomalies: 0,
          toolRateDeviation: 1.0,
        },
      }),
    );
    // Should contribute measurable risk compared to nominal
    expect(withViolations.compositeRiskScore).toBeGreaterThan(nominal.compositeRiskScore);
  });

  it('should escalate on high consecutive anomalies', () => {
    const decision = hitl.evaluate(
      nominalSignals({
        agentConfidence: {
          activeInterventions: [],
          isPaused: false,
          baselineDeviationFactor: 2.5,
          consecutiveAnomalies: 8,
          toolRateDeviation: 1.0,
        },
      }),
    );
    // 8 consecutive anomalies should trigger pause_and_review
    expect(STRATEGY_SEVERITY[decision.strategy]).toBeGreaterThanOrEqual(
      STRATEGY_SEVERITY.pause_and_review,
    );
  });

  it('should increase risk on paused agent', () => {
    const nominal = hitl.evaluate(nominalSignals());
    const paused = hitl.evaluate(
      nominalSignals({
        agentConfidence: {
          activeInterventions: [],
          isPaused: true,
          baselineDeviationFactor: 1.0,
          consecutiveAnomalies: 0,
          toolRateDeviation: 1.0,
        },
      }),
    );
    // Paused agent should have higher risk than nominal
    expect(paused.compositeRiskScore).toBeGreaterThan(nominal.compositeRiskScore);
  });

  // ── Correlation Scoring ──────────────────────────────────────

  it('should escalate on critical correlation', () => {
    const decision = hitl.evaluate(
      nominalSignals({
        correlation: {
          activeCorrelationTypes: ['collusion', 'command_and_control'],
          maxCorrelationRiskScore: 85,
          criticalCorrelation: true,
        },
      }),
    );
    // Critical correlation forces escalate minimum
    expect(STRATEGY_SEVERITY[decision.strategy]).toBeGreaterThanOrEqual(STRATEGY_SEVERITY.escalate);
  });

  it('should return 0 correlation score when no matches', () => {
    const decision = hitl.evaluate(
      nominalSignals({
        correlation: {
          activeCorrelationTypes: [],
          maxCorrelationRiskScore: 0,
          criticalCorrelation: false,
        },
      }),
    );
    expect(decision.compositeRiskScore).toBeLessThanOrEqual(5);
  });

  // ── Verification Scoring ─────────────────────────────────────

  it('should increase risk on low verification confidence', () => {
    const nominal = hitl.evaluate(nominalSignals());
    const lowConf = hitl.evaluate(
      nominalSignals({
        verification: {
          confidence: 0.2,
          gateFailures: ['hallucination', 'completeness'],
          hallucinationDetected: true,
        },
      }),
    );
    // Low verification confidence should contribute measurable risk
    expect(lowConf.compositeRiskScore).toBeGreaterThan(nominal.compositeRiskScore);
  });

  // ── Mission Scoring ──────────────────────────────────────────

  it('should escalate in production environment', () => {
    const devDecision = hitl.evaluate(
      nominalSignals({
        mission: {
          criticality: 0.3,
          budgetRemaining: 0.8,
          userRole: 'admin',
          environment: 'development',
          taskType: 'unknown',
          stepsExecuted: 5,
        },
      }),
    );
    const prodDecision = hitl.evaluate(
      nominalSignals({
        mission: {
          criticality: 0.3,
          budgetRemaining: 0.8,
          userRole: 'admin',
          environment: 'production',
          taskType: 'unknown',
          stepsExecuted: 5,
        },
      }),
    );
    expect(prodDecision.compositeRiskScore).toBeGreaterThan(devDecision.compositeRiskScore);
  });

  it('should escalate for guest users', () => {
    const adminDecision = hitl.evaluate(
      nominalSignals({
        mission: {
          criticality: 0.3,
          budgetRemaining: 0.8,
          userRole: 'admin',
          environment: 'development',
          taskType: 'unknown',
          stepsExecuted: 5,
        },
      }),
    );
    const guestDecision = hitl.evaluate(
      nominalSignals({
        mission: {
          criticality: 0.3,
          budgetRemaining: 0.8,
          userRole: 'guest',
          environment: 'development',
          taskType: 'unknown',
          stepsExecuted: 5,
        },
      }),
    );
    expect(guestDecision.compositeRiskScore).toBeGreaterThan(adminDecision.compositeRiskScore);
  });

  // ── Time Decay ───────────────────────────────────────────────

  it('should increase risk with time since last review', () => {
    const freshDecision = hitl.evaluate(nominalSignals({ msSinceLastReview: 0 }));
    const staleDecision = hitl.evaluate(
      nominalSignals({
        msSinceLastReview: 30 * 60 * 1000,
      }),
    );
    expect(staleDecision.compositeRiskScore).toBeGreaterThan(freshDecision.compositeRiskScore);
  });

  // ── Composite Scenario Tests ─────────────────────────────────

  it('should deny execution with all max-risk signals', () => {
    const decision = hitl.evaluate({
      agentId: 'evil-agent',
      toolRisk: {
        argRiskLevel: 'critical',
        trustTier: 'untrusted',
        isReadOnly: false,
        hasNetworkAccess: true,
        mutatesState: true,
        toolName: 'shell_execute',
      },
      agentConfidence: {
        activeInterventions: ['safety_violation', 'data_exfiltration', 'goal_hijack'],
        isPaused: true,
        baselineDeviationFactor: 4.0,
        consecutiveAnomalies: 12,
        toolRateDeviation: 8.0,
      },
      correlation: {
        activeCorrelationTypes: ['collusion', 'command_and_control', 'coordinated_exfiltration'],
        maxCorrelationRiskScore: 95,
        criticalCorrelation: true,
      },
      verification: {
        confidence: 0.1,
        gateFailures: ['hallucination', 'completeness', 'consistency', 'accuracy'],
        hallucinationDetected: true,
      },
      mission: {
        criticality: 1.0,
        budgetRemaining: 0.05,
        userRole: 'guest',
        environment: 'production',
        taskType: 'deployment',
        stepsExecuted: 60,
      },
      msSinceLastReview: 60 * 60 * 1000,
    });
    expect(decision.strategy).toBe('deny');
    expect(decision.compositeRiskScore).toBeGreaterThanOrEqual(90);
  });

  it('should have an escalation flag when strategy was upgraded', () => {
    const decision = hitl.evaluate({
      agentId: 'agent-x',
      toolRisk: {
        argRiskLevel: 'medium',
        trustTier: 'trusted',
        isReadOnly: false,
        hasNetworkAccess: false,
        mutatesState: true,
        toolName: 'file_write',
      },
      agentConfidence: {
        activeInterventions: [],
        isPaused: false,
        baselineDeviationFactor: 1.0,
        consecutiveAnomalies: 7,
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
        criticality: 0.3,
        budgetRemaining: 0.8,
        userRole: 'admin',
        environment: 'development',
        taskType: 'unknown',
        stepsExecuted: 5,
      },
      msSinceLastReview: 0,
    });
    expect(decision.escalated).toBe(true);
    expect(decision.previousStrategy).toBeDefined();
  });

  // ── Behavior Profiles ────────────────────────────────────────

  it('should track behavior profiles across decisions', () => {
    const agentId = 'agent-profile-test';
    // First decision: nominal
    hitl.evaluate(nominalSignals({ agentId }));
    const profile1 = hitl.getProfile(agentId);
    expect(profile1.totalDecisions).toBe(1);
    expect(profile1.strategyCounts.auto).toBe(1);

    // Second decision: high risk
    hitl.evaluate(
      nominalSignals({
        agentId,
        toolRisk: {
          argRiskLevel: 'critical',
          trustTier: 'untrusted',
          isReadOnly: false,
          hasNetworkAccess: true,
          mutatesState: true,
          toolName: 'shell_execute',
        },
      }),
    );
    const profile2 = hitl.getProfile(agentId);
    expect(profile2.totalDecisions).toBe(2);
    expect(profile2.avgRiskScore).toBeGreaterThan(0);
  });

  it('should build trust bonus for consistently safe agents', () => {
    const agentId = 'safe-agent';
    // 30 auto decisions
    for (let i = 0; i < 30; i++) {
      hitl.evaluate(nominalSignals({ agentId }));
    }
    const profile = hitl.getProfile(agentId);
    expect(profile.trustBonus).toBeGreaterThan(0);
  });

  it('should reset trust bonus on high-risk decisions', () => {
    const agentId = 'unstable-agent';
    // Build trust
    for (let i = 0; i < 20; i++) {
      hitl.evaluate(nominalSignals({ agentId }));
    }
    // Snapshot trust bonus before high-risk call
    const trustBonusBefore = hitl.getProfile(agentId).trustBonus;
    expect(trustBonusBefore).toBeGreaterThan(0);

    // High risk decision
    hitl.evaluate(
      nominalSignals({
        agentId,
        toolRisk: {
          argRiskLevel: 'critical',
          trustTier: 'untrusted',
          isReadOnly: false,
          hasNetworkAccess: true,
          mutatesState: true,
          toolName: 'shell_execute',
        },
      }),
    );
    const trustBonusAfter = hitl.getProfile(agentId).trustBonus;
    // Trust bonus should decrease by 3
    expect(trustBonusAfter).toBeLessThan(trustBonusBefore);
  });

  // ── Explainability ───────────────────────────────────────────

  it('should include all 6 factors with reasoning', () => {
    const decision = hitl.evaluate(
      nominalSignals({
        toolRisk: {
          argRiskLevel: 'high',
          trustTier: 'untrusted',
          isReadOnly: false,
          hasNetworkAccess: true,
          mutatesState: true,
          toolName: 'shell_execute',
        },
      }),
    );
    expect(decision.factors).toHaveLength(6);
    for (const factor of decision.factors) {
      expect(factor.source).toBeDefined();
      expect(factor.score).toBeGreaterThanOrEqual(0);
      expect(factor.score).toBeLessThanOrEqual(100);
      expect(factor.weight).toBeGreaterThan(0);
      expect(factor.reasoning.length).toBeGreaterThan(0);
    }
  });

  it('should include a human-readable summary', () => {
    const decision = hitl.evaluate(nominalSignals());
    expect(decision.summary.length).toBeGreaterThan(0);
    expect(decision.recommendation.length).toBeGreaterThan(0);
    expect(decision.decisionId).toMatch(/^hitl_/);
  });

  // ── Stats ────────────────────────────────────────────────────

  it('should track decision statistics', () => {
    for (let i = 0; i < 5; i++) {
      hitl.evaluate(nominalSignals());
    }
    const stats = hitl.getStats();
    expect(stats.totalDecisions).toBe(5);
    expect(stats.strategyDistribution.auto).toBe(5);
  });

  // ── Overrides ────────────────────────────────────────────────

  it('should track human overrides', () => {
    const decision = hitl.evaluate(nominalSignals());
    hitl.recordOverride(decision.decisionId, 'confirm', 'Operator escalated');
    const overrides = hitl.getOverrides();
    expect(overrides).toHaveLength(1);
    expect(overrides[0].overridden).toBe('confirm');
  });

  // ── Singleton ────────────────────────────────────────────────

  it('should support singleton reset', () => {
    const a = getAdaptiveHitl();
    expect(a).toBeDefined();
    resetAdaptiveHitl();
    const b = getAdaptiveHitl();
    expect(b).toBeDefined();
    // After reset, stats should be empty
    expect(b.getStats().totalDecisions).toBe(0);
    resetAdaptiveHitl();
  });

  // ── HITLSignalBundle factory ─────────────────────────────────

  it('should provide sensible defaults via defaultSignals', () => {
    const bundle = AdaptiveHITL.defaultSignals({
      agentId: 'test',
      toolRisk: {
        argRiskLevel: 'low',
        trustTier: 'trusted',
        isReadOnly: true,
        hasNetworkAccess: false,
        mutatesState: false,
        toolName: 'test_tool',
      },
    });
    expect(bundle.agentId).toBe('test');
    expect(bundle.agentConfidence.activeInterventions).toEqual([]);
    expect(bundle.verification.confidence).toBe(0.95);
    expect(bundle.mission.environment).toBe('development');
  });

  // ── Reset ────────────────────────────────────────────────────

  it('should reset all state', () => {
    hitl.evaluate(nominalSignals({ agentId: 'a' }));
    hitl.evaluate(nominalSignals({ agentId: 'b' }));
    hitl.reset();
    expect(hitl.getStats().totalDecisions).toBe(0);
    expect(hitl.getAllProfiles().size).toBe(0);
  });

  // ── Config Update ────────────────────────────────────────────

  it('should allow runtime config updates', () => {
    hitl.updateConfig({ autoThreshold: 5 });
    expect(hitl.getConfig().autoThreshold).toBe(5);
  });
});

// ── Local helper ───────────────────────────────────────────────────────

const STRATEGY_SEVERITY: Record<HITLStrategy, number> = {
  auto: 0,
  suggest: 1,
  confirm: 2,
  pause_and_review: 3,
  escalate: 4,
  deny: 5,
};
