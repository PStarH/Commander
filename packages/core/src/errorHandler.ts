/**
 * Error Handler
 * Phase 2: 错误处理增强
 * 
 * 提供统一的错误处理、恢复和重试机制
 */

// ========================================
// Error Types
// ========================================

export class CommanderError extends Error {
  constructor(
    message: string,
    public code: string,
    public component: string,
    public severity: 'low' | 'medium' | 'high' | 'critical',
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'CommanderError';
  }
}

export class TaskComplexityError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'TASK_COMPLEXITY', 'TaskComplexityAnalyzer', 'medium', context);
  }
}

export class OrchestrationError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'ORCHESTRATION', 'AdaptiveOrchestrator', 'high', context);
  }
}

export class BudgetExhaustedError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'BUDGET_EXHAUSTED', 'TokenBudgetAllocator', 'critical', context);
  }
}

export class MemoryError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'MEMORY', 'ThreeLayerMemory', 'medium', context);
  }
}

export class ConsensusError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONSENSUS', 'ConsensusChecker', 'high', context);
  }
}

export class InspectionError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
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
  enableLogging: boolean;
}

const DEFAULT_CONFIG: ErrorHandlerConfig = {
  maxRetries: 3,
  retryDelayMs: 1000,
  exponentialBackoff: true,
  circuitBreakerThreshold: 5,
  enableLogging: true
};

export class ErrorHandler {
  private config: ErrorHandlerConfig;
  private errors: Array<{ timestamp: string; error: CommanderError }> = [];
  private circuitBreakerState: Map<string, { failures: number; lastFailure: string }> = new Map();
  private errorListeners: Array<(error: CommanderError) => void> = [];

  constructor(config?: Partial<ErrorHandlerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Handle error with automatic retry
   */
  async handleWithRetry<T>(
    operation: () => T | Promise<T>,
    context: { component: string; operation: string }
  ): Promise<T> {
    let lastError: Error | undefined;
    const component = context.component;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        // Check circuit breaker
        if (this.isCircuitOpen(component)) {
          throw new CommanderError(
            `Circuit breaker open for ${component}`,
            'CIRCUIT_OPEN',
            component,
            'high',
            { failures: this.getFailureCount(component) }
          );
        }

        const result = await operation();
        
        // Success - reset circuit breaker
        this.resetCircuitBreaker(component);
        return result;

      } catch (error) {
        lastError = error as Error;
        
        // Check if it's a retryable error
        if (!this.isRetryable(error as Error)) {
          this.recordError(lastError as CommanderError);
          throw error;
        }

        // Record failure
        this.recordFailure(component);
        this.recordError(this.wrapError(lastError, context.component));

        // Wait before retry
        if (attempt < this.config.maxRetries) {
          const delay = this.config.exponentialBackoff
            ? this.config.retryDelayMs * Math.pow(2, attempt)
            : this.config.retryDelayMs;
          
          if (this.config.enableLogging) {
            console.warn(`Retry ${attempt + 1}/${this.config.maxRetries} for ${context.operation} after ${delay}ms`);
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
    return new CommanderError(
      error.message,
      'UNKNOWN',
      component,
      'medium',
      { originalError: error.name }
    );
  }

  /**
   * Check if error is retryable
   */
  private isRetryable(error: Error): boolean {
    // Network errors, timeouts are retryable
    const retryablePatterns = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'network',
      'timeout',
      'temporary'
    ];

    const message = error.message.toLowerCase();
    const isNetworkError = retryablePatterns.some(p => message.includes(p));

    // Don't retry validation errors or logic errors
    const nonRetryablePatterns = ['invalid', 'malformed', 'validation'];
    const isNonRetryable = nonRetryablePatterns.some(p => message.includes(p));

    return isNetworkError && !isNonRetryable;
  }

  /**
   * Circuit breaker: check if circuit is open
   */
  private isCircuitOpen(component: string): boolean {
    const state = this.circuitBreakerState.get(component);
    if (!state) return false;

    const threshold = this.config.circuitBreakerThreshold;
    if (state.failures < threshold) return false;

    // Check if enough time has passed to try again
    const lastFailure = new Date(state.lastFailure).getTime();
    const now = Date.now();
    const cooldownMs = 60000; // 1 minute cooldown

    return now - lastFailure < cooldownMs;
  }

  /**
   * Record failure for circuit breaker
   */
  private recordFailure(component: string): void {
    const existing = this.circuitBreakerState.get(component);
    if (existing) {
      existing.failures++;
      existing.lastFailure = new Date().toISOString();
    } else {
      this.circuitBreakerState.set(component, {
        failures: 1,
        lastFailure: new Date().toISOString()
      });
    }
  }

  /**
   * Reset circuit breaker on success
   */
  private resetCircuitBreaker(component: string): void {
    this.circuitBreakerState.delete(component);
  }

  /**
   * Get failure count for component
   */
  private getFailureCount(component: string): number {
    return this.circuitBreakerState.get(component)?.failures || 0;
  }

  /**
   * Record error
   */
  private recordError(error: CommanderError): void {
    this.errors.push({
      timestamp: new Date().toISOString(),
      error
    });

    // Notify listeners
    this.errorListeners.forEach(listener => listener(error));

    // Log if enabled
    if (this.config.enableLogging) {
      const prefix = error.severity === 'critical' ? '❌' : error.severity === 'high' ? '⚠️' : '📋';
      console.error(`${prefix} [${error.component}] ${error.code}: ${error.message}`);
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    this.errorListeners = this.errorListeners.filter(l => l !== listener);
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
    return this.errors.filter(e => e.error.component === component);
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
    this.circuitBreakerState.forEach((state, component) => {
      circuitBreakerStatus[component] = {
        failures: state.failures,
        open: this.isCircuitOpen(component)
      };
    });

    return {
      total: this.errors.length,
      bySeverity,
      byComponent,
      circuitBreakerStatus
    };
  }

  /**
   * Clear errors
   */
  clear(): void {
    this.errors = [];
  }
}

// ========================================
// Result Type
// ========================================

export type Result<T> = 
  | { success: true; data: T }
  | { success: false; error: CommanderError };

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
  operation: string
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

let globalErrorHandler: ErrorHandler | null = null;

export function getGlobalErrorHandler(): ErrorHandler {
  if (!globalErrorHandler) {
    globalErrorHandler = new ErrorHandler();
  }
  return globalErrorHandler;
}