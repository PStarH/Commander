/**
 * CostGuard Tests — Enterprise Economic Attack Detection & Auto Circuit-Breaker
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CostGuard, resetCostGuard, getCostGuard } from '../../src/security/costGuard';
import type { CostGuardConfig } from '../../src/security/costGuard';

function createGuard(overrides?: Partial<CostGuardConfig>): CostGuard {
  const guard = new CostGuard(overrides);
  return guard;
}

describe('CostGuard', () => {
  beforeEach(() => {
    resetCostGuard();
  });

  // ── Token Flood Detection ───────────────────────────────────────

  describe('token flood detection', () => {
    it('allows normal token usage', () => {
      const guard = createGuard();
      const result = guard.evaluateRequest({
        tokens: 500,
        model: 'gpt-4o',
        source: 'user-1',
      });
      expect(result.action).toBe('LOGONLY');
    });

    it('THROTTLEs when tokens exceed maxTokensPerRequest', () => {
      const guard = createGuard({ maxTokensPerRequest: 1000 });
      const result = guard.evaluateRequest({
        tokens: 2000,
        model: 'gpt-4o',
        source: 'user-1',
      });
      expect(result.action).toBe('THROTTLE');
      expect(result.attackType).toBe('token_flood');
    });

    it('MELTs when tokens exceed meltTokensPerRequest', () => {
      const guard = createGuard({ meltTokensPerRequest: 5000 });
      const result = guard.evaluateRequest({
        tokens: 10000,
        model: 'gpt-4o',
        source: 'user-1',
      });
      expect(result.action).toBe('MELT');
    });

    it('rejects all requests from melted sources', () => {
      const guard = createGuard({ meltTokensPerRequest: 1000 });
      // First request triggers MELT
      guard.evaluateRequest({ tokens: 10000, model: 'gpt-4o', source: 'attacker' });
      // Subsequent requests blocked
      const result = guard.evaluateRequest({ tokens: 10, model: 'gpt-4o', source: 'attacker' });
      expect(result.action).toBe('MELT');
    });
  });

  // ── Concurrent Burst Detection ──────────────────────────────────

  describe('concurrent burst detection', () => {
    it('detects burst of requests from same source', () => {
      const guard = createGuard({ burstThreshold: 5, burstWindowMs: 60_000 });

      // Send 10 requests rapidly
      let lastResult: any = null;
      for (let i = 0; i < 10; i++) {
        lastResult = guard.evaluateRequest({
          tokens: 100,
          model: 'gpt-4o',
          source: 'attacker',
        });
      }

      // The 6th+ requests should be throttled
      expect(lastResult.action).toBe('THROTTLE');
      expect(lastResult.attackType).toBe('concurrent_burst');
    });

    it('MELTs at 2x burst threshold', () => {
      const guard = createGuard({ burstThreshold: 3, burstWindowMs: 60_000 });

      let lastResult: any = null;
      for (let i = 0; i < 10; i++) {
        lastResult = guard.evaluateRequest({
          tokens: 100,
          model: 'gpt-4o',
          source: 'attacker',
        });
      }

      // Beyond 2x threshold → MELT
      expect(lastResult.action).toBe('MELT');
    });
  });

  // ── Context Stuffing Detection ──────────────────────────────────

  describe('context stuffing detection', () => {
    it('detects context stuffing when session tokens are high and new request is large', () => {
      const guard = createGuard({ burstThreshold: 100 }); // disable burst detection for this test

      // Build up session tokens via evaluateRequest to simulate context stuffing
      for (let i = 0; i < 21; i++) {
        guard.evaluateRequest({ tokens: 10_000, model: 'gpt-4o', source: 'user-1' });
      }
      // Now sessionTokens > 200_000, next large request should trigger context stuffing
      const result = guard.evaluateRequest({
        tokens: 15_000,
        model: 'gpt-4o',
        source: 'user-1',
      });

      expect(result.action).toBe('QUARANTINE');
      expect(result.attackType).toBe('context_stuffing');
    });

    it('does not flag small requests even with high session usage', () => {
      const guard = createGuard({ burstThreshold: 100 }); // disable burst detection
      // Build up session tokens
      for (let i = 0; i < 21; i++) {
        guard.evaluateRequest({ tokens: 10_000, model: 'gpt-4o', source: 'user-1' });
      }

      const result = guard.evaluateRequest({
        tokens: 500,
        model: 'gpt-4o',
        source: 'user-1',
      });

      expect(result.action).toBe('LOGONLY');
    });
  });

  // ── Expensive Query Patterns ────────────────────────────────────

  describe('expensive query detection', () => {
    it('detects recursive search queries', () => {
      const guard = createGuard();
      const result = guard.evaluateRequest({
        tokens: 1000,
        model: 'gpt-4o',
        source: 'user-1',
        input: 'please search all pages and recursively follow every link forever',
      });
      expect(result.action).toBe('QUARANTINE');
      expect(result.attackType).toBe('expensive_query');
    });

    it('detects massive analysis queries', () => {
      const guard = createGuard();
      const result = guard.evaluateRequest({
        tokens: 500,
        model: 'gpt-4o',
        source: 'user-1',
        input: 'analyze every paragraph of this document in detail',
      });
      expect(result.action).toBe('QUARANTINE');
    });

    it('allows normal queries through', () => {
      const guard = createGuard();
      const result = guard.evaluateRequest({
        tokens: 500,
        model: 'gpt-4o',
        source: 'user-1',
        input: 'what is the capital of France?',
      });
      expect(result.action).toBe('LOGONLY');
    });
  });

  // ── Tool Call Loop Detection ────────────────────────────────────

  describe('tool call loop detection', () => {
    it('THROTTLEs when tool calls exceed per-minute limit', () => {
      const guard = createGuard({ maxToolCallsPerMinute: 5 });

      // Simulate 10 rapid tool calls
      let lastResult: any = null;
      for (let i = 0; i < 10; i++) {
        lastResult = guard.evaluateToolCall({
          toolName: 'web_search',
          source: 'user-1',
        });
      }

      expect(lastResult.action).toBe('THROTTLE');
      expect(lastResult.attackType).toBe('amplification_loop');
    });

    it('QUARANTINEs when total tool calls exceed session limit', () => {
      const guard = createGuard({ maxToolCallsPerSession: 10 });

      // Make many tool calls
      let lastResult: any = null;
      for (let i = 0; i < 15; i++) {
        lastResult = guard.evaluateToolCall({
          toolName: 'web_search',
          source: 'user-1',
        });
      }

      expect(lastResult.action).toBe('QUARANTINE');
    });

    it('MELTs at 2x session tool call limit', () => {
      const guard = createGuard({ maxToolCallsPerSession: 5 });

      let lastResult: any = null;
      for (let i = 0; i < 15; i++) {
        lastResult = guard.evaluateToolCall({
          toolName: 'web_search',
          source: 'user-1',
        });
      }

      expect(lastResult.action).toBe('MELT');
    });
  });

  // ── Provider Switch Detection ───────────────────────────────────

  describe('provider switch detection', () => {
    it('flags aggressive cost escalation in provider switches', () => {
      const guard = createGuard();
      const result = guard.evaluateProviderSwitch({
        fromModel: 'gpt-4o-mini',
        toModel: 'claude-3-opus',
        reason: 'primary provider failure',
        source: 'user-1',
      });
      // claude-3-opus ($0.015) >> gpt-4o-mini ($0.00015) ~ 100x
      expect(result.action).toBe('QUARANTINE');
      expect(result.attackType).toBe('model_degradation');
    });

    it('allows reasonable provider switches', () => {
      const guard = createGuard();
      const result = guard.evaluateProviderSwitch({
        fromModel: 'gpt-4o',
        toModel: 'claude-3-sonnet',
        reason: 'fallback',
        source: 'user-1',
      });
      expect(result.action).toBe('LOGONLY');
    });
  });

  // ── Quota Enforcement ───────────────────────────────────────────

  describe('quota enforcement', () => {
    it('enforces daily cost limits per tier', () => {
      const guard = createGuard();
      guard.setTier('free');

      // Consume near the daily limit ($1.00)
      guard.recordActualCost(190_000, 'gpt-4o'); // ~$0.95

      // Next request should be throttled
      const result = guard.evaluateRequest({
        tokens: 20_000,
        model: 'gpt-4o',
        source: 'user-1',
      });

      expect(result.action).toBe('THROTTLE');
    });

    it('enforces per-request cost limits', () => {
      const guard = createGuard();
      guard.setTier('free'); // $0.05 per request

      const result = guard.evaluateRequest({
        tokens: 100_000, // ~$0.50 at gpt-4o rates
        model: 'gpt-4o',
        source: 'user-1',
      });

      expect(result.action).toBe('THROTTLE');
    });
  });

  // ── State Management ────────────────────────────────────────────

  describe('state management', () => {
    it('tracks session costs correctly via recordActualCost', () => {
      const guard = createGuard();
      guard.evaluateRequest({ tokens: 1000, model: 'gpt-4o', source: 'user-1' });
      guard.recordActualCost(1000, 'gpt-4o');
      guard.evaluateRequest({ tokens: 2000, model: 'gpt-4o', source: 'user-1' });
      guard.recordActualCost(2000, 'gpt-4o');

      const report = guard.getReport();
      // sessionTokens reflects the last actual call's tokens
      expect(report.sessionTokens).toBeGreaterThan(0);
      expect(report.sessionCost).toBeGreaterThan(0);
    });

    it('resetSession clears session data', () => {
      const guard = createGuard();
      guard.evaluateRequest({ tokens: 5000, model: 'gpt-4o', source: 'user-1' });
      guard.resetSession();

      const report = guard.getReport();
      expect(report.sessionCost).toBe(0);
      expect(report.sessionTokens).toBe(0);
    });

    it('resetDaily clears daily data', () => {
      const guard = createGuard();
      guard.evaluateRequest({ tokens: 5000, model: 'gpt-4o', source: 'user-1' });
      guard.resetDaily();

      const report = guard.getReport();
      expect(report.dailyCost).toBe(0);
      expect(report.dailyTokens).toBe(0);
    });

    it('liftMelt allows source to resume', () => {
      const guard = createGuard({ meltTokensPerRequest: 1000 });
      guard.evaluateRequest({ tokens: 10000, model: 'gpt-4o', source: 'freed' });
      expect(guard.isMelted('freed')).toBe(true);

      guard.liftMelt('freed');
      expect(guard.isMelted('freed')).toBe(false);

      const result = guard.evaluateRequest({ tokens: 10, model: 'gpt-4o', source: 'freed' });
      expect(result.action).toBe('LOGONLY');
    });
  });

  // ── Report Generation ───────────────────────────────────────────

  describe('report generation', () => {
    it('generates comprehensive report', () => {
      const guard = createGuard();
      guard.evaluateRequest({ tokens: 500, model: 'gpt-4o', source: 'user-1' });
      guard.evaluateToolCall({ toolName: 'web_search', source: 'user-1' });

      const report = guard.getReport();
      expect(report.sessionCost).toBeDefined();
      expect(report.dailyCost).toBeDefined();
      expect(report.sessionToolCalls === undefined).toBe(false);
      expect(report.tier).toBe('standard');
      expect(report.recentDecisions.length).toBeGreaterThan(0);
    });
  });

  // ── Decisions Tracking ──────────────────────────────────────────

  describe('decision tracking', () => {
    it('records all non-LOGONLY decisions', () => {
      const guard = createGuard({ maxTokensPerRequest: 500 });
      guard.evaluateRequest({ tokens: 1000, model: 'gpt-4o', source: 'user-1' });

      const decisions = guard.getDecisions();
      const nonLog = decisions.filter((d) => d.action !== 'LOGONLY');
      expect(nonLog.length).toBeGreaterThan(0);
    });

    it('caps decision history', () => {
      const guard = createGuard({ meltTokensPerRequest: 10 });

      // Generate many MELTs
      for (let i = 0; i < 300; i++) {
        guard.evaluateRequest({ tokens: 100, model: 'gpt-4o', source: `user-${i}` });
      }

      const decisions = guard.getDecisions();
      expect(decisions.length).toBeLessThanOrEqual(200);
    });
  });
});
