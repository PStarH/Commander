/**
 * Error Handler
 * Phase 2: 错误处理增强
 *
 * 提供统一的错误处理、恢复和重试机制
 */
export declare class CommanderError extends Error {
    code: string;
    component: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    context?: Record<string, unknown> | undefined;
    constructor(message: string, code: string, component: string, severity: 'low' | 'medium' | 'high' | 'critical', context?: Record<string, unknown> | undefined);
}
export declare class TaskComplexityError extends CommanderError {
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class OrchestrationError extends CommanderError {
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class BudgetExhaustedError extends CommanderError {
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class MemoryError extends CommanderError {
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class ConsensusError extends CommanderError {
    constructor(message: string, context?: Record<string, unknown>);
}
export declare class InspectionError extends CommanderError {
    constructor(message: string, context?: Record<string, unknown>);
}
export interface ErrorHandlerConfig {
    maxRetries: number;
    retryDelayMs: number;
    exponentialBackoff: boolean;
    circuitBreakerThreshold: number;
    circuitBreakerCooldownMs: number;
    maxErrors: number;
    enableLogging: boolean;
}
export declare class ErrorHandler {
    private config;
    private errors;
    private circuitBreakers;
    private errorListeners;
    constructor(config?: Partial<ErrorHandlerConfig>);
    /**
     * Handle error with automatic retry
     */
    handleWithRetry<T>(operation: () => T | Promise<T>, context: {
        component: string;
        operation: string;
    }): Promise<T>;
    /**
     * Wrap error in CommanderError
     */
    private wrapError;
    private isRetryable;
    private getOrCreateBreaker;
    private recordError;
    /**
     * Sleep utility
     */
    private sleep;
    /**
     * Add error listener
     */
    onError(listener: (error: CommanderError) => void): void;
    /**
     * Remove error listener
     */
    offError(listener: (error: CommanderError) => void): void;
    /**
     * Get recent errors
     */
    getRecentErrors(limit?: number): Array<{
        timestamp: string;
        error: CommanderError;
    }>;
    /**
     * Get errors by component
     */
    getErrorsByComponent(component: string): Array<{
        timestamp: string;
        error: CommanderError;
    }>;
    /**
     * Get error statistics
     */
    getErrorStats(): {
        total: number;
        bySeverity: Record<string, number>;
        byComponent: Record<string, number>;
        circuitBreakerStatus: Record<string, {
            failures: number;
            open: boolean;
        }>;
    };
    /**
     * Clear errors
     */
    clear(): void;
}
export type Result<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: CommanderError;
};
export declare function success<T>(data: T): Result<T>;
export declare function failure<T>(error: CommanderError): Result<T>;
export declare function safeExecute<T>(fn: () => T | Promise<T>, errorHandler: ErrorHandler, component: string, operation: string): Promise<Result<T>>;
export declare function getGlobalErrorHandler(): ErrorHandler;
export declare function resetErrorHandler(): void;
//# sourceMappingURL=errorHandler.d.ts.map