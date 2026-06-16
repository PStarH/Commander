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
  'gen_ai.request.temperature'?: number;
  'gen_ai.request.top_p'?: number;
  'gen_ai.response.model'?: string;
  'gen_ai.response.id'?: string;
  'gen_ai.response.finish_reasons'?: string;
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.usage.total_tokens'?: number;
  'gen_ai.usage.cached_input_tokens'?: number;
  'gen_ai.usage.reasoning.output_tokens'?: number;
  'gen_ai.output.type'?: string;
  'gen_ai.agent.id'?: string;
  'gen_ai.agent.name'?: string;
  'gen_ai.conversation.id'?: string;
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call.id'?: string;
  'gen_ai.tool.call.arguments'?: string;
  'server.address'?: string;
  'error.type'?: string;
  'error.message'?: string;
  // Error classification fields (custom attributes, not standard OTel semconv)
  'error.class'?: string;
  'error.retryable'?: boolean;
  'error.retrying'?: boolean;
  'error.attempts'?: number;
  'http.response.status_code'?: number;
}

export function isGenAiSemConvOptIn(): boolean {
  const envVal = typeof process !== 'undefined' ? process.env?.OTEL_SEMCONV_STABILITY_OPT_IN : undefined;
  if (!envVal) return true;
  return envVal
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((v) => v === 'gen_ai' || v === 'all');
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
    if (e.data.responseId) attrs['gen_ai.response.id'] = e.data.responseId;
  }
  // Extract request parameters from LLM call input
  if (e.type === 'llm_call' && e.data.input && typeof e.data.input === 'object') {
    const req = e.data.input as Record<string, unknown>;
    if (typeof req['temperature'] === 'number') attrs['gen_ai.request.temperature'] = req['temperature'];
    if (typeof req['top_p'] === 'number') attrs['gen_ai.request.top_p'] = req['top_p'];
  }
  if (e.data.tokenUsage) {
    attrs['gen_ai.usage.input_tokens'] = e.data.tokenUsage.promptTokens ?? 0;
    attrs['gen_ai.usage.output_tokens'] = e.data.tokenUsage.completionTokens ?? 0;
    attrs['gen_ai.usage.total_tokens'] = e.data.tokenUsage.totalTokens ?? 0;
    if (typeof e.data.tokenUsage.cacheReadTokens === 'number' && e.data.tokenUsage.cacheReadTokens > 0) {
      attrs['gen_ai.usage.cached_input_tokens'] = e.data.tokenUsage.cacheReadTokens;
    }
  }
  if (typeof e.data.reasoningTokens === 'number' && e.data.reasoningTokens > 0) {
    attrs['gen_ai.usage.reasoning.output_tokens'] = e.data.reasoningTokens;
  }
  if (e.data.outputType) attrs['gen_ai.output.type'] = e.data.outputType;
  if (e.data.finishReason) attrs['gen_ai.response.finish_reasons'] = e.data.finishReason;
  if (e.data.serverAddress) attrs['server.address'] = e.data.serverAddress;
  if (e.agentId) attrs['gen_ai.agent.id'] = e.agentId;
  if (ctx.agentName) attrs['gen_ai.agent.name'] = ctx.agentName;
  if (ctx.conversationId) attrs['gen_ai.conversation.id'] = ctx.conversationId;
  if (e.type === 'tool_execution') {
    // The exporter stashes the original tool name in `data.toolName` before
    // redacting `data.input` to '[redacted]'. Check `toolName` first, then
    // fall back to `input` for backward compat.
    const toolName = String((e.data as Record<string, unknown>).toolName ?? e.data.input ?? 'unknown');
    attrs['gen_ai.tool.name'] = toolName;
    if (e.data.toolCallId) attrs['gen_ai.tool.call.id'] = e.data.toolCallId;
  }
  if (e.data.error) {
    attrs['error.type'] = e.type;
    attrs['error.message'] = String(e.data.error);
  }
  // Pass through classification fields for error events
  const dataEx = e.data as Record<string, unknown>;
  if (dataEx.errorClass !== undefined) {
    attrs['error.class'] = String(dataEx.errorClass);
  }
  if (dataEx.retryable !== undefined) {
    attrs['error.retryable'] = Boolean(dataEx.retryable);
  }
  if (dataEx.retrying !== undefined) {
    attrs['error.retrying'] = Boolean(dataEx.retrying);
  }
  if (dataEx.attempts !== undefined) {
    attrs['error.attempts'] = Number(dataEx.attempts);
  }
  if (dataEx.statusCode !== undefined) {
    attrs['http.response.status_code'] = Number(dataEx.statusCode);
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

