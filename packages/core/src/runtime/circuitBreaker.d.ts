export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export interface CircuitStats {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number;
    threshold: number;
    recoveryTimeMs: number;
    openCount: number;
    semanticFailureCount: number;
    securityEventCount: number;
}
export declare class CircuitBreaker {
    private state;
    private failureCount;
    private successCount;
    private lastFailureTime;
    private threshold;
    private recoveryTimeMs;
    private halfOpenMaxTests;
    private halfOpenTests;
    private halfOpenInFlight;
    private openCount;
    private onStateChange?;
    private observability?;
    private providerName?;
    /** Sliding window of failure timestamps for windowed failure counting */
    private failureTimestamps;
    /** Sliding window of all request timestamps for volume threshold (Hystrix pattern) */
    private requestTimestamps;
    /** Minimum requests in window before circuit can trip (Hystrix: circuitBreakerRequestVolumeThreshold) */
    private volumeThreshold;
    /** Error rate threshold (0-1) to trip circuit (Hystrix: circuitBreakerErrorThresholdPercentage) */
    private errorRateThreshold;
    private consecutiveSemanticFailures;
    private semanticFailureThreshold;
    private lastSemanticFailureTime;
    private onSemanticTrip?;
    private semanticFailureCount;
    private securityEventCount;
    private semanticThreshold;
    private securityThreshold;
    constructor(threshold?: number, recoveryTimeMs?: number, halfOpenMaxTests?: number, onStateChange?: (from: CircuitState, to: CircuitState) => void, options?: {
        volumeThreshold?: number;
        errorRateThreshold?: number;
        semanticThreshold?: number;
        securityThreshold?: number;
    });
    setProviderName(name: string): void;
    setObservability(obs: {
        onTransition?: (from: CircuitState, to: CircuitState, provider?: string) => void;
    }): void;
    getState(): CircuitState;
    getStats(): CircuitStats;
    isAvailable(): boolean;
    onSuccess(): void;
    /** Decrement halfOpenInFlight without recording success/failure (for callers that throw before reporting). */
    release(): void;
    onFailure(): void;
    /**
     * Record a semantic/quality failure (e.g., verification failed, hallucination detected).
     * Tracks consecutive failures as a proxy for semantic drift.
     * When threshold is reached, fires onSemanticTrip callback.
     * This is separate from operational failures (network errors, timeouts).
     */
    recordSemanticFailure(reason: string): void;
    /** Reset semantic failure counter after a successful recovery. */
    recordSemanticSuccess(): void;
    /** Get current semantic health status. */
    getSemanticHealth(): {
        consecutiveFailures: number;
        tripped: boolean;
        lastFailureTime: number;
    };
    /** Set callback for semantic trip events. */
    setSemanticTripHandler(handler: (consecutiveFailures: number, reason: string) => void): void;
    /**
     * Record a semantic drift event with a severity score (0-1).
     * Increments the aggregated semantic failure counter; when the configured
     * threshold is reached, subsequent isAvailable() calls will keep the circuit open.
     */
    onSemanticDrift(score: number): void;
    /**
     * Record a security event (e.g., HIGH/CRITICAL content threat detected).
     * Critical events count for 2, others for 1. When the security threshold is
     * reached, the circuit stays open until reset.
     */
    onSecurityEvent(severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): void;
    reset(): void;
    private transitionTo;
}
//# sourceMappingURL=circuitBreaker.d.ts.map