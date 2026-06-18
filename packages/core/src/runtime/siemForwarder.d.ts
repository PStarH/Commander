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
export declare class SIEMForwarder {
    private config;
    private queue;
    private processing;
    private retryTimer;
    private totalForwarded;
    private totalFailed;
    private totalDropped;
    private hostname;
    constructor(config: SIEMConfig);
    /** Get forwarder stats */
    getStats(): {
        totalForwarded: number;
        totalFailed: number;
        totalDropped: number;
        queueSize: number;
    };
    /**
     * Forward a SIEM event. Non-blocking — events are queued and processed
     * in batches. Returns immediately.
     */
    forward(event: SIEMEvent): void;
    /**
     * Forward multiple events at once. More efficient than calling forward() in a loop.
     */
    forwardBatch(events: SIEMEvent[]): void;
    /**
     * Flush the queue immediately. Returns when the queue is empty.
     * Useful before shutdown.
     */
    flush(timeoutMs?: number): Promise<void>;
    private processQueue;
    private sendBatch;
    /**
     * Format event as RFC 5424 syslog message and send via UDP or TCP.
     *
     * RFC 5424 format:
     *   <PRI>VERSION TIMESTAMP HOSTNAME APPNAME PROCID MSGID STRUCTURED-DATA MSG
     *
     * Facility: 1 (user-level). Severity maps to syslog severity (0-7).
     */
    private sendSyslog;
    private formatSyslogMessage;
    private severityToSyslogPriority;
    private sendUDP;
    private sendTCP;
    /**
     * Send events to Splunk HTTP Event Collector.
     * Endpoint format: https://your-instance.splunkcloud.com:8088
     * Token: Splunk HEC token (configured in Splunk)
     */
    private sendSplunkHEC;
    /**
     * Send events to Datadog Logs HTTP API.
     * Endpoint: https://http-intake.logs.datadoghq.com/api/v2/logs
     * Token: Datadog API key
     */
    private sendDatadog;
    private httpPost;
}
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
export declare function createSIEMForwarderFromEnv(): SIEMForwarder | null;
//# sourceMappingURL=siemForwarder.d.ts.map