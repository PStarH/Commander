import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheManager, type CacheManagerConfig } from '../../src/runtime/cacheManager';
import * as tenantContext from '../../src/runtime/tenantContext';
import { SemanticCache } from '../../src/runtime/semanticCache';
import { SingleFlightRequestCache } from '../../src/runtime/singleFlightRequestCache';
import { GeminiCacheManager } from '../../src/runtime/geminiCacheManager';
import { ToolResultCache } from '../../src/runtime/toolResultCache';
import type { LLMRequest, LLMResponse, ToolDefinition } from '../../src/runtime/types';

// Prototype spies (not vi.mock constructor factories). Vitest 4 + setupFiles
// left constructor mocks unbound so CacheManager wired real managers and
// assertions on mock stats/shapes failed across CI.

describe('cacheManager', () => {
  let mockLookup: ReturnType<typeof vi.spyOn>;
  let mockStore: ReturnType<typeof vi.spyOn>;
  let mockSemanticStats: ReturnType<typeof vi.spyOn>;
  let mockDedupe: ReturnType<typeof vi.spyOn>;
  let mockSingleFlightStats: ReturnType<typeof vi.spyOn>;
  let mockInflightCount: ReturnType<typeof vi.spyOn>;
  let mockGetOrCreate: ReturnType<typeof vi.spyOn>;
  let mockGeminiStats: ReturnType<typeof vi.spyOn>;
  let mockToolDispose: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(tenantContext, 'getCurrentTenantId').mockReturnValue(undefined);
    vi.spyOn(tenantContext, 'isMultiTenantEnabled').mockReturnValue(false);

    mockLookup = vi.spyOn(SemanticCache.prototype, 'lookup').mockResolvedValue(null as never);
    mockStore = vi.spyOn(SemanticCache.prototype, 'store').mockReturnValue(undefined as never);
    mockSemanticStats = vi
      .spyOn(SemanticCache.prototype, 'getStats')
      .mockReturnValue({ hits: 0, misses: 0 } as never);
    mockDedupe = vi
      .spyOn(SingleFlightRequestCache.prototype, 'dedupe')
      .mockImplementation(async (_k: string, fn: () => Promise<unknown>) => fn() as never);
    mockSingleFlightStats = vi
      .spyOn(SingleFlightRequestCache.prototype, 'getStats')
      .mockReturnValue({ hits: 0, deduped: 0 } as never);
    mockInflightCount = vi
      .spyOn(SingleFlightRequestCache.prototype, 'inflightCount')
      .mockReturnValue(0);
    mockGetOrCreate = vi
      .spyOn(GeminiCacheManager.prototype, 'getOrCreate')
      .mockResolvedValue({ cachedContentName: 'name-1', createdNow: true } as never);
    mockGeminiStats = vi
      .spyOn(GeminiCacheManager.prototype, 'getStats')
      .mockReturnValue({ hits: 0, misses: 0 } as never);
    mockToolDispose = vi.spyOn(ToolResultCache.prototype, 'dispose').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('construction', () => {
    it('creates a CacheManager with default config', () => {
      const manager = new CacheManager();
      expect(manager.getToolCache()).toBeDefined();
      expect(manager.getSemanticCacheStats()).toEqual({ hits: 0, misses: 0 });
      expect(manager.getSingleFlightStats()).toEqual({ hits: 0, deduped: 0 });
      expect(manager.getGeminiCacheStats()).toEqual({ hits: 0, misses: 0 });
    });

    it('respects config flags', () => {
      const manager = new CacheManager({
        semanticCache: { enabled: true, similarityThreshold: 0.95 },
        singleFlight: { enabled: true, maxInFlight: 500 },
        geminiCache: { enabled: true, maxEntries: 50 },
        enableToolCaching: false,
      } as CacheManagerConfig);
      expect(manager.getToolCache()).toBeDefined();
      expect(manager.getSingleFlightInflightCount()).toBe(0);
    });

    it('disables semantic cache when configured', () => {
      const manager = new CacheManager({ semanticCache: { enabled: false } });
      expect(manager.getSemanticCacheStats()).toBeDefined();
    });
  });

  describe('semantic cache', () => {
    it('looks up a cached response', async () => {
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      const response = { content: 'cached' } as unknown as LLMResponse;
      mockLookup.mockResolvedValue(response as never);
      const result = await manager.lookupSemantic(request);
      expect(result).toBe(response);
      expect(mockLookup).toHaveBeenCalledWith(request, undefined);
    });

    it('stores a response', () => {
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      const response = { content: 'cached' } as unknown as LLMResponse;
      manager.storeSemantic(request, response);
      expect(mockStore).toHaveBeenCalledWith(request, response, undefined);
    });

    it('throws when lookup is called outside tenant context in multi-tenant mode', async () => {
      vi.spyOn(tenantContext, 'isMultiTenantEnabled').mockReturnValue(true);
      vi.spyOn(tenantContext, 'getCurrentTenantId').mockReturnValue(undefined);
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      await expect(manager.lookupSemantic(request)).rejects.toThrow('outside tenant context');
    });

    it('throws when store is called outside tenant context in multi-tenant mode', () => {
      vi.spyOn(tenantContext, 'isMultiTenantEnabled').mockReturnValue(true);
      vi.spyOn(tenantContext, 'getCurrentTenantId').mockReturnValue(undefined);
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      const response = { content: 'cached' } as unknown as LLMResponse;
      expect(() => manager.storeSemantic(request, response)).toThrow('outside tenant context');
    });

    it('passes tenant id to semantic cache when available', async () => {
      vi.spyOn(tenantContext, 'isMultiTenantEnabled').mockReturnValue(true);
      vi.spyOn(tenantContext, 'getCurrentTenantId').mockReturnValue('tenant-1');
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      await manager.lookupSemantic(request);
      expect(mockLookup).toHaveBeenCalledWith(request, 'tenant-1');
    });
  });

  describe('single flight cache', () => {
    it('deduplicates concurrent requests', async () => {
      const manager = new CacheManager();
      const response = { content: 'result' } as unknown as LLMResponse;
      mockDedupe.mockResolvedValue(response as never);
      const factory = vi.fn().mockResolvedValue(response);
      const result = await manager.dedupeSingleFlight('key-1', factory, 'tenant-1');
      expect(result).toBe(response);
      expect(mockDedupe).toHaveBeenCalledWith('key-1', factory, 'tenant-1');
    });

    it('exposes single flight stats', () => {
      const manager = new CacheManager();
      mockSingleFlightStats.mockReturnValue({ hits: 5, deduped: 3 } as never);
      expect(manager.getSingleFlightStats()).toEqual({ hits: 5, deduped: 3 });
    });

    it('exposes single flight inflight count', () => {
      const manager = new CacheManager();
      mockInflightCount.mockReturnValue(7);
      expect(manager.getSingleFlightInflightCount()).toBe(7);
    });
  });

  describe('gemini cache', () => {
    it('gets or creates cached content', async () => {
      const manager = new CacheManager();
      mockGetOrCreate.mockResolvedValue({ cachedContentName: 'name-1', createdNow: true } as never);
      const params = {
        systemInstruction: 'sys',
        tools: [] as ToolDefinition[],
        model: 'gemini-1.5',
        apiKey: 'key',
        tenantId: 'tenant-1',
      };
      const result = await manager.getGeminiCachedContent(params);
      expect(result).toEqual({ cachedContentName: 'name-1', createdNow: true });
      expect(mockGetOrCreate).toHaveBeenCalledWith(params);
    });

    it('exposes gemini cache stats', () => {
      const manager = new CacheManager();
      mockGeminiStats.mockReturnValue({ hits: 2, misses: 1 } as never);
      expect(manager.getGeminiCacheStats()).toEqual({ hits: 2, misses: 1 });
    });
  });

  describe('tool cache', () => {
    it('returns the tool cache instance', () => {
      const manager = new CacheManager();
      expect(manager.getToolCache()).toBeDefined();
    });
  });

  describe('dispose', () => {
    it('disposes tool cache resources', () => {
      const manager = new CacheManager();
      manager.dispose();
      expect(mockToolDispose).toHaveBeenCalled();
    });
  });
});
