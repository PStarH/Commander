"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XiaomiProvider = void 0;
const formatBridge_1 = require("../formatBridge");
const mimoProvider_1 = require("./mimoProvider");
const logging_1 = require("../../logging");
/**
 * Xiaomi MiMo Provider — Xiaomi's own MiMo API (separate from MiMo's token-plan endpoint).
 * Endpoint: https://api.xiaomimimo.com/v1
 * Models: mimo-v2-flash, mimo-v2-pro, mimo-v2-omni
 *
 * This is the Xiaomi-hosted version of MiMo, distinct from the token-plan endpoint
 * used by MiMoProvider. Use XIAOMI_API_KEY to activate.
 *
 * Xiaomi-specific behavior:
 * - Uses OpenAI-compatible chat completions format.
 * - Reasoning models return `reasoning_content`.
 */
class XiaomiProvider {
    constructor(config) {
        var _a, _b;
        this.name = 'xiaomi';
        this.apiKey = config.apiKey;
        this.baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : 'https://api.xiaomimimo.com/v1';
        this.defaultModel = (_b = config.defaultModel) !== null && _b !== void 0 ? _b : 'mimo-v2-flash';
    }
    async call(request) {
        var _a, _b;
        const model = this.defaultModel || request.model;
        const body = this.buildBody(request, model);
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
            throw new Error(`Xiaomi MiMo API error ${response.status}: ${err}`);
        }
        if (useStreaming) {
            return this.handleStreamingResponse(response, model);
        }
        const data = await response.json();
        return this.parseResponse(data, model);
    }
    buildBody(request, model) {
        var _a;
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
            body.tools = formatBridge_1.FormatBridge.adaptToolsForProvider(request.tools, 'xiaomi');
            body.parallel_tool_calls = true;
        }
        return body;
    }
    async handleStreamingResponse(response, model) {
        var _a, _b, _c, _d, _e, _f;
        const reader = (_a = response.body) === null || _a === void 0 ? void 0 : _a.getReader();
        if (!reader)
            throw new Error('Xiaomi MiMo: No response body from streaming endpoint');
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
                    (0, logging_1.getGlobalLogger)().debug('XiaomiProvider', 'Skipping malformed stream chunk', {
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
            }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        return {
            content,
            model,
            usage: tokenUsage,
            finishReason: 'stop',
            toolCalls: toolCalls.length > 0
                ? toolCalls.map((tc) => {
                    let args = {};
                    try {
                        args = JSON.parse(tc.arguments || '{}');
                    }
                    catch {
                        args = {};
                    }
                    return { id: tc.id, name: tc.name, arguments: args };
                })
                : undefined,
            reasoning_content: reasoningContent || undefined,
        };
    }
    parseResponse(data, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const choice = (_a = data.choices) === null || _a === void 0 ? void 0 : _a[0];
        const message = (_b = choice === null || choice === void 0 ? void 0 : choice.message) !== null && _b !== void 0 ? _b : {};
        const tokenUsage = {
            promptTokens: (_d = (_c = data.usage) === null || _c === void 0 ? void 0 : _c.prompt_tokens) !== null && _d !== void 0 ? _d : 0,
            completionTokens: (_f = (_e = data.usage) === null || _e === void 0 ? void 0 : _e.completion_tokens) !== null && _f !== void 0 ? _f : 0,
            totalTokens: (_h = (_g = data.usage) === null || _g === void 0 ? void 0 : _g.total_tokens) !== null && _h !== void 0 ? _h : 0,
        };
        // Parse text-format tool calls too
        let content = (_j = message.content) !== null && _j !== void 0 ? _j : '';
        let toolCalls = (_k = message.tool_calls) === null || _k === void 0 ? void 0 : _k.map((tc) => {
            let args = {};
            try {
                args = JSON.parse(tc.function.arguments || '{}');
            }
            catch {
                args = {};
            }
            return { id: tc.id, name: tc.function.name, arguments: args };
        });
        if ((!toolCalls || toolCalls.length === 0) && content.includes('<tool_call>')) {
            const parsed = (0, mimoProvider_1.parseMiMoTextToolCalls)(content);
            if (parsed.length > 0) {
                toolCalls = parsed;
                content = '';
            }
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
            reasoning_content: message.reasoning_content,
        };
    }
}
exports.XiaomiProvider = XiaomiProvider;
