import type { SagaStepNode, SagaContext, RetryPolicy } from './types';
export interface CompensableStep {
    node: SagaStepNode;
    result: unknown;
}
export interface CompensationAttempt {
    nodeId: string;
    success: boolean;
    attempts: number;
    error?: Error;
}
export interface FailedCompensation {
    nodeId: string;
    runId: string;
    compensationError: Error;
    attempts: number;
    timestamp: string;
}
export interface CompensationResult {
    compensated: string[];
    failed: FailedCompensation[];
}
export type DeadLetterSink = (entry: FailedCompensation) => Promise<void>;
export interface CompensationSchedulerOptions {
    retryPolicy: RetryPolicy;
    deadLetter?: DeadLetterSink;
}
export declare class CompensationScheduler {
    private readonly retry;
    private readonly dlq;
    constructor(options: CompensationSchedulerOptions);
    compensate(steps: readonly CompensableStep[], context: SagaContext): Promise<CompensationResult>;
    compensateParallel(steps: readonly CompensableStep[], context: SagaContext): Promise<CompensationResult>;
    forceCompensate(step: CompensableStep, context: SagaContext): Promise<CompensationAttempt>;
    private runOne;
}
export declare class CompensationSchedulerError extends Error {
    constructor(message: string);
}
export declare function defaultCompensationRetryPolicy(): RetryPolicy;
//# sourceMappingURL=compensationScheduler.d.ts.map