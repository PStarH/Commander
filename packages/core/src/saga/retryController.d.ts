import type { RetryPolicy } from './types';
export declare class RetryController {
    private readonly policy;
    private consecutiveFailures;
    private circuitOpen;
    constructor(policy: RetryPolicy);
    get policy_(): RetryPolicy;
    computeDelay(attempt: number): number;
    shouldRetry(err: Error, attempt: number): boolean;
    recordFailure(): void;
    recordSuccess(): void;
    resetCircuit(): void;
    isCircuitOpen(): boolean;
    get consecutiveFailureCount(): number;
    private baseDelay;
    private applyJitter;
}
export declare class RetryControllerError extends Error {
    constructor(message: string);
}
export declare function createRetryController(policy: RetryPolicy): RetryController;
export declare function mergeRetryPolicy(base: RetryPolicy, override: Partial<RetryPolicy>): RetryPolicy;
//# sourceMappingURL=retryController.d.ts.map