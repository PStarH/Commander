import type { LLMProvider, LLMRequest, LLMResponse } from './types';
export interface BatchJob {
    id: string;
    requests: Array<{
        id: string;
        request: LLMRequest;
    }>;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    createdAt: string;
    completedAt?: string;
    results: Map<string, LLMResponse | Error>;
}
export interface BatchProviderConfig {
    maxBatchSize: number;
    pollIntervalMs: number;
    maxPollAttempts: number;
}
export declare class BatchLLMProvider {
    private wrapped;
    private config;
    private pendingJobs;
    private completedJobs;
    constructor(wrapped: LLMProvider, config?: Partial<BatchProviderConfig>);
    submitBatch(requests: LLMRequest[]): string;
    processBatch(jobId: string): Promise<BatchJob>;
    processSequentially(jobId: string): Promise<BatchJob>;
    getResult(jobId: string, requestId: string): LLMResponse | Error | undefined;
    getJob(jobId: string): BatchJob | undefined;
    listJobs(): Array<{
        id: string;
        status: string;
        total: number;
        completed: number;
    }>;
    getStats(): {
        pendingJobs: number;
        completedJobs: number;
        totalRequests: number;
    };
    clearCompleted(): void;
    getWrappedProvider(): LLMProvider;
    private chunk;
}
export declare function createBatchProvider(wrapped: LLMProvider, config?: Partial<BatchProviderConfig>): BatchLLMProvider;
//# sourceMappingURL=batchProvider.d.ts.map