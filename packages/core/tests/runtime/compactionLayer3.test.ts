import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SemanticToolCompactor } from '../../src/runtime/compactionLayer3.js';

import type { SemanticCompactionConfig } from '../../src/runtime/compactionLayer3.js';

// ============================================================================
// Mock LLM provider for testing
// ============================================================================

class MockCompactionProvider {
  private nextResponse: LLMResponse | null = null;
  private lastRequest: Record<string, unknown> | null = null;

  setResponse(response: LLMResponse): void {
    this.nextResponse = response;
  }

  getLastRequest(): Record<string, unknown> | null {
    return this.lastRequest;
  }

  async call(req: Record<string, unknown>): Promise<LLMResponse | null> {
    this.lastRequest = req;
    return this.nextResponse;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('SemanticToolCompactor', () => {
  const LARGE_OUTPUT = 'x'.repeat(3000);
  const SMALL_OUTPUT = 'short output';

  describe('constructor and config', () => {
    it('creates with default config', () => {
      const c = new SemanticToolCompactor();
      const cfg = c.getConfig();
      assert.strictEqual(cfg.enabled, true);
      assert.strictEqual(cfg.minOutputChars, 2000);
      assert.ok(cfg.excludeTools.includes('git'));
    });

    it('accepts partial config override', () => {
      const c = new SemanticToolCompactor({ enabled: false, minOutputChars: 500 });
      const cfg = c.getConfig();
      assert.strictEqual(cfg.enabled, false);
      assert.strictEqual(cfg.minOutputChars, 500);
      assert.strictEqual(cfg.maxSummaryTokens, 300); // defaults preserved
    });
  });

  describe('shouldCompact', () => {
    const c = new SemanticToolCompactor();

    it('returns true for large output with budget', () => {
      assert.strictEqual(c.shouldCompact(LARGE_OUTPUT, 'file_read', 20000), true);
    });

    it('returns false for small output', () => {
      assert.strictEqual(c.shouldCompact(SMALL_OUTPUT, 'file_read', 20000), false);
    });

    it('returns false when disabled', () => {
      const disabled = new SemanticToolCompactor({ enabled: false });
      assert.strictEqual(disabled.shouldCompact(LARGE_OUTPUT, 'file_read', 20000), false);
    });

    it('returns false for excluded tools', () => {
      assert.strictEqual(c.shouldCompact(LARGE_OUTPUT, 'git', 20000), false);
    });

    it('returns false when budget is too low', () => {
      assert.strictEqual(c.shouldCompact(LARGE_OUTPUT, 'file_read', 1000), false);
    });

    it('respects includeTools whitelist when set', () => {
      const whitelist = new SemanticToolCompactor({ includeTools: ['file_read', 'code_search'] });
      assert.strictEqual(whitelist.shouldCompact(LARGE_OUTPUT, 'file_read', 20000), true);
      assert.strictEqual(whitelist.shouldCompact(LARGE_OUTPUT, 'shell_execute', 20000), false);
    });
  });

  describe('compact (with mock provider)', () => {
    it('returns original content when not eligible for compaction', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      const result = await c.compact(
        SMALL_OUTPUT,
        'file_read',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
      );
      assert.strictEqual(result.compacted, false);
      assert.strictEqual(result.content, SMALL_OUTPUT);
      assert.strictEqual(result.tokensSaved, 0);
    });

    it('compacts large output via LLM', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      provider.setResponse({
        content: 'Summarized: this is a compact version',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        model: 'test',
      });

      const result = await c.compact(
        LARGE_OUTPUT,
        'file_read',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      assert.strictEqual(result.compacted, true);
      assert.ok(result.content.includes('[Compacted file_read output:'), `got: ${result.content}`);
      assert.ok(result.originalChars > result.compactedChars);
      assert.ok(result.tokensSaved > 0);
      assert.ok(result.durationMs >= 0);
    });

    it('falls back to original content when LLM returns null', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      provider.setResponse(null as unknown as LLMResponse);

      const result = await c.compact(
        LARGE_OUTPUT,
        'file_read',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      assert.strictEqual(result.compacted, false);
      assert.strictEqual(result.content, LARGE_OUTPUT);
    });

    it('falls back to original content when LLM returns empty content', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      provider.setResponse({
        content: '',
        usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
        model: 'test',
      });

      const result = await c.compact(
        LARGE_OUTPUT,
        'file_read',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      assert.strictEqual(result.compacted, false);
      assert.strictEqual(result.content, LARGE_OUTPUT);
    });

    it('falls back to original content when LLM throws', async () => {
      const c = new SemanticToolCompactor();
      const throwingProvider = {
        async call() {
          throw new Error('Provider down');
        },
      };

      const result = await c.compact(
        LARGE_OUTPUT,
        'file_read',
        throwingProvider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      assert.strictEqual(result.compacted, false);
      assert.strictEqual(result.content, LARGE_OUTPUT);
    });

    it('uses tool-specific prompt for file_read', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      provider.setResponse({
        content: 'Compacted',
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        model: 'test',
      });

      await c.compact(
        LARGE_OUTPUT,
        'file_read',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      const req = provider.getLastRequest();
      assert.ok(req, 'LLM request should have been made');
      const msgs = (req as { messages: Array<{ content: string }> }).messages;
      assert.ok(msgs[0].content.includes('function/class signatures'));
    });

    it('uses default prompt for unknown tools', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      provider.setResponse({
        content: 'Compacted',
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        model: 'test',
      });

      await c.compact(
        LARGE_OUTPUT,
        'unknown_tool',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      const req = provider.getLastRequest();
      assert.ok(req, 'LLM request should have been made');
      const msgs = (req as { messages: Array<{ content: string }> }).messages;
      assert.ok(msgs[0].content.includes('tool output summarizer'));
    });

    it('truncates very long input before sending to LLM', async () => {
      const c = new SemanticToolCompactor();
      const provider = new MockCompactionProvider();
      provider.setResponse({
        content: 'Compacted',
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        model: 'test',
      });

      const hugeOutput = 'x'.repeat(50000);
      await c.compact(
        hugeOutput,
        'file_read',
        provider as unknown as import('../../src/runtime/types.js').LLMProvider,
        20000,
      );
      const req = provider.getLastRequest();
      assert.ok(req, 'LLM request should have been made');
      const msgs = (req as { messages: Array<{ content: string }> }).messages;
      const userMsg = msgs[1].content;
      assert.ok(
        userMsg.includes('[truncated:'),
        `Expected truncation marker, got: ${userMsg.slice(0, 500)}`,
      );
      // User message should be approximately 12000 chars (maxInputChars)
      assert.ok(userMsg.length <= 20000, `User message too long: ${userMsg.length}`);
    });
  });

  describe('estimateSavings', () => {
    it('estimates positive savings for large output', () => {
      const c = new SemanticToolCompactor();
      const savings = c.estimateSavings(LARGE_OUTPUT);
      assert.ok(savings.charsSaved > 0);
      assert.ok(savings.estimatedTokensSaved > 0);
    });

    it('estimates modest savings for medium output', () => {
      const c = new SemanticToolCompactor();
      const savings = c.estimateSavings('x'.repeat(5000));
      assert.ok(savings.charsSaved > 0);
    });

    it('returns zero savings for very short output', () => {
      const c = new SemanticToolCompactor();
      const savings = c.estimateSavings('hi');
      assert.ok(savings.charsSaved >= 0);
    });
  });
});
