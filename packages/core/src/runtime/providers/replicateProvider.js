"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReplicateProvider = void 0;
const logging_1 = require("../../logging");
/**
 * Replicate Provider — Run open-source models via Replicate's API.
 *
 * Endpoint: https://api.replicate.com/v1
 * Models: meta/meta-llama-3.3-70b-instruct, mistralai/mistral-7b-instruct,
 *         google-deepmind/gemma-2-27b-it
 *
 * Note: Replicate uses a different API format than OpenAI.
 * Each model has its own input schema. We use the chat/compat endpoint
 * for models that support it, falling back to the prediction API.
 *
 * Env: REPLICATE_API_TOKEN (primary, official Replicate env var)
 *       REPLICATE_API_KEY (fallback)
 *       REPLICATE_BASE_URL (optional)
 *       REPLICATE_MODEL (optional)
 */
class ReplicateProvider {
    constructor(config) {
        var _a, _b, _c, _d;
        this.name = 'replicate';
        this.apiKey =
            config.apiKey || process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '';
        this.baseUrl =
            (_b = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : process.env.REPLICATE_BASE_URL) !== null && _b !== void 0 ? _b : 'https://api.replicate.com/v1';
        this.defaultModel =
            (_d = (_c = config.defaultModel) !== null && _c !== void 0 ? _c : process.env.REPLICATE_MODEL) !== null && _d !== void 0 ? _d : 'meta/meta-llama-3.3-70b-instruct';
    }
    async call(request) {
        const model = request.model || this.defaultModel;
        if (request.tools && request.tools.length > 0) {
            throw new Error(`[replicate] Replicate does NOT support tool/function calling. ` +
                `Remove tools from the request or use a different provider (e.g. OpenAI, Anthropic) ` +
                `for agentic workflows that require tools.`);
        }
        // Try chat/compat endpoint first (OpenAI-compatible, supported by many models)
        try {
            return await this.callChatCompat(request, model);
        }
        catch {
            // Fall back to Replicate's prediction API
            return await this.callPrediction(request, model);
        }
    }
    async callChatCompat(request, model) {
        var _a, _b, _c, _d, _e, _f;
        const messages = request.messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
            content: m.content,
        }));
        const response = await fetch(`${this.baseUrl}/models/${model}/chat/compat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                messages,
                max_tokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096,
                temperature: (_b = request.temperature) !== null && _b !== void 0 ? _b : 0.7,
            }),
        });
        if (!response.ok) {
            const err = await response.text().catch(() => '');
            throw new Error(`Replicate chat compat error ${response.status} — some models don't support this endpoint; falls back to prediction API. Body: ${err}`);
        }
        const data = await response.json();
        return {
            content: (_f = (_e = (_d = (_c = data.choices) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.content) !== null && _f !== void 0 ? _f : '',
            model,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: 'stop',
        };
    }
    async callPrediction(request, model) {
        var _a, _b, _c;
        const systemMsg = request.messages.find((m) => m.role === 'system');
        const userMsg = request.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
        const prompt = userMsg
            .map((m) => {
            const role = m.role === 'assistant' ? 'Assistant' : 'User';
            return `${role}: ${m.content}`;
        })
            .join('\n\n');
        const input = {
            prompt: systemMsg ? `${systemMsg.content}\n\n${prompt}` : prompt,
            max_tokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096,
            temperature: (_b = request.temperature) !== null && _b !== void 0 ? _b : 0.7,
        };
        // Create prediction
        const createRes = await fetch(`${this.baseUrl}/predictions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                version: model,
                input,
            }),
        });
        if (!createRes.ok) {
            const err = await createRes.text();
            throw new Error(`Replicate prediction error ${createRes.status}: ${err}`);
        }
        const prediction = await createRes.json();
        // Poll for completion (Replicate runs async)
        const result = await this.pollPrediction(prediction.id);
        return {
            content: Array.isArray(result.output) ? result.output.join('') : ((_c = result.output) !== null && _c !== void 0 ? _c : ''),
            model,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            finishReason: result.status === 'succeeded' ? 'stop' : 'error',
        };
    }
    async pollPrediction(id, maxAttempts = 60) {
        const logger = (0, logging_1.getGlobalLogger)();
        for (let i = 0; i < maxAttempts; i++) {
            const res = await fetch(`${this.baseUrl}/predictions/${id}`, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                },
            });
            if (!res.ok) {
                const err = await res.text().catch(() => '');
                throw new Error(`Replicate poll error ${res.status}: ${err}`);
            }
            const data = await res.json();
            if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
                return data;
            }
            // Wait 1s between polls
            await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error('Replicate prediction timed out');
    }
}
exports.ReplicateProvider = ReplicateProvider;
