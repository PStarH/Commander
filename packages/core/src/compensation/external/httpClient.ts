/**
 * Shared HTTP client for external compensation handlers.
 *
 * Responsibilities:
 *   1. Inject Idempotency-Key / Stripe-Idempotency-Key / X-Request-Id headers
 *      so retries are safe.
 *   2. Retry transient failures (5xx, 408, 429 with Retry-After) with
 *      exponential backoff + jitter.
 *   3. Buffer full response body so the compensation handler can
 *      introspect the upstream's "already done" semantic (e.g. 404 on
 *      a delete is usually a success).
 *   4. Never throw on HTTP error status — return a structured HttpResponse
 *      so the handler decides what to do.
 *
 * Why not just use fetch? Because compensation calls need tight control
 * over retries (we don't want to retry a non-idempotent POST), and the
 * `Idempotency-Key` plumbing is upstream-specific (Stripe calls it
 * `Idempotency-Key`, GitHub calls it `X-Idempotency-Key`, Notion has no
 * native support). The handler decides which header to use; this client
 * just plumbs the key.
 */

import { getGlobalLogger } from '../../logging';
import type {
  HttpRequest,
  HttpResponse,
  HttpSendFn as _HttpSendFn,
  CompensationOutcome,
} from './types';

// Re-export types for external handler files
export type { HttpRequest, HttpResponse, _HttpSendFn as HttpSendFn, CompensationOutcome };

const log = getGlobalLogger();

export interface ResilientHttpOptions {
  /** Maximum number of attempts (1 = no retry). Default 3. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 200. */
  initialBackoffMs?: number;
  /** Max backoff in ms. Default 5000. */
  maxBackoffMs?: number;
  /** Per-request timeout in ms. Default 30000. */
  defaultTimeoutMs?: number;
  /** Hook called for observability after each attempt. */
  onAttempt?: (info: {
    attempt: number;
    req: HttpRequest;
    res?: HttpResponse;
    err?: string;
    durationMs: number;
  }) => void;
}

const DEFAULT_OPTIONS: Required<Omit<ResilientHttpOptions, 'onAttempt'>> = {
  maxAttempts: 3,
  initialBackoffMs: 200,
  maxBackoffMs: 5000,
  defaultTimeoutMs: 30000,
};

/**
 * Classify an HTTP status code into retry / success / permanent failure.
 * Compensation semantics: 404 on DELETE is success ("already gone"), 410
 * is success ("intentionally gone"), 429 is retry, 5xx is retry, other
 * 4xx is permanent.
 */
export function classifyHttpStatus(
  status: number,
  _method: HttpRequest['method'],
): 'success' | 'not_found_ok' | 'retry' | 'permanent' {
  if (status >= 200 && status < 300) return 'success';
  if (status === 404 || status === 410) {
    // DELETE / idempotent inverse: "already compensated" is success.
    return 'not_found_ok';
  }
  if (status === 408 || status === 425 || status === 429) return 'retry';
  if (status >= 500) return 'retry';
  return 'permanent';
}

export class ResilientHttp {
  private readonly options: Required<Omit<ResilientHttpOptions, 'onAttempt'>>;
  private readonly onAttempt?: ResilientHttpOptions['onAttempt'];
  private readonly sendFn: _HttpSendFn;

  constructor(send: _HttpSendFn, options: ResilientHttpOptions = {}) {
    this.sendFn = send;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.onAttempt = options.onAttempt;
  }

  /**
   * Send a request with retries. Returns the LAST response, never throws.
   * Use {@link sendWithClassification} for the convenience wrapper that
   * turns status codes into CompensationOutcome.
   */
  async send(req: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? this.options.defaultTimeoutMs;
    const idempotencyKey = req.idempotencyKey;
    const max = idempotencyKey ? this.options.maxAttempts : 1;

    let attempt = 0;
    let lastResponse: HttpResponse | null = null;
    let lastError: string | null = null;

    while (attempt < max) {
      attempt++;
      const start = Date.now();
      try {
        const res = await this.sendFn({
          ...req,
          timeoutMs,
          headers: idempotencyKey
            ? { ...(req.headers ?? {}), 'Idempotency-Key': idempotencyKey }
            : req.headers,
        });
        const durationMs = Date.now() - start;
        lastResponse = res;
        this.onAttempt?.({ attempt, req, res, durationMs });
        const cls = classifyHttpStatus(res.status, req.method);
        if (cls !== 'retry') return res;
      } catch (err) {
        const durationMs = Date.now() - start;
        lastError = (err as Error).message;
        this.onAttempt?.({ attempt, req, err: lastError, durationMs });
        log.warn('CompensationHTTP', `Attempt ${attempt} threw`, {
          url: req.url,
          method: req.method,
          err: lastError,
        });
      }

      if (attempt < max) {
        const delay = this.computeBackoff(attempt);
        await new Promise<void>((r) => {
          const t = setTimeout(r, delay);
          t.unref();
        });
      }
    }

    if (lastResponse) return lastResponse;
    return {
      status: 0,
      headers: {},
      body: lastError ?? 'no response',
      ok: false,
    };
  }

  /**
   * Send a request and return a structured CompensationOutcome. The
   * handler's "already gone" case (404/410) is treated as success so the
   * saga path continues; a non-retryable 4xx surfaces as a permanent
   * failure; 5xx/429/timeout surface as a retryable failure.
   */
  async sendWithClassification(
    req: HttpRequest,
  ): Promise<{ res: HttpResponse; outcome: CompensationOutcome }> {
    const res = await this.send(req);
    const cls = classifyHttpStatus(res.status, req.method);
    if (cls === 'success') {
      return { res, outcome: { success: true } };
    }
    if (cls === 'not_found_ok') {
      return {
        res,
        outcome: { success: true, alreadyCompensated: true },
      };
    }
    if (cls === 'retry') {
      return {
        res,
        outcome: {
          success: false,
          error: `Retryable HTTP ${res.status}: ${res.body.slice(0, 200)}`,
        },
      };
    }
    return {
      res,
      outcome: {
        success: false,
        permanent: true,
        error: `Permanent HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      },
    };
  }

  private computeBackoff(attempt: number): number {
    const base = this.options.initialBackoffMs * Math.pow(2, attempt - 1);
    const capped = Math.min(base, this.options.maxBackoffMs);
    // Equal jitter: half base + half random. Avoids thundering herd.
    return Math.floor(capped / 2 + Math.random() * (capped / 2));
  }
}

// ============================================================================
// Node fetch adapter
// ============================================================================

/**
 * Default send function backed by Node's built-in fetch (Node 18+).
 * Compensation handlers can override this (e.g. for tests) by passing a
 * different function to the ResilientHttp constructor.
 */
export const nodeFetchHttp: _HttpSendFn = async (req: import('./types').HttpRequest) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 30000);
  try {
    const fetchRes = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    fetchRes.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await fetchRes.text();
    return {
      status: fetchRes.status,
      headers,
      body,
      ok: fetchRes.ok,
    };
  } finally {
    clearTimeout(timer);
  }
};

// ============================================================================
// Per-system header helpers
// ============================================================================

/**
 * Some APIs require the idempotency key under a specific header name.
 * This maps the canonical `Idempotency-Key` header to the upstream's
 * expected name. The handler picks which map to use.
 */
export const IDEMPOTENCY_HEADER_BY_SYSTEM: Record<string, string> = {
  stripe: 'Idempotency-Key',
  github: 'X-Idempotency-Key',
  linear: 'linear-idempotency-key', // speculative; not all APIs support it
};

/**
 * Build a stable idempotency key from the compensation context. The key
 * is the SHA-256 of (runId + actionId + system + inverse-name) so the
 * same compensation can be retried safely.
 */
export function buildCompensationIdempotencyKey(input: {
  runId: string;
  actionId: string;
  system: string;
  inverse: string;
}): string {
  return `${input.system}:${input.inverse}:${input.runId}:${input.actionId}`;
}
