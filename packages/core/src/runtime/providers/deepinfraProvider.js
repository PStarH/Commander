"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepInfraProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
class DeepInfraProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'deepinfra';
    }
    getDefaultBaseUrl() {
        return process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai';
    }
    getDefaultModel() {
        return process.env.DEEPINFRA_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
    }
    getExtraConfig() {
        return {};
    }
}
exports.DeepInfraProvider = DeepInfraProvider;
