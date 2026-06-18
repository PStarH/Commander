"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XAIProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
class XAIProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'xai';
    }
    getDefaultBaseUrl() {
        return process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
    }
    getDefaultModel() {
        return process.env.XAI_MODEL || 'grok-2-latest';
    }
    getExtraConfig() {
        return {};
    }
}
exports.XAIProvider = XAIProvider;
