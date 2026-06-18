import type { SagaGraph, RetryPolicy, CompensationFn } from './types';
export interface SagaStepConfig {
    id?: string;
    compensate?: CompensationFn;
    compensateOrder?: 'lifo' | 'fifo';
    timeoutMs?: number;
    retryPolicy?: Partial<RetryPolicy>;
    description?: string;
    tags?: string[];
}
export interface SagaParallelConfig {
    id?: string;
    name?: string;
    failFast?: boolean;
}
export interface SagaNestedConfig {
    id?: string;
    name?: string;
    compensateOrder?: 'lifo' | 'fifo';
}
export interface SagaApprovalConfig {
    id?: string;
    timeoutMs?: number;
    onTimeout?: 'reject' | 'fail';
}
export declare class SagaBuilder {
    private readonly nodes;
    private _description?;
    private _timeoutMs?;
    private _defaultRetryPolicy?;
    private _tenantId?;
    private _metadata?;
    private _name;
    constructor(name: string);
    describe(description: string): this;
    withTimeout(ms: number): this;
    withRetry(policy: RetryPolicy): this;
    withTenant(tenantId: string): this;
    withMetadata(metadata: Record<string, unknown>): this;
    step(name: string, fn: (ctx: import('./types').SagaContext) => Promise<unknown>, config?: SagaStepConfig): this;
    compensate(fn: CompensationFn): this;
    parallel(branches: readonly SagaGraph[], config?: SagaParallelConfig): this;
    nested(child: SagaGraph, config?: SagaNestedConfig): this;
    approval(approver: string, config?: SagaApprovalConfig): this;
    build(): SagaGraph;
    private resolveRetryPolicy;
}
export declare class SagaBuilderError extends Error {
    constructor(message: string);
}
export declare function createSaga(name: string): SagaBuilder;
export declare function buildSaga(name: string, configure: (b: SagaBuilder) => SagaBuilder): SagaGraph;
//# sourceMappingURL=sagaBuilder.d.ts.map