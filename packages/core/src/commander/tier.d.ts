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
import type { ProbeResult } from './probe';
import type { AgentRuntimeConfig } from '../runtime/types';
import type { TenantConfig } from '../runtime/tenantProvider';
export type DeploymentTier = 'hobbyist' | 'team' | 'enterprise';
export interface CommanderOptions {
    /** Force a specific tier. If set, skips environment probing for tier selection. */
    tier?: DeploymentTier;
    /** Preferred provider (e.g. 'openai', 'anthropic'). Overrides env detection priority. */
    provider?: string;
    /** API key for the selected provider. */
    apiKey?: string;
    /** Model ID override. */
    model?: string;
    /** Base URL override for provider API. */
    baseUrl?: string;
    /** Token budget override (defaults: hobbyist=16000, team=64000, enterprise=200000). */
    tokenBudget?: number;
    /** Max concurrent runs override. */
    maxConcurrency?: number;
    /** Workspace root for file operations. */
    workspacePath?: string;
    /** Arbitrary metadata passed through to runtime config. */
    metadata?: Record<string, string>;
}
export interface ResolvedConfig {
    /** Detected or forced deployment tier. */
    tier: DeploymentTier;
    /** Runtime configuration for AgentRuntime. */
    runtime: Partial<AgentRuntimeConfig>;
    /** Provider configuration. */
    provider: {
        type: string;
        apiKey?: string;
        baseUrl?: string;
        defaultModel?: string;
    } | null;
    /** Tenant configuration. */
    tenant: {
        provider: 'null' | 'simple' | 'multi';
        configs?: TenantConfig[];
    };
    /** Persistence configuration. */
    persistence: {
        type: 'memory' | 'file' | 'redis';
        /** Path for file-based persistence (.commander/ directory). */
        path?: string;
        /** Redis URL for distributed persistence. */
        redisUrl?: string;
    };
    /** Feature flags based on tier. */
    features: {
        /** Enable OTel export. */
        otelExport: boolean;
        /** Enable multi-tenant isolation. */
        multiTenant: boolean;
        /** Enable semantic cache. */
        semanticCache: boolean;
        /** Enable durable compensation queue. */
        durableCompensation: boolean;
        /** Enable Prometheus metrics export. */
        prometheusMetrics: boolean;
        /** Enable crash-safe checkpoints. */
        crashSafeCheckpoints: boolean;
        /** Enable model learning (cross-session performance tracking). */
        modelLearning: boolean;
    };
}
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
export declare function determineTier(probe: ProbeResult, options?: CommanderOptions): DeploymentTier;
/**
 * Resolve the full configuration for a given deployment tier.
 * Merges tier defaults with user-provided options.
 */
export declare function resolveConfig(tier: DeploymentTier, probe: ProbeResult, options?: CommanderOptions): ResolvedConfig;
//# sourceMappingURL=tier.d.ts.map