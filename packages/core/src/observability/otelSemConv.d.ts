import type { TraceEvent } from '../runtime/types';
import { type OtelGenAiOperation, type SpanKind } from './types';
export declare const SPAN_KIND_TO_OTEL_KIND: Record<SpanKind, number>;
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
    'error.class'?: string;
    'error.retryable'?: boolean;
    'error.retrying'?: boolean;
    'error.attempts'?: number;
    'http.response.status_code'?: number;
}
export declare function isGenAiSemConvOptIn(): boolean;
export declare function eventToOtelAttrs(e: TraceEvent, ctx: {
    agentName?: string;
    conversationId?: string;
}): OtelGenAiAttrs;
export declare function spanNameForEvent(e: TraceEvent): string;
//# sourceMappingURL=otelSemConv.d.ts.map