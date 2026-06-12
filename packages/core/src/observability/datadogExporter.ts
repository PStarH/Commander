import type { ExecutionTrace, TraceEvent } from '../runtime/types';
import * as http from 'http';
import * as https from 'https';
import { getGlobalLogger } from '../logging';

interface DatadogSpan {
  trace_id: string;
  span_id: string;
  parent_id?: string;
  name: string;
  resource: string;
  service: string;
  type: string;
  start: number;
  duration: number;
  error?: number;
  meta: Record<string, string>;
  metrics: Record<string, number>;
}

interface DatadogExporterConfig {
  apiKey: string;
  site?: string;
  serviceName?: string;
  environment?: string;
}

function eventToDatadogSpan(event: TraceEvent, serviceName: string, environment: string): DatadogSpan {
  const startTime = new Date(event.timestamp).getTime() * 1_000_000;
  const duration = event.durationMs * 1_000_000;

  const meta: Record<string, string> = {
    'commander.run_id': event.runId,
    'commander.agent_id': event.agentId,
    'commander.event_type': event.type,
    'env': environment,
  };

  if (event.data.modelInfo) {
    meta['gen_ai.request.model'] = event.data.modelInfo.model;
    meta['gen_ai.request.provider'] = event.data.modelInfo.provider;
  }

  if (event.data.error) {
    meta['error.message'] = event.data.error;
  }

  const metrics: Record<string, number> = {};
  if (event.data.tokenUsage) {
    metrics['gen_ai.usage.prompt_tokens'] = event.data.tokenUsage.promptTokens ?? 0;
    metrics['gen_ai.usage.completion_tokens'] = event.data.tokenUsage.completionTokens ?? 0;
    metrics['gen_ai.usage.total_tokens'] = event.data.tokenUsage.totalTokens ?? 0;
  }

  let spanType = 'custom';
  if (event.type === 'llm_call') spanType = 'llm';
  else if (event.type === 'tool_execution') spanType = 'tool';

  return {
    trace_id: event.traceId.replace(/-/g, ''),
    span_id: event.spanId.replace(/-/g, ''),
    parent_id: event.parentSpanId?.replace(/-/g, ''),
    name: `${event.type}:${event.data.modelInfo?.model ?? event.data.input ?? 'unknown'}`,
    resource: `${event.type}.${event.data.modelInfo?.model ?? 'unknown'}`,
    service: serviceName,
    type: spanType,
    start: startTime,
    duration,
    error: event.data.error ? 1 : undefined,
    meta,
    metrics,
  };
}

export class DatadogExporter {
  private config: Required<DatadogExporterConfig>;
  private queue: DatadogSpan[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs = 5000;
  private readonly maxBatchSize = 100;

  constructor(config: DatadogExporterConfig) {
    this.config = {
      apiKey: config.apiKey,
      site: config.site ?? 'datadoghq.com',
      serviceName: config.serviceName ?? 'commander',
      environment: config.environment ?? 'production',
    };
  }

  start(): void {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    return this.flush();
  }

  exportTrace(trace: ExecutionTrace): void {
    for (const event of trace.events) {
      this.queue.push(eventToDatadogSpan(event, this.config.serviceName, this.config.environment));
    }
    if (this.queue.length >= this.maxBatchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.maxBatchSize);
    const payload = JSON.stringify({ spans: batch });

    const url = `https://http-intake.logs.${this.config.site}/api/v2/events`;
    const headers = {
      'Content-Type': 'application/json',
      'DD-API-KEY': this.config.apiKey,
      'DD-EVIL-AGENT': 'true',
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'POST', headers }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            getGlobalLogger().warn('DatadogExporter', `Failed to send spans: ${res.statusCode} ${data}`);
            this.queue.unshift(...batch);
            resolve();
          }
        });
      });
      req.on('error', (err) => {
        getGlobalLogger().warn('DatadogExporter', `HTTP error: ${err.message}`);
        this.queue.unshift(...batch);
        resolve();
      });
      req.write(payload);
      req.end();
    });
  }
}
