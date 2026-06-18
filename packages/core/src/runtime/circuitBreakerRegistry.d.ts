/**
 * Circuit Breaker Registry — Named circuit breaker management for per-tool/per-provider fault isolation.
 *
 * Wraps individual CircuitBreaker instances with a registry that provides
 * named access, lazy initialization, aggregated stats, and bulk reset.
 * Each tool or provider gets its own breaker so a failure in one doesn't
 * cascade to others.
 *
 * Used by ToolOrchestrator and AgentRuntime to track per-call reliability.
 */
import { CircuitBreaker, type CircuitStats } from './circuitBreaker';
export interface BreakerConfig {
    threshold: number;
    recoveryTimeMs: number;
    halfOpenMaxTests: number;
}
export declare class CircuitBreakerRegistry {
    private breakers;
    private configs;
    private lastAccess;
    private readonly MAX_IDLE_MS;
    private pruneTimer;
    constructor();
    private pruneIdle;
    register(name: string, config?: Partial<BreakerConfig>): CircuitBreaker;
    get(name: string): CircuitBreaker | undefined;
    isAvailable(name: string): boolean;
    onSuccess(name: string): void;
    onFailure(name: string): void;
    getStats(name: string): CircuitStats;
    getOpenBreakers(): string[];
    reset(name: string): void;
    /** Remove a breaker from the registry */
    deregister(name: string): boolean;
    resetAll(): void;
    listBreakers(): string[];
    dispose(): void;
}
//# sourceMappingURL=circuitBreakerRegistry.d.ts.map