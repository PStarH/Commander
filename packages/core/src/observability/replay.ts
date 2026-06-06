import type { ExecutionTrace } from '../runtime/types';
import type { ReplayResult, ReplaySpec, TimelineView, TimelineNode } from './types';
import { buildTimeline } from './timelineBuilder';

function applySubstitution(node: TimelineNode, spec: ReplaySpec): TimelineNode {
  for (const sub of spec.substitutions) {
    if (sub.spanId !== node.spanId) continue;
    if (sub.target === 'tool_output' && node.type === 'TOOL') {
      return { ...node, toolOutputPreview: previewOf(sub.value) };
    }
    if (sub.target === 'tool_input' && node.type === 'TOOL') {
      return { ...node, toolInputPreview: previewOf(sub.value) };
    }
    if (sub.target === 'llm_response' && node.type === 'LLM') {
      return { ...node, reasoning: previewOf(sub.value) };
    }
  }
  return node;
}

function previewOf(v: unknown, n = 200): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.length > n ? v.slice(0, n) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return String(v).slice(0, n);
  }
}

export function dryReplay(trace: ExecutionTrace, spec: ReplaySpec): ReplayResult {
  const originalTimeline = buildTimeline(trace);
  const replayedNodes = originalTimeline.nodes.map((n) => applySubstitution(n, spec));
  const replaySummary = recomputeSummary(replayedNodes);

  const newSpans = replayedNodes.filter((n) => !originalTimeline.nodes.some((o) => o.spanId === n.spanId)).length;
  const changedSpans = replayedNodes.filter((n) => {
    const o = originalTimeline.nodes.find((x) => x.spanId === n.spanId);
    if (!o) return false;
    return (
      o.reasoning !== n.reasoning ||
      o.toolOutputPreview !== n.toolOutputPreview ||
      o.toolInputPreview !== n.toolInputPreview
    );
  }).length;
  const costDelta = replaySummary.totalCost.totalCostUsd - originalTimeline.summary.totalCost.totalCostUsd;
  const tokenDelta = replaySummary.totalTokens.total - originalTimeline.summary.totalTokens.total;

  return {
    runId: trace.runId,
    traceId: trace.traceId,
    originalSummary: originalTimeline.summary,
    replaySummary,
    diff: { newSpans, changedSpans, costDeltaUsd: costDelta, tokenDelta },
    replayedNodes,
  };
}

function recomputeSummary(nodes: TimelineNode[]): TimelineView['summary'] {
  const cost = { totalCostUsd: 0, inputCostUsd: 0, outputCostUsd: 0 };
  const tokens = { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 };
  let llmCalls = 0, toolCalls = 0, agentInvocations = 0, errors = 0;
  for (const n of nodes) {
    if (n.tokens) {
      tokens.input += n.tokens.input;
      tokens.output += n.tokens.output;
      tokens.cached += n.tokens.cached;
      tokens.reasoning += n.tokens.reasoning;
      tokens.total += n.tokens.total;
    }
    if (n.cost) {
      cost.totalCostUsd += n.cost.totalCostUsd;
      cost.inputCostUsd += n.cost.inputCostUsd;
      cost.outputCostUsd += n.cost.outputCostUsd;
    }
    if (n.type === 'LLM') llmCalls++;
    if (n.type === 'TOOL') toolCalls++;
    if (n.type === 'AGENT' || n.type === 'TASK') agentInvocations++;
    if (n.status === 'error') errors++;
  }
  return {
    totalSpans: nodes.length,
    llmCalls, toolCalls, agentInvocations, errors,
    totalTokens: tokens, totalCost: cost, modelsUsed: [],
  };
}
