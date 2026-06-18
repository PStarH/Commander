import { isUrlSafe } from './urlSafety';

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST' | 'HEAD';
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  body: string;
  bytes: number;
  truncated: boolean;
  contentType: string;
  finalUrl: string;
}

export class SafeFetchError extends Error {
  readonly name = 'SafeFetchError';
  constructor(
    public readonly code: 'timeout' | 'too_large' | 'network' | 'unsafe_url' | 'aborted',
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function performFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (timedOut) {
      throw new SafeFetchError('timeout', `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new SafeFetchError('aborted', `Request to ${url} was aborted`);
    }
    throw new SafeFetchError('network', `Network error: ${(err as Error).message}`);
  }

  if (options.method === 'HEAD' || !response.body) {
    clearTimeout(timer);
    return {
      ok: response.ok,
      status: response.status,
      body: '',
      bytes: 0,
      truncated: false,
      contentType: response.headers.get('content-type') ?? '',
      finalUrl: response.url,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        const allowed = Math.max(0, value.byteLength - (bytes - maxBytes));
        if (allowed > 0) {
          chunks.push(decoder.decode(value.subarray(0, allowed), { stream: true }));
        }
        bytes = maxBytes;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    if (timedOut) {
      throw new SafeFetchError('timeout', `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new SafeFetchError('network', `Stream read error: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  chunks.push(decoder.decode());
  return {
    ok: response.ok,
    status: response.status,
    body: chunks.join(''),
    bytes,
    truncated,
    contentType: response.headers.get('content-type') ?? '',
    finalUrl: response.url,
  };
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const safety = isUrlSafe(url);
  if (!safety.safe) {
    throw new SafeFetchError('unsafe_url', `URL blocked: ${safety.reason}`);
  }
  return performFetch(url, options);
}
