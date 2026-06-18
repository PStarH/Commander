"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerplexityProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
/**
 * Perplexity Provider — Perplexity AI's sonar models (OpenAI-compatible).
 *
 * Endpoint: https://api.perplexity.ai/v1
 * Models: sonar-pro, sonar, sonar-reasoning, sonar-reasoning-pro,
 *         sonar-deep-research, r1-1776
 *
 * Note: Perplexity models are optimized for research and answer accuracy.
 * The Sonar API does NOT support tool/function calling — use the Agent API
 * (/v1/responses) if tool support is needed.
 *
 * Env: PERPLEXITY_API_KEY (primary, required)
 *       PPLX_API_KEY (fallback)
 *       PERPLEXITY_BASE_URL (optional)
 *       PERPLEXITY_MODEL (optional)
 */
class PerplexityProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'perplexity';
    }
    getDefaultBaseUrl() {
        return process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai/v1';
    }
    getDefaultModel() {
        return process.env.PERPLEXITY_MODEL || 'sonar-pro';
    }
    getExtraConfig() {
        return {};
    }
    async call(request) {
        if (request.tools && request.tools.length > 0) {
            throw new Error(`[perplexity] Perplexity Sonar API does NOT support tool/function calling. ` +
                `Remove tools from the request or use a different provider (e.g. OpenAI, Anthropic) ` +
                `for agentic workflows that require tools.`);
        }
        return super.call(request);
    }
}
exports.PerplexityProvider = PerplexityProvider;
