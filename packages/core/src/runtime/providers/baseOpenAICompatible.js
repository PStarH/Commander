"use strict";
/**
 * Base class for OpenAI-compatible LLM providers.
 *
 * Many providers (DeepSeek, GLM, MiMo, Xiaomi, Ollama, vLLM, Groq,
 * Together AI, Perplexity, Mistral, Fireworks, etc.) use the OpenAI
 * chat completions format. This base eliminates duplication of:
 * - Streaming SSE parsing
 * - Tool call handling (JSON + text-format)
 * - Error handling
 * - Body construction
 *
 * Subclasses need only set their default config and optionally override
 * buildBody() or parseResponse() for provider-specific behavior.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseOpenAICompatibleProvider = void 0;
exports.parseOpenAIStream = parseOpenAIStream;
exports.parseOpenAIResponse = parseOpenAIResponse;
exports.buildOpenAIBody = buildOpenAIBody;
exports.callOpenAICompatibleAPI = callOpenAICompatibleAPI;
const formatBridge_1 = require("../formatBridge");
const logging_1 = require("../../logging");
// ============================================================================
// Shared utilities
// ============================================================================
/**
 * Parse OpenAI SSE stream into content, reasoning, tool calls, and usage.
 */
async function parseOpenAIStream(response, logger) {
    var _a, _b, _c, _d, _e, _f;
    const reader = (_a = response.body) === null || _a === void 0 ? void 0 : _a.getReader();
    if (!reader)
        throw new Error('OpenAI-compatible: No response body from streaming endpoint');
    let content = '';
    let reasoningContent = '';
    const toolCalls = [];
    let currentTool = null;
    let usage = null;
    let buffer = '';
    const decoder = new TextDecoder();
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = (_b = lines.pop()) !== null && _b !== void 0 ? _b : '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: '))
                continue;
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]')
                continue;
            try {
                const chunk = JSON.parse(jsonStr);
                if (chunk.usage)
                    usage = chunk.usage;
                for (const choice of (_c = chunk.choices) !== null && _c !== void 0 ? _c : []) {
                    const delta = choice.delta;
                    if (delta.content)
                        content += delta.content;
                    if (delta.reasoning_content)
                        reasoningContent += delta.reasoning_content;
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            if (tc.id) {
                                currentTool = { id: tc.id, name: (_e = (_d = tc.function) === null || _d === void 0 ? void 0 : _d.name) !== null && _e !== void 0 ? _e : '', arguments: '' };
                                toolCalls.push(currentTool);
                            }
                            if (currentTool && ((_f = tc.function) === null || _f === void 0 ? void 0 : _f.arguments)) {
                                currentTool.arguments += tc.function.arguments;
                            }
                        }
                    }
                }
            }
            catch (e) {
                logger.debug('BaseOpenAI', 'Skipping malformed stream chunk', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
    }
    return { content, reasoningContent, toolCalls, usage };
}
function parseOpenAIResponse(data, model, extractTextToolCalls, responseFormat) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const choice = (_a = data.choices) === null || _a === void 0 ? void 0 : _a[0];
    const message = (_b = choice === null || choice === void 0 ? void 0 : choice.message) !== null && _b !== void 0 ? _b : {};
    const tokenUsage = {
        promptTokens: (_d = (_c = data.usage) === null || _c === void 0 ? void 0 : _c.prompt_tokens) !== null && _d !== void 0 ? _d : 0,
        completionTokens: (_f = (_e = data.usage) === null || _e === void 0 ? void 0 : _e.completion_tokens) !== null && _f !== void 0 ? _f : 0,
        totalTokens: (_h = (_g = data.usage) === null || _g === void 0 ? void 0 : _g.total_tokens) !== null && _h !== void 0 ? _h : 0,
        cacheReadTokens: (_l = (_k = (_j = data.usage) === null || _j === void 0 ? void 0 : _j.prompt_tokens_details) === null || _k === void 0 ? void 0 : _k.cached_tokens) !== null && _l !== void 0 ? _l : 0,
    };
    let content = (_m = message.content) !== null && _m !== void 0 ? _m : '';
    let toolCalls = (_o = message.tool_calls) === null || _o === void 0 ? void 0 : _o.map((tc) => {
        let parsed = {};
        try {
            parsed = JSON.parse(tc.function.arguments || '{}');
        }
        catch {
            try {
                parsed = JSON.parse(`{${tc.function.arguments}}`);
            }
            catch {
                parsed = { raw: tc.function.arguments };
            }
        }
        return { id: tc.id, name: tc.function.name, arguments: parsed };
    });
    // Some providers return tool calls as text (e.g. MiMo text format)
    if ((!toolCalls || toolCalls.length === 0) && content && extractTextToolCalls) {
        const parsed = extractTextToolCalls(content);
        if (parsed && parsed.length > 0) {
            toolCalls = parsed;
            content = '';
        }
    }
    // Merge reasoning_content into content for models that put output there
    if (!content && message.reasoning_content) {
        content = message.reasoning_content;
    }
    return {
        content,
        model,
        usage: tokenUsage,
        finishReason: (choice === null || choice === void 0 ? void 0 : choice.finish_reason) === 'stop'
            ? 'stop'
            : (choice === null || choice === void 0 ? void 0 : choice.finish_reason) === 'tool_calls'
                ? 'tool_calls'
                : (choice === null || choice === void 0 ? void 0 : choice.finish_reason) === 'length'
                    ? 'length'
                    : 'stop',
        toolCalls,
        parsed: tryParseOpenAICompatibleStructured(content, responseFormat),
        reasoning_content: message.reasoning_content,
    };
}
function tryParseOpenAICompatibleStructured(content, responseFormat) {
    if (!responseFormat || responseFormat.type === 'text' || !content.trim())
        return undefined;
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
}
/**
 * Build the standard OpenAI-compatible request body.
 */
function buildOpenAIBody(request, model, providerName, extra = {}) {
    var _a, _b;
    const messages = request.messages.map((m) => {
        const msg = { role: m.role, content: m.content };
        if (m.tool_call_id)
            msg.tool_call_id = m.tool_call_id;
        if (m.reasoning_content)
            msg.reasoning_content = m.reasoning_content;
        if (m.name)
            msg.name = m.name;
        if (m.tool_calls)
            msg.tool_calls = m.tool_calls;
        return msg;
    });
    const body = {
        model,
        messages,
        max_tokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096,
        ...extra,
    };
    if (request.temperature !== undefined)
        body.temperature = request.temperature;
    if (request.stop && request.stop.length > 0)
        body.stop = request.stop;
    if (request.tools && request.tools.length > 0) {
        body.tools = formatBridge_1.FormatBridge.adaptToolsForProvider(request.tools, providerName);
        body.parallel_tool_calls = true;
    }
    // Provider-native structured output for OpenAI-compatible endpoints
    if (request.responseFormat) {
        if (request.responseFormat.type === 'json_schema' && request.responseFormat.schema) {
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: (_b = request.responseFormat.name) !== null && _b !== void 0 ? _b : 'response',
                    schema: request.responseFormat.schema,
                    strict: true,
                },
            };
        }
        else if (request.responseFormat.type === 'json_object') {
            body.response_format = { type: 'json_object' };
        }
    }
    return body;
}
/**
 * Standard OpenAI-compatible API call.
 * Handles streaming and non-streaming, auto-detects which to use.
 */
async function callOpenAICompatibleAPI(config, request, model, extractTextToolCalls, extraBody) {
    var _a, _b, _c, _d;
    const body = buildOpenAIBody(request, model, config.name, extraBody);
    const useStreaming = (_b = (_a = request.cacheConfig) === null || _a === void 0 ? void 0 : _a.useCacheControl) !== null && _b !== void 0 ? _b : true;
    const logger = (0, logging_1.getGlobalLogger)();
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
            ...config.extraHeaders,
        },
        body: JSON.stringify({ ...body, stream: useStreaming }),
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`${config.name} API error ${response.status}: ${err}`);
    }
    if (useStreaming) {
        const streamed = await parseOpenAIStream(response, logger);
        const tokenUsage = streamed.usage
            ? {
                promptTokens: streamed.usage.prompt_tokens,
                completionTokens: streamed.usage.completion_tokens,
                totalTokens: streamed.usage.total_tokens,
                cacheReadTokens: (_d = (_c = streamed.usage.prompt_tokens_details) === null || _c === void 0 ? void 0 : _c.cached_tokens) !== null && _d !== void 0 ? _d : 0,
            }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        return {
            content: streamed.content,
            model,
            usage: tokenUsage,
            finishReason: 'stop',
            toolCalls: streamed.toolCalls.length > 0
                ? streamed.toolCalls.map((tc) => {
                    let parsed = {};
                    try {
                        parsed = JSON.parse(tc.arguments || '{}');
                    }
                    catch {
                        try {
                            parsed = JSON.parse(`{${tc.arguments}}`);
                        }
                        catch {
                            parsed = { raw: tc.arguments };
                        }
                    }
                    return { id: tc.id, name: tc.name, arguments: parsed };
                })
                : undefined,
            parsed: tryParseOpenAICompatibleStructured(streamed.content, request.responseFormat),
            reasoning_content: streamed.reasoningContent || undefined,
        };
    }
    const data = await response.json();
    return parseOpenAIResponse(data, model, extractTextToolCalls, request.responseFormat);
}
// ============================================================================
// Abstract base class
// ============================================================================
class BaseOpenAICompatibleProvider {
    constructor(config) {
        var _a, _b, _c, _d;
        this.config = {
            apiKey: config.apiKey,
            baseUrl: (_a = config.baseUrl) !== null && _a !== void 0 ? _a : this.getDefaultBaseUrl(),
            defaultModel: (_b = config.defaultModel) !== null && _b !== void 0 ? _b : this.getDefaultModel(),
            name: (_c = config.name) !== null && _c !== void 0 ? _c : 'unknown',
            ...this.getExtraConfig(),
        };
        // Override config.name with the concrete class's name (avoid abstract in constructor)
        if (!config.name) {
            this.config.name =
                ((_d = this.constructor.name) === null || _d === void 0 ? void 0 : _d.replace('Provider', '').toLowerCase()) ||
                    this.config.name;
        }
    }
    /** Override to provide extra config (headers, isLocal, etc.) */
    getExtraConfig() {
        return {};
    }
    /** Override to provide extra body fields per-request */
    getExtraBody(_request) {
        return {};
    }
    /** Override for providers that emit text-format tool calls */
    extractTextToolCalls(_content) {
        return null;
    }
    async call(request) {
        const model = request.model || this.config.defaultModel;
        return callOpenAICompatibleAPI(this.config, request, model, (content) => this.extractTextToolCalls(content), this.getExtraBody(request));
    }
}
exports.BaseOpenAICompatibleProvider = BaseOpenAICompatibleProvider;
