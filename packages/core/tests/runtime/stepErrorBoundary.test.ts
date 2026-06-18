import { describe, it, expect, vi } from 'vitest';
import { StepErrorBoundary } from '../../src/runtime/stepErrorBoundary';
import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';

let testCount = 0;
function createBoundary(config?: Record<string, unknown>) {
  testCount++;
  const dlq = new DeadLetterQueue(`/tmp/commander_dlq_test_${Date.now()}_${testCount}`);
  const boundary = new StepErrorBoundary('run-1', 'agent-1', dlq, 'mission-1', config as any);
  return { boundary, dlq };
}

describe('StepErrorBoundary', () => {
  it('returns success when operation succeeds', async () => {
    const { boundary } = createBoundary();
    const result = await boundary.execute('test-op', 'tool', async () => 'ok');
    expect(result.success).toBe(true);
    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(1);
    expect(result.recovered).toBe(false);
  });

  it('retries on transient error and recovers', async () => {
    const { boundary } = createBoundary({ maxRetries: 3, retryDelayMs: 5 });
    let callCount = 0;
    const result = await boundary.execute('test-op', 'tool', async () => {
      callCount++;
      if (callCount < 3) throw new Error('timeout');
      return 'recovered';
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe('recovered');
    expect(result.attempts).toBe(3);
    expect(result.recovered).toBe(true);
  });

  it('aborts on permanent error with abort strategy', async () => {
    const { boundary } = createBoundary({ onPermanent: 'abort', maxRetries: 3, retryDelayMs: 5 });
    const result = await boundary.execute('test-op', 'tool', async () => {
      throw Object.assign(new Error('Bad request'), { statusCode: 400 });
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Bad request: bad request');
    expect(result.attempts).toBe(1);
  });

  it('skips on permanent error with skip strategy', async () => {
    const { boundary } = createBoundary({ onPermanent: 'skip', maxRetries: 3, retryDelayMs: 5 });
    let skipped = false;
    const result = await boundary.execute(
      'test-op',
      'tool',
      async () => {
        throw Object.assign(new Error('Invalid'), { statusCode: 422 });
      },
      {
        onSkip: () => {
          skipped = true;
        },
      },
    );
    expect(result.success).toBe(false);
    expect(skipped).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('exhausts retries and applies onExhausted skip strategy', async () => {
    const { boundary } = createBoundary({ maxRetries: 2, retryDelayMs: 5, onExhausted: 'skip' });
    let skipped = false;
    const result = await boundary.execute(
      'test-op',
      'tool',
      async () => {
        throw new Error('Connection timed out');
      },
      {
        onSkip: () => {
          skipped = true;
        },
      },
    );
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(skipped).toBe(true);
  });

  it('exhausts retries and aborts with onExhausted abort strategy', async () => {
    const { boundary } = createBoundary({ maxRetries: 1, retryDelayMs: 5, onExhausted: 'abort' });
    const result = await boundary.execute('test-op', 'tool', async () => {
      throw new Error('Connection timed out');
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBe(2);
  });

  it('calls onRetry callback with attempt number', async () => {
    const { boundary } = createBoundary({ maxRetries: 2, retryDelayMs: 5 });
    const retryCalls: number[] = [];
    let callCount = 0;
    await boundary.execute(
      'test-op',
      'tool',
      async () => {
        callCount++;
        if (callCount < 3) throw new Error('Connection timed out');
        return 'ok';
      },
      {
        onRetry: (attempt, err) => {
          retryCalls.push(attempt);
        },
      },
    );
    expect(retryCalls).toEqual([0, 1]);
  });

  it('records permanent errors to DLQ', async () => {
    const { boundary, dlq } = createBoundary({ onPermanent: 'skip' });
    await boundary.execute('test-op', 'tool', async () => {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    });
    dlq.flush('tool');
    const entries = dlq.readEntries('tool');
    expect(entries.length).toBe(1);
    expect(entries[0].errorMessage).toBe('Authentication failed: invalid API key');
  });

  it('records transient errors to DLQ on each attempt', async () => {
    const { boundary, dlq } = createBoundary({ maxRetries: 2, retryDelayMs: 5 });
    await boundary.execute('test-op', 'tool', async () => {
      throw new Error('timeout');
    });
    dlq.flush('tool');
    const entries = dlq.readEntries('tool');
    expect(entries.length).toBe(3);
    entries.forEach((e: any) => expect(e.retryable).toBe(true));
  });

  it('uses retry-after header for delay when available', async () => {
    const { boundary } = createBoundary({ maxRetries: 1, retryDelayMs: 1000 });
    const start = Date.now();
    await boundary.execute('test-op', 'tool', async () => {
      const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
      (err as any).headers = { 'retry-after': '0' };
      throw err;
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500); // retry-after=0 → immediate retry
  });
});
