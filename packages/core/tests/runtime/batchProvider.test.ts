import { describe, it, expect, beforeEach } from 'vitest';
import { BatchLLMProvider, createBatchProvider } from '../../src/runtime/batchProvider';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/runtime/types';

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  callCount = 0;

  async call(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    return {
      content: `response-${this.callCount}`,
      model: request.model,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    };
  }
}

class FailingProvider implements LLMProvider {
  readonly name = 'failing';
  callCount = 0;

  async call(): Promise<LLMResponse> {
    this.callCount++;
    throw new Error(`API failure #${this.callCount}`);
  }
}

function makeRequest(suffix = ''): LLMRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: `test${suffix}` }],
  };
}

describe('BatchLLMProvider', () => {
  let stub: StubProvider;
  let batch: BatchLLMProvider;

  beforeEach(() => {
    stub = new StubProvider();
    batch = new BatchLLMProvider(stub);
  });

  describe('submitBatch', () => {
    it('creates a batch job with correct id and status', () => {
      const jobId = batch.submitBatch([makeRequest('1'), makeRequest('2')]);
      const job = batch.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe('pending');
      expect(job!.requests).toHaveLength(2);
    });
  });

  describe('processBatch', () => {
    it('processes all requests in parallel', async () => {
      const jobId = batch.submitBatch([
        makeRequest('a'),
        makeRequest('b'),
        makeRequest('c'),
      ]);
      const job = await batch.processBatch(jobId);
      expect(job.status).toBe('completed');
      expect(job.completedAt).toBeDefined();
      expect(stub.callCount).toBe(3);
    });

    it('stores results indexed by request id', async () => {
      const jobId = batch.submitBatch([makeRequest('x')]);
      const job = await batch.processBatch(jobId);
      const result = job.results.get(job.requests[0].id);
      expect(result).toBeDefined();
      if (result && 'content' in result) {
        expect(result.content).toBe('response-1');
      }
    });

    it('handles provider errors gracefully', async () => {
      const failing = new FailingProvider();
      const failBatch = new BatchLLMProvider(failing);
      const jobId = failBatch.submitBatch([makeRequest('fail')]);
      const job = await failBatch.processBatch(jobId);
      expect(job.status).toBe('completed');
      const result = job.results.get(job.requests[0].id);
      expect(result).toBeInstanceOf(Error);
    });
  });

  describe('processSequentially', () => {
    it('processes requests one at a time', async () => {
      const jobId = batch.submitBatch([makeRequest('1'), makeRequest('2')]);
      const job = await batch.processSequentially(jobId);
      expect(job.status).toBe('completed');
      expect(stub.callCount).toBe(2);
    });
  });

  describe('getResult', () => {
    it('returns result for completed job', async () => {
      const jobId = batch.submitBatch([makeRequest()]);
      const job = await batch.processBatch(jobId);
      const result = batch.getResult(jobId, job.requests[0].id);
      expect(result).toBeDefined();
    });

    it('returns undefined for unknown request', () => {
      const result = batch.getResult('nonexistent', 'nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('listJobs', () => {
    it('lists all jobs with status', async () => {
      batch.submitBatch([makeRequest()]);
      const jobId2 = batch.submitBatch([makeRequest()]);
      await batch.processBatch(jobId2);
      const jobs = batch.listJobs();
      expect(jobs).toHaveLength(2);
      expect(jobs.some((j) => j.status === 'completed')).toBe(true);
      expect(jobs.some((j) => j.status === 'pending')).toBe(true);
    });
  });

  describe('stats', () => {
    it('tracks pending and completed jobs', async () => {
      batch.submitBatch([makeRequest()]);
      const jobId2 = batch.submitBatch([makeRequest()]);
      await batch.processBatch(jobId2);
      const stats = batch.getStats();
      expect(stats.pendingJobs).toBe(1);
      expect(stats.completedJobs).toBe(1);
      expect(stats.totalRequests).toBe(2);
    });
  });

  describe('clearCompleted', () => {
    it('removes completed jobs', async () => {
      const jobId = batch.submitBatch([makeRequest()]);
      await batch.processBatch(jobId);
      batch.clearCompleted();
      expect(batch.getJob(jobId)).toBeUndefined();
    });
  });

  describe('chunking', () => {
    it('respects maxBatchSize', async () => {
      const smallBatch = new BatchLLMProvider(stub, { maxBatchSize: 2 });
      const requests = Array.from({ length: 5 }, (_, i) => makeRequest(`-${i}`));
      const jobId = smallBatch.submitBatch(requests);
      const job = await smallBatch.processBatch(jobId);
      expect(job.status).toBe('completed');
      expect(stub.callCount).toBe(5);
    });
  });

  describe('createBatchProvider helper', () => {
    it('creates a BatchLLMProvider', () => {
      const bp = createBatchProvider(stub);
      expect(bp.getWrappedProvider()).toBe(stub);
    });
  });
});
