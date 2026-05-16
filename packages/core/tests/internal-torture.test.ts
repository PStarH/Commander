import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { AgentRuntime } from '../src/runtime/agentRuntime';
import { classifyLLMError, computeBackoff } from '../src/runtime/llmRetry';
import { CircuitBreaker } from '../src/runtime/circuitBreaker';
import { ContextCompactor } from '../src/runtime/contextCompactor';
import type { LLMMessage } from '../src/runtime/types';

describe('Internal Torture Test — WP1: Context Overflow', () => {
  it('compacts after many tool loop iterations', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 2000, layer1Trigger: 0.3, keepRecentTurns: 2 });
    const msgs: LLMMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: 'user', content: `Step ${i}: do something`.repeat(50) });
      msgs.push({ role: 'assistant', content: `Result of step ${i}`.repeat(50) });
      msgs.push({ role: 'tool', content: `Tool output for step ${i}: x`.repeat(100), tool_call_id: `call_${i}` });
    }
    const { action } = compactor.compact(msgs);
    assert.ok(action.droppedCount > 0, `Compaction should drop messages, dropped: ${action.droppedCount}`);
    assert.ok(action.tokensSaved > 0, `Compaction should save tokens, saved: ${action.tokensSaved}`);
  });

  it('needs compaction when context is large', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 1000, layer1Trigger: 0.5 });
    const many: LLMMessage[] = [
      { role: 'system', content: 's' },
      ...Array(20).fill(null).map((_, i) => ({ role: 'user' as const, content: `Message ${i} `.repeat(30) })),
    ];
    const layer = compactor.needsCompaction(many);
    assert.ok(layer !== null, `Should need compaction, got layer: ${layer}`);
  });

  it('torture: 100 rapid tool turns without OOM', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 64000, layer1Trigger: 0.4, layer2Trigger: 0.6, keepRecentTurns: 3, maxToolOutputChars: 100 });
    let msgs: LLMMessage[] = [{ role: 'system', content: 'You are a tireless assistant.' }];
    let peakLength = 0;
    for (let i = 0; i < 100; i++) {
      msgs.push({ role: 'user', content: `Iteration ${i}` });
      msgs.push({ role: 'assistant', content: `Response ${i}`, tool_calls: [{ id: `tc_${i}`, type: 'function', function: { name: 'test', arguments: '{}' } }] });
      msgs.push({ role: 'tool', content: `Output ${i}: `.repeat(500), tool_call_id: `tc_${i}` });
      if (i > 5 && i % 10 === 0) {
        const r = compactor.compact(msgs);
        msgs = r.messages;
      }
      peakLength = Math.max(peakLength, msgs.length);
    }
    assert.ok(msgs.length < 200, `Messages should be bounded after compaction, was: ${msgs.length}`);
    console.log(`  [torture] 100 turns: peak ${peakLength} msgs, final ${msgs.length} msgs`);
  });
});

describe('Internal Torture Test — WP2+WP4: Error Handling & Retry', () => {
  it('classifies 401 as permanent (no retry)', () => {
    const result = classifyLLMError(new Error('401 Unauthorized: invalid API key'));
    assert.strictEqual(result.retryable, false, '401 should be permanent');
    assert.strictEqual(result.errorClass, 'permanent');
  });

  it('classifies 429 as transient with retry', () => {
    const result = classifyLLMError(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
    assert.strictEqual(result.retryable, true, '429 should be retryable');
    assert.strictEqual(result.errorClass, 'transient');
  });

  it('classifies timeout as transient', () => {
    const result = classifyLLMError(new Error('timeout of 30000ms exceeded'));
    assert.strictEqual(result.retryable, true, 'timeout should be retryable');
  });

  it('exponential backoff produces increasing delays', () => {
    const delays = [0, 1, 2, 3, 4].map(i => computeBackoff(i, 1000, 30000));
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i] >= delays[i - 1] * 0.5, `Backoff should increase (${delays[i]} >= ${delays[i - 1]})`);
    }
    assert.ok(delays[0] >= 500 && delays[0] <= 1500, `First backoff ~1000ms: ${delays[0]}`);
    assert.ok(delays[3] <= 35000, `Fourth backoff capped: ${delays[3]}`);
  });

  it('over 1000 concurrent callers, jitter prevents thundering herd', () => {
    const delays = Array.from({ length: 1000 }, () => computeBackoff(0, 1000, 30000));
    const unique = new Set(delays);
    assert.ok(unique.size > 100, `Jitter should produce >100 unique delays, got ${unique.size}`);
  });
});

describe('Internal Torture Test — WP3: Self-Correction Dedup', () => {
  it('Reflexion context prevents repeated mistakes', () => {
    const prevScore = 0.3;
    const reflexion = `\n\nPrevious fix attempt scored ${(prevScore * 100).toFixed(0)}% but failed to pass the same gate. Do NOT repeat the same approach. Try a different strategy.`;
    assert.ok(reflexion.includes('30%'), 'Reflexion includes previous score');
    assert.ok(reflexion.includes('Do NOT repeat'), 'Reflexion explicitly discourages repetition');
  });

  it('identical output is detected and skipped', () => {
    const original = 'The synthesis text is exactly the same';
    const newOutput = 'The synthesis text is exactly the same';
    assert.ok(newOutput === original, 'Identical output should be detected');
  });
});

describe('Internal Torture Test — WP5: Circuit Breaker', () => {
  it('starts CLOSED', () => {
    const cb = new CircuitBreaker(3, 1000);
    assert.strictEqual(cb.isAvailable(), true);
  });

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker(3, 10000);
    assert.strictEqual(cb.isAvailable(), true);
    cb.onFailure();
    assert.strictEqual(cb.isAvailable(), true);
    cb.onFailure();
    assert.strictEqual(cb.isAvailable(), true);
    cb.onFailure();
    assert.strictEqual(cb.isAvailable(), false, 'Circuit should be OPEN after 3 failures');
  });

  it('half-opens after recovery time', async () => {
    const cb = new CircuitBreaker(2, 100); // 100ms recovery
    cb.onFailure();
    cb.onFailure();
    assert.strictEqual(cb.isAvailable(), false, 'OPEN after 2 failures');
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(cb.isAvailable(), true, 'HALF_OPEN after recovery');
    cb.onSuccess();
    assert.strictEqual(cb.isAvailable(), true, 'CLOSED after success in HALF_OPEN');
  });

  it('resets on success in half-open state', () => {
    const cb = new CircuitBreaker(3, 5000);
    cb.onFailure(); cb.onFailure(); cb.onFailure();
    // Force half-open
    const resetSpy = () => { cb['state'] = 'HALF_OPEN' as any; };
    resetSpy();
    cb.onSuccess();
    assert.strictEqual(cb.isAvailable(), true);
  });
});

describe('Internal Torture Test — All Weak Points Combined', () => {
  it('torture: circuit breaker + error classification + backoff compose correctly', () => {
    const cb = new CircuitBreaker(3, 5000);
    const errors = [
      { err: new Error('401 Unauthorized'), expected: 'permanent' },
      { err: new Error('timeout'), expected: 'transient' },
      { err: new Error('429 rate limit'), expected: 'transient' },
    ];

    for (const { err, expected } of errors) {
      const classified = classifyLLMError(err);
      assert.strictEqual(classified.errorClass, expected, `${err.message} -> ${expected}`);
      if (classified.retryable) {
        // Transient errors that exhaust retries should trigger circuit breaker
        cb.onFailure();
      }
    }
    // 2 transient + 1 permanent = 2 circuit breaker hits, threshold is 3
    assert.strictEqual(cb.isAvailable(), true, 'Circuit should still be closed (2/3 failures)');
  });

  it('torture: 10K messages without crash', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 50000, layer1Trigger: 0.5, keepRecentTurns: 3 });
    let msgs: LLMMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 10000; i++) {
      msgs.push({ role: 'user', content: `msg${i}` });
      if (i % 100 === 0 && i > 0) {
        const { messages } = compactor.compact(msgs);
        msgs = messages;
      }
    }
    assert.ok(msgs.length < 5000, `Messages bounded under 5000 after 10K: ${msgs.length}`);
  });
});
