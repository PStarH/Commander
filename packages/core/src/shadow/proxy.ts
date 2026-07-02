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

  private async mirror(ctx: ProxyContext): Promise<void> {
    const scrubbed = scrubRequest(ctx.request, this.config.ignoreFields);
    const shadowUrl = this.config.endpoint + ctx.request.url;
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
        endpoint: ctx.request.url,
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
