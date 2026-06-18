export type ErrorClass = 'transient' | 'permanent' | 'unknown';

export interface ClassifiedError {
  retryable: boolean;
  errorClass: ErrorClass;
  message: string;
  statusCode?: number;
  retryAfter?: number;
}

const RE_NETWORK_ERROR =
  /timeout|timed out|econnrefused|econnreset|enotfound|connection refused|network|fetch failed|abort|econnaborted|esockettimedout/i;

export function classifyLLMError(err: unknown): ClassifiedError {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const statusCode = extractStatus(err);

  // Permanent: never retry
  if (statusCode === 400)
    return {
      retryable: false,
      errorClass: 'permanent',
      message: `Bad request: ${truncate(msg, 200)}`,
      statusCode: 400,
    };
  if (statusCode === 401)
    return {
      retryable: false,
      errorClass: 'permanent',
      message: 'Authentication failed: invalid API key',
      statusCode: 401,
    };
  if (statusCode === 403)
    return {
      retryable: false,
      errorClass: 'permanent',
      message: 'Forbidden: insufficient permissions',
      statusCode: 403,
    };
  if (statusCode === 422)
    return {
      retryable: false,
      errorClass: 'permanent',
      message: `Invalid request: ${truncate(msg, 200)}`,
      statusCode: 422,
    };

  // Transient: retry with backoff
  if (statusCode === 429) {
    const retryAfter = extractRetryAfter(err);
    return {
      retryable: true,
      errorClass: 'transient',
      message: truncate(msg, 200),
      statusCode: 429,
      retryAfter,
    };
  }
  if (statusCode === 529)
    return { retryable: true, errorClass: 'transient', message: 'API overloaded', statusCode: 529 };
  if (statusCode && statusCode >= 500)
    return { retryable: true, errorClass: 'transient', message: truncate(msg, 200), statusCode };

  // HTTP 408 Request Timeout — always retryable (GAP-26)
  if (statusCode === 408)
    return {
      retryable: true,
      errorClass: 'transient',
      message: truncate(msg, 200),
      statusCode: 408,
    };

  // Network/timeout errors: transient (GAP-26: added ECONNABORTED, ESOCKETTIMEDOUT)
  if (RE_NETWORK_ERROR.test(msg)) {
    return { retryable: true, errorClass: 'transient', message: truncate(msg, 200) };
  }

  return { retryable: false, errorClass: 'unknown', message: truncate(msg, 200) };
}

export function computeBackoff(
  attempt: number,
  baseMs: number = 1000,
  maxMs: number = 30000,
): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponential * 0.2 * (Math.random() - 0.5);
  return Math.min(Math.round(exponential + jitter), maxMs);
}

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    const msg = typeof e.message === 'string' ? e.message : '';
    const m = msg.match(/\b(4\d{2}|5\d{2})\b/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function extractRetryAfter(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const e = err as { headers?: unknown; response?: { headers?: unknown } };
    const hdrs = e.headers ?? e.response?.headers;
    if (hdrs && typeof hdrs === 'object') {
      const h = hdrs as Record<string, unknown>;
      const val = h['retry-after'] ?? h['Retry-After'];
      if (val) return parseInt(String(val), 10) * 1000;
    }
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}
