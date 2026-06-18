"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenRouterProvider = void 0;
const formatBridge_1 = require("../formatBridge");
const logging_1 = require("../../logging");
class OpenRouterProvider {
    constructor(config) {
        var _a, _b;
        this.name = 'openrouter';
        this.apiKey = config.apiKey;
        this.baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : 'https://openrouter.ai/api/v1';
        this.defaultModel = (_b = config.defaultModel) !== null && _b !== void 0 ? _b : 'openai/gpt-4o-mini';
    }
    async call(request) {
        var _a, _b;
        const model = request.model || this.defaultModel;
        const messages = request.messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        }));
        const body = {
            model,
            messages,
            max_tokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 8192,
            temperature: (_b = request.temperature) !== null && _b !== void 0 ? _b : 0.7,
        };
        if (request.tools && request.tools.length > 0) {
            body.tools = formatBridge_1.FormatBridge.adaptToolsForProvider(request.tools, 'openrouter');
        }
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
                'HTTP-Referer': 'https://github.com/PStarH/Commander',
                'X-Title': 'Commander',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`OpenRouter API error ${response.status}: ${err}`);
        }
        const data = await response.json();
        return this.parseResponse(data, model);
    }
    parseResponse(data, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
        const choice = (_a = data.choices) === null || _a === void 0 ? void 0 : _a[0];
        const message = (_b = choice === null || choice === void 0 ? void 0 : choice.message) !== null && _b !== void 0 ? _b : {};
        return {
            content: (_c = message.content) !== null && _c !== void 0 ? _c : '',
            model: (_d = data.model) !== null && _d !== void 0 ? _d : model,
            usage: {
                promptTokens: (_f = (_e = data.usage) === null || _e === void 0 ? void 0 : _e.prompt_tokens) !== null && _f !== void 0 ? _f : 0,
                completionTokens: (_h = (_g = data.usage) === null || _g === void 0 ? void 0 : _g.completion_tokens) !== null && _h !== void 0 ? _h : 0,
                totalTokens: (_k = (_j = data.usage) === null || _j === void 0 ? void 0 : _j.total_tokens) !== null && _k !== void 0 ? _k : 0,
            },
            finishReason: (choice === null || choice === void 0 ? void 0 : choice.finish_reason) === 'stop'
                ? 'stop'
                : (choice === null || choice === void 0 ? void 0 : choice.finish_reason) === 'tool_calls'
                    ? 'tool_calls'
                    : (choice === null || choice === void 0 ? void 0 : choice.finish_reason) === 'length'
                        ? 'length'
                        : 'stop',
            toolCalls: (_l = message.tool_calls) === null || _l === void 0 ? void 0 : _l.map((tc) => {
                var _a, _b;
                return ({
                    id: tc.id,
                    name: (_b = (_a = tc.function) === null || _a === void 0 ? void 0 : _a.name) !== null && _b !== void 0 ? _b : '',
                    arguments: (() => {
                        var _a, _b;
                        try {
                            return JSON.parse((_b = (_a = tc.function) === null || _a === void 0 ? void 0 : _a.arguments) !== null && _b !== void 0 ? _b : '{}');
                        }
                        catch (e) {
                            (0, logging_1.getGlobalLogger)().debug('OpenRouterProvider', 'Skipping malformed tool arguments', {
                                error: e === null || e === void 0 ? void 0 : e.message,
                            });
                            return {};
                        }
                    })(),
                });
            }),
            reasoning_content: message.reasoning,
        };
    }
}
exports.OpenRouterProvider = OpenRouterProvider;
