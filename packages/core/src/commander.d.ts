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
import type { ProbeResult } from './commander/probe';
import type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';
import type { AgentRuntimeInterface } from './runtime';
export type { ProbeResult } from './commander/probe';
export type { CommanderOptions, DeploymentTier, ResolvedConfig } from './commander/tier';
/**
 * Result of running a task through Commander.
 */
export interface CommanderResult {
    status: 'success' | 'failed' | 'partial' | 'cancelled' | 'interrupted';
    summary: string;
    steps: Array<{
        stepNumber: number;
        type: string;
        content: string;
        durationMs: number;
    }>;
    tokenUsage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    durationMs: number;
    runId: string;
    error?: string;
}
/** Status snapshot returned by Commander.getStatus(). */
export interface CommanderStatus {
    tier: string;
    provider: string;
    model: string;
    uptime: string;
    features: string[];
    providerCount: number;
    ollamaAvailable: boolean;
    vllmAvailable: boolean;
    inKubernetes: boolean;
    redisAvailable: boolean;
}
export declare class Commander {
    private runtime;
    private config;
    private probe;
    private startTime;
    private disposed;
    private constructor();
    /**
     * Get a human-readable status summary. */
    getStatus(): CommanderStatus;
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
    static create(options?: CommanderOptions): Promise<Commander>;
    /**
     * Run a task through the full Commander pipeline.
     *
     * @param task - The task/goal to execute (e.g., "Fix all TypeScript errors")
     * @param agentId - Optional agent identifier (default: 'commander')
     * @param availableTools - Optional list of tool names to enable (default: all)
     */
    run(task: string, agentId?: string, availableTools?: string[]): Promise<CommanderResult>;
    /**
     * Plan a task without executing (deliberation + task decomposition only).
     */
    plan(task: string): Promise<unknown>;
    /** Get the detected deployment tier. */
    get tier(): DeploymentTier;
    /** Get the resolved configuration. */
    get resolvedConfig(): Readonly<ResolvedConfig>;
    /** Get the environment probe results. */
    get probeResult(): Readonly<ProbeResult>;
    /** Get the underlying AgentRuntime (for advanced usage). */
    getRuntime(): AgentRuntimeInterface;
    /** Get uptime in milliseconds. */
    get uptimeMs(): number;
    /**
     * Gracefully shut down the Commander instance.
     * Cancels in-flight steps, flushes buffers, and releases resources.
     */
    dispose(): Promise<void>;
    private ensureActive;
    private formatResult;
}
//# sourceMappingURL=commander.d.ts.map