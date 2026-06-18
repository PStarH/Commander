import type { TraceEvent, ExecutionTrace } from '@commander/core';
import type { DecisionNode } from './types';

export function buildDecisions(trace: ExecutionTrace): DecisionNode[] {
  const events = trace.events;
  const bySpan = new Map<string, TraceEvent>();
  for (const e of events) bySpan.set(e.spanId, e);

  const decisions: DecisionNode[] = [];
  for (const e of events) {
    if (e.type !== 'tool_execution') continue;
    const llmEvent = findPrecedingLlm(trace, e);
    const thinkDurationMs = llmEvent
      ? Math.max(0, new Date(e.timestamp).getTime() - new Date(llmEvent.timestamp).getTime())
      : 0;
    const args =
      typeof e.data.input === 'object' && e.data.input !== null
        ? (e.data.input as Record<string, unknown>)
        : {};
    decisions.push({
      spanId: e.spanId,
      parentSpanId: e.parentSpanId,
      timestamp: e.timestamp,
      toolName:
        typeof e.data.input === 'string'
          ? e.data.input
          : ((args['toolName'] as string) ?? String(e.data.input ?? 'unknown')),
      toolArgs: args,
      decisionReason: extractReason(llmEvent),
      llmSpanId: llmEvent?.spanId,
      llmReasoning: llmEvent ? preview(llmEvent.data.output) : undefined,
      llmModel: llmEvent?.data.modelInfo?.model,
      thinkDurationMs,
    });
  }
  return decisions;
}

function findPrecedingLlm(trace: ExecutionTrace, toolEvent: TraceEvent): TraceEvent | undefined {
  const toolStart = new Date(toolEvent.timestamp).getTime();
  const candidates = trace.events.filter(
    (e) => e.type === 'llm_call' && new Date(e.timestamp).getTime() <= toolStart,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((latest, e) =>
    new Date(e.timestamp).getTime() > new Date(latest.timestamp).getTime() ? e : latest,
  );
}

function extractReason(llm: TraceEvent | undefined): string {
  if (!llm) return 'no preceding LLM call captured';
  const out = llm.data.output;
  if (typeof out === 'string') return out.slice(0, 300);
  if (out && typeof out === 'object') {
    const o = out as Record<string, unknown>;
    if (typeof o['content'] === 'string') return (o['content'] as string).slice(0, 300);
    if (Array.isArray(o['tool_calls']) && o['tool_calls'].length > 0) {
      const tc = o['tool_calls'][0] as Record<string, unknown>;
      return `chose tool: ${String(tc['name'] ?? 'unknown')}`;
    }
  }
  return 'preceding LLM call did not produce a textual decision';
}

function preview(v: unknown, n = 300): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v.length > n ? v.slice(0, n) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return undefined;
  }
}

export function decisionsSummary(decisions: DecisionNode[]): {
  total: number;
  avgThinkMs: number;
  p95ThinkMs: number;
  byTool: Array<{ tool: string; count: number; avgThinkMs: number }>;
} {
  if (decisions.length === 0) {
    return { total: 0, avgThinkMs: 0, p95ThinkMs: 0, byTool: [] };
  }
  const sorted = [...decisions].map((d) => d.thinkDurationMs).sort((a, b) => a - b);
  const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const p95Idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
  const p95 = sorted[p95Idx] as number;
  const toolAgg = new Map<string, { count: number; total: number }>();
  for (const d of decisions) {
    const cur = toolAgg.get(d.toolName);
    if (cur) {
      cur.count++;
      cur.total += d.thinkDurationMs;
    } else {
      toolAgg.set(d.toolName, { count: 1, total: d.thinkDurationMs });
    }
  }
  return {
    total: decisions.length,
    avgThinkMs: Math.round(avg),
    p95ThinkMs: p95,
    byTool: Array.from(toolAgg.entries()).map(([tool, v]) => ({
      tool,
      count: v.count,
      avgThinkMs: Math.round(v.total / v.count),
    })),
  };
}
