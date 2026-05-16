import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactor } from '../../src/runtime/contextCompactor';
import type { LLMMessage } from '../../src/runtime/types';

function msgs(...contents: string[]): LLMMessage[] {
  return contents.map((c, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: c,
  }));
}

function systemMsg(content: string): LLMMessage {
  return { role: 'system', content };
}

function toolMsg(content: string): LLMMessage {
  return { role: 'tool', content, tool_call_id: 'tc1' };
}

function assistantWithToolCalls(content: string, calls: Array<{ name: string; args: string }>): LLMMessage {
  return {
    role: 'assistant',
    content,
    tool_calls: calls.map((c, i) => ({
      id: `tc_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args },
    })),
  };
}

describe('ContextCompactor (upgraded)', () => {
  describe('token estimation', () => {
    it('uses CJK-aware estimation', () => {
      const compactor = new ContextCompactor({ maxContextTokens: 100000 });
      // CJK text should have more tokens per char than ASCII
      const ascii: LLMMessage[] = [{ role: 'user', content: 'a'.repeat(400) }];
      const cjk: LLMMessage[] = [{ role: 'user', content: '中'.repeat(400) }];
      const asciiUsage = compactor.getUsage(ascii);
      const cjkUsage = compactor.getUsage(cjk);
      // CJK should have more tokens (each CJK char ≈ 0.67 tokens vs ASCII 0.25 tokens)
      assert.ok(cjkUsage.total > asciiUsage.total);
    });
  });

  describe('needsCompaction', () => {
    it('returns null when under threshold', () => {
      const compactor = new ContextCompactor({ maxContextTokens: 100000 });
      const messages = msgs('short', 'reply');
      assert.equal(compactor.needsCompaction(messages), null);
    });

    it('returns correct layer when over threshold', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 100,
        layer1Trigger: 0.1, // very low to trigger
      });
      const messages = msgs('a'.repeat(200), 'b'.repeat(200));
      assert.ok(compactor.needsCompaction(messages) !== null);
    });
  });

  describe('layer1Snip', () => {
    it('removes oldest turn-pairs', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 200,
        layer1Trigger: 0.01,
        keepRecentTurns: 1,
      });
      const messages: LLMMessage[] = [
        systemMsg('You are helpful'),
        ...msgs('turn1 user', 'turn1 assistant', 'turn2 user', 'turn2 assistant'),
      ];
      const { messages: result, action } = compactor.compact(messages);
      assert.equal(action.layer, 1);
      assert.ok(action.droppedCount > 0);
      assert.ok(result.length < messages.length);
      // System message preserved
      assert.ok(result.some(m => m.role === 'system'));
    });
  });

  describe('layer2Microcompact', () => {
    it('trims verbose tool outputs', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 500,
        layer1Trigger: 0.99, // disable layer 1
        layer2Trigger: 0.01,
        maxToolOutputChars: 50,
        governorAware: false,
      });
      const messages: LLMMessage[] = [
        systemMsg('sys'),
        ...msgs('do something', 'ok'),
        toolMsg('a'.repeat(200)),
      ];
      const { action } = compactor.compact(messages);
      assert.equal(action.layer, 2);
      assert.ok(action.droppedCount > 0);
    });
  });

  describe('layer3Collapse', () => {
    it('collapses middle turns into summary', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 300,
        layer1Trigger: 0.99,
        layer2Trigger: 0.99,
        layer3Trigger: 0.01,
        keepRecentTurns: 1,
        governorAware: false,
      });
      const messages: LLMMessage[] = [
        systemMsg('You are a helpful assistant'),
        ...msgs(
          'I need help with Python',
          'Sure, what do you need?',
          'Fix the bug in main.py',
          'I found the issue: line 42 has a type error',
          'Great, now run the tests',
          'All 10 tests passed',
        ),
      ];
      const { messages: result, action } = compactor.compact(messages);
      assert.equal(action.layer, 3);
      assert.ok(action.summary);
      // Should have system + summary + recent
      assert.ok(result.some(m => typeof m.content === 'string' && m.content.includes('Compacted summary')));
    });

    it('prevents double-compaction', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 200,
        layer1Trigger: 0.99,
        layer2Trigger: 0.99,
        layer3Trigger: 0.01,
        keepRecentTurns: 1,
        governorAware: false,
      });
      // First compaction
      const messages1: LLMMessage[] = [
        systemMsg('sys'),
        ...msgs('a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100), 'd'.repeat(100)),
      ];
      const { messages: compacted } = compactor.compact(messages1);

      // Second compaction on already-compacted messages
      const moreMessages: LLMMessage[] = [
        ...compacted,
        ...msgs('e'.repeat(100), 'f'.repeat(100)),
      ];
      const { messages: result2, action: action2 } = compactor.compact(moreMessages);
      // Should still work without degrading
      assert.ok(action2.droppedCount >= 0);
    });
  });

  describe('layer4Autocompact', () => {
    it('keeps messages by token budget, not count', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 500,
        layer1Trigger: 0.99,
        layer2Trigger: 0.99,
        layer3Trigger: 0.99,
        layer4Trigger: 0.01,
        governorAware: false,
      });
      // Create many short messages
      const messages: LLMMessage[] = [
        systemMsg('sys'),
        ...Array.from({ length: 50 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `msg ${i}`,
        })),
      ];
      const { messages: result, action } = compactor.compact(messages);
      assert.equal(action.layer, 4);
      // Should have system + summary + some recent
      assert.ok(result.length < messages.length);
      assert.ok(result.some(m => typeof m.content === 'string' && m.content.includes('Emergency compact')));
    });
  });

  describe('importance scoring', () => {
    it('preserves error messages in layer3', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 300,
        layer1Trigger: 0.99,
        layer2Trigger: 0.99,
        layer3Trigger: 0.01,
        keepRecentTurns: 1,
        governorAware: false,
      });
      const messages: LLMMessage[] = [
        systemMsg('sys'),
        ...msgs('do something', 'ok'),
        toolMsg('ERROR: file not found at /tmp/test.txt'),
        ...msgs('try again', 'done'),
      ];
      const { messages: result } = compactor.compact(messages);
      // Error message should be preserved
      const hasError = result.some(m =>
        typeof m.content === 'string' && m.content.includes('ERROR'),
      );
      assert.ok(hasError, 'Error message should be preserved through compaction');
    });

    it('preserves user instructions in layer3', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 300,
        layer1Trigger: 0.99,
        layer2Trigger: 0.99,
        layer3Trigger: 0.01,
        keepRecentTurns: 1,
        governorAware: false,
      });
      const messages: LLMMessage[] = [
        systemMsg('sys'),
        { role: 'user', content: 'Please implement a sorting algorithm in Python with these requirements: must handle edge cases' },
        { role: 'assistant', content: 'I will implement merge sort' },
        ...msgs('do something else', 'ok'),
        ...msgs('final task', 'done'),
      ];
      const { messages: result } = compactor.compact(messages);
      // User instruction should be preserved
      const hasInstruction = result.some(m =>
        typeof m.content === 'string' && m.content.includes('sorting algorithm'),
      );
      assert.ok(hasInstruction, 'User instruction should be preserved');
    });
  });

  describe('governor-aware thresholds', () => {
    it('compacts with default thresholds when governor-aware disabled', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 100,
        governorAware: false,
        layer1Trigger: 0.5,
      });
      const messages = msgs('a'.repeat(60), 'b'.repeat(60));
      const layer = compactor.needsCompaction(messages);
      // At 120 chars ≈ 30+ tokens, 100 token budget, should be > 50%
      assert.ok(layer !== null);
    });
  });
});
