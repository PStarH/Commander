import type { TraceEvent, ExecutionTrace, TokenUsage, ModelTier, TraceSpan } from './types';
import type { TraceStore } from './traceStore';
export declare class ExecutionTraceRecorder {
    private traces;
    private traceInsertOrder;
    private maxTraces;
    /** Maximum events per trace to prevent unbounded memory growth */
    private readonly maxEventsPerTrace;
    /** Evict the oldest completed trace to make room. Skips active traces. */
    private evictOldestCompleted;
    private store;
    constructor(maxTraces?: number, store?: TraceStore, maxEventsPerTrace?: number);
    setStore(store: TraceStore): void;
    hasStore(): boolean;
    startRun(runId: string, agentId: string, missionId?: string, traceId?: string, context?: {
        tenantId?: string;
        parentRunId?: string;
        subAgentDepth?: number;
        subAgentRole?: string;
    }): void;
    recordEvent(runId: string, event: Omit<TraceEvent, 'id' | 'spanId' | 'traceId' | 'runId' | 'timestamp' | 'agentId'>): TraceEvent;
    recordLLMCall(runId: string, model: string, provider: string, tier: ModelTier, input: unknown, output: unknown, tokenUsage: TokenUsage, durationMs: number, parentSpanId?: string, metadata?: {
        taskCategory?: string;
    }): TraceEvent;
    recordToolExecution(runId: string, toolName: string, input: unknown, output: unknown, durationMs: number, error?: string, parentSpanId?: string): TraceEvent;
    recordDecision(runId: string, decision: string, durationMs: number, parentSpanId?: string): TraceEvent;
    recordError(runId: string, error: string, durationMs: number, parentSpanId?: string): TraceEvent;
    recordVerification(runId: string, passed: boolean, confidence: number, signalCount: number, durationMs: number, parentSpanId?: string): TraceEvent;
    /**
     * Record a critical event with fsync durability. Use sparingly: circuit-breaker
     * transitions, compensation exhaustion, intent-log writes, run manifest commits.
     * Higher latency than recordEvent() because it fsyncs the file descriptor.
     */
    recordCriticalEvent(runId: string, event: Omit<TraceEvent, 'id' | 'spanId' | 'traceId' | 'runId' | 'timestamp' | 'agentId'>): TraceEvent | null;
    completeRun(runId: string): ExecutionTrace;
    getTrace(runId: string): ExecutionTrace | undefined;
    listTraces(agentId?: string, limit?: number): ExecutionTrace[];
    getSummary(): {
        totalTraces: number;
        totalLLMCalls: number;
        totalTokens: number;
        totalErrors: number;
    };
    startSpan(runId: string, name: string, parentSpanId?: string): TraceSpan;
}
export declare function getTraceRecorder(store?: TraceStore): ExecutionTraceRecorder;
export declare function resetTraceRecorder(): void;
//# sourceMappingURL=executionTrace.d.ts.map