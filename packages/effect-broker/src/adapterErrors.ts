export type AdapterCommitState = 'NOT_COMMITTED' | 'UNKNOWN';
export type AdapterRetryMode = 'SAFE' | 'QUERY_FIRST' | 'NEVER';

export class AdapterExecutionError extends Error {
  readonly code: string;
  readonly commitState: AdapterCommitState;
  readonly retryMode: AdapterRetryMode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    init: {
      code: string;
      commitState: AdapterCommitState;
      retryMode: AdapterRetryMode;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = 'AdapterExecutionError';
    this.code = init.code;
    this.commitState = init.commitState;
    this.retryMode = init.retryMode;
    this.retryable = init.retryMode === 'SAFE';
    this.details = init.details;
  }
}

export function classifyAdapterError(error: AdapterExecutionError): {
  commitState: AdapterCommitState;
  retryMode: AdapterRetryMode;
} {
  return {
    commitState: error.commitState,
    retryMode: error.retryMode,
  };
}

export function adapterErrorFromHttpStatus(
  status: number,
  message: string,
  code = 'ADAPTER_HTTP_ERROR',
): AdapterExecutionError {
  if (status === 401 || status === 403) {
    return new AdapterExecutionError(message, {
      code,
      commitState: 'NOT_COMMITTED',
      retryMode: 'NEVER',
      details: { httpStatus: status },
    });
  }
  if (status === 429 || status >= 500) {
    return new AdapterExecutionError(message, {
      code,
      commitState: 'UNKNOWN',
      retryMode: 'QUERY_FIRST',
      details: { httpStatus: status },
    });
  }
  return new AdapterExecutionError(message, {
    code,
    commitState: 'NOT_COMMITTED',
    retryMode: 'NEVER',
    details: { httpStatus: status },
  });
}
