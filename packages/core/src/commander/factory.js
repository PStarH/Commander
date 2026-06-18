"use strict";
/**
 * factory.ts — RuntimeFactory that wires up a Commander instance based on
 * resolved tier configuration.
 *
 * Takes a ResolvedConfig from tier.ts and creates the necessary runtime
 * components: TenantProvider, AgentRuntime, Provider registration, etc.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWiredRuntime = createWiredRuntime;
const agentRuntime_1 = require("../runtime/agentRuntime");
const modelRouter_1 = require("../runtime/modelRouter");
const tenantProvider_1 = require("../runtime/tenantProvider");
const logging_1 = require("../logging");
const index_1 = require("../tools/index");
// Provider map — lazy-loaded to avoid bundling all providers in every import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROVIDER_FACTORIES = {
    openai: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/openaiProvider')))).OpenAIProvider,
    anthropic: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/anthropicProvider')))).AnthropicProvider,
    google: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/googleProvider')))).GoogleProvider,
    deepseek: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/deepseekProvider')))).DeepSeekProvider,
    glm: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/glmProvider')))).GLMProvider,
    mimo: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/mimoProvider')))).MiMoProvider,
    xiaomi: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/xiaomiProvider')))).XiaomiProvider,
    ollama: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/ollamaProvider')))).OllamaProvider,
    vllm: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/vllmProvider')))).VLLMProvider,
    cohere: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/cohereProvider')))).CohereProvider,
    mistral: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/mistralProvider')))).MistralProvider,
    groq: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/groqProvider')))).GroqProvider,
    together: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/togetherProvider')))).TogetherProvider,
    perplexity: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/perplexityProvider')))).PerplexityProvider,
    fireworks: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/fireworksProvider')))).FireworksProvider,
    replicate: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/replicateProvider')))).ReplicateProvider,
    bedrock: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/bedrockProvider')))).BedrockProvider,
    xai: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/xaiProvider')))).XAIProvider,
    anyscale: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/anyscaleProvider')))).AnyscaleProvider,
    deepinfra: async () => (await Promise.resolve().then(() => __importStar(require('../runtime/providers/deepinfraProvider')))).DeepInfraProvider,
};
/**
 * Create and wire a complete runtime based on resolved configuration.
 *
 * This is the single entry point that assembles:
 *   1. TenantProvider (null/simple/multi based on tier)
 *   2. AgentRuntime with tier-appropriate config
 *   3. LLM Provider registration (lazy-loaded by provider type)
 *   4. Tool registration (all built-in tools)
 *   5. Model registration in the router
 */
async function createWiredRuntime(config) {
    var _a, _b, _c, _d, _e;
    const logger = (0, logging_1.getGlobalLogger)();
    // ── 1. Tenant Provider ─────────────────────────────────────────────────
    if (config.tenant.provider === 'multi') {
        // In production, MultiTenantProvider would be dynamically configured
        // For now, use SimpleTenantProvider as the enterprise base
        (0, tenantProvider_1.setGlobalTenantProvider)(new tenantProvider_1.SimpleTenantProvider((_a = config.tenant.configs) !== null && _a !== void 0 ? _a : []));
    }
    else if (config.tenant.provider === 'simple') {
        (0, tenantProvider_1.setGlobalTenantProvider)(new tenantProvider_1.SimpleTenantProvider());
    }
    // null → already the default (NullTenantProvider)
    // ── 2. AgentRuntime ────────────────────────────────────────────────────
    const runtime = new agentRuntime_1.AgentRuntime({
        ...config.runtime,
        otelExporter: config.features.otelExport
            ? { enabled: true, serviceName: 'commander' }
            : { enabled: false },
    });
    // ── 3. Register Provider ───────────────────────────────────────────────
    if (config.provider) {
        const factory = PROVIDER_FACTORIES[config.provider.type];
        if (factory) {
            try {
                const ProviderClass = await factory();
                runtime.registerProvider(config.provider.type, new ProviderClass({
                    apiKey: (_b = config.provider.apiKey) !== null && _b !== void 0 ? _b : '',
                    baseUrl: config.provider.baseUrl,
                    defaultModel: config.provider.defaultModel,
                }));
                // Register model in the router
                const router = (0, modelRouter_1.getModelRouter)();
                const modelId = (_c = config.provider.defaultModel) !== null && _c !== void 0 ? _c : 'gpt-4o';
                for (const tier of ['eco', 'standard', 'power', 'consensus']) {
                    router.registerModel({
                        id: `${modelId}@${tier}`,
                        provider: config.provider.type,
                        tier,
                        costPer1KInput: 0.001,
                        costPer1KOutput: 0.003,
                        capabilities: ['code', 'reasoning', 'analysis'],
                        contextWindow: 128000,
                        priority: 0,
                    });
                }
            }
            catch (err) {
                logger.warn('RuntimeFactory', `Failed to register provider: ${config.provider.type}`, {
                    error: err === null || err === void 0 ? void 0 : err.message,
                });
            }
        }
        else {
            logger.warn('RuntimeFactory', `Unknown provider type: ${config.provider.type}`);
        }
    }
    // ── 4. Register Tools ──────────────────────────────────────────────────
    const allTools = (0, index_1.createAllTools)();
    for (const [name, tool] of allTools) {
        runtime.registerTool(name, tool);
    }
    logger.info('RuntimeFactory', `Wired runtime for tier: ${config.tier}`, {
        provider: (_e = (_d = config.provider) === null || _d === void 0 ? void 0 : _d.type) !== null && _e !== void 0 ? _e : 'none',
        features: Object.entries(config.features)
            .filter(([, v]) => v)
            .map(([k]) => k),
    });
    return {
        runtime,
        tier: config.tier,
        features: config.features,
    };
}
