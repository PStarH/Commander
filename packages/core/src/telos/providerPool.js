"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderPool = void 0;
exports.getProviderPool = getProviderPool;
exports.resetProviderPool = resetProviderPool;
const modelRouter_1 = require("../runtime/modelRouter");
// ============================================================================
// Built-in providers (will be fleshed out when API keys are configured)
// ============================================================================
class NoOpProvider {
    constructor(name) {
        this.name = name;
    }
    async call(_request) {
        throw new Error(`${this.name} provider not configured — set API key`);
    }
}
// ============================================================================
// Provider Pool
// ============================================================================
class ProviderPool {
    constructor(maxRetries = 2, retryDelayMs = 2000) {
        this.endpoints = [];
        this.healthCache = new Map();
        this.providers = new Map();
        this.consecutiveFailures = new Map();
        // GAP-27: Automatic recovery timer for 'down' providers
        this.recoveryTimer = null;
        this.RECOVERY_CHECK_INTERVAL_MS = 60000; // Check every 60s
        this.RECOVERY_AFTER_FAILURES_MS = 120000; // Try recovery after 2 min of being down
        this.maxRetries = maxRetries;
        this.retryDelayMs = retryDelayMs;
        // GAP-27: Start periodic recovery check
        this.recoveryTimer = setInterval(() => this.checkRecovery(), this.RECOVERY_CHECK_INTERVAL_MS);
        if (this.recoveryTimer.unref)
            this.recoveryTimer.unref();
    }
    /**
     * Register an LLM provider instance (e.g. OpenAIProvider, AnthropicProvider).
     */
    registerProvider(provider) {
        this.providers.set(provider.name, provider);
        // Auto-create endpoint if not exists
        if (!this.endpoints.find((e) => e.provider === provider.name)) {
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
    configureEndpoints(endpoints) {
        for (const ep of endpoints) {
            const existing = this.endpoints.findIndex((e) => e.provider === ep.provider && e.modelId === ep.modelId);
            if (existing >= 0) {
                this.endpoints[existing] = { ...this.endpoints[existing], ...ep };
            }
            else {
                this.endpoints.push(ep);
            }
        }
    }
    /**
     * Select the best provider for a given model and tier.
     * Uses weighted random selection among healthy endpoints.
     */
    select(modelTier) {
        const router = (0, modelRouter_1.getModelRouter)();
        const eligible = [];
        const models = modelTier ? router.listModels(modelTier) : router.listModels();
        for (const model of models) {
            const eps = this.endpoints.filter((e) => (e.modelId === '*' || e.modelId === model.id) && e.isEnabled);
            for (const ep of eps) {
                const health = this.healthCache.get(`${ep.provider}:${model.id}`);
                if (health && health.status === 'down')
                    continue;
                eligible.push({ endpoint: ep, modelId: model.id });
            }
        }
        if (eligible.length === 0) {
            // Fallback: use any enabled endpoint
            for (const ep of this.endpoints.filter((e) => e.isEnabled)) {
                eligible.push({
                    endpoint: ep,
                    modelId: ep.modelId === '*' ? 'claude-3-5-sonnet' : ep.modelId,
                });
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
        if (eligible.length === 0) {
            throw new Error('No eligible providers available');
        }
        return {
            provider: eligible[0].endpoint.provider,
            modelId: eligible[0].modelId,
            endpoint: eligible[0].endpoint,
            estimatedCost: 0,
        };
    }
    /**
     * Get all eligible endpoints for a tier, sorted by weight (descending).
     */
    getAllEligible(modelTier) {
        const router = (0, modelRouter_1.getModelRouter)();
        const eligible = [];
        const models = modelTier ? router.listModels(modelTier) : router.listModels();
        for (const model of models) {
            const eps = this.endpoints.filter((e) => (e.modelId === '*' || e.modelId === model.id) && e.isEnabled);
            for (const ep of eps) {
                const health = this.healthCache.get(`${ep.provider}:${model.id}`);
                if (health && health.status === 'down')
                    continue;
                eligible.push({ endpoint: ep, modelId: model.id });
            }
        }
        if (eligible.length === 0) {
            for (const ep of this.endpoints.filter((e) => e.isEnabled)) {
                eligible.push({
                    endpoint: ep,
                    modelId: ep.modelId === '*' ? 'claude-3-5-sonnet' : ep.modelId,
                });
            }
        }
        // Sort by weight descending for deterministic order
        eligible.sort((a, b) => b.endpoint.weight - a.endpoint.weight);
        return eligible;
    }
    /**
     * Execute a request with automatic failover across providers.
     * Cycles through eligible providers deterministically (by weight).
     */
    async executeWithFailover(request, modelTier) {
        const allEligible = this.getAllEligible(modelTier);
        if (allEligible.length === 0) {
            throw new Error('No eligible providers available');
        }
        let lastError = null;
        const maxAttempts = Math.min(this.maxRetries + 1, allEligible.length);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const selection = allEligible[attempt];
            const provider = this.providers.get(selection.endpoint.provider);
            if (!provider) {
                lastError = new Error(`Provider ${selection.endpoint.provider} not registered`);
                continue;
            }
            try {
                const response = await provider.call({
                    ...request,
                    model: selection.modelId,
                });
                this.recordSuccess(selection.endpoint.provider, selection.modelId);
                return response;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.recordFailure(selection.endpoint.provider, selection.modelId);
                if (attempt < maxAttempts - 1) {
                    await this.delay(this.retryDelayMs * Math.pow(2, attempt));
                }
            }
        }
        throw lastError !== null && lastError !== void 0 ? lastError : new Error('All providers failed');
    }
    /**
     * Execute with provider-native streaming when available, with the same
     * endpoint failover behavior as non-streaming calls.
     */
    async executeStreaming(request, modelTier, onChunk) {
        let lastError = null;
        const tried = new Set();
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const selection = this.select(modelTier);
            const key = `${selection.provider}:${selection.modelId}`;
            if (tried.has(key))
                break;
            tried.add(key);
            const provider = this.providers.get(selection.provider);
            if (!provider) {
                lastError = new Error(`Provider ${selection.provider} not registered`);
                continue;
            }
            const routedRequest = { ...request, model: selection.modelId };
            try {
                const response = provider.stream
                    ? await this.consumeStream(provider, routedRequest, onChunk)
                    : await provider.call(routedRequest);
                if (!provider.stream && response.content && onChunk)
                    onChunk(response.content);
                this.recordSuccess(selection.provider, selection.modelId);
                return response;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.recordFailure(selection.provider, selection.modelId);
                if (attempt < this.maxRetries) {
                    await this.delay(this.retryDelayMs * Math.pow(2, attempt));
                }
            }
        }
        throw lastError !== null && lastError !== void 0 ? lastError : new Error('All providers failed');
    }
    async consumeStream(provider, request, onChunk) {
        var _a, _b, _c, _d;
        if (!provider.stream)
            return provider.call(request);
        let content = '';
        let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const toolCalls = new Map();
        for await (const chunk of provider.stream(request)) {
            if (chunk.contentDelta) {
                content += chunk.contentDelta;
                if (onChunk)
                    onChunk(chunk.contentDelta);
            }
            if (chunk.usage) {
                usage = {
                    promptTokens: (_a = chunk.usage.promptTokens) !== null && _a !== void 0 ? _a : usage.promptTokens,
                    completionTokens: (_b = chunk.usage.completionTokens) !== null && _b !== void 0 ? _b : usage.completionTokens,
                    totalTokens: (_c = chunk.usage.totalTokens) !== null && _c !== void 0 ? _c : usage.totalTokens,
                };
            }
            if (((_d = chunk.toolCallDelta) === null || _d === void 0 ? void 0 : _d.id) && chunk.toolCallDelta.name && chunk.toolCallDelta.arguments) {
                toolCalls.set(chunk.toolCallDelta.id, {
                    id: chunk.toolCallDelta.id,
                    name: chunk.toolCallDelta.name,
                    arguments: chunk.toolCallDelta.arguments,
                });
            }
        }
        if (usage.totalTokens === 0) {
            // Estimate tokens from character count (~4 chars per token)
            const promptChars = JSON.stringify(request.messages).length;
            const completionChars = content.length;
            usage = {
                promptTokens: Math.ceil(promptChars / 4),
                completionTokens: Math.ceil(completionChars / 4),
                totalTokens: Math.ceil((promptChars + completionChars) / 4),
            };
        }
        return {
            content,
            model: request.model,
            usage,
            finishReason: toolCalls.size > 0 ? 'tool_calls' : 'stop',
            toolCalls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
        };
    }
    // ========================================================================
    // Health management
    // ========================================================================
    recordSuccess(provider, modelId) {
        var _a;
        const key = `${provider}:${modelId}`;
        const current = this.healthCache.get(key);
        this.healthCache.set(key, {
            provider,
            modelId,
            status: 'healthy',
            latencyMs: (_a = current === null || current === void 0 ? void 0 : current.latencyMs) !== null && _a !== void 0 ? _a : 0,
            lastCheck: new Date().toISOString(),
            consecutiveFailures: 0,
            rateLimitRemaining: 100,
        });
        this.consecutiveFailures.set(key, 0);
    }
    recordFailure(provider, modelId) {
        var _a;
        const key = `${provider}:${modelId}`;
        const failures = ((_a = this.consecutiveFailures.get(key)) !== null && _a !== void 0 ? _a : 0) + 1;
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
    getHealthStatus() {
        return Array.from(this.healthCache.values());
    }
    getEndpointCount() {
        return this.endpoints.length;
    }
    isProviderRegistered(name) {
        return this.providers.has(name);
    }
    recoverProvider(provider, modelId) {
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
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    // GAP-27: Periodically attempt recovery of 'down' providers
    checkRecovery() {
        var _a;
        const now = Date.now();
        for (const [key, health] of this.healthCache) {
            if (health.status === 'down') {
                const lastCheck = new Date(health.lastCheck).getTime();
                if (now - lastCheck > this.RECOVERY_AFTER_FAILURES_MS) {
                    // Reset to 'degraded' so it gets one more chance, but keep some failure memory
                    health.status = 'degraded';
                    health.lastCheck = new Date().toISOString();
                    this.healthCache.set(key, health);
                    const prev = (_a = this.consecutiveFailures.get(key)) !== null && _a !== void 0 ? _a : 0;
                    this.consecutiveFailures.set(key, Math.max(0, Math.floor(prev / 2)));
                }
            }
        }
    }
    /** Stop the recovery timer. Call when shutting down. */
    dispose() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    }
}
exports.ProviderPool = ProviderPool;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const providerPoolSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ProviderPool(), {
    dispose: (pool) => pool.dispose(),
});
function getProviderPool() {
    return providerPoolSingleton.get();
}
function resetProviderPool() {
    providerPoolSingleton.reset();
}
