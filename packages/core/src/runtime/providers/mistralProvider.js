"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MistralProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
/**
 * Mistral AI Provider — Mistral's API (OpenAI-compatible).
 *
 * Endpoint: https://api.mistral.ai/v1
 * Models: mistral-large-latest, mistral-small-latest, codestral-latest,
 *         open-mistral-nemo, open-mixtral-8x22b, open-codestral-mamba
 *
 * Env: MISTRAL_API_KEY (required)
 *       MISTRAL_BASE_URL (optional)
 *       MISTRAL_MODEL (optional)
 */
class MistralProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'mistral';
    }
    getDefaultBaseUrl() {
        return process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1';
    }
    getDefaultModel() {
        return process.env.MISTRAL_MODEL || 'mistral-large-latest';
    }
    getExtraConfig() {
        return {};
    }
}
exports.MistralProvider = MistralProvider;
