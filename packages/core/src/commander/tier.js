"use strict";
/**
 * tier.ts — Tier determination and configuration resolution.
 *
 * Based on probe results + user options, determines which deployment tier
 * Commander should run in and resolves the appropriate configuration.
 *
 * Tier progression:
 *   hobbyist → team → enterprise (auto-escalates based on detected capabilities)
 *   Degradation: enterprise → team → hobbyist (when capabilities are absent)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.determineTier = determineTier;
exports.resolveConfig = resolveConfig;
// ============================================================================
// Tier defaults
// ============================================================================
const TIER_DEFAULTS = {
    hobbyist: {
        runtime: {
            defaultModelTier: 'eco',
            maxStepsPerRun: 10,
            maxRetries: 1,
            retryDelayMs: 1000,
            timeoutMs: 120000,
            maxConcurrency: 1,
            budgetHardCapTokens: 16000,
            observationMaskWindow: 0,
            enableDescendingScheduler: false,
            enableCompensation: false,
            enableToolCaching: true,
            memoryStoreType: 'in-memory',
            otelExporter: { enabled: false },
        },
        features: {
            otelExport: false,
            multiTenant: false,
            semanticCache: false,
            durableCompensation: false,
            prometheusMetrics: false,
            crashSafeCheckpoints: false,
            modelLearning: false,
        },
    },
    team: {
        runtime: {
            defaultModelTier: 'standard',
            maxStepsPerRun: 20,
            maxRetries: 2,
            retryDelayMs: 2000,
            timeoutMs: 300000,
            maxConcurrency: 3,
            budgetHardCapTokens: 64000,
            observationMaskWindow: 3,
            enableDescendingScheduler: true,
            enableCompensation: true,
            enableToolCaching: true,
            memoryStoreType: 'json',
            otelExporter: { enabled: false },
        },
        features: {
            otelExport: false,
            multiTenant: false,
            semanticCache: true,
            durableCompensation: true,
            prometheusMetrics: false,
            crashSafeCheckpoints: true,
            modelLearning: true,
        },
    },
    enterprise: {
        runtime: {
            defaultModelTier: 'standard',
            maxStepsPerRun: 50,
            maxRetries: 3,
            retryDelayMs: 1000,
            timeoutMs: 600000,
            maxConcurrency: 20,
            budgetHardCapTokens: 200000,
            observationMaskWindow: 5,
            enableDescendingScheduler: true,
            enableCompensation: true,
            enableToolCaching: true,
            memoryStoreType: 'sqlite',
            otelExporter: { enabled: true },
        },
        features: {
            otelExport: true,
            multiTenant: true,
            semanticCache: true,
            durableCompensation: true,
            prometheusMetrics: true,
            crashSafeCheckpoints: true,
            modelLearning: true,
        },
    },
};
// ============================================================================
// Tier determination
// ============================================================================
/**
 * Determine the deployment tier based on probe results and user options.
 *
 * Decision logic:
 *   Enterprise: API keys + Redis available + K8s detected
 *   Team:       API keys available
 *   Hobbyist:   No API keys, local model only
 *
 * Degradation path: if Redis isn't reachable, enterprise → team.
 */
function determineTier(probe, options) {
    // User override takes precedence
    if (options === null || options === void 0 ? void 0 : options.tier)
        return options.tier;
    // Enterprise: must have API keys, Redis, and K8s
    if (probe.apiProviderCount > 0 && probe.redisUrl && probe.inKubernetes) {
        return 'enterprise';
    }
    // Team: must have API keys (at least one provider)
    if (probe.apiProviderCount > 0) {
        return 'team';
    }
    // Hobbyist: local models only
    return 'hobbyist';
}
// ============================================================================
// Provider resolution
// ============================================================================
/**
 * Resolve the LLM provider configuration based on tier, probe, and options.
 * Returns null if no usable provider was found (only possible in hobbyist mode
 * without Ollama/vLLM — caller should handle gracefully).
 */
function resolveProvider(tier, probe, options) {
    var _a, _b, _c, _d;
    const preferred = options === null || options === void 0 ? void 0 : options.provider;
    if (tier === 'hobbyist') {
        // Local-first: prefer Ollama → vLLM
        if (probe.ollamaAvailable) {
            return {
                type: 'ollama',
                baseUrl: process.env.OLLAMA_HOST,
                defaultModel: 'llama3.2',
            };
        }
        if (probe.vllmAvailable) {
            return {
                type: 'vllm',
                baseUrl: process.env.VLLM_BASE_URL,
                defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
            };
        }
        // Fallback: maybe the user set an API key but has no local models?
        // Try first available provider from env.
        if (probe.availableProviders.length > 0) {
            const p = probe.availableProviders[0];
            return { type: p, apiKey: readEnvKey(p) };
        }
        return null;
    }
    // Team/Enterprise: prefer specified provider, then first available
    if (preferred && (probe.availableProviders.includes(preferred) || (options === null || options === void 0 ? void 0 : options.apiKey))) {
        return {
            type: preferred,
            apiKey: (_a = options.apiKey) !== null && _a !== void 0 ? _a : readEnvKey(preferred),
            baseUrl: options.baseUrl,
            defaultModel: (_b = options.model) !== null && _b !== void 0 ? _b : defaultModelForProvider(preferred),
        };
    }
    // Pick the first available provider from env
    for (const provider of probe.availableProviders) {
        return {
            type: provider,
            apiKey: readEnvKey(provider),
            baseUrl: options === null || options === void 0 ? void 0 : options.baseUrl,
            defaultModel: (_c = options === null || options === void 0 ? void 0 : options.model) !== null && _c !== void 0 ? _c : defaultModelForProvider(provider),
        };
    }
    // Last resort: if user explicitly set apiKey, use it
    if ((options === null || options === void 0 ? void 0 : options.apiKey) && preferred) {
        return {
            type: preferred,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            defaultModel: (_d = options.model) !== null && _d !== void 0 ? _d : 'gpt-4o',
        };
    }
    return null;
}
// ============================================================================
// Tenant resolution
// ============================================================================
function resolveTenant(tier, _probe) {
    if (tier === 'enterprise') {
        return { provider: 'multi', configs: [] };
    }
    if (tier === 'team') {
        return { provider: 'simple', configs: [] };
    }
    return { provider: 'null' };
}
// ============================================================================
// Persistence resolution
// ============================================================================
function resolvePersistence(tier, probe) {
    if (tier === 'enterprise' && probe.redisUrl) {
        return { type: 'redis', redisUrl: probe.redisUrl };
    }
    if (tier === 'team') {
        return { type: 'file', path: '.commander' };
    }
    return { type: 'memory' };
}
// ============================================================================
// Config resolution
// ============================================================================
/**
 * Resolve the full configuration for a given deployment tier.
 * Merges tier defaults with user-provided options.
 */
function resolveConfig(tier, probe, options) {
    const defaults = TIER_DEFAULTS[tier];
    const config = {
        tier,
        runtime: { ...defaults.runtime },
        provider: resolveProvider(tier, probe, options),
        tenant: resolveTenant(tier, probe),
        persistence: resolvePersistence(tier, probe),
        features: { ...defaults.features },
    };
    // Apply user overrides
    if (options === null || options === void 0 ? void 0 : options.tokenBudget) {
        config.runtime.budgetHardCapTokens = options.tokenBudget;
    }
    if ((options === null || options === void 0 ? void 0 : options.maxConcurrency) !== undefined) {
        config.runtime.maxConcurrency = options.maxConcurrency;
    }
    return config;
}
// ============================================================================
// Helpers
// ============================================================================
function readEnvKey(provider) {
    const envMap = {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        google: 'GOOGLE_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        glm: 'ZHIPU_API_KEY',
        mimo: 'MIMO_API_KEY',
        xiaomi: 'XIAOMI_API_KEY',
        ollama: 'OLLAMA_HOST',
        vllm: 'VLLM_BASE_URL',
        cohere: 'CO_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        groq: 'GROQ_API_KEY',
        together: 'TOGETHER_API_KEY',
        perplexity: 'PERPLEXITY_API_KEY',
        fireworks: 'FIREWORKS_API_KEY',
        replicate: 'REPLICATE_API_TOKEN',
        bedrock: 'AWS_ACCESS_KEY_ID',
        xai: 'XAI_API_KEY',
        anyscale: 'ANYSCALE_API_KEY',
        deepinfra: 'DEEPINFRA_API_KEY',
    };
    return process.env[envMap[provider]];
}
function defaultModelForProvider(provider) {
    var _a;
    const models = {
        openai: 'gpt-4o',
        anthropic: 'claude-sonnet-4-6',
        google: 'gemini-2-pro',
        openrouter: 'gpt-4o',
        deepseek: 'deepseek-v4-pro',
        glm: 'glm-5.1',
        mimo: 'mimo-v2.5-pro',
        xiaomi: 'mimo-v2.5-pro',
        ollama: 'llama3.2',
        vllm: 'meta-llama/Llama-3.2-3B-Instruct',
        cohere: 'command-r-plus-08-2024',
        mistral: 'mistral-large-latest',
        groq: 'llama-3.3-70b-versatile',
        together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        perplexity: 'sonar-pro',
        fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        replicate: 'meta/meta-llama-3.3-70b-instruct',
        bedrock: 'anthropic.claude-sonnet-4-6-v1:0',
        xai: 'grok-3',
        anyscale: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
        deepinfra: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    };
    return (_a = models[provider]) !== null && _a !== void 0 ? _a : 'gpt-4o';
}
