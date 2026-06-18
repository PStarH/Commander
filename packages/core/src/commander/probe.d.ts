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
export interface ProbeResult {
    /** API keys found in environment variables */
    availableProviders: string[];
    /** Is Docker socket accessible? */
    dockerAvailable: boolean;
    /** Redis URL from env or detected */
    redisUrl: string | null;
    /** Is Ollama running locally? */
    ollamaAvailable: boolean;
    /** Is vLLM running locally? */
    vllmAvailable: boolean;
    /** Running inside Kubernetes? */
    inKubernetes: boolean;
    /** K8s namespace if applicable */
    k8sNamespace: string | null;
    /** Available env-based config keys */
    envKeys: string[];
    /** Number of detected API providers */
    apiProviderCount: number;
}
/** Result of testing connectivity to a single provider. */
export interface ConnectivityResult {
    provider: string;
    /** Human-readable display name */
    displayName: string;
    /** 'reachable' | 'unreachable' | 'auth_error' | 'timeout' | 'skipped' */
    status: 'reachable' | 'unreachable' | 'auth_error' | 'timeout' | 'skipped';
    /** Latency in milliseconds (only for reachable) */
    latencyMs?: number;
    /** Error message if not reachable */
    error?: string;
    /** Provider tier recommendation */
    tier: 'local' | 'cloud' | 'premium';
    /** Default model */
    defaultModel: string;
}
/**
 * Test connectivity for all detected providers in parallel.
 * Returns results sorted by latency (fastest first), with unreachable
 * providers at the end.
 */
export declare function testConnectivity(availableProviders: string[], timeoutMs?: number): Promise<ConnectivityResult[]>;
/**
 * Build a recommended fallback chain from connectivity results.
 * Returns an array of provider names in priority order (fastest → fallback).
 */
export declare function recommendFallbackChain(results: ConnectivityResult[]): string[];
/**
 * Probe the environment to determine available capabilities.
 * All checks are best-effort with timeouts — returns partial results
 * rather than failing on any single check.
 */
export declare function probeEnvironment(): Promise<ProbeResult>;
//# sourceMappingURL=probe.d.ts.map