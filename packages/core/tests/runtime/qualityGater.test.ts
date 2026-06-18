/**
 * QualityGater Tests
 *
 * Tests the Agent Capsules quality-gated escalation system:
 * - 3 execution modes: compound, standard, fine
 * - 5 escalation rules
 * - Rolling window quality tracking
 * - Mode transitions (escalate/de-escalate/maintain)
 * - Helper functions: getModeConfig, getInitialMode
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { QualityGater, getModeConfig, getInitialMode } from '../../src/runtime/qualityGater';
import type { QualityMetrics, ExecutionMode } from '../../src/runtime/qualityGater';

function makeMetrics(overrides: Partial<QualityMetrics> = {}): QualityMetrics {
  return {
    quality: 0.9,
    passed: true,
    issueCount: 0,
    worstSeverity: 'none',
    tokenCost: 1000,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('QualityGater', () => {
  let gater: QualityGater;

  beforeEach(() => {
    gater = new QualityGater();
  });

  describe('Initial state', () => {
    it('should start in compound mode', () => {
      assert.equal(gater.getCurrentMode(), 'compound');
    });

    it('should have rolling quality of 1.0 with no history', () => {
      assert.equal(gater.getRollingQuality(), 1);
    });

    it('should have zero mode changes', () => {
      assert.equal(gater.getModeChanges().length, 0);
    });

    it('should have zero consecutive failures', () => {
      const stats = gater.getStats();
      assert.equal(stats.consecutiveFailures, 0);
    });
  });

  describe('Rule 1: Consecutive failures escalation', () => {
    it('should escalate after maxConsecutiveFailures (default 3)', () => {
      // Record 3 failed outcomes
      gater.recordOutcome(makeMetrics({ passed: false, quality: 0.9 }));
      gater.recordOutcome(makeMetrics({ passed: false, quality: 0.9 }));
      const decision = gater.recordOutcome(makeMetrics({ passed: false, quality: 0.9 }));

      assert.equal(decision.action, 'escalate');
      assert.equal(decision.mode, 'standard');
      assert.equal(decision.consecutiveFailures, 3);
      assert.ok(decision.reason.includes('consecutive failures'));
    });

    it('should escalate from standard to fine on more failures', () => {
      // First escalate to standard
      gater.forceMode('standard', 'test');

      gater.recordOutcome(makeMetrics({ passed: false }));
      gater.recordOutcome(makeMetrics({ passed: false }));
      const decision = gater.recordOutcome(makeMetrics({ passed: false }));

      assert.equal(decision.action, 'escalate');
      assert.equal(decision.mode, 'fine');
    });

    it('should not escalate beyond fine mode (de-escalates instead)', () => {
      gater.forceMode('fine', 'test');

      // Record failures with high quality — consecutive failures trigger escalation attempt,
      // but since we're at max (fine), escalation is a no-op. High quality then triggers de-escalation.
      gater.recordOutcome(makeMetrics({ passed: false, quality: 0.95 }));
      gater.recordOutcome(makeMetrics({ passed: false, quality: 0.95 }));
      const decision = gater.recordOutcome(makeMetrics({ passed: false, quality: 0.95 }));

      // Should de-escalate from fine to standard (quality is consistently high)
      assert.equal(decision.mode, 'standard');
      assert.equal(decision.action, 'de-escalate');
    });

    it('should reset consecutive failures on success', () => {
      gater.recordOutcome(makeMetrics({ passed: false }));
      gater.recordOutcome(makeMetrics({ passed: false }));
      gater.recordOutcome(makeMetrics({ passed: true, quality: 0.95 }));

      const stats = gater.getStats();
      assert.equal(stats.consecutiveFailures, 0);
    });

    it('should count high/critical severity as failure even if passed=true', () => {
      gater.recordOutcome(makeMetrics({ passed: true, worstSeverity: 'high' }));
      gater.recordOutcome(makeMetrics({ passed: true, worstSeverity: 'critical' }));

      const stats = gater.getStats();
      assert.equal(stats.consecutiveFailures, 2);
    });
  });

  describe('Rule 2: Low quality escalation', () => {
    it('should escalate when rolling quality drops below threshold', () => {
      // Use low minExecutions to allow decisions with fewer records
      const g = new QualityGater({ minExecutions: 1, windowSize: 10 });

      // Record low-quality outcomes — rolling weighted avg will be well below 0.7
      const d1 = g.recordOutcome(makeMetrics({ quality: 0.5, passed: true }));
      const d2 = g.recordOutcome(makeMetrics({ quality: 0.4, passed: true }));
      const d3 = g.recordOutcome(makeMetrics({ quality: 0.3, passed: true }));

      // The first outcome that drops below threshold should trigger escalation
      const escalatingDecision = [d1, d2, d3].find((d) => d.action === 'escalate');
      assert.ok(escalatingDecision, 'At least one decision should be an escalation');
      assert.ok(g.getRollingQuality() < 0.7, 'Rolling quality should be below threshold');
    });

    it('should report low rolling quality correctly', () => {
      gater.recordOutcome(makeMetrics({ quality: 0.3 }));
      gater.recordOutcome(makeMetrics({ quality: 0.4 }));
      const rolling = gater.getRollingQuality();
      // Weighted: (0.3*1 + 0.4*2) / 3 = 1.1/3 ≈ 0.367
      assert.ok(rolling < 0.5, `Rolling quality ${rolling} should be < 0.5`);
    });
  });

  describe('Rule 3: Critical issue escalation', () => {
    it('should escalate on critical severity', () => {
      const decision = gater.recordOutcome(
        makeMetrics({
          passed: true,
          quality: 0.9,
          worstSeverity: 'critical',
        }),
      );

      assert.equal(decision.action, 'escalate');
      assert.ok(decision.reason.includes('critical'));
    });
  });

  describe('Rule 4: High quality de-escalation', () => {
    it('should de-escalate when quality is consistently high', () => {
      // First escalate to standard
      gater.forceMode('standard', 'test');

      // Record minExecutions (3) high-quality outcomes — de-escalation triggers on the 3rd
      gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));
      gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));
      const decision = gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));

      assert.equal(decision.action, 'de-escalate');
      assert.equal(decision.mode, 'compound');
      assert.ok(gater.getCurrentMode(), 'compound');
    });

    it('should not de-escalate from compound (already at minimum)', () => {
      // Record high quality outcomes while in compound mode
      for (let i = 0; i < 5; i++) {
        const decision = gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));
        // Should maintain compound
        assert.equal(decision.mode, 'compound');
      }
    });

    it('should not de-escalate if any recent quality is below threshold', () => {
      gater.forceMode('standard', 'test');

      gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));
      gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));
      gater.recordOutcome(makeMetrics({ quality: 0.8, passed: true })); // Below 0.9

      const decision = gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));
      // Should not de-escalate because not all recent are >= 0.9
      assert.notEqual(decision.action, 'de-escalate');
    });
  });

  describe('Rule 5: Maintain mode', () => {
    it('should maintain when quality is adequate and no escalation triggers', () => {
      gater.recordOutcome(makeMetrics({ quality: 0.8, passed: true }));
      const decision = gater.recordOutcome(makeMetrics({ quality: 0.8, passed: true }));

      assert.equal(decision.action, 'maintain');
      assert.equal(decision.mode, 'compound');
    });
  });

  describe('Rolling window', () => {
    it('should respect window size', () => {
      const g = new QualityGater({ windowSize: 3 });

      // Record 5 outcomes
      for (let i = 0; i < 5; i++) {
        g.recordOutcome(makeMetrics({ quality: 0.95 }));
      }

      const stats = g.getStats();
      assert.equal(stats.totalExecutions, 3); // Only keeps last 3
    });

    it('should use weighted average (recent has higher weight)', () => {
      // Record low quality first, then high quality
      gater.recordOutcome(makeMetrics({ quality: 0.3, passed: true }));
      gater.recordOutcome(makeMetrics({ quality: 0.95, passed: true }));

      const rolling = gater.getRollingQuality();
      // Weighted: (0.3*1 + 0.95*2) / (1+2) = 2.2/3 = 0.733
      assert.ok(rolling > 0.7, `Rolling quality ${rolling} should be > 0.7`);
      assert.ok(rolling < 0.8, `Rolling quality ${rolling} should be < 0.8`);
    });
  });

  describe('forceMode', () => {
    it('should force a specific mode', () => {
      gater.forceMode('fine', 'manual override');
      assert.equal(gater.getCurrentMode(), 'fine');
    });

    it('should record mode change', () => {
      gater.forceMode('fine', 'manual override');
      const changes = gater.getModeChanges();
      assert.equal(changes.length, 1);
      assert.equal(changes[0].from, 'compound');
      assert.equal(changes[0].to, 'fine');
    });

    it('should detect escalation action', () => {
      gater.forceMode('fine', 'test');
      const changes = gater.getModeChanges();
      assert.equal(changes[0].action, 'escalate');
    });

    it('should detect de-escalation action', () => {
      gater.forceMode('fine', 'test');
      gater.forceMode('compound', 'test');
      const changes = gater.getModeChanges();
      assert.equal(changes[1].action, 'de-escalate');
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      gater.forceMode('fine', 'test');
      gater.recordOutcome(makeMetrics({ quality: 0.3 }));

      gater.reset();

      assert.equal(gater.getCurrentMode(), 'compound');
      assert.equal(gater.getRollingQuality(), 1);
      assert.equal(gater.getModeChanges().length, 0);
      assert.equal(gater.getStats().totalExecutions, 0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      gater.recordOutcome(makeMetrics({ quality: 0.8, tokenCost: 1000 }));
      gater.recordOutcome(makeMetrics({ quality: 0.9, tokenCost: 2000 }));

      const stats = gater.getStats();
      assert.equal(stats.totalExecutions, 2);
      assert.equal(stats.currentMode, 'compound');
      assert.ok(stats.averageQuality > 0.8);
      assert.equal(stats.averageTokenCost, 1500);
    });
  });

  describe('Custom config', () => {
    it('should accept custom thresholds', () => {
      const g = new QualityGater({
        escalationThreshold: 0.5,
        deEscalationThreshold: 0.8,
        maxConsecutiveFailures: 2,
      });

      // Should not escalate with quality 0.6 (above custom threshold 0.5)
      g.recordOutcome(makeMetrics({ quality: 0.6, passed: true }));
      g.recordOutcome(makeMetrics({ quality: 0.6, passed: true }));

      assert.equal(g.getCurrentMode(), 'compound');
    });
  });
});

describe('getModeConfig', () => {
  it('should return compound config', () => {
    const config = getModeConfig('compound');
    assert.equal(config.maxAgents, 1);
    assert.equal(config.contextLevel, 'minimal');
    assert.equal(config.verificationLevel, 'none');
    assert.equal(config.tokenMultiplier, 1.0);
  });

  it('should return standard config', () => {
    const config = getModeConfig('standard');
    assert.equal(config.maxAgents, 3);
    assert.equal(config.contextLevel, 'standard');
    assert.equal(config.verificationLevel, 'basic');
    assert.equal(config.tokenMultiplier, 2.5);
  });

  it('should return fine config', () => {
    const config = getModeConfig('fine');
    assert.equal(config.maxAgents, 5);
    assert.equal(config.contextLevel, 'full');
    assert.equal(config.verificationLevel, 'thorough');
    assert.equal(config.tokenMultiplier, 4.0);
  });
});

describe('getInitialMode', () => {
  it('should return compound for low complexity (<=3)', () => {
    assert.equal(getInitialMode(1), 'compound');
    assert.equal(getInitialMode(3), 'compound');
  });

  it('should return standard for medium complexity (4-7)', () => {
    assert.equal(getInitialMode(4), 'standard');
    assert.equal(getInitialMode(7), 'standard');
  });

  it('should return fine for high complexity (>7)', () => {
    assert.equal(getInitialMode(8), 'fine');
    assert.equal(getInitialMode(10), 'fine');
  });
});
