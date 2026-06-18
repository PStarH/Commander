"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPAN_KIND_TO_OTEL_KIND = void 0;
exports.isGenAiSemConvOptIn = isGenAiSemConvOptIn;
exports.eventToOtelAttrs = eventToOtelAttrs;
exports.spanNameForEvent = spanNameForEvent;
const types_1 = require("./types");
exports.SPAN_KIND_TO_OTEL_KIND = {
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
function isGenAiSemConvOptIn() {
    var _a;
    const envVal = typeof process !== 'undefined' ? (_a = process.env) === null || _a === void 0 ? void 0 : _a.OTEL_SEMCONV_STABILITY_OPT_IN : undefined;
    if (!envVal)
        return true;
    return envVal
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .some((v) => v === 'gen_ai' || v === 'all');
}
function eventToOtelAttrs(e, ctx) {
    var _a, _b, _c, _d, _e, _f;
    const kind = ((_a = types_1.COMMANDER_TYPE_TO_SPAN_KIND[e.type]) !== null && _a !== void 0 ? _a : 'CHAIN');
    const operation = types_1.SPAN_KIND_TO_OPERATION[kind];
    const attrs = {
        'gen_ai.operation.name': operation,
    };
    if (e.data.modelInfo) {
        attrs['gen_ai.provider.name'] = e.data.modelInfo.provider;
        attrs['gen_ai.request.model'] = e.data.modelInfo.model;
        if (e.data.responseId)
            attrs['gen_ai.response.id'] = e.data.responseId;
    }
    // Extract request parameters from LLM call input
    if (e.type === 'llm_call' && e.data.input && typeof e.data.input === 'object') {
        const req = e.data.input;
        if (typeof req['temperature'] === 'number')
            attrs['gen_ai.request.temperature'] = req['temperature'];
        if (typeof req['top_p'] === 'number')
            attrs['gen_ai.request.top_p'] = req['top_p'];
    }
    if (e.data.tokenUsage) {
        attrs['gen_ai.usage.input_tokens'] = (_b = e.data.tokenUsage.promptTokens) !== null && _b !== void 0 ? _b : 0;
        attrs['gen_ai.usage.output_tokens'] = (_c = e.data.tokenUsage.completionTokens) !== null && _c !== void 0 ? _c : 0;
        attrs['gen_ai.usage.total_tokens'] = (_d = e.data.tokenUsage.totalTokens) !== null && _d !== void 0 ? _d : 0;
        if (typeof e.data.tokenUsage.cacheReadTokens === 'number' &&
            e.data.tokenUsage.cacheReadTokens > 0) {
            attrs['gen_ai.usage.cached_input_tokens'] = e.data.tokenUsage.cacheReadTokens;
        }
    }
    if (typeof e.data.reasoningTokens === 'number' && e.data.reasoningTokens > 0) {
        attrs['gen_ai.usage.reasoning.output_tokens'] = e.data.reasoningTokens;
    }
    if (e.data.outputType)
        attrs['gen_ai.output.type'] = e.data.outputType;
    if (e.data.finishReason)
        attrs['gen_ai.response.finish_reasons'] = e.data.finishReason;
    if (e.data.serverAddress)
        attrs['server.address'] = e.data.serverAddress;
    if (e.agentId)
        attrs['gen_ai.agent.id'] = e.agentId;
    if (ctx.agentName)
        attrs['gen_ai.agent.name'] = ctx.agentName;
    if (ctx.conversationId)
        attrs['gen_ai.conversation.id'] = ctx.conversationId;
    if (e.type === 'tool_execution') {
        // The exporter stashes the original tool name in `data.toolName` before
        // redacting `data.input` to '[redacted]'. Check `toolName` first, then
        // fall back to `input` for backward compat.
        const toolName = String((_f = (_e = e.data.toolName) !== null && _e !== void 0 ? _e : e.data.input) !== null && _f !== void 0 ? _f : 'unknown');
        attrs['gen_ai.tool.name'] = toolName;
        if (e.data.toolCallId)
            attrs['gen_ai.tool.call.id'] = e.data.toolCallId;
    }
    if (e.data.error) {
        attrs['error.type'] = e.type;
        attrs['error.message'] = String(e.data.error);
    }
    // Pass through classification fields for error events
    const dataEx = e.data;
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
function spanNameForEvent(e) {
    var _a, _b, _c, _d;
    const kind = ((_a = types_1.COMMANDER_TYPE_TO_SPAN_KIND[e.type]) !== null && _a !== void 0 ? _a : 'CHAIN');
    const op = types_1.SPAN_KIND_TO_OPERATION[kind];
    if (op === 'chat')
        return `chat ${(_c = (_b = e.data.modelInfo) === null || _b === void 0 ? void 0 : _b.model) !== null && _c !== void 0 ? _c : 'llm'}`;
    if (op === 'execute_tool')
        return `execute_tool ${String((_d = e.data.input) !== null && _d !== void 0 ? _d : 'unknown')}`;
    if (op === 'invoke_agent')
        return `invoke_agent ${e.agentId}`;
    return `${op} ${e.type}`;
}
