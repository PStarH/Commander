/**
 * StepErrorBoundary — Per-step error recovery for agent execution.
 *
 * Wraps a single operation (tool call or LLM call) with configurable
 * recovery strategies: retry (with modified params), fallback (alternative
 * approach), skip (record and continue), or abort (fail the execution).
 *
 * State recorded to DeadLetterQueue for post-mortem analysis.
 */
import { DeadLetterQueue, type DLQCategory } from './deadLetterQueue';
import { type ErrorClass } from './llmRetry';
import type { Reflexion, ReflexionContext, ReflexionGenerator } from './reflexionGenerator';
export type RecoveryStrategy = 'retry' | 'fallback' | 'skip' | 'abort';
export interface ErrorBoundaryConfig {
    maxRetries: number;
    retryDelayMs: number;
    /** Strategy to use when maxRetries exhausted */
    onExhausted: RecoveryStrategy;
    /** Strategy to use for permanent (non-retryable) errors */
    onPermanent: RecoveryStrategy;
}
export interface ErrorBoundaryResult<T> {
    success: boolean;
    value?: T;
    error?: string;
    errorClass: ErrorClass;
    attempts: number;
    recovered: boolean;
}
export declare class StepErrorBoundary {
    private config;
    private dlq;
    private runId;
    private agentId;
    private missionId?;
    private reflexionGenerator;
    constructor(runId: string, agentId: string, dlq: DeadLetterQueue, missionId?: string, config?: Partial<ErrorBoundaryConfig>, reflexionGenerator?: ReflexionGenerator);
    execute<T>(operationName: string, category: DLQCategory, fn: () => Promise<T>, options?: {
        tags?: string[];
        inputSnapshot?: string;
        tokenUsage?: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
        /** Called before each retry attempt (e.g., to modify request) */
        onRetry?: (attempt: number, error: string) => void;
        /** Called when the operation is skipped */
        onSkip?: (error: string) => void;
        /** Called when a structured reflexion is generated before a retry. Async-safe. */
        onReflexion?: (reflexion: Reflexion, ctx: ReflexionContext) => void | Promise<void>;
    }): Promise<ErrorBoundaryResult<T>>;
    private recordToDLQ;
}
//# sourceMappingURL=stepErrorBoundary.d.ts.map