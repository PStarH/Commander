"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = void 0;
class CircuitBreaker {
    constructor(threshold = 5, recoveryTimeMs = 30000, halfOpenMaxTests = 1, onStateChange, options) {
        var _a, _b, _c, _d;
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = 0;
        this.halfOpenTests = 0;
        this.halfOpenInFlight = 0;
        this.openCount = 0;
        /** Sliding window of failure timestamps for windowed failure counting */
        this.failureTimestamps = [];
        /** Sliding window of all request timestamps for volume threshold (Hystrix pattern) */
        this.requestTimestamps = [];
        // Semantic drift tracking (P1: semantic circuit breaker)
        this.consecutiveSemanticFailures = 0;
        this.semanticFailureThreshold = 3;
        this.lastSemanticFailureTime = 0;
        // Aggregated counters for semantic drift and security events
        this.semanticFailureCount = 0;
        this.securityEventCount = 0;
        this.threshold = threshold;
        this.recoveryTimeMs = recoveryTimeMs;
        this.halfOpenMaxTests = halfOpenMaxTests;
        this.onStateChange = onStateChange;
        this.volumeThreshold = (_a = options === null || options === void 0 ? void 0 : options.volumeThreshold) !== null && _a !== void 0 ? _a : 0;
        this.errorRateThreshold = (_b = options === null || options === void 0 ? void 0 : options.errorRateThreshold) !== null && _b !== void 0 ? _b : 0.5;
        this.semanticThreshold = (_c = options === null || options === void 0 ? void 0 : options.semanticThreshold) !== null && _c !== void 0 ? _c : 3;
        this.securityThreshold = (_d = options === null || options === void 0 ? void 0 : options.securityThreshold) !== null && _d !== void 0 ? _d : 2;
    }
    setProviderName(name) {
        this.providerName = name;
    }
    setObservability(obs) {
        this.observability = obs;
    }
    getState() {
        return this.state;
    }
    getStats() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            threshold: this.threshold,
            recoveryTimeMs: this.recoveryTimeMs,
            openCount: this.openCount,
            semanticFailureCount: this.semanticFailureCount,
            securityEventCount: this.securityEventCount,
        };
    }
    isAvailable() {
        // Trip the circuit if semantic failures or security events exceed their thresholds,
        // even when conventional operational failures have not reached the volume/error rate gate.
        if (this.semanticFailureCount >= this.semanticThreshold ||
            this.securityEventCount >= this.securityThreshold) {
            if (this.state !== 'OPEN') {
                this.transitionTo('OPEN');
                this.openCount++;
            }
            return false;
        }
        if (this.state === 'CLOSED')
            return true;
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
                this.transitionTo('HALF_OPEN');
                this.halfOpenTests = 0;
                this.halfOpenInFlight = 1;
                return true;
            }
            return false;
        }
        if (this.halfOpenInFlight < this.halfOpenMaxTests) {
            this.halfOpenInFlight++;
            return true;
        }
        return false;
    }
    onSuccess() {
        this.successCount++;
        this.failureCount = 0;
        this.requestTimestamps.push(Date.now());
        if (this.state === 'HALF_OPEN') {
            this.halfOpenTests++;
            // Only close circuit after enough consecutive successes (multi-probe recovery)
            if (this.halfOpenTests >= this.halfOpenMaxTests) {
                this.transitionTo('CLOSED');
                this.halfOpenTests = 0;
                this.halfOpenInFlight = 0;
            }
        }
    }
    /** Decrement halfOpenInFlight without recording success/failure (for callers that throw before reporting). */
    release() {
        if (this.state === 'HALF_OPEN') {
            this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
        }
    }
    onFailure() {
        const now = Date.now();
        this.failureCount++;
        this.lastFailureTime = now;
        // Track failure in sliding window (prune entries older than recoveryTimeMs)
        this.failureTimestamps.push(now);
        this.requestTimestamps.push(now);
        const windowStart = now - this.recoveryTimeMs;
        this.failureTimestamps = this.failureTimestamps.filter((t) => t > windowStart);
        this.requestTimestamps = this.requestTimestamps.filter((t) => t > windowStart);
        if (this.state === 'HALF_OPEN') {
            this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
        }
        // Hystrix pattern: trip when BOTH volume threshold AND error rate are met
        const windowedFailures = this.failureTimestamps.length;
        const windowedRequests = this.requestTimestamps.length;
        const volumeMet = windowedRequests >= this.volumeThreshold;
        const errorRate = windowedRequests > 0 ? windowedFailures / windowedRequests : 0;
        const errorRateMet = errorRate >= this.errorRateThreshold;
        if (this.state === 'HALF_OPEN' ||
            (volumeMet && errorRateMet && windowedFailures >= this.threshold)) {
            if (this.state !== 'OPEN') {
                this.transitionTo('OPEN');
                this.openCount++;
            }
        }
    }
    /**
     * Record a semantic/quality failure (e.g., verification failed, hallucination detected).
     * Tracks consecutive failures as a proxy for semantic drift.
     * When threshold is reached, fires onSemanticTrip callback.
     * This is separate from operational failures (network errors, timeouts).
     */
    recordSemanticFailure(reason) {
        var _a;
        this.consecutiveSemanticFailures++;
        this.lastSemanticFailureTime = Date.now();
        if (this.consecutiveSemanticFailures >= this.semanticFailureThreshold) {
            (_a = this.onSemanticTrip) === null || _a === void 0 ? void 0 : _a.call(this, this.consecutiveSemanticFailures, reason);
        }
    }
    /** Reset semantic failure counter after a successful recovery. */
    recordSemanticSuccess() {
        this.consecutiveSemanticFailures = 0;
    }
    /** Get current semantic health status. */
    getSemanticHealth() {
        return {
            consecutiveFailures: this.consecutiveSemanticFailures,
            tripped: this.consecutiveSemanticFailures >= this.semanticFailureThreshold,
            lastFailureTime: this.lastSemanticFailureTime,
        };
    }
    /** Set callback for semantic trip events. */
    setSemanticTripHandler(handler) {
        this.onSemanticTrip = handler;
    }
    /**
     * Record a semantic drift event with a severity score (0-1).
     * Increments the aggregated semantic failure counter; when the configured
     * threshold is reached, subsequent isAvailable() calls will keep the circuit open.
     */
    onSemanticDrift(score) {
        if (score > 0) {
            this.semanticFailureCount++;
            this.lastSemanticFailureTime = Date.now();
        }
    }
    /**
     * Record a security event (e.g., HIGH/CRITICAL content threat detected).
     * Critical events count for 2, others for 1. When the security threshold is
     * reached, the circuit stays open until reset.
     */
    onSecurityEvent(severity) {
        const weight = severity === 'CRITICAL' ? 2 : severity === 'HIGH' ? 1 : 0;
        if (weight > 0) {
            this.securityEventCount += weight;
            this.lastSemanticFailureTime = Date.now();
        }
    }
    reset() {
        var _a;
        const was = this.state;
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.halfOpenTests = 0;
        this.halfOpenInFlight = 0;
        this.failureTimestamps = [];
        this.requestTimestamps = [];
        this.consecutiveSemanticFailures = 0;
        this.semanticFailureCount = 0;
        this.securityEventCount = 0;
        if (was !== 'CLOSED')
            (_a = this.onStateChange) === null || _a === void 0 ? void 0 : _a.call(this, was, 'CLOSED');
    }
    transitionTo(newState) {
        var _a, _b, _c;
        const old = this.state;
        if (old !== newState) {
            this.state = newState;
            (_a = this.onStateChange) === null || _a === void 0 ? void 0 : _a.call(this, old, newState);
            try {
                (_c = (_b = this.observability) === null || _b === void 0 ? void 0 : _b.onTransition) === null || _c === void 0 ? void 0 : _c.call(_b, old, newState, this.providerName);
            }
            catch {
                /* best-effort */
            }
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
