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
});
