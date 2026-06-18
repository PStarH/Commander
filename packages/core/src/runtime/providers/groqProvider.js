"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroqProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
/**
 * Groq Provider — ultra-fast inference via Groq Cloud (OpenAI-compatible).
 *
 * Endpoint: https://api.groq.com/openai/v1
 * Models: llama3-70b-8192, llama3-8b-8192, mixtral-8x7b-32768,
 *         gemma2-9b-it, llama-3.1-70b-versatile, llama-3.1-8b-instant,
 *         llama-guard-3-8b, llama3-70b-8192-tool-use-preview
 *
 * Env: GROQ_API_KEY (required)
 *       GROQ_BASE_URL (optional)
 *       GROQ_MODEL (optional)
 */
class GroqProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'groq';
    }
    getDefaultBaseUrl() {
        return process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
    }
    getDefaultModel() {
        return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    }
    getExtraConfig() {
        return {};
    }
}
exports.GroqProvider = GroqProvider;
