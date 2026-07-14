import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CacheManager, type CacheManagerConfig } from '../../src/runtime/cacheManager';
import * as tenantContext from '../../src/runtime/tenantContext';
import type { LLMRequest, LLMResponse, ToolDefinition } from '../../src/runtime/types';

const mockLookup = vi.fn();
const mockStore = vi.fn();
const mockSemanticStats = vi.fn().mockReturnValue({ hits: 0, misses: 0 });
const mockDedupe = vi.fn();
const mockSingleFlightStats = vi.fn().mockReturnValue({ hits: 0, deduped: 0 });
const mockInflightCount = vi.fn().mockReturnValue(0);
const mockGetOrCreate = vi.fn();
const mockGeminiStats = vi.fn().mockReturnValue({ hits: 0, misses: 0 });
const mockToolDispose = vi.fn();

vi.mock('../../src/runtime/semanticCache', () => ({
  SemanticCache: vi.fn().mockImplementation(function () {
    return {
      lookup: mockLookup,
      store: mockStore,
      getStats: mockSemanticStats,
    };
  }),
}));

vi.mock('../../src/runtime/singleFlightRequestCache', () => ({
  SingleFlightRequestCache: vi.fn().mockImplementation(function () {
    return {
      dedupe: mockDedupe,
      getStats: mockSingleFlightStats,
      inflightCount: mockInflightCount,
    };
  }),
}));

vi.mock('../../src/runtime/geminiCacheManager', () => ({
  GeminiCacheManager: vi.fn().mockImplementation(function () {
    return {
      getOrCreate: mockGetOrCreate,
      getStats: mockGeminiStats,
    };
  }),
}));

vi.mock('../../src/runtime/toolResultCache', () => ({
  ToolResultCache: vi.fn().mockImplementation(function () {
    return {
      dispose: mockToolDispose,
    };
  }),
}));

vi.mock('../../src/runtime/embedding', () => ({
  MockEmbeddingFunction: vi.fn(),
  OpenAIEmbeddingFunction: vi.fn(),
  LocalEmbeddingFunction: vi.fn(),
}));

vi.mock('../../src/runtime/tenantContext', () => ({
  getCurrentTenantId: vi.fn(),
  isMultiTenantEnabled: vi.fn(),
  TenantIsolationError: class TenantIsolationError extends Error {},
}));

describe('cacheManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tenantContext.getCurrentTenantId).mockReturnValue(undefined);
    vi.mocked(tenantContext.isMultiTenantEnabled).mockReturnValue(false);
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
      });
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
      mockLookup.mockResolvedValue(response);
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
      vi.mocked(tenantContext.isMultiTenantEnabled).mockReturnValue(true);
      vi.mocked(tenantContext.getCurrentTenantId).mockReturnValue(undefined);
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      await expect(manager.lookupSemantic(request)).rejects.toThrow('outside tenant context');
    });

    it('throws when store is called outside tenant context in multi-tenant mode', () => {
      vi.mocked(tenantContext.isMultiTenantEnabled).mockReturnValue(true);
      vi.mocked(tenantContext.getCurrentTenantId).mockReturnValue(undefined);
      const manager = new CacheManager();
      const request = { model: 'gpt-4o', messages: [] } as unknown as LLMRequest;
      const response = { content: 'cached' } as unknown as LLMResponse;
      expect(() => manager.storeSemantic(request, response)).toThrow('outside tenant context');
    });

    it('passes tenant id to semantic cache when available', async () => {
      vi.mocked(tenantContext.isMultiTenantEnabled).mockReturnValue(true);
      vi.mocked(tenantContext.getCurrentTenantId).mockReturnValue('tenant-1');
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
      mockDedupe.mockResolvedValue(response);
      const factory = vi.fn().mockResolvedValue(response);
      const result = await manager.dedupeSingleFlight('key-1', factory, 'tenant-1');
      expect(result).toBe(response);
      expect(mockDedupe).toHaveBeenCalledWith('key-1', factory, 'tenant-1');
    });

    it('exposes single flight stats', () => {
      const manager = new CacheManager();
      mockSingleFlightStats.mockReturnValue({ hits: 5, deduped: 3 });
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
      mockGetOrCreate.mockResolvedValue({ cachedContentName: 'name-1', createdNow: true });
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
      mockGeminiStats.mockReturnValue({ hits: 2, misses: 1 });
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
