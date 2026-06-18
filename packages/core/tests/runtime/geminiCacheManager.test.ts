import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiCacheManager } from '../../src/runtime/geminiCacheManager';
import type { ToolDefinition } from '../../src/runtime/types';

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
  };
}

describe('GeminiCacheManager', () => {
  let manager: GeminiCacheManager;
  const originalFetch = global.fetch;

  beforeEach(() => {
    manager = new GeminiCacheManager({ enabled: true, maxEntries: 5, defaultTtlSeconds: 300 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchOk(name: string) {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ name }),
    })) as unknown as typeof fetch;
  }

  function mockFetchError(status: number) {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status,
      text: async () => `error ${status}`,
      json: async () => ({}),
    })) as unknown as typeof fetch;
  }

  it('returns empty lookup when disabled', async () => {
    const disabled = new GeminiCacheManager({ enabled: false });
    const result = await disabled.getOrCreate({
      systemInstruction: 'sys',
      tools: undefined,
      model: 'gemini-2.0-flash',
      apiKey: 'test-key',
    });
    expect(result.cachedContentName).toBeUndefined();
    expect(result.createdNow).toBe(false);
  });

  it('creates a cached content on first call', async () => {
    mockFetchOk('cachedContents/abc123');
    const result = await manager.getOrCreate({
      systemInstruction: 'You are a helpful assistant',
      tools: [makeTool('search')],
      model: 'gemini-2.0-flash',
      apiKey: 'test-key',
    });
    expect(result.cachedContentName).toBe('cachedContents/abc123');
    expect(result.createdNow).toBe(true);
    expect(result.contentHash).toBeTruthy();
    expect(manager.getStats().totalCreates).toBe(1);
    expect(manager.getStats().totalHits).toBe(0);
  });

  it('returns a hit on second call with same content', async () => {
    mockFetchOk('cachedContents/abc123');
    const params = {
      systemInstruction: 'You are a helpful assistant',
      tools: [makeTool('search')],
      model: 'gemini-2.0-flash',
      apiKey: 'test-key',
    };
    const first = await manager.getOrCreate(params);
    expect(first.createdNow).toBe(true);

    const second = await manager.getOrCreate(params);
    expect(second.cachedContentName).toBe(first.cachedContentName);
    expect(second.createdNow).toBe(false);
    expect(manager.getStats().totalCreates).toBe(1);
    expect(manager.getStats().totalHits).toBe(1);
  });

  it('isolates cache by tenantId', async () => {
    mockFetchOk('cachedContents/tenantA');
    const a = await manager.getOrCreate({
      systemInstruction: 'sys',
      tools: undefined,
      model: 'gemini-2.0-flash',
      apiKey: 'k',
      tenantId: 'tenant-a',
    });
    expect(a.cachedContentName).toBe('cachedContents/tenantA');

    mockFetchOk('cachedContents/tenantB');
    const b = await manager.getOrCreate({
      systemInstruction: 'sys',
      tools: undefined,
      model: 'gemini-2.0-flash',
      apiKey: 'k',
      tenantId: 'tenant-b',
    });
    expect(b.cachedContentName).toBe('cachedContents/tenantB');
    expect(manager.getStats().totalCreates).toBe(2);
  });

  it('produces stable content hash regardless of tool key order', async () => {
    const toolA = makeTool('a');
    const toolB = makeTool('b');
    const h1 = GeminiCacheManager.computeContentHash('sys', [toolA, toolB], 'gemini-2.0-flash');
    const h2 = GeminiCacheManager.computeContentHash('sys', [toolB, toolA], 'gemini-2.0-flash');
    expect(h1).toBe(h2);
  });

  it('produces different hash for different system prompts', () => {
    const h1 = GeminiCacheManager.computeContentHash('system A', undefined, 'gemini-2.0-flash');
    const h2 = GeminiCacheManager.computeContentHash('system B', undefined, 'gemini-2.0-flash');
    expect(h1).not.toBe(h2);
  });

  it('single-flight: concurrent calls for same key share one POST', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      // Slight delay to ensure both calls hit the in-flight path
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ name: 'cachedContents/shared' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const params = {
      systemInstruction: 'sys',
      tools: undefined,
      model: 'gemini-2.0-flash',
      apiKey: 'k',
    };
    const [r1, r2, r3] = await Promise.all([
      manager.getOrCreate(params),
      manager.getOrCreate(params),
      manager.getOrCreate(params),
    ]);
    expect(callCount).toBe(1);
    expect(r1.cachedContentName).toBe('cachedContents/shared');
    expect(r2.cachedContentName).toBe('cachedContents/shared');
    expect(r3.cachedContentName).toBe('cachedContents/shared');
    expect(manager.getStats().totalCreates).toBe(1);
    expect(manager.getStats().totalHits).toBe(2); // r2 and r3 are waiters
  });

  it('does not cache failures: next call retries the create', async () => {
    mockFetchError(500);
    await expect(
      manager.getOrCreate({
        systemInstruction: 'sys',
        tools: undefined,
        model: 'gemini-2.0-flash',
        apiKey: 'k',
      }),
    ).rejects.toThrow();
    expect(manager.getStats().totalErrors).toBe(1);

    mockFetchOk('cachedContents/recovered');
    const second = await manager.getOrCreate({
      systemInstruction: 'sys',
      tools: undefined,
      model: 'gemini-2.0-flash',
      apiKey: 'k',
    });
    expect(second.cachedContentName).toBe('cachedContents/recovered');
    expect(manager.getStats().totalCreates).toBe(1);
  });

  it('evicts the oldest LRU entry when maxEntries is exceeded', async () => {
    const small = new GeminiCacheManager({ enabled: true, maxEntries: 2 });

    mockFetchOk('cachedContents/1');
    await small.getOrCreate({
      systemInstruction: 'sys1',
      tools: undefined,
      model: 'm',
      apiKey: 'k',
    });

    mockFetchOk('cachedContents/2');
    await small.getOrCreate({
      systemInstruction: 'sys2',
      tools: undefined,
      model: 'm',
      apiKey: 'k',
    });

    mockFetchOk('cachedContents/3');
    await small.getOrCreate({
      systemInstruction: 'sys3',
      tools: undefined,
      model: 'm',
      apiKey: 'k',
    });

    expect(small.getStats().totalEntries).toBe(2);
    expect(small.getStats().totalEvictions).toBe(1);
  });

  it('evicts by server-side name', async () => {
    mockFetchOk('cachedContents/abc');
    await manager.getOrCreate({
      systemInstruction: 'sys',
      tools: undefined,
      model: 'm',
      apiKey: 'k',
    });
    expect(manager.getStats().totalEntries).toBe(1);

    const evicted = manager.evictByName('cachedContents/abc');
    expect(evicted).toBe(true);
    expect(manager.getStats().totalEntries).toBe(0);
    expect(manager.getStats().totalEvictions).toBe(1);
  });

  it('reset clears all state', async () => {
    mockFetchOk('cachedContents/abc');
    await manager.getOrCreate({
      systemInstruction: 'sys',
      tools: undefined,
      model: 'm',
      apiKey: 'k',
    });
    expect(manager.getStats().totalEntries).toBe(1);

    manager.reset();
    expect(manager.getStats().totalEntries).toBe(0);
    expect(manager.getStats().totalCreates).toBe(0);
  });

  it('hitRate is computed correctly', async () => {
    mockFetchOk('cachedContents/abc');
    const params = { systemInstruction: 'sys', tools: undefined, model: 'm', apiKey: 'k' };
    await manager.getOrCreate(params);
    await manager.getOrCreate(params);
    await manager.getOrCreate(params);
    // 1 create + 2 hits = 3 total → hitRate = 2/3
    expect(manager.getStats().hitRate).toBeCloseTo(2 / 3, 2);
  });
});
