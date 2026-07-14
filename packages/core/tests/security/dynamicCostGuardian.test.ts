import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DynamicCostGuardian,
  getDynamicCostGuardian,
  resetDynamicCostGuardian,
  type CostRecord,
  type DynamicCostConfig,
  type DeviationLevel,
} from '../../src/security/dynamicCostGuardian';

const tenantA = 'tenant-a';
const sessionA = 'session-a';

function makeRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    tenantId: tenantA,
    agentId: 'agent-1',
    sessionId: sessionA,
    cost: 0.01,
    tokens: 150,
    inputTokens: 100,
    outputTokens: 50,
    model: 'gpt-4',
    toolCalls: 0,
    requestSize: 150,
    timestamp: new Date().toISOString(),
    ...(overrides as Partial<CostRecord>),
  } as CostRecord;
}

function seedFingerprint(
  guardian: DynamicCostGuardian,
  count: number,
  base: Partial<CostRecord> = {},
): void {
  for (let i = 0; i < count; i++) {
    const sessionId = `seed-session-${i}`;
    guardian.recordTransaction(
      makeRecord({
        sessionId,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        ...base,
      }),
    );
    guardian.endSession(tenantA, sessionId);
  }
}

describe('DynamicCostGuardian', () => {
  beforeEach(() => {
    process.env.TZ = 'UTC';
    resetDynamicCostGuardian();
    vi.useFakeTimers?.();
  });

  afterEach(() => {
    vi.useRealTimers?.();
  });

  it('constructs with default config', () => {
    const guardian = new DynamicCostGuardian();
    const config = guardian.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.anomalySigmaThreshold).toBe(3);
  });

  it('constructs with custom config', () => {
    const custom: Partial<DynamicCostConfig> = {
      hourlyBudgetUsd: 5,
      anomalySigmaThreshold: 2,
      minDataPointsForFingerprint: 3,
    };
    const guardian = new DynamicCostGuardian(custom);
    expect(guardian.getConfig().anomalySigmaThreshold).toBe(2);
    expect(guardian.getConfig().minDataPointsForFingerprint).toBe(3);
  });

  it('reconfigure updates config', () => {
    const guardian = new DynamicCostGuardian();
    guardian.reconfigure({ minDataPointsForFingerprint: 10 });
    expect(guardian.getConfig().minDataPointsForFingerprint).toBe(10);
  });

  it('returns conservative thresholds for new tenant', () => {
    const guardian = new DynamicCostGuardian();
    const thresholds = guardian.getDynamicThresholds(tenantA);
    expect(thresholds.perRequestTokenLimit).toBeGreaterThan(0);
    expect(thresholds.reason).toContain('保守默认');
  });

  it('caches thresholds within interval', () => {
    const guardian = new DynamicCostGuardian();
    const first = guardian.getDynamicThresholds(tenantA);
    const second = guardian.getDynamicThresholds(tenantA);
    expect(first.lastCalculated).toBe(second.lastCalculated);
  });

  it('builds fingerprint after enough data points', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
    seedFingerprint(guardian, 5);
    const fp = guardian.buildSpendingFingerprint(tenantA);
    expect(fp).not.toBeNull();
    expect(fp!.tenantId).toBe(tenantA);
  });

  it('returns null fingerprint when data points insufficient', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 10 });
    seedFingerprint(guardian, 2);
    expect(guardian.buildSpendingFingerprint(tenantA)).toBeNull();
  });

  it('getFingerprint returns cached fingerprint', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 2 });
    seedFingerprint(guardian, 2);
    const fp1 = guardian.getFingerprint(tenantA);
    const fp2 = guardian.getFingerprint(tenantA);
    expect(fp1).not.toBeNull();
    expect(fp1).toBe(fp2);
  });

  it('detects no attack when disabled', () => {
    const guardian = new DynamicCostGuardian({ enabled: false });
    const detection = guardian.detectNovelEconomicAttack(makeRecord());
    expect(detection.detected).toBe(false);
  });

  it('detects no attack without fingerprint', () => {
    const guardian = new DynamicCostGuardian();
    const detection = guardian.detectNovelEconomicAttack(makeRecord());
    expect(detection.detected).toBe(false);
  });

  it('detects sudden_spike attack', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
    seedFingerprint(guardian, 5, { cost: 0.001 });
    const detection = guardian.detectNovelEconomicAttack(makeRecord({ cost: 10 }));
    expect(detection.detected).toBe(true);
    expect(detection.attackType).toContain('sudden_spike');
  });

  it('detects context_stuffing attack', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
    seedFingerprint(guardian, 5, { requestSize: 100 });
    const detection = guardian.detectNovelEconomicAttack(makeRecord({ requestSize: 10000 }));
    expect(detection.detected).toBe(true);
    expect(detection.attackType).toContain('context_stuffing');
  });

  it('detects recursive_amplification attack', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
    seedFingerprint(guardian, 5, { toolCalls: 1 });
    const detection = guardian.detectNovelEconomicAttack(makeRecord({ toolCalls: 100 }));
    expect(detection.detected).toBe(true);
    expect(detection.attackType).toContain('recursive_amplification');
  });

  it('detects model_switching attack', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
    seedFingerprint(guardian, 5, { model: 'cheap', cost: 0.001 });
    const detection = guardian.detectNovelEconomicAttack(
      makeRecord({ model: 'expensive-power', cost: 0.004 }),
    );
    expect(detection.detected).toBe(true);
    expect(detection.attackType).toContain('model_switching');
  });

  it('detects token_recycling attack', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
    for (let i = 0; i < 5; i++) {
      const sessionId = `ratio-session-${i}`;
      guardian.recordTransaction(
        makeRecord({
          sessionId,
          inputTokens: 80 + i * 10,
          outputTokens: 100 + i * 20,
        }),
      );
      guardian.endSession(tenantA, sessionId);
    }
    const detection = guardian.detectNovelEconomicAttack(
      makeRecord({ inputTokens: 10000, outputTokens: 10 }),
    );
    expect(detection.detected).toBe(true);
    expect(detection.attackType).toContain('token_recycling');
  });

  it('detects unknown_deviation with cost sigma', () => {
    const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 10 });
    seedFingerprint(guardian, 15, { cost: 0.001 });
    const detection = guardian.detectNovelEconomicAttack(makeRecord({ cost: 0.5 }));
    expect(detection.detected).toBe(true);
  });

  it('respondToCostAnomaly returns allow for clean detection', () => {
    const guardian = new DynamicCostGuardian();
    const response = guardian.respondToCostAnomaly(tenantA, {
      detected: false,
      confidence: 0,
      estimatedCostImpact: 0,
      deviationSigma: 0,
      tenantId: tenantA,
      description: 'clean',
      recommendedAction: 1,
      evidence: [],
      timestamp: new Date().toISOString(),
    });
    expect(response.action).toContain('记录');
  });

  it('respondToCostAnomaly escalates to block at high level', () => {
    const guardian = new DynamicCostGuardian();
    const response = guardian.respondToCostAnomaly(tenantA, {
      detected: true,
      attackType: 'sudden_spike',
      confidence: 0.9,
      estimatedCostImpact: 100,
      deviationSigma: 10,
      tenantId: tenantA,
      description: 'spike',
      recommendedAction: 4,
      evidence: [],
      timestamp: new Date().toISOString(),
    });
    expect(response.blocked).toBe(true);
    expect(response.level).toBe(4);
  });

  it('respondToCostAnomaly respects manual override', () => {
    const guardian = new DynamicCostGuardian();
    guardian.setManualOverride(tenantA, 2);
    const response = guardian.respondToCostAnomaly(tenantA, {
      detected: true,
      attackType: 'test',
      confidence: 0.5,
      estimatedCostImpact: 1,
      deviationSigma: 2,
      tenantId: tenantA,
      description: 'test',
      recommendedAction: 4,
      evidence: [],
      timestamp: new Date().toISOString(),
    });
    expect(response.level).toBe(2);
    expect(response.throttled).toBe(true);
  });

  it('clearManualOverride restores automatic level', () => {
    const guardian = new DynamicCostGuardian();
    guardian.setManualOverride(tenantA, 5);
    guardian.clearManualOverride(tenantA);
    const status = guardian.getCostAnomalyStatus(tenantA);
    expect(status.manualOverride).toBeNull();
  });

  it('recordTransaction updates fingerprint and detects anomaly', () => {
    const guardian = new DynamicCostGuardian({
      minDataPointsForFingerprint: 5,
      autoResponseEnabled: true,
    });
    seedFingerprint(guardian, 5, { requestSize: 100 });
    guardian.recordTransaction(makeRecord({ requestSize: 10000 }));
    const status = guardian.getCostAnomalyStatus(tenantA);
    expect(status.recentDetections.length).toBeGreaterThan(0);
  });

  it('recordTransaction does not respond when autoResponse is disabled', () => {
    const guardian = new DynamicCostGuardian({
      minDataPointsForFingerprint: 5,
      autoResponseEnabled: false,
    });
    seedFingerprint(guardian, 5, { requestSize: 100 });
    guardian.recordTransaction(makeRecord({ requestSize: 10000 }));
    const status = guardian.getCostAnomalyStatus(tenantA);
    expect(status.recentDetections.length).toBeGreaterThan(0);
    expect(status.lastResponse).toBeNull();
  });

  it('getCostAnomalyStatus returns default for new tenant', () => {
    const guardian = new DynamicCostGuardian();
    const status = guardian.getCostAnomalyStatus(tenantA);
    expect(status.currentLevel).toBe(1);
    expect(status.blocked).toBe(false);
  });

  it('endSession removes active session', () => {
    const guardian = new DynamicCostGuardian();
    guardian.recordTransaction(makeRecord({ sessionId: 's1' }));
    guardian.endSession(tenantA, 's1');
    const status = guardian.getCostAnomalyStatus(tenantA);
    expect(status.activeSessions).toBe(0);
  });

  it('resetState clears all internal state', () => {
    const guardian = new DynamicCostGuardian();
    guardian.recordTransaction(makeRecord());
    guardian.resetState();
    expect(guardian.getCostAnomalyStatus(tenantA).currentHourCost).toBe(0);
  });

  it('getDynamicCostGuardian returns singleton', () => {
    const a = getDynamicCostGuardian();
    const b = getDynamicCostGuardian();
    expect(a).toBe(b);
  });

  it('resetDynamicCostGuardian resets singleton', () => {
    const first = getDynamicCostGuardian();
    resetDynamicCostGuardian();
    const second = getDynamicCostGuardian();
    expect(second).not.toBe(first);
  });

  it('getDynamicCostGuardian reconfigures with provided config', () => {
    resetDynamicCostGuardian();
    const guardian = getDynamicCostGuardian({ anomalySigmaThreshold: 1.5 });
    expect(guardian.getConfig().anomalySigmaThreshold).toBe(1.5);
  });

  describe('additional detection patterns', () => {
    it('detects gradient_escalation attack', () => {
      const guardian = new DynamicCostGuardian({
        minDataPointsForFingerprint: 2,
        gradientEscalationWindowMs: 60_000,
        gradientEscalationThreshold: 0.1,
      });
      const now = Date.now();
      for (let i = 0; i < 16; i++) {
        const sessionId = `grad-${i}`;
        guardian.recordTransaction(
          makeRecord({
            sessionId,
            cost: i < 8 ? 0.001 : 0.004,
            timestamp: new Date(now - 60_000 + i * 4000).toISOString(),
          }),
        );
        guardian.endSession(tenantA, sessionId);
      }
      const detection = guardian.detectNovelEconomicAttack(
        makeRecord({ cost: 0.004, timestamp: new Date(now).toISOString() }),
      );
      expect(detection.detected).toBe(true);
      expect(detection.attackType).toContain('gradient_escalation');
    });

    it('detects off_hours_surge attack', () => {
      const guardian = new DynamicCostGuardian({
        minDataPointsForFingerprint: 2,
        offHoursThreshold: 1,
      });
      const now = new Date('2024-01-01T03:00:00Z');
      // Seed across different hours (skip hour 3) with varied costs to raise std.
      for (let i = 0; i < 12; i++) {
        const sessionId = `offhour-${i}`;
        const hour = i < 3 ? i : i + 4; // 0,1,2,4,5,6,7,8,9,10,11,12 (skip 3)
        const ts = new Date(now.getTime() - (i + 1) * 24 * 3600_000);
        ts.setUTCHours(hour, 0, 0, 0);
        guardian.recordTransaction(
          makeRecord({
            sessionId,
            cost: i % 2 === 0 ? 0.001 : 0.008,
            timestamp: ts.toISOString(),
          }),
        );
        guardian.endSession(tenantA, sessionId);
      }
      // Current hour 3 cost is above baseline but not enough to dominate 3σ catch-all.
      guardian.recordTransaction(
        makeRecord({ sessionId: 'active', cost: 0.015, timestamp: now.toISOString() }),
      );
      const detection = guardian.detectNovelEconomicAttack(
        makeRecord({ cost: 0.001, timestamp: now.toISOString() }),
      );
      expect(detection.detected).toBe(true);
      expect(detection.attackType).toContain('off_hours_surge');
    });

    it('detects multi_session_parallelism attack', () => {
      const guardian = new DynamicCostGuardian({
        minDataPointsForFingerprint: 2,
        multiSessionThreshold: 2,
      });
      for (let i = 0; i < 5; i++) {
        guardian.recordTransaction(makeRecord({ sessionId: `parallel-${i}` }));
      }
      const detection = guardian.detectNovelEconomicAttack(makeRecord());
      expect(detection.detected).toBe(true);
      expect(detection.attackType).toContain('multi_session_parallelism');
    });

    it('handles detection exception gracefully', () => {
      const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 2 });
      seedFingerprint(guardian, 5);
      guardian.endSession(tenantA, 'invalid');
      const detection = guardian.detectNovelEconomicAttack(makeRecord());
      expect(detection.detected).toBe(false);
    });
  });

  describe('response levels', () => {
    it('applies level 1 response', () => {
      const guardian = new DynamicCostGuardian();
      const response = guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.5,
        estimatedCostImpact: 0,
        deviationSigma: 0.5,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 1,
        evidence: [],
        timestamp: new Date().toISOString(),
      });
      expect(response.level).toBe(1);
      expect(response.blocked).toBe(false);
      expect(response.throttled).toBe(false);
    });

    it('applies level 2 response', () => {
      const guardian = new DynamicCostGuardian();
      const response = guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.5,
        estimatedCostImpact: 1,
        deviationSigma: 2,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 2,
        evidence: [],
        timestamp: new Date().toISOString(),
      });
      expect(response.level).toBe(2);
      expect(response.throttled).toBe(true);
    });

    it('applies level 3 response', () => {
      const guardian = new DynamicCostGuardian();
      const response = guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.5,
        estimatedCostImpact: 1,
        deviationSigma: 5,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 3,
        evidence: [],
        timestamp: new Date().toISOString(),
      });
      expect(response.level).toBe(3);
      expect(response.requiresReauth).toBe(true);
    });

    it('applies level 4 response', () => {
      const guardian = new DynamicCostGuardian();
      const response = guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.9,
        estimatedCostImpact: 1,
        deviationSigma: 10,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 4,
        evidence: [],
        timestamp: new Date().toISOString(),
      });
      expect(response.level).toBe(4);
      expect(response.blocked).toBe(true);
    });

    it('applies level 5 response with forensic snapshot', () => {
      const guardian = new DynamicCostGuardian({ maxAutoResponseLevel: 5 as DeviationLevel });
      guardian.recordTransaction(makeRecord());
      const response = guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.9,
        estimatedCostImpact: 1,
        deviationSigma: 10,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 5,
        evidence: [],
        timestamp: new Date().toISOString(),
      });
      expect(response.level).toBe(5);
      expect(response.blocked).toBe(true);
    });

    it('autoResponseEnabled false forces level 1', () => {
      const guardian = new DynamicCostGuardian({ autoResponseEnabled: false });
      const response = guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.9,
        estimatedCostImpact: 1,
        deviationSigma: 10,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 5,
        evidence: [],
        timestamp: new Date().toISOString(),
      });
      expect(response.level).toBe(1);
    });
  });

  describe('relax adjustment factor', () => {
    it('relaxes after normal transactions', () => {
      const guardian = new DynamicCostGuardian({ minDataPointsForFingerprint: 5 });
      const startTime = Date.now();
      vi.setSystemTime?.(startTime);
      guardian.respondToCostAnomaly(tenantA, {
        detected: true,
        attackType: 'test',
        confidence: 0.5,
        estimatedCostImpact: 1,
        deviationSigma: 5,
        tenantId: tenantA,
        description: 'test',
        recommendedAction: 4,
        evidence: [],
        timestamp: new Date(startTime).toISOString(),
      });
      const before = guardian.getCostAnomalyStatus(tenantA).adjustmentFactor;
      vi.advanceTimersByTime?.(120_000);
      for (let i = 0; i < 10; i++) {
        const t = startTime + 120_000 + i * 1000;
        guardian.recordTransaction(
          makeRecord({
            cost: 0.001,
            sessionId: `relax-${i}`,
            timestamp: new Date(t).toISOString(),
          }),
        );
        guardian.endSession(tenantA, `relax-${i}`);
      }
      const after = guardian.getCostAnomalyStatus(tenantA).adjustmentFactor;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('error handling', () => {
    it('endSession catches errors', () => {
      const guardian = new DynamicCostGuardian();
      expect(() => guardian.endSession('', '')).not.toThrow();
    });

    it('logSecurityEvent catches errors silently', () => {
      const guardian = new DynamicCostGuardian();
      expect(() =>
        guardian.respondToCostAnomaly(tenantA, {
          detected: true,
          attackType: 'x',
          confidence: 0.5,
          estimatedCostImpact: 0,
          deviationSigma: 0,
          tenantId: tenantA,
          description: 'x',
          recommendedAction: 5,
          evidence: [],
          timestamp: new Date().toISOString(),
        }),
      ).not.toThrow();
    });
  });
});
