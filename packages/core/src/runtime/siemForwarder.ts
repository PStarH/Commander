/**
 * SIEM Log Forwarder — enterprise log forwarding for Commander.
 *
 * Forwards security audit events and execution traces to external SIEM systems:
 *   - Syslog (RFC 5424) over UDP or TCP → Splunk, ELK, rsyslog, syslog-ng
 *   - Splunk HTTP Event Collector (HEC) → Splunk Enterprise / Cloud
 *   - Datadog Logs HTTP API → Datadog
 *
 * Configuration via env vars:
 *   SIEM_TYPE=syslog|splunk-hec|datadog
 *   SIEM_ENDPOINT=host:port (for syslog) or full URL (for HEC/DataDog)
 *   SIEM_TOKEN=... (Splunk HEC token or Datadog API key)
 *   SIEM_SOURCE=commander (default source name)
 *
 * Wire-in: call siemForwarder.forward(event) wherever security events are logged.
 * The forwarder is non-blocking (fire-and-forget with internal queue + retry).
 */

import * as dgram from 'dgram';
import * as net from 'net';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export type SIEMType = 'syslog' | 'splunk-hec' | 'datadog';

export interface SIEMConfig {
  /** SIEM backend type */
  type: SIEMType;
  /** Hostname or IP for syslog; full URL for HEC/Datadog */
  endpoint: string;
  /** Port (syslog default 514) or authentication token */
  token?: string;
  /** Protocol for syslog: 'udp' (default) or 'tcp' */
  protocol?: 'udp' | 'tcp';
  /** Source name / app name in forwarded events (default: 'commander') */
  sourceName?: string;
  /** Maximum events in the internal queue before dropping (default: 1000) */
  maxQueueSize?: number;
  /** Retry interval in ms on failure (default: 5000) */
  retryIntervalMs?: number;
  /** Enable verbose logging of forwarded events (default: false) */
  verbose?: boolean;
}

export interface SIEMEvent {
  /** ISO timestamp */
  timestamp: string;
  /** Event type (matches SecurityEventType or custom) */
  type: string;
  /** Severity level */
  severity: string;
  /** Source component */
  source: string;
  /** Human-readable message */
  message: string;
  /** Structured data */
  details?: Record<string, unknown>;
  /** User/agent/run context */
  context?: {
    userId?: string;
    agentId?: string;
    runId?: string;
    tenantId?: string;
  };
  /** Event ID for deduplication */
  eventId: string;
}

// ============================================================================
// Default Config
// ============================================================================

const DEFAULT_CONFIG: Partial<SIEMConfig> = {
  protocol: 'udp',
  sourceName: 'commander',
  maxQueueSize: 1000,
  retryIntervalMs: 5000,
  verbose: false,
};

// ============================================================================
// SIEM Forwarder
// ============================================================================

export class SIEMForwarder {
  private config: SIEMConfig;
  private queue: SIEMEvent[] = [];
  private processing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private totalForwarded = 0;
  private totalFailed = 0;
  private totalDropped = 0;
  private hostname: string;

  constructor(config: SIEMConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as SIEMConfig;
    this.hostname = os.hostname();
  }

  /** Get forwarder stats */
  getStats(): { totalForwarded: number; totalFailed: number; totalDropped: number; queueSize: number } {
    return {
      totalForwarded: this.totalForwarded,
      totalFailed: this.totalFailed,
      totalDropped: this.totalDropped,
      queueSize: this.queue.length,
    };
  }

  /**
   * Forward a SIEM event. Non-blocking — events are queued and processed
   * in batches. Returns immediately.
   */
  forward(event: SIEMEvent): void {
    if (this.queue.length >= (this.config.maxQueueSize ?? 1000)) {
      this.queue.shift(); // Drop oldest
      this.totalDropped++;
    }
    this.queue.push(event);

    if (!this.processing) {
      this.processing = true;
      this.processQueue().catch(() => {
        this.processing = false;
      });
    }
  }

  /**
   * Forward multiple events at once. More efficient than calling forward() in a loop.
   */
  forwardBatch(events: SIEMEvent[]): void {
    for (const event of events) {
      this.forward(event);
    }
  }

  /**
   * Flush the queue immediately. Returns when the queue is empty.
   * Useful before shutdown.
   */
  async flush(timeoutMs: number = 5000): Promise<void> {
    const start = Date.now();
    while (this.queue.length > 0 && Date.now() - start < timeoutMs) {
      if (!this.processing) {
        this.processing = true;
        await this.processQueue();
        this.processing = false;
      } else {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, 10); // Process in batches of 10
      try {
        await this.sendBatch(batch);
        this.totalForwarded += batch.length;
        if (this.config.verbose) {
          getGlobalLogger().debug('SIEMForwarder', `Forwarded ${batch.length} events`, {
            type: this.config.type,
            totalForwarded: this.totalForwarded,
          });
        }
      } catch (err) {
        this.totalFailed += batch.length;
        // Re-queue failed events to the FRONT to preserve ordering.
        // Use splice to insert at position 0 without creating a new array.
        const reQueueCount = Math.min(batch.length, (this.config.maxQueueSize ?? 1000) - this.queue.length);
        if (reQueueCount > 0) {
          const toRequeue = batch.slice(0, reQueueCount);
          this.queue.splice(0, 0, ...toRequeue);
        }
        getGlobalLogger().warn('SIEMForwarder', 'Failed to forward events, will retry', {
          type: this.config.type,
          failed: batch.length,
          reQueued: reQueueCount,
          error: (err as Error)?.message,
        });

        // Schedule retry
        if (!this.retryTimer) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.queue.length > 0 && !this.processing) {
              this.processing = true;
              this.processQueue().catch(() => {
                this.processing = false;
              });
            }
          }, this.config.retryIntervalMs ?? 5000);
          if (typeof (this.retryTimer as unknown as { unref?: () => void }).unref === 'function') {
            (this.retryTimer as unknown as { unref: () => void }).unref();
          }
        }
        return; // Stop processing until retry
      }
    }
    this.processing = false;
  }

  private async sendBatch(events: SIEMEvent[]): Promise<void> {
    switch (this.config.type) {
      case 'syslog':
        await this.sendSyslog(events);
        break;
      case 'splunk-hec':
        await this.sendSplunkHEC(events);
        break;
      case 'datadog':
        await this.sendDatadog(events);
        break;
    }
  }

  // ── Syslog (RFC 5424) ─────────────────────────────────────────────

  /**
   * Format event as RFC 5424 syslog message and send via UDP or TCP.
   *
   * RFC 5424 format:
   *   <PRI>VERSION TIMESTAMP HOSTNAME APPNAME PROCID MSGID STRUCTURED-DATA MSG
   *
   * Facility: 1 (user-level). Severity maps to syslog severity (0-7).
   */
  private async sendSyslog(events: SIEMEvent[]): Promise<void> {
    const [host, portStr] = this.config.endpoint.split(':');
    const port = parseInt(portStr ?? '514', 10);
    const appName = this.config.sourceName ?? 'commander';
    const messages = events.map(event => this.formatSyslogMessage(event, appName, this.hostname));
    const payload = messages.join('\n');

    if (this.config.protocol === 'tcp') {
      await this.sendTCP(host, port, payload);
    } else {
      await this.sendUDP(host, port, payload);
    }
  }

  private formatSyslogMessage(event: SIEMEvent, appName: string, hostname: string): string {
    const pri = this.severityToSyslogPriority(event.severity);
    const timestamp = new Date(event.timestamp).toISOString();
    const msgId = event.type.replace(/[^a-zA-Z0-9_-]/g, '_');
    const structuredData = event.eventId
      ? `[eventId@commander id="${event.eventId}" severity="${event.severity}"]`
      : '-';
    const msg = event.message.replace(/[\n\r]/g, ' ').slice(0, 1000);

    // RFC 5424: <PRI>1 TIMESTAMP HOSTNAME APPNAME PROCID MSGID STRUCTURED-DATA MSG
    return `<${pri}>1 ${timestamp} ${hostname} ${appName} - ${msgId} ${structuredData} ${msg}`;
  }

  private severityToSyslogPriority(severity: string): number {
    const facility = 1; // user-level
    const sev = (sev: string): number => {
      switch (sev) {
        case 'critical': return 2; // Critical
        case 'high': return 3; // Error
        case 'medium': return 4; // Warning
        case 'low': return 6; // Informational
        default: return 6;
      }
    };
    return facility * 8 + sev(severity);
  }

  private sendUDP(host: string, port: number, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket('udp4');
      const buffer = Buffer.from(payload, 'utf-8');
      client.send(buffer, 0, buffer.length, port, host, (err) => {
        client.close();
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private sendTCP(host: string, port: number, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      client.connect(port, host, () => {
        client.write(payload, 'utf-8', (err) => {
          client.destroy();
          if (err) reject(err);
          else resolve();
        });
      });
      client.on('error', (err) => {
        client.destroy();
        reject(err);
      });
      client.setTimeout(10000, () => {
        client.destroy();
        reject(new Error('TCP connection timeout'));
      });
    });
  }

  // ── Splunk HEC ────────────────────────────────────────────────────

  /**
   * Send events to Splunk HTTP Event Collector.
   * Endpoint format: https://your-instance.splunkcloud.com:8088
   * Token: Splunk HEC token (configured in Splunk)
   */
  private async sendSplunkHEC(events: SIEMEvent[]): Promise<void> {
    const url = new URL(this.config.endpoint);
    const token = this.config.token ?? '';
    const source = this.config.sourceName ?? 'commander';

    const payload = events.map(event => ({
      time: new Date(event.timestamp).getTime() / 1000,
      host: this.hostname,
      source,
      sourcetype: 'commander:event',
      event: {
        type: event.type,
        severity: event.severity,
        source: event.source,
        message: event.message,
        ...(event.details ? { details: event.details } : {}),
        ...(event.context ? { context: event.context } : {}),
        event_id: event.eventId,
      },
    }));

    await this.httpPost(url, payload, {
      Authorization: `Splunk ${token}`,
      'Content-Type': 'application/json',
    });
  }

  // ── Datadog ───────────────────────────────────────────────────────

  /**
   * Send events to Datadog Logs HTTP API.
   * Endpoint: https://http-intake.logs.datadoghq.com/api/v2/logs
   * Token: Datadog API key
   */
  private async sendDatadog(events: SIEMEvent[]): Promise<void> {
    const url = new URL(this.config.endpoint);
    const apiKey = this.config.token ?? '';

    const payload = events.map(event => ({
      ddsource: this.config.sourceName ?? 'commander',
      ddtags: `severity:${event.severity},type:${event.type}`,
      hostname: this.hostname,
      service: 'commander',
      message: JSON.stringify({
        type: event.type,
        severity: event.severity,
        source: event.source,
        message: event.message,
        details: event.details,
        context: event.context,
        event_id: event.eventId,
      }),
      date: new Date(event.timestamp).getTime(),
    }));

    await this.httpPost(url, payload, {
      'DD-API-KEY': apiKey,
      'Content-Type': 'application/json',
    });
  }

  // ── HTTP helper ───────────────────────────────────────────────────

  private httpPost(url: URL, body: unknown, headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
        timeout: 10000,
      };

      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk: string) => { responseBody += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timeout')); });
      req.write(data);
      req.end();
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a SIEMForwarder from environment variables.
 * Returns null if SIEM_TYPE is not set or unsupported.
 *
 * Expected env vars:
 *   SIEM_TYPE=syslog|splunk-hec|datadog
 *   SIEM_ENDPOINT=host:port (syslog) or https://... (HEC/Datadog)
 *   SIEM_TOKEN=... (HEC token or Datadog API key)
 *   SIEM_PROTOCOL=udp|tcp (syslog, default: udp)
 *   SIEM_SOURCE=commander (default source name)
 *   SIEM_VERBOSE=true (enable verbose logging)
 */
export function createSIEMForwarderFromEnv(): SIEMForwarder | null {
  const type = process.env.SIEM_TYPE as SIEMType | undefined;
  if (!type) return null;

  const endpoint = process.env.SIEM_ENDPOINT;
  if (!endpoint) {
    getGlobalLogger().warn('SIEMForwarder', 'SIEM_TYPE set but SIEM_ENDPOINT missing');
    return null;
  }

  if (!['syslog', 'splunk-hec', 'datadog'].includes(type)) {
    getGlobalLogger().warn('SIEMForwarder', `Unsupported SIEM_TYPE: ${type}. Use syslog, splunk-hec, or datadog.`);
    return null;
  }

  return new SIEMForwarder({
    type: type as SIEMType,
    endpoint,
    token: process.env.SIEM_TOKEN,
    protocol: (process.env.SIEM_PROTOCOL as 'udp' | 'tcp') ?? 'udp',
    sourceName: process.env.SIEM_SOURCE ?? 'commander',
    verbose: process.env.SIEM_VERBOSE === 'true',
  });
}
