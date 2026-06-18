"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgnesProvider = void 0;
const baseOpenAICompatible_1 = require("./baseOpenAICompatible");
class AgnesProvider extends baseOpenAICompatible_1.BaseOpenAICompatibleProvider {
    constructor() {
        super(...arguments);
        this.name = 'agnes';
    }
    getDefaultBaseUrl() {
        return 'https://apihub.agnes-ai.com/v1';
    }
    getDefaultModel() {
        return 'agnes-2.0-flash';
    }
    getExtraBody(request) {
        var _a;
        const maxTokens = Math.min((_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096, 65536);
        return { max_tokens: maxTokens };
    }
}
exports.AgnesProvider = AgnesProvider;
