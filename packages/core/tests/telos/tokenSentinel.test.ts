import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TokenSentinel,
  resetTokenSentinel,
  estimateTokenCount,
  estimateMessagesTokens,
  calculateCostBreakdown,
  CACHE_MULTIPLIERS,
} from '../../src/telos/tokenSentinel';

describe('TokenSentinel', () => {
  let sentinel: TokenSentinel;

  beforeEach(() => {
    resetTokenSentinel();
    sentinel = new TokenSentinel(1000);
  });

  describe('estimateTokenCount', () => {
    it('estimates English text', () => {
      const count = estimateTokenCount('Hello world, this is a test message.', 'gpt-4');
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(20);
    });

    it('estimates Chinese text at higher density', () => {
      const count = estimateTokenCount('你好世界，这是一个测试消息。', 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('estimates mixed Chinese+English', () => {
      const count = estimateTokenCount('Hello 你好 world 世界', 'claude-3-5-sonnet');
      expect(count).toBeGreaterThan(0);
    });

    it('estimates code-like text', () => {
      const code = 'function hello() { return "world"; } const x = 42;';
      const count = estimateTokenCount(code, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });

    it('handles empty string', () => {
      expect(estimateTokenCount('', 'gpt-4')).toBe(0);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('estimates tokens for a conversation', () => {
      const msgs = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
      ];
      const count = estimateMessagesTokens(msgs, 'gpt-4');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('pre-flight check', () => {
    it('allows requests within budget', () => {
      const result = sentinel.check([{ role: 'user', content: 'Hello' }], 'gpt-4o', {
        hardCapTokens: 64000,
        softCapTokens: 48000,
        costCapUsd: 2.0,
      });
      expect(result.allowed).toBe(true);
      expect(result.totalEstimated).toBeGreaterThan(0);
      expect(result.budgetRemaining).toBeGreaterThan(0);
    });

    it('denies requests exceeding hard cap', () => {
      const longText = 'A'.repeat(500000);
      const result = sentinel.check([{ role: 'user', content: longText }], 'gpt-4o', {
        hardCapTokens: 100,
        softCapTokens: 50,
        costCapUsd: 1.0,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('hard cap');
    });
  });

  describe('budget enforcement', () => {
    it('detects hard cap reached', () => {
      const alert = sentinel.checkBudget('run-1', 65000, {
        hardCapTokens: 64000,
        softCapTokens: 48000,
        costCapUsd: 2.0,
      });
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('hard_cap_reached');
    });

    it('returns null when under cap', () => {
      const alert = sentinel.checkBudget('run-1', 1000, {
        hardCapTokens: 64000,
        softCapTokens: 48000,
        costCapUsd: 2.0,
      });
      expect(alert).toBeNull();
    });

    it('returns null when hard cap is not configured', () => {
      const alert = sentinel.checkBudget('run-1', 1000000, {
        hardCapTokens: 0,
        softCapTokens: 0,
        costCapUsd: 1.0,
      });
      expect(alert).toBeNull();
    });
  });

  describe('soft cap warning', () => {
    it('records a soft-cap alert when estimate exceeds soft cap', () => {
      const result = sentinel.check([{ role: 'user', content: 'short' }], 'gpt-4', {
        hardCapTokens: 100,
        softCapTokens: 1,
        costCapUsd: 1.0,
      });
      expect(result.allowed).toBe(true);
      expect(sentinel.getAlerts().some((a) => a.type === 'soft_cap_warning')).toBe(true);
    });
  });

  describe('cost breakdown', () => {
    it('exports cache multipliers with read/write ratios', () => {
      expect(CACHE_MULTIPLIERS.anthropic.read).toBe(0.1);
      expect(CACHE_MULTIPLIERS.openai.write).toBe(1.0);
      expect(CACHE_MULTIPLIERS.default.read).toBe(1.0);
    });

    it('falls back to conservative pricing for unknown models', () => {
      const result = calculateCostBreakdown('unknown-model-xyz', 1000, 500);
      expect(result.totalUsd).toBeGreaterThan(0);
      expect(result.cacheSavingsUsd).toBe(0);
    });

    it('computes cache read/write costs and savings for known models', () => {
      const result = calculateCostBreakdown('gpt-4o', 1000, 500, 100, 50);
      expect(result.cacheReadCostUsd).toBeGreaterThan(0);
      expect(result.cacheWriteCostUsd).toBeGreaterThan(0);
      expect(result.cacheSavingsUsd).toBeGreaterThan(0);
      expect(result.totalUsd).toBeGreaterThan(0);
    });

    it('applies batch discount when isBatch is true', () => {
      const batch = calculateCostBreakdown('gpt-4o', 10000, 5000, 0, 0, true);
      const standard = calculateCostBreakdown('gpt-4o', 10000, 5000, 0, 0, false);
      expect(batch.totalUsd).toBeLessThan(standard.totalUsd);
    });
  });
});
