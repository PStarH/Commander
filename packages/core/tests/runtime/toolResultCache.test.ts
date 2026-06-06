import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolResultCache } from '../../src/runtime/toolResultCache';
import type { ToolCacheStats } from '../../src/runtime/toolResultCache';
import type { ToolCall, ToolResult } from '../../src/runtime/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call_${name}`, name, arguments: args };
}

function makeResult(output: string, error?: string): ToolResult {
  return { toolCallId: 'call_x', name: 'x', output, durationMs: 10, ...(error ? { error } : {}) };
}

function makeCache(config: Record<string, unknown> = {}) {
  return new ToolResultCache({ enabled: true, ...config });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolResultCache', () => {
  let cache: ToolResultCache;

  afterEach(() => {
    cache?.dispose();
  });

  // =========================================================================
  // 1. Basic hit / miss
  // =========================================================================

  describe('basic hit/miss', () => {
    it('returns undefined on miss when enabled', () => {
      cache = makeCache();
      const result = cache.get(makeToolCall('search', { q: 'hello' }));
      expect(result).toBeUndefined();
    });

    it('returns cached result on hit', () => {
      cache = makeCache();
      const call = makeToolCall('search', { q: 'hello' });
      const res = makeResult('found 3 results');
      cache.set(call, res);
      const hit = cache.get(call);
      expect(hit).toBeDefined();
      expect(hit!.output).toBe('found 3 results');
    });

    it('returns undefined when caching is disabled', () => {
      cache = new ToolResultCache({ enabled: false });
      const call = makeToolCall('search', { q: 'test' });
      cache.set(call, makeResult('data'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('returns a copy, not a reference, to prevent corruption', () => {
      cache = makeCache();
      const call = makeToolCall('read', { path: '/tmp' });
      cache.set(call, makeResult('original'));
      const hit1 = cache.get(call);
      hit1!.output = 'mutated';
      const hit2 = cache.get(call);
      expect(hit2!.output).toBe('original');
    });
  });

  // =========================================================================
  // 2. TTL expiry
  // =========================================================================

  describe('TTL expiry', () => {
    it('returns undefined after TTL expires', () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 1000 });
      const call = makeToolCall('fetch', { url: 'a' });
      cache.set(call, makeResult('data'));

      expect(cache.get(call)).toBeDefined();

      vi.advanceTimersByTime(1001);
      expect(cache.get(call)).toBeUndefined();
      vi.useRealTimers();
    });

    it('respects per-tool TTL overrides', () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 10000, toolTtls: { fast_tool: 500 } });
      const call = makeToolCall('fast_tool', {});
      cache.set(call, makeResult('quick'));

      vi.advanceTimersByTime(501);
      expect(cache.get(call)).toBeUndefined();
      vi.useRealTimers();
    });

    it('counts expired entries as misses in stats', () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 100 });
      const call = makeToolCall('t', {});
      cache.set(call, makeResult('v'));
      vi.advanceTimersByTime(101);
      cache.get(call);
      const stats = cache.getStats();
      expect(stats.totalMisses).toBe(1);
      expect(stats.totalHits).toBe(0);
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 3. neverCache tools
  // =========================================================================

  describe('neverCache', () => {
    it('does not cache tools in the neverCache list', () => {
      cache = makeCache();
      const call = makeToolCall('shell_execute', { cmd: 'ls' });
      cache.set(call, makeResult('file1\nfile2'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('does not cache all default neverCache tools', () => {
      cache = makeCache();
      const blocked = ['shell_execute', 'python_execute', 'file_write', 'file_edit',
        'git_push', 'git_commit', 'agent', 'memory_store'];
      for (const name of blocked) {
        const call = makeToolCall(name, {});
        cache.set(call, makeResult('ok'));
        expect(cache.get(call), `expected ${name} to be blocked`).toBeUndefined();
      }
    });

    it('supports wildcard prefix patterns in neverCache', () => {
      cache = makeCache({ neverCache: ['danger_*'] });
      const call = makeToolCall('danger_exec', {});
      cache.set(call, makeResult('boom'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('get returns undefined for neverCache tools even if somehow stored', () => {
      cache = makeCache();
      const call = makeToolCall('file_write', { path: '/tmp' });
      // set is also blocked, but get should independently block
      expect(cache.get(call)).toBeUndefined();
    });
  });

  // =========================================================================
  // 4. Error results are not cached
  // =========================================================================

  describe('error results', () => {
    it('does not cache results with errors', () => {
      cache = makeCache();
      const call = makeToolCall('api_call', {});
      cache.set(call, makeResult('', 'timeout'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('caches results with output and no error', () => {
      cache = makeCache();
      const call = makeToolCall('api_call', {});
      cache.set(call, makeResult('success'));
      expect(cache.get(call)).toBeDefined();
    });
  });

  // =========================================================================
  // 5. LRU eviction
  // =========================================================================

  describe('LRU eviction', () => {
    it('evicts least recently used entry when at capacity', () => {
      cache = makeCache({ maxEntries: 2 });

      const call1 = makeToolCall('a', { x: 1 });
      const call2 = makeToolCall('b', { x: 2 });
      const call3 = makeToolCall('c', { x: 3 });

      cache.set(call1, makeResult('r1'));
      cache.set(call2, makeResult('r2'));

      // Access call1 to make it more recent
      cache.get(call1);

      // Insert call3, should evict call2 (least recently used)
      cache.set(call3, makeResult('r3'));

      expect(cache.get(call1)).toBeDefined();
      expect(cache.get(call2)).toBeUndefined();
      expect(cache.get(call3)).toBeDefined();
    });

    it('increments eviction count in stats', () => {
      cache = makeCache({ maxEntries: 1 });
      cache.set(makeToolCall('a', {}), makeResult('r1'));
      cache.set(makeToolCall('b', {}), makeResult('r2'));
      expect(cache.getStats().evictions).toBe(1);
    });
  });

  // =========================================================================
  // 6. Key determinism
  // =========================================================================

  describe('key determinism', () => {
    it('produces the same key for identical inputs', () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'hello', limit: 10 });
      const k2 = ToolResultCache.computeKey('search', { q: 'hello', limit: 10 });
      expect(k1).toBe(k2);
    });

    it('produces different keys for different arguments', () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'hello' });
      const k2 = ToolResultCache.computeKey('search', { q: 'world' });
      expect(k1).not.toBe(k2);
    });

    it('produces different keys for different tool names', () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'x' });
      const k2 = ToolResultCache.computeKey('fetch', { q: 'x' });
      expect(k1).not.toBe(k2);
    });

    it('sorts top-level keys for deterministic canonicalization', () => {
      const k1 = ToolResultCache.computeKey('t', { b: 2, a: 1 });
      const k2 = ToolResultCache.computeKey('t', { a: 1, b: 2 });
      expect(k1).toBe(k2);
    });

    it('includes tenantId in key when provided', () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'x' }, 'tenant-a');
      const k2 = ToolResultCache.computeKey('search', { q: 'x' }, 'tenant-b');
      expect(k1).not.toBe(k2);
    });

    it('produces different keys with vs without tenantId', () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'x' });
      const k2 = ToolResultCache.computeKey('search', { q: 'x' }, 'tenant-a');
      expect(k1).not.toBe(k2);
    });
  });

  // =========================================================================
  // 7. Invalidation
  // =========================================================================

  describe('invalidation', () => {
    it('invalidateTool removes all entries for a tool', () => {
      cache = makeCache();
      cache.set(makeToolCall('search', { q: 'a' }), makeResult('r1'));
      cache.set(makeToolCall('search', { q: 'b' }), makeResult('r2'));
      cache.set(makeToolCall('fetch', {}), makeResult('r3'));

      const removed = cache.invalidateTool('search');
      expect(removed).toBe(2);
      expect(cache.get(makeToolCall('search', { q: 'a' }))).toBeUndefined();
      expect(cache.get(makeToolCall('search', { q: 'b' }))).toBeUndefined();
      expect(cache.get(makeToolCall('fetch', {}))).toBeDefined();
    });

    it('invalidatePattern with exact name matches', () => {
      cache = makeCache();
      cache.set(makeToolCall('file_read', {}), makeResult('r'));
      cache.set(makeToolCall('file_write', {}), makeResult('r'));
      cache.set(makeToolCall('git_push', {}), makeResult('r'));

      const removed = cache.invalidatePattern('file_read');
      expect(removed).toBe(1);
    });

    it('invalidatePattern with wildcard prefix', () => {
      cache = makeCache({ neverCache: [] });
      cache.set(makeToolCall('file_read', {}), makeResult('r'));
      cache.set(makeToolCall('file_write', {}), makeResult('r'));
      cache.set(makeToolCall('git_push', {}), makeResult('r'));

      const removed = cache.invalidatePattern('file_*');
      expect(removed).toBe(2);
      expect(cache.get(makeToolCall('git_push', {}))).toBeDefined();
    });

    it('clear removes all entries', () => {
      cache = makeCache();
      cache.set(makeToolCall('a', {}), makeResult('1'));
      cache.set(makeToolCall('b', {}), makeResult('2'));
      cache.clear();
      expect(cache.getStats().totalEntries).toBe(0);
    });
  });

  // =========================================================================
  // 8. Statistics
  // =========================================================================

  describe('statistics', () => {
    it('tracks hits and misses correctly', () => {
      cache = makeCache();
      const call = makeToolCall('x', {});
      cache.set(call, makeResult('v'));

      cache.get(call); // hit
      cache.get(call); // hit
      cache.get(makeToolCall('y', {})); // miss

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(2);
      expect(stats.totalMisses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('returns zero hit rate when no accesses', () => {
      cache = makeCache();
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('tracks total entries', () => {
      cache = makeCache();
      cache.set(makeToolCall('a', {}), makeResult('1'));
      cache.set(makeToolCall('b', {}), makeResult('2'));
      expect(cache.getStats().totalEntries).toBe(2);
    });

    it('updates memoryEstimateBytes on set and delete', () => {
      cache = makeCache();
      const before = cache.getStats().memoryEstimateBytes;
      cache.set(makeToolCall('a', {}), makeResult('hello world'));
      const after = cache.getStats().memoryEstimateBytes;
      expect(after).toBeGreaterThan(before);

      cache.invalidateTool('a');
      expect(cache.getStats().memoryEstimateBytes).toBe(before);
    });
  });

  // =========================================================================
  // 9. Prune
  // =========================================================================

  describe('prune', () => {
    it('removes expired entries and returns count', () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 1000 });
      cache.set(makeToolCall('a', {}), makeResult('1'));
      cache.set(makeToolCall('b', {}), makeResult('2'));

      vi.advanceTimersByTime(1001);
      const pruned = cache.prune();
      expect(pruned).toBe(2);
      expect(cache.getStats().totalEntries).toBe(0);
      vi.useRealTimers();
    });

    it('does not remove unexpired entries', () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 5000 });
      cache.set(makeToolCall('a', {}), makeResult('1'));

      vi.advanceTimersByTime(1000);
      const pruned = cache.prune();
      expect(pruned).toBe(0);
      expect(cache.getStats().totalEntries).toBe(1);
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 10. Tenant isolation
  // =========================================================================

  describe('tenant isolation', () => {
    it('isolates cache entries by tenantId', () => {
      cache = makeCache();
      const call = makeToolCall('search', { q: 'x' });
      cache.set(call, makeResult('tenant-a-data'), 'tenant-a');
      cache.set(call, makeResult('tenant-b-data'), 'tenant-b');

      expect(cache.get(call, 'tenant-a')!.output).toBe('tenant-a-data');
      expect(cache.get(call, 'tenant-b')!.output).toBe('tenant-b-data');
    });

    it('tenant-scoped miss does not affect other tenants', () => {
      cache = makeCache();
      const call = makeToolCall('s', { q: '1' });
      cache.set(call, makeResult('data'), 't1');

      expect(cache.get(call, 't2')).toBeUndefined();
      expect(cache.get(call, 't1')).toBeDefined();
    });
  });

  // =========================================================================
  // 11. dispose
  // =========================================================================

  describe('dispose', () => {
    it('dispose clears the prune timer without error', () => {
      cache = new ToolResultCache({ enabled: true });
      expect(() => cache.dispose()).not.toThrow();
    });

    it('dispose is idempotent', () => {
      cache = new ToolResultCache({ enabled: true });
      cache.dispose();
      expect(() => cache.dispose()).not.toThrow();
    });
  });
});
