/**
 * Format Bridge — Provider-Specific Schema Adaptation
 *
 * Centralizes tool schema conversion for all 8 providers.
 * Inspired by OpenClaw's "prefer flat string enum helpers over anyOf" approach.
 *
 * Key innovations:
 * - Google/Gemini tool support (currently zero tools sent)
 * - anyOf flattening for provider compatibility
 * - Unified tool call response normalization
 */
import type { ToolDefinition, ToolCall } from './types';
type ProviderName = 'openai' | 'anthropic' | 'google' | 'mimo' | 'deepseek' | 'glm' | 'xiaomi' | 'openrouter' | string;
export declare class FormatBridge {
    /**
     * Convert Commander's internal ToolDefinition[] to provider-native format.
     */
    static adaptToolsForProvider(tools: ToolDefinition[], providerName: ProviderName): unknown[];
    /**
     * Normalize provider-specific tool call responses to Commander's internal format.
     */
    static adaptToolCallsFromProvider(toolCalls: unknown[], providerName: ProviderName): ToolCall[];
    private static toOpenAIFormat;
    private static toAnthropicFormat;
    private static toGoogleFormat;
    /**
     * Convert JSON Schema to Gemini's parameter format.
     * Gemini uses a subset of OpenAPI Schema with specific type enum values.
     */
    private static toGeminiParameters;
    /**
     * Convert a single JSON Schema property to Gemini type format.
     */
    private static jsonSchemaToGeminiType;
    /**
     * Parse Gemini function call responses to ToolCall format.
     * Gemini returns: { functionCall: { name, args } }
     */
    private static fromGoogleToolCalls;
    /**
     * Recursively flatten anyOf constructs into simple type + enum.
     * Example: {anyOf: [{const: "a"}, {const: "b"}]} -> {type: "string", enum: ["a", "b"]}
     * Leaves complex anyOf constructs unchanged.
     */
    static flattenSchema(schema: Record<string, unknown>): Record<string, unknown>;
    /**
     * Try to flatten an anyOf array into a simple enum.
     * Returns the flattened schema or null if not flattenable.
     */
    private static tryFlattenAnyOf;
}
export {};
//# sourceMappingURL=formatBridge.d.ts.map