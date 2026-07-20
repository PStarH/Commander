// packages/core/src/shadow/proxy.ts
import type { ShadowConfig, DriftEntry } from './types';
import { scrubRequest } from './scrubber';
import { reportSilentFailure } from '../silentFailureReporter';
import { DriftReporter } from './driftReporter';

export interface ProxyContext {
  request: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response: { status: number; body?: unknown };
  latencyMs: number;
  costUsd: number;
  tenantId?: string;
}

export type Next = () => Promise<void> | void;

export class ShadowProxy {
  private rng: () => number;
  private reporter?: DriftReporter;

  constructor(
    private config: ShadowConfig,
    opts?: { reporter?: DriftReporter; seed?: number },
  ) {
    this.reporter = opts?.reporter;
    this.rng = opts?.seed !== undefined ? mulberry32(opts.seed) : Math.random;
  }

  middleware() {
    return async (ctx: ProxyContext, next: Next): Promise<void> => {
      await next();
      if (!this.config.enabled) return;
      if (this.rng() > this.config.sampleRate) return;

      this.mirror(ctx).catch((err) => reportSilentFailure(err, 'shadow:proxy:mirror'));
    };
  }

  /**
   * Express/Connect compatible middleware. Captures request/response and
   * mirrors a sampled subset of traffic to the configured shadow endpoint.
   * Returns early when shadow is disabled so there is zero overhead.
   */
  expressMiddleware() {
    return (req: unknown, res: unknown, next: (err?: unknown) => void): void => {
      if (!this.config.enabled) {
        return next();
      }

      const request = req as {
        method: string;
        url: string;
        headers: Record<string, string>;
        body?: unknown;
      };
      const response = res as {
        statusCode: number;
        status: (code: number) => unknown;
        json: (body: unknown) => unknown;
        send: (body: unknown) => unknown;
        on: (event: string, listener: () => void) => unknown;
        removeListener: (event: string, listener: () => void) => unknown;
      };

      const start = Date.now();
      let capturedBody: unknown;
      let bodyCaptured = false;

      const originalJson = response.json.bind(response);
      const originalSend = response.send.bind(response);

      response.json = (body: unknown): unknown => {
        if (!bodyCaptured) {
          capturedBody = body;
          bodyCaptured = true;
        }
        return originalJson(body);
      };
      response.send = (body: unknown): unknown => {
        if (!bodyCaptured && typeof body !== 'string') {
          capturedBody = body;
          bodyCaptured = true;
        }
        return originalSend(body);
      };

      const onFinish = (): void => {
        response.removeListener('finish', onFinish);
        if (this.rng() > this.config.sampleRate) return;

        const ctx: ProxyContext = {
          request: {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
          },
          response: {
            status: response.statusCode,
            body: capturedBody,
          },
          latencyMs: Date.now() - start,
          costUsd: 0,
        };
        this.mirror(ctx).catch((err) => reportSilentFailure(err, 'shadow:proxy:mirror'));
      };

      response.on('finish', onFinish);
      next();
    };
  }

  private async mirror(ctx: ProxyContext): Promise<void> {
    // Scrub headers, body, AND url — query/path secrets must not reach shadow.
    const scrubbed = scrubRequest(
      {
        headers: ctx.request.headers,
        body: ctx.request.body,
        url: ctx.request.url,
      },
      this.config.ignoreFields,
    );
    const safePath = scrubbed.url ?? '/';
    const shadowUrl = this.config.endpoint + safePath;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const start = Date.now();
      const res = await fetch(shadowUrl, {
        method: ctx.request.method,
        headers: scrubbed.headers,
        body: scrubbed.body ? JSON.stringify(scrubbed.body) : undefined,
        signal: controller.signal,
      });
      const shadowLatency = Date.now() - start;
      const shadowStatus = res.status;

      const entry: DriftEntry = {
        timestamp: new Date().toISOString(),
        endpoint: safePath,
        prodStatus: ctx.response.status,
        shadowStatus,
        prodLatencyMs: ctx.latencyMs,
        shadowLatencyMs: shadowLatency,
        prodCostUsd: ctx.costUsd,
        shadowCostUsd: 0,
        driftDetected: shadowStatus !== ctx.response.status,
        metrics: {
          statusDeltaPct: shadowStatus === ctx.response.status ? 0 : 100,
          latencyDeltaPct: ((shadowLatency - ctx.latencyMs) / Math.max(ctx.latencyMs, 1)) * 100,
          costDeltaPct: 0,
        },
      };
      this.reporter?.record(entry);
    } catch (err) {
      reportSilentFailure(err, 'shadow:proxy:fetch');
    } finally {
      clearTimeout(timer);
    }
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
