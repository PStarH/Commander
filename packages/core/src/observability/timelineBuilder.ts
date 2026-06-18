import type { TraceEvent, ExecutionTrace } from '../runtime/types';
import {
  COMMANDER_TYPE_TO_SPAN_KIND,
  SPAN_KIND_TO_OPERATION,
  type CostBreakdown,
  type OtelGenAiOperation,
  type SpanKind,
  type SpanTreeNode,
  type SpanTreeView,
  type TimelineNode,
  type TimelineView,
  type TokenBreakdown,
} from './types';
import { getCostModel } from './costModel';

const PREVIEW_CHARS = 200;

function truncate(s: string, n: number = PREVIEW_CHARS): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function tokensFromEvent(e: TraceEvent): TokenBreakdown {
  const u = e.data.tokenUsage;
  if (!u) return { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
  const input = u.promptTokens ?? 0;
  const output = u.completionTokens ?? 0;
  const total = u.totalTokens ?? input + output;
  return { input, output, cached: 0, reasoning: 0, total };
}

function nodeFromEvent(e: TraceEvent, childSpanIds: Set<string>): TimelineNode {
  const kind = (COMMANDER_TYPE_TO_SPAN_KIND[e.type] ?? 'CHAIN') as SpanKind;
  const operation: OtelGenAiOperation = SPAN_KIND_TO_OPERATION[kind];
  const tokens = e.data.tokenUsage ? tokensFromEvent(e) : undefined;
  const cost =
    e.data.modelInfo && tokens
      ? getCostModel().calculate(e.data.modelInfo.provider, e.data.modelInfo.model, tokens)
      : undefined;
  const endedAt = new Date(new Date(e.timestamp).getTime() + e.durationMs).toISOString();

  let promptContent: string | undefined;
  let completionContent: string | undefined;
  if (e.type === 'llm_call') {
    if (e.data.input && typeof e.data.input === 'object') {
      const req = e.data.input as Record<string, unknown>;
      if (typeof req['messages'] === 'string') promptContent = req['messages'];
      else if (Array.isArray(req['messages'])) promptContent = JSON.stringify(req['messages']);
    }
    if (typeof e.data.output === 'string') completionContent = e.data.output;
    else if (e.data.output && typeof e.data.output === 'object') {
      const out = e.data.output as Record<string, unknown>;
      if (typeof out['content'] === 'string') completionContent = out['content'];
      else completionContent = JSON.stringify(e.data.output);
    }
  }

  return {
    spanId: e.spanId,
    parentSpanId: e.parentSpanId,
    traceId: e.traceId,
    type: kind,
    operation,
    name:
      e.type === 'llm_call'
        ? `chat ${e.data.modelInfo?.model ?? 'llm'}`
        : e.type === 'tool_execution'
          ? `execute_tool ${String(e.data.input ?? 'unknown')}`
          : e.type,
    startedAt: e.timestamp,
    endedAt,
    durationMs: e.durationMs,
    status: e.type === 'error' ? 'error' : 'ok',
    errorMessage: e.data.error,
    agentId: e.agentId,
    model: e.data.modelInfo?.model,
    provider: e.data.modelInfo?.provider,
    tier: e.data.tier ?? e.data.modelInfo?.tier,
    taskCategory: e.data.taskCategory,
    tokens,
    cost,
    reasoning: e.type === 'llm_call' ? preview(e.data.output) : undefined,
    promptContent,
    completionContent,
    toolInputPreview: e.type === 'tool_execution' ? preview(e.data.input) : undefined,
    toolOutputPreview: e.type === 'tool_execution' ? preview(e.data.output) : undefined,
    decision:
      e.type === 'decision'
        ? typeof e.data.output === 'string'
          ? e.data.output
          : preview(e.data.output)
        : undefined,
    stateTransition: e.data.stateTransition,
    evaluationScore: e.data.evaluationScore,
    evaluationPassed: e.data.evaluationPassed,
    hasChildren: childSpanIds.has(e.spanId),
  };
}

export function buildTimeline(trace: ExecutionTrace): TimelineView {
  const events = trace.events;
  const childSpanIds = new Set<string>();
  for (const e of events) {
    if (e.parentSpanId) childSpanIds.add(e.parentSpanId);
  }

  const nodes: TimelineNode[] = events.map((e) => nodeFromEvent(e, childSpanIds));

  const costModel = getCostModel();
  const emptyTokens: TokenBreakdown = costModel.emptyTokens();
  const emptyCost: CostBreakdown = costModel.emptyCost();
  let totalTokens = emptyTokens;
  let totalCost = emptyCost;
  let llmCalls = 0;
  let toolCalls = 0;
  let agentInvocations = 0;
  let errors = 0;
  const modelAgg = new Map<
    string,
    { model: string; provider: string; calls: number; tokens: TokenBreakdown; costUsd: number }
  >();

  for (const n of nodes) {
    if (n.tokens) totalTokens = costModel.addTokens(totalTokens, n.tokens);
    if (n.cost) totalCost = costModel.addCost(totalCost, n.cost);
    if (n.type === 'LLM') llmCalls++;
    if (n.type === 'TOOL') toolCalls++;
    if (n.type === 'AGENT' || n.type === 'TASK') agentInvocations++;
    if (n.status === 'error') errors++;
    if (n.model && n.provider && n.cost && n.tokens) {
      const key = `${n.provider}:${n.model}`;
      const cur = modelAgg.get(key);
      if (cur) {
        cur.calls++;
        cur.tokens = costModel.addTokens(cur.tokens, n.tokens);
        cur.costUsd += n.cost.totalCostUsd;
      } else {
        modelAgg.set(key, {
          model: n.model,
          provider: n.provider,
          calls: 1,
          tokens: n.tokens,
          costUsd: n.cost.totalCostUsd,
        });
      }
    }
  }

  const modelsUsed = Array.from(modelAgg.values()).map((m) => ({
    model: m.model,
    provider: m.provider,
    calls: m.calls,
    tokens: m.tokens.total,
    costUsd: m.costUsd,
  }));

  return {
    runId: trace.runId,
    traceId: trace.traceId,
    agentId: trace.agentId,
    tenantId: trace.tenantId,
    startedAt: trace.startedAt,
    endedAt: trace.completedAt,
    totalDurationMs: trace.completedAt
      ? new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime()
      : trace.summary.totalDurationMs,
    nodes,
    summary: {
      totalSpans: nodes.length,
      llmCalls,
      toolCalls,
      agentInvocations,
      errors,
      totalTokens,
      totalCost,
      modelsUsed,
    },
  };
}

export function buildSpanTree(trace: ExecutionTrace): SpanTreeView {
  const events = trace.events;
  const childSpanIds = new Set<string>();
  for (const e of events) if (e.parentSpanId) childSpanIds.add(e.parentSpanId);

  const nodeMap = new Map<string, SpanTreeNode>();
  for (const e of events) {
    const span = nodeFromEvent(e, childSpanIds);
    nodeMap.set(e.spanId, { span, children: [], depth: 0 });
  }

  let root: SpanTreeNode | null = null;
  const orphans: SpanTreeNode[] = [];

  for (const e of events) {
    const node = nodeMap.get(e.spanId);
    if (!node) continue;
    if (!e.parentSpanId) {
      if (!root) {
        root = node;
        node.depth = 0;
      } else {
        orphans.push(node);
      }
    } else {
      const parent = nodeMap.get(e.parentSpanId);
      if (parent) {
        parent.children.push(node);
        node.depth = parent.depth + 1;
      } else {
        orphans.push(node);
      }
    }
  }

  return {
    runId: trace.runId,
    traceId: trace.traceId,
    root: root ?? {
      span: nodeFromEvent(events[0] as TraceEvent, childSpanIds),
      children: [],
      depth: 0,
    },
    orphans,
  };
}
