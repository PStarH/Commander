import type { LLMProvider, LLMRequest, LLMResponse, ModelTier } from '../runtime/types';
import type {
  ProviderEndpoint,
  ProviderHealth,
  ProviderSelection,
} from './types';
import { getModelRouter } from '../runtime/modelRouter';

// ============================================================================
// Built-in providers (will be fleshed out when API keys are configured)
// ============================================================================

class NoOpProvider implements LLMProvider {
  readonly name: string;
  constructor(name: string) { this.name = name; }
  async call(_request: LLMRequest): Promise<LLMResponse> {
    throw new Error(`${this.name} provider not configured — set API key`);
  }
}

// ============================================================================
// Provider Pool
// ============================================================================

export class ProviderPool {
  private endpoints: ProviderEndpoint[] = [];
  private healthCache: Map<string, ProviderHealth> = new Map();
  private providers: Map<string, LLMProvider> = new Map();
  private rateLimitCounters: Map<string, { count: number; windowStart: number }> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(maxRetries = 2, retryDelayMs = 2000) {
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  /**
   * Register an LLM provider instance (e.g. OpenAIProvider, AnthropicProvider).
   */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
    // Auto-create endpoint if not exists
    if (!this.endpoints.find(e => e.provider === provider.name)) {
      this.endpoints.push({
        provider: provider.name,
        modelId: '*',
        priority: this.endpoints.length,
        weight: 1,
        isEnabled: true,
      });
    }
  }

  /**
   * Configure endpoints with API keys and routing weights.
   */
  configureEndpoints(endpoints: ProviderEndpoint[]): void {
    for (const ep of endpoints) {
      const existing = this.endpoints.findIndex(
        e => e.provider === ep.provider && e.modelId === ep.modelId,
      );
      if (existing >= 0) {
        this.endpoints[existing] = { ...this.endpoints[existing], ...ep };
      } else {
        this.endpoints.push(ep);
      }
    }
  }

  /**
   * Select the best provider for a given model and tier.
   * Uses weighted random selection among healthy endpoints.
   */
  select(modelTier?: ModelTier): ProviderSelection {
    const router = getModelRouter();
    const eligible: Array<{ endpoint: ProviderEndpoint; modelId: string }> = [];

    const models = modelTier
      ? router.listModels(modelTier)
      : router.listModels();

    for (const model of models) {
      const eps = this.endpoints.filter(
        e => (e.modelId === '*' || e.modelId === model.id) && e.isEnabled,
      );
      for (const ep of eps) {
        const health = this.healthCache.get(`${ep.provider}:${model.id}`);
        if (health && health.status === 'down') continue;
        eligible.push({ endpoint: ep, modelId: model.id });
      }
    }

    if (eligible.length === 0) {
      // Fallback: use any enabled endpoint
      for (const ep of this.endpoints.filter(e => e.isEnabled)) {
        eligible.push({ endpoint: ep, modelId: ep.modelId === '*' ? 'claude-3-5-sonnet' : ep.modelId });
      }
    }

    // Weighted selection
    const totalWeight = eligible.reduce((s, e) => s + e.endpoint.weight, 0);
    let pick = Math.random() * totalWeight;
    for (const el of eligible) {
      pick -= el.endpoint.weight;
      if (pick <= 0) {
        return {
          provider: el.endpoint.provider,
          modelId: el.modelId,
          endpoint: el.endpoint,
          estimatedCost: 0,
        };
      }
    }

    return {
      provider: eligible[0]?.endpoint.provider ?? 'none',
      modelId: eligible[0]?.modelId ?? 'none',
      endpoint: eligible[0]?.endpoint ?? { provider: 'none', modelId: 'none', priority: 0, weight: 1, isEnabled: false },
      estimatedCost: 0,
    };
  }

  /**
   * Execute a request with automatic failover across providers.
   * Returns the response from the first successful provider.
   */
  async executeWithFailover(
    request: LLMRequest,
    modelTier?: ModelTier,
  ): Promise<LLMResponse> {
    let lastError: Error | null = null;
    const tried = new Set<string>();

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const selection = this.select(modelTier);
      if (tried.has(`${selection.provider}:${selection.modelId}`)) {
        // All available tried, break
        break;
      }
      tried.add(`${selection.provider}:${selection.modelId}`);

      const provider = this.providers.get(selection.provider);
      if (!provider) {
        lastError = new Error(`Provider ${selection.provider} not registered`);
        continue;
      }

      try {
        const response = await provider.call({
          ...request,
          model: selection.modelId,
        });
        this.recordSuccess(selection.provider, selection.modelId);
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(selection.provider, selection.modelId);
        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelayMs * Math.pow(2, attempt));
        }
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  /**
   * Execute with streaming — calls the provider and returns the first response chunk.
   * Full streaming support requires the provider to implement streaming natively.
   */
  async executeStreaming(
    request: LLMRequest,
    modelTier?: ModelTier,
    onChunk?: (chunk: string) => void,
  ): Promise<LLMResponse> {
    // For now, calls the provider as-is.
    // Streaming will be added when real providers are implemented.
    return this.executeWithFailover(request, modelTier);
  }

  // ========================================================================
  // Health management
  // ========================================================================

  private recordSuccess(provider: string, modelId: string): void {
    const key = `${provider}:${modelId}`;
    const current = this.healthCache.get(key);
    this.healthCache.set(key, {
      provider,
      modelId,
      status: 'healthy',
      latencyMs: current?.latencyMs ?? 0,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
      rateLimitRemaining: 100,
    });
    this.consecutiveFailures.set(key, 0);
  }

  private recordFailure(provider: string, modelId: string): void {
    const key = `${provider}:${modelId}`;
    const failures = (this.consecutiveFailures.get(key) ?? 0) + 1;
    this.consecutiveFailures.set(key, failures);

    this.healthCache.set(key, {
      provider,
      modelId,
      status: failures >= 3 ? 'down' : failures >= 1 ? 'degraded' : 'healthy',
      latencyMs: 0,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: failures,
      rateLimitRemaining: 0,
    });
  }

  getHealthStatus(): ProviderHealth[] {
    return Array.from(this.healthCache.values());
  }

  getEndpointCount(): number {
    return this.endpoints.length;
  }

  isProviderRegistered(name: string): boolean {
    return this.providers.has(name);
  }

  recoverProvider(provider: string, modelId: string): void {
    const key = `${provider}:${modelId}`;
    this.consecutiveFailures.delete(key);
    this.healthCache.set(key, {
      provider,
      modelId,
      status: 'healthy',
      latencyMs: 0,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
      rateLimitRemaining: 100,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

let globalPool: ProviderPool | null = null;

export function getProviderPool(): ProviderPool {
  if (!globalPool) {
    globalPool = new ProviderPool();
  }
  return globalPool;
}

export function resetProviderPool(): void {
  globalPool = null;
}
