/**
 * Error Handling System
 * Phase 2: 错误处理增强
 * 
 * Provides comprehensive error handling, retry logic, and fallback mechanisms
 */

// ========================================
// Error Types
// ========================================

export class CommanderError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'CommanderError';
  }
}

export class ValidationError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', context);
    this.name = 'ValidationError';
  }
}

export class ResourceError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'RESOURCE_ERROR', context);
    this.name = 'ResourceError';
  }
}

export class TimeoutError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'TIMEOUT_ERROR', context);
    this.name = 'TimeoutError';
  }
}

export class ConsensusError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONSENSUS_ERROR', context);
    this.name = 'ConsensusError';
  }
}

export class MemoryError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'MEMORY_ERROR', context);
    this.name = 'MemoryError';
  }
}

// ========================================
// Result Type (Railway-Oriented Programming)
// ========================================

export type Result<T, E extends Error = CommanderError> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<E extends Error = CommanderError>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ========================================
// Retry Configuration
// ========================================

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[];  // Error codes to retry
  nonRetryableErrors?: string[]; // Error codes to NOT retry
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableErrors: [
    'TIMEOUT_ERROR',
    'NETWORK_ERROR',
    'RESOURCE_ERROR'
  ],
  nonRetryableErrors: [
    'VALIDATION_ERROR',
    'CONSENSUS_ERROR'
  ]
};

// ========================================
// Retry Handler
// ========================================

export class RetryHandler {
  private config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Execute function with retry logic
   */
  async execute<T>(
    fn: () => Promise<T>,
    onRetry?: (attempt: number, error: Error, delay: number) => void
  ): Promise<T> {
    let lastError: Error;
    let delay = this.config.initialDelayMs;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        
        // Check if should retry
        if (!this.shouldRetry(lastError as CommanderError)) {
          throw lastError;
        }

        // Last attempt, don't retry
        if (attempt === this.config.maxAttempts) {
          break;
        }

        // Notify callback
        onRetry?.(attempt, lastError, delay);

        // Wait before retry
        await this.sleep(delay);
        
        // Exponential backoff
        delay = Math.min(delay * this.config.backoffMultiplier, this.config.maxDelayMs);
      }
    }

    throw lastError!;
  }

  /**
   * Check if error should be retried
   */
  private shouldRetry(error: CommanderError): boolean {
    // Check non-retryable first
    if (this.config.nonRetryableErrors?.includes(error.code)) {
      return false;
    }

    // Check retryable
    if (this.config.retryableErrors?.includes(error.code)) {
      return true;
    }

    // Default: retry network-like errors
    const networkIndicators = ['timeout', 'network', 'connection', 'temporary'];
    return networkIndicators.some(indicator => 
      error.message.toLowerCase().includes(indicator)
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ========================================
// Circuit Breaker
// ========================================

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening
  successThreshold: number;      // Successes before closing
  timeout: number;               // Time before trying again (ms)
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeout: 60000 // 1 minute
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime?: number;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Execute with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit should transition
    this.checkState();

    if (this.state === 'open') {
      throw new Error('Circuit breaker is OPEN - service unavailable');
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    this.checkState();
    return this.state;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime
    };
  }

  /**
   * Manually reset
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = undefined;
  }

  private recordSuccess(): void {
    this.failureCount = 0;
    this.successCount++;

    if (this.state === 'half-open' && this.successCount >= this.config.successThreshold) {
      this.state = 'closed';
      this.successCount = 0;
    }
  }

  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }

  private checkState(): void {
    if (this.state === 'open' && this.lastFailureTime) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.timeout) {
        this.state = 'half-open';
        this.failureCount = 0;
      }
    }
  }
}

// ========================================
// Fallback Handler
// ========================================

export interface Fallback<T> {
  primary: () => Promise<T>;
  fallback: () => Promise<T>;
  errorHandler?: (error: Error) => void;
}

export class FallbackHandler {
  /**
   * Execute with fallback
   */
  async execute<T>(fallback: Fallback<T>): Promise<T> {
    try {
      return await fallback.primary();
    } catch (error) {
      fallback.errorHandler?.(error as Error);
      
      // Log the error
      console.error(`Primary failed, using fallback:`, error);
      
      // Try fallback
      return fallback.fallback();
    }
  }

  /**
   * Execute with multiple fallbacks (cascade)
   */
  async executeCascade<T>(
    funcs: Array<() => Promise<T>>,
    onError?: (error: Error, index: number) => void
  ): Promise<T> {
    let lastError: Error;

    for (let i = 0; i < funcs.length; i++) {
      try {
        return await funcs[i]();
      } catch (error) {
        lastError = error as Error;
        onError?.(lastError, i);
      }
    }

    throw lastError!;
  }
}

// ========================================
// Error Aggregator
// ========================================

export class ErrorAggregator {
  private errors: Array<{ timestamp: string; error: Error; context?: string }> = [];

  /**
   * Add error
   */
  add(error: Error, context?: string): void {
    this.errors.push({
      timestamp: new Date().toISOString(),
      error,
      context
    });

    // Keep last 100 errors
    if (this.errors.length > 100) {
      this.errors.shift();
    }
  }

  /**
   * Get recent errors
   */
  getRecent(limit: number = 10): Array<{ timestamp: string; message: string; context?: string }> {
    return this.errors.slice(-limit).map(e => ({
      timestamp: e.timestamp,
      message: e.error.message,
      context: e.context
    }));
  }

  /**
   * Get error summary
   */
  getSummary(): {
    total: number;
    byType: Record<string, number>;
    lastError?: string;
  } {
    const byType: Record<string, number> = {};
    
    for (const e of this.errors) {
      const name = e.error.name || 'Unknown';
      byType[name] = (byType[name] || 0) + 1;
    }

    return {
      total: this.errors.length,
      byType,
      lastError: this.errors[this.errors.length - 1]?.error.message
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
// Validation Helpers
// ========================================

export function requireNonNull<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) {
    throw new ValidationError(message || 'Value is required');
  }
  return value;
}

export function requireNonEmpty<T extends any[]>(
  value: T, 
  message?: string
): T {
  if (value.length === 0) {
    throw new ValidationError(message || 'Array cannot be empty');
  }
  return value;
}

export function validateRange(
  value: number,
  min: number,
  max: number,
  name?: string
): void {
  if (value < min || value > max) {
    throw new ValidationError(
      `${name || 'Value'} must be between ${min} and ${max}, got ${value}`
    );
  }
}

export function validateString(
  value: any,
  options?: {
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    name?: string;
  }
): void {
  if (typeof value !== 'string') {
    throw new ValidationError(`${options?.name || 'Value'} must be a string`);
  }

  if (options?.minLength !== undefined && value.length < options.minLength) {
    throw new ValidationError(
      `${options.name || 'Value'} must be at least ${options.minLength} characters`
    );
  }

  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(
      `${options.name || 'Value'} must be at most ${options.maxLength} characters`
    );
  }

  if (options?.pattern && !options.pattern.test(value)) {
    throw new ValidationError(
      `${options.name || 'Value'} does not match expected format`
    );
  }
}

// ========================================
// Global Error Handler
// ========================================

export const globalErrorAggregator = new ErrorAggregator();
export const globalFallbackHandler = new FallbackHandler();

/**
 * Global error handler wrapper
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context?: string,
  fallback?: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    globalErrorAggregator.add(error as Error, context);
    
    if (fallback) {
      return fallback();
    }
    
    throw error;
  }
}

/**
 * Safe async wrapper that never throws
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  defaultValue: T
): Promise<T> {
  try {
    return await fn();
  } catch {
    return defaultValue;
  }
}

// ========================================
// Exports
// ========================================

export const retryHandler = new RetryHandler();
export const circuitBreaker = new CircuitBreaker();