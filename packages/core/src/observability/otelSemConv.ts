import type { TraceEvent } from '../runtime/types';
import {
  COMMANDER_TYPE_TO_SPAN_KIND,
  SPAN_KIND_TO_OPERATION,
  type OtelGenAiOperation,
  type SpanKind,
} from './types';

export const SPAN_KIND_TO_OTEL_KIND: Record<SpanKind, number> = {
  AGENT: 1,
  TASK: 1,
  TOOL: 1,
  LLM: 3,
  RETRIEVER: 3,
  EMBEDDING: 3,
  EVALUATOR: 1,
  GUARDRAIL: 1,
  CHAIN: 1,
  DECISION: 1,
  ERROR: 1,
  STATE_CHANGE: 1,
};

export interface OtelGenAiAttrs {
  'gen_ai.operation.name': OtelGenAiOperation;
  'gen_ai.provider.name'?: string;
  'gen_ai.request.model'?: string;
  'gen_ai.response.model'?: string;
  'gen_ai.response.finish_reasons'?: string;
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.usage.total_tokens'?: number;
  'gen_ai.usage.cached_input_tokens'?: number;
  'gen_ai.usage.reasoning.output_tokens'?: number;
  'gen_ai.agent.id'?: string;
  'gen_ai.agent.name'?: string;
  'gen_ai.conversation.id'?: string;
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call.id'?: string;
  'gen_ai.tool.call.arguments'?: string;
  'error.type'?: string;
  'error.message'?: string;
}

export function eventToOtelAttrs(
  e: TraceEvent,
  ctx: { agentName?: string; conversationId?: string },
): OtelGenAiAttrs {
  const kind = (COMMANDER_TYPE_TO_SPAN_KIND[e.type] ?? 'CHAIN') as SpanKind;
  const operation = SPAN_KIND_TO_OPERATION[kind];
  const attrs: OtelGenAiAttrs = {
    'gen_ai.operation.name': operation,
  };
  if (e.data.modelInfo) {
    attrs['gen_ai.provider.name'] = e.data.modelInfo.provider;
    attrs['gen_ai.request.model'] = e.data.modelInfo.model;
  }
  if (e.data.tokenUsage) {
    attrs['gen_ai.usage.input_tokens'] = e.data.tokenUsage.promptTokens ?? 0;
    attrs['gen_ai.usage.output_tokens'] = e.data.tokenUsage.completionTokens ?? 0;
    attrs['gen_ai.usage.total_tokens'] = e.data.tokenUsage.totalTokens ?? 0;
  }
  if (e.agentId) attrs['gen_ai.agent.id'] = e.agentId;
  if (ctx.agentName) attrs['gen_ai.agent.name'] = ctx.agentName;
  if (ctx.conversationId) attrs['gen_ai.conversation.id'] = ctx.conversationId;
  if (e.type === 'tool_execution') {
    attrs['gen_ai.tool.name'] = String(e.data.input ?? 'unknown');
    if (e.data.input) attrs['gen_ai.tool.call.arguments'] = previewJson(e.data.input);
  }
  if (e.data.error) {
    attrs['error.type'] = e.type;
    attrs['error.message'] = String(e.data.error);
  }
  return attrs;
}

export function spanNameForEvent(e: TraceEvent): string {
  const kind = (COMMANDER_TYPE_TO_SPAN_KIND[e.type] ?? 'CHAIN') as SpanKind;
  const op = SPAN_KIND_TO_OPERATION[kind];
  if (op === 'chat') return `chat ${e.data.modelInfo?.model ?? 'llm'}`;
  if (op === 'execute_tool') return `execute_tool ${String(e.data.input ?? 'unknown')}`;
  if (op === 'invoke_agent') return `invoke_agent ${e.agentId}`;
  return `${op} ${e.type}`;
}

function previewJson(v: unknown, n = 500): string {
  try {
    const s = JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + '…' : s;
  } catch {
    return String(v).slice(0, n);
  }
}
