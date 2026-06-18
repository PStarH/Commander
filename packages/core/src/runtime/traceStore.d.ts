import type { TraceEvent } from './types';
export interface TraceStore {
    append(event: TraceEvent): void;
    flush(runId: string): void;
    appendCritical?(event: TraceEvent): void;
}
/**
 * Sanitize a runId for safe use as a file path component.
 * Strips path traversal sequences and limits length.
 */
export declare function sanitizeRunId(runId: string): string;
export declare class PersistentTraceStore implements TraceStore {
    private baseDir;
    private buffers;
    private bufferTimestamps;
    private static readonly BUFFER_TTL_MS;
    private tenantId?;
    private staleFlushTimer;
    constructor(baseDir?: string, tenantId?: string);
    append(event: TraceEvent): void;
    /**
     * Append a critical event with fsync — guarantees the bytes are on disk
     * before returning. Use sparingly: e.g. circuit-breaker transitions,
     * compensation exhaustion, intent-log writes. Higher latency than append().
     */
    appendCritical(event: TraceEvent): void;
    private flushStaleBuffers;
    flush(runId: string): void;
    flushAll(): void;
    shutdown(): void;
    readTrace(runId: string): TraceEvent[];
}
//# sourceMappingURL=traceStore.d.ts.map