"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiMoProvider = void 0;
exports.parseMiMoTextToolCalls = parseMiMoTextToolCalls;
const formatBridge_1 = require("../formatBridge");
const logging_1 = require("../../logging");
/**
 * MiMo Provider — Xiaomi's reasoning model API.
 * Endpoint: https://token-plan-sgp.xiaomimimo.com/v1
 * Models: mimo-v2.5, mimo-v2.5-pro, mimo-v2-pro, mimo-v2-omni
 *
 * MiMo-specific behavior:
 * - Reasoning models return `reasoning_content` field that MUST be passed back
 *   on follow-up calls to maintain chain-of-thought continuity.
 * - Uses OpenAI-compatible chat completions format.
 */
class MiMoProvider {
    constructor(config) {
        var _a, _b;
        this.name = 'mimo';
        this.apiKey = config.apiKey;
        this.baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : 'https://token-plan-sgp.xiaomimimo.com/v1';
        this.defaultModel = (_b = config.defaultModel) !== null && _b !== void 0 ? _b : 'mimo-v2.5';
    }
    async call(request) {
        var _a, _b;
        const model = this.defaultModel || request.model;
        const body = this.buildBody(request, model);
        // MiMo: pass back reasoning_content from previous responses
        const lastAssistant = [...request.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAssistant === null || lastAssistant === void 0 ? void 0 : lastAssistant.tool_calls) {
            body.tool_calls = lastAssistant.tool_calls;
        }
        const useStreaming = (_b = (_a = request.cacheConfig) === null || _a === void 0 ? void 0 : _a.useCacheControl) !== null && _b !== void 0 ? _b : true;
        let lastError = null;
        for (let attempt = 0; attempt <= MiMoProvider.MAX_RETRIES; attempt++) {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({ ...body, stream: useStreaming }),
            });
            if (response.ok) {
                if (useStreaming) {
                    return this.handleStreamingResponse(response, model);
                }
                const data = await response.json();
                return this.parseResponse(data, model);
            }
            const err = await response.text();
            lastError = new Error(`MiMo API error ${response.status}: ${err}`);
            // Only retry on 429 (rate limit) and 503 (service unavailable)
            if (response.status !== 429 && response.status !== 503) {
                throw lastError;
            }
            if (attempt < MiMoProvider.MAX_RETRIES) {
                // Exponential backoff with jitter: 2s, 4s, 8s, 16s + random 0-1s
                const delay = MiMoProvider.BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
                (0, logging_1.getGlobalLogger)().warn('MiMoProvider', `Rate limited (${response.status}), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MiMoProvider.MAX_RETRIES})`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }
    buildBody(request, model) {
        var _a;
        const messages = request.messages.map((m) => {
            const msg = { role: m.role, content: m.content };
            if (m.tool_call_id)
                msg.tool_call_id = m.tool_call_id;
            // Critical: pass reasoning_content for MiMo chain-of-thought continuity
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
        // Apply reasoning/thinking configuration
        // MiMo reasoning API supports enable_thinking + reasoning_effort for
        // models that have thinking capability.
        const rc = request.reasoningConfig;
        if (rc === null || rc === void 0 ? void 0 : rc.enabled) {
            body.enable_thinking = true;
            if (rc.effort)
                body.reasoning_effort = rc.effort;
            if (rc.budget && rc.budget > 0)
                body.max_thinking_tokens = rc.budget;
        }
        if (request.tools && request.tools.length > 0) {
            body.tools = formatBridge_1.FormatBridge.adaptToolsForProvider(request.tools, 'mimo');
            body.parallel_tool_calls = true;
        }
        return body;
    }
    async handleStreamingResponse(response, model) {
        var _a, _b, _c, _d, _e, _f;
        const reader = (_a = response.body) === null || _a === void 0 ? void 0 : _a.getReader();
        if (!reader)
            throw new Error('MiMo: No response body from streaming endpoint');
        let content = '';
        let reasoningContent = '';
        let toolCalls = [];
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
                    (0, logging_1.getGlobalLogger)().debug('MiMoProvider', 'Skipping malformed stream chunk', {
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
        // MiMo streaming may also return text-format tool calls
        if ((!toolCalls || toolCalls.length === 0) && content.includes('<tool_call>')) {
            const parsed = parseMiMoTextToolCalls(content);
            if (parsed.length > 0) {
                toolCalls = parsed.map((p) => ({
                    id: p.id,
                    name: p.name,
                    arguments: JSON.stringify(p.arguments),
                }));
                content = '';
            }
        }
        // MiMo reasoning model sometimes puts everything in reasoning_content
        // leaving content empty. Merge so AgentRuntime can read it.
        if (!content && reasoningContent) {
            content = reasoningContent;
        }
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
        let content = (_j = message.content) !== null && _j !== void 0 ? _j : '';
        let toolCalls = (_k = message.tool_calls) === null || _k === void 0 ? void 0 : _k.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
        }));
        // MiMo sometimes returns tool calls as text: <tool_call><function=name><parameter=k>v</parameter></function></tool_call>
        if ((!toolCalls || toolCalls.length === 0) && content.includes('<tool_call>')) {
            const parsed = parseMiMoTextToolCalls(content);
            if (parsed.length > 0) {
                toolCalls = parsed;
                content = ''; // tool calls consumed, no text response
            }
        }
        // Same merge as in streaming handler: MiMo reasoning model puts
        // output in reasoning_content leaving content empty.
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
            reasoning_content: message.reasoning_content,
        };
    }
}
exports.MiMoProvider = MiMoProvider;
MiMoProvider.MAX_RETRIES = 4;
MiMoProvider.BASE_DELAY_MS = 2000;
/**
 * Parse MiMo's text-format tool calls into structured format.
 *
 * Input:  "<tool_call>\n<function=web_search>\n<parameter=query>AI news</parameter>\n</function>\n</tool_call>"
 * Output: [{ id: "call_xxx", name: "web_search", arguments: { query: "AI news" } }]
 */
function parseMiMoTextToolCalls(content) {
    const results = [];
    // Split by <tool_call> blocks
    const blocks = content.split('<tool_call>').slice(1);
    for (const block of blocks) {
        const endTag = '</tool_call>';
        const blockContent = block.includes(endTag) ? block.split(endTag)[0] : block;
        // Extract function name: <function=name> or <function_name>
        const funcMatch = blockContent.match(/<function[=_]([^>]+)>/);
        if (!funcMatch)
            continue;
        const name = funcMatch[1].trim();
        // Extract parameters: <parameter=key>value</parameter>
        const args = {};
        const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
        let paramMatch;
        while ((paramMatch = paramRegex.exec(blockContent)) !== null) {
            args[paramMatch[1].trim()] = paramMatch[2].trim();
        }
        results.push({
            id: `call_mimo_${Date.now()}_${results.length}`,
            name,
            arguments: args,
        });
    }
    return results;
}
