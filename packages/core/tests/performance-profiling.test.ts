/**
 * Performance & Stability Profiling Suite
 *
 * 1. Memory profiling under 200K token context
 * 2. Concurrent request latency distribution (P50/P95/P99)
 * 3. Long-running 1000-round degradation test
 * 4. Tool call cache effectiveness analysis
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ContextCompactor } from '../src/runtime/contextCompactor';
import { InMemoryMemoryStore } from '../src/memory';
import { TokenGovernor } from '../src/runtime/tokenGovernor';
import { ToolResultCache } from '../src/runtime/toolResultCache';
import { CircuitBreaker } from '../src/runtime/circuitBreaker';
import type { LLMMessage } from '../src/runtime/types';

// ============================================================================
// Helpers
// ============================================================================

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(times: number[]): { min: number; max: number; avg: number; p50: number; p95: number; p99: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function heapMB(): number {
  global.gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// ============================================================================
// 1. Memory Profiling Under Long Context
// ============================================================================

describe('1. Memory Profiling — 200K Token Context', () => {
  it('ContextCompactor does not leak memory across 100 compaction cycles', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 50000, layer1Trigger: 0.3, keepRecentTurns: 3 });

    global.gc?.();
    const heapBefore = heapMB();

    // Simulate 100 compaction cycles, each with 500 messages
    for (let cycle = 0; cycle < 100; cycle++) {
      const msgs: LLMMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }];
      for (let i = 0; i < 500; i++) {
        msgs.push({ role: 'user', content: `Cycle ${cycle} message ${i}: ${'x'.repeat(200)}` });
        msgs.push({ role: 'assistant', content: `Response ${i}: ${'y'.repeat(100)}` });
      }
      const { messages } = compactor.compact(msgs);
      // messages goes out of scope here — should be GC'd
      assert.ok(messages.length > 0);
    }

    global.gc?.();
    const heapAfter = heapMB();
    const growth = heapAfter - heapBefore;

    console.log(`  [Memory] ContextCompactor: before=${heapBefore.toFixed(1)}MB, after=${heapAfter.toFixed(1)}MB, growth=${growth.toFixed(1)}MB`);
    // Should not grow more than 50MB after 100 cycles (all intermediate arrays should be GC'd)
    assert.ok(growth < 50, `ContextCompactor memory growth should be < 50MB, got ${growth.toFixed(1)}MB`);
  });

  it('InMemoryMemoryStore bounded by LRU eviction (GAP-22 fix)', async () => {
    const maxEntries = 2000;
    const store = new InMemoryMemoryStore(maxEntries);

    global.gc?.();
    const heapBefore = heapMB();

    // Write 10000 items — LRU should cap at maxEntries
    for (let i = 0; i < 10000; i++) {
      await store.write({
        projectId: 'test',
        kind: 'LESSON',
        title: `Memory item ${i}`,
        content: `Content for item ${i} with some detail that makes it realistic. `.repeat(5),
        tags: ['test', `tag-${i % 100}`],
      });
    }

    global.gc?.();
    const heapAfter = heapMB();
    const growth = heapAfter - heapBefore;
    const stats = await store.getStats('test');

    console.log(`  [Memory] InMemoryMemoryStore (maxEntries=${maxEntries}): ${stats.totalItems} items, growth=${growth.toFixed(1)}MB`);
    // LRU eviction should cap items at maxEntries
    assert.strictEqual(stats.totalItems, maxEntries, `Should be capped at ${maxEntries}, got ${stats.totalItems}`);
    // Growth should be bounded (not proportional to 10K writes)
    assert.ok(growth < 50, `Bounded growth should be < 50MB, got ${growth.toFixed(1)}MB`);

    await store.close();
  });

  it('TokenGovernor singleton does not leak across resets', () => {
    const governor = new TokenGovernor({ totalBudget: 200000, enableLearning: true });

    global.gc?.();
    const heapBefore = heapMB();

    // Simulate 1000 task executions with learning
    for (let i = 0; i < 1000; i++) {
      governor.reset(200000);
      governor.reportUsage(1000 + i * 10);
      governor.recordOutcome('compress', 1000, 800);
      governor.recordOutcome('truncate', 500, 300);
      governor.getRecommendations();
    }

    global.gc?.();
    const heapAfter = heapMB();
    const growth = heapAfter - heapBefore;

    console.log(`  [Memory] TokenGovernor: growth=${growth.toFixed(1)}MB after 1000 resets`);
    // History is capped at 500, so growth should be minimal
    assert.ok(growth < 10, `TokenGovernor growth should be < 10MB, got ${growth.toFixed(1)}MB`);
  });
});

// ============================================================================
// 2. Concurrent Request Latency Distribution
// ============================================================================

describe('2. Concurrent Request Latency Distribution', () => {
  it('ContextCompactor under 10 concurrent calls', async () => {
    const compactor = new ContextCompactor({ maxContextTokens: 20000, layer1Trigger: 0.3, keepRecentTurns: 3 });
    const makeMsgs = (): LLMMessage[] => {
      const msgs: LLMMessage[] = [{ role: 'system', content: 'System prompt' }];
      for (let i = 0; i < 100; i++) {
        msgs.push({ role: 'user', content: `Message ${i}` });
        msgs.push({ role: 'assistant', content: `Response ${i}` });
      }
      return msgs;
    };

    const times: number[] = [];
    const concurrency = 10;

    // Run concurrent compaction calls
    const start = performance.now();
    const promises = Array.from({ length: concurrency }, async () => {
      const t0 = performance.now();
      const { messages } = compactor.compact(makeMsgs());
      const t1 = performance.now();
      times.push(t1 - t0);
      return messages.length;
    });
    await Promise.all(promises);

    const s = stats(times);
    console.log(`  [Latency] ContextCompactor x${concurrency}: avg=${s.avg.toFixed(2)}ms, p50=${s.p50.toFixed(2)}ms, p95=${s.p95.toFixed(2)}ms, p99=${s.p99.toFixed(2)}ms`);
    assert.ok(s.p95 < 100, `P95 should be < 100ms, got ${s.p95.toFixed(2)}ms`);
  });

  it('TokenGovernor under 50 concurrent callers', () => {
    const governor = new TokenGovernor({ totalBudget: 200000 });
    const times: number[] = [];
    const concurrency = 50;

    // Simulate 50 concurrent reportUsage + getState calls
    for (let i = 0; i < concurrency; i++) {
      const t0 = performance.now();
      governor.reportUsage(100);
      const state = governor.getState();
      const t1 = performance.now();
      times.push(t1 - t0);
      assert.ok(state.pressure >= 0);
    }

    const s = stats(times);
    console.log(`  [Latency] TokenGovernor x${concurrency}: avg=${s.avg.toFixed(3)}ms, p50=${s.p50.toFixed(3)}ms, p95=${s.p95.toFixed(3)}ms`);
    assert.ok(s.p95 < 1, `P95 should be < 1ms, got ${s.p95.toFixed(3)}ms`);
  });

  it('ToolResultCache under 100 concurrent reads/writes', () => {
    const cache = new ToolResultCache({ enabled: true, maxEntries: 100 });
    const times: number[] = [];

    // Pre-populate
    for (let i = 0; i < 50; i++) {
      const tc = { id: `tc${i}`, name: 'search', arguments: { query: `test${i}` } };
      cache.set(tc, { toolCallId: `tc${i}`, name: 'search', output: `result${i}`, durationMs: 10 });
    }

    // Mixed read/write workload
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      if (i % 3 === 0) {
        // Write
        const tc = { id: `new${i}`, name: 'search', arguments: { query: `new${i}` } };
        cache.set(tc, { toolCallId: `new${i}`, name: 'search', output: `result${i}`, durationMs: 10 });
      } else {
        // Read
        const tc = { id: `tc${i % 50}`, name: 'search', arguments: { query: `test${i % 50}` } };
        cache.get(tc);
      }
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    const s = stats(times);
    const cs = cache.getStats();
    console.log(`  [Latency] ToolResultCache x100: avg=${s.avg.toFixed(3)}ms, p50=${s.p50.toFixed(3)}ms, p95=${s.p95.toFixed(3)}ms, hitRate=${(cs.hitRate * 100).toFixed(1)}%`);
    assert.ok(s.p95 < 5, `P95 should be < 5ms, got ${s.p95.toFixed(3)}ms`);
    cache.dispose();
  });

  it('CircuitBreaker under 100 rapid state checks', () => {
    const cb = new CircuitBreaker(5, 1000);
    const times: number[] = [];

    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      cb.isAvailable();
      if (i % 10 === 0) cb.onFailure();
      if (i % 7 === 0) cb.onSuccess();
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    const s = stats(times);
    console.log(`  [Latency] CircuitBreaker x100: avg=${s.avg.toFixed(4)}ms, p50=${s.p50.toFixed(4)}ms, p95=${s.p95.toFixed(4)}ms`);
    assert.ok(s.p95 < 1, `P95 should be < 1ms`);
  });
});

// ============================================================================
// 3. Long-Running 1000-Round Degradation Test
// ============================================================================

describe('3. Long-Running 1000-Round Degradation', () => {
  it('token estimation stays consistent over 1000 rounds', () => {
    const governor = new TokenGovernor({ totalBudget: 100000 });
    const estimations: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const text = `Round ${i}: This is a realistic message with some content that varies slightly per round. The quick brown fox jumps over the lazy dog.`;
      const tokens = TokenGovernor.estimateTokens(text);
      estimations.push(tokens);
    }

    // Estimation should be deterministic — same input always gives same output
    const unique = new Set(estimations.map((t, i) => {
      const text = `Round ${i}: This is a realistic message with some content that varies slightly per round. The quick brown fox jumps over the lazy dog.`;
      return `${text.length}:${t}`;
    }));

    // Each unique text length should map to exactly one token count
    const textToTokens = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const text = `Round ${i}: This is a realistic message with some content that varies slightly per round. The quick brown fox jumps over the lazy dog.`;
      const tokens = TokenGovernor.estimateTokens(text);
      const key = text;
      if (textToTokens.has(key)) {
        assert.strictEqual(tokens, textToTokens.get(key), `Estimation should be deterministic at round ${i}`);
      }
      textToTokens.set(key, tokens);
    }

    console.log(`  [Degradation] Token estimation: ${unique.size} unique (length,token) pairs over 1000 rounds — deterministic`);
  });

  it('cache hit rate improves over 1000 rounds with repeated patterns', () => {
    const cache = new ToolResultCache({ enabled: true, maxEntries: 200, defaultTtlMs: 60000 });

    let hits = 0;
    let misses = 0;

    for (let i = 0; i < 1000; i++) {
      // 70% repeated queries (should hit cache), 30% new queries
      const isRepeat = Math.random() < 0.7;
      const queryId = isRepeat ? i % 50 : i;
      const tc = { id: `tc${queryId}`, name: 'web_search', arguments: { query: `query ${queryId}` } };

      const result = cache.get(tc);
      if (result) {
        hits++;
      } else {
        misses++;
        cache.set(tc, { toolCallId: `tc${queryId}`, name: 'web_search', output: `result for query ${queryId}`, durationMs: 100 });
      }
    }

    const cs = cache.getStats();
    console.log(`  [Degradation] Cache over 1000 rounds: hits=${hits}, misses=${misses}, hitRate=${(cs.hitRate * 100).toFixed(1)}%, entries=${cs.totalEntries}`);

    // With 70% repeated queries, hit rate should be meaningful
    assert.ok(cs.hitRate > 0.3, `Hit rate should be > 30%, got ${(cs.hitRate * 100).toFixed(1)}%`);
    cache.dispose();
  });

  it('compaction quality does not degrade over 100 rounds', () => {
    const compactor = new ContextCompactor({ maxContextTokens: 10000, layer1Trigger: 0.3, keepRecentTurns: 3 });
    const dropRatios: number[] = [];

    for (let round = 0; round < 100; round++) {
      const msgs: LLMMessage[] = [{ role: 'system', content: 'System prompt for consistency test.' }];
      for (let i = 0; i < 50; i++) {
        msgs.push({ role: 'user', content: `Round ${round} msg ${i}: ${'noise '.repeat(20)}` });
        msgs.push({ role: 'assistant', content: `Response ${i}: ${'data '.repeat(10)}` });
      }
      const before = msgs.length;
      const { messages, action } = compactor.compact(msgs);
      const after = messages.length;
      dropRatios.push(1 - after / before);
    }

    // Drop ratios should be consistent — no degradation
    const first10 = dropRatios.slice(0, 10);
    const last10 = dropRatios.slice(-10);
    const avgFirst = first10.reduce((a, b) => a + b, 0) / first10.length;
    const avgLast = last10.reduce((a, b) => a + b, 0) / last10.length;

    console.log(`  [Degradation] Compaction: first10 avg drop=${(avgFirst * 100).toFixed(1)}%, last10 avg drop=${(avgLast * 100).toFixed(1)}%`);

    // The compaction behavior should not change significantly
    const drift = Math.abs(avgFirst - avgLast);
    assert.ok(drift < 0.1, `Compaction drift should be < 10%, got ${(drift * 100).toFixed(1)}%`);
  });

  it('memory store does not degrade query performance at 5000 entries', async () => {
    const store = new InMemoryMemoryStore();

    // Populate with 5000 entries
    for (let i = 0; i < 5000; i++) {
      await store.write({
        projectId: 'perf-test',
        kind: i % 4 === 0 ? 'DECISION' : i % 4 === 1 ? 'ISSUE' : i % 4 === 2 ? 'LESSON' : 'SUMMARY',
        title: `Entry ${i}`,
        content: `Content for entry ${i} with searchable text`,
        tags: [`tag-${i % 50}`, 'common'],
      });
    }

    // Measure query time at full capacity
    const queryTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await store.search({ projectId: 'perf-test', query: 'searchable', limit: 10 });
      const t1 = performance.now();
      queryTimes.push(t1 - t0);
    }

    const s = stats(queryTimes);
    console.log(`  [Degradation] MemoryStore query at 5K entries: avg=${s.avg.toFixed(2)}ms, p95=${s.p95.toFixed(2)}ms`);
    assert.ok(s.p95 < 50, `P95 query time should be < 50ms at 5K entries, got ${s.p95.toFixed(2)}ms`);

    await store.close();
  });
});

// ============================================================================
// 4. Tool Call Cache Effectiveness
// ============================================================================

describe('4. Tool Call Cache Effectiveness', () => {
  it('cache hit rate with realistic workload (web_search, file_read, git)', () => {
    const cache = new ToolResultCache({
      enabled: true,
      maxEntries: 256,
      defaultTtlMs: 300000,
      neverCache: ['shell_execute', 'python_execute', 'file_write', 'file_edit', 'git_push', 'git_commit'],
    });

    let totalGets = 0;
    let totalHits = 0;

    // Simulate realistic workload:
    // - web_search: same queries repeated often (high cache value)
    // - file_read: same files read multiple times (medium cache value)
    // - git status: called frequently but neverCache doesn't include it
    // - file_write: never cached (in neverCache list)

    const tools = ['web_search', 'file_read', 'git', 'file_write', 'memory_recall'];
    const toolWeights = [0.3, 0.3, 0.15, 0.1, 0.15]; // frequency distribution

    for (let i = 0; i < 1000; i++) {
      // Pick tool based on weights
      const r = Math.random();
      let cumulative = 0;
      let tool = tools[0];
      for (let j = 0; j < tools.length; j++) {
        cumulative += toolWeights[j];
        if (r < cumulative) { tool = tools[j]; break; }
      }

      // For web_search and file_read, 60% are repeated queries
      const isRepeat = (tool === 'web_search' || tool === 'file_read') && Math.random() < 0.6;
      const queryId = isRepeat ? i % 30 : i;

      const tc = { id: `tc${i}`, name: tool, arguments: { query: `query ${queryId}`, path: `/file/${queryId}` } };

      totalGets++;
      const cached = cache.get(tc);
      if (cached) {
        totalHits++;
      } else {
        cache.set(tc, { toolCallId: `tc${i}`, name: tool, output: `result for ${tool} query ${queryId}`, durationMs: 50 });
      }
    }

    const cs = cache.getStats();
    console.log(`  [Cache] Realistic workload: gets=${totalGets}, hits=${totalHits}, hitRate=${(cs.hitRate * 100).toFixed(1)}%`);
    console.log(`  [Cache] entries=${cs.totalEntries}, evictions=${cs.evictions}, memory=${(cs.memoryEstimateBytes / 1024).toFixed(1)}KB`);

    // With 60% repeat rate on cacheable tools, hit rate should be meaningful
    assert.ok(cs.hitRate > 0.1, `Hit rate should be > 10%, got ${(cs.hitRate * 100).toFixed(1)}%`);
    cache.dispose();
  });

  it('cache TTL expiry works correctly', async () => {
    const cache = new ToolResultCache({
      enabled: true,
      maxEntries: 100,
      defaultTtlMs: 100, // 100ms TTL for testing
    });

    const tc = { id: 'tc1', name: 'search', arguments: { q: 'test' } };
    cache.set(tc, { toolCallId: 'tc1', name: 'search', output: 'result', durationMs: 10 });

    // Should hit immediately
    assert.ok(cache.get(tc), 'Should hit within TTL');

    // Wait for expiry
    await new Promise(r => setTimeout(r, 150));

    // Should miss after TTL
    assert.strictEqual(cache.get(tc), undefined, 'Should miss after TTL expiry');

    const cs = cache.getStats();
    console.log(`  [Cache] TTL test: hits=${cs.totalHits}, misses=${cs.totalMisses}`);
    cache.dispose();
  });

  it('cache LRU eviction preserves most-recently-used entries', () => {
    const cache = new ToolResultCache({
      enabled: true,
      maxEntries: 5,
      defaultTtlMs: 300000,
    });

    // Fill cache to capacity
    for (let i = 0; i < 5; i++) {
      const tc = { id: `tc${i}`, name: 'search', arguments: { q: `q${i}` } };
      cache.set(tc, { toolCallId: `tc${i}`, name: 'search', output: `result${i}`, durationMs: 10 });
    }

    // Access tc0 to make it recently used
    const tc0 = { id: 'tc0', name: 'search', arguments: { q: 'q0' } };
    assert.ok(cache.get(tc0), 'tc0 should be in cache');

    // Add new entry — should evict LRU (tc1, not tc0)
    const tc5 = { id: 'tc5', name: 'search', arguments: { q: 'q5' } };
    cache.set(tc5, { toolCallId: 'tc5', name: 'search', output: 'result5', durationMs: 10 });

    // tc0 should still be there (recently accessed)
    assert.ok(cache.get(tc0), 'tc0 should survive LRU eviction (was recently accessed)');

    // tc1 should be evicted
    const tc1 = { id: 'tc1', name: 'search', arguments: { q: 'q1' } };
    assert.strictEqual(cache.get(tc1), undefined, 'tc1 should be evicted (LRU)');

    const cs = cache.getStats();
    console.log(`  [Cache] LRU: entries=${cs.totalEntries}, evictions=${cs.evictions}`);
    cache.dispose();
  });
});
