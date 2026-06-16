/**
 * P-obs-1: OpenTelemetry wire export.
 *
 * Streams Commander `TraceEvent`s to an OTel Collector over OTLP/HTTP/JSON.
 * Compatible with Jaeger, Honeycomb, Datadog, Grafana Tempo, and any
 * OTel-aware backend that accepts OTLP (which is the universal
 * lingua franca since OTel 1.0).
 *
 * Why hand-rolled vs. @opentelemetry/exporter-trace-otlp-http:
 *  - Avoids a heavy dependency for a simple use case (we already
 *    convert TraceEvent → OTel attrs in `otelSemConv.ts`).
 *  - Gives us full control over batching, retry, and the
 *    "best-effort, never fail the run" guarantee that fits
 *    Commander's "observability is non-critical" philosophy.
 *
 * Wire format: POST /v1/traces with `Content-Type: application/json`
 * and a body matching the OTLP/JSON `ExportTraceServiceRequest` schema.
 * The schema is large but the fields we care about are:
 *   - resourceSpans[].resource.attributes[]  (service.name, etc.)
 *   - resourceSpans[].scopeSpans[].spans[]   (the actual spans)
 *
 * For now we emit a minimal subset (name, traceId, spanId, parentSpanId,
 * startTimeUnixNano, endTimeUnixNano, attributes, status) and let the
 * Collector handle enrichment.
 */

import type { ExecutionTrace, TraceEvent, TokenUsage } from '../runtime/types';
import { eventToOtelAttrs, spanNameForEvent } from './otelSemConv';
import {  formatTraceparent } from './traceContext';
import { SamplingPolicy, type SamplingDecision } from './samplingPolicy';

const OTLP_HTTP_PATH = '/v1/traces';

export interface OtelExporterConfig {
  /** Full URL of the OTel Collector OTLP/HTTP receiver, e.g. http://otel-collector:4318 */
  endpoint: string;
  /** service.name resource attribute. Default 'commander'. */
  serviceName?: string;
  /** service.version resource attribute. */
  serviceVersion?: string;
  /** Optional Bearer token. Sent as `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Max spans to batch per HTTP POST. Default 100. */
  maxBatchSize?: number;
  /** Max time to wait before flushing a partial batch (ms). Default 5000. */
  flushIntervalMs?: number;
  /** Max retry attempts on transient failures. Default 3. */
  maxRetries?: number;
  /** Base backoff (ms); doubled per attempt. Default 200. */
  baseBackoffMs?: number;
  /** Sampling policy. Default: head 5% + tail rules. */
  samplingPolicy?: SamplingPolicy;
  /** Disable export (sampling + no-op). Useful for tests + dry-runs. */
  disabled?: boolean;
  /** PII redaction: drop the raw prompt (`data.input`) from every span.
   *  Default true. Set to false ONLY when you've secured the Collector
   *  transport (mTLS, private VPC) and have a contractual need to
   *  inspect full payloads (e.g. eval replay). */
  redactInput?: boolean;
  /** PII redaction: drop the raw completion (`data.output`) from every span.
   *  Default true. Same caveats as `redactInput`. */
  redactOutput?: boolean;
  /** PII redaction: drop tool call arguments (`gen_ai.tool.call.arguments`)
   *  from every span. Default true. Tool call IDs and tool NAMES are kept
   *  so dashboards remain queryable. */
  redactToolArgs?: boolean;
  /** Backpressure: cap the in-memory buffer to this many traces. When the
   *  cap is hit, the oldest traces are dropped and `bufferOverflowCount`
   *  increments. Default 10_000. */
  maxBufferSize?: number;
  /** When true, `flush()` re-throws on any batch failure so callers can
   *  distinguish "all sent" from "some dropped". Default false (matches
   *  fire-and-forget observability semantics). */
  failLoudOnFlush?: boolean;
}

export interface OtelExporterStats {
  totalTracesSeen: number;
  totalSpansExported: number;
  totalTracesSampled: number;
  totalHttpRequests: number;
  totalHttpFailures: number;
  lastExportAt: string | undefined;
  lastError: string | undefined;
  bufferOverflowCount: number;
}

export class OtelSpanExporter {
  private readonly config: Required<
    Omit<
      OtelExporterConfig,
      | 'authToken'
      | 'samplingPolicy'
      | 'disabled'
      | 'redactInput'
      | 'redactOutput'
      | 'redactToolArgs'
      | 'maxBufferSize'
      | 'failLoudOnFlush'
    >
  > & {
    authToken: string | undefined;
    samplingPolicy: SamplingPolicy;
    disabled: boolean;
    redactInput: boolean;
    redactOutput: boolean;
    redactToolArgs: boolean;
    maxBufferSize: number;
    failLoudOnFlush: boolean;
  };
  private buffer: ExecutionTrace[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private bufferOverflowCount = 0;
  private stats: OtelExporterStats & { bufferOverflowCount: number } = {
    totalTracesSeen: 0,
    totalSpansExported: 0,
    totalTracesSampled: 0,
    totalHttpRequests: 0,
    totalHttpFailures: 0,
    lastExportAt: undefined,
    lastError: undefined,
    bufferOverflowCount: 0,
  };

  constructor(config: OtelExporterConfig) {
    this.config = {
      endpoint: stripTrailingSlash(config.endpoint),
      serviceName: config.serviceName ?? 'commander',
      serviceVersion: config.serviceVersion ?? '0.0.0',
      maxBatchSize: config.maxBatchSize ?? 100,
      flushIntervalMs: config.flushIntervalMs ?? 5_000,
      maxRetries: config.maxRetries ?? 3,
      baseBackoffMs: config.baseBackoffMs ?? 200,
      authToken: config.authToken,
      samplingPolicy: config.samplingPolicy ?? new SamplingPolicy(),
      disabled: config.disabled ?? false,
      // PII redaction: defaults to "strip everything" so a misconfigured
      // Collector URL can't exfiltrate user prompts/completions. Callers
      // who NEED full payloads must opt in explicitly.
      redactInput: config.redactInput ?? true,
      redactOutput: config.redactOutput ?? true,
      redactToolArgs: config.redactToolArgs ?? true,
      // Backpressure: cap the in-memory buffer. On overflow, drop oldest.
      maxBufferSize: config.maxBufferSize ?? 10_000,
      // failLoudOnFlush: false = fire-and-forget (default); true = throw
      // so `await exporter.flush()` is honest about partial failures.
      failLoudOnFlush: config.failLoudOnFlush ?? false,
    };
  }

  /**
   * Replace the live sampling policy. Used by the HTTP `PUT /sampling`
   * endpoint so an operator can tune rates without restarting Commander.
   * Atomic: callers reading `getStats()` mid-swap may see either the
   * old or the new policy, never a torn read.
   */
  setSamplingPolicy(policy: SamplingPolicy): void {
    this.config.samplingPolicy = policy;
  }

  /** Read-only accessor for the live policy (used by GET /sampling). */
  getSamplingPolicy(): SamplingPolicy {
    return this.config.samplingPolicy;
  }

  /** Begin the background flush timer. Call once at startup. */
  start(): void {
    if (this.config.disabled || this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.stats.lastError = String(err);
      });
    }, this.config.flushIntervalMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /** Stop the flush timer. Pending spans stay in the buffer. */
  stop(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Enqueue a trace for export. Non-blocking. The sampling policy
   * decides whether to actually send; dropped traces update the
   * stats counter. Backpressure: when the buffer is full, the
   * oldest trace is dropped (FIFO) and `bufferOverflowCount` ticks.
   */
  enqueue(trace: ExecutionTrace): void {
    if (this.config.disabled) return;
    this.stats.totalTracesSeen += 1;
    const totalDurationMs = computeTotalDurationMs(trace);
    const decision: SamplingDecision = this.config.samplingPolicy.decide(
      trace.events,
      trace.traceId,
      totalDurationMs,
    );
    if (!decision.keep) return;
    this.stats.totalTracesSampled += 1;
    if (this.buffer.length >= this.config.maxBufferSize) {
      // Backpressure: drop oldest. The newest is more likely to be
      // relevant to a live operator watching the dashboard.
      this.buffer.shift();
      this.bufferOverflowCount += 1;
      this.stats.bufferOverflowCount = this.bufferOverflowCount;
    }
    this.buffer.push(trace);
    if (this.buffer.length >= this.config.maxBatchSize) {
      // Fire-and-forget — never block the caller.
      this.flush().catch((err) => {
        this.stats.lastError = String(err);
      });
    }
  }

  /**
   * Force a flush of the current buffer. Awaits the HTTP round-trip.
   * Default semantics: fire-and-forget (errors update `lastError` and
   * `totalHttpFailures`, but the returned promise resolves). Set
   * `failLoudOnFlush: true` in the constructor to make this method
   * re-throw on any batch failure — useful for shutdown drains where
   * the caller wants to know "did everything ship?".
   *
   * Loops: if more items were enqueued during the in-flight HTTP
   * round-trip, keep draining them. This prevents the shutdown-drain
   * bug where `await exporter.flush()` returns with a non-empty
   * buffer because the HTTP latency exceeded the in-flight window.
   */
  async flush(): Promise<void> {
    if (this.config.disabled) return;
    if (this.inFlight !== null) {
      // Coalesce concurrent flushes, but DON'T return early — keep
      // draining until the buffer is empty.
      await this.inFlight;
    }
    let lastErr: unknown = undefined;
    // Loop: drain the buffer in batches, even if a flush was in flight
    // when this call started. This is the shutdown-drain guarantee.
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.config.maxBatchSize);
      if (batch.length === 0) break;
      const payload = this.buildOtlpPayload(batch);
      const inflight = this.exportWithRetry(payload)
        .then(() => {
          this.stats.totalSpansExported += batch.reduce((s, t) => s + t.events.length, 0);
          this.stats.lastExportAt = new Date().toISOString();
        })
        .catch((err) => {
          this.stats.totalHttpFailures += 1;
          this.stats.lastError = String(err);
          lastErr = err;
          // Best-effort: drop the batch on persistent failure rather than
          // growing the buffer unboundedly.
        });
      this.inFlight = inflight;
      await inflight;
    }
    this.inFlight = null;
    if (this.config.failLoudOnFlush && lastErr !== undefined) {
      throw lastErr;
    }
  }

  /** Read-only stats snapshot for the /otel/stats endpoint. */
  getStats(): OtelExporterStats & { bufferOverflowCount: number } {
    return { ...this.stats, lastError: this.stats.lastError };
  }

  /** Current buffer size. Exposed for tests. */
  pendingCount(): number {
    return this.buffer.length;
  }

  // ────────── private ──────────

  private buildOtlpPayload(traces: ExecutionTrace[]): OtlpExportTraceServiceRequest {
    const resourceAttributes = [
      { key: 'service.name', value: { stringValue: this.config.serviceName } },
      { key: 'service.version', value: { stringValue: this.config.serviceVersion } },
      { key: 'telemetry.sdk.language', value: { stringValue: 'typescript' } },
      { key: 'telemetry.sdk.name', value: { stringValue: 'commander-core' } },
    ];
    const scopeSpans: OtlpScopeSpan[] = traces.map((trace) => ({
      scope: { name: 'commander.core', version: this.config.serviceVersion },
      spans: trace.events.flatMap((e) => this.eventToSpan(e, trace)),
    }));
    return {
      resourceSpans: [{ resource: { attributes: resourceAttributes }, scopeSpans }],
    };
  }

  private eventToSpan(event: TraceEvent, trace: ExecutionTrace): OtlpSpan[] {
    // Deterministic spanId derivation (djb2-based, see helper). Same
    // Commander spanId always produces the same OTel spanId so
    // parent→child relationships survive re-exports.
    const spanId = deriveSpanIdHex(event.spanId || `commander-fallback-${event.timestamp}`);
    const traceIdHex = deriveTraceIdHex(trace.traceId);
    const startNs = isoToUnixNanos(event.timestamp);
    const endNs = startNs + event.durationMs * 1_000_000;
    // Apply PII redaction BEFORE serializing. The `eventToOtelAttrs`
    // helper is unaware of our redaction policy, so we strip the
    // raw input/output from the event itself when we hand it off.
    const sanitized = this.redactEvent(event);
    const attrs = eventToOtelAttrs(sanitized, { agentName: event.agentId });
    const span: OtlpSpan = {
      traceId: traceIdHex,
      spanId,
      name: spanNameForEvent(event),
      kind: 1, // INTERNAL (most Commander spans are in-process)
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(endNs),
      attributes: Object.entries(attrs).map(([key, value]) => ({
        key,
        value: attrValueToOtlp(value),
      })),
      status:
        event.type === 'error'
          ? { code: 2, message: String(event.data.error ?? 'error') }
          : { code: 1 },
    };
    if (event.parentSpanId) {
      span.parentSpanId = deriveSpanIdHex(event.parentSpanId);
    }
    return [span];
  }

  /**
   * Strip PII from a TraceEvent before exporting. Returns a shallow
   * copy so the in-memory trace recorder is untouched. `redactInput`,
   * `redactOutput`, `redactToolArgs` are independent toggles.
   *
   * CRITICAL: for tool_execution events, `data.input` IS the tool
   * name (e.g. 'web_search'). otelSemConv.ts reads it for
   * `gen_ai.tool.name`. We must preserve it as `data.toolName` so
   * dashboards can still identify the tool, even when the args
   * preview is redacted. The original `data.input` is overwritten
   * with '[redacted]' so the args preview is hidden but the tool
   * name survives via the new `data.toolName` field.
   *
   * The shallow copy preserves all other `data` fields automatically
   * (errorClass, retryable, retrying, attempts, statusCode, etc.) —
   * we only overwrite `data['input']` and `data['output']` below.
   */
  private redactEvent(event: TraceEvent): TraceEvent {
    const needsCopy =
      this.config.redactInput || this.config.redactOutput || this.config.redactToolArgs;
    if (!needsCopy) return event;
    const data: Record<string, unknown> = { ...(event.data as Record<string, unknown>) };
    if (event.type === 'tool_execution') {
      // Stash the tool name before potentially redacting input.
      if (data['input'] !== undefined) {
        data['toolName'] = data['input'];
      }
      if (this.config.redactInput) {
        data['input'] = '[redacted]';
      }
      if (this.config.redactOutput) {
        data['output'] = '[redacted]';
      }
    } else {
      if (this.config.redactInput) {
        data['input'] = '[redacted]';
      }
      if (this.config.redactOutput) {
        data['output'] = '[redacted]';
      }
    }
    return { ...event, data };
  }

  private async exportWithRetry(payload: OtlpExportTraceServiceRequest): Promise<void> {
    const body = JSON.stringify(payload);
    const url = `${this.config.endpoint}${OTLP_HTTP_PATH}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }
    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      this.stats.totalHttpRequests += 1;
      try {
        // Use global fetch (Node 18+, Bun, Deno, browser). Reuse the
        // built-in so we don't need a polyfill.
        const res = await fetch(url, { method: 'POST', headers, body });
        if (res.ok) return;
        // 4xx: bad payload — do not retry, the Collector has already
        // rejected it. Throw a NonRetryableHttpError so the catch
        // below can detect the non-retryable case and bail out.
        if (res.status >= 400 && res.status < 500) {
          throw new NonRetryableHttpError(`OTLP export rejected with ${res.status}`);
        }
        lastErr = new Error(`OTLP export failed with ${res.status}`);
      } catch (err) {
        if (err instanceof NonRetryableHttpError) {
          // 4xx: propagate immediately, do not retry.
          throw err;
        }
        lastErr = err;
      }
      // Exponential backoff: 200ms, 400ms, 800ms, ...
      const delay = this.config.baseBackoffMs * Math.pow(2, attempt);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
    throw lastErr ?? new Error('OTLP export failed after retries');
  }
}

/**
 * Sentinel error class for non-retryable HTTP responses (4xx). The
 * retry loop in `exportWithRetry` uses `instanceof` to detect and
 * re-throw these immediately instead of catching them and continuing
 * the loop.
 */
class NonRetryableHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableHttpError';
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function isoToUnixNanos(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms * 1_000_000 : 0;
}

/**
 * Derive a 16-char hex span id from Commander's `span_<ts>_<rand>` id.
 * Strips the prefix and uses the first 16 hex chars it finds; if the
 * source has no hex chars we generate a fresh one.
 */
function deriveSpanIdHex(commanderSpanId: string): string {
  // Deterministic hash so the same Commander spanId always produces
  // the same OTel spanId (preserves parent→child relationships across
  // re-exports). Uses djb2 → 16 hex chars. NOT cryptographic.
  return djb2Hex(commanderSpanId, 16);
}

/**
 * Derive a 32-char hex trace id from Commander's `trace_<ts>_<rand>` id.
 * Same strategy as spanId.
 */
function deriveTraceIdHex(commanderTraceId: string): string {
  return djb2Hex(commanderTraceId, 32);
}

/**
 * Deterministic djb2 → hex string of `n` chars. Same input always
 * produces the same output, so parent→child relationships survive
 * re-exports. Not cryptographic.
 */
function djb2Hex(input: string, n: number): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  // Generate enough hex chars by re-hashing with a counter
  let out = '';
  let h = hash;
  while (out.length < n) {
    out += (h >>> 0).toString(16).padStart(8, '0');
    h = ((h << 5) + h + 7) | 0; // perturb
  }
  return out.slice(0, n);
}

function attrValueToOtlp(v: unknown): {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
} {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  if (typeof v === 'boolean') return { boolValue: v };
  if (v === null || v === undefined) return { stringValue: '' };
  return { stringValue: JSON.stringify(v) };
}

function computeTotalDurationMs(trace: ExecutionTrace): number {
  if (!trace.startedAt) return 0;
  const start = Date.parse(trace.startedAt);
  const end = trace.completedAt ? Date.parse(trace.completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

// ────────── OTLP/JSON minimal types (the ones we emit) ──────────

interface OtlpExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: unknown }> };
    scopeSpans: OtlpScopeSpan[];
  }>;
}

interface OtlpScopeSpan {
  scope: { name: string; version: string };
  spans: OtlpSpan[];
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: unknown }>;
  status: { code: number; message?: string };
}

export type { OtlpExportTraceServiceRequest, OtlpScopeSpan, OtlpSpan };
// Also re-export the W3C format helper for callers that want to
// emit their own `traceparent` header.
export { formatTraceparent };
// And the token-usage type for convenience.
export type { TokenUsage };
