import type { TraceEvent, ExecutionTrace, TokenUsage, ModelTier } from './types';

function generateId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export class ExecutionTraceRecorder {
  private traces: Map<string, ExecutionTrace> = new Map();
  private maxTraces: number;

  constructor(maxTraces = 500) {
    this.maxTraces = maxTraces;
  }

  startRun(
    runId: string,
    agentId: string,
    missionId?: string,
  ): void {
    this.traces.set(runId, {
      runId,
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
    event: Omit<TraceEvent, 'id' | 'runId' | 'timestamp' | 'agentId'>,
  ): TraceEvent {
    const trace = this.traces.get(runId);
    if (!trace) {
      throw new Error(`No trace found for run: ${runId}`);
    }

    const fullEvent: TraceEvent = {
      ...event,
      id: generateId(),
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
    parentId?: string,
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
      parentId,
    });
  }

  recordToolExecution(
    runId: string,
    toolName: string,
    input: unknown,
    output: unknown,
    durationMs: number,
    error?: string,
    parentId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'tool_execution',
      durationMs,
      data: { input, output, error },
      parentId,
    });
  }

  recordDecision(
    runId: string,
    decision: string,
    durationMs: number,
    parentId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'decision',
      durationMs,
      data: { input: undefined, output: decision },
      parentId,
    });
  }

  recordError(
    runId: string,
    error: string,
    durationMs: number,
    parentId?: string,
  ): TraceEvent {
    return this.recordEvent(runId, {
      type: 'error',
      durationMs,
      data: { error },
      parentId,
    });
  }

  completeRun(runId: string): ExecutionTrace {
    const trace = this.traces.get(runId);
    if (!trace) {
      throw new Error(`No trace found for run: ${runId}`);
    }
    trace.completedAt = new Date().toISOString();
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
}

let globalRecorder: ExecutionTraceRecorder | null = null;

export function getTraceRecorder(): ExecutionTraceRecorder {
  if (!globalRecorder) {
    globalRecorder = new ExecutionTraceRecorder();
  }
  return globalRecorder;
}

export function resetTraceRecorder(): void {
  globalRecorder = null;
}
