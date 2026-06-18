"use strict";
// Span kinds follow OpenTelemetry GenAI semantic conventions (alpha).
// Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMANDER_TYPE_TO_SPAN_KIND = exports.SPAN_KIND_TO_OPERATION = void 0;
exports.SPAN_KIND_TO_OPERATION = {
    AGENT: 'invoke_agent',
    TASK: 'invoke_agent',
    TOOL: 'execute_tool',
    LLM: 'chat',
    RETRIEVER: 'retrieval',
    EMBEDDING: 'embeddings',
    EVALUATOR: 'chat',
    GUARDRAIL: 'chat',
    CHAIN: 'chat',
    DECISION: 'invoke_agent',
    ERROR: 'chat',
    STATE_CHANGE: 'invoke_agent',
};
exports.COMMANDER_TYPE_TO_SPAN_KIND = {
    llm_call: 'LLM',
    tool_execution: 'TOOL',
    decision: 'DECISION',
    error: 'ERROR',
    state_change: 'STATE_CHANGE',
    verification: 'EVALUATOR',
};
