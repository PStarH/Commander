import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AdapterExecutionError,
  adapterErrorFromHttpStatus,
  classifyAdapterError,
} from './adapterErrors.js';

describe('AdapterExecutionError', () => {
  it('classifies NOT_COMMITTED NEVER as non-retryable', () => {
    const error = new AdapterExecutionError('auth failed', {
      code: 'GITHUB_UNAUTHORIZED',
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
    assert.equal(error.retryable, false);
    assert.deepEqual(classifyAdapterError(error), {
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
    });
  });

  it('classifies UNKNOWN QUERY_FIRST as non-retryable via retryable flag', () => {
    const error = new AdapterExecutionError('upstream timeout', {
      code: 'GITHUB_UPSTREAM',
      commitState: 'UNKNOWN',
      retryMode: 'QUERY_FIRST',
    });
    assert.equal(error.retryable, false);
    assert.deepEqual(classifyAdapterError(error), {
      commitState: 'UNKNOWN',
      retryMode: 'QUERY_FIRST',
    });
  });

  it('classifies SAFE as retryable', () => {
    const error = new AdapterExecutionError('transient', {
      code: 'ADAPTER_TRANSIENT',
      commitState: 'NOT_COMMITTED',
      retryMode: 'SAFE',
    });
    assert.equal(error.retryable, true);
  });

  it('adapterErrorFromHttpStatus maps 401/403 to NOT_COMMITTED NEVER', () => {
    const error = adapterErrorFromHttpStatus(403, 'forbidden');
    assert.equal(error.commitState, 'NOT_COMMITTED');
    assert.equal(error.retryMode, 'NEVER');
    assert.equal(error.details?.httpStatus, 403);
  });

  it('adapterErrorFromHttpStatus maps 429/5xx to UNKNOWN QUERY_FIRST', () => {
    const rateLimited = adapterErrorFromHttpStatus(429, 'rate limited');
    assert.equal(rateLimited.commitState, 'UNKNOWN');
    assert.equal(rateLimited.retryMode, 'QUERY_FIRST');

    const serverError = adapterErrorFromHttpStatus(503, 'unavailable');
    assert.equal(serverError.commitState, 'UNKNOWN');
    assert.equal(serverError.retryMode, 'QUERY_FIRST');
  });

  it('adapterErrorFromHttpStatus maps 3xx redirects to UNKNOWN QUERY_FIRST', () => {
    // A redirect is not proof that the origin skipped the write (307/308 expect
    // the caller to repeat), so it must not be reported as NOT_COMMITTED/NEVER.
    for (const status of [301, 302, 303, 307, 308]) {
      const error = adapterErrorFromHttpStatus(status, `redirect ${status}`);
      assert.equal(error.commitState, 'UNKNOWN', `status ${status} commitState`);
      assert.equal(error.retryMode, 'QUERY_FIRST', `status ${status} retryMode`);
      assert.equal(error.details?.httpStatus, status);
      assert.equal(error.retryable, false);
    }
  });
});
