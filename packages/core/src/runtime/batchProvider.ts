import type { LLMProvider, LLMRequest, LLMResponse } from './types';
import { getGlobalLogger } from '../logging';

export interface BatchJob {
  id: string;
  requests: Array<{ id: string; request: LLMRequest }>;
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

const DEFAULT_BATCH_CONFIG: BatchProviderConfig = {
  maxBatchSize: 100,
  pollIntervalMs: 5000,
  maxPollAttempts: 120,
};

export class BatchLLMProvider {
  private wrapped: LLMProvider;
  private config: BatchProviderConfig;
  private pendingJobs = new Map<string, BatchJob>();
  private completedJobs = new Map<string, BatchJob>();

  constructor(wrapped: LLMProvider, config: Partial<BatchProviderConfig> = {}) {
    this.wrapped = wrapped;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
  }

  submitBatch(requests: LLMRequest[]): string {
    const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entries = requests.map((req, i) => ({
      id: `${jobId}_req_${i}`,
      request: req,
    }));

    const job: BatchJob = {
      id: jobId,
      requests: entries,
      status: 'pending',
      createdAt: new Date().toISOString(),
      results: new Map(),
    };

    this.pendingJobs.set(jobId, job);
    getGlobalLogger().info('BatchProvider', `Batch job ${jobId} created with ${requests.length} requests`);
    return jobId;
  }

  async processBatch(jobId: string): Promise<BatchJob> {
    const job = this.pendingJobs.get(jobId);
    if (!job) throw new Error(`Batch job ${jobId} not found`);

    job.status = 'processing';
    const chunks = this.chunk(job.requests, this.config.maxBatchSize);

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map((entry) => this.wrapped.call(entry.request)),
      );

      for (let i = 0; i < chunk.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          job.results.set(chunk[i].id, result.value);
        } else {
          job.results.set(chunk[i].id, result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
        }
      }
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    this.completedJobs.set(jobId, job);
    this.pendingJobs.delete(jobId);
    return job;
  }

  async processSequentially(jobId: string): Promise<BatchJob> {
    const job = this.pendingJobs.get(jobId);
    if (!job) throw new Error(`Batch job ${jobId} not found`);

    job.status = 'processing';
    for (const entry of job.requests) {
      try {
        const response = await this.wrapped.call(entry.request);
        job.results.set(entry.id, response);
      } catch (err) {
        job.results.set(entry.id, err instanceof Error ? err : new Error(String(err)));
      }
    }

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    this.completedJobs.set(jobId, job);
    this.pendingJobs.delete(jobId);
    return job;
  }

  getResult(jobId: string, requestId: string): LLMResponse | Error | undefined {
    const job = this.completedJobs.get(jobId) ?? this.pendingJobs.get(jobId);
    return job?.results.get(requestId);
  }

  getJob(jobId: string): BatchJob | undefined {
    return this.pendingJobs.get(jobId) ?? this.completedJobs.get(jobId);
  }

  listJobs(): Array<{ id: string; status: string; total: number; completed: number }> {
    const all = [...this.pendingJobs.values(), ...this.completedJobs.values()];
    return all.map((j) => ({
      id: j.id,
      status: j.status,
      total: j.requests.length,
      completed: j.results.size,
    }));
  }

  getStats(): { pendingJobs: number; completedJobs: number; totalRequests: number } {
    let totalRequests = 0;
    for (const j of this.pendingJobs.values()) totalRequests += j.requests.length;
    for (const j of this.completedJobs.values()) totalRequests += j.requests.length;
    return {
      pendingJobs: this.pendingJobs.size,
      completedJobs: this.completedJobs.size,
      totalRequests,
    };
  }

  clearCompleted(): void {
    this.completedJobs.clear();
  }

  getWrappedProvider(): LLMProvider {
    return this.wrapped;
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}

export function createBatchProvider(
  wrapped: LLMProvider,
  config?: Partial<BatchProviderConfig>,
): BatchLLMProvider {
  return new BatchLLMProvider(wrapped, config);
}
