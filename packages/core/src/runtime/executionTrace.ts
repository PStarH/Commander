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
  private maxTraces: number;
  private store: TraceStore | null;

  constructor(maxTraces = 500, store?: TraceStore) {
    this.maxTraces = maxTraces;
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
  ): void {
    const tid = traceId ?? generateTraceId();
    this.traces.set(runId, {
      runId,
      traceId: tid,
      agentId,
      missionId,
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

    if (this.traces.size > this.maxTraces) {
      const oldest = Array.from(this.traces.keys()).sort(
        (a, b) => new Date(this.traces.get(a)!.startedAt).getTime() - new Date(this.traces.get(b)!.startedAt).getTime(),
      )[0];
      this.traces.delete(oldest);
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
        id: '', spanId: '', traceId: tid, runId, agentId: 'unknown',
        timestamp: new Date().toISOString(), durationMs: 0,
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
      const oldest = Array.from(this.traces.keys()).sort(
        (a, b) => new Date(this.traces.get(a)!.startedAt).getTime() - new Date(this.traces.get(b)!.startedAt).getTime(),
      )[0];
      this.traces.delete(oldest);
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
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'llm_call',
      durationMs,
      data: {
        input,
        output,
        modelInfo: { model, provider, tier },
        tokenUsage,
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

  recordError(
    runId: string,
    error: string,
    durationMs: number,
    parentSpanId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'error',
      durationMs,
      data: { error },
      parentSpanId,
    });
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
      all = all.filter(t => t.agentId === agentId);
    }
    return all
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
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

  startSpan(
    runId: string,
    name: string,
    parentSpanId?: string,
  ): TraceSpan {
    const trace = this.traces.get(runId);
    const spanId = generateId();
    const traceId = trace?.traceId ?? generateTraceId();
    const agentId = trace?.agentId ?? 'unknown';
    const startTime = Date.now();

    if (!trace) {
      this.traces.set(runId, {
        runId, traceId, agentId, missionId: undefined,
        startedAt: new Date().toISOString(), events: [], summary: {
          totalEvents: 0, totalDurationMs: 0, totalTokens: 0,
          llmCalls: 0, toolExecutions: 0, errors: 0, modelUsed: '',
        },
      });
    }

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

let globalRecorder: ExecutionTraceRecorder | null = null;

export function getTraceRecorder(store?: TraceStore): ExecutionTraceRecorder {
  if (!globalRecorder) {
    globalRecorder = new ExecutionTraceRecorder(500, store);
  } else if (store && !globalRecorder.hasStore()) {
    globalRecorder.setStore(store);
  }
  return globalRecorder;
}

export function resetTraceRecorder(): void {
  globalRecorder = null;
}
