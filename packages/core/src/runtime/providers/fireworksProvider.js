"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FireworksProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
/**
 * Fireworks AI Provider — fast inference via Fireworks API (OpenAI-compatible).
 *
 * Endpoint: https://api.fireworks.ai/inference/v1
 * Models: accounts/fireworks/models/llama-v3p3-70b-instruct,
 *         accounts/fireworks/models/deepseek-v3,
 *         accounts/fireworks/models/qwen2p5-coder-32b-instruct,
 *         accounts/fireworks/models/mixtral-8x22b-instruct
 *
 * Env: FIREWORKS_API_KEY (required)
 *       FIREWORKS_BASE_URL (optional)
 *       FIREWORKS_MODEL (optional)
 */
class FireworksProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'fireworks';
    }
    getDefaultBaseUrl() {
        return process.env.FIREWORKS_BASE_URL || 'https://api.fireworks.ai/inference/v1';
    }
    getDefaultModel() {
        return process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/llama-v3p3-70b-instruct';
    }
    getExtraConfig() {
        return {};
    }
}
exports.FireworksProvider = FireworksProvider;
