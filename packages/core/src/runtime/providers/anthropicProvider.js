"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicProvider = void 0;
const formatBridge_1 = require("../formatBridge");
const logging_1 = require("../../logging");
class AnthropicProvider {
    constructor(config) {
        var _a, _b;
        this.name = 'anthropic';
        this.apiKey = config.apiKey;
        this.baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : 'https://api.anthropic.com/v1';
        this.defaultModel = (_b = config.defaultModel) !== null && _b !== void 0 ? _b : 'claude-3-5-sonnet-20241022';
    }
    async call(request) {
        var _a, _b, _c, _d, _e, _f;
        const model = request.model || this.defaultModel;
        const anthropicMessages = this.buildMessages(request);
        const systemWithCache = this.buildSystemWithCache(request);
        const useStreaming = (_b = (_a = request.cacheConfig) === null || _a === void 0 ? void 0 : _a.useCacheControl) !== null && _b !== void 0 ? _b : true;
        const body = {
            model,
            max_tokens: (_c = request.maxTokens) !== null && _c !== void 0 ? _c : 8192,
            messages: anthropicMessages,
        };
        if (systemWithCache) {
            body.system = systemWithCache;
        }
        if (request.tools && request.tools.length > 0) {
            body.tools = formatBridge_1.FormatBridge.adaptToolsForProvider(request.tools, 'anthropic');
            if ((_d = request.cacheConfig) === null || _d === void 0 ? void 0 : _d.cacheTools) {
                const toolCacheControl = { type: 'ephemeral' };
                if ((_e = request.cacheConfig) === null || _e === void 0 ? void 0 : _e.cacheTtl)
                    toolCacheControl.ttl = request.cacheConfig.cacheTtl;
                body.tools.forEach((t) => {
                    t.cache_control = toolCacheControl;
                });
            }
        }
        // Anthropic does not support response_format natively. Use a dummy tool
        // with the output schema as its input_schema so the model can emit
        // structured data via tool_use.
        if (((_f = request.responseFormat) === null || _f === void 0 ? void 0 : _f.type) === 'json_schema' && request.responseFormat.schema) {
            const structuredTool = {
                name: 'structured_output',
                description: 'Emit the final answer as structured JSON matching the requested schema.',
                input_schema: request.responseFormat.schema,
            };
            if (!body.tools)
                body.tools = [];
            body.tools.push(structuredTool);
        }
        const response = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                ...(useStreaming ? { accept: 'text/event-stream' } : {}),
            },
            body: JSON.stringify(useStreaming ? { ...body, stream: true } : body),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Anthropic API error ${response.status}: ${err}`);
        }
        if (useStreaming) {
            return this.handleStreamingResponse(response, model);
        }
        const data = await response.json();
        return this.parseResponse(data, model);
    }
    buildMessages(request) {
        var _a;
        const msgs = [];
        let currentRole = null;
        let currentContent = [];
        for (const m of request.messages) {
            if (m.role === 'system')
                continue;
            if (m.role !== currentRole && currentContent.length > 0) {
                msgs.push({ role: currentRole, content: currentContent });
                currentContent = [];
            }
            currentRole = m.role;
            if (m.role === 'tool') {
                currentContent.push({
                    type: 'tool_result',
                    tool_use_id: (_a = m.tool_call_id) !== null && _a !== void 0 ? _a : '',
                    content: m.content,
                });
            }
            else if (m.tool_call_id) {
                currentContent.push({
                    type: 'tool_result',
                    tool_use_id: m.tool_call_id,
                    content: m.content,
                });
            }
            else {
                currentContent.push({ type: 'text', text: m.content });
            }
        }
        if (currentContent.length > 0 && currentRole) {
            msgs.push({ role: currentRole, content: currentContent });
        }
        return msgs;
    }
    buildSystemWithCache(request) {
        var _a, _b;
        const systemMsg = request.messages.find((m) => m.role === 'system');
        if (!systemMsg)
            return undefined;
        const blocks = [
            {
                type: 'text',
                text: systemMsg.content,
            },
        ];
        if ((_a = request.cacheConfig) === null || _a === void 0 ? void 0 : _a.cacheSystemPrompt) {
            blocks[0].cache_control = { type: 'ephemeral' };
            if ((_b = request.cacheConfig) === null || _b === void 0 ? void 0 : _b.cacheTtl)
                blocks[0].cache_control.ttl = request.cacheConfig.cacheTtl;
        }
        return blocks;
    }
    async handleStreamingResponse(response, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const reader = (_a = response.body) === null || _a === void 0 ? void 0 : _a.getReader();
        if (!reader)
            throw new Error('Anthropic: No response body from streaming endpoint');
        let content = '';
        const toolCalls = [];
        let currentToolBlock = null;
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
                if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:'))
                    continue;
                if (trimmed.startsWith('data: ')) {
                    const jsonStr = trimmed.slice(6);
                    try {
                        const event = JSON.parse(jsonStr);
                        if (event.type === 'content_block_delta' && ((_c = event.delta) === null || _c === void 0 ? void 0 : _c.text)) {
                            content += event.delta.text;
                        }
                        if (event.type === 'content_block_start' && ((_d = event.content_block) === null || _d === void 0 ? void 0 : _d.type) === 'tool_use') {
                            currentToolBlock = {
                                id: event.content_block.id,
                                name: event.content_block.name,
                                inputBuffer: '',
                            };
                        }
                        if (event.type === 'content_block_delta' &&
                            ((_e = event.delta) === null || _e === void 0 ? void 0 : _e.type) === 'input_json_delta' &&
                            currentToolBlock) {
                            currentToolBlock.inputBuffer += event.delta.partial_json;
                        }
                        if (event.type === 'content_block_stop' && currentToolBlock) {
                            try {
                                toolCalls.push({
                                    id: currentToolBlock.id,
                                    name: currentToolBlock.name,
                                    arguments: JSON.parse(currentToolBlock.inputBuffer || '{}'),
                                });
                            }
                            catch (e) {
                                (0, logging_1.getGlobalLogger)().debug('AnthropicProvider', 'Skipping malformed tool args', {
                                    error: e === null || e === void 0 ? void 0 : e.message,
                                });
                            }
                            currentToolBlock = null;
                        }
                        if (event.type === 'message_delta' && event.usage) {
                            usage = event.usage;
                        }
                        if (event.type === 'message_start' && ((_f = event.message) === null || _f === void 0 ? void 0 : _f.usage)) {
                            usage = event.message.usage;
                        }
                    }
                    catch (e) {
                        (0, logging_1.getGlobalLogger)().debug('AnthropicProvider', 'Skipping malformed stream event', {
                            error: e === null || e === void 0 ? void 0 : e.message,
                        });
                    }
                }
            }
        }
        const tokenUsage = {
            promptTokens: (_g = usage === null || usage === void 0 ? void 0 : usage.input_tokens) !== null && _g !== void 0 ? _g : 0,
            completionTokens: (_h = usage === null || usage === void 0 ? void 0 : usage.output_tokens) !== null && _h !== void 0 ? _h : 0,
            totalTokens: ((_j = usage === null || usage === void 0 ? void 0 : usage.input_tokens) !== null && _j !== void 0 ? _j : 0) + ((_k = usage === null || usage === void 0 ? void 0 : usage.output_tokens) !== null && _k !== void 0 ? _k : 0),
            cacheReadTokens: (_l = usage === null || usage === void 0 ? void 0 : usage.cache_read_input_tokens) !== null && _l !== void 0 ? _l : 0,
            cacheWriteTokens: (_m = usage === null || usage === void 0 ? void 0 : usage.cache_creation_input_tokens) !== null && _m !== void 0 ? _m : 0,
        };
        const structuredTool = toolCalls.find((tc) => tc.name === 'structured_output');
        const parsed = structuredTool === null || structuredTool === void 0 ? void 0 : structuredTool.arguments;
        const normalToolCalls = toolCalls.filter((tc) => tc.name !== 'structured_output');
        return {
            content,
            model,
            usage: tokenUsage,
            finishReason: 'stop',
            toolCalls: normalToolCalls.length > 0 ? normalToolCalls : undefined,
            parsed,
        };
    }
    parseResponse(data, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        const content = (_a = data.content) !== null && _a !== void 0 ? _a : [];
        const textBlocks = content.filter((c) => c.type === 'text');
        const toolBlocks = content.filter((c) => c.type === 'tool_use');
        const usage = {
            promptTokens: (_c = (_b = data.usage) === null || _b === void 0 ? void 0 : _b.input_tokens) !== null && _c !== void 0 ? _c : 0,
            completionTokens: (_e = (_d = data.usage) === null || _d === void 0 ? void 0 : _d.output_tokens) !== null && _e !== void 0 ? _e : 0,
            totalTokens: ((_g = (_f = data.usage) === null || _f === void 0 ? void 0 : _f.input_tokens) !== null && _g !== void 0 ? _g : 0) + ((_j = (_h = data.usage) === null || _h === void 0 ? void 0 : _h.output_tokens) !== null && _j !== void 0 ? _j : 0),
            cacheReadTokens: (_l = (_k = data.usage) === null || _k === void 0 ? void 0 : _k.cache_read_input_tokens) !== null && _l !== void 0 ? _l : 0,
            cacheWriteTokens: (_o = (_m = data.usage) === null || _m === void 0 ? void 0 : _m.cache_creation_input_tokens) !== null && _o !== void 0 ? _o : 0,
        };
        const structuredTool = toolBlocks.find((b) => b.name === 'structured_output');
        const parsed = (structuredTool === null || structuredTool === void 0 ? void 0 : structuredTool.input) && typeof structuredTool.input === 'object'
            ? structuredTool.input
            : undefined;
        const normalToolCalls = toolBlocks
            .filter((b) => b.name !== 'structured_output')
            .map((b) => {
            var _a;
            return ({
                id: b.id,
                name: b.name,
                arguments: ((_a = b.input) !== null && _a !== void 0 ? _a : {}),
            });
        });
        return {
            content: textBlocks.map((b) => b.text).join(''),
            model,
            usage,
            finishReason: 'stop',
            toolCalls: normalToolCalls.length > 0 ? normalToolCalls : undefined,
            parsed,
        };
    }
}
exports.AnthropicProvider = AnthropicProvider;
