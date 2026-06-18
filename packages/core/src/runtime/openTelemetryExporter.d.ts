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
}
export interface OTelSpan {
    /** The execution span to export */
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: number;
    startTime: string;
    endTime: string;
    attributes: Record<string, string | number | boolean>;
    status?: {
        code: number;
        message?: string;
    };
    resource?: Record<string, string>;
}
export declare class OpenTelemetryExporter {
    private config;
    private queue;
    private static readonly MAX_QUEUE_SIZE;
    private flushTimer;
    private running;
    private totalExported;
    private totalFailed;
    constructor(config?: OTelExporterConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    forceFlush(): Promise<void>;
    /**
     * Queue a span for export. Non-blocking — spans are batched and sent periodically.
     */
    exportSpan(span: OTelSpan): void;
    getStats(): {
        queued: number;
        totalExported: number;
        totalFailed: number;
    };
    private flush;
    private sendBatch;
    private saveToDisk;
    private recoverFromDisk;
}
/**
 * Convert an ExecutionTrace into an array of OTelSpan objects for export.
 * Each TraceEvent becomes one OTelSpan. OTel GenAI attributes are produced
 * via the shared `eventToOtelAttrs` mapping so HTTP and OTLP exports stay
 * in sync (P1: OTel GenAI 1.36+ compliance).
 */
export declare function executionTraceToOtlpSpans(trace: import('./types').ExecutionTrace): OTelSpan[];
export declare function getOTelExporter(config?: OTelExporterConfig): OpenTelemetryExporter;
export declare function resetOTelExporter(): void;
//# sourceMappingURL=openTelemetryExporter.d.ts.map