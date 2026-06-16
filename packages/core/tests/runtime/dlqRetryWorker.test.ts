import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DlqRetryWorker, type DlqReader, type DlqWriter, type RetryHandler } from '../../src/runtime/dlqRetryWorker';

function makeEntry(overrides: Partial<{ id: string; category: string; operationName: string; runId: string; attemptNumber: number; retryable: boolean; recovered: boolean; errorMessage: string; inputSnapshot: string; agentId: string; tags: string[] }> = {}) {
  return {
    id: overrides.id ?? 'dlq-1',
    category: overrides.category ?? 'llm',
    operationName: overrides.operationName ?? 'test-op',
    runId: overrides.runId ?? 'run-1',
    agentId: overrides.agentId ?? 'agent-1',
    attemptNumber: overrides.attemptNumber ?? 1,
    retryable: overrides.retryable ?? true,
    recovered: overrides.recovered ?? false,
    errorMessage: overrides.errorMessage ?? 'timeout',
    inputSnapshot: overrides.inputSnapshot ?? '{"prompt":"hello"}',
    tags: overrides.tags ?? [],
  };
}

function createMockDlq(entries: ReturnType<typeof makeEntry>[] = []): DlqReader & DlqWriter {
  const getRetryableEntries = vi.fn().mockImplementation((category: string, limit: number) => {
    return entries.filter((e) => e.category === category && e.retryable && !e.recovered).slice(0, limit);
  });
  const readEntries = vi.fn().mockImplementation((category: string, limit: number) => {
    return entries.filter((e) => e.category === category).slice(0, limit);
  });
  return {
    getRetryableEntries,
    readEntries,
    record: vi.fn(),
    flush: vi.fn(),
  };
}

function createMockHandler(outcome: { recovered: boolean; error?: string } = { recovered: true }): RetryHandler {
  return vi.fn().mockResolvedValue(outcome);
}

describe('DlqRetryWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('poll() processes retryable entries and marks recovered', async () => {
    const entry = makeEntry({ attemptNumber: 1 });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: true });
    const worker = new DlqRetryWorker(dlq, handler, { intervalMs: 60_000, maxAutoRetries: 3, batchSize: 10 });

    const result = await worker.poll();

    expect(result.processed).toBe(1);
    expect(result.recovered).toBe(1);
    expect(result.escalated).toBe(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'dlq-1', category: 'llm' }));
    expect(dlq.record).toHaveBeenCalledWith(expect.objectContaining({ recovered: true }));
  });

  it('poll() escalates entries that exceed maxAutoRetries', async () => {
    const entry = makeEntry({ attemptNumber: 3 });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: true });
    const worker = new DlqRetryWorker(dlq, handler, { intervalMs: 60_000, maxAutoRetries: 3, batchSize: 10 });

    const result = await worker.poll();

    expect(result.processed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.escalated).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(dlq.record).toHaveBeenCalledWith(expect.objectContaining({ operationName: 'dlq_retry.escalated', retryable: false }));
  });

  it('poll() handles handler returning recovered: false', async () => {
    const entry = makeEntry({ attemptNumber: 1 });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: false, error: 'still broken' });
    const worker = new DlqRetryWorker(dlq, handler, { intervalMs: 60_000, maxAutoRetries: 3, batchSize: 10 });

    const result = await worker.poll();

    expect(result.processed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.escalated).toBe(0);
  });

  it('poll() handles handler throwing an error', async () => {
    const entry = makeEntry({ attemptNumber: 1 });
    const dlq = createMockDlq([entry]);
    const handler = vi.fn().mockRejectedValue(new Error('explosion'));
    const worker = new DlqRetryWorker(dlq, handler, { intervalMs: 60_000, maxAutoRetries: 3, batchSize: 10 });

    const result = await worker.poll();

    expect(result.processed).toBe(1);
    expect(result.recovered).toBe(0);
    expect(handler).toHaveBeenCalled();
  });

  it('poll() skips already-recovered entries', async () => {
    const entry = makeEntry({ recovered: true });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: true });
    const worker = new DlqRetryWorker(dlq, handler);

    const result = await worker.poll();

    expect(result.processed).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('poll() returns zero when no retryable entries', async () => {
    const dlq = createMockDlq([]);
    const handler = createMockHandler();
    const worker = new DlqRetryWorker(dlq, handler);

    const result = await worker.poll();

    expect(result).toEqual({ processed: 0, recovered: 0, escalated: 0 });
  });

  it('start()/stop() manage timer lifecycle', () => {
    const dlq = createMockDlq([]);
    const handler = createMockHandler();
    const worker = new DlqRetryWorker(dlq, handler, { intervalMs: 1000 });

    worker.start();
    expect(worker.getStatus().status).toBe('idle');

    worker.stop();
    expect(worker.getStatus().status).toBe('stopped');
  });

  it('start() is idempotent', () => {
    const dlq = createMockDlq([]);
    const handler = createMockHandler();
    const worker = new DlqRetryWorker(dlq, handler);

    worker.start();
    worker.start();
    expect(worker.getStatus().status).toBe('idle');

    worker.stop();
  });

  it('processEntry() finds and retries a specific entry', async () => {
    const entry = makeEntry({ id: 'target-42' });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: true });
    const worker = new DlqRetryWorker(dlq, handler);

    const result = await worker.processEntry('target-42');

    expect(result.recovered).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'target-42' }));
  });

  it('processEntry() returns error when entry not found', async () => {
    const dlq = createMockDlq([]);
    const handler = createMockHandler();
    const worker = new DlqRetryWorker(dlq, handler);

    const result = await worker.processEntry('nonexistent');

    expect(result.recovered).toBe(false);
    expect(result.error).toBe('Entry not found');
  });

  it('getStatus() returns accurate stats after poll', async () => {
    const entry = makeEntry({ attemptNumber: 1 });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: true });
    const worker = new DlqRetryWorker(dlq, handler);

    await worker.poll();
    const status = worker.getStatus();

    expect(status.totalProcessed).toBe(1);
    expect(status.totalRecovered).toBe(1);
    expect(status.totalEscalated).toBe(0);
    expect(status.lastPollAt).toBeTruthy();
  });

  it('timer fires poll automatically', async () => {
    const entry = makeEntry({ attemptNumber: 1 });
    const dlq = createMockDlq([entry]);
    const handler = createMockHandler({ recovered: true });
    const worker = new DlqRetryWorker(dlq, handler, { intervalMs: 5000 });

    worker.start();
    vi.advanceTimersByTime(5000);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    worker.stop();
  });
});
