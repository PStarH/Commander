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

// ============================================================================
// Provider Format Names
// ============================================================================

type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mimo'
  | 'deepseek'
  | 'glm'
  | 'xiaomi'
  | 'openrouter'
  | string;

// ============================================================================
// Format Bridge
// ============================================================================

export class FormatBridge {
  /**
   * Convert Commander's internal ToolDefinition[] to provider-native format.
   */
  static adaptToolsForProvider(tools: ToolDefinition[], providerName: ProviderName): unknown[] {
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
  static adaptToolCallsFromProvider(toolCalls: unknown[], providerName: ProviderName): ToolCall[] {
    switch (providerName) {
      case 'google':
        return FormatBridge.fromGoogleToolCalls(toolCalls);
      default:
        // OpenAI-style providers return the same format
        return toolCalls as ToolCall[];
    }
  }

  // ==========================================================================
  // OpenAI Format
  // ==========================================================================

  private static toOpenAIFormat(tools: ToolDefinition[]): unknown[] {
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

  private static toAnthropicFormat(tools: ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: FormatBridge.flattenSchema(t.inputSchema),
    }));
  }

  // ==========================================================================
  // Google/Gemini Format
  // ==========================================================================

  private static toGoogleFormat(tools: ToolDefinition[]): unknown[] {
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
  private static toGeminiParameters(schema: Record<string, unknown>): Record<string, unknown> {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];

    const geminiProps: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      geminiProps[key] = FormatBridge.jsonSchemaToGeminiType(propSchema);
    }

    const result: Record<string, unknown> = {
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
  private static jsonSchemaToGeminiType(schema: Record<string, unknown>): Record<string, unknown> {
    const type = schema.type as string;
    const result: Record<string, unknown> = {};

    // Map JSON Schema types to Gemini type enum
    const typeMap: Record<string, string> = {
      string: 'STRING',
      number: 'NUMBER',
      integer: 'INTEGER',
      boolean: 'BOOLEAN',
      object: 'OBJECT',
      array: 'ARRAY',
    };

    result.type = typeMap[type] ?? 'STRING';

    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;

    // Handle nested object properties
    if (type === 'object' && schema.properties) {
      const nested = schema.properties as Record<string, Record<string, unknown>>;
      const nestedProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(nested)) {
        nestedProps[k] = FormatBridge.jsonSchemaToGeminiType(v);
      }
      result.properties = nestedProps;
      if (schema.required) result.required = schema.required;
    }

    // Handle array items
    if (type === 'array' && schema.items) {
      result.items = FormatBridge.jsonSchemaToGeminiType(schema.items as Record<string, unknown>);
    }

    return result;
  }

  /**
   * Parse Gemini function call responses to ToolCall format.
   * Gemini returns: { functionCall: { name, args } }
   */
  private static fromGoogleToolCalls(parts: unknown[]): ToolCall[] {
    const results: ToolCall[] = [];

    for (const part of parts) {
      const p = part as Record<string, unknown>;
      if (p.functionCall) {
        const fc = p.functionCall as Record<string, unknown>;
        results.push({
          id: `call_google_${Date.now()}_${results.length}`,
          name: fc.name as string,
          arguments: (fc.args ?? {}) as Record<string, unknown>,
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
  static flattenSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema || typeof schema !== 'object') return schema;

    const result = { ...schema };

    // Flatten anyOf at the top level
    if (result.anyOf && Array.isArray(result.anyOf)) {
      const flattened = FormatBridge.tryFlattenAnyOf(result.anyOf as Record<string, unknown>[]);
      if (flattened) {
        // Merge the flattened result, preserving description etc.
        delete result.anyOf;
        Object.assign(result, flattened);
        return result;
      }
    }

    // Recursively flatten properties
    if (result.properties && typeof result.properties === 'object') {
      const props = result.properties as Record<string, Record<string, unknown>>;
      const flatProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        flatProps[key] = FormatBridge.flattenSchema(value);
      }
      result.properties = flatProps;
    }

    // Recursively flatten items (for arrays)
    if (result.items && typeof result.items === 'object') {
      result.items = FormatBridge.flattenSchema(result.items as Record<string, unknown>);
    }

    return result;
  }

  /**
   * Try to flatten an anyOf array into a simple enum.
   * Returns the flattened schema or null if not flattenable.
   */
  private static tryFlattenAnyOf(anyOf: Record<string, unknown>[]): Record<string, unknown> | null {
    // Check if all entries are simple const/literal values of the same type
    const consts: unknown[] = [];
    let allSameType = true;
    let firstType: string | undefined;

    for (const entry of anyOf) {
      if (entry.const !== undefined) {
        consts.push(entry.const);
        const t = typeof entry.const;
        if (firstType === undefined) firstType = t;
        else if (t !== firstType) allSameType = false;
      } else if (entry.type === 'string' && Array.isArray(entry.enum)) {
        consts.push(...entry.enum);
        if (firstType === undefined) firstType = 'string';
        else if (firstType !== 'string') allSameType = false;
      } else {
        return null; // Not a simple union
      }
    }

    if (consts.length === 0 || !allSameType) return null;

    return {
      type: firstType === 'number' ? 'number' : 'string',
      enum: consts,
    };
  }
}
