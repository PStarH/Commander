import type { ExecutionTrace, TraceEvent } from '@commander/core';
import type { ExecutiveSummary, TimelineNode } from './types';
import { buildTimeline } from './timelineBuilder';
import { getCostModel } from './costModel';

export function buildExecutiveSummary(trace: ExecutionTrace): ExecutiveSummary {
  const timeline = buildTimeline(trace);
  const costModel = getCostModel();

  const modelsUsed = new Set<string>();
  const toolsUsed = new Set<string>();
  let totalCostUsd = 0;
  let totalTokens = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let errors = 0;
  const highlights: string[] = [];

  for (const node of timeline.nodes) {
    if (node.model) modelsUsed.add(node.model);
    if (node.type === 'LLM') llmCalls++;
    if (node.type === 'TOOL') {
      toolCalls++;
      const toolName = node.name.replace('execute_tool ', '');
      toolsUsed.add(toolName);
    }
    if (node.status === 'error') errors++;
    if (node.cost) totalCostUsd += node.cost.totalCostUsd;
    if (node.tokens) totalTokens += node.tokens.total;
  }

  const durationMs = timeline.totalDurationMs;
  const status: ExecutiveSummary['status'] = errors > 0 ? 'error' : 'success';

  if (errors > 0) highlights.push(`${errors} error(s) detected`);
  if (toolCalls > 10) highlights.push(`High tool usage: ${toolCalls} calls`);
  if (totalCostUsd > 1.0) highlights.push(`High cost: $${totalCostUsd.toFixed(4)}`);
  if (durationMs > 60000) highlights.push(`Long execution: ${(durationMs / 1000).toFixed(1)}s`);

  const narrative = buildNarrative(trace, timeline, status, durationMs, totalCostUsd, totalTokens, llmCalls, toolCalls, errors, modelsUsed, toolsUsed);

  const timelineEvents = buildTimelineEvents(trace);

  return {
    runId: trace.runId,
    traceId: trace.traceId,
    status,
    durationMs,
    totalCostUsd,
    totalTokens,
    llmCalls,
    toolCalls,
    errors,
    modelsUsed: Array.from(modelsUsed),
    toolsUsed: Array.from(toolsUsed),
    topology: extractTopology(trace),
    taskCategory: extractTaskCategory(trace),
    narrative,
    highlights,
    timeline: timelineEvents,
  };
}

function buildNarrative(
  trace: ExecutionTrace,
  _timeline: ReturnType<typeof buildTimeline>,
  status: ExecutiveSummary['status'],
  durationMs: number,
  totalCostUsd: number,
  totalTokens: number,
  llmCalls: number,
  toolCalls: number,
  errors: number,
  modelsUsed: Set<string>,
  toolsUsed: Set<string>,
): string {
  const parts: string[] = [];

  parts.push(`Run ${trace.runId.slice(0, 12)} ${status === 'success' ? 'completed successfully' : 'had errors'}.`);

  const durationSec = (durationMs / 1000).toFixed(1);
  parts.push(`Duration: ${durationSec}s`);

  parts.push(`Cost: $${totalCostUsd.toFixed(4)} (${totalTokens} tokens)`);

  if (llmCalls > 0) {
    const models = Array.from(modelsUsed).join(', ');
    parts.push(`${llmCalls} LLM call(s) using ${models}`);
  }

  if (toolCalls > 0) {
    const tools = Array.from(toolsUsed).join(', ');
    parts.push(`${toolCalls} tool call(s): ${tools}`);
  }

  if (errors > 0) {
    parts.push(`${errors} error(s) occurred during execution`);
  }

  return parts.join('. ') + '.';
}

function buildTimelineEvents(trace: ExecutionTrace): ExecutiveSummary['timeline'] {
  const events: ExecutiveSummary['timeline'] = [];

  for (const e of trace.events) {
    let label: string;
    let detail: string;

    switch (e.type) {
      case 'llm_call': {
        const model = e.data.modelInfo?.model ?? 'unknown';
        const provider = e.data.modelInfo?.provider ?? 'unknown';
        label = `LLM Call (${provider}/${model})`;
        const tokens = e.data.tokenUsage?.totalTokens ?? 0;
        detail = `${tokens} tokens`;
        break;
      }
      case 'tool_execution': {
        const toolName = String(e.data.input ?? 'unknown');
        label = `Tool: ${toolName}`;
        detail = e.data.error ? `Error: ${e.data.error}` : 'Executed';
        break;
      }
      case 'decision':
        label = 'Decision';
        detail = typeof e.data.output === 'string' ? e.data.output : 'Made a decision';
        break;
      case 'error':
        label = 'Error';
        detail = String(e.data.error ?? 'Unknown error');
        break;
      case 'state_change':
        label = 'State Change';
        detail = e.data.stateTransition
          ? `${e.data.stateTransition.from} → ${e.data.stateTransition.to}`
          : 'State changed';
        break;
      default:
        label = e.type;
        detail = 'Event recorded';
    }

    events.push({
      timestamp: e.timestamp,
      label,
      detail,
      durationMs: e.durationMs,
      costUsd: e.data.modelInfo && e.data.tokenUsage
        ? getCostModel().calculate(
            e.data.modelInfo.provider,
            e.data.modelInfo.model,
            {
              input: e.data.tokenUsage.promptTokens ?? 0,
              output: e.data.tokenUsage.completionTokens ?? 0,
              cached: 0,
              reasoning: 0,
              total: e.data.tokenUsage.totalTokens ?? 0,
            },
          ).totalCostUsd
        : undefined,
    });
  }

  return events;
}

function extractTopology(trace: ExecutionTrace): string | undefined {
  for (const e of trace.events) {
    if (e.type === 'decision' && typeof e.data.output === 'string') {
      const output = e.data.output.toLowerCase();
      if (output.includes('topology') || output.includes('sequential') || output.includes('parallel')) {
        return e.data.output;
      }
    }
  }
  return undefined;
}

function extractTaskCategory(trace: ExecutionTrace): string | undefined {
  for (const e of trace.events) {
    if (e.type === 'decision' && typeof e.data.output === 'string') {
      const output = e.data.output.toLowerCase();
      if (output.includes('coding') || output.includes('research') || output.includes('analysis')) {
        return e.data.output;
      }
    }
  }
  return undefined;
}
