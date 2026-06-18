"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BedrockProvider = void 0;
const logging_1 = require("../../logging");
/**
 * AWS Bedrock Provider — invoke foundation models via AWS Bedrock.
 *
 * Uses the Bedrock Runtime Converse API for structured chat + tool calls.
 * Falls back to InvokeModel (Anthropic Messages API format) for edge cases.
 *
 * Models: anthropic.claude-sonnet-4-6-v1,
 *         anthropic.claude-opus-4-6-v1,
 *         anthropic.claude-haiku-4-5-v1:0,
 *         anthropic.claude-opus-4-5-20251101-v1:0,
 *         anthropic.claude-sonnet-4-5-20250929-v1:0,
 *         anthropic.claude-mythos-preview-v1
 *
 * Env: AWS_REGION or AWS_DEFAULT_REGION (default: us-east-1)
 *       AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or AWS_PROFILE)
 *       BEDROCK_MODEL (optional)
 *
 * Note: Claude 4.x models have up to 60-minute inference timeouts.
 * The SDK client is configured with a 10-minute request timeout.
 *
 * Requires: npm install @aws-sdk/client-bedrock-runtime
 */
class BedrockProvider {
    constructor(config) {
        this.name = 'bedrock';
        this.sdk = null;
        this.sdkLoaded = false;
        this.region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
        this.defaultModel =
            config.defaultModel || process.env.BEDROCK_MODEL || 'anthropic.claude-sonnet-4-6-v1';
    }
    async loadSDK() {
        if (this.sdkLoaded)
            return;
        try {
            // String variable avoids compile-time module resolution (SDK is optional)
            const MODULE_NAME = '@aws-sdk/client-bedrock-runtime';
            const bedrockModule = (await Promise.resolve(`${MODULE_NAME}`).then(s => __importStar(require(s))));
            this.sdk = bedrockModule;
            this.sdkLoaded = true;
        }
        catch {
            throw new Error('AWS Bedrock SDK not found. Install it: npm install @aws-sdk/client-bedrock-runtime');
        }
    }
    async call(request) {
        var _a, _b, _c;
        await this.loadSDK();
        const model = request.model || this.defaultModel;
        // Build messages in Bedrock Converse format
        const messages = this.buildMessages(request);
        const system = this.buildSystem(request);
        const body = {
            modelId: model,
            messages,
            inferenceConfig: {
                maxTokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096,
                temperature: (_b = request.temperature) !== null && _b !== void 0 ? _b : 0.7,
            },
        };
        if (system)
            body.system = system;
        // Map tools to Bedrock tool format
        if (request.tools && request.tools.length > 0) {
            body.toolConfig = {
                tools: request.tools.map((t) => ({
                    toolSpec: {
                        name: t.name,
                        description: t.description,
                        inputSchema: { json: t.inputSchema },
                    },
                })),
            };
        }
        try {
            if (!this.sdk) {
                throw new Error('Bedrock SDK not loaded');
            }
            const client = new this.sdk.BedrockRuntimeClient({
                region: this.region,
                requestHandler: { requestTimeout: 600000 },
            });
            const command = new this.sdk.ConverseCommand(body);
            const response = (await client.send(command));
            return this.parseResponse(JSON.parse(new TextDecoder().decode((_c = response.body) !== null && _c !== void 0 ? _c : new Uint8Array())), model);
        }
        catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            if (e instanceof Error &&
                [
                    'AccessDeniedException',
                    'ValidationException',
                    'ModelErrorException',
                    'ModelTimeoutException',
                ].includes(e.name)) {
                (0, logging_1.getGlobalLogger)().debug('BedrockProvider', 'Converse API failed, trying invokeModel', {
                    error: errMsg,
                });
                return this.callInvokeModel(request, model);
            }
            throw new Error(`Bedrock API error: ${errMsg}`);
        }
    }
    buildMessages(request) {
        const messages = [];
        for (const m of request.messages) {
            if (m.role === 'system')
                continue;
            if (m.role === 'tool') {
                // Find the corresponding tool result content
                const lastMsg = messages[messages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                    lastMsg.content.push({
                        toolResult: {
                            toolUseId: m.tool_call_id || '',
                            content: [{ text: m.content }],
                            status: 'success',
                        },
                    });
                }
                continue;
            }
            const role = m.role === 'assistant' ? 'assistant' : 'user';
            const content = [];
            if (m.content) {
                content.push({ text: m.content });
            }
            // Map tool_calls from assistant
            if (m.tool_calls) {
                for (const tc of m.tool_calls) {
                    content.push({
                        toolUse: {
                            toolUseId: tc.id,
                            name: tc.function.name,
                            input: JSON.parse(tc.function.arguments),
                        },
                    });
                }
            }
            messages.push({ role, content });
        }
        return messages;
    }
    buildSystem(request) {
        const systemMsg = request.messages.find((m) => m.role === 'system');
        return systemMsg ? [{ text: systemMsg.content }] : undefined;
    }
    parseResponse(response, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const output = response.output || {};
        const message = output.message || {};
        const content = message.content || [];
        const textParts = content.filter((c) => !!c.text);
        const toolUseParts = content.filter((c) => !!c.toolUse);
        const stopReason = response.stopReason || 'end_turn';
        const usage = {
            promptTokens: (_b = (_a = response.usage) === null || _a === void 0 ? void 0 : _a.inputTokens) !== null && _b !== void 0 ? _b : 0,
            completionTokens: (_d = (_c = response.usage) === null || _c === void 0 ? void 0 : _c.outputTokens) !== null && _d !== void 0 ? _d : 0,
            totalTokens: ((_f = (_e = response.usage) === null || _e === void 0 ? void 0 : _e.inputTokens) !== null && _f !== void 0 ? _f : 0) + ((_h = (_g = response.usage) === null || _g === void 0 ? void 0 : _g.outputTokens) !== null && _h !== void 0 ? _h : 0),
        };
        return {
            content: textParts.map((c) => c.text).join(''),
            model,
            usage,
            finishReason: stopReason === 'end_turn'
                ? 'stop'
                : stopReason === 'tool_use'
                    ? 'tool_calls'
                    : stopReason === 'max_tokens'
                        ? 'length'
                        : 'stop',
            toolCalls: toolUseParts.length > 0
                ? toolUseParts.map((c) => {
                    var _a;
                    return ({
                        id: c.toolUse.toolUseId,
                        name: c.toolUse.name,
                        arguments: ((_a = c.toolUse.input) !== null && _a !== void 0 ? _a : {}),
                    });
                })
                : undefined,
        };
    }
    async callInvokeModel(request, model) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
        // Use Anthropic Messages API format for InvokeModel fallback.
        // This is the standard format for Claude 3+ and handles the
        // most common Bedrock use case (Claude models).
        const messages = this.buildMessages(request);
        const system = this.buildSystem(request);
        const anthropicPayload = {
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: (_a = request.maxTokens) !== null && _a !== void 0 ? _a : 4096,
            temperature: (_b = request.temperature) !== null && _b !== void 0 ? _b : 0.7,
            messages,
        };
        if (system)
            anthropicPayload.system = system;
        const body = {
            modelId: model,
            contentType: 'application/json',
            accept: 'application/json',
            body: new TextEncoder().encode(JSON.stringify(anthropicPayload)),
        };
        try {
            if (!this.sdk) {
                throw new Error('Bedrock SDK not loaded');
            }
            const client = new this.sdk.BedrockRuntimeClient({
                region: this.region,
                requestHandler: { requestTimeout: 600000 },
            });
            const command = new this.sdk.InvokeModelCommand(body);
            const response = (await client.send(command));
            const data = JSON.parse(new TextDecoder().decode((_c = response.body) !== null && _c !== void 0 ? _c : new Uint8Array()));
            // Messages API response: data.content[0].text
            // Legacy Text Completions response: data.completion
            const content = ((_e = (_d = data.content) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.text) || data.completion || data.generation || '';
            return {
                content,
                model,
                usage: {
                    promptTokens: (_g = (_f = data.usage) === null || _f === void 0 ? void 0 : _f.inputTokens) !== null && _g !== void 0 ? _g : 0,
                    completionTokens: (_j = (_h = data.usage) === null || _h === void 0 ? void 0 : _h.outputTokens) !== null && _j !== void 0 ? _j : 0,
                    totalTokens: ((_l = (_k = data.usage) === null || _k === void 0 ? void 0 : _k.inputTokens) !== null && _l !== void 0 ? _l : 0) + ((_o = (_m = data.usage) === null || _m === void 0 ? void 0 : _m.outputTokens) !== null && _o !== void 0 ? _o : 0),
                },
                finishReason: data.stop_reason === 'end_turn'
                    ? 'stop'
                    : data.stop_reason === 'max_tokens'
                        ? 'length'
                        : 'stop',
            };
        }
        catch (e) {
            throw new Error(`Bedrock invokeModel error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
exports.BedrockProvider = BedrockProvider;
