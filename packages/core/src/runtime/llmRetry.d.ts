export type ErrorClass = 'transient' | 'permanent' | 'unknown';
export interface ClassifiedError {
    retryable: boolean;
    errorClass: ErrorClass;
    message: string;
    statusCode?: number;
    retryAfter?: number;
}
export declare function classifyLLMError(err: unknown): ClassifiedError;
export declare function computeBackoff(attempt: number, baseMs?: number, maxMs?: number): number;
//# sourceMappingURL=llmRetry.d.ts.map