/**
 * Error Handler
 * Phase 2: 错误处理增强
 *
 * 提供统一的错误处理、恢复和重试机制
 */

import { reportSilentFailure } from './silentFailureReporter';
import { CircuitBreaker } from './runtime/circuitBreaker';
import { getGlobalLogger } from './logging';

// ========================================
// Error Types
// ========================================

export class CommanderError extends Error {
  constructor(
    message: string,
    public code: string,
    public component: string,
    public severity: 'low' | 'medium' | 'high' | 'critical',
    public context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CommanderError';
  }
}

export class TaskComplexityError extends CommanderError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'TASK_COMPLEXITY', 'TaskComplexityAnalyzer', 'medium', context);
  }
}

export class OrchestrationError extends CommanderError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'ORCHESTRATION', 'AdaptiveOrchestrator', 'high', context);
  }
}

export class BudgetExhaustedError extends CommanderError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'BUDGET_EXHAUSTED', 'TokenBudgetAllocator', 'critical', context);
  }
}

export class MemoryError extends CommanderError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'MEMORY', 'ThreeLayerMemory', 'medium', context);
  }
}

export class ConsensusError extends CommanderError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONSENSUS', 'ConsensusChecker', 'high', context);
  }
}

export class InspectionError extends CommanderError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'INSPECTION', 'InspectorAgent', 'medium', context);
  }
}

// ========================================
// Error Handler
// ========================================

export interface ErrorHandlerConfig {
  maxRetries: number;
  retryDelayMs: number;
  exponentialBackoff: boolean;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  maxErrors: number;
  enableLogging: boolean;
}

const DEFAULT_CONFIG: ErrorHandlerConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  exponentialBackoff: true,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 60000,
  maxErrors: 1000,
  enableLogging: true,
};

export class ErrorHandler {
  private config: ErrorHandlerConfig;
  private errors: Array<{ timestamp: string; error: CommanderError }> = [];
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private errorListeners: Array<(error: CommanderError) => void> = [];

  constructor(config?: Partial<ErrorHandlerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Handle error with automatic retry
   */
  async handleWithRetry<T>(
    operation: () => T | Promise<T>,
    context: { component: string; operation: string },
  ): Promise<T> {
    let lastError: Error | undefined;
    const component = context.component;
    const cb = this.getOrCreateBreaker(component);

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Check circuit breaker
        if (!cb.isAvailable()) {
          const stats = cb.getStats();
          throw new CommanderError(
            `Circuit breaker open for ${component}`,
            'CIRCUIT_OPEN',
            component,
            'high',
            { failures: stats.failureCount },
          );
        }

        const result = await operation();

        // Success - reset circuit breaker
        cb.onSuccess();
        return result;
      } catch (error) {
        lastError = error as Error;
        const commanderErr =
          error instanceof CommanderError ? error : this.wrapError(error as Error, component);

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
            getGlobalLogger().warn(
              'ErrorHandler',
              `Retry ${attempt + 1}/${this.config.maxRetries} for ${context.operation} after ${delay}ms`,
            );
          }

          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    this.recordError(this.wrapError(lastError!, context.component));
    throw lastError;
  }

  /**
   * Wrap error in CommanderError
   */
  private wrapError(error: Error, component: string): CommanderError {
    if (error instanceof CommanderError) {
      return error;
    }
    return new CommanderError(error.message, 'UNKNOWN', component, 'medium', {
      originalError: error.name,
    });
  }

  private isRetryable(error: Error): boolean {
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
      if (retryableCodes.has(error.code)) return true;
      if (nonRetryableCodes.has(error.code)) return false;
      return false;
    }

    const errCode = (error as NodeJS.ErrnoException).code;
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
      if (retryableNodeCodes.has(errCode)) return true;
      if (nonRetryableNodeCodes.has(errCode)) return false;
    }

    const message = error.message.toLowerCase();
    const retryablePatterns = ['network', 'timeout', 'temporary', 'econnreset', 'etimedout'];
    const isNetworkError = retryablePatterns.some((p) => message.includes(p));
    const nonRetryablePatterns = ['invalid', 'malformed', 'validation'];
    const isNonRetryable = nonRetryablePatterns.some((p) => message.includes(p));

    return isNetworkError && !isNonRetryable;
  }

  private getOrCreateBreaker(component: string): CircuitBreaker {
    let cb = this.circuitBreakers.get(component);
    if (!cb) {
      cb = new CircuitBreaker(
        this.config.circuitBreakerThreshold,
        this.config.circuitBreakerCooldownMs,
        1,
      );
      this.circuitBreakers.set(component, cb);
    }
    return cb;
  }

  private recordError(error: CommanderError): void {
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
      } catch (err) {
        reportSilentFailure(err, 'errorHandler:250');
        /* listener threw — don't propagate */
      }
    }

    if (this.config.enableLogging) {
      const prefix = error.severity === 'critical' ? '❌' : error.severity === 'high' ? '⚠️' : '📋';
      getGlobalLogger().error(
        'ErrorHandler',
        `${prefix} [${error.component}] ${error.code}: ${error.message}`,
      );
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Add error listener
   */
  onError(listener: (error: CommanderError) => void): void {
    this.errorListeners.push(listener);
  }

  /**
   * Remove error listener
   */
  offError(listener: (error: CommanderError) => void): void {
    this.errorListeners = this.errorListeners.filter((l) => l !== listener);
  }

  /**
   * Get recent errors
   */
  getRecentErrors(limit: number = 10): Array<{ timestamp: string; error: CommanderError }> {
    return this.errors.slice(-limit);
  }

  /**
   * Get errors by component
   */
  getErrorsByComponent(component: string): Array<{ timestamp: string; error: CommanderError }> {
    return this.errors.filter((e) => e.error.component === component);
  }

  /**
   * Get error statistics
   */
  getErrorStats(): {
    total: number;
    bySeverity: Record<string, number>;
    byComponent: Record<string, number>;
    circuitBreakerStatus: Record<string, { failures: number; open: boolean }>;
  } {
    const bySeverity: Record<string, number> = {};
    const byComponent: Record<string, number> = {};

    for (const { error } of this.errors) {
      bySeverity[error.severity] = (bySeverity[error.severity] || 0) + 1;
      byComponent[error.component] = (byComponent[error.component] || 0) + 1;
    }

    const circuitBreakerStatus: Record<string, { failures: number; open: boolean }> = {};
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
  clear(): void {
    this.errors = [];
    this.circuitBreakers.clear();
  }
}

// ========================================
// Result Type
// ========================================

export type Result<T> = { success: true; data: T } | { success: false; error: CommanderError };

export function success<T>(data: T): Result<T> {
  return { success: true, data };
}

export function failure<T>(error: CommanderError): Result<T> {
  return { success: false, error };
}

// ========================================
// Safe Execute Wrapper
// ========================================

export async function safeExecute<T>(
  fn: () => T | Promise<T>,
  errorHandler: ErrorHandler,
  component: string,
  operation: string,
): Promise<Result<T>> {
  try {
    const result = await errorHandler.handleWithRetry(fn, { component, operation });
    return success(result);
  } catch (error) {
    return failure(error as CommanderError);
  }
}

// ========================================
// Global Error Handler
// ========================================

import { createTenantAwareSingleton } from './runtime/tenantAwareSingleton';

const errorHandlerSingleton = createTenantAwareSingleton(() => new ErrorHandler());

export function getGlobalErrorHandler(): ErrorHandler {
  return errorHandlerSingleton.get();
}

export function resetErrorHandler(): void {
  errorHandlerSingleton.reset();
}
