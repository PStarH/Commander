/**
 * OpenTelemetry Trace Exporter (OTLP HTTP JSON)
 *
 * Exports execution traces to any OpenTelemetry-compatible backend
 * (Jaeger, Grafana Tempo, SigNoz, etc.) via OTLP HTTP JSON protocol.
 *
 * No external dependencies — uses built-in http/https and crypto.
 * Falls back to file-based queue if endpoint is unreachable.
 *
 * Usage:
 *   const exporter = new OpenTelemetryExporter({
 *     endpoint: 'http://localhost:4318/v1/traces',
 *     serviceName: 'commander',
 *   });
 *   await exporter.start();
 *   exporter.exportSpan(executionSpan);
 *   await exporter.stop();
 */
import { reportSilentFailure } from '../silentFailureReporter';
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { eventToOtelAttrs, spanNameForEvent } from '../observability/otelSemConv';

// ── Types ──────────────────────────────────────────────────────────

export interface OTelExporterConfig {
  /** OTLP HTTP endpoint (default: http://localhost:4318/v1/traces) */
  endpoint?: string;
  /** Service name for identifying traces (default: commander) */
  serviceName?: string;
  /** Additional HTTP headers (e.g. for auth) */
  headers?: Record<string, string>;
  /** Max spans per batch (default: 64) */
  batchSize?: number;
  /** Batch send interval in ms (default: 5000) */
  batchIntervalMs?: number;
  /** File fallback directory when endpoint unreachable (default: .commander/otel_queue/) */
  fallbackDir?: string;
  /** PII redaction: drop raw prompt input from spans. Default true. */
  redactInput?: boolean;
  /** PII redaction: drop raw completion output from spans. Default true. */
  redactOutput?: boolean;
  /** PII redaction: drop tool call arguments from spans. Default true. */
  redactToolArgs?: boolean;
  /** Head-based sampling rate (0–1). Spans are deterministically sampled
   *  per traceId so all spans in a trace share the same fate. Error spans
   *  (status code 2) always bypass sampling. Default 1.0 (no sampling).
   *  Set via OTEL_TRACES_SAMPLER_ARG env var for production. */
  samplingRate?: number;
  /** Max in-memory queue size before spans are dropped (oldest first).
   *  Default 10000. Overflow count is tracked in getStats(). */
  maxBufferSize?: number;
}

export interface OTelSpan {
  /** The execution span to export */
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // 0=INTERNAL, 1=SERVER, 2=CLIENT, 3=PRODUCER, 4=CONSUMER
  startTime: string; // ISO 8601
  endTime: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string }; // 0=UNSET, 1=OK, 2=ERROR
  resource?: Record<string, string>;
}

// ── OTLP Protocol Helpers ──────────────────────────────────────────

function isoToNanos(iso: string): string {
  const d = new Date(iso);
  return String(d.getTime() * 1_000_000);
}

function toOtlpSpan(span: OTelSpan): Record<string, unknown> {
  const attrs: Array<{
    key: string;
    value: { stringValue?: string; intValue?: string; boolValue?: boolean };
  }> = [];
  for (const [key, value] of Object.entries(span.attributes || {})) {
    const attr: {
      key: string;
      value: { stringValue?: string; intValue?: string; boolValue?: boolean };
    } = { key, value: {} };
    if (typeof value === 'string') attr.value = { stringValue: value };
    else if (typeof value === 'boolean') attr.value = { boolValue: value };
    else attr.value = { intValue: String(value) };
    attrs.push(attr);
  }
  // Add resource attributes if present
  if (span.resource) {
    for (const [key, value] of Object.entries(span.resource)) {
      attrs.push({ key: `resource.${key}`, value: { stringValue: String(value) } });
    }
  }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? undefined,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: isoToNanos(span.startTime),
    endTimeUnixNano: isoToNanos(span.endTime),
    attributes: attrs,
    status: span.status ?? { code: 0 },
  };
}

function toOtlpTraceRequest(spans: OTelSpan[], serviceName: string): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'commander' } },
            { key: 'telemetry.sdk.language', value: { stringValue: 'typescript' } },
            { key: 'telemetry.sdk.version', value: { stringValue: '0.2.0' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'commander.execution' },
            spans: spans.map((s) => toOtlpSpan(s)),
          },
        ],
      },
    ],
  };
}

// ── Exporter ───────────────────────────────────────────────────────

export class OpenTelemetryExporter {
  private config: Required<OTelExporterConfig>;
  private queue: OTelSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private totalExported = 0;
  private totalFailed = 0;
  private bufferOverflowCount = 0;
  private spansSampledOut = 0;

  constructor(config: OTelExporterConfig = {}) {
    // Resolve sampling rate: explicit config > OTEL_TRACES_SAMPLER_ARG env > 1.0 (no sampling)
    const envSamplingRate =
      typeof process !== 'undefined' ? process.env?.OTEL_TRACES_SAMPLER_ARG : undefined;
    const resolvedSamplingRate =
      config.samplingRate ?? (envSamplingRate ? parseFloat(envSamplingRate) : 1.0);
    this.config = {
      endpoint: config.endpoint || 'http://localhost:4318/v1/traces',
      serviceName: config.serviceName || 'commander',
      headers: config.headers || {},
      batchSize: config.batchSize || 64,
      batchIntervalMs: config.batchIntervalMs || 5000,
      fallbackDir: config.fallbackDir || path.join(process.cwd(), '.commander', 'otel_queue'),
      // PII redaction defaults to "strip everything" so a misconfigured
      // Collector URL can't exfiltrate user prompts/completions.
      redactInput: config.redactInput ?? true,
      redactOutput: config.redactOutput ?? true,
      redactToolArgs: config.redactToolArgs ?? true,
      samplingRate: isNaN(resolvedSamplingRate)
        ? 1.0
        : Math.max(0, Math.min(1, resolvedSamplingRate)),
      maxBufferSize: config.maxBufferSize ?? 10000,
    };
    // Try env var override
    const envEndpoint =
      typeof process !== 'undefined' ? process.env?.OTEL_EXPORTER_OTLP_ENDPOINT : undefined;
    if (envEndpoint) {
      this.config.endpoint = envEndpoint;
    }
  }

  /**
   * Deterministic head-sampling: hashes the traceId to a 0–1 value and
   * keeps the span if the hash falls below the sampling rate. All spans
   * in the same trace share the same traceId so they share the same fate.
   * Error spans (status code 2) always bypass sampling.
   */
  private shouldSample(span: OTelSpan): boolean {
    if (this.config.samplingRate >= 1.0) return true;
    // Always keep error spans — they are high-signal and low-volume
    if (span.status?.code === 2) return true;
    // djb2 hash → [0, 1)
    let hash = 5381;
    for (let i = 0; i < span.traceId.length; i++) {
      hash = ((hash << 5) + hash + span.traceId.charCodeAt(i)) | 0;
    }
    const normalized = (hash >>> 0) / 0x100000000;
    return normalized < this.config.samplingRate;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // Recover queued spans from filesystem
    await this.recoverFromDisk();
    // Start batch flush timer
    this.flushTimer = setInterval(() => this.flush(), this.config.batchIntervalMs);
    this.flushTimer.unref();
    getGlobalLogger().info('OTelExporter', 'Started', {
      endpoint: this.config.endpoint,
      batchSize: this.config.batchSize,
      batchIntervalMs: this.config.batchIntervalMs,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush
    await this.flush();
    getGlobalLogger().info('OTelExporter', 'Stopped', {
      totalExported: this.totalExported,
      totalFailed: this.totalFailed,
    });
  }

  async forceFlush(): Promise<void> {
    await this.flush();
  }

  // ── Export ───────────────────────────────────────────────────────

  /**
   * Queue a span for export. Non-blocking — spans are batched and sent periodically.
   * PII redaction is applied before queuing when redactInput/redactOutput/redactToolArgs
   * are enabled (default: all true).
   */
  exportSpan(span: OTelSpan): void {
    // Head-based sampling: drop low-signal spans deterministically per traceId.
    // Error spans always bypass sampling (see shouldSample).
    if (!this.shouldSample(span)) {
      this.spansSampledOut++;
      return;
    }
    if (!this.running) {
      getGlobalLogger().warn('OTelExporter', 'Exporter not started — queuing span');
    }
    // P0: Apply PII redaction before the span enters the queue so no
    // raw prompt/completion/tool-args ever touch the network or disk.
    const redactedSpan = this.redactSpan(span);
    if (this.queue.length >= this.config.maxBufferSize) {
      // Buffer overflow: drop oldest and track for observability
      this.queue.shift();
      this.bufferOverflowCount++;
    }
    this.queue.push(redactedSpan);
    if (this.queue.length >= this.config.batchSize) {
      this.flush().catch((err) => {
        getGlobalLogger().error('OTelExporter', 'Batch flush failed', err as Error);
      });
    }
  }

  /**
   * Strip PII-sensitive attributes from a span based on redaction config.
   * Removes gen_ai.prompt (input), gen_ai.completion (output), and
   * gen_ai.tool.call.arguments while preserving tool names and IDs.
   */
  private redactSpan(span: OTelSpan): OTelSpan {
    if (!this.config.redactInput && !this.config.redactOutput && !this.config.redactToolArgs) {
      return span;
    }

    const attrs = { ...span.attributes };
    let redacted = false;

    if (this.config.redactInput) {
      for (const key of ['gen_ai.prompt', 'data.input', 'input', 'gen_ai.input']) {
        if (key in attrs) {
          delete attrs[key];
          redacted = true;
        }
      }
    }

    if (this.config.redactOutput) {
      for (const key of ['gen_ai.completion', 'data.output', 'output', 'gen_ai.output']) {
        if (key in attrs) {
          delete attrs[key];
          redacted = true;
        }
      }
    }

    if (this.config.redactToolArgs) {
      for (const key of ['gen_ai.tool.call.arguments', 'tool.args', 'arguments']) {
        if (key in attrs) {
          delete attrs[key];
          redacted = true;
        }
      }
    }

    return redacted ? { ...span, attributes: attrs } : span;
  }

  getStats(): {
    queued: number;
    totalExported: number;
    totalFailed: number;
    bufferOverflowCount: number;
    spansSampledOut: number;
    samplingRate: number;
    maxBufferSize: number;
  } {
    return {
      queued: this.queue.length,
      totalExported: this.totalExported,
      totalFailed: this.totalFailed,
      bufferOverflowCount: this.bufferOverflowCount,
      spansSampledOut: this.spansSampledOut,
      samplingRate: this.config.samplingRate,
      maxBufferSize: this.config.maxBufferSize,
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.config.batchSize);
    try {
      await this.sendBatch(batch);
      this.totalExported += batch.length;
    } catch (err) {
      this.totalFailed += batch.length;
      getGlobalLogger().error('OTelExporter', 'Failed to send batch, saving to disk', err as Error);
      this.saveToDisk(batch);
    }
  }

  private sendBatch(spans: OTelSpan[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(toOtlpTraceRequest(spans, this.config.serviceName));
      const url = new URL(this.config.endpoint);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.config.headers,
      };

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: 10000,
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`OTLP endpoint returned ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('OTLP request timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  // ── Disk Fallback ────────────────────────────────────────────────

  private saveToDisk(spans: OTelSpan[]): void {
    try {
      const dir = this.config.fallbackDir;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filename = path.join(
        dir,
        `spans_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`,
      );
      fs.writeFileSync(filename, JSON.stringify(spans));
      getGlobalLogger().info('OTelExporter', 'Saved spans to disk', {
        filename,
        count: spans.length,
      });
    } catch (err) {
      getGlobalLogger().error('OTelExporter', 'Failed to save spans to disk', err as Error);
    }
  }

  private async recoverFromDisk(): Promise<void> {
    const dir = this.config.fallbackDir;
    try {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
          if (Array.isArray(data)) {
            for (const span of data) {
              if (this.queue.length < this.config.maxBufferSize) {
                this.queue.push(span);
              }
            }
          }
          fs.unlinkSync(path.join(dir, file));
        } catch (err) {
          reportSilentFailure(err, 'openTelemetryExporter:310');
          // Delete corrupted files to prevent retry loop on every restart
          try {
            fs.unlinkSync(path.join(dir, file));
          } catch (e) {
            getGlobalLogger().debug('OTelExporter', 'Failed to delete corrupted file', {
              error: (e as Error)?.message,
              file,
            });
          }
        }
      }
      if (files.length > 0) {
        getGlobalLogger().info('OTelExporter', 'Recovered spans from disk', {
          files: files.length,
          spans: this.queue.length,
        });
      }
    } catch (err) {
      reportSilentFailure(err, 'openTelemetryExporter:329');
      // Directory may not exist yet
    }
  }
}

// ── ExecutionTrace → OTelSpan Bridge ───────────────────────────────

/**
 * Convert an ExecutionTrace into an array of OTelSpan objects for export.
 * Each TraceEvent becomes one OTelSpan. OTel GenAI attributes are produced
 * via the shared `eventToOtelAttrs` mapping so HTTP and OTLP exports stay
 * in sync (P1: OTel GenAI 1.36+ compliance).
 */
export function executionTraceToOtlpSpans(trace: import('./types').ExecutionTrace): OTelSpan[] {
  const spans: OTelSpan[] = [];
  const baseAttrs: Record<string, string | number | boolean> = {
    'commander.run_id': trace.runId,
    'commander.agent_id': trace.agentId,
  };
  if (trace.missionId) baseAttrs['commander.mission_id'] = trace.missionId;

  for (const event of trace.events) {
    const otelAttrs = eventToOtelAttrs(event, {});
    const attrs: Record<string, string | number | boolean> = { ...baseAttrs };
    for (const [k, v] of Object.entries(otelAttrs)) {
      if (v === undefined) continue;
      attrs[k] = typeof v === 'boolean' ? v : (v as string | number);
    }
    if (event.data.stateTransition) {
      attrs['state.from'] = event.data.stateTransition.from;
      attrs['state.to'] = event.data.stateTransition.to;
    }

    const span: OTelSpan = {
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      name: spanNameForEvent(event),
      kind: 0,
      startTime: event.timestamp,
      endTime: new Date(new Date(event.timestamp).getTime() + event.durationMs).toISOString(),
      attributes: attrs,
      status:
        event.type === 'error' ? { code: 2, message: String(event.data.error ?? '') } : { code: 1 },
    };
    spans.push(span);
  }

  return spans;
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

let _otelConfig: OTelExporterConfig | undefined;

const otelExporterSingleton = createTenantAwareSingleton(
  () => new OpenTelemetryExporter(_otelConfig),
);

export function getOTelExporter(config?: OTelExporterConfig): OpenTelemetryExporter {
  if (config) _otelConfig = config;
  return otelExporterSingleton.get();
}

export function resetOTelExporter(): void {
  otelExporterSingleton.reset();
}
