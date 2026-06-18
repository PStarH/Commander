"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractJSON = extractJSON;
exports.callLLMJSON = callLLMJSON;
const logging_1 = require("../logging");
/**
 * Extract a JSON object from an LLM response string.
 * Tries multiple strategies:
 * 1. Direct JSON.parse
 * 2. Strip markdown code fences
 * 3. Find first {...} block
 * 4. Find last {...} block (some models put reasoning first)
 */
function extractJSON(raw) {
    if (!raw || typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    // Strategy 1: Direct parse
    try {
        return JSON.parse(trimmed);
    }
    catch {
        /* continue */
    }
    // Strategy 2: Strip markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
        try {
            return JSON.parse(fenceMatch[1].trim());
        }
        catch {
            /* continue */
        }
    }
    // Strategy 3: Find first balanced {...} block
    const firstBrace = trimmed.indexOf('{');
    if (firstBrace !== -1) {
        let depth = 0;
        let end = -1;
        for (let i = firstBrace; i < trimmed.length; i++) {
            if (trimmed[i] === '{')
                depth++;
            if (trimmed[i] === '}')
                depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
        if (end > firstBrace) {
            try {
                return JSON.parse(trimmed.slice(firstBrace, end + 1));
            }
            catch {
                /* continue */
            }
        }
    }
    // Strategy 4: Find last {...} block (reasoning models often put text first)
    const lastBrace = trimmed.lastIndexOf('}');
    if (lastBrace > 0) {
        let depth = 0;
        let start = -1;
        for (let i = lastBrace; i >= 0; i--) {
            if (trimmed[i] === '}')
                depth++;
            if (trimmed[i] === '{')
                depth--;
            if (depth === 0) {
                start = i;
                break;
            }
        }
        if (start >= 0 && start < lastBrace) {
            try {
                return JSON.parse(trimmed.slice(start, lastBrace + 1));
            }
            catch {
                /* continue */
            }
        }
    }
    return null;
}
/**
 * Call an LLM and extract a JSON response.
 * Handles reasoning models (MiMo, DeepSeek-R) that put output in reasoning_content.
 */
async function callLLMJSON(provider, model, systemPrompt, userMessage, opts) {
    var _a, _b, _c, _d;
    try {
        const response = await provider.call({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            temperature: (_a = opts === null || opts === void 0 ? void 0 : opts.temperature) !== null && _a !== void 0 ? _a : 0.2,
            maxTokens: (_b = opts === null || opts === void 0 ? void 0 : opts.maxTokens) !== null && _b !== void 0 ? _b : 2048,
        });
        // Try content first, then reasoning_content (for reasoning models)
        const raw = response.content || response.reasoning_content || '';
        const data = extractJSON(raw);
        if (!data) {
            (0, logging_1.getGlobalLogger)().warn('LLMJsonExtractor', 'Failed to extract JSON from LLM response', {
                responseLength: raw.length,
                preview: raw.slice(0, 200),
            });
            return null;
        }
        return { data, tokens: (_d = (_c = response.usage) === null || _c === void 0 ? void 0 : _c.totalTokens) !== null && _d !== void 0 ? _d : 0 };
    }
    catch (err) {
        (0, logging_1.getGlobalLogger)().error('LLMJsonExtractor', 'LLM call failed', err);
        return null;
    }
}
