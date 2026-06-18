"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoogleProvider = void 0;
class GoogleProvider {
    constructor(config) {
        var _a, _b;
        this.name = 'google';
        this.apiKey = config.apiKey;
        this.baseUrl = (_a = config.baseUrl) !== null && _a !== void 0 ? _a : 'https://generativelanguage.googleapis.com/v1beta';
        this.defaultModel = (_b = config.defaultModel) !== null && _b !== void 0 ? _b : 'gemini-2.0-flash';
    }
    async call(request) {
        var _a, _b, _c, _d, _e;
        const model = request.model || this.defaultModel;
        const contents = this.buildContents(request);
        const systemInstruction = this.buildSystemInstruction(request);
        const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
        const body = {
            contents,
            generationConfig: {
                maxOutputTokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 8192,
                temperature: (_b = request.temperature) !== null && _b !== void 0 ? _b : 0.7,
            },
        };
        if (systemInstruction) {
            body.system_instruction = { parts: [{ text: systemInstruction }] };
        }
        // Provider-native structured output (Gemini responseSchema)
        if (((_c = request.responseFormat) === null || _c === void 0 ? void 0 : _c.type) === 'json_schema' && request.responseFormat.schema) {
            body.generationConfig.responseMimeType = 'application/json';
            body.generationConfig.responseSchema =
                request.responseFormat.schema;
        }
        else if (((_d = request.responseFormat) === null || _d === void 0 ? void 0 : _d.type) === 'json_object') {
            body.generationConfig.responseMimeType = 'application/json';
        }
        // Gemini cachedContent wiring: when a server-side cached content name is provided in
        // cacheConfig, reference it instead of inline contents. This is a >4K token optimization;
        // cached tokens are billed at 90% discount. The system instruction and tools can stay
        // inline as well — Gemini deduplicates them against the cached content.
        const cachedContentName = (_e = request.cacheConfig) === null || _e === void 0 ? void 0 : _e.geminiCachedContentName;
        if (cachedContentName) {
            body.cachedContent = cachedContentName;
        }
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Gemini API error ${response.status}: ${err}`);
        }
        const data = await response.json();
        return this.parseResponse(data, model, request.responseFormat);
    }
    buildContents(request) {
        const contents = [];
        for (const msg of request.messages) {
            if (msg.role === 'system')
                continue;
            const role = msg.role === 'assistant' ? 'model' : msg.role;
            contents.push({
                role,
                parts: [{ text: msg.content }],
            });
        }
        return contents;
    }
    buildSystemInstruction(request) {
        const sysMsg = request.messages.find((m) => m.role === 'system');
        return sysMsg === null || sysMsg === void 0 ? void 0 : sysMsg.content;
    }
    parseResponse(data, model, responseFormat) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
        const text = (_f = (_e = (_d = (_c = (_b = (_a = data.candidates) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.content) === null || _c === void 0 ? void 0 : _c.parts) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.text) !== null && _f !== void 0 ? _f : '';
        const finishReason = (_j = (_h = (_g = data.candidates) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h.finishReason) !== null && _j !== void 0 ? _j : 'stop';
        const usage = (_k = data.usageMetadata) !== null && _k !== void 0 ? _k : {
            promptTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
        };
        const parsed = tryParseGeminiResponse(text, responseFormat);
        return {
            content: text,
            model,
            usage: {
                promptTokens: usage.promptTokenCount,
                completionTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount,
            },
            finishReason: finishReason === 'STOP' ? 'stop' : finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
            parsed,
        };
    }
}
exports.GoogleProvider = GoogleProvider;
function tryParseGeminiResponse(content, responseFormat) {
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
