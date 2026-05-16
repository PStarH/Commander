export type ErrorClass = 'transient' | 'permanent' | 'unknown';

export interface ClassifiedError {
  retryable: boolean;
  errorClass: ErrorClass;
  message: string;
  statusCode?: number;
  retryAfter?: number;
}

export function classifyLLMError(err: unknown): ClassifiedError {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const statusCode = extractStatus(err);

  // Permanent: never retry
  if (statusCode === 400) return { retryable: false, errorClass: 'permanent', message: `Bad request: ${truncate(msg, 200)}`, statusCode: 400 };
  if (statusCode === 401) return { retryable: false, errorClass: 'permanent', message: 'Authentication failed: invalid API key', statusCode: 401 };
  if (statusCode === 403) return { retryable: false, errorClass: 'permanent', message: 'Forbidden: insufficient permissions', statusCode: 403 };
  if (statusCode === 422) return { retryable: false, errorClass: 'permanent', message: `Invalid request: ${truncate(msg, 200)}`, statusCode: 422 };

  // Transient: retry with backoff
  if (statusCode === 429) {
    const retryAfter = extractRetryAfter(err);
    return { retryable: true, errorClass: 'transient', message: truncate(msg, 200), statusCode: 429, retryAfter };
  }
  if (statusCode === 529) return { retryable: true, errorClass: 'transient', message: 'API overloaded', statusCode: 529 };
  if (statusCode && statusCode >= 500) return { retryable: true, errorClass: 'transient', message: truncate(msg, 200), statusCode };

  // HTTP 408 Request Timeout — always retryable (GAP-26)
  if (statusCode === 408) return { retryable: true, errorClass: 'transient', message: truncate(msg, 200), statusCode: 408 };

  // Network/timeout errors: transient (GAP-26: added ECONNABORTED, ESOCKETTIMEDOUT)
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound') || msg.includes('connection refused') || msg.includes('network') || msg.includes('fetch failed') || msg.includes('abort') || msg.includes('econnaborted') || msg.includes('esockettimedout')) {
    return { retryable: true, errorClass: 'transient', message: truncate(msg, 200) };
  }

  return { retryable: false, errorClass: 'unknown', message: truncate(msg, 200) };
}

export function computeBackoff(attempt: number, baseMs: number = 1000, maxMs: number = 30000): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponential * 0.2 * (Math.random() - 0.5);
  return Math.round(exponential + jitter);
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    if ('status' in err && typeof (err as any).status === 'number') return (err as any).status;
    if ('statusCode' in err && typeof (err as any).statusCode === 'number') return (err as any).statusCode;
    const msg = (err as any).message || '';
    const m = msg.match(/\b(4\d{2}|5\d{2})\b/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function extractRetryAfter(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const headers = (err as any).headers || (err as any).response?.headers;
    if (headers) {
      const val = headers['retry-after'] || headers['Retry-After'];
      if (val) return parseInt(val, 10) * 1000;
    }
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
