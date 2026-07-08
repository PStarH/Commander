import type { TraceEvent, ExecutionTrace, TokenUsage, ModelTier, TraceSpan } from './types';
import type { TraceStore } from './traceStore';

function generateId(): string {
  return `span_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function generateTraceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 15)}`;
}

export class ExecutionTraceRecorder {
  private traces: Map<string, ExecutionTrace> = new Map();
  private traceInsertOrder: string[] = [];
  private maxTraces: number;
  /** Maximum events per trace to prevent unbounded memory growth */
  private readonly maxEventsPerTrace: number;

  /** Evict the oldest completed trace to make room. Skips active traces. */
  private evictOldestCompleted(): void {
    // Use shift for O(1) on the common case (oldest is first inserted)
    while (this.traceInsertOrder.length > 0) {
      const key = this.traceInsertOrder[0];
      const trace = this.traces.get(key);
      if (trace?.completedAt) {
        this.traceInsertOrder.shift();
        this.traces.delete(key);
        return;
      }
      // Oldest is still active — try the next one
      break;
    }
  }
  private store: TraceStore | null;

  constructor(maxTraces = 500, store?: TraceStore, maxEventsPerTrace = 5000) {
    this.maxTraces = maxTraces;
    this.maxEventsPerTrace = maxEventsPerTrace;
    this.store = store ?? null;
  }

  setStore(store: TraceStore): void {
    this.store = store;
  }

  hasStore(): boolean {
    return this.store !== null;
  }

  startRun(
    runId: string,
    agentId: string,
    missionId?: string,
    traceId?: string,
    context?: {
      tenantId?: string;
      parentRunId?: string;
      subAgentDepth?: number;
      subAgentRole?: string;
    },
  ): void {
    const tid = traceId ?? generateTraceId();
    this.traces.set(runId, {
      runId,
      traceId: tid,
      agentId,
      missionId,
      tenantId: context?.tenantId,
      parentRunId: context?.parentRunId,
      subAgentDepth: context?.subAgentDepth,
      subAgentRole: context?.subAgentRole,
      startedAt: new Date().toISOString(),
      events: [],
      summary: {
        totalEvents: 0,
        totalDurationMs: 0,
        totalTokens: 0,
        llmCalls: 0,
        toolExecutions: 0,
        errors: 0,
        modelUsed: '',
      },
    });
    this.traceInsertOrder.push(runId);

    if (this.traces.size > this.maxTraces) {
      this.evictOldestCompleted();
    }
  }

  recordEvent(
    runId: string,
    event: Omit<TraceEvent, 'id' | 'spanId' | 'traceId' | 'runId' | 'timestamp' | 'agentId'>,
  ): TraceEvent {
    const trace = this.traces.get(runId);
    if (!trace) {
      const tid = generateTraceId();
      return {
        id: '',
        spanId: '',
        traceId: tid,
        runId,
        agentId: 'unknown',
        timestamp: new Date().toISOString(),
        durationMs: 0,
        type: event.type ?? 'decision',
        data: event.data ?? {},
        parentSpanId: event.parentSpanId,
      };
    }

    const fullEvent: TraceEvent = {
      ...event,
      id: generateId(),
      spanId: generateId(),
      traceId: trace.traceId,
      runId,
      agentId: trace.agentId,
      timestamp: new Date().toISOString(),
    };

    // Limit events per trace to prevent unbounded memory growth
    if (trace.events.length >= this.maxEventsPerTrace) {
      // Drop oldest events (keep most recent 80%)
      const keepCount = Math.floor(this.maxEventsPerTrace * 0.8);
      trace.events = trace.events.slice(-keepCount);
    }
    trace.events.push(fullEvent);

    trace.summary.totalEvents++;
    trace.summary.totalDurationMs += event.durationMs;
    if (event.type === 'llm_call') {
      trace.summary.llmCalls++;
      if (event.data.tokenUsage) {
        trace.summary.totalTokens += event.data.tokenUsage.totalTokens;
      }
      if (event.data.modelInfo) {
        trace.summary.modelUsed = event.data.modelInfo.model;
      }
    }
    if (event.type === 'tool_execution') trace.summary.toolExecutions++;
    if (event.type === 'error') trace.summary.errors++;

    this.store?.append(fullEvent);

    if (this.traces.size > this.maxTraces) {
      this.evictOldestCompleted();
    }

    return fullEvent;
  }

  recordLLMCall(
    runId: string,
    model: string,
    provider: string,
    tier: ModelTier,
    input: unknown,
    output: unknown,
    tokenUsage: TokenUsage,
    durationMs: number,
    parentSpanId?: string,
    metadata?: { taskCategory?: string },
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'llm_call',
      durationMs,
      data: {
        input,
        output,
        modelInfo: { model, provider, tier },
        tokenUsage,
        tier,
        taskCategory: metadata?.taskCategory,
      },
      parentSpanId,
    });
  }

  recordToolExecution(
    runId: string,
    toolName: string,
    input: unknown,
    output: unknown,
    durationMs: number,
    error?: string,
    parentSpanId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'tool_execution',
      durationMs,
      data: { input, output, error },
      parentSpanId,
    });
  }

  recordDecision(
    runId: string,
    decision: string,
    durationMs: number,
    parentSpanId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'decision',
      durationMs,
      data: { input: undefined, output: decision },
      parentSpanId,
    });
  }

  recordError(runId: string, error: string, durationMs: number, parentSpanId?: string): TraceEvent {
    return this.recordEvent(runId, {
      type: 'error',
      durationMs,
      data: { error },
      parentSpanId,
    });
  }

  recordVerification(
    runId: string,
    passed: boolean,
    confidence: number,
    signalCount: number,
    durationMs: number,
    parentSpanId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'verification',
      durationMs,
      data: {
        input: { passed, confidence, signalCount },
        output: { passed, confidence, signalCount },
        evaluationScore: confidence,
        evaluationPassed: passed,
      },
      parentSpanId,
    });
  }

  /**
   * Record a critical event with fsync durability. Use sparingly: circuit-breaker
   * transitions, compensation exhaustion, intent-log writes, run manifest commits.
   * Higher latency than recordEvent() because it fsyncs the file descriptor.
   */
  recordCriticalEvent(
    runId: string,
    event: Omit<TraceEvent, 'id' | 'spanId' | 'traceId' | 'runId' | 'timestamp' | 'agentId'>,
  ): TraceEvent | null {
    const trace = this.traces.get(runId);
    const fullEvent: TraceEvent = {
      ...event,
      id: generateId(),
      spanId: generateId(),
      traceId: trace?.traceId ?? generateTraceId(),
      runId,
      agentId: trace?.agentId ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
    if (trace) {
      trace.events.push(fullEvent);
    }
    if (
      this.store &&
      typeof (this.store as { appendCritical?: (e: TraceEvent) => void }).appendCritical ===
        'function'
    ) {
      (this.store as { appendCritical: (e: TraceEvent) => void }).appendCritical(fullEvent);
    } else {
      this.store?.append(fullEvent);
    }
    return fullEvent;
  }

  completeRun(runId: string): ExecutionTrace {
    const trace = this.traces.get(runId);
    if (!trace) {
      throw new Error(`No trace found for run: ${runId}`);
    }
    trace.completedAt = new Date().toISOString();
    this.store?.flush(runId);
    return trace;
  }

  getTrace(runId: string): ExecutionTrace | undefined {
    return this.traces.get(runId);
  }

  listTraces(agentId?: string, limit = 50): ExecutionTrace[] {
    let all = Array.from(this.traces.values());
    if (agentId) {
      all = all.filter((t) => t.agentId === agentId);
    }
    // ISO string comparison — no Date parsing needed
    return all
      .sort((a, b) => (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0))
      .slice(0, limit);
  }

  getSummary(): {
    totalTraces: number;
    totalLLMCalls: number;
    totalTokens: number;
    totalErrors: number;
  } {
    let totalLLMCalls = 0;
    let totalTokens = 0;
    let totalErrors = 0;

    for (const trace of this.traces.values()) {
      totalLLMCalls += trace.summary.llmCalls;
      totalTokens += trace.summary.totalTokens;
      totalErrors += trace.summary.errors;
    }

    return {
      totalTraces: this.traces.size,
      totalLLMCalls,
      totalTokens,
      totalErrors,
    };
  }

  startSpan(runId: string, name: string, parentSpanId?: string): TraceSpan {
    const trace = this.traces.get(runId);
    const spanId = generateId();
    const traceId = trace?.traceId ?? generateTraceId();
    const agentId = trace?.agentId ?? 'unknown';
    const startTime = Date.now();

    if (!trace) {
      this.traces.set(runId, {
        runId,
        traceId,
        agentId,
        missionId: undefined,
        startedAt: new Date().toISOString(),
        events: [],
        summary: {
          totalEvents: 0,
          totalDurationMs: 0,
          totalTokens: 0,
          llmCalls: 0,
          toolExecutions: 0,
          errors: 0,
          modelUsed: '',
        },
      });
      this.traceInsertOrder.push(runId);
    }

    // Re-fetch after potential fallback creation
    this.traces.get(runId)!;

    return {
      spanId,
      traceId,
      end: (attrs) => {
        const durationMs = Date.now() - startTime;
        const event = this.recordEvent(runId, {
          type: 'state_change',
          durationMs,
          data: {
            input: name,
            output: attrs?.output,
            error: attrs?.error,
          },
          parentSpanId,
        });
        return event;
      },
      recordChild: (type, attrs) => {
        const childDuration = attrs?.durationMs ?? 0;
        return this.recordEvent(runId, {
          type,
          durationMs: childDuration,
          data: {
            input: attrs?.input,
            output: attrs?.output,
            error: attrs?.error,
          },
          parentSpanId: spanId,
        });
      },
    };
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

let _traceStore: TraceStore | undefined;

const traceRecorderSingleton = createTenantAwareSingleton(
  () => new ExecutionTraceRecorder(500, _traceStore),
  {},
);

export function getTraceRecorder(store?: TraceStore): ExecutionTraceRecorder {
  if (store) _traceStore = store;
  const recorder = traceRecorderSingleton.get();
  if (store && !recorder.hasStore()) {
    recorder.setStore(store);
  }
  return recorder;
}

export function resetTraceRecorder(): void {
  traceRecorderSingleton.reset();
}
