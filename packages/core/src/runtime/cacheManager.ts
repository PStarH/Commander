/**
 * CacheManager — consolidates LLM and tool caching for AgentRuntime.
 *
 * Extracted from AgentRuntime to shrink the god object. Handles semantic,
 * single-flight, Gemini context, and tool-result caches.
 */

import { SemanticCache } from './semanticCache';
import { SingleFlightRequestCache, type SingleFlightStats } from './singleFlightRequestCache';
import { GeminiCacheManager, type GeminiCacheStats } from './geminiCacheManager';
import { ToolResultCache } from './toolResultCache';
import {
  MockEmbeddingFunction,
  OpenAIEmbeddingFunction,
  LocalEmbeddingFunction,
} from './embedding';
import { getGlobalLogger } from '../logging';
import type { LLMRequest, LLMResponse, AgentRuntimeConfig, ToolDefinition } from './types';

export interface CacheManagerConfig {
  semanticCache?: AgentRuntimeConfig['semanticCache'];
  singleFlight?: AgentRuntimeConfig['singleFlight'];
  geminiCache?: AgentRuntimeConfig['geminiCache'];
}

export class CacheManager {
  private semanticCache: SemanticCache;
  private singleFlight: SingleFlightRequestCache;
  private geminiCache: GeminiCacheManager;
  private toolCache: ToolResultCache;

  constructor(config: CacheManagerConfig = {}) {
    this.toolCache = new ToolResultCache({
      enabled: true,
      maxEntries: 512,
      defaultTtlMs: 1_800_000,
    });
    this.semanticCache = resolveSemanticCache(config);
    this.singleFlight = new SingleFlightRequestCache({
      enabled: config.singleFlight?.enabled ?? true,
      maxInFlight: config.singleFlight?.maxInFlight ?? 1000,
    });
    this.geminiCache = new GeminiCacheManager({
      enabled: config.geminiCache?.enabled ?? true,
      maxEntries: config.geminiCache?.maxEntries ?? 100,
      defaultTtlSeconds: config.geminiCache?.defaultTtlSeconds ?? 300,
      fetchTimeoutMs: config.geminiCache?.fetchTimeoutMs ?? 30_000,
    });
  }

  getToolCache(): ToolResultCache {
    return this.toolCache;
  }

  async lookupSemantic(request: LLMRequest): Promise<LLMResponse | null> {
    return this.semanticCache.lookup(request);
  }

  storeSemantic(request: LLMRequest, response: LLMResponse): void {
    this.semanticCache.store(request, response);
  }

  async dedupeSingleFlight(
    key: string,
    factory: () => Promise<LLMResponse>,
    tenantId?: string,
  ): Promise<LLMResponse> {
    return this.singleFlight.dedupe(key, factory, tenantId);
  }

  async getGeminiCachedContent(params: {
    systemInstruction: string | undefined;
    tools: ToolDefinition[] | undefined;
    model: string;
    apiKey: string;
    baseUrl?: string;
    tenantId?: string;
  }): Promise<{ cachedContentName?: string; createdNow?: boolean }> {
    return this.geminiCache.getOrCreate(params);
  }

  getSemanticCacheStats() {
    return this.semanticCache.getStats();
  }

  getSingleFlightStats(): SingleFlightStats {
    return this.singleFlight.getStats();
  }

  getSingleFlightInflightCount(): number {
    return this.singleFlight.inflightCount();
  }

  getGeminiCacheStats(): GeminiCacheStats {
    return this.geminiCache.getStats();
  }

  dispose(): void {
    this.toolCache.dispose();
  }
}

function resolveSemanticCache(config: CacheManagerConfig): SemanticCache {
  const cfg = config.semanticCache;
  if (!cfg?.enabled) {
    return new SemanticCache(new MockEmbeddingFunction(), { enabled: false, pruneIntervalMs: 0 });
  }
  const apiKey = cfg.openaiApiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    getGlobalLogger().debug(
      'CacheManager',
      `Semantic cache enabled with local embeddings (threshold=${cfg.similarityThreshold ?? 0.92}). Set OPENAI_API_KEY for higher-quality OpenAI embeddings.`,
    );
    return new SemanticCache(new LocalEmbeddingFunction(), {
      enabled: true,
      similarityThreshold: cfg.similarityThreshold ?? 0.92,
      maxEntries: cfg.maxEntries ?? 10_000,
      defaultTtlMs: cfg.defaultTtlMs ?? 86_400_000,
      maxBucketSize: cfg.maxBucketSize ?? 64,
      cacheStochastic: cfg.cacheStochastic ?? false,
      cacheToolCalls: cfg.cacheToolCalls ?? false,
      pruneIntervalMs: cfg.pruneIntervalMs ?? 60_000,
    });
  }
  getGlobalLogger().debug(
    'CacheManager',
    `Semantic cache enabled with OpenAI embeddings (model=${cfg.embeddingModel ?? 'text-embedding-3-small'}, threshold=${cfg.similarityThreshold ?? 0.92})`,
  );
  return new SemanticCache(
    new OpenAIEmbeddingFunction({
      apiKey,
      model: cfg.embeddingModel,
      baseUrl: cfg.embeddingBaseUrl,
    }),
    {
      enabled: true,
      similarityThreshold: cfg.similarityThreshold ?? 0.92,
      maxEntries: cfg.maxEntries ?? 10_000,
      defaultTtlMs: cfg.defaultTtlMs ?? 86_400_000,
      maxBucketSize: cfg.maxBucketSize ?? 64,
      cacheStochastic: cfg.cacheStochastic ?? false,
      cacheToolCalls: cfg.cacheToolCalls ?? false,
      pruneIntervalMs: cfg.pruneIntervalMs ?? 60_000,
    },
  );
}
