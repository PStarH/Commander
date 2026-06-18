"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerRegistry = void 0;
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
const circuitBreaker_1 = require("./circuitBreaker");
const logging_1 = require("../logging");
const DEFAULT_BREAKER_CONFIG = {
    threshold: 5,
    recoveryTimeMs: 60000,
    halfOpenMaxTests: 1,
};
class CircuitBreakerRegistry {
    constructor() {
        var _a;
        this.breakers = new Map();
        this.configs = new Map();
        this.lastAccess = new Map();
        this.MAX_IDLE_MS = 30 * 60 * 1000; // 30 minutes
        this.pruneTimer = null;
        this.pruneTimer = setInterval(() => this.pruneIdle(), this.MAX_IDLE_MS);
        if ((_a = this.pruneTimer) === null || _a === void 0 ? void 0 : _a.unref)
            this.pruneTimer.unref();
    }
    pruneIdle() {
        var _a;
        const now = Date.now();
        for (const [name, breaker] of this.breakers) {
            const last = (_a = this.lastAccess.get(name)) !== null && _a !== void 0 ? _a : 0;
            if (breaker.getState() === 'CLOSED' && now - last > this.MAX_IDLE_MS) {
                this.breakers.delete(name);
                this.configs.delete(name);
                this.lastAccess.delete(name);
            }
        }
    }
    register(name, config) {
        if (this.breakers.has(name)) {
            return this.breakers.get(name);
        }
        const merged = { ...DEFAULT_BREAKER_CONFIG, ...config };
        this.configs.set(name, merged);
        const breaker = new circuitBreaker_1.CircuitBreaker(merged.threshold, merged.recoveryTimeMs, merged.halfOpenMaxTests, (from, to) => {
            if (to === 'OPEN') {
                (0, logging_1.getGlobalLogger)().warn('CircuitBreakerRegistry', `"${name}" opened (${from}→OPEN, ${this.getStats(name).failureCount} failures)`);
            }
            if (to === 'CLOSED') {
                (0, logging_1.getGlobalLogger)().info('CircuitBreakerRegistry', `"${name}" closed (${from}→CLOSED)`);
            }
        });
        this.breakers.set(name, breaker);
        return breaker;
    }
    get(name) {
        const breaker = this.breakers.get(name);
        if (breaker)
            this.lastAccess.set(name, Date.now());
        return breaker;
    }
    isAvailable(name) {
        var _a, _b;
        return (_b = (_a = this.breakers.get(name)) === null || _a === void 0 ? void 0 : _a.isAvailable()) !== null && _b !== void 0 ? _b : true;
    }
    onSuccess(name) {
        var _a;
        (_a = this.breakers.get(name)) === null || _a === void 0 ? void 0 : _a.onSuccess();
    }
    onFailure(name) {
        var _a;
        (_a = this.breakers.get(name)) === null || _a === void 0 ? void 0 : _a.onFailure();
    }
    getStats(name) {
        const breaker = this.breakers.get(name);
        if (!breaker) {
            return {
                state: 'CLOSED',
                failureCount: 0,
                successCount: 0,
                lastFailureTime: 0,
                threshold: 0,
                recoveryTimeMs: 0,
                openCount: 0,
                semanticFailureCount: 0,
                securityEventCount: 0,
            };
        }
        return breaker.getStats();
    }
    getOpenBreakers() {
        const open = [];
        for (const [name, breaker] of this.breakers) {
            if (breaker.getState() === 'OPEN')
                open.push(name);
        }
        return open;
    }
    reset(name) {
        var _a;
        (_a = this.breakers.get(name)) === null || _a === void 0 ? void 0 : _a.reset();
    }
    /** Remove a breaker from the registry */
    deregister(name) {
        this.configs.delete(name);
        return this.breakers.delete(name);
    }
    resetAll() {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }
    listBreakers() {
        return Array.from(this.breakers.keys());
    }
    dispose() {
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
    }
}
exports.CircuitBreakerRegistry = CircuitBreakerRegistry;
