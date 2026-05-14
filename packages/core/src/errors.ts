/**
 * Error Handling Utilities
 * Phase 2: 错误处理增强
 * 
 * 提供统一的错误处理和恢复机制
 */

// ========================================
// Error Types
// ========================================

export class CommanderError extends Error {
  constructor(
    message: string,
    public code: string,
    public severity: 'low' | 'medium' | 'high' | 'critical' = 'medium',
    public context?: Record<string, any>
  ) {
    super(message);
    this.name = 'CommanderError';
  }
}

export class TimeoutError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'TIMEOUT', 'medium', context);
    this.name = 'TimeoutError';
  }
}

export class ValidationError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'VALIDATION', 'low', context);
    this.name = 'ValidationError';
  }
}

export class ResourceExhaustedError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'RESOURCE_EXHAUSTED', 'high', context);
    this.name = 'ResourceExhaustedError';
  }
}

export class ConsensusFailureError extends CommanderError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONSENSUS_FAILURE', 'high', context);
    this.name = 'ConsensusFailureError';
  }
}

// ========================================
// Result Type
// ========================================

export type Result<T, E = Error> = 
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ========================================
// Retry Utilities
// ========================================

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  shouldRetry?: (error: any) => boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  shouldRetry: (error) => {
    // Don't retry validation errors or timeout errors
    if (error instanceof ValidationError) return false;
    if (error instanceof TimeoutError) return false;
    return true;
  }
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: any;
  let delay = cfg.initialDelayMs;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === cfg.maxAttempts) {
        throw error;
      }

      // Check if we should retry
      if (cfg.shouldRetry && !cfg.shouldRetry(error)) {
        throw error;
      }

      // Wait before retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * cfg.backoffMultiplier, cfg.maxDelayMs);
    }
  }

  throw lastError;
}

// ========================================
// Circuit Breaker
// ========================================

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;      // Failures before opening
  successThreshold: number;      // Successes to close
  timeoutMs: number;             // Time before half-open
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 2,
  timeoutMs: 60000
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureTime?: number;

  constructor(private config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if timeout has passed
      if (this.lastFailureTime && 
          Date.now() - this.lastFailureTime > this.config.timeoutMs) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      
      if (this.state === 'half-open') {
        this.successes++;
        if (this.successes >= this.config.successThreshold) {
          this.state = 'closed';
          this.failures = 0;
        }
      }

      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      if (this.state === 'half-open') {
        this.state = 'open';
      } else if (this.failures >= this.config.failureThreshold) {
        this.state = 'open';
      }

      throw error;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailures(): number {
    return this.failures;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = undefined;
  }
}

// ========================================
// Error Handler
// ========================================

export interface ErrorContext {
  component: string;
  operation: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface ErrorHandlerConfig {
  onError?: (error: Error, context: ErrorContext) => void;
  onRetry?: (error: Error, attempt: number, context: ErrorContext) => void;
  onCircuitOpen?: (error: Error, context: ErrorContext) => void;
  logErrors: boolean;
  throwOnUnhandled: boolean;
}

export const DEFAULT_ERROR_HANDLER_CONFIG: ErrorHandlerConfig = {
  logErrors: true,
  throwOnUnhandled: true
};

export class ErrorHandler {
  private errors: Array<Error & { context: ErrorContext }> = [];

  constructor(private config: ErrorHandlerConfig = DEFAULT_ERROR_HANDLER_CONFIG) {}

  handle(error: Error, context: ErrorContext): void {
    const errorWithContext = Object.assign(error, { context });
    this.errors.push(errorWithContext);

    if (this.config.logErrors) {
      console.error(`[${context.component}] ${context.operation}:`, {
        message: error.message,
        stack: error.stack,
        ...context.metadata
      });
    }

    if (this.config.onError) {
      this.config.onError(error, context);
    }
  }

  execute<T>(component: string, operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      this.handle(error as Error, {
        component,
        operation,
        timestamp: new Date().toISOString()
      });

      if (this.config.throwOnUnhandled) {
        throw error;
      }

      return undefined as T;
    }
  }

  async executeAsync<T>(
    component: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.handle(error as Error, {
        component,
        operation,
        timestamp: new Date().toISOString()
      });

      if (this.config.throwOnUnhandled) {
        throw error;
      }

      return undefined;
    }
  }

  getErrors(): Array<Error & { context: ErrorContext }> {
    return this.errors;
  }

  clearErrors(): void {
    this.errors = [];
  }

  getErrorCount(): number {
    return this.errors.length;
  }

  getErrorsByComponent(component: string): Array<Error & { context: ErrorContext }> {
    return this.errors.filter(e => e.context.component === component);
  }
}

// ========================================
// Validation Utilities
// ========================================

export interface ValidationRule<T> {
  validate: (value: T) => boolean;
  message: string;
}

export function validate<T>(
  value: T,
  rules: ValidationRule<T>[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const rule of rules) {
    if (!rule.validate(value)) {
      errors.push(rule.message);
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Common rules
export const rules = {
  required: <T>(message = 'Value is required'): ValidationRule<T> => ({
    validate: (value) => value !== null && value !== undefined && value !== '',
    message
  }),

  minLength: (min: number, message?: string): ValidationRule<string> => ({
    validate: (value) => value.length >= min,
    message: message || `Minimum length is ${min}`
  }),

  maxLength: (max: number, message?: string): ValidationRule<string> => ({
    validate: (value) => value.length <= max,
    message: message || `Maximum length is ${max}`
  }),

  positive: (message = 'Must be positive'): ValidationRule<number> => ({
    validate: (value) => value > 0,
    message
  }),

  inRange: (min: number, max: number, message?: string): ValidationRule<number> => ({
    validate: (value) => value >= min && value <= max,
    message: message || `Must be between ${min} and ${max}`
  }),

  matches: (pattern: RegExp, message: string): ValidationRule<string> => ({
    validate: (value) => pattern.test(value),
    message
  })
};

// ========================================
// Panic Recovery
// ========================================

export function withPanicRecovery<T>(
  fn: () => T,
  fallback: T,
  onPanic?: (error: any) => void
): T {
  try {
    return fn();
  } catch (error) {
    if (onPanic) {
      onPanic(error);
    }
    return fallback;
  }
}

export async function withPanicRecoveryAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  onPanic?: (error: any) => void
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (onPanic) {
      onPanic(error);
    }
    return fallback;
  }
}

// ========================================
// Error Boundary
// ========================================

export interface ErrorBoundaryConfig {
  fallback?: () => any;
  onError?: (error: Error, component: string) => void;
  componentName?: string;
}

export class ErrorBoundary {
  private hasError = false;
  private lastError?: Error;

  constructor(private config: ErrorBoundaryConfig = {}) {}

  render<T>(renderFn: () => T): T | undefined {
    try {
      this.hasError = false;
      return renderFn();
    } catch (error) {
      this.hasError = true;
      this.lastError = error as Error;

      if (this.config.onError && this.config.componentName) {
        this.config.onError(error as Error, this.config.componentName);
      }

      if (this.config.fallback) {
        return this.config.fallback();
      }

      return undefined;
    }
  }

  hasCaughtError(): boolean {
    return this.hasError;
  }

  getLastError(): Error | undefined {
    return this.lastError;
  }
}