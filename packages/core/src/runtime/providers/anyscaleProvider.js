"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnyscaleProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
class AnyscaleProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'anyscale';
    }
    getDefaultBaseUrl() {
        return process.env.ANYSCALE_BASE_URL || 'https://api.endpoints.anyscale.com/v1';
    }
    getDefaultModel() {
        return process.env.ANYSCALE_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';
    }
    getExtraConfig() {
        return {};
    }
}
exports.AnyscaleProvider = AnyscaleProvider;
