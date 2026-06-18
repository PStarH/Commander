"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CohereProvider = void 0;
/**
 * Cohere Provider — Cohere's native API.
 *
 * Endpoint (chat): https://api.cohere.com/v2/chat
 * Models: command-a-plus-05-2026, command-a-03-2025, command-r-08-2024, command-r-plus-08-2024
 *
 * Cohere uses a multi-turn chat format with tool support.
 * This adapter maps Commander's LLMRequest to Cohere's API.
 *
 * Env: CO_API_KEY (primary, official Python SDK default)
 *       COHERE_API_KEY (fallback)
 *       COHERE_BASE_URL (optional)
 *       COHERE_MODEL (optional)
 */
class CohereProvider {
    constructor(config) {
        var _a, _b, _c, _d;
        this.name = 'cohere';
        this.apiKey = config.apiKey || process.env.CO_API_KEY || process.env.COHERE_API_KEY || '';
        this.baseUrl = (_b = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : process.env.COHERE_BASE_URL) !== null && _b !== void 0 ? _b : 'https://api.cohere.com';
        this.defaultModel = (_d = (_c = config.defaultModel) !== null && _c !== void 0 ? _c : process.env.COHERE_MODEL) !== null && _d !== void 0 ? _d : 'command-a-plus-05-2026';
    }
    async call(request) {
        var _a;
        const model = request.model || this.defaultModel;
        const body = this.buildBody(request, model);
        const response = await fetch(`${this.baseUrl}/v2/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                ...(((_a = request.cacheConfig) === null || _a === void 0 ? void 0 : _a.useCacheControl) ? { accept: 'text/event-stream' } : {}),
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Cohere API error ${response.status}: ${err}`);
        }
        const data = await response.json();
        return this.parseResponse(data, model);
    }
    buildBody(request, model) {
        var _a;
        // Cohere v2 chat format: separate system message, then messages array
        const systemMsg = request.messages.find((m) => m.role === 'system');
        const otherMessages = request.messages.filter((m) => m.role !== 'system');
        const messages = otherMessages.map((m) => {
            const msg = {
                role: m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : 'user',
                content: m.content,
            };
            if (m.tool_call_id)
                msg.tool_call_id = m.tool_call_id;
            if (m.tool_calls)
                msg.tool_calls = m.tool_calls;
            return msg;
        });
        const body = {
            model,
            messages,
            max_tokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096,
        };
        if (systemMsg) {
            body.system = systemMsg.content;
        }
        if (request.temperature !== undefined)
            body.temperature = request.temperature;
        // Map tools to Cohere's tool format
        if (request.tools && request.tools.length > 0) {
            body.tools = request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameter_definitions: this.cohereParameterDefs(t.inputSchema),
            }));
        }
        return body;
    }
    cohereParameterDefs(schema) {
        var _a;
        // Cohere expects flat parameter_definitions
        const props = schema.properties || {};
        const defs = {};
        for (const [key, val] of Object.entries(props)) {
            const prop = val;
            defs[key] = {
                description: prop.description || '',
                type: prop.type || 'string',
                required: ((_a = schema.required) === null || _a === void 0 ? void 0 : _a.includes(key)) || false,
            };
        }
        return defs;
    }
    parseResponse(data, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        const message = data.message || {};
        const content = Array.isArray(message.content)
            ? ((_b = (_a = message.content[0]) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : '')
            : typeof message.content === 'string'
                ? message.content
                : '';
        // Parse tool calls
        const toolCalls = (message.tool_calls || []).map((tc) => {
            var _a, _b;
            return ({
                id: tc.id || `call_${Date.now()}`,
                type: 'function',
                function: {
                    name: ((_a = tc.function) === null || _a === void 0 ? void 0 : _a.name) || tc.name || '',
                    arguments: (((_b = tc.function) === null || _b === void 0 ? void 0 : _b.arguments) || tc.parameters || {}),
                },
            });
        });
        const usage = {
            promptTokens: (_h = (_e = (_d = (_c = data.usage) === null || _c === void 0 ? void 0 : _c.input_tokens) !== null && _d !== void 0 ? _d : data.input_tokens) !== null && _e !== void 0 ? _e : (_g = (_f = data.meta) === null || _f === void 0 ? void 0 : _f.billed_units) === null || _g === void 0 ? void 0 : _g.input_tokens) !== null && _h !== void 0 ? _h : 0,
            completionTokens: (_p = (_l = (_k = (_j = data.usage) === null || _j === void 0 ? void 0 : _j.output_tokens) !== null && _k !== void 0 ? _k : data.output_tokens) !== null && _l !== void 0 ? _l : (_o = (_m = data.meta) === null || _m === void 0 ? void 0 : _m.billed_units) === null || _o === void 0 ? void 0 : _o.output_tokens) !== null && _p !== void 0 ? _p : 0,
            totalTokens: 0,
        };
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
        return {
            content,
            model,
            usage,
            finishReason: data.finish_reason === 'COMPLETE'
                ? 'stop'
                : data.finish_reason === 'MAX_TOKENS'
                    ? 'length'
                    : data.finish_reason === 'ERROR'
                        ? 'error'
                        : 'stop',
            toolCalls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                }))
                : undefined,
        };
    }
}
exports.CohereProvider = CohereProvider;
