import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TokenSentinel, resetTokenSentinel, estimateTokenCount, estimateMessagesTokens } from '../../src/telos/tokenSentinel';

describe('TokenSentinel', () => {
  let sentinel: TokenSentinel;

  before(() => {
    resetTokenSentinel();
    sentinel = new TokenSentinel(100, 50);
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
      const result = sentinel.check(
        [{ role: 'user', content: 'Hello' }],
        'gpt-4o',
        { hardCapTokens: 64000, softCapTokens: 48000, costCapUsd: 2.0 },
      );
      expect(result.allowed).toBe(true);
      expect(result.totalEstimated).toBeGreaterThan(0);
      expect(result.budgetRemaining).toBeGreaterThan(0);
    });

    it('denies requests exceeding hard cap', () => {
      const longText = 'A'.repeat(500000);
      const result = sentinel.check(
        [{ role: 'user', content: longText }],
        'gpt-4o',
        { hardCapTokens: 100, softCapTokens: 50, costCapUsd: 1.0 },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('hard cap');
    });

    it('denies requests exceeding monthly budget', () => {
      const expensive = new TokenSentinel(100, 1.0);
      const result1 = expensive.check(
        [{ role: 'user', content: 'Hello' }],
        'gpt-4o',
        { hardCapTokens: 64000, softCapTokens: 48000, costCapUsd: 2.0 },
      );
      expect(result1.allowed).toBe(true);

      expensive.recordCostFromUsage('run-1', 'agent-1', 'gpt-4o', {
        promptTokens: 200000,
        completionTokens: 50000,
        totalTokens: 250000,
      });

      const result2 = expensive.check(
        [{ role: 'user', content: 'Hello' }],
        'gpt-4o',
        { hardCapTokens: 64000, softCapTokens: 48000, costCapUsd: 2.0 },
      );
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain('monthly');
    });
  });

  describe('cost tracking', () => {
    it('records costs from token usage', () => {
      const record = sentinel.recordCostFromUsage('run-1', 'agent-1', 'gpt-4o-mini', {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      });
      expect(record.runId).toBe('run-1');
      expect(record.agentId).toBe('agent-1');
      expect(record.totalTokens).toBe(1500);
      expect(record.costUsd).toBeGreaterThan(0);
    });

    it('produces cost summary', () => {
      sentinel.recordCostFromUsage('run-1', 'agent-1', 'gpt-4o-mini', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
      sentinel.recordCostFromUsage('run-1', 'agent-2', 'gpt-4o', { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 });

      const summary = sentinel.getCostSummary();
      expect(summary.totalCalls).toBe(2);
      expect(summary.totalTokens).toBe(4500);
      expect(summary.perModel['gpt-4o-mini']).toBeDefined();
      expect(summary.perModel['gpt-4o']).toBeDefined();
      expect(summary.perAgent['agent-1']).toBeDefined();
      expect(summary.perAgent['agent-2']).toBeDefined();
    });

    it('filters costs by run ID', () => {
      sentinel.recordCostFromUsage('run-a', 'agent-1', 'gpt-4o-mini', { promptTokens: 100, completionTokens: 50, totalTokens: 150 });
      sentinel.recordCostFromUsage('run-b', 'agent-1', 'gpt-4o-mini', { promptTokens: 200, completionTokens: 100, totalTokens: 300 });

      const runACosts = sentinel.getCosts('run-a');
      expect(runACosts.length).toBe(1);
    });
  });

  describe('budget enforcement', () => {
    it('detects hard cap reached', () => {
      const alert = sentinel.checkBudget('run-1', 65000, { hardCapTokens: 64000, softCapTokens: 48000, costCapUsd: 2.0 });
      expect(alert).not.toBeNull();
      expect(alert!.type).toBe('hard_cap_reached');
    });

    it('returns null when under cap', () => {
      const alert = sentinel.checkBudget('run-1', 1000, { hardCapTokens: 64000, softCapTokens: 48000, costCapUsd: 2.0 });
      expect(alert).toBeNull();
    });
  });

  describe('monthly tracking', () => {
    it('tracks monthly cost', () => {
      expect(sentinel.getMonthlyCostUsd()).toBe(0);
      sentinel.recordCostFromUsage('run-1', 'agent-1', 'gpt-4o-mini', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
      expect(sentinel.getMonthlyCostUsd()).toBeGreaterThan(0);
    });

    it('resets monthly tracking', () => {
      sentinel.recordCostFromUsage('run-1', 'agent-1', 'gpt-4o-mini', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
      sentinel.resetMonthly();
      expect(sentinel.getMonthlyCostUsd()).toBe(0);
    });
  });
});
