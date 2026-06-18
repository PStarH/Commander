"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAIProvider = void 0;
const formatBridge_1 = require("../formatBridge");
const logging_1 = require("../../logging");
class OpenAIProvider {
    constructor(config) {
        var _a, _b;
        this.name = 'openai';
        this.apiKey = config.apiKey;
        this.baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : 'https://api.openai.com/v1';
        this.defaultModel = (_b = config.defaultModel) !== null && _b !== void 0 ? _b : 'gpt-4o';
    }
    async call(request) {
        var _a, _b;
        const model = this.defaultModel || request.model;
        const body = this.buildBody(request, model);
        // Include tool_calls if present on the last assistant message (for multi-turn)
        const lastAssistant = [...request.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant === null || lastAssistant === void 0 ? void 0 : lastAssistant.tool_calls) {
            body.tool_calls = lastAssistant.tool_calls;
        }
        const useStreaming = (_b = (_a = request.cacheConfig) === null || _a === void 0 ? void 0 : _a.useCacheControl) !== null && _b !== void 0 ? _b : true;
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ ...body, stream: useStreaming }),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenAI API error ${response.status}: ${err}`);
        }
        if (useStreaming) {
            return this.handleStreamingResponse(response, model, request.responseFormat);
        }
        const data = await response.json();
        return this.parseResponse(data, model, request.responseFormat);
    }
    buildBody(request, model) {
        var _a, _b, _c, _d;
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
        };
        if (request.tools && request.tools.length > 0) {
            body.tools = formatBridge_1.FormatBridge.adaptToolsForProvider(request.tools, 'openai');
            body.parallel_tool_calls = true;
        }
        // Provider-native structured output
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
        // OpenAI auto-caches prompts >1024 tokens — no explicit markers needed
        if ((_c = request.cacheConfig) === null || _c === void 0 ? void 0 : _c.cacheSystemPrompt) {
            // OpenAI's prompt caching is automatic for repeated prefixes
            // System prompt at the start ensures cache hits
        }
        if ((_d = request.cacheConfig) === null || _d === void 0 ? void 0 : _d.promptCacheKey) {
            body.prompt_cache_key = request.cacheConfig.promptCacheKey;
        }
        return body;
    }
    async handleStreamingResponse(response, model, responseFormat) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const reader = (_a = response.body) === null || _a === void 0 ? void 0 : _a.getReader();
        if (!reader)
            throw new Error('OpenAI: No response body from streaming endpoint');
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
                    break;
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
                    (0, logging_1.getGlobalLogger)().debug('OpenAIProvider', 'Skipping malformed stream chunk', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                }
            }
        }
        const tokenUsage = usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens,
                cacheReadTokens: (_h = (_g = usage.prompt_tokens_details) === null || _g === void 0 ? void 0 : _g.cached_tokens) !== null && _h !== void 0 ? _h : 0,
            }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const parsed = tryParseResponseFormat(content, responseFormat);
        return {
            content,
            model,
            usage: tokenUsage,
            finishReason: 'stop',
            toolCalls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.name,
                    arguments: JSON.parse(tc.arguments || '{}'),
                }))
                : undefined,
            parsed,
            reasoning_content: reasoningContent || undefined,
        };
    }
    parseResponse(data, model, responseFormat) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        const choice = (_a = data.choices) === null || _a === void 0 ? void 0 : _a[0];
        const message = (_b = choice === null || choice === void 0 ? void 0 : choice.message) !== null && _b !== void 0 ? _b : {};
        const tokenUsage = {
            promptTokens: (_d = (_c = data.usage) === null || _c === void 0 ? void 0 : _c.prompt_tokens) !== null && _d !== void 0 ? _d : 0,
            completionTokens: (_f = (_e = data.usage) === null || _e === void 0 ? void 0 : _e.completion_tokens) !== null && _f !== void 0 ? _f : 0,
            totalTokens: (_h = (_g = data.usage) === null || _g === void 0 ? void 0 : _g.total_tokens) !== null && _h !== void 0 ? _h : 0,
            cacheReadTokens: (_l = (_k = (_j = data.usage) === null || _j === void 0 ? void 0 : _j.prompt_tokens_details) === null || _k === void 0 ? void 0 : _k.cached_tokens) !== null && _l !== void 0 ? _l : 0,
        };
        const toolCalls = (_m = message.tool_calls) === null || _m === void 0 ? void 0 : _m.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
        }));
        const parsed = tryParseResponseFormat((_o = message.content) !== null && _o !== void 0 ? _o : '', responseFormat);
        return {
            content: (_p = message.content) !== null && _p !== void 0 ? _p : '',
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
            parsed,
            // Capture reasoning_content for MiMo reasoning models
            reasoning_content: message.reasoning_content,
        };
    }
}
exports.OpenAIProvider = OpenAIProvider;
function tryParseResponseFormat(content, responseFormat) {
    if (!responseFormat || !content.trim())
        return undefined;
    if (responseFormat.type !== 'json_schema' && responseFormat.type !== 'json_object')
        return undefined;
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('['))
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch (e) {
        (0, logging_1.getGlobalLogger)().debug('OpenAIProvider', 'Failed to parse structured response content', {
            error: e === null || e === void 0 ? void 0 : e.message,
        });
        return undefined;
    }
}
