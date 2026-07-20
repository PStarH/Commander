import { describe, it, expect } from 'vitest';
import { classifyLLMError, computeBackoff } from '../../src/runtime/llmRetry';

describe('classifyLLMError', () => {
  it('classifies 400 as permanent', () => {
    const err = { status: 400, message: 'Bad request: invalid JSON' };
    const result = classifyLLMError(err);
    expect(result.retryable).toBe(false);
    expect(result.errorClass).toBe('permanent');
    expect(result.statusCode).toBe(400);
  });

  it('classifies 401 as permanent', () => {
    const err = { statusCode: 401, message: 'unauthorized' };
    const result = classifyLLMError(err);
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('classifies 403 as permanent', () => {
    const err = new Error('Forbidden: insufficient permissions');
    (err as any).statusCode = 403;
    const result = classifyLLMError(err);
    expect(result.retryable).toBe(false);
  });

  it('classifies 422 as permanent', () => {
    const result = classifyLLMError({ status: 422, message: 'Unprocessable entity' });
    expect(result.retryable).toBe(false);
    expect(result.errorClass).toBe('permanent');
  });

  it('classifies 429 as transient with retry-after', () => {
    const err = {
      status: 429,
      message: 'Rate limit exceeded',
      headers: { 'retry-after': '5' },
    };
    const result = classifyLLMError(err);
    expect(result.retryable).toBe(true);
    expect(result.errorClass).toBe('transient');
    expect(result.retryAfter).toBe(5000);
  });

  it('classifies 529 as transient', () => {
    const result = classifyLLMError({ statusCode: 529 });
    expect(result.retryable).toBe(true);
    expect(result.errorClass).toBe('transient');
  });

  it('classifies 5xx as transient', () => {
    const result = classifyLLMError({ statusCode: 502, message: 'Bad gateway' });
    expect(result.retryable).toBe(true);
    expect(result.errorClass).toBe('transient');
  });

  it('classifies 408 as transient', () => {
    const result = classifyLLMError({ status: 408, message: 'Request Timeout' });
    expect(result.retryable).toBe(true);
    expect(result.errorClass).toBe('transient');
  });

  it('classifies timeout messages as transient', () => {
    const result = classifyLLMError(new Error('Connection timed out'));
    expect(result.retryable).toBe(true);
    expect(result.errorClass).toBe('transient');
  });

  it('classifies LLM StepTimeout as transient; tool Abort/TOOL_* as non-retryable', () => {
    // LLM 经 stepTimeout.wrap 抛 StepTimeoutError：须 transient（与 a1301eb7 对齐）
    const stepTimeout = classifyLLMError(
      Object.assign(new Error('Step "call-1" exceeded timeout of 30ms'), {
        name: 'StepTimeoutError',
      }),
    );
    expect(stepTimeout.retryable).toBe(true);
    expect(stepTimeout.errorClass).toBe('transient');

    // 父取消 AbortError：不可重试
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    const abort = classifyLLMError(abortErr);
    expect(abort.retryable).toBe(false);
    expect(abort.errorClass).toBe('unknown');

    // 工具标记：不可重试
    expect(classifyLLMError(new Error('TOOL_TIMEOUT: "x" exceeded 30ms')).retryable).toBe(false);
    expect(classifyLLMError(new Error('TOOL_ABORTED: parent abortSignal fired')).retryable).toBe(
      false,
    );

    // 网络 abort 仍可 transient retry（无 ECONNABORTED 误伤）
    const net = classifyLLMError(new Error('network ECONNABORTED'));
    expect(net.retryable).toBe(true);
    expect(net.errorClass).toBe('transient');
  });

  it('classifies network errors as transient', () => {
    const result = classifyLLMError(new Error('ECONNREFUSED connect'));
    expect(result.retryable).toBe(true);
  });

  it('classifies unknown errors as permanent', () => {
    const result = classifyLLMError(new Error('Some random error'));
    expect(result.retryable).toBe(false);
    expect(result.errorClass).toBe('unknown');
  });

  it('handles null/undefined input', () => {
    const result = classifyLLMError(null);
    expect(result.retryable).toBe(false);
    expect(result.errorClass).toBe('unknown');
  });

  it('extracts status from error message text', () => {
    const err = new Error('HTTP 503 Service Unavailable');
    const result = classifyLLMError(err);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(503);
  });

  it('extracts Retry-After from response headers', () => {
    const err = {
      status: 429,
      message: 'too many requests',
      response: { headers: { 'Retry-After': '10' } },
    };
    const result = classifyLLMError(err);
    expect(result.retryAfter).toBe(10000);
  });

  it('classifies fetch failed as transient', () => {
    const result = classifyLLMError(new Error('fetch failed: something went wrong'));
    expect(result.retryable).toBe(true);
    expect(result.errorClass).toBe('transient');
  });

  it('truncates long error messages', () => {
    const longMsg = 'x'.repeat(500);
    const result = classifyLLMError(new Error(longMsg));
    expect(result.message.length).toBeLessThanOrEqual(203); // 200 + '...'
  });
});

describe('computeBackoff', () => {
  it('computes exponential backoff for attempt 0', () => {
    const result = computeBackoff(0, 1000, 30000);
    expect(result).toBeGreaterThanOrEqual(800);
    expect(result).toBeLessThanOrEqual(1200);
  });

  it('computes exponential backoff for attempt 1', () => {
    const result = computeBackoff(1, 1000, 30000);
    expect(result).toBeGreaterThanOrEqual(1600);
    expect(result).toBeLessThanOrEqual(2400);
  });

  it('computes exponential backoff for attempt 2', () => {
    const result = computeBackoff(2, 1000, 30000);
    expect(result).toBeGreaterThanOrEqual(3200);
    expect(result).toBeLessThanOrEqual(4800);
  });

  it('caps at maxMs', () => {
    for (let i = 0; i < 20; i++) {
      const result = computeBackoff(10, 1000, 30000);
      expect(result).toBeLessThanOrEqual(30000);
    }
  });

  it('uses custom baseMs', () => {
    const result = computeBackoff(0, 2000, 60000);
    expect(result).toBeGreaterThanOrEqual(1600);
    expect(result).toBeLessThanOrEqual(2400);
  });

  it('jitter produces variance', () => {
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(computeBackoff(0, 1000, 30000));
    }
    // With 20 samples and 20% jitter, should see at least 2 distinct values
    expect(results.size).toBeGreaterThanOrEqual(2);
  });
});
