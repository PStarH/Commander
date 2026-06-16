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

describe('ToolResultCache', async () => {
  let cache: ToolResultCache;

  afterEach(() => {
    cache?.dispose();
  });

  // =========================================================================
  // 1. Basic hit / miss
  // =========================================================================

  describe('basic hit/miss', async () => {
    it('returns undefined on miss when enabled', async () => {
      cache = makeCache();
      const result = cache.get(makeToolCall('search', { q: 'hello' }));
      expect(result).toBeUndefined();
    });

    it('returns cached result on hit', async () => {
      cache = makeCache();
      const call = makeToolCall('search', { q: 'hello' });
      const res = makeResult('found 3 results');
      await cache.set(call, res);
      const hit = cache.get(call);
      expect(hit).toBeDefined();
      expect(hit!.output).toBe('found 3 results');
    });

    it('returns undefined when caching is disabled', async () => {
      cache = new ToolResultCache({ enabled: false });
      const call = makeToolCall('search', { q: 'test' });
      await cache.set(call, makeResult('data'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('returns a copy, not a reference, to prevent corruption', async () => {
      cache = makeCache();
      const call = makeToolCall('read', { path: '/tmp' });
      await cache.set(call, makeResult('original'));
      const hit1 = cache.get(call);
      hit1!.output = 'mutated';
      const hit2 = cache.get(call);
      expect(hit2!.output).toBe('original');
    });
  });

  // =========================================================================
  // 2. TTL expiry
  // =========================================================================

  describe('TTL expiry', async () => {
    it('returns undefined after TTL expires', async () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 1000 });
      const call = makeToolCall('fetch', { url: 'a' });
      await cache.set(call, makeResult('data'));

      expect(cache.get(call)).toBeDefined();

      vi.advanceTimersByTime(1001);
      expect(cache.get(call)).toBeUndefined();
      vi.useRealTimers();
    });

    it('respects per-tool TTL overrides', async () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 10000, toolTtls: { fast_tool: 500 } });
      const call = makeToolCall('fast_tool', {});
      await cache.set(call, makeResult('quick'));

      vi.advanceTimersByTime(501);
      expect(cache.get(call)).toBeUndefined();
      vi.useRealTimers();
    });

    it('counts expired entries as misses in stats', async () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 100 });
      const call = makeToolCall('t', {});
      await cache.set(call, makeResult('v'));
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

  describe('neverCache', async () => {
    it('does not cache tools in the neverCache list', async () => {
      cache = makeCache();
      const call = makeToolCall('shell_execute', { cmd: 'ls' });
      await cache.set(call, makeResult('file1\nfile2'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('does not cache all default neverCache tools', async () => {
      cache = makeCache();
      const blocked = ['shell_execute', 'python_execute', 'file_write', 'file_edit',
        'git_push', 'git_commit', 'agent', 'memory_store'];
      for (const name of blocked) {
        const call = makeToolCall(name, {});
        await cache.set(call, makeResult('ok'));
        expect(cache.get(call), `expected ${name} to be blocked`).toBeUndefined();
      }
    });

    it('supports wildcard prefix patterns in neverCache', async () => {
      cache = makeCache({ neverCache: ['danger_*'] });
      const call = makeToolCall('danger_exec', {});
      await cache.set(call, makeResult('boom'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('get returns undefined for neverCache tools even if somehow stored', async () => {
      cache = makeCache();
      const call = makeToolCall('file_write', { path: '/tmp' });
      // set is also blocked, but get should independently block
      expect(cache.get(call)).toBeUndefined();
    });
  });

  // =========================================================================
  // 4. Error results are not cached
  // =========================================================================

  describe('error results', async () => {
    it('does not cache results with errors', async () => {
      cache = makeCache();
      const call = makeToolCall('api_call', {});
      await cache.set(call, makeResult('', 'timeout'));
      expect(cache.get(call)).toBeUndefined();
    });

    it('caches results with output and no error', async () => {
      cache = makeCache();
      const call = makeToolCall('api_call', {});
      await cache.set(call, makeResult('success'));
      expect(cache.get(call)).toBeDefined();
    });
  });

  // =========================================================================
  // 5. LRU eviction
  // =========================================================================

  describe('LRU eviction', async () => {
    it('evicts least recently used entry when at capacity', async () => {
      cache = makeCache({ maxEntries: 2 });

      const call1 = makeToolCall('a', { x: 1 });
      const call2 = makeToolCall('b', { x: 2 });
      const call3 = makeToolCall('c', { x: 3 });

      await cache.set(call1, makeResult('r1'));
      await cache.set(call2, makeResult('r2'));

      // Access call1 to make it more recent
      cache.get(call1);

      // Insert call3, should evict call2 (least recently used)
      await cache.set(call3, makeResult('r3'));

      expect(cache.get(call1)).toBeDefined();
      expect(cache.get(call2)).toBeUndefined();
      expect(cache.get(call3)).toBeDefined();
    });

    it('increments eviction count in stats', async () => {
      cache = makeCache({ maxEntries: 1 });
      await cache.set(makeToolCall('a', {}), makeResult('r1'));
      await cache.set(makeToolCall('b', {}), makeResult('r2'));
      expect(cache.getStats().evictions).toBe(1);
    });
  });

  // =========================================================================
  // 6. Key determinism
  // =========================================================================

  describe('key determinism', async () => {
    it('produces the same key for identical inputs', async () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'hello', limit: 10 });
      const k2 = ToolResultCache.computeKey('search', { q: 'hello', limit: 10 });
      expect(k1).toBe(k2);
    });

    it('produces different keys for different arguments', async () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'hello' });
      const k2 = ToolResultCache.computeKey('search', { q: 'world' });
      expect(k1).not.toBe(k2);
    });

    it('produces different keys for different tool names', async () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'x' });
      const k2 = ToolResultCache.computeKey('fetch', { q: 'x' });
      expect(k1).not.toBe(k2);
    });

    it('sorts top-level keys for deterministic canonicalization', async () => {
      const k1 = ToolResultCache.computeKey('t', { b: 2, a: 1 });
      const k2 = ToolResultCache.computeKey('t', { a: 1, b: 2 });
      expect(k1).toBe(k2);
    });

    it('includes tenantId in key when provided', async () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'x' }, 'tenant-a');
      const k2 = ToolResultCache.computeKey('search', { q: 'x' }, 'tenant-b');
      expect(k1).not.toBe(k2);
    });

    it('produces different keys with vs without tenantId', async () => {
      const k1 = ToolResultCache.computeKey('search', { q: 'x' });
      const k2 = ToolResultCache.computeKey('search', { q: 'x' }, 'tenant-a');
      expect(k1).not.toBe(k2);
    });
  });

  // =========================================================================
  // 7. Invalidation
  // =========================================================================

  describe('invalidation', async () => {
    it('invalidateTool removes all entries for a tool', async () => {
      cache = makeCache();
      await cache.set(makeToolCall('search', { q: 'a' }), makeResult('r1'));
      await cache.set(makeToolCall('search', { q: 'b' }), makeResult('r2'));
      await cache.set(makeToolCall('fetch', {}), makeResult('r3'));

      const removed = cache.invalidateTool('search');
      expect(removed).toBe(2);
      expect(cache.get(makeToolCall('search', { q: 'a' }))).toBeUndefined();
      expect(cache.get(makeToolCall('search', { q: 'b' }))).toBeUndefined();
      expect(cache.get(makeToolCall('fetch', {}))).toBeDefined();
    });

    it('invalidatePattern with exact name matches', async () => {
      cache = makeCache();
      await cache.set(makeToolCall('file_read', {}), makeResult('r'));
      await cache.set(makeToolCall('file_write', {}), makeResult('r'));
      await cache.set(makeToolCall('git_push', {}), makeResult('r'));

      const removed = cache.invalidatePattern('file_read');
      expect(removed).toBe(1);
    });

    it('invalidatePattern with wildcard prefix', async () => {
      cache = makeCache({ neverCache: [] });
      await cache.set(makeToolCall('file_read', {}), makeResult('r'));
      await cache.set(makeToolCall('file_write', {}), makeResult('r'));
      await cache.set(makeToolCall('git_push', {}), makeResult('r'));

      const removed = cache.invalidatePattern('file_*');
      expect(removed).toBe(2);
      expect(cache.get(makeToolCall('git_push', {}))).toBeDefined();
    });

    it('clear removes all entries', async () => {
      cache = makeCache();
      await cache.set(makeToolCall('a', {}), makeResult('1'));
      await cache.set(makeToolCall('b', {}), makeResult('2'));
      cache.clear();
      expect(cache.getStats().totalEntries).toBe(0);
    });
  });

  // =========================================================================
  // 8. Statistics
  // =========================================================================

  describe('statistics', async () => {
    it('tracks hits and misses correctly', async () => {
      cache = makeCache();
      const call = makeToolCall('x', {});
      await cache.set(call, makeResult('v'));

      cache.get(call); // hit
      cache.get(call); // hit
      cache.get(makeToolCall('y', {})); // miss

      const stats = cache.getStats();
      expect(stats.totalHits).toBe(2);
      expect(stats.totalMisses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('returns zero hit rate when no accesses', async () => {
      cache = makeCache();
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });

    it('tracks total entries', async () => {
      cache = makeCache();
      await cache.set(makeToolCall('a', {}), makeResult('1'));
      await cache.set(makeToolCall('b', {}), makeResult('2'));
      expect(cache.getStats().totalEntries).toBe(2);
    });

    it('updates memoryEstimateBytes on set and delete', async () => {
      cache = makeCache();
      const before = cache.getStats().memoryEstimateBytes;
      await cache.set(makeToolCall('a', {}), makeResult('hello world'));
      const after = cache.getStats().memoryEstimateBytes;
      expect(after).toBeGreaterThan(before);

      cache.invalidateTool('a');
      expect(cache.getStats().memoryEstimateBytes).toBe(before);
    });
  });

  // =========================================================================
  // 9. Prune
  // =========================================================================

  describe('prune', async () => {
    it('removes expired entries and returns count', async () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 1000 });
      await cache.set(makeToolCall('a', {}), makeResult('1'));
      await cache.set(makeToolCall('b', {}), makeResult('2'));

      vi.advanceTimersByTime(1001);
      const pruned = cache.prune();
      expect(pruned).toBe(2);
      expect(cache.getStats().totalEntries).toBe(0);
      vi.useRealTimers();
    });

    it('does not remove unexpired entries', async () => {
      vi.useFakeTimers();
      cache = makeCache({ defaultTtlMs: 5000 });
      await cache.set(makeToolCall('a', {}), makeResult('1'));

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

  describe('tenant isolation', async () => {
    it('isolates cache entries by tenantId', async () => {
      cache = makeCache();
      const call = makeToolCall('search', { q: 'x' });
      await cache.set(call, makeResult('tenant-a-data'), 'tenant-a');
      await cache.set(call, makeResult('tenant-b-data'), 'tenant-b');

      expect(cache.get(call, 'tenant-a')!.output).toBe('tenant-a-data');
      expect(cache.get(call, 'tenant-b')!.output).toBe('tenant-b-data');
    });

    it('tenant-scoped miss does not affect other tenants', async () => {
      cache = makeCache();
      const call = makeToolCall('s', { q: '1' });
      await cache.set(call, makeResult('data'), 't1');

      expect(cache.get(call, 't2')).toBeUndefined();
      expect(cache.get(call, 't1')).toBeDefined();
    });
  });

  // =========================================================================
  // 11. dispose
  // =========================================================================

  describe('dispose', async () => {
    it('dispose clears the prune timer without error', async () => {
      cache = new ToolResultCache({ enabled: true });
      expect(() => cache.dispose()).not.toThrow();
    });

    it('dispose is idempotent', async () => {
      cache = new ToolResultCache({ enabled: true });
      cache.dispose();
      expect(() => cache.dispose()).not.toThrow();
    });
  });
});
