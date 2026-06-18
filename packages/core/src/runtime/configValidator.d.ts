/**
 * Runtime Configuration Validation
 *
 * Pure TypeScript schema validation for runtime configuration objects.
 * No external dependencies — uses built-in type checking only.
 *
 * Usage:
 *   const schema = createSchema({
 *     port: { type: 'number', required: true, min: 1, max: 65535 },
 *     host: { type: 'string', default: '127.0.0.1' },
 *   });
 *   const result = validateConfig(myConfig, schema);
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';
export interface ConfigField {
    type: FieldType;
    required?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    enum?: string[];
    itemType?: FieldType;
    description?: string;
    /** For object type: nested schema */
    fields?: Record<string, ConfigField>;
}
export type ConfigSchema<T> = Record<string, ConfigField>;
export interface ConfigValidationResult<T = unknown> {
    valid: boolean;
    errors: ConfigValidationError[];
    data: T;
}
export interface ConfigValidationError {
    path: string;
    message: string;
    value?: unknown;
    expected?: string;
}
/**
 * Create a schema definition for a config type.
 * This is just a typed helper — the schema itself is a plain object.
 */
export declare function createSchema<T>(schema: ConfigSchema<T>): ConfigSchema<T>;
/**
 * Merge a partial config with schema defaults.
 * Returns a new object with all default values filled in.
 */
export declare function mergeWithDefaults<T extends Record<string, unknown>>(partial: Partial<T>, schema: ConfigSchema<Record<string, unknown>>): T;
/**
 * Validate a config object against a schema.
 * Returns { valid, errors, data } where data is the validated+defaulted config.
 */
export declare function validateConfig<T extends Record<string, unknown>>(config: Partial<T> | undefined, schema: ConfigSchema<Record<string, unknown>>): ConfigValidationResult<T>;
/**
 * Validate AgentRuntimeConfig against its schema.
 */
export declare function validateRuntimeConfig(config: Record<string, unknown>): ConfigValidationResult;
/**
 * Validate HttpServerConfig against its schema.
 */
export declare function validateHttpServerConfig(config: Record<string, unknown>): ConfigValidationResult;
/**
 * Validate a single config value against a field definition.
 */
export declare function validateField(value: unknown, field: ConfigField, path: string): ConfigValidationError[];
//# sourceMappingURL=configValidator.d.ts.map