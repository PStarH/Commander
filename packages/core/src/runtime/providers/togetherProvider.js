"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TogetherProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
/**
 * Together AI Provider — broad model selection via Together API (OpenAI-compatible).
 *
 * Endpoint: https://api.together.ai/v1
 * Models: meta-llama/Llama-3.3-70B-Instruct, deepseek-ai/DeepSeek-V3,
 *         Qwen/Qwen2.5-72B-Instruct, mistralai/Mixtral-8x22B-Instruct-v0.1,
 *         google/gemma-2-27b-it, microsoft/Phi-3.5-mini-instruct
 *
 * Note: Model IDs use <provider>/<model> namespace (not flat names).
 * No Assistants/Threads API — use chat+function calling for agents.
 *
 * Env: TOGETHER_API_KEY (required)
 *       TOGETHER_BASE_URL (optional)
 *       TOGETHER_MODEL (optional)
 */
class TogetherProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'together';
    }
    getDefaultBaseUrl() {
        return process.env.TOGETHER_BASE_URL || 'https://api.together.ai/v1';
    }
    getDefaultModel() {
        return process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
    }
    getExtraConfig() {
        return {};
    }
}
exports.TogetherProvider = TogetherProvider;
