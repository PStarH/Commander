"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryControllerError = exports.RetryController = void 0;
exports.createRetryController = createRetryController;
exports.mergeRetryPolicy = mergeRetryPolicy;
class RetryController {
    constructor(policy) {
        this.policy = policy;
        this.consecutiveFailures = 0;
        this.circuitOpen = false;
        if (policy.maxAttempts < 1) {
            throw new RetryControllerError('maxAttempts must be >= 1');
        }
        if (policy.initialDelayMs < 0 || policy.maxDelayMs < 0) {
            throw new RetryControllerError('delay values must be non-negative');
        }
        if (policy.initialDelayMs > policy.maxDelayMs) {
            throw new RetryControllerError('initialDelayMs must be <= maxDelayMs');
        }
    }
    get policy_() {
        return this.policy;
    }
    computeDelay(attempt) {
        if (attempt < 1)
            return 0;
        const base = this.baseDelay(attempt);
        const capped = Math.min(base, this.policy.maxDelayMs);
        return this.applyJitter(capped);
    }
    shouldRetry(err, attempt) {
        if (this.circuitOpen)
            return false;
        if (attempt >= this.policy.maxAttempts)
            return false;
        if (this.policy.retryOn)
            return this.policy.retryOn(err);
        return true;
    }
    recordFailure() {
        this.consecutiveFailures++;
        if (this.policy.circuitBreakerAfter !== undefined &&
            this.consecutiveFailures >= this.policy.circuitBreakerAfter) {
            this.circuitOpen = true;
        }
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
    }
    resetCircuit() {
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
    }
    isCircuitOpen() {
        return this.circuitOpen;
    }
    get consecutiveFailureCount() {
        return this.consecutiveFailures;
    }
    baseDelay(attempt) {
        switch (this.policy.backoff) {
            case 'fixed':
                return this.policy.initialDelayMs;
            case 'linear':
                return this.policy.initialDelayMs * attempt;
            case 'exponential':
                return this.policy.initialDelayMs * Math.pow(2, attempt - 1);
        }
    }
    applyJitter(delay) {
        switch (this.policy.jitter) {
            case 'none':
                return delay;
            case 'full':
                return Math.floor(Math.random() * delay);
            case 'equal':
                return Math.floor(delay / 2 + Math.random() * (delay / 2));
        }
    }
}
exports.RetryController = RetryController;
class RetryControllerError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RetryControllerError';
    }
}
exports.RetryControllerError = RetryControllerError;
function createRetryController(policy) {
    return new RetryController(policy);
}
function mergeRetryPolicy(base, override) {
    var _a, _b, _c, _d, _e, _f, _g;
    return {
        maxAttempts: (_a = override.maxAttempts) !== null && _a !== void 0 ? _a : base.maxAttempts,
        backoff: (_b = override.backoff) !== null && _b !== void 0 ? _b : base.backoff,
        initialDelayMs: (_c = override.initialDelayMs) !== null && _c !== void 0 ? _c : base.initialDelayMs,
        maxDelayMs: (_d = override.maxDelayMs) !== null && _d !== void 0 ? _d : base.maxDelayMs,
        jitter: (_e = override.jitter) !== null && _e !== void 0 ? _e : base.jitter,
        retryOn: (_f = override.retryOn) !== null && _f !== void 0 ? _f : base.retryOn,
        circuitBreakerAfter: (_g = override.circuitBreakerAfter) !== null && _g !== void 0 ? _g : base.circuitBreakerAfter,
    };
}
