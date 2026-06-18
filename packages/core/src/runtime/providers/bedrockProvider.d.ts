import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
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
export declare class BedrockProvider implements LLMProvider {
    readonly name = "bedrock";
    private region;
    private defaultModel;
    private sdk;
    private sdkLoaded;
    constructor(config: {
        apiKey?: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    private loadSDK;
    call(request: LLMRequest): Promise<LLMResponse>;
    private buildMessages;
    private buildSystem;
    private parseResponse;
    private callInvokeModel;
}
//# sourceMappingURL=bedrockProvider.d.ts.map