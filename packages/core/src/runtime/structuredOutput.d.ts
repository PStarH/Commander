/**
 * Structured Output Parsing Utilities
 *
 * Provides reliable extraction of JSON/structured data from LLM responses,
 * supporting multiple output formats (JSON blocks, XML tags, YAML, markdown code blocks).
 */
export declare function parseStructuredOutput<T = unknown>(input: string | {
    content: string;
    parsed?: Record<string, unknown>;
}, fallback?: T): {
    success: true;
    data: T;
} | {
    success: false;
    data: T | undefined;
    raw: string;
};
/**
 * Validate that parsed structured output matches expected schema.
 */
export declare function validateStructuredOutput<T>(result: {
    success: true;
    data: T;
} | {
    success: false;
    data: T | undefined;
    raw: string;
}, requiredKeys: (keyof T)[]): result is {
    success: true;
    data: T;
};
/**
 * Runtime type guard that validates a parsed value matches an expected shape.
 * Use after parseStructuredOutput() to ensure the returned data actually has
 * the expected keys and types — preventing `as T` from masking shape mismatches.
 *
 * @example
 * const parsed = parseStructuredOutput(content);
 * if (parsed.success && validateShape(parsed.data, { name: 'string', age: 'number' })) {
 *   parsed.data.name; // string, safely narrowed
 * }
 */
export declare function validateShape<T extends Record<string, unknown>>(value: unknown, shape: {
    [K in keyof T]: 'string' | 'number' | 'boolean' | 'object' | 'array';
}): value is T;
//# sourceMappingURL=structuredOutput.d.ts.map