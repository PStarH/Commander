"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FormatBridge = void 0;
// ============================================================================
// Format Bridge
// ============================================================================
class FormatBridge {
    /**
     * Convert Commander's internal ToolDefinition[] to provider-native format.
     */
    static adaptToolsForProvider(tools, providerName) {
        switch (providerName) {
            case 'openai':
            case 'mimo':
            case 'deepseek':
            case 'glm':
            case 'xiaomi':
            case 'openrouter':
                return FormatBridge.toOpenAIFormat(tools);
            case 'anthropic':
                return FormatBridge.toAnthropicFormat(tools);
            case 'google':
                return FormatBridge.toGoogleFormat(tools);
            default:
                // Default to OpenAI format (most compatible)
                return FormatBridge.toOpenAIFormat(tools);
        }
    }
    /**
     * Normalize provider-specific tool call responses to Commander's internal format.
     */
    static adaptToolCallsFromProvider(toolCalls, providerName) {
        switch (providerName) {
            case 'google':
                return FormatBridge.fromGoogleToolCalls(toolCalls);
            default:
                // OpenAI-style providers return the same format
                return toolCalls;
        }
    }
    // ==========================================================================
    // OpenAI Format
    // ==========================================================================
    static toOpenAIFormat(tools) {
        return tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: FormatBridge.flattenSchema(t.inputSchema),
            },
        }));
    }
    // ==========================================================================
    // Anthropic Format
    // ==========================================================================
    static toAnthropicFormat(tools) {
        return tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: FormatBridge.flattenSchema(t.inputSchema),
        }));
    }
    // ==========================================================================
    // Google/Gemini Format
    // ==========================================================================
    static toGoogleFormat(tools) {
        // Gemini uses function_declarations at the top level
        const declarations = tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: FormatBridge.toGeminiParameters(t.inputSchema),
        }));
        return [{ function_declarations: declarations }];
    }
    /**
     * Convert JSON Schema to Gemini's parameter format.
     * Gemini uses a subset of OpenAPI Schema with specific type enum values.
     */
    static toGeminiParameters(schema) {
        var _a, _b;
        const properties = ((_a = schema.properties) !== null && _a !== void 0 ? _a : {});
        const required = ((_b = schema.required) !== null && _b !== void 0 ? _b : []);
        const geminiProps = {};
        for (const [key, propSchema] of Object.entries(properties)) {
            geminiProps[key] = FormatBridge.jsonSchemaToGeminiType(propSchema);
        }
        const result = {
            type: 'OBJECT',
            properties: geminiProps,
        };
        if (required.length > 0) {
            result.required = required;
        }
        return result;
    }
    /**
     * Convert a single JSON Schema property to Gemini type format.
     */
    static jsonSchemaToGeminiType(schema) {
        var _a;
        const type = schema.type;
        const result = {};
        // Map JSON Schema types to Gemini type enum
        const typeMap = {
            string: 'STRING',
            number: 'NUMBER',
            integer: 'INTEGER',
            boolean: 'BOOLEAN',
            object: 'OBJECT',
            array: 'ARRAY',
        };
        result.type = (_a = typeMap[type]) !== null && _a !== void 0 ? _a : 'STRING';
        if (schema.description)
            result.description = schema.description;
        if (schema.enum)
            result.enum = schema.enum;
        // Handle nested object properties
        if (type === 'object' && schema.properties) {
            const nested = schema.properties;
            const nestedProps = {};
            for (const [k, v] of Object.entries(nested)) {
                nestedProps[k] = FormatBridge.jsonSchemaToGeminiType(v);
            }
            result.properties = nestedProps;
            if (schema.required)
                result.required = schema.required;
        }
        // Handle array items
        if (type === 'array' && schema.items) {
            result.items = FormatBridge.jsonSchemaToGeminiType(schema.items);
        }
        return result;
    }
    /**
     * Parse Gemini function call responses to ToolCall format.
     * Gemini returns: { functionCall: { name, args } }
     */
    static fromGoogleToolCalls(parts) {
        var _a;
        const results = [];
        for (const part of parts) {
            const p = part;
            if (p.functionCall) {
                const fc = p.functionCall;
                results.push({
                    id: `call_google_${Date.now()}_${results.length}`,
                    name: fc.name,
                    arguments: ((_a = fc.args) !== null && _a !== void 0 ? _a : {}),
                });
            }
        }
        return results;
    }
    // ==========================================================================
    // Schema Flattening (from OpenClaw: "prefer flat enums over anyOf")
    // ==========================================================================
    /**
     * Recursively flatten anyOf constructs into simple type + enum.
     * Example: {anyOf: [{const: "a"}, {const: "b"}]} -> {type: "string", enum: ["a", "b"]}
     * Leaves complex anyOf constructs unchanged.
     */
    static flattenSchema(schema) {
        if (!schema || typeof schema !== 'object')
            return schema;
        const result = { ...schema };
        // Flatten anyOf at the top level
        if (result.anyOf && Array.isArray(result.anyOf)) {
            const flattened = FormatBridge.tryFlattenAnyOf(result.anyOf);
            if (flattened) {
                // Merge the flattened result, preserving description etc.
                delete result.anyOf;
                Object.assign(result, flattened);
                return result;
            }
        }
        // Recursively flatten properties
        if (result.properties && typeof result.properties === 'object') {
            const props = result.properties;
            const flatProps = {};
            for (const [key, value] of Object.entries(props)) {
                flatProps[key] = FormatBridge.flattenSchema(value);
            }
            result.properties = flatProps;
        }
        // Recursively flatten items (for arrays)
        if (result.items && typeof result.items === 'object') {
            result.items = FormatBridge.flattenSchema(result.items);
        }
        return result;
    }
    /**
     * Try to flatten an anyOf array into a simple enum.
     * Returns the flattened schema or null if not flattenable.
     */
    static tryFlattenAnyOf(anyOf) {
        // Check if all entries are simple const/literal values of the same type
        const consts = [];
        let allSameType = true;
        let firstType;
        for (const entry of anyOf) {
            if (entry.const !== undefined) {
                consts.push(entry.const);
                const t = typeof entry.const;
                if (firstType === undefined)
                    firstType = t;
                else if (t !== firstType)
                    allSameType = false;
            }
            else if (entry.type === 'string' && Array.isArray(entry.enum)) {
                consts.push(...entry.enum);
                if (firstType === undefined)
                    firstType = 'string';
                else if (firstType !== 'string')
                    allSameType = false;
            }
            else {
                return null; // Not a simple union
            }
        }
        if (consts.length === 0 || !allSameType)
            return null;
        return {
            type: firstType === 'number' ? 'number' : 'string',
            enum: consts,
        };
    }
}
exports.FormatBridge = FormatBridge;
