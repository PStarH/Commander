"use strict";
/**
 * probeEnvironment — Zero-cost environment detection + connectivity testing
 * for Commander tier selection and fallback chain generation.
 *
 * Detects:
 *   - API keys (env vars for 20+ providers)
 *   - Docker socket availability
 *   - Redis connectivity
 *   - Kubernetes environment (in-cluster detection)
 *   - Ollama / vLLM local model availability
 *   - Provider connectivity (latency, reachability)
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
exports.testConnectivity = testConnectivity;
exports.recommendFallbackChain = recommendFallbackChain;
exports.probeEnvironment = probeEnvironment;
const fs = __importStar(require("fs"));
// ============================================================================
// Provider key map — env var → provider name
// ============================================================================
const PROVIDER_ENV_MAP = {
    OPENAI_API_KEY: 'openai',
    ANTHROPIC_API_KEY: 'anthropic',
    GOOGLE_API_KEY: 'google',
    DEEPSEEK_API_KEY: 'deepseek',
    ZHIPU_API_KEY: 'glm',
    MIMO_API_KEY: 'mimo',
    XIAOMI_API_KEY: 'xiaomi',
    OPENROUTER_API_KEY: 'openrouter',
    CO_API_KEY: 'cohere',
    MISTRAL_API_KEY: 'mistral',
    GROQ_API_KEY: 'groq',
    TOGETHER_API_KEY: 'together',
    PERPLEXITY_API_KEY: 'perplexity',
    FIREWORKS_API_KEY: 'fireworks',
    REPLICATE_API_TOKEN: 'replicate',
    XAI_API_KEY: 'xai',
    ANYSCALE_API_KEY: 'anyscale',
    DEEPINFRA_API_KEY: 'deepinfra',
    AGNES_API_KEY: 'agnes',
    AWS_ACCESS_KEY_ID: 'bedrock',
};
// ============================================================================
// Probing functions
// ============================================================================
/** Check if Docker socket is accessible. */
async function checkDocker() {
    var _a;
    try {
        const sock = (_a = process.env.DOCKER_SOCKET) !== null && _a !== void 0 ? _a : '/var/run/docker.sock';
        await fs.promises.access(sock, fs.constants.R_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Check if Redis is reachable. */
async function checkRedis() {
    var _a;
    const url = (_a = process.env.REDIS_URL) !== null && _a !== void 0 ? _a : process.env.REDIS_HOST;
    if (!url)
        return null;
    try {
        const parsed = url.startsWith('redis://') ? url : `redis://${url}`;
        // Best-effort TCP check — don't block startup
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        try {
            // Use a lightweight check — just verify the port is open
            const host = new URL(parsed).hostname;
            const port = parseInt(new URL(parsed).port || '6379', 10);
            // Node 18+ supports connect with AbortSignal
            const { createConnection } = await Promise.resolve().then(() => __importStar(require('net')));
            await new Promise((resolve, reject) => {
                const sock = createConnection({ host, port, signal: controller.signal });
                sock.on('connect', () => {
                    sock.destroy();
                    resolve();
                });
                sock.on('error', reject);
            });
            return parsed;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    catch {
        return null;
    }
}
/** Check if running inside Kubernetes. */
function checkKubernetes() {
    var _a;
    const inK8s = !!process.env.KUBERNETES_SERVICE_HOST;
    let namespace = null;
    if (inK8s) {
        try {
            namespace =
                (_a = process.env.KUBERNETES_NAMESPACE) !== null && _a !== void 0 ? _a : fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf-8').trim();
        }
        catch {
            namespace = null;
        }
    }
    return { inK8s, namespace };
}
/** Check Ollama availability. */
async function checkOllama() {
    var _a;
    const host = (_a = process.env.OLLAMA_HOST) !== null && _a !== void 0 ? _a : 'http://localhost:11434';
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch(`${host}/api/tags`, { signal: controller.signal });
            return response.ok;
        }
        catch {
            return false;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    catch {
        return false;
    }
}
/** Check vLLM availability. */
async function checkVllm() {
    const baseUrl = process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {
                signal: controller.signal,
            });
            return response.ok;
        }
        catch {
            return false;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    catch {
        return false;
    }
}
// ============================================================================
// Provider metadata for connectivity testing
// ============================================================================
const PROVIDER_DISPLAY_NAMES = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google Gemini',
    deepseek: 'DeepSeek',
    glm: 'GLM (Zhipu)',
    mimo: 'MiMo',
    xiaomi: 'Xiaomi MiMo',
    openrouter: 'OpenRouter',
    cohere: 'Cohere',
    mistral: 'Mistral AI',
    groq: 'Groq',
    together: 'Together AI',
    perplexity: 'Perplexity',
    fireworks: 'Fireworks AI',
    replicate: 'Replicate',
    bedrock: 'AWS Bedrock',
    xai: 'xAI Grok',
    anyscale: 'Anyscale',
    deepinfra: 'DeepInfra',
    ollama: 'Ollama (Local)',
    vllm: 'vLLM (Local)',
    agnes: 'Agnes AI',
};
const PROVIDER_DEFAULT_URLS = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    deepseek: 'https://api.deepseek.com',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    mimo: 'https://token-plan-sgp.xiaomimimo.com/v1',
    xiaomi: 'https://api.xiaomimimo.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    cohere: 'https://api.cohere.com',
    mistral: 'https://api.mistral.ai/v1',
    groq: 'https://api.groq.com/openai/v1',
    together: 'https://api.together.ai/v1',
    perplexity: 'https://api.perplexity.ai/v1',
    fireworks: 'https://api.fireworks.ai/inference/v1',
    replicate: 'https://api.replicate.com/v1',
    bedrock: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    xai: 'https://api.x.ai/v1',
    anyscale: 'https://api.endpoints.anyscale.com/v1',
    deepinfra: 'https://api.deepinfra.com/v1/openai',
    agnes: 'https://apihub.agnes-ai.com/v1',
};
const PROVIDER_DEFAULT_MODELS = {
    openai: 'gpt-4o',
    anthropic: 'claude-3-5-sonnet-20241022',
    google: 'gemini-2.0-flash',
    deepseek: 'deepseek-v4-flash',
    glm: 'glm-4.7',
    mimo: 'mimo-v2.5',
    xiaomi: 'mimo-v2-flash',
    openrouter: 'openai/gpt-4o-mini',
    cohere: 'command-a-plus-05-2026',
    mistral: 'mistral-large-latest',
    groq: 'llama-3.3-70b-versatile',
    together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    perplexity: 'sonar-pro',
    fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    replicate: 'meta/meta-llama-3.3-70b-instruct',
    bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    xai: 'grok-2-latest',
    anyscale: 'meta-llama/Llama-3.3-70B-Instruct',
    deepinfra: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    agnes: 'agnes-2.0-flash',
};
const PROVIDER_TIERS = {
    ollama: 'local',
    vllm: 'local',
    openai: 'premium',
    anthropic: 'premium',
    google: 'premium',
    openrouter: 'cloud',
    deepseek: 'cloud',
    glm: 'cloud',
    mimo: 'cloud',
    xiaomi: 'cloud',
    cohere: 'cloud',
    mistral: 'cloud',
    groq: 'cloud',
    together: 'cloud',
    perplexity: 'cloud',
    fireworks: 'cloud',
    replicate: 'cloud',
    bedrock: 'premium',
    xai: 'premium',
    anyscale: 'cloud',
    deepinfra: 'cloud',
    agnes: 'cloud',
};
// ============================================================================
// Connectivity testing
// ============================================================================
/**
 * Test connectivity to a single provider with a lightweight HTTP request.
 * Returns latency and status. Handles 3 API types: OpenAI-compatible,
 * Anthropic, and Google.
 */
async function testSingleProvider(provider, apiKey, timeoutMs = 5000) {
    var _a, _b, _c;
    const displayName = (_a = PROVIDER_DISPLAY_NAMES[provider]) !== null && _a !== void 0 ? _a : provider;
    const defaultModel = (_b = PROVIDER_DEFAULT_MODELS[provider]) !== null && _b !== void 0 ? _b : 'unknown';
    const tier = (_c = PROVIDER_TIERS[provider]) !== null && _c !== void 0 ? _c : 'cloud';
    // Local providers: skip HTTP test, mark as reachable if env is set
    if (provider === 'ollama') {
        const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/v1\/?$/, '');
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);
            const start = Date.now();
            const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
            clearTimeout(t);
            return {
                provider,
                displayName,
                status: res.ok ? 'reachable' : 'unreachable',
                latencyMs: Date.now() - start,
                tier,
                defaultModel,
            };
        }
        catch {
            return {
                provider,
                displayName,
                status: 'unreachable',
                tier,
                defaultModel,
                error: 'Ollama not running. Start with: ollama serve',
            };
        }
    }
    if (provider === 'vllm') {
        const baseUrl = process.env.VLLM_BASE_URL || 'http://localhost:8000/v1';
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);
            const start = Date.now();
            const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {
                signal: controller.signal,
            });
            clearTimeout(t);
            return {
                provider,
                displayName,
                status: res.ok ? 'reachable' : 'unreachable',
                latencyMs: Date.now() - start,
                tier,
                defaultModel,
            };
        }
        catch {
            return {
                provider,
                displayName,
                status: 'unreachable',
                tier,
                defaultModel,
                error: 'vLLM not running. Start with: vllm serve <model>',
            };
        }
    }
    // Bedrock: uses AWS credentials, can't easily test without SDK
    if (provider === 'bedrock') {
        return {
            provider,
            displayName,
            status: 'skipped',
            tier,
            defaultModel,
            error: 'AWS SDK connectivity test not available (requires @aws-sdk/client-bedrock-runtime)',
        };
    }
    // Cloud providers
    const baseUrl = PROVIDER_DEFAULT_URLS[provider];
    if (!baseUrl) {
        return {
            provider,
            displayName,
            status: 'skipped',
            tier,
            defaultModel,
            error: `No default URL for provider: ${provider}`,
        };
    }
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const start = Date.now();
        let response;
        if (provider === 'anthropic') {
            // Anthropic uses x-api-key header
            response = await fetch(`${baseUrl}/models`, {
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                signal: controller.signal,
            });
        }
        else if (provider === 'google') {
            // Google uses API key in query string; test with a models list call
            response = await fetch(`${baseUrl}/models?key=${apiKey}`, {
                signal: controller.signal,
            });
        }
        else {
            // OpenAI-compatible: Bearer token
            response = await fetch(`${baseUrl}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: controller.signal,
            });
        }
        clearTimeout(t);
        const latencyMs = Date.now() - start;
        if (response.ok) {
            return { provider, displayName, status: 'reachable', latencyMs, tier, defaultModel };
        }
        if (response.status === 401 || response.status === 403) {
            return {
                provider,
                displayName,
                status: 'auth_error',
                latencyMs,
                tier,
                defaultModel,
                error: `HTTP ${response.status}: Invalid API key`,
            };
        }
        return {
            provider,
            displayName,
            status: 'unreachable',
            latencyMs,
            tier,
            defaultModel,
            error: `HTTP ${response.status}`,
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort') || msg.includes('timeout')) {
            return {
                provider,
                displayName,
                status: 'timeout',
                tier,
                defaultModel,
                error: `Connection timed out after ${timeoutMs}ms`,
            };
        }
        return {
            provider,
            displayName,
            status: 'unreachable',
            tier,
            defaultModel,
            error: msg.slice(0, 80),
        };
    }
}
/**
 * Test connectivity for all detected providers in parallel.
 * Returns results sorted by latency (fastest first), with unreachable
 * providers at the end.
 */
async function testConnectivity(availableProviders, timeoutMs = 5000) {
    // Build API key lookup from env
    const envKeyMap = {
        openai: process.env.OPENAI_API_KEY || '',
        anthropic: process.env.ANTHROPIC_API_KEY || '',
        google: process.env.GOOGLE_API_KEY || '',
        deepseek: process.env.DEEPSEEK_API_KEY || '',
        glm: process.env.ZHIPU_API_KEY || '',
        mimo: process.env.MIMO_API_KEY || '',
        xiaomi: process.env.XIAOMI_API_KEY || '',
        openrouter: process.env.OPENROUTER_API_KEY || '',
        cohere: process.env.CO_API_KEY || '',
        mistral: process.env.MISTRAL_API_KEY || '',
        groq: process.env.GROQ_API_KEY || '',
        together: process.env.TOGETHER_API_KEY || '',
        perplexity: process.env.PERPLEXITY_API_KEY || '',
        fireworks: process.env.FIREWORKS_API_KEY || '',
        replicate: process.env.REPLICATE_API_TOKEN || '',
        xai: process.env.XAI_API_KEY || '',
        anyscale: process.env.ANYSCALE_API_KEY || '',
        deepinfra: process.env.DEEPINFRA_API_KEY || '',
        agnes: process.env.AGNES_API_KEY || '',
    };
    // Test all available providers in parallel
    const results = await Promise.all(availableProviders.map(async (provider) => {
        var _a, _b, _c;
        const apiKey = envKeyMap[provider] || '';
        if (!apiKey && provider !== 'ollama' && provider !== 'vllm' && provider !== 'bedrock') {
            return {
                provider,
                displayName: (_a = PROVIDER_DISPLAY_NAMES[provider]) !== null && _a !== void 0 ? _a : provider,
                status: 'skipped',
                tier: (_b = PROVIDER_TIERS[provider]) !== null && _b !== void 0 ? _b : 'cloud',
                defaultModel: (_c = PROVIDER_DEFAULT_MODELS[provider]) !== null && _c !== void 0 ? _c : 'unknown',
                error: 'No API key set',
            };
        }
        return testSingleProvider(provider, apiKey, timeoutMs);
    }));
    // Sort: reachable by latency first, then auth_error, then unreachable/timeout/skipped
    return results.sort((a, b) => {
        var _a, _b;
        const order = { reachable: 0, auth_error: 1, timeout: 2, unreachable: 3, skipped: 4 };
        const diff = order[a.status] - order[b.status];
        if (diff !== 0)
            return diff;
        return ((_a = a.latencyMs) !== null && _a !== void 0 ? _a : 9999) - ((_b = b.latencyMs) !== null && _b !== void 0 ? _b : 9999);
    });
}
/**
 * Build a recommended fallback chain from connectivity results.
 * Returns an array of provider names in priority order (fastest → fallback).
 */
function recommendFallbackChain(results) {
    const reachable = results.filter((r) => r.status === 'reachable');
    // Prefer: local first (fast), then cloud by latency, then premium
    return reachable
        .sort((a, b) => {
        var _a, _b;
        const tierOrder = { local: 0, cloud: 1, premium: 2 };
        const tDiff = tierOrder[a.tier] - tierOrder[b.tier];
        if (tDiff !== 0)
            return tDiff;
        return ((_a = a.latencyMs) !== null && _a !== void 0 ? _a : 9999) - ((_b = b.latencyMs) !== null && _b !== void 0 ? _b : 9999);
    })
        .slice(0, 5)
        .map((r) => r.provider);
}
// ============================================================================
// Main probe function
// ============================================================================
/**
 * Probe the environment to determine available capabilities.
 * All checks are best-effort with timeouts — returns partial results
 * rather than failing on any single check.
 */
async function probeEnvironment() {
    // Detect API keys from environment (synchronous, zero-cost)
    const existingEnvKeys = [];
    const availableProviders = [];
    for (const [envVar, provider] of Object.entries(PROVIDER_ENV_MAP)) {
        if (process.env[envVar]) {
            availableProviders.push(provider);
            existingEnvKeys.push(envVar);
        }
    }
    // Run detection checks in parallel
    const [docker, redis, ollama, vllm, k8s] = await Promise.all([
        checkDocker(),
        checkRedis(),
        checkOllama(),
        checkVllm(),
        Promise.resolve(checkKubernetes()),
    ]);
    return {
        availableProviders,
        dockerAvailable: docker,
        redisUrl: redis,
        ollamaAvailable: ollama,
        vllmAvailable: vllm,
        inKubernetes: k8s.inK8s,
        k8sNamespace: k8s.namespace,
        envKeys: existingEnvKeys,
        apiProviderCount: availableProviders.length,
    };
}
