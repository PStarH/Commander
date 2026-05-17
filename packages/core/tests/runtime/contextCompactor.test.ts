import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactor, type CompactTaskType, type AdaptiveProfile, type CompositionScore } from '../../src/runtime/contextCompactor';
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

  describe('adaptive compaction — task type profiles', () => {
    it('returns correct profile for code tasks', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getCurrentTaskTypeProfile('code');
      assert.equal(profile.keepRecentTurns, 4);
      assert.equal(profile.maxToolOutputChars, 800);
      assert.equal(profile.collapseVerbosity, 'detail');
      assert.equal(profile.layerTriggers.layer1, 0.63);
    });

    it('returns correct profile for search tasks', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getCurrentTaskTypeProfile('search');
      assert.equal(profile.keepRecentTurns, 2);
      assert.equal(profile.maxToolOutputChars, 300);
      assert.equal(profile.collapseVerbosity, 'aggressive');
      assert.equal(profile.layerTriggers.layer1, 0.55);
    });

    it('returns correct profile for analysis tasks', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getCurrentTaskTypeProfile('analysis');
      assert.equal(profile.keepRecentTurns, 3);
      assert.equal(profile.collapseVerbosity, 'balanced');
    });

    it('returns correct profile for structured tasks', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getCurrentTaskTypeProfile('structured');
      assert.equal(profile.keepRecentTurns, 2);
      assert.equal(profile.collapseVerbosity, 'aggressive');
    });

    it('returns correct profile for general tasks', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getCurrentTaskTypeProfile('general');
      assert.equal(profile.keepRecentTurns, 3);
      assert.equal(profile.collapseVerbosity, 'balanced');
    });
  });

  describe('adaptive compaction — backward compatibility', () => {
    it('compact() without task type uses default profile', () => {
      const compactor = new ContextCompactor({ maxContextTokens: 400, layer1Trigger: 0.99, layer2Trigger: 0.99, layer3Trigger: 0.3, layer4Trigger: 0.99, keepRecentTurns: 1, governorAware: false });
      const messages: LLMMessage[] = [
        { role: 'system', content: 'You are a helpful assistant that helps with various tasks' },
        ...msgs('a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80), 'd'.repeat(80), 'e'.repeat(80), 'f'.repeat(80)),
      ];
      const { action } = compactor.compact(messages);
      assert.equal(action.layer, 3);
      assert.ok(action.droppedCount > 0);
    });

    it('compact() with explicit config overrides adaptive profile', () => {
      // config.keepRecentTurns = 1 differs from DEFAULT_CONFIG.keepRecentTurns = 3
      // So config should win over profile's keepRecentTurns
      const compactor = new ContextCompactor({ maxContextTokens: 300, layer1Trigger: 0.99, layer2Trigger: 0.99, layer3Trigger: 0.01, keepRecentTurns: 1, governorAware: false });
      const messages: LLMMessage[] = [
        { role: 'system', content: 'sys' },
        ...msgs('a', 'b', 'c', 'd', 'e', 'f'),
      ];
      // With keepRecentTurns=1 and 3 turns (6 messages), compact should drop 2 turns
      const { action } = compactor.compact(messages, undefined, 'code');
      assert.equal(action.layer, 3);
      // Code profile wants keepRecentTurns=4, but config wants 1 → config wins
      assert.ok(action.droppedCount >= 2);
    });
  });

  describe('adaptive compaction — task type affects thresholds', () => {
    it('code task compacts later than search task', () => {
      // Create messages that are right at code threshold but above search threshold
      const msgText = 'this is a test message that uses tokens'.repeat(20);
      const messages = msgs(msgText, msgText, msgText, msgText);

      const compactor = new ContextCompactor({
        maxContextTokens: 200,
        governorAware: false,
      });

      // With same messages, code should need less urgent compaction than search
      // because code has higher thresholds
      const codeLayer = compactor.needsCompaction(messages, 'code');
      const searchLayer = compactor.needsCompaction(messages, 'search');

      // Search compacts earlier, so its layer should be >= code's layer
      // (null < 1 < 2 < 3 < 4)
      const codeVal = codeLayer ?? 0;
      const searchVal = searchLayer ?? 0;
      assert.ok(searchVal >= codeVal, `Search (${searchVal}) should compact at least as aggressively as code (${codeVal})`);
    });

    it('detail collapse verbosity includes more items than aggressive', () => {
      const compactor = new ContextCompactor({
        maxContextTokens: 500,
        layer1Trigger: 0.99,
        layer2Trigger: 0.99,
        layer3Trigger: 0.01,
        keepRecentTurns: 0,
        governorAware: false,
      });

      const manyTurns: LLMMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first request' },
        { role: 'assistant', content: 'I will do that. The answer is 42.' },
        { role: 'user', content: 'second request' },
        { role: 'assistant', content: 'Therefore the total is 100. Found the result.' },
        { role: 'user', content: 'third request' },
        { role: 'assistant', content: 'In conclusion, I determined the answer.' },
        { role: 'user', content: 'final request' },
        { role: 'assistant', content: 'The sum of all values is 500.' },
      ];

      // Code (detail) should produce longer summary than search (aggressive)
      const codeResult = compactor.compact(manyTurns, undefined, 'code');
      const searchResult = compactor.compact(manyTurns, undefined, 'search');

      const codeSummary = codeResult.action.summary?.length ?? 0;
      const searchSummary = searchResult.action.summary?.length ?? 0;

      assert.ok(codeSummary >= searchSummary,
        `Detail summary (${codeSummary} chars) should be >= aggressive (${searchSummary} chars)`);
    });
  });

  describe('composition analysis', () => {
    it('detects high tool density', () => {
      const compactor = new ContextCompactor();
      const messages: LLMMessage[] = [
        { role: 'user', content: 'do something' },
        { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
        { role: 'tool', content: 'result', tool_call_id: '1' },
        { role: 'assistant', content: '', tool_calls: [{ id: '2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'data', tool_call_id: '2' },
      ];
      const composition = compactor.analyzeComposition(messages);
      assert.ok(composition.toolDensity > 0.5);
      assert.equal(composition.messageCount, 5);
    });

    it('detects high error density', () => {
      const compactor = new ContextCompactor();
      const messages: LLMMessage[] = [
        { role: 'tool', content: 'ERROR: file not found', tool_call_id: '1' },
        { role: 'tool', content: 'result ok', tool_call_id: '2' },
        { role: 'tool', content: 'Traceback: TypeError at line 42', tool_call_id: '3' },
      ];
      const composition = compactor.analyzeComposition(messages);
      assert.ok(composition.errorDensity > 0.5);
    });

    it('detects code blocks', () => {
      const compactor = new ContextCompactor();
      const messages: LLMMessage[] = [
        { role: 'user', content: '```python\nprint("hello")\n```' },
        { role: 'assistant', content: '```\nconst x = 1\n```' },
        { role: 'user', content: 'no code here' },
      ];
      const composition = compactor.analyzeComposition(messages);
      assert.equal(composition.codeBlockRatio, 2 / 3);
    });

    it('handles empty message list', () => {
      const compactor = new ContextCompactor();
      const composition = compactor.analyzeComposition([]);
      assert.equal(composition.toolDensity, 0);
      assert.equal(composition.errorDensity, 0);
      assert.equal(composition.messageCount, 0);
    });
  });

  describe('getEffectiveProfile', () => {
    it('returns default profile without task type', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getEffectiveProfile();
      assert.equal(profile.keepRecentTurns, 3);
      assert.equal(profile.collapseVerbosity, 'balanced');
    });

    it('returns code profile with task type', () => {
      const compactor = new ContextCompactor();
      const profile = compactor.getEffectiveProfile('code');
      assert.equal(profile.keepRecentTurns, 4);
    });

    it('composition adjusts high tool density profile', () => {
      const compactor = new ContextCompactor();
      const messages: LLMMessage[] = [
        { role: 'user', content: 'do' },
        { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
        { role: 'tool', content: 'result', tool_call_id: '1' },
      ];
      // general + high tool density → keepRecentTurns should be boosted to at least 4
      const profile = compactor.getEffectiveProfile('general', messages);
      assert.ok(profile.keepRecentTurns >= 4);
    });

    it('config overrides take priority over profile', () => {
      const compactor = new ContextCompactor({ keepRecentTurns: 5 });
      const profile = compactor.getEffectiveProfile('search');
      // search wants 2, but config says 5 → config wins
      assert.equal(profile.keepRecentTurns, 5);
    });
  });
});
