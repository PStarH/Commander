"use strict";
/**
 * Error Handler
 * Phase 2: 错误处理增强
 *
 * 提供统一的错误处理、恢复和重试机制
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorHandler = exports.InspectionError = exports.ConsensusError = exports.MemoryError = exports.BudgetExhaustedError = exports.OrchestrationError = exports.TaskComplexityError = exports.CommanderError = void 0;
exports.success = success;
exports.failure = failure;
exports.safeExecute = safeExecute;
exports.getGlobalErrorHandler = getGlobalErrorHandler;
exports.resetErrorHandler = resetErrorHandler;
const circuitBreaker_1 = require("./runtime/circuitBreaker");
const logging_1 = require("./logging");
// ========================================
// Error Types
// ========================================
class CommanderError extends Error {
    constructor(message, code, component, severity, context) {
        super(message);
        this.code = code;
        this.component = component;
        this.severity = severity;
        this.context = context;
        this.name = 'CommanderError';
    }
}
exports.CommanderError = CommanderError;
class TaskComplexityError extends CommanderError {
    constructor(message, context) {
        super(message, 'TASK_COMPLEXITY', 'TaskComplexityAnalyzer', 'medium', context);
    }
}
exports.TaskComplexityError = TaskComplexityError;
class OrchestrationError extends CommanderError {
    constructor(message, context) {
        super(message, 'ORCHESTRATION', 'AdaptiveOrchestrator', 'high', context);
    }
}
exports.OrchestrationError = OrchestrationError;
class BudgetExhaustedError extends CommanderError {
    constructor(message, context) {
        super(message, 'BUDGET_EXHAUSTED', 'TokenBudgetAllocator', 'critical', context);
    }
}
exports.BudgetExhaustedError = BudgetExhaustedError;
class MemoryError extends CommanderError {
    constructor(message, context) {
        super(message, 'MEMORY', 'ThreeLayerMemory', 'medium', context);
    }
}
exports.MemoryError = MemoryError;
class ConsensusError extends CommanderError {
    constructor(message, context) {
        super(message, 'CONSENSUS', 'ConsensusChecker', 'high', context);
    }
}
exports.ConsensusError = ConsensusError;
class InspectionError extends CommanderError {
    constructor(message, context) {
        super(message, 'INSPECTION', 'InspectorAgent', 'medium', context);
    }
}
exports.InspectionError = InspectionError;
const DEFAULT_CONFIG = {
    maxRetries: 3,
    retryDelayMs: 1000,
    exponentialBackoff: true,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 60000,
    maxErrors: 1000,
    enableLogging: true,
};
class ErrorHandler {
    constructor(config) {
        this.errors = [];
        this.circuitBreakers = new Map();
        this.errorListeners = [];
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Handle error with automatic retry
     */
    async handleWithRetry(operation, context) {
        let lastError;
        const component = context.component;
        const cb = this.getOrCreateBreaker(component);
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                // Check circuit breaker
                if (!cb.isAvailable()) {
                    const stats = cb.getStats();
                    throw new CommanderError(`Circuit breaker open for ${component}`, 'CIRCUIT_OPEN', component, 'high', { failures: stats.failureCount });
                }
                const result = await operation();
                // Success - reset circuit breaker
                cb.onSuccess();
                return result;
            }
            catch (error) {
                lastError = error;
                const commanderErr = error instanceof CommanderError ? error : this.wrapError(error, component);
                // Check if it's a retryable error
                if (!this.isRetryable(lastError)) {
                    this.recordError(commanderErr);
                    throw error;
                }
                // Record failure
                cb.onFailure();
                this.recordError(commanderErr);
                // Wait before retry
                if (attempt < this.config.maxRetries) {
                    const delay = this.config.exponentialBackoff
                        ? this.config.retryDelayMs * Math.pow(2, attempt)
                        : this.config.retryDelayMs;
                    if (this.config.enableLogging) {
                        (0, logging_1.getGlobalLogger)().warn('ErrorHandler', `Retry ${attempt + 1}/${this.config.maxRetries} for ${context.operation} after ${delay}ms`);
                    }
                    await this.sleep(delay);
                }
            }
        }
        // All retries exhausted
        this.recordError(this.wrapError(lastError, context.component));
        throw lastError;
    }
    /**
     * Wrap error in CommanderError
     */
    wrapError(error, component) {
        if (error instanceof CommanderError) {
            return error;
        }
        return new CommanderError(error.message, 'UNKNOWN', component, 'medium', {
            originalError: error.name,
        });
    }
    isRetryable(error) {
        if (error instanceof CommanderError) {
            const retryableCodes = new Set(['CIRCUIT_OPEN', 'TASK_COMPLEXITY']);
            const nonRetryableCodes = new Set([
                'INVALID_INPUT',
                'VALIDATION_ERROR',
                'PERMISSION_DENIED',
                'NOT_FOUND',
                'UNAUTHORIZED',
                'BUDGET_EXHAUSTED',
            ]);
            if (retryableCodes.has(error.code))
                return true;
            if (nonRetryableCodes.has(error.code))
                return false;
            return false;
        }
        const errCode = error.code;
        if (errCode) {
            const retryableNodeCodes = new Set([
                'ECONNRESET',
                'ETIMEDOUT',
                'ENOTFOUND',
                'ECONNREFUSED',
                'EPIPE',
                'EAI_AGAIN',
            ]);
            const nonRetryableNodeCodes = new Set([
                'ERR_INVALID_ARG_TYPE',
                'ERR_INVALID_ARG_VALUE',
                'ERR_ASSERTION',
                'MODULE_NOT_FOUND',
            ]);
            if (retryableNodeCodes.has(errCode))
                return true;
            if (nonRetryableNodeCodes.has(errCode))
                return false;
        }
        const message = error.message.toLowerCase();
        const retryablePatterns = ['network', 'timeout', 'temporary', 'econnreset', 'etimedout'];
        const isNetworkError = retryablePatterns.some((p) => message.includes(p));
        const nonRetryablePatterns = ['invalid', 'malformed', 'validation'];
        const isNonRetryable = nonRetryablePatterns.some((p) => message.includes(p));
        return isNetworkError && !isNonRetryable;
    }
    getOrCreateBreaker(component) {
        let cb = this.circuitBreakers.get(component);
        if (!cb) {
            cb = new circuitBreaker_1.CircuitBreaker(this.config.circuitBreakerThreshold, this.config.circuitBreakerCooldownMs, 1);
            this.circuitBreakers.set(component, cb);
        }
        return cb;
    }
    recordError(error) {
        this.errors.push({
            timestamp: new Date().toISOString(),
            error,
        });
        if (this.errors.length > this.config.maxErrors) {
            this.errors = this.errors.slice(-this.config.maxErrors);
        }
        for (const listener of this.errorListeners) {
            try {
                listener(error);
            }
            catch {
                /* listener threw — don't propagate */
            }
        }
        if (this.config.enableLogging) {
            const prefix = error.severity === 'critical' ? '❌' : error.severity === 'high' ? '⚠️' : '📋';
            (0, logging_1.getGlobalLogger)().error('ErrorHandler', `${prefix} [${error.component}] ${error.code}: ${error.message}`);
        }
    }
    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Add error listener
     */
    onError(listener) {
        this.errorListeners.push(listener);
    }
    /**
     * Remove error listener
     */
    offError(listener) {
        this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    }
    /**
     * Get recent errors
     */
    getRecentErrors(limit = 10) {
        return this.errors.slice(-limit);
    }
    /**
     * Get errors by component
     */
    getErrorsByComponent(component) {
        return this.errors.filter((e) => e.error.component === component);
    }
    /**
     * Get error statistics
     */
    getErrorStats() {
        const bySeverity = {};
        const byComponent = {};
        for (const { error } of this.errors) {
            bySeverity[error.severity] = (bySeverity[error.severity] || 0) + 1;
            byComponent[error.component] = (byComponent[error.component] || 0) + 1;
        }
        const circuitBreakerStatus = {};
        this.circuitBreakers.forEach((cb, component) => {
            const stats = cb.getStats();
            circuitBreakerStatus[component] = {
                failures: stats.failureCount,
                open: stats.state !== 'CLOSED',
            };
        });
        return {
            total: this.errors.length,
            bySeverity,
            byComponent,
            circuitBreakerStatus,
        };
    }
    /**
     * Clear errors
     */
    clear() {
        this.errors = [];
        this.circuitBreakers.clear();
    }
}
exports.ErrorHandler = ErrorHandler;
function success(data) {
    return { success: true, data };
}
function failure(error) {
    return { success: false, error };
}
// ========================================
// Safe Execute Wrapper
// ========================================
async function safeExecute(fn, errorHandler, component, operation) {
    try {
        const result = await errorHandler.handleWithRetry(fn, { component, operation });
        return success(result);
    }
    catch (error) {
        return failure(error);
    }
}
// ========================================
// Global Error Handler
// ========================================
const tenantAwareSingleton_1 = require("./runtime/tenantAwareSingleton");
const errorHandlerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ErrorHandler());
function getGlobalErrorHandler() {
    return errorHandlerSingleton.get();
}
function resetErrorHandler() {
    errorHandlerSingleton.reset();
}
