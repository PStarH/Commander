"use strict";
/**
 * Commander — Core Control Center
 *
 * The single entry point for Commander's multi-agent orchestration.
 * Handles environment probing, tier auto-detection, infrastructure wiring,
 * and execution lifecycle management.
 *
 * This is the recommended way to use Commander programmatically:
 *
 * @example
 * ```typescript
 * // Zero-config: auto-detects everything
 * const commander = await Commander.create();
 * const result = await commander.run('analyze this codebase');
 *
 * // With explicit config:
 * const commander = await Commander.create({
 *   provider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY,
 *   tier: 'team',
 * });
 * ```
 *
 * For remote/HTTP access, use @commander/sdk's CommanderClient instead.
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
exports.Commander = void 0;
const probe_1 = require("./commander/probe");
const tier_1 = require("./commander/tier");
const factory_1 = require("./commander/factory");
const logging_1 = require("./logging");
class Commander {
    constructor(wired, config, probe) {
        this.disposed = false;
        this.runtime = wired.runtime;
        this.config = config;
        this.probe = probe;
        this.startTime = Date.now();
    }
    // ==========================================================================
    // Factory
    // ==========================================================================
    /**
     * Get a human-readable status summary. */
    getStatus() {
        var _a, _b, _c, _d;
        return {
            tier: this.config.tier,
            provider: (_b = (_a = this.config.provider) === null || _a === void 0 ? void 0 : _a.type) !== null && _b !== void 0 ? _b : 'none',
            model: (_d = (_c = this.config.provider) === null || _c === void 0 ? void 0 : _c.defaultModel) !== null && _d !== void 0 ? _d : 'auto',
            uptime: `${Math.floor(this.uptimeMs / 1000)}s`,
            features: Object.entries(this.config.features)
                .filter(([, v]) => v)
                .map(([k]) => k),
            providerCount: this.probe.apiProviderCount,
            ollamaAvailable: this.probe.ollamaAvailable,
            vllmAvailable: this.probe.vllmAvailable,
            inKubernetes: this.probe.inKubernetes,
            redisAvailable: !!this.probe.redisUrl,
        };
    }
    // ==========================================================================
    // Factory
    // ==========================================================================
    /**
     * Create a Commander instance with full auto-detection.
     *
     * Probes the environment → determines the deployment tier → resolves
     * configuration → wires up the runtime → returns a ready-to-use instance.
     *
     * This is the primary entry point. Passing `options` overrides
     * auto-detected values.
     *
     * @example
     * ```typescript
     * // Hobbyist (local Ollama, no API keys needed)
     * const c = await Commander.create();
     *
     * // Team (OpenAI, file persistence)
     * const c = await Commander.create({ provider: 'openai' });
     *
     * // Enterprise (Redis, multi-tenant, K8s)
     * const c = await Commander.create({ tier: 'enterprise' });
     * ```
     */
    static async create(options) {
        const logger = (0, logging_1.getGlobalLogger)();
        // 1. Probe: detect what's available on the host
        const probe = await (0, probe_1.probeEnvironment)();
        logger.info('Commander', 'Environment probed', {
            providers: probe.availableProviders.length,
            ollama: probe.ollamaAvailable,
            vllm: probe.vllmAvailable,
            redis: !!probe.redisUrl,
            docker: probe.dockerAvailable,
            k8s: probe.inKubernetes,
        });
        // 2. Determine: what tier does this deployment run in?
        const tier = (0, tier_1.determineTier)(probe, options);
        logger.info('Commander', `Tier determined: ${tier}`);
        // 3. Resolve: compute the full configuration for this tier
        const config = (0, tier_1.resolveConfig)(tier, probe, options);
        // Validate: ensure we have a usable provider
        if (!config.provider) {
            throw new Error('No LLM provider available. ' +
                'Set an API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) ' +
                'or start a local model (Ollama, vLLM).');
        }
        // 4. Wire: create and configure the runtime
        const wired = await (0, factory_1.createWiredRuntime)(config);
        return new Commander(wired, config, probe);
    }
    // ==========================================================================
    // Execution
    // ==========================================================================
    /**
     * Run a task through the full Commander pipeline.
     *
     * @param task - The task/goal to execute (e.g., "Fix all TypeScript errors")
     * @param agentId - Optional agent identifier (default: 'commander')
     * @param availableTools - Optional list of tool names to enable (default: all)
     */
    async run(task, agentId = 'commander', availableTools) {
        var _a, _b;
        this.ensureActive();
        const result = await this.runtime.execute({
            projectId: 'commander',
            agentId,
            goal: task,
            contextData: {
                governanceProfile: { riskLevel: 'LOW' },
            },
            availableTools: availableTools !== null && availableTools !== void 0 ? availableTools : [],
            maxSteps: (_a = this.config.runtime.maxStepsPerRun) !== null && _a !== void 0 ? _a : 20,
            tokenBudget: (_b = this.config.runtime.budgetHardCapTokens) !== null && _b !== void 0 ? _b : 64000,
        });
        return this.formatResult(result);
    }
    /**
     * Plan a task without executing (deliberation + task decomposition only).
     */
    async plan(task) {
        const { deliberate } = await Promise.resolve().then(() => __importStar(require('./ultimate/index')));
        return deliberate(task);
    }
    // ==========================================================================
    // Introspection
    // ==========================================================================
    /** Get the detected deployment tier. */
    get tier() {
        return this.config.tier;
    }
    /** Get the resolved configuration. */
    get resolvedConfig() {
        return this.config;
    }
    /** Get the environment probe results. */
    get probeResult() {
        return this.probe;
    }
    /** Get the underlying AgentRuntime (for advanced usage). */
    getRuntime() {
        return this.runtime;
    }
    /** Get uptime in milliseconds. */
    get uptimeMs() {
        return Date.now() - this.startTime;
    }
    // ==========================================================================
    // Lifecycle
    // ==========================================================================
    /**
     * Gracefully shut down the Commander instance.
     * Cancels in-flight steps, flushes buffers, and releases resources.
     */
    async dispose() {
        if (this.disposed)
            return;
        this.runtime.cancelAllSteps();
        this.disposed = true;
    }
    ensureActive() {
        if (this.disposed) {
            throw new Error('Commander instance has been disposed. Create a new one with Commander.create().');
        }
    }
    // ==========================================================================
    // Internal
    // ==========================================================================
    formatResult(result) {
        var _a, _b, _c;
        return {
            status: result.status,
            summary: (_a = result.summary) !== null && _a !== void 0 ? _a : `Execution ${result.status}`,
            steps: ((_b = result.steps) !== null && _b !== void 0 ? _b : []).map((s) => {
                var _a, _b;
                return ({
                    stepNumber: s.stepNumber,
                    type: s.type,
                    content: (_b = (_a = s.content) === null || _a === void 0 ? void 0 : _a.slice(0, 500)) !== null && _b !== void 0 ? _b : '',
                    durationMs: s.durationMs,
                });
            }),
            tokenUsage: (_c = result.totalTokenUsage) !== null && _c !== void 0 ? _c : {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
            },
            durationMs: result.totalDurationMs,
            runId: result.runId,
            error: result.error,
        };
    }
}
exports.Commander = Commander;
